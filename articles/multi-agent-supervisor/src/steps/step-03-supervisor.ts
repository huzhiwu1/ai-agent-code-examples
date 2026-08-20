/**
 * Step 03 – Supervisor 自动路由：声明式多 Agent 调度
 *
 * 学习目标：理解 Supervisor 模式的核心机制 ——
 * 用一个"调度员 LLM"自动决定每个请求该交给哪个子 Agent 处理。
 *
 * 做法：
 *   1. 创建两个专门 Agent（weather_agent / trivia_agent）
 *   2. 用 createSupervisor 创建一个调度员
 *   3. 调度员自动路由：看到天气关键词 → 调 weather_agent，看到知识关键词 → 调 trivia_agent
 *   4. 支持多步骤：用户同时问天气+知识，Supervisor 自动串联调用
 *
 * 核心概念：
 *   - Supervisor = 一个不直接执行任务的 LLM，只负责"选人"
 *   - 子 Agent = 只拥有领域工具，职责单一
 *   - 路由是声明式的（写在 Supervisor Prompt 里），不是 if-else
 *   - 多步骤：Supervisor 可以多次调用不同 Agent，直到任务完成
 *
 * 与 Step 02 的对比：
 *   Step 02（手动 Handoff）：Router 只能选一个 → 复合查询丢失
 *   Step 03（Supervisor）：自动多次调用 → 复合查询完整覆盖
 *
 * 对应真实设计：
 *   LangGraph Supervisor 是生产级多 Agent 模式的基础。
 *   deepagents 的 createDeepAgent 底层也是 Supervisor 模式的变体。
 *
 * 跑法：pnpm run:multi-agent-supervisor:step3
 */

import { HumanMessage } from "@langchain/core/messages";
import { createSupervisor } from "@langchain/langgraph-supervisor";
import { createAgent } from "langchain";
import {
  API_KEY,
  llm,
  lookupWeatherTool,
  lookupCityTriviaTool,
  lastMessageText,
  printSeparator,
  printObservations,
} from "../shared";

export async function main() {
  printSeparator("Step 03: Supervisor 自动路由 — 声明式多 Agent 调度");

  if (!API_KEY) {
    console.log("⚠️  跳过（未配置 LLM_API_KEY）");
    return;
  }

  // 两个专门 Agent：职责单一，System Prompt 极短
  const weatherAgent = createAgent({
    name: "weather_agent",
    description: "专门查天气的子 Agent。",
    model: llm,
    tools: [lookupWeatherTool],
    systemPrompt: "你只处理天气。用户提到城市时，必须先调用 lookup_weather，再用中文简短说明。",
  });

  const triviaAgent = createAgent({
    name: "trivia_agent",
    description: "专门讲城市小知识的子 Agent。",
    model: llm,
    tools: [lookupCityTriviaTool],
    systemPrompt: "你只讲城市小知识。必须先调用 lookup_city_trivia，再用人话转述，不要编造。",
  });

  // 关键：Supervisor 只负责"选人"，不直接执行任务
  // addHandoffMessages: false — DeepSeek 兼容性配置，避免 tool_calls 配对校验失败
  const workflow = createSupervisor({
    agents: [weatherAgent.graph, triviaAgent.graph],
    llm,
    supervisorName: "supervisor",
    includeAgentName: "inline",
    addHandoffMessages: false,
    addHandoffBackMessages: false,
    prompt: `你是调度员（Supervisor），只负责选人，绝对不要自己报气温或讲城市百科。

你的子 Agent 及其职责：
- weather_agent：查天气、气温、下雨、空气质量
- trivia_agent：讲城市小知识、景点、历史、文化

规则：
1. 分析用户请求，每次只调用一个 Agent
2. 如果用户问天气 → 调 weather_agent，问完后立即 FINISH
3. 如果用户问知识 → 调 trivia_agent，问完后立即 FINISH
4. 如果用户同时问天气+知识 → 先调 weather_agent，再调 trivia_agent，然后 FINISH
5. 绝对不要重复调用同一个 Agent，每个 Agent 最多调用一次
6. 绝对不要自己编造数据，必须交给子 Agent 处理`,
  });

  const app = workflow.compile();

  // 打印图结构
  console.log("\n📊 Supervisor 图结构（Mermaid）：");
  const graph = await app.getGraphAsync();
  console.log(graph.drawMermaid({ withStyles: true }));

  // 演示 1：复合查询 —— Supervisor 自动处理多步骤
  const query = "查一下杭州的天气，再讲一条和杭州有关的小知识。";
  console.log(`\n📝 用户请求：「${query}」\n`);

  const nodePath: string[] = [];
  let finalState: { messages?: Array<{ content?: unknown }> } | null = null;

  const stream = await app.stream(
    { messages: [new HumanMessage(query)] },
    { streamMode: ["updates", "values"] }
  );
  for await (const event of stream) {
    const [mode, payload] = event as [string, Record<string, unknown>];
    if (mode === "updates" && payload && typeof payload === "object") {
      const keys = Object.keys(payload);
      if (keys.length > 0) nodePath.push(...keys);
    }
    if (mode === "values") {
      finalState = payload as { messages?: Array<{ content?: unknown }> };
    }
  }

  console.log("🔀 执行路径:", nodePath.join(" → "));
  console.log("\n🤖 最终回答:\n");
  console.log(lastMessageText(finalState ?? {}));

  console.log("-".repeat(72));
  printObservations([
    "Supervisor 自动处理了复合查询（天气 + 知识），没有遗漏任何一个需求",
    "子 Agent 的 System Prompt 仍然极短，职责单一 —— 这是多 Agent 的核心优势",
    "Supervisor 的 Prompt 是声明式的：「如果A则选X，如果B则选Y」—— 不是 if-else 代码",
    "图结构展示了 Supervisor → Agent → Supervisor 的循环：调度员可以多次调用 Agent",
  ]);

  console.log("\n✅ Step 03 完成（Supervisor 模式已掌握）\n");
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
