/**
 * Step 06 – 从零搭建 Supervisor：用 StateGraph 手写实现
 *
 * 学习目标：拆解 createSupervisor 的黑盒，理解其内部机制。
 * 用 StateGraph 从零搭建一个 Supervisor，掌握：
 *   1. State 定义 —— 图的状态结构
 *   2. Supervisor 节点 —— LLM 决策路由
 *   3. Agent 节点 —— 包装子 Agent 执行
 *   4. 条件边 —— 根据 Supervisor 决策跳转到不同 Agent
 *   5. 循环控制 —— Agent 完成后回到 Supervisor 继续决策
 *
 * 这是整个教程最核心的一步：理解了 StateGraph + Supervisor 的内部机制，
 * 你就能自己设计任意复杂的多 Agent 编排模式。
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
 * 对应真实设计：
 *   LangGraph 的 createSupervisor 内部就是 StateGraph + 条件边。
 *   deepagents / dsh 的 Agent 编排也是基于同样的 StateGraph 机制。
 *
 * 跑法：pnpm run:multi-agent-supervisor:step6
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
  lastMessageText,
  printSeparator,
  printObservations,
} from "../shared";

// ──────────────── State 定义 ────────────────
// 这是 Supervisor 图的核心状态。每个节点读写这个 State。

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
 * 这是整个图的大脑。它不直接执行任务，而是：
 * 1. 分析当前对话状态
 * 2. 用 structured output 输出一个路由决策
 * 3. 通过 state.next 控制图中的流转
 */
const RoutingDecision = z.object({
  reasoning: z.string().describe("为什么选择这个 Agent"),
  next: z
    .enum(["weather_agent", "trivia_agent", "FINISH"])
    .describe("下一个要调用的 Agent，或 FINISH 表示结束"),
});

async function supervisorNode(state: typeof SupervisorState.State) {
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
4. 绝对不要自己编造数据，必须交给子 Agent 处理`);

  const messages = [systemPrompt, ...state.messages];
  const decision = await routingLLM.invoke(messages);

  console.log(`  🧠 Supervisor 决策: ${decision.next}（${decision.reasoning}）`);

  return {
    next: decision.next,
    messages: [], // Supervisor 不产生新消息，只做路由
  };
}

/**
 * Agent 节点：包装子 Agent 的执行
 *
 * 每个 Agent 节点做三件事：
 * 1. 从 state 中取出消息历史
 * 2. 调用子 Agent 的 graph
 * 3. 返回新消息（会被 reducer 合并到 state.messages 中）
 */
async function weatherAgentNode(state: typeof SupervisorState.State) {
  console.log("  🌤️  weather_agent 开始执行...");
  const result = await weatherAgent.graph.invoke({
    messages: state.messages,
  });
  // 只返回 Agent 产生的增量消息
  const agentMessages = result.messages.slice(state.messages.length);
  console.log("  🌤️  weather_agent 完成");
  return { messages: agentMessages, next: "supervisor" };
}

async function triviaAgentNode(state: typeof SupervisorState.State) {
  console.log("  📚 trivia_agent 开始执行...");
  const result = await triviaAgent.graph.invoke({
    messages: state.messages,
  });
  const agentMessages = result.messages.slice(state.messages.length);
  console.log("  📚 trivia_agent 完成");
  return { messages: agentMessages, next: "supervisor" };
}

// ──────────────── 图构建 ────────────────

/**
 * 这就是 createSupervisor 内部做的事情：
 * 1. 定义 State
 * 2. 添加 Supervisor 节点和 Agent 节点
 * 3. 添加条件边：Supervisor → Agent / FINISH
 * 4. 添加回流边：Agent → Supervisor（形成循环）
 */
function buildSupervisorGraph() {
  const graph = new StateGraph(SupervisorState)
    // 添加节点
    .addNode("supervisor", supervisorNode)
    .addNode("weather_agent", weatherAgentNode)
    .addNode("trivia_agent", triviaAgentNode)

    // 入口：从 START 到 supervisor
    .addEdge(START, "supervisor")

    // 条件边：supervisor 根据 state.next 决定跳转到哪个 Agent
    .addConditionalEdges("supervisor", (state: typeof SupervisorState.State) => state.next, {
      weather_agent: "weather_agent",
      trivia_agent: "trivia_agent",
      FINISH: END,
    })

    // 回流边：Agent 完成后回到 supervisor 继续决策
    .addEdge("weather_agent", "supervisor")
    .addEdge("trivia_agent", "supervisor");

  return graph.compile();
}

// ──────────────── 主函数 ────────────────

export async function main() {
  printSeparator("Step 06: 从零搭建 Supervisor — StateGraph 手写实现");

  if (!API_KEY) {
    console.log("⚠️  跳过（未配置 LLM_API_KEY）");
    return;
  }

  const app = buildSupervisorGraph();

  // 打印图结构
  console.log("\n📊 手写 Supervisor 图结构：");
  const graphImage = await app.getGraphAsync();
  console.log(graphImage.drawMermaid({ withStyles: true }));

  const query = "查一下杭州的天气，再讲一条和杭州有关的小知识。";
  console.log(`\n📝 用户请求：「${query}」\n`);

  console.log("🔍 执行过程（观察 Supervisor 如何一步步决策）：\n");

  const result = await app.invoke({
    messages: [new HumanMessage(query)],
  });

  console.log("\n🤖 最终回答:\n");
  console.log(lastMessageText(result));

  console.log("-".repeat(72));
  printObservations([
    "Supervisor 节点：只做路由决策，不产生回答内容 —— 职责单一",
    "Agent 节点：只执行自己的领域工具，完成后回到 Supervisor",
    "条件边：state.next 决定流转方向，这是图的核心控制机制",
    "回流边：Agent → Supervisor 形成循环，直到 Supervisor 决定 FINISH",
    "现在你完全理解了 createSupervisor 的内部机制！可以用 StateGraph 自定义任意编排模式",
  ]);

  console.log("\n✅ Step 06 完成（Supervisor 内部机制已掌握）\n");
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
