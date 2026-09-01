/**
 * Step 07 – 防失控：预算熔断 + 超时 + 可观测性（Trace 报告）
 *
 * 学习目标：给多 Agent 系统装上生产级"安全气囊"：
 *   1. Token 预算熔断 —— 累计消耗超限立即终止
 *   2. 最大轮数限制 —— 防止循环消耗（配合 recursion limit 双保险）
 *   3. 超时保护 —— 整体执行超时立即终止
 *   4. 可观测性 —— Trace 日志 + 结构化执行报告，出了问题能复盘
 *
 * 生产级要点：
 *   ① 多 Agent 系统因冗余上下文共享，Token 消耗是理论值的 1.5x ~ 7x
 *     （Galileo 实测 MetaGPT 72% / CAMEL 86% 的 token 是重复的），
 *     没有预算熔断，一次失控循环就能烧掉整月预算
 *   ② 预算/轮数/超时 = 熔断器（circuit breaker）：强制 Agent 在失控前收手，
 *     而不是等 LangGraph 的 recursion limit（25 步）兜底 —— 25 步已经太晚了
 *   ③ 可观测性：每个决策都要能回答「谁、为什么、花了多少、用了多久」。
 *     生产排障靠的不是看代码，而是看 Trace
 *
 * 跑法：pnpm run:multi-agent-supervisor:step7
 */

import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { z } from "zod";
import {
  API_KEY,
  llm,
  lookupWeatherTool,
  lookupCityTriviaTool,
  isDirectRun,
  lastMessageText,
  printSeparator,
  printObservations,
} from "../shared";

// ──────────────── 生产配置（熔断阈值）───────────────

const BUDGET_LIMITS = {
  maxTotalTokens: 20_000, // Token 预算上限：超过立即熔断
  maxRounds: 5, // 最大调度轮数（每轮 = 1 次 Supervisor 决策）
  maxDurationMs: 90_000, // 整体超时：超过立即熔断（90 秒）
} as const;

// ──────────────── State 定义 ────────────────

const BudgetState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev: BaseMessage[], next: BaseMessage[]) => prev.concat(next),
    default: () => [],
  }),
  next: Annotation<string>({
    reducer: (_prev: string, next: string) => next,
    default: () => "supervisor",
  }),
  // 累计 Token 消耗（从各 AI 消息的 usage_metadata 累加）
  totalTokens: Annotation<number>({
    reducer: (prev: number, next: number) => prev + next,
    default: () => 0,
  }),
  // 已执行的调度轮数
  roundCount: Annotation<number>({
    reducer: (prev: number, next: number) => prev + next,
    default: () => 0,
  }),
  // Trace 日志：每步一条 { 谁、为什么、token、耗时 }
  traceLogs: Annotation<Array<Record<string, unknown>>>({
    reducer: (prev: Array<Record<string, unknown>>, next: Array<Record<string, unknown>>) =>
      prev.concat(next),
    default: () => [],
  }),
  // 熔断原因（正常结束为空）
  budgetBreaker: Annotation<string>({
    reducer: (_prev: string, next: string) => next,
    default: () => "",
  }),
});

// ──────────────── Agent 定义 ────────────────

const weatherAgent = createAgent({
  name: "weather_agent",
  model: llm,
  tools: [lookupWeatherTool],
  systemPrompt: "你只处理天气。必须先调用 lookup_weather，再用中文简要说明。",
});

const triviaAgent = createAgent({
  name: "trivia_agent",
  model: llm,
  tools: [lookupCityTriviaTool],
  systemPrompt: "你只讲城市小知识。必须先调用 lookup_city_trivia，再用人话转述。",
});

// ──────────────── 节点实现 ────────────────

const RoutingDecision = z.object({
  reasoning: z.string().describe("为什么选择这个 Agent"),
  next: z
    .enum(["weather_agent", "trivia_agent", "FINISH"])
    .describe("下一个要调用的 Agent，或 FINISH 表示结束"),
});

/** 从消息里累计 token（AI 消息带 usage_metadata） */
function countTokens(messages: BaseMessage[]): number {
  return messages.reduce(
    (sum, m) =>
      sum +
      ((m as { usage_metadata?: { total_tokens?: number } }).usage_metadata?.total_tokens ?? 0),
    0
  );
}

async function supervisorNode(state: typeof BudgetState.State) {
  const startTime = Date.now();
  const routingLLM = llm.withStructuredOutput(RoutingDecision, {
    method: "functionCalling",
    name: "routing_decision",
    // includeRaw：同时拿到原始 AIMessage，读取「本次路由调用」的真实 token 用量
    includeRaw: true,
  });

  const systemPrompt = new SystemMessage(`你是调度员（Supervisor）。
子 Agent：
- weather_agent：查天气
- trivia_agent：讲城市小知识

规则：
1. 分析用户请求，选择最合适的 Agent
2. 如果所有需求都已被满足，返回 FINISH
3. 绝对不要自己编造数据`);

  const { parsed: decision, raw } = await routingLLM.invoke([systemPrompt, ...state.messages]);
  const elapsed = Date.now() - startTime;
  // 只计「本次路由调用」的 token（来自 raw.usage_metadata），而不是累计全部历史——
  // 历史消息的 token 已由各 Agent 节点按新增消息计入 totalTokens，
  // 若再累加历史总量，会让预算虚增、熔断过早触发
  const tokens = (raw as AIMessage).usage_metadata?.total_tokens ?? 0;

  console.log(
    `  [Trace] 轮次 ${state.roundCount + 1} | 🧠 Supervisor 决策: ${decision.next} | 累计 ${state.totalTokens + tokens} tokens | ${elapsed}ms`
  );
  console.log(`          └─ 理由: ${decision.reasoning.slice(0, 60)}...`);

  // 硬约束：如果还从未调度过 Agent 就说 FINISH，至少先调一个
  if (decision.next === "FINISH" && state.roundCount === 0) {
    console.log("  🛑 检测到提前 FINISH（未调度任何 Agent）→ 强制选 weather_agent");
    return {
      next: "weather_agent",
      messages: [],
      totalTokens: tokens,
      roundCount: 1,
      traceLogs: [
        {
          step: state.roundCount + 1,
          node: "supervisor",
          decision: "weather_agent",
          reasoning: "提前 FINISH 被拦截",
          tokens,
          elapsedMs: elapsed,
        },
      ],
    };
  }

  return {
    next: decision.next,
    messages: [],
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

/** 通用 Agent 执行节点工厂：执行 + 记账 + 写 Trace */
function makeAgentNode(
  agentName: string,
  agentGraph: {
    invoke: (input: { messages: BaseMessage[] }) => Promise<{ messages: BaseMessage[] }>;
  },
  emoji: string
) {
  return async function agentNode(state: typeof BudgetState.State) {
    const startTime = Date.now();
    console.log(`  [Trace] ${emoji} ${agentName} 执行中...`);
    const result = await agentGraph.invoke({ messages: state.messages });
    const agentMessages = result.messages.slice(state.messages.length);
    const elapsed = Date.now() - startTime;
    const tokens = countTokens(agentMessages);

    return {
      messages: agentMessages,
      next: "guard", // 每个 Agent 完成后先进熔断检查
      totalTokens: tokens,
      traceLogs: [
        {
          step: state.roundCount,
          node: agentName,
          tokens,
          elapsedMs: elapsed,
        },
      ],
    };
  };
}

const weatherAgentNode = makeAgentNode("weather_agent", weatherAgent.graph, "🌤️");
const triviaAgentNode = makeAgentNode("trivia_agent", triviaAgent.graph, "📚");

/**
 * Guard 节点：预算熔断 + 轮数限制 + 超时保护
 * 这是生产级的"安全气囊"——任何一项超限都强制 FINISH
 */
async function guardNode(state: typeof BudgetState.State) {
  // 轮数熔断
  if (state.roundCount >= BUDGET_LIMITS.maxRounds) {
    console.log(`  🛑 熔断：调度轮数达到上限 ${BUDGET_LIMITS.maxRounds}`);
    return { next: "FINISH", budgetBreaker: `maxRounds(${BUDGET_LIMITS.maxRounds})` };
  }
  // Token 预算熔断
  if (state.totalTokens >= BUDGET_LIMITS.maxTotalTokens) {
    console.log(
      `  🛑 熔断：Token 消耗 ${state.totalTokens} 超过预算 ${BUDGET_LIMITS.maxTotalTokens}`
    );
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

function buildBudgetGraph() {
  return (
    new StateGraph(BudgetState)
      .addNode("supervisor", supervisorNode)
      .addNode("weather_agent", weatherAgentNode)
      .addNode("trivia_agent", triviaAgentNode)
      .addNode("guard", guardNode)

      .addEdge(START, "supervisor")

      .addConditionalEdges("supervisor", (state: typeof BudgetState.State) => state.next, {
        weather_agent: "weather_agent",
        trivia_agent: "trivia_agent",
        FINISH: END,
      })

      // Agent → guard（熔断检查）→ supervisor / FINISH
      .addEdge("weather_agent", "guard")
      .addEdge("trivia_agent", "guard")
      .addConditionalEdges("guard", (state: typeof BudgetState.State) => state.next, {
        supervisor: "supervisor",
        FINISH: END,
      })

      .compile()
  );
}

// ──────────────── 主函数 ────────────────

export async function main() {
  printSeparator("Step 07: 防失控 — 预算熔断 + 超时 + Trace 可观测性");

  if (!API_KEY) {
    console.log("⚠️  跳过（未配置 LLM_API_KEY）");
    return;
  }

  const app = buildBudgetGraph();

  console.log("\n📊 带 Guard 熔断节点的图结构：");
  const graphImage = await app.getGraphAsync();
  console.log(graphImage.drawMermaid({ withStyles: true }));

  const query = "查一下杭州的天气，再讲一条和杭州有关的小知识。";
  console.log(`\n📝 用户请求：「${query}」\n`);
  console.log(
    `⚙️  熔断阈值: Token≤${BUDGET_LIMITS.maxTotalTokens} | 轮数≤${BUDGET_LIMITS.maxRounds} | 时长≤${BUDGET_LIMITS.maxDurationMs / 1000}s\n`
  );

  // 记录整体开始时间（挂在首条消息的 additional_kwargs 上，供 guard 超时判断）
  const humanMsg = new HumanMessage(query);
  humanMsg.additional_kwargs.startedAt = Date.now();

  const result = await app.invoke({ messages: [humanMsg] });

  console.log("\n📊 Trace 执行报告（谁、为什么、花了多少、用了多久）：");
  console.log("-".repeat(72));
  console.log(
    "  " + ["轮次", "节点", "决策/内容", "Token", "耗时"].map((h) => h.padEnd(14)).join("")
  );
  (result.traceLogs as Array<Record<string, unknown>>).forEach((t) => {
    const decision = (t.decision as string) ?? "";
    const node = t.node as string;
    const content = decision ? `→ ${decision}` : node;
    console.log(
      "  " +
        [
          String(t.step),
          node,
          content.slice(0, 14).padEnd(14),
          String(t.tokens).padEnd(14),
          `${t.elapsedMs}ms`,
        ].join(" ")
    );
  });
  console.log("-".repeat(72));

  console.log(
    `\n📈 汇总：累计 ${result.totalTokens} tokens | ${result.roundCount} 轮调度 | 熔断: ${result.budgetBreaker || "无（正常结束）"}`
  );

  console.log("\n🤖 最终回答:\n");
  console.log(lastMessageText(result));

  console.log("-".repeat(72));
  printObservations([
    "Token 预算熔断：多 Agent 系统 token 冗余 53%~86%，没有预算控制，一次失控循环就烧光预算",
    "轮数限制 + recursion limit 双保险：前者提前收手，后者兜底（25 步时已经太晚了）",
    "超时保护：agent 卡死在递归规划里时，时间熔断是最后的逃生通道",
    "Trace 报告：每个决策都能回答『谁、为什么、花了多少、用了多久』——生产排障的第一手资料",
    "生产落地：Trace 应写入 LangSmith / 日志系统并关联 Trace ID，而不是只打印到终端",
  ]);

  console.log("\n✅ Step 07 完成（预算熔断 + 可观测性已掌握）\n");
}

// 仅当本文件被直接运行时才执行 main：避免被 index.ts 批量模式 import 时重复执行
if (isDirectRun("step-07-budget-observability.ts")) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
