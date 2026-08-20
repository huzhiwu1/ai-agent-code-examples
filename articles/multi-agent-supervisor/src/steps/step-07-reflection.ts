/**
 * Step 07 – 反思与权衡：Reflection 模式 + 单/多 Agent 对比
 *
 * 学习目标：
 *   1. 在 Supervisor 中加入 Reflection 节点，让系统自我评估输出质量
 *   2. 对比单 Agent vs 多 Agent 的优劣，理解何时用、何时不用
 *
 * Reflection 模式（Reflexion 论文的核心思想）：
 *   Plan → Execute → Reflect → (if not good enough) Replan
 *   在我们的实现中，Reflector 检查 Agent 输出是否完整、准确，
 *   如果不满意，让 Supervisor 重新调度。
 *
 * 核心洞见：多 Agent 不是银弹 ——
 *   - 单 Agent 适用：任务简单、工具少（<5）、领域单一
 *   - 多 Agent 适用：任务复杂、工具多（>5）、多领域、需要角色分离
 *   - 关键指标：工具选择准确率、System Prompt 复杂度、Token 成本
 *
 * 对应真实设计：
 *   Reflexion 论文（Shinn et al., 2023）：LLM 自我反思提升推理能力。
 *   LangGraph 的 Reflexion Agent 实现：在图中加入 evaluate 节点。
 *   deepagents 的 replan 机制：失败后反思并重新规划。
 *
 * 跑法：pnpm run:multi-agent-supervisor:step7
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

const ReflectorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev: BaseMessage[], next: BaseMessage[]) => prev.concat(next),
    default: () => [],
  }),
  next: Annotation<string>({
    reducer: (_prev: string, next: string) => next,
    default: () => "supervisor",
  }),
  // 反思结果：pass（通过）或 fail（不通过，需要重试）
  reflectionResult: Annotation<string>({
    reducer: (_prev: string, next: string) => next,
    default: () => "",
  }),
  // 反思轮次计数
  reflectionCount: Annotation<number>({
    reducer: (_prev: number, next: number) => next,
    default: () => 0,
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

async function supervisorNode(state: typeof ReflectorState.State) {
  const routingLLM = llm.withStructuredOutput(RoutingDecision, {
    method: "functionCalling",
    name: "routing_decision",
  });

  const systemPrompt = new SystemMessage(`你是调度员（Supervisor）。

子 Agent：
- weather_agent：查天气
- trivia_agent：讲城市小知识

规则：
1. 分析用户请求，选择最合适的 Agent
2. 如果所有需求都已被满足，返回 FINISH
3. 绝对不要自己编造数据`);

  const decision = await routingLLM.invoke([systemPrompt, ...state.messages]);
  console.log(`  🧠 Supervisor: ${decision.next}（${decision.reasoning.slice(0, 50)}...）`);

  return { next: decision.next, messages: [] };
}

async function weatherAgentNode(state: typeof ReflectorState.State) {
  console.log("  🌤️  weather_agent 执行中...");
  const result = await weatherAgent.graph.invoke({ messages: state.messages });
  const agentMessages = result.messages.slice(state.messages.length);
  return { messages: agentMessages, next: "reflector" };
}

async function triviaAgentNode(state: typeof ReflectorState.State) {
  console.log("  📚 trivia_agent 执行中...");
  const result = await triviaAgent.graph.invoke({ messages: state.messages });
  const agentMessages = result.messages.slice(state.messages.length);
  return { messages: agentMessages, next: "reflector" };
}

/**
 * Reflector 节点：自我评估 Agent 输出的质量
 *
 * 这是 Reflection 模式的核心。Reflector 不执行任务，而是：
 * 1. 检查 Agent 输出是否完整（是否回答了用户的所有问题）
 * 2. 检查数据是否来源于工具调用（不是编造的）
 * 3. 检查逻辑是否合理
 * 4. 如果通过 → 返回 FINISH；如果不通过 → 返回 supervisor 重新调度
 */
const ReflectionResult = z.object({
  passed: z.boolean().describe("输出是否通过质量检查"),
  feedback: z.string().describe("通过的理由或不通过的具体问题"),
});

async function reflectorNode(state: typeof ReflectorState.State) {
  const reflectionLLM = llm.withStructuredOutput(ReflectionResult, {
    method: "functionCalling",
    name: "reflection",
  });

  const systemPrompt = new SystemMessage(`你是质量检查员（Reflector）。评估 Agent 的输出质量：

检查标准：
1. 是否回答了用户的所有问题？（完整性）
2. 数据是否来自工具调用结果？（准确性）
3. 回答是否清晰有逻辑？（可读性）

如果所有标准都满足，返回 passed=true；否则返回 passed=false 并说明问题。`);

  const result = await reflectionLLM.invoke([systemPrompt, ...state.messages]);

  const newCount = (state.reflectionCount ?? 0) + 1;
  console.log(
    `  🔍 Reflector: ${result.passed ? "✅ 通过" : "❌ 不通过"}（${result.feedback.slice(0, 60)}...）`
  );

  if (result.passed) {
    return {
      reflectionResult: "passed",
      reflectionCount: newCount,
      next: "FINISH",
    };
  }

  if (newCount >= 3) {
    console.log("  ⚠️  已达最大反思次数（3次），强制结束");
    return {
      reflectionResult: "max_retries",
      reflectionCount: newCount,
      next: "FINISH",
    };
  }

  return {
    reflectionResult: "failed",
    reflectionCount: newCount,
    messages: [
      new HumanMessage(
        `质量检查未通过：${result.feedback}。请 Supervisor 重新调度，确保问题被解决。`
      ),
    ],
    next: "supervisor",
  };
}

// ──────────────── 图构建 ────────────────

function buildReflectorGraph() {
  return (
    new StateGraph(ReflectorState)
      .addNode("supervisor", supervisorNode)
      .addNode("weather_agent", weatherAgentNode)
      .addNode("trivia_agent", triviaAgentNode)
      .addNode("reflector", reflectorNode)

      .addEdge(START, "supervisor")

      .addConditionalEdges("supervisor", (state: typeof ReflectorState.State) => state.next, {
        weather_agent: "weather_agent",
        trivia_agent: "trivia_agent",
        FINISH: END,
      })

      // Agent 完成后先到 Reflector 检查，而不是直接回 Supervisor
      .addEdge("weather_agent", "reflector")
      .addEdge("trivia_agent", "reflector")

      // Reflector 检查后：通过 → FINISH；不通过 → 回 Supervisor
      .addConditionalEdges("reflector", (state: typeof ReflectorState.State) => state.next, {
        supervisor: "supervisor",
        FINISH: END,
      })

      .compile()
  );
}

// ──────────────── 主函数 ────────────────

export async function main() {
  printSeparator("Step 07: 反思与权衡 — Reflection + 单/多 Agent 对比");

  if (!API_KEY) {
    console.log("⚠️  跳过（未配置 LLM_API_KEY）");
    return;
  }

  const app = buildReflectorGraph();

  console.log("\n📊 带 Reflection 的 Supervisor 图结构：");
  const graphImage = await app.getGraphAsync();
  console.log(graphImage.drawMermaid({ withStyles: true }));

  const query = "查一下杭州的天气，再讲一条和杭州有关的小知识。";
  console.log(`\n📝 用户请求：「${query}」\n`);
  console.log("🔍 执行过程（观察 Supervisor → Agent → Reflector 的循环）：\n");

  const result = await app.invoke({
    messages: [new HumanMessage(query)],
  });

  console.log(
    `\n📊 反思统计：共 ${result.reflectionCount} 轮反思，最终状态：${result.reflectionResult}`
  );
  console.log("\n🤖 最终回答:\n");
  console.log(lastMessageText(result));

  console.log("\n" + "=".repeat(72));
  console.log("📊 单 Agent vs 多 Agent 综合对比");
  console.log("=".repeat(72));

  console.log(`
┌─────────────────┬────────────────────────┬────────────────────────┐
│      维度        │      单 Agent           │      多 Agent           │
├─────────────────┼────────────────────────┼────────────────────────┤
│ System Prompt   │ 长（覆盖所有领域）       │ 短（每个 Agent 1-2 句） │
│ 工具选择准确率   │ 随工具数增加而下降       │ 每个 Agent 只选 1-2 个   │
│ Token 消耗      │ 低（1 次 LLM 调用）      │ 高（N 次 LLM 调用）      │
│ 延迟            │ 低                       │ 高（串行/并行）          │
│ 可维护性        │ 加工具需改 System Prompt  │ 加 Agent 不影响现有      │
│ 复合任务处理    │ 可能漏步骤               │ Supervisor 自动多步调度  │
│ 适合场景        │ 简单任务、工具 < 5       │ 复杂任务、多领域、角色分离│
└─────────────────┴────────────────────────┴────────────────────────┘`);

  printObservations([
    "Reflection 节点在 Agent 执行后评估质量，不通过则回 Supervisor 重试 —— 这是生产级的质量保障",
    "反思循环有最大次数限制（3次），防止无限循环，这是工程实践中的关键细节",
    "多 Agent 增加 Token 消耗和延迟，但换来更好的工具选择准确率和可维护性",
    "决策框架：如果单 Agent 的 System Prompt < 500 字且工具 < 5 个 → 用单 Agent；否则考虑多 Agent",
    "LangGraph 的 StateGraph 让你可以灵活组合这些模式：Supervisor + Reflection + Replan 都在一张图中",
  ]);

  console.log("\n✅ Step 07 完成（Reflection 模式 + 权衡分析已掌握）\n");
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
