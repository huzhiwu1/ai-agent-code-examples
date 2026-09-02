/**
 * Step 08 – 生产级综合编排：Planner-Worker-Reviewer 全链路
 *
 * 把前面 7 步的所有生产级要点集成到一张图里，完成真实旅行规划场景：
 *
 *   Planner（规划）→ Supervisor（调度）→ 4 个 Worker（执行）
 *   → Reviewer（程序化硬校验）→ 通过则 FINISH，不通过则回调度
 *
 * 集成的生产级要点：
 *   ① 任务分解：Planner 把用户请求拆成结构化任务清单（角色分工：Planner/Worker/Reviewer）
 *   ② 确定性任务分配：visitedAgents 记录已调度 Worker，代码层拒绝重复调度（Step 05）
 *   ③ 预算熔断：Token 上限 + 最大轮数 + 超时，失控立即收手（Step 07）
 *   ④ 程序化硬校验：声称回答了的需求，必须在历史里有真实工具调用记录（Step 06）
 *   ⑤ Trace 可观测：每轮决策记录 谁/为什么/Token/耗时，输出执行报告（Step 07）
 *   ⑥ 依赖链：餐厅推荐依赖天气结果 → Supervisor 按任务清单顺序调度（Step 04）
 *
 * 对应真实设计：
 *   CrewAI 的 Crew（角色化团队）+ Flows（任务依赖管理）
 *   DEPART 框架（NeurIPS 2024）：Divide → Plan → Act → Reflect → Track
 *
 * 跑法：pnpm run:multi-agent-supervisor:step8
 */

import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Annotation, StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
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
  maxRounds: 8,
  maxDurationMs: 120_000,
} as const;

// ──────────────── State 定义 ────────────────

const ProductionState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev: BaseMessage[], next: BaseMessage[]) => prev.concat(next),
    default: () => [],
  }),
  next: Annotation<string>({
    reducer: (_prev: string, next: string) => next,
    default: () => "planner",
  }),
  // Planner 输出的任务清单（如 ["weather", "trivia", "restaurant", "travel"]）
  taskList: Annotation<string[]>({
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
  // 质量门禁记录：Reviewer 硬校验发现的问题（不阻断流程，随汇总输出）
  qualityIssues: Annotation<string[]>({
    reducer: (prev: string[], next: string[]) => prev.concat(next),
    default: () => [],
  }),
});

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

/** 领域 → Worker 节点名 / 工具名 映射（Planner 任务清单的合法值） */
const DOMAIN_TO_AGENT: Record<string, { node: string; toolName: string; keywords: string[] }> = {
  weather: {
    node: "weather_agent",
    toolName: "lookup_weather",
    keywords: ["天气", "气温", "下雨"],
  },
  trivia: {
    node: "trivia_agent",
    toolName: "lookup_city_trivia",
    keywords: ["小知识", "知识", "景点", "历史"],
  },
  restaurant: {
    node: "restaurant_agent",
    toolName: "lookup_restaurants",
    keywords: ["餐厅", "美食", "吃"],
  },
  travel: {
    node: "travel_agent",
    toolName: "lookup_travel_tips",
    keywords: ["贴士", "旅行", "注意"],
  },
};

// ──────────────── 节点：Planner（角色：规划者）───────────────

/** Planner 输出：结构化任务清单，只列出用户请求覆盖的领域 */
const PlanOutput = z.object({
  domains: z
    .array(z.enum(["weather", "trivia", "restaurant", "travel"]))
    .describe("用户请求覆盖的领域清单（只列确实需要的）"),
});

async function plannerNode(state: typeof ProductionState.State) {
  const startTime = Date.now();
  const planLLM = llm.withStructuredOutput(PlanOutput, { method: "functionCalling", name: "plan" });

  const systemPrompt =
    new SystemMessage(`你是旅行规划师（Planner）。分析用户请求，列出需要哪些领域的信息。
可用领域：
- weather：天气、气温、是否下雨
- trivia：城市小知识、景点、历史
- restaurant：餐厅、美食
- travel：旅行贴士、注意事项

只列出用户明确要求的领域。`);

  const plan = await planLLM.invoke([systemPrompt, ...state.messages]);
  const elapsed = Date.now() - startTime;
  console.log(`  📋 Planner 任务清单: [${plan.domains.join(", ")}]（${elapsed}ms）`);

  return {
    taskList: plan.domains,
    next: "supervisor",
    roundCount: 1,
    traceLogs: [
      { step: 1, node: "planner", decision: `plan:${plan.domains.join("+")}`, elapsedMs: elapsed },
    ],
  };
}

// ──────────────── 节点：Supervisor（角色：协调者/仲裁者）───────────────

const RoutingDecision = z.object({
  reasoning: z.string().describe("为什么选择这个 Agent"),
  next: z
    .enum(["weather_agent", "trivia_agent", "restaurant_agent", "travel_agent", "FINISH"])
    .describe("下一个要调用的 Worker，或 FINISH 表示结束"),
});

async function supervisorNode(state: typeof ProductionState.State) {
  const startTime = Date.now();
  const routingLLM = llm.withStructuredOutput(RoutingDecision, {
    method: "functionCalling",
    name: "routing_decision",
    // includeRaw：同时拿到原始 AIMessage，读取「本次路由调用」的真实 token 用量
    includeRaw: true,
  });

  // 只展示未完成的任务：Planner 清单 - 已调度记录
  const remaining = state.taskList
    .map((d) => DOMAIN_TO_AGENT[d]?.node)
    .filter((n): n is string => !!n && !state.visitedAgents.includes(n));
  const visitedText = state.visitedAgents.length ? state.visitedAgents.join("、") : "（无）";

  const systemPrompt =
    new SystemMessage(`你是调度员（Supervisor）。按 Planner 的任务清单调度 Worker：
- weather_agent：查天气
- trivia_agent：讲城市小知识
- restaurant_agent：推荐餐厅（依赖天气结果）
- travel_agent：旅行贴士

任务清单（未完成）：${remaining.length ? remaining.join("、") : "（全部完成）"}
已调度：${visitedText}

规则：
1. 每次只选一个 Worker，从"未完成"列表里选
2. 餐厅推荐放在天气之后
3. 未完成列表为空时返回 FINISH
4. 绝对不要自己编造数据`);

  const { parsed: decision, raw } = await routingLLM.invoke([systemPrompt, ...state.messages]);
  const elapsed = Date.now() - startTime;
  // 只计「本次路由调用」的 token（来自 raw.usage_metadata），而不是累计全部历史——
  // 历史消息的 token 已由各 Worker 节点按新增消息计入 totalTokens，
  // 若再累加历史总量，会让预算虚增、熔断过早触发
  const tokens = (raw as AIMessage).usage_metadata?.total_tokens ?? 0;
  console.log(
    `  [Trace] 轮次 ${state.roundCount + 1} | 🧠 Supervisor: ${decision.next} | 累计 ${state.totalTokens + tokens} tokens | ${elapsed}ms`
  );
  console.log(`          └─ 理由: ${decision.reasoning.slice(0, 60)}...`);

  // 确定性任务分配（硬约束）：重复调度直接拦截
  if (decision.next !== "FINISH" && state.visitedAgents.includes(decision.next)) {
    console.log(`  🛑 检测到重复调度「${decision.next}」→ 强制 FINISH`);
    return { next: "FINISH", messages: [], totalTokens: tokens };
  }

  // 硬约束：提前 FINISH 拦截 —— 仍有未完成任务时禁止结束，
  // 否则 bypass Reviewer 质量门禁，未完成项直接消失
  if (decision.next === "FINISH" && remaining.length > 0) {
    const forced = remaining[0];
    console.log(
      `  🛑 检测到提前 FINISH（仍有 ${remaining.length} 个未完成: ${remaining.join(", ")}）→ 强制选 ${forced}`
    );
    return {
      next: forced,
      messages: [],
      visitedAgents: [forced],
      totalTokens: tokens,
      roundCount: 1,
      traceLogs: [
        {
          step: state.roundCount + 1,
          node: "supervisor",
          decision: forced,
          reasoning: `提前 FINISH 被拦截，剩余: ${remaining.join(", ")}`,
          tokens,
          elapsedMs: elapsed,
        },
      ],
    };
  }

  return {
    next: decision.next,
    messages: [],
    visitedAgents: decision.next === "FINISH" ? [] : [decision.next],
    totalTokens: tokens,
    roundCount: 1,
    traceLogs: [
      {
        step: state.roundCount + 1,
        node: "supervisor",
        decision: decision.next,
        reasoning: decision.reasoning,
        tokens,
        elapsedMs: elapsed,
      },
    ],
  };
}

// ──────────────── 节点：Worker（角色：执行者）───────────────

function countTokens(messages: BaseMessage[]): number {
  return messages.reduce(
    (sum, m) =>
      sum +
      ((m as { usage_metadata?: { total_tokens?: number } }).usage_metadata?.total_tokens ?? 0),
    0
  );
}

/** Worker 节点工厂：执行 + 记账 + Trace，完成后进 Reviewer */
function makeWorkerNode(
  nodeName: string,
  agentGraph: {
    invoke: (input: { messages: BaseMessage[] }) => Promise<{ messages: BaseMessage[] }>;
  },
  emoji: string
) {
  return async function workerNode(state: typeof ProductionState.State) {
    const startTime = Date.now();
    console.log(`  [Trace] ${emoji} ${nodeName} 执行中...`);
    const result = await agentGraph.invoke({ messages: state.messages });
    const agentMessages = result.messages.slice(state.messages.length);
    const elapsed = Date.now() - startTime;
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
function hardCheck(state: typeof ProductionState.State): string[] {
  const problems: string[] = [];
  const toolNames = new Set(
    state.messages.filter((m) => m.getType() === "tool").map((m) => (m as { name?: string }).name)
  );
  for (const domain of state.taskList) {
    const conf = DOMAIN_TO_AGENT[domain];
    if (!conf) continue;
    // 该领域的 Worker 是否已执行（visitedAgents 里有记录）且调用了对应工具？
    const agentRan = state.visitedAgents.includes(conf.node);
    if (agentRan && !toolNames.has(conf.toolName)) {
      problems.push(`${conf.node} 已执行但没有调用 ${conf.toolName}，输出可能是编造的`);
    }
  }
  return problems;
}

async function reviewerNode(state: typeof ProductionState.State) {
  // ── 硬校验：工具调用记录检查（确定性）──
  const hardProblems = hardCheck(state);
  if (hardProblems.length > 0) {
    console.log(`  🔍 Reviewer 硬校验 ❌: ${hardProblems.join("；")}`);
    // 记录质量问题，不打断调度：继续让 Supervisor 推进下一个未完成任务
    return { next: "supervisor", qualityIssues: hardProblems };
  }

  // ── 完整性：Planner 要求的领域都跑完了吗 ──
  const missing = state.taskList.filter(
    (d) => !state.visitedAgents.includes(DOMAIN_TO_AGENT[d]?.node ?? "")
  );
  if (missing.length > 0) {
    console.log(`  🔍 Reviewer 完整性: 待完成 → ${missing.join(", ")}`);
    return { next: "supervisor" };
  }

  console.log("  🔍 Reviewer: ✅ 所有任务都有真实工具调用记录，通过");
  return { next: "FINISH" };
}

// ──────────────── 节点：Guard（角色：熔断器）───────────────

async function guardNode(state: typeof ProductionState.State) {
  if (state.roundCount >= BUDGET_LIMITS.maxRounds) {
    console.log(`  🛑 熔断：轮数达到上限 ${BUDGET_LIMITS.maxRounds}`);
    return { next: "FINISH", budgetBreaker: `maxRounds(${BUDGET_LIMITS.maxRounds})` };
  }
  if (state.totalTokens >= BUDGET_LIMITS.maxTotalTokens) {
    console.log(`  🛑 熔断：Token 超过预算 ${BUDGET_LIMITS.maxTotalTokens}`);
    return { next: "FINISH", budgetBreaker: `maxTokens(${BUDGET_LIMITS.maxTotalTokens})` };
  }
  // 超时熔断（用首条消息的时间戳模拟整体耗时；生产上用真挂钟 + AbortSignal 取消在途调用——
  // 节点间检查无法中止一次正在挂起的 LLM 请求）
  const startedAt = state.messages[0]?.additional_kwargs?.startedAt as number | undefined;
  if (startedAt && Date.now() - startedAt > BUDGET_LIMITS.maxDurationMs) {
    console.log(`  🛑 熔断：整体执行超过 ${BUDGET_LIMITS.maxDurationMs / 1000}s`);
    return { next: "FINISH", budgetBreaker: `maxDuration(${BUDGET_LIMITS.maxDurationMs}ms)` };
  }
  return { next: "supervisor" };
}

// ──────────────── 图构建 ────────────────

/**
 * 构建生产级编排图：planner → supervisor → 4 Worker → reviewer → guard → supervisor / FINISH
 * 角色分工：Planner 拆任务（taskList）、Supervisor 调度（visitedAgents 防重复/防提前 FINISH）、
 * Worker 执行（只写 messages 增量）、Reviewer 验票（工具调用记录硬校验）、Guard 熔断。
 * checkpointer 持久化状态：崩溃恢复、断点续跑、时间旅行调试（教学用 MemorySaver，
 * 生产换 PostgresSaver/Redis 并关联 thread_id）。
 */
function buildProductionGraph() {
  return (
    new StateGraph(ProductionState)
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

      .addConditionalEdges("supervisor", (state: typeof ProductionState.State) => state.next, {
        weather_agent: "weather_agent",
        trivia_agent: "trivia_agent",
        restaurant_agent: "restaurant_agent",
        travel_agent: "travel_agent",
        FINISH: END,
      })

      // Worker → Reviewer（质量把关）→ Guard（预算熔断）→ Supervisor / FINISH
      .addEdge("weather_agent", "reviewer")
      .addEdge("trivia_agent", "reviewer")
      .addEdge("restaurant_agent", "reviewer")
      .addEdge("travel_agent", "reviewer")
      .addConditionalEdges("reviewer", (state: typeof ProductionState.State) => state.next, {
        supervisor: "guard",
        FINISH: END,
      })
      .addConditionalEdges("guard", (state: typeof ProductionState.State) => state.next, {
        supervisor: "supervisor",
        FINISH: END,
      })

      // 生产级：checkpointer 持久化状态——崩溃恢复、断点续跑、时间旅行调试都靠它；
      // 教学用 MemorySaver（内存），生产换 PostgresSaver/Redis 并关联 thread_id
      .compile({ checkpointer: new MemorySaver() })
  );
}

// ──────────────── 主函数 ────────────────

export async function main() {
  printSeparator("Step 08: 生产级综合编排 — Planner-Worker-Reviewer 全链路");

  if (!API_KEY) {
    console.log("⚠️  跳过（未配置 LLM_API_KEY）");
    return;
  }

  const app = buildProductionGraph();

  console.log("\n📊 生产级编排图结构：");
  const graphImage = await app.getGraphAsync();
  console.log(graphImage.drawMermaid({ withStyles: true }));

  const query = "帮我规划一趟杭州三日游，需要了解天气、景点知识、美食推荐和旅行贴士。";
  console.log(`\n📝 用户请求：「${query}」\n`);
  console.log(
    `⚙️  熔断阈值: Token≤${BUDGET_LIMITS.maxTotalTokens} | 轮数≤${BUDGET_LIMITS.maxRounds} | 时长≤${BUDGET_LIMITS.maxDurationMs / 1000}s\n`
  );

  // 记录整体开始时间（挂在首条消息的 additional_kwargs 上，供 guard 超时判断；生产上用真挂钟 + AbortSignal）
  const humanMsg = new HumanMessage(query);
  humanMsg.additional_kwargs.startedAt = Date.now();

  const result = await app.invoke(
    { messages: [humanMsg] },
    // 关联 thread_id：同一会话多次调用自动恢复历史状态（多轮对话的生产基础）
    { configurable: { thread_id: "step-08-production-demo" } }
  );

  console.log("\n📊 Trace 执行报告：");
  console.log("-".repeat(72));
  (result.traceLogs as Array<Record<string, unknown>>).forEach((t) => {
    const decision = (t.decision as string) ?? "";
    console.log(
      `  轮次 ${String(t.step).padEnd(3)}| ${(t.node as string).padEnd(16)}| ${(decision || "执行").slice(0, 22).padEnd(22)}| ${String(t.tokens).padEnd(6)}tokens | ${t.elapsedMs}ms`
    );
  });
  console.log("-".repeat(72));

  console.log(
    `\n📈 汇总：累计 ${result.totalTokens} tokens | ${result.roundCount} 轮 | 调度记录: [${(result.visitedAgents as string[]).join(", ")}] | 熔断: ${result.budgetBreaker || "无"}`
  );

  // 质量门禁结果：硬校验发现的问题（如果有）
  const issues = result.qualityIssues as string[];
  if (issues.length > 0) {
    console.log("⚠️  质量门禁：以下任务未通过工具调用硬校验 →");
    issues.forEach((p) => console.log(`     - ${p}`));
  } else {
    console.log("🛡️  质量门禁：所有任务均有真实工具调用记录，全部通过");
  }

  console.log("\n🤖 最终旅行规划:\n");
  console.log(lastMessageText(result));

  console.log("-".repeat(72));
  printObservations([
    "Planner-Worker-Reviewer 角色分工：规划者拆任务、执行者干专活、审阅者把质量关（DEPART 框架的工程化）",
    "确定性任务分配：visitedAgents 保证每个 Worker 最多执行一次（硬约束，不依赖模型自觉）",
    "程序化硬校验：任务清单里的每个领域都要有真实工具调用记录，编造数据过不了 Reviewer",
    "熔断三件套：Token 预算 / 最大轮数 / 超时 —— 失控前收手，而不是等 25 步 recursion limit 兜底",
    "Trace 报告回答了『谁、为什么、花了多少、用了多久』—— 生产排障的第一手资料",
    "多 Agent 不是银弹：本场景 4 个 Worker + 3 个协调节点 ≈ 10+ 次 LLM 调用，简单任务用单 Agent 更划算",
  ]);

  console.log("\n✅ Step 08 完成（生产级多 Agent 编排已掌握）\n");
}

// 仅当本文件被直接运行时才执行 main：避免被 index.ts 批量模式 import 时重复执行
if (isDirectRun("step-08-production.ts")) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
