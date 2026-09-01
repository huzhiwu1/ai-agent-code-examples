/**
 * Step 06 – 质量兜底：Reflector 程序化硬校验（不让 LLM 自己给自己打分）
 *
 * 学习目标：
 *   1. 在 Supervisor 中加入质量检查节点，让系统自我评估输出质量
 *   2. 掌握生产级质量兜底的核心原则：**可程序化验证的检查才能叫校验**
 *
 * 为什么不能只靠 LLM 判断质量（本文实测踩坑）：
 *   早期版本用纯 LLM 做质量检查，结果 Reflector 被越权的子 Agent 骗过——
 *   weather_agent 收到完整用户请求后，违反"只处理天气"指令，顺手编了一条
 *   "小知识"（数据表里根本没有），Reflector 看到"问题都被回答了"就判通过，
 *   trivia_agent 从头到尾没被调度，编造内容直接上线。
 *
 * 教训：
 *   - LLM 主观检查（"内容是否完整"）可以被编造的流畅文本骗过
 *   - 生产级校验必须是**可程序化验证**的硬检查：
 *     声称给了小知识？→ 检查历史里有没有 lookup_city_trivia 的 tool 消息
 *   - 硬校验 = 确定性代码逻辑；LLM 检查 = 兜底的软判断，两者结合
 *
 * Reflection 模式（Reflexion 论文）：
 *   Plan → Execute → Reflect → (if not good enough) Replan
 *   本实现：Reflector 检查 Agent 输出，不通过则让 Supervisor 重新调度，
 *   最多 3 轮（reflectionCount 上限，防止反思本身变成死循环）。
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
  isDirectRun,
  lastMessageText,
  printSeparator,
  printObservations,
} from "../shared";

/** 最大反思轮数：硬校验与 LLM 软检查共用同一上限，防止「反思→重试→再反思」死循环 */
const MAX_REFLECTIONS = 3;

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
  reflectionResult: Annotation<string>({
    reducer: (_prev: string, next: string) => next,
    default: () => "",
  }),
  reflectionCount: Annotation<number>({
    reducer: (_prev: number, next: number) => next,
    default: () => 0,
  }),
  // 质量反馈（独立 state 字段，不写入 messages——避免把控制信号伪装成用户消息）
  reflectionFeedback: Annotation<string>({
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

async function supervisorNode(state: typeof ReflectorState.State) {
  const routingLLM = llm.withStructuredOutput(RoutingDecision, {
    method: "functionCalling",
    name: "routing_decision",
  });

  // 将质量反馈注入 prompt（独立 state 字段，不污染 messages）
  const feedbackText = state.reflectionFeedback
    ? `\n\n上一次质量检查反馈：${state.reflectionFeedback}\n请根据反馈重新调度。`
    : "";

  const systemPrompt = new SystemMessage(`你是调度员（Supervisor）。

子 Agent：
- weather_agent：查天气
- trivia_agent：讲城市小知识

规则：
1. 分析用户请求，选择最合适的 Agent
2. 如果所有需求都已被满足，返回 FINISH
3. 绝对不要自己编造数据${feedbackText}`);

  const decision = await routingLLM.invoke([systemPrompt, ...state.messages]);
  console.log(`  🧠 Supervisor: ${decision.next}（${decision.reasoning.slice(0, 60)}...）`);

  // 硬约束：如果还从未调度过 Agent 就说 FINISH，至少先调一个
  if (decision.next === "FINISH" && state.messages.length <= 1) {
    console.log("  🛑 检测到提前 FINISH（未调度任何 Agent）→ 强制选 weather_agent");
    return { next: "weather_agent", messages: [] };
  }

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

// ──────────────── 硬校验（程序化，确定性）───────────────

/** 用户需求 → 必须出现的工具调用 映射表（硬校验的依据） */
const REQUIREMENT_TOOL_MAP: Array<{ keywords: string[]; toolName: string; agentName: string }> = [
  {
    keywords: ["天气", "气温", "下雨", "空气质量"],
    toolName: "lookup_weather",
    agentName: "weather_agent",
  },
  {
    keywords: ["小知识", "知识", "景点", "历史", "文化"],
    toolName: "lookup_city_trivia",
    agentName: "trivia_agent",
  },
];

/** 程序化硬校验：需求提到的领域，必须在历史里有真实的工具调用记录 */
function hardCheck(state: typeof ReflectorState.State): string[] {
  const problems: string[] = [];
  const userText = state.messages.find((m) => m.getType() === "human")?.content?.toString() ?? "";
  const toolNames = new Set(
    state.messages.filter((m) => m.getType() === "tool").map((m) => (m as { name?: string }).name)
  );

  for (const req of REQUIREMENT_TOOL_MAP) {
    const mentioned = req.keywords.some((k) => userText.includes(k));
    if (mentioned && !toolNames.has(req.toolName)) {
      problems.push(
        `用户请求包含「${req.keywords[0]}」相关需求，但历史中没有任何 ${req.toolName} 工具调用记录 —— ` +
          `该需求可能未被 ${req.agentName} 处理，或数据是编造的`
      );
    }
  }
  return problems;
}

// ──────────────── Reflector 节点 ────────────────

const ReflectionResult = z.object({
  passed: z.boolean().describe("输出是否通过质量检查"),
  feedback: z.string().describe("通过的理由或不通过的具体问题"),
});

async function reflectorNode(state: typeof ReflectorState.State) {
  // 反思轮数统一在此 +1：硬校验与软检查共用同一上限，
  // 保证「硬校验一直失败」这条最容易循环的路径同样会被强制终止
  const newCount = (state.reflectionCount ?? 0) + 1;

  // ── 第一层：程序化硬校验（确定性，最可靠）──
  const hardProblems = hardCheck(state);
  if (hardProblems.length > 0) {
    if (newCount >= MAX_REFLECTIONS) {
      console.log("  ⚠️  已达最大反思次数（3次），强制结束");
      return { reflectionResult: "max_retries", reflectionCount: newCount, next: "FINISH" };
    }
    console.log(`  🔍 Reflector 硬校验 ❌：${hardProblems.join("；")}`);
    console.log(`      （第 ${newCount} 轮反思，回 Supervisor 重新调度）`);
    return {
      reflectionResult: "failed",
      reflectionCount: newCount,
      reflectionFeedback: `质量检查未通过：${hardProblems.join("；")}`,
      next: "supervisor",
    };
  }

  // ── 第二层：LLM 软检查（完整性 / 可读性，主观项兜底）──
  const reflectionLLM = llm.withStructuredOutput(ReflectionResult, {
    method: "functionCalling",
    name: "reflection",
  });

  const systemPrompt = new SystemMessage(`你是质量检查员（Reflector）。评估 Agent 的输出质量：

检查标准：
1. 是否回答了用户的所有问题？（完整性）
2. 回答是否清晰有逻辑？（可读性）

如果所有标准都满足，返回 passed=true；否则返回 passed=false 并说明问题。`);

  const result = await reflectionLLM.invoke([systemPrompt, ...state.messages]);

  if (result.passed) {
    console.log(`  🔍 Reflector: ✅ 通过（${result.feedback.slice(0, 60)}...）`);
    return { reflectionResult: "passed", reflectionCount: newCount, next: "FINISH" };
  }

  if (newCount >= MAX_REFLECTIONS) {
    console.log("  ⚠️  已达最大反思次数（3次），强制结束");
    return { reflectionResult: "max_retries", reflectionCount: newCount, next: "FINISH" };
  }

  console.log(`  🔍 Reflector: ❌ 不通过（${result.feedback.slice(0, 60)}...）`);
  return {
    reflectionResult: "failed",
    reflectionCount: newCount,
    reflectionFeedback: `质量检查未通过：${result.feedback}`,
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
  printSeparator("Step 06: 质量兜底 — Reflector 程序化硬校验");

  if (!API_KEY) {
    console.log("⚠️  跳过（未配置 LLM_API_KEY）");
    return;
  }

  const app = buildReflectorGraph();

  console.log("\n📊 带硬校验 Reflection 的图结构：");
  const graphImage = await app.getGraphAsync();
  console.log(graphImage.drawMermaid({ withStyles: true }));

  const query = "查一下杭州的天气，再讲一条和杭州有关的小知识。";
  console.log(`\n📝 用户请求：「${query}」\n`);
  console.log("🔍 执行过程（注意：weather_agent 完成后硬校验会拦截它编造的小知识）：\n");

  const result = await app.invoke({
    messages: [new HumanMessage(query)],
  });

  console.log(
    `\n📊 反思统计：共 ${result.reflectionCount} 轮反思，最终状态：${result.reflectionResult}`
  );

  // 程序化验收：trivia 是否真的跑了？
  const toolNames = result.messages
    .filter((m: BaseMessage) => m.getType() === "tool")
    .map((m) => (m as { name?: string }).name);
  console.log(
    "🛡️  程序化验收：历史中的工具调用记录 =",
    [...new Set(toolNames)].join(", ") || "（无）"
  );

  console.log("\n🤖 最终回答:\n");
  console.log(lastMessageText(result));

  console.log("-".repeat(72));
  printObservations([
    "硬校验是确定性的：需求提到了『小知识』但历史里没有 lookup_city_trivia 调用 → 直接判不通过，回 Supervisor",
    "对比纯 LLM 检查：Reflector 看『内容都被回答了』就放行 —— 但内容是子 Agent 编造的（实测踩坑）",
    "LLM 软检查只兜底完整性和可读性（主观项），数据来源由硬校验负责（客观项）",
    "反思上限 3 次：防止『反思→重试→再反思』本身变成死循环",
    "生产级组合：硬校验（防编造）+ visitedAgents（防重复调度）+ recursion limit（防无限）",
  ]);

  console.log("\n✅ Step 06 完成（程序化质量兜底已掌握）\n");
}

// 仅当本文件被直接运行时才执行 main：避免被 index.ts 批量模式 import 时重复执行
if (isDirectRun("step-06-reflection.ts")) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
