/**
 * Step 05 – 确定性路由：手写 StateGraph，用状态显式防重复调度
 *
 * 学习目标：
 *   1. 拆解 createSupervisor 的黑盒，理解 StateGraph + 条件边的内部机制
 *   2. 掌握生产级"确定性任务分配"：任务 ID + 已调度记录 + 拒绝重复分配
 *
 * 生产级要点（Galileo《10 Multi-Agent Coordination Strategies》#1）：
 *   多 Agent 系统最常见的失败模式之一就是"ping-pong"——
 *   多个 Agent 反复抢同一个任务，或 Supervisor 反复调度同一个 Agent。
 *   解法是确定性任务分配：
 *     - 给任务分配唯一 ID（本 Step 的 visitedAgents 就是"已分配任务记录"）
 *     - 记录选中的 Agent（每次路由都写入 visitedAgents）
 *     - 拒绝重复分配（路由函数发现 next 已在 visitedAgents 中 → 强制 FINISH）
 *   这比"在 Prompt 里写'不要重复调用'"可靠得多：
 *   Prompt 是软约束，模型可能不遵守；状态是硬约束，代码层面直接拦截。
 *
 * 图结构:
 *   START → supervisor ──→ weather_agent ──┐
 *              │                            │
 *              ├──→ trivia_agent  ──────────┤
 *              │                            │
 *              └──→ FINISH                  │
 *              ↑                            │
 *              └────────────────────────────┘
 *
 * 跑法：pnpm run:multi-agent-supervisor:step5
 */

import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
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

// ──────────────── State 定义 ────────────────
// 与 Step 03 的 createSupervisor 相比，多了一个 visitedAgents 字段：
// 这是"确定性任务分配"的状态载体 —— 记录哪些 Agent 已经被调度过

const SupervisorState = Annotation.Root({
  // messages: 对话历史，贯穿整个图
  messages: Annotation<BaseMessage[]>({
    reducer: (prev: BaseMessage[], next: BaseMessage[]) => prev.concat(next),
    default: () => [],
  }),
  // next: Supervisor 的决策结果 —— 下一个要执行的节点
  next: Annotation<string>({
    reducer: (_prev: string, next: string) => next,
    default: () => "supervisor",
  }),
  // visitedAgents: 已调度的 Agent 列表（生产级：任务分配记录，防止重复调度）
  visitedAgents: Annotation<string[]>({
    reducer: (prev: string[], next: string[]) => prev.concat(next),
    default: () => [],
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

/**
 * Supervisor 节点：用 LLM 决定下一个该调用哪个 Agent
 *
 * 生产级细节：LLM 只负责"从还没调用过的 Agent 里选一个"——
 * 已经调度过的 Agent 由代码层拦截，不依赖模型自觉。
 */
const RoutingDecision = z.object({
  reasoning: z.string().describe("为什么选择这个 Agent"),
  next: z
    .enum(["weather_agent", "trivia_agent", "FINISH"])
    .describe("下一个要调用的 Agent，或 FINISH 表示结束"),
});

async function supervisorNode(state: typeof SupervisorState.State) {
  // 已调度的 Agent 列表（用于提示 LLM + 代码层拦截）
  const visited = state.visitedAgents.length > 0 ? state.visitedAgents.join("、") : "（无）";

  const routingLLM = llm.withStructuredOutput(RoutingDecision, {
    method: "functionCalling",
    name: "routing_decision",
  });

  const systemPrompt = new SystemMessage(`你是调度员（Supervisor），只负责选人，不要自己回答问题。

你的子 Agent 及其职责：
- weather_agent：查天气、气温、下雨、空气质量
- trivia_agent：讲城市小知识、景点、历史、文化

规则：
1. 分析用户最新请求，选择最合适的 Agent
2. 如果用户同时问天气和知识，先选一个，等它完成后你会再次被调用
3. 如果所有需求都已被满足，返回 FINISH
4. 绝对不要自己编造数据，必须交给子 Agent 处理

已经调用过的 Agent：${visited}
注意：不要选择已经调用过的 Agent。`);

  const decision = await routingLLM.invoke([systemPrompt, ...state.messages]);
  console.log(`  🧠 Supervisor 决策: ${decision.next}（${decision.reasoning}）`);

  // ── 确定性任务分配（硬约束）──
  // 代码层拦截：模型若重复选择已调用过的 Agent，直接强制 FINISH，
  // 不依赖模型"自觉遵守" Prompt 规则
  if (decision.next !== "FINISH" && state.visitedAgents.includes(decision.next)) {
    console.log(`  🛑 检测到重复调度「${decision.next}」→ 代码层强制 FINISH（确定性任务分配）`);
    return { next: "FINISH", messages: [] };
  }

  // 硬约束：如果还从未调用过任何 Agent 就说 FINISH，至少强制选一个
  //（与"重复调度"同为模型随机性下的高频失败模式，代码层拦截）
  if (decision.next === "FINISH" && state.visitedAgents.length === 0) {
    console.log("  🛑 检测到提前 FINISH（未调用任何 Agent）→ 强制选 weather_agent");
    return { next: "weather_agent", messages: [], visitedAgents: ["weather_agent"] };
  }

  return {
    next: decision.next,
    messages: [],
    // 记录本次调度（如果选了 Agent），供下一轮决策参考
    visitedAgents: decision.next === "FINISH" ? [] : [decision.next],
  };
}

/** Agent 节点：包装子 Agent 的执行，只返回增量消息 */
async function weatherAgentNode(state: typeof SupervisorState.State) {
  console.log("  🌤️  weather_agent 开始执行...");
  const result = await weatherAgent.graph.invoke({ messages: state.messages });
  const agentMessages = result.messages.slice(state.messages.length);
  return { messages: agentMessages, next: "supervisor" };
}

async function triviaAgentNode(state: typeof SupervisorState.State) {
  console.log("  📚 trivia_agent 开始执行...");
  const result = await triviaAgent.graph.invoke({ messages: state.messages });
  const agentMessages = result.messages.slice(state.messages.length);
  return { messages: agentMessages, next: "supervisor" };
}

// ──────────────── 图构建 ────────────────

function buildSupervisorGraph() {
  return (
    new StateGraph(SupervisorState)
      .addNode("supervisor", supervisorNode)
      .addNode("weather_agent", weatherAgentNode)
      .addNode("trivia_agent", triviaAgentNode)

      .addEdge(START, "supervisor")

      // 条件边：supervisor 根据 state.next 决定跳转
      .addConditionalEdges("supervisor", (state: typeof SupervisorState.State) => state.next, {
        weather_agent: "weather_agent",
        trivia_agent: "trivia_agent",
        FINISH: END,
      })

      // 回流边：Agent 完成后回到 supervisor 继续决策（形成循环）
      .addEdge("weather_agent", "supervisor")
      .addEdge("trivia_agent", "supervisor")

      .compile()
  );
}

// ──────────────── 主函数 ────────────────

export async function main() {
  printSeparator("Step 05: 确定性路由 — 手写 StateGraph + 防重复调度");

  if (!API_KEY) {
    console.log("⚠️  跳过（未配置 LLM_API_KEY）");
    return;
  }

  const app = buildSupervisorGraph();

  console.log("\n📊 手写 Supervisor 图结构：");
  const graphImage = await app.getGraphAsync();
  console.log(graphImage.drawMermaid({ withStyles: true }));

  const query = "查一下杭州的天气，再讲一条和杭州有关的小知识。";
  console.log(`\n📝 用户请求：「${query}」\n`);
  console.log("🔍 执行过程（观察 visitedAgents 如何防止重复调度）：\n");

  const result = await app.invoke({
    messages: [new HumanMessage(query)],
  });

  console.log("\n📊 调度记录（visitedAgents）:", result.visitedAgents);
  console.log("\n🤖 最终回答:\n");
  console.log(lastMessageText(result));

  console.log("-".repeat(72));
  printObservations([
    "确定性任务分配：visitedAgents 记录已调度 Agent，代码层拦截重复调度（硬约束）",
    "对比 Step 03：Prompt 里写'不要重复调用'是软约束，模型可能不遵守；状态字段是硬约束",
    "Supervisor 节点只做路由决策（职责单一），Agent 节点只执行领域任务",
    "条件边 + 回流边 = 状态机：这正是 createSupervisor 的内部机制",
    "生产级组合：visitedAgents（防重复）+ recursion limit（防无限）+ full_history（防证据缺失）",
  ]);

  console.log("\n✅ Step 05 完成（确定性路由已掌握）\n");
}

// 仅当本文件被直接运行时才执行 main：避免被 index.ts 批量模式 import 时重复执行
if (isDirectRun("step-05-deterministic-routing.ts")) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
