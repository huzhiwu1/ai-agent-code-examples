/**
 * Step 09 – 并行扇出：Send API 让无依赖 Worker 同批并行执行
 *
 * 学习目标：
 *   1. 回答「为什么前面全程串行」：JS 版 createSupervisor 只处理第一个 handoff
 *      Command（Step 03 实测坑），而手写 StateGraph 可以用 Send API 做真并行扇出
 *   2. 掌握并行调度的正确姿势：任务清单 + 依赖表 + 已调度记录 → 确定性扇出，
 *      LLM 从调度层完全退场（Step 05 确定性路由的并行版）
 *   3. 理解并行的边界：只有无依赖的任务才能同批并行；restaurant 依赖 weather
 *      的结果（雨天推荐室内餐厅），必须等第一波完成后再单独跑
 *
 * 生产级要点：
 *   ① 并行扇出 = 条件边返回 Send[]：LangGraph 在同一个 superstep 内并行执行整批
 *      Worker，全部完成后再沿各自出边汇合到 reviewer（map-reduce 的 join 语义）
 *   ② 依赖判定是确定性的：ready = 未调度 ∧ 依赖已满足。不再靠 LLM「每次选一个」，
 *      Step 03/05 的循环与提前 FINISH 两大软约束问题从机制上消失
 *   ③ 预算语义：一批并行 = 1 轮；各 Worker 只计自己新增消息的 token
 *   ④ 状态合并：并行 Worker 都写 messages / traceLogs，由 concat reducer 安全合并，
 *      不会互相覆盖
 *   ⑤ 收益：4 个 Worker 串行 ≈ 4 段端到端延迟 → 2 波完成，墙钟时间接近减半
 *      （LLM 调用次数不变，但等待时间大降）
 *
 * 跑法：pnpm run:multi-agent-supervisor:step9
 */

import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  Annotation,
  StateGraph,
  START,
  END,
  MemorySaver,
  Send,
  messagesStateReducer,
} from "@langchain/langgraph";
import { createAgent } from "langchain";
import { z } from "zod";
import {
  API_KEY,
  llm,
  lookupWeatherTool,
  lookupCityTriviaTool,
  lookupRestaurantsTool,
  lookupTravelTipsTool,
  isDirectRun,
  lastMessageText,
  printSeparator,
  printObservations,
} from "../shared";

// ──────────────── 生产配置 ────────────────

const BUDGET_LIMITS = {
  maxTotalTokens: 30_000,
  maxRounds: 8, // 一批并行 = 1 轮
  maxDurationMs: 120_000,
} as const;

// ──────────────── State 定义 ────────────────

const ParallelState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    // 使用 LangGraph 内置的 messagesStateReducer（而非自定义 concat）：
    // 并行 Worker 同时写 messages 时，内置 reducer 能正确处理消息合并与类型转换，
    // 自定义 concat 在 Send 扇出场景下会与 LangGraph 内部消息通道冲突
    reducer: messagesStateReducer,
    default: () => [],
  }),
  // 路由信号：fanout（扇出就绪批次）/ finish_check（交 Reviewer 终检）
  next: Annotation<string>({
    reducer: (_prev: string, next: string) => next,
    default: () => "planner",
  }),
  // Planner 输出的任务清单（如 ["weather", "trivia", "restaurant", "travel"]）
  taskList: Annotation<string[]>({
    reducer: (_prev: string[], next: string[]) => next,
    default: () => [],
  }),
  // 本轮扇出的就绪批次（supervisor 写入，条件边据此生成 Send 数组）
  currentBatch: Annotation<string[]>({
    reducer: (_prev: string[], next: string[]) => next,
    default: () => [],
  }),
  // 已调度的 Worker 记录（确定性任务分配，防重复调度）
  visitedAgents: Annotation<string[]>({
    reducer: (prev: string[], next: string[]) => prev.concat(next),
    default: () => [],
  }),
  totalTokens: Annotation<number>({
    reducer: (prev: number, next: number) => prev + next,
    default: () => 0,
  }),
  roundCount: Annotation<number>({
    reducer: (prev: number, next: number) => prev + next,
    default: () => 0,
  }),
  traceLogs: Annotation<Array<Record<string, unknown>>>({
    reducer: (prev: Array<Record<string, unknown>>, next: Array<Record<string, unknown>>) =>
      prev.concat(next),
    default: () => [],
  }),
  budgetBreaker: Annotation<string>({
    reducer: (_prev: string, next: string) => next,
    default: () => "",
  }),
  // 质量门禁记录：Reviewer 发现的问题（随汇总输出）
  qualityIssues: Annotation<string[]>({
    reducer: (prev: string[], next: string[]) => prev.concat(next),
    default: () => [],
  }),
});

// ──────────────── 领域 → Worker 映射 + 依赖表 ────────────────

/** 领域 → Worker 节点名 / 工具名 映射（Planner 任务清单的合法值） */
const DOMAIN_TO_AGENT: Record<string, { node: string; toolName: string; emoji: string }> = {
  weather: { node: "weather_agent", toolName: "lookup_weather", emoji: "🌤️" },
  trivia: { node: "trivia_agent", toolName: "lookup_city_trivia", emoji: "📚" },
  restaurant: { node: "restaurant_agent", toolName: "lookup_restaurants", emoji: "🍽️" },
  travel: { node: "travel_agent", toolName: "lookup_travel_tips", emoji: "🧳" },
};

/**
 * 依赖表（并行扇出的关键）：restaurant 的推荐要参考天气结果（雨天 → 室内），
 * 所以必须等 weather 完成。没有出现在这里的领域都视为无依赖，可同批并行。
 */
const DOMAIN_DEPENDENCIES: Record<string, string[]> = {
  restaurant: ["weather"],
};

// ──────────────── 4 个 Worker Agent（职责单一）───────────────

const weatherAgent = createAgent({
  name: "weather_agent",
  model: llm,
  tools: [lookupWeatherTool],
  systemPrompt: "你只查天气。调用 lookup_weather 获取数据，用中文简要说明，不要回答其他问题。",
});

const triviaAgent = createAgent({
  name: "trivia_agent",
  model: llm,
  tools: [lookupCityTriviaTool],
  systemPrompt: "你只讲城市小知识。调用 lookup_city_trivia 获取数据，用人话转述，不要编造。",
});

const restaurantAgent = createAgent({
  name: "restaurant_agent",
  model: llm,
  tools: [lookupRestaurantsTool],
  systemPrompt: `你只推荐餐厅。调用 lookup_restaurants 获取数据。
可查看对话历史中的天气信息：下雨则优先推荐室内餐厅。`,
});

const travelAgent = createAgent({
  name: "travel_agent",
  model: llm,
  tools: [lookupTravelTipsTool],
  systemPrompt: "你只提供旅行贴士。调用 lookup_travel_tips 获取数据，整理成要点，不要编造。",
});

// ──────────────── 节点：Planner（角色：规划者）───────────────

/** Planner 输出：结构化任务清单，只列出用户请求覆盖的领域 */
const PlanOutput = z.object({
  domains: z
    .array(z.enum(["weather", "trivia", "restaurant", "travel"]))
    .describe("用户请求覆盖的领域清单（只列确实需要的）"),
});

async function plannerNode(state: typeof ParallelState.State) {
  const startTime = Date.now();
  const planLLM = llm.withStructuredOutput(PlanOutput, {
    method: "functionCalling",
    name: "plan",
    // includeRaw：拿到原始 AIMessage，读取「本次规划调用」的真实 token 用量
    includeRaw: true,
  });

  const systemPrompt =
    new SystemMessage(`你是旅行规划师（Planner）。分析用户请求，列出需要哪些领域的信息。
可用领域：
- weather：天气、气温、是否下雨
- trivia：城市小知识、景点、历史
- restaurant：餐厅、美食
- travel：旅行贴士、注意事项

只列出用户明确要求的领域。`);

  const { parsed: plan, raw } = await planLLM.invoke([systemPrompt, ...state.messages]);
  const elapsed = Date.now() - startTime;
  // Planner 的调用同样计入预算（只计本次调用，避免与历史重复记账）
  const tokens = (raw as AIMessage).usage_metadata?.total_tokens ?? 0;
  console.log(
    `  📋 Planner 任务清单: [${plan.domains.join(", ")}]（${elapsed}ms, ${tokens} tokens）`
  );

  return {
    taskList: plan.domains,
    next: "supervisor",
    totalTokens: tokens,
    traceLogs: [
      {
        step: 0,
        node: "planner",
        decision: `plan:[${plan.domains.join("+")}]`,
        tokens,
        elapsedMs: elapsed,
      },
    ],
  };
}

// ──────────────── 节点：Supervisor（确定性并行调度器）───────────────

/**
 * Supervisor 节点：确定性并行调度——不需要 LLM。
 *
 * 这是 Step 05「确定性路由」的并行版：任务清单（Planner 输出）+ 依赖表（静态配置）
 * + visitedAgents（状态记录）三者都是确定性的，直接算出「就绪批次」：
 *
 *   ready = 未调度 ∧ 依赖已满足
 *
 * 例：taskList = [weather, trivia, restaurant, travel]
 *   第 1 波：weather / trivia / travel（restaurant 依赖 weather，未满足）
 *   第 2 波：restaurant（weather 已调度）
 *
 * LLM 从调度层退场后，Step 03 的循环、Step 05 拦截的「提前 FINISH」和「重复调度」
 * 都从机制上消失——因为调度不再依赖模型输出，而是依赖状态与配置。
 */
async function supervisorNode(state: typeof ParallelState.State) {
  const ready = state.taskList
    .filter((d) => {
      const node = DOMAIN_TO_AGENT[d]?.node;
      if (!node || state.visitedAgents.includes(node)) return false; // 已调度
      const deps = DOMAIN_DEPENDENCIES[d] ?? [];
      // 依赖已满足：依赖领域对应的 Worker 都在 visitedAgents 里
      return deps.every((dep) => state.visitedAgents.includes(DOMAIN_TO_AGENT[dep]?.node ?? ""));
    })
    .map((d) => DOMAIN_TO_AGENT[d].node);

  if (ready.length === 0) {
    console.log("  🧠 Supervisor: 无就绪任务 → 交 Reviewer 终检");
    return { next: "finish_check" };
  }

  console.log(`  🧠 Supervisor: 第 ${state.roundCount + 1} 波并行扇出 → [${ready.join(" | ")}]`);
  return {
    next: "fanout",
    currentBatch: ready,
    // 整批写入 visitedAgents：防重复调度的硬约束（确定性，不需要模型自觉）
    visitedAgents: ready,
    // 预算语义：一批并行 = 1 轮
    roundCount: 1,
    traceLogs: [
      {
        step: state.roundCount + 1,
        node: "supervisor",
        decision: `fanout:[${ready.join("+")}]`,
        tokens: 0, // 确定性调度：无 LLM 调用
        elapsedMs: 0,
      },
    ],
  };
}

// ──────────────── 节点：Worker（角色：执行者）───────────────

/** 从消息里累计 token（AI 消息带 usage_metadata） */
function countTokens(messages: BaseMessage[]): number {
  return messages.reduce(
    (sum, m) =>
      sum +
      ((m as { usage_metadata?: { total_tokens?: number } }).usage_metadata?.total_tokens ?? 0),
    0
  );
}

/**
 * Worker 节点工厂：执行 + 记账 + Trace。
 * 同一批次内的多个 Worker 由 LangGraph 并发执行，各自只返回新增消息，
 * 共享 state 的合并由 messagesStateReducer 保证安全（支持 ID 去重与 RemoveMessage）。
 */
function makeWorkerNode(
  nodeName: string,
  agentGraph: {
    invoke: (input: { messages: BaseMessage[] }) => Promise<{ messages: BaseMessage[] }>;
  },
  emoji: string
) {
  return async function workerNode(state: typeof ParallelState.State) {
    const startTime = Date.now();
    console.log(`  [第 ${state.roundCount} 波] ${emoji} ${nodeName} 并行执行中...`);
    const result = await agentGraph.invoke({ messages: state.messages });
    // 只取本 Worker 新增的消息（输入消息之前的都是历史）
    const agentMessages = result.messages.slice(state.messages.length);
    const elapsed = Date.now() - startTime;
    // 只计本 Worker 新增消息的 token（避免与历史重复记账）
    const tokens = countTokens(agentMessages);
    return {
      messages: agentMessages,
      next: "reviewer",
      totalTokens: tokens,
      traceLogs: [{ step: state.roundCount, node: nodeName, tokens, elapsedMs: elapsed }],
    };
  };
}

const weatherWorkerNode = makeWorkerNode("weather_agent", weatherAgent.graph, "🌤️");
const triviaWorkerNode = makeWorkerNode("trivia_agent", triviaAgent.graph, "📚");
const restaurantWorkerNode = makeWorkerNode("restaurant_agent", restaurantAgent.graph, "🍽️");
const travelWorkerNode = makeWorkerNode("travel_agent", travelAgent.graph, "🧳");

// ──────────────── 节点：Reviewer（角色：审阅者）───────────────

/**
 * 程序化硬校验：Planner 清单里的每个领域，都必须有对应的真实工具调用记录。
 * 需求声称被回答了但历史里没有工具调用 → 判定编造/遗漏 → 记录质量问题。
 */
function hardCheck(state: typeof ParallelState.State): string[] {
  const problems: string[] = [];
  const toolNames = new Set(
    state.messages.filter((m) => m.getType() === "tool").map((m) => (m as { name?: string }).name)
  );
  for (const domain of state.taskList) {
    const conf = DOMAIN_TO_AGENT[domain];
    if (!conf) continue;
    const agentRan = state.visitedAgents.includes(conf.node);
    if (agentRan && !toolNames.has(conf.toolName)) {
      problems.push(`${conf.node} 已执行但没有调用 ${conf.toolName}，输出可能是编造的`);
    }
  }
  return problems;
}

async function reviewerNode(state: typeof ParallelState.State) {
  // ── 依赖不可满足：planner 列了 restaurant 却没列 weather → 永远无法就绪，
  //    记录问题并结束（确定性调度下不可能重试成功，避免空转）──
  const blocked = state.taskList.filter((d) => {
    const deps = DOMAIN_DEPENDENCIES[d] ?? [];
    return deps.some((dep) => !state.taskList.includes(dep));
  });
  if (blocked.length > 0) {
    console.log(
      `  🔍 Reviewer: 依赖不可满足（${blocked.join(", ")} 的依赖不在任务清单）→ 记录并结束`
    );
    return { next: "FINISH", qualityIssues: [`依赖不可满足: ${blocked.join(", ")}`] };
  }

  // ── 硬校验：Worker 跑了但没调用工具 → 编造嫌疑（visitedAgents 已拦截重复调度，
  //    无法重试，记录问题随汇总输出）──
  const hardProblems = hardCheck(state);
  if (hardProblems.length > 0) {
    console.log(`  🔍 Reviewer 硬校验 ❌: ${hardProblems.join("；")}`);
    return { next: "FINISH", qualityIssues: hardProblems };
  }

  // ── 完整性：还有未调度的领域 → 回 Supervisor 继续下一波扇出 ──
  const missing = state.taskList.filter(
    (d) => !state.visitedAgents.includes(DOMAIN_TO_AGENT[d]?.node ?? "")
  );
  if (missing.length > 0) {
    console.log(`  🔍 Reviewer 完整性: 待完成 → ${missing.join(", ")}（等下一波扇出）`);
    return { next: "guard" };
  }

  console.log("  🔍 Reviewer: ✅ 所有任务都有真实工具调用记录，通过");
  return { next: "FINISH" };
}

// ──────────────── 节点：Guard（角色：熔断器）───────────────

async function guardNode(state: typeof ParallelState.State) {
  if (state.roundCount >= BUDGET_LIMITS.maxRounds) {
    console.log(`  🛑 熔断：轮数达到上限 ${BUDGET_LIMITS.maxRounds}`);
    return { next: "FINISH", budgetBreaker: `maxRounds(${BUDGET_LIMITS.maxRounds})` };
  }
  if (state.totalTokens >= BUDGET_LIMITS.maxTotalTokens) {
    console.log(`  🛑 熔断：Token 超过预算 ${BUDGET_LIMITS.maxTotalTokens}`);
    return { next: "FINISH", budgetBreaker: `maxTokens(${BUDGET_LIMITS.maxTotalTokens})` };
  }
  // 超时熔断（用首条消息的时间戳模拟整体耗时；生产上用真挂钟 + 任务级超时——Send 的
  // 第三参数 { timeout } 可以给每个 Worker 挂 runTimeout）
  const startedAt = state.messages[0]?.additional_kwargs?.startedAt as number | undefined;
  if (startedAt && Date.now() - startedAt > BUDGET_LIMITS.maxDurationMs) {
    console.log(`  🛑 熔断：整体执行超过 ${BUDGET_LIMITS.maxDurationMs / 1000}s`);
    return { next: "FINISH", budgetBreaker: `maxDuration(${BUDGET_LIMITS.maxDurationMs}ms)` };
  }
  return { next: "supervisor" };
}

// ──────────────── 图构建 ────────────────

function buildParallelGraph() {
  return (
    new StateGraph(ParallelState)
      .addNode("planner", plannerNode)
      .addNode("supervisor", supervisorNode)
      .addNode("weather_agent", weatherWorkerNode)
      .addNode("trivia_agent", triviaWorkerNode)
      .addNode("restaurant_agent", restaurantWorkerNode)
      .addNode("travel_agent", travelWorkerNode)
      .addNode("reviewer", reviewerNode)
      .addNode("guard", guardNode)

      .addEdge(START, "planner")
      .addEdge("planner", "supervisor")

      // 条件边：fanout → 返回 Send[] 并行扇出；finish_check → Reviewer 终检
      // Send[] 的语义：同一 superstep 内并行执行整批 Worker，全部完成后
      // 沿各自出边（worker → reviewer）汇合——map-reduce 的 join 语义
      // 注意 1：edge map 必须声明所有 Send 可能指向的节点，否则编译期抛 UNREACHABLE_NODE
      // 注意 2（实测坑）：Send 的 args 就是目标节点的完整输入 state，不会与当前图状态
      //   自动合并——Worker 里拿不到 args 之外的任何字段（连 schema default 都不应用）。
      //   所以必须显式传 Worker 需要的所有字段（messages + 波次号）
      .addConditionalEdges(
        "supervisor",
        (state: typeof ParallelState.State): string | Send[] => {
          if (state.next !== "fanout") return "reviewer";
          return state.currentBatch.map(
            (node) => new Send(node, { messages: state.messages, roundCount: state.roundCount })
          );
        },
        {
          weather_agent: "weather_agent",
          trivia_agent: "trivia_agent",
          restaurant_agent: "restaurant_agent",
          travel_agent: "travel_agent",
          reviewer: "reviewer",
        }
      )

      // Worker 完成后汇合到 Reviewer（并行批次全部完成后执行一次）
      .addEdge("weather_agent", "reviewer")
      .addEdge("trivia_agent", "reviewer")
      .addEdge("restaurant_agent", "reviewer")
      .addEdge("travel_agent", "reviewer")

      .addConditionalEdges("reviewer", (state: typeof ParallelState.State) => state.next, {
        guard: "guard",
        FINISH: END,
      })

      .addConditionalEdges("guard", (state: typeof ParallelState.State) => state.next, {
        supervisor: "supervisor",
        FINISH: END,
      })

      // 生产级：checkpointer 持久化状态（与 Step 08 一致）
      .compile({ checkpointer: new MemorySaver() })
  );
}

// ──────────────── 主函数 ────────────────

export async function main() {
  printSeparator("Step 09: 并行扇出 — Send API 让无依赖 Worker 同批并行");

  if (!API_KEY) {
    console.log("⚠️  跳过（未配置 LLM_API_KEY）");
    return;
  }

  const app = buildParallelGraph();

  console.log("\n📊 并行扇出图结构：");
  const graphImage = await app.getGraphAsync();
  console.log(graphImage.drawMermaid({ withStyles: true }));

  const query = "帮我规划一趟杭州三日游，需要了解天气、景点知识、美食推荐和旅行贴士。";
  console.log(`\n📝 用户请求：「${query}」\n`);
  console.log(
    `⚙️  熔断阈值: Token≤${BUDGET_LIMITS.maxTotalTokens} | 轮数≤${BUDGET_LIMITS.maxRounds} | 时长≤${BUDGET_LIMITS.maxDurationMs / 1000}s\n`
  );
  console.log(
    "🧩 预期调度：第 1 波 [weather | trivia | travel] 并行 → 第 2 波 [restaurant]（依赖 weather）\n"
  );

  // 记录整体开始时间（挂在首条消息上，供 guard 超时判断）
  const humanMsg = new HumanMessage(query);
  humanMsg.additional_kwargs.startedAt = Date.now();

  const result = await app.invoke(
    { messages: [humanMsg] },
    // 关联 thread_id：同一会话多次调用自动恢复历史状态
    { configurable: { thread_id: "step-09-parallel-fanout" } }
  );

  console.log("\n📊 Trace 执行报告（波次 = 一批并行扇出）：");
  console.log("-".repeat(72));
  console.log(
    "  " + ["波次", "节点", "决策/内容", "Token", "耗时"].map((h) => h.padEnd(14)).join("")
  );
  (result.traceLogs as Array<Record<string, unknown>>).forEach((t) => {
    const decision = (t.decision as string) ?? "";
    console.log(
      "  " +
        [
          String(t.step).padEnd(14),
          (t.node as string).padEnd(14),
          (decision || "执行").slice(0, 14).padEnd(14),
          String(t.tokens).padEnd(14),
          `${t.elapsedMs}ms`,
        ].join("")
    );
  });
  console.log("-".repeat(72));

  console.log(
    `\n📈 汇总：累计 ${result.totalTokens} tokens | ${result.roundCount} 波 | 调度记录: [${(result.visitedAgents as string[]).join(", ")}] | 熔断: ${result.budgetBreaker || "无"}`
  );

  // 质量门禁结果：硬校验发现的问题（如果有）
  const issues = result.qualityIssues as string[];
  if (issues.length > 0) {
    console.log("⚠️  质量门禁：以下问题随汇总输出 →");
    issues.forEach((p) => console.log(`     - ${p}`));
  } else {
    console.log("🛡️  质量门禁：所有任务均有真实工具调用记录，全部通过");
  }

  console.log("\n🤖 最终旅行规划:\n");
  console.log(lastMessageText(result));

  console.log("-".repeat(72));
  printObservations([
    "并行扇出：条件边返回 Send[]，weather/trivia/travel 同一 superstep 并行执行（对照 Step 08 串行版）",
    "依赖表决定批次：restaurant 依赖 weather → 第 2 波单独执行（雨天推荐室内餐厅）",
    "确定性调度：任务清单 + 依赖表 + visitedAgents 直接算出就绪批次，LLM 从调度层退场——提前 FINISH 与重复调度从机制上消失",
    "预算语义：一批并行 = 1 轮；各 Worker 只计自己新增消息的 token，Supervisor 调度 0 token",
    "收益对比：Step 08 串行 ≈ 4 段端到端延迟；本步 2 波完成，墙钟时间接近减半（LLM 调用数不变）",
    "并行不是银弹：有依赖的任务必须串行；真正的收益来自依赖图的拓扑分层",
    "生产提示：Send 第三参数 { timeout } 可给每个 Worker 挂任务级 runTimeout，配合 AbortSignal 实现真超时",
  ]);

  console.log("\n✅ Step 09 完成（并行扇出已掌握）\n");
}

// 仅当本文件被直接运行时才执行 main：避免被 index.ts 批量模式 import 时重复执行
if (isDirectRun("step-09-parallel-fanout.ts")) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
