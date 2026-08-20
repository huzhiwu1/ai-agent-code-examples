/**
 * Step 02 – 手动 Handoff：两个 Agent 手动交接
 *
 * 学习目标：理解最简单的多 Agent 协作模式——Handoff（任务交接）。
 *
 * 做法：
 *   1. 用 Router LLM 先判断用户意图（天气 vs 知识）
 *   2. 根据意图手动调用对应的子 Agent
 *   3. 每个子 Agent 只拥有一个领域的工具，System Prompt 极短
 *
 * 核心概念：
 *   - Handoff = 一个 Agent 把任务"交接"给另一个 Agent
 *   - 路由逻辑：基于意图分类 → 选择 Agent
 *   - 职责单一：每个 Agent 只专注一件事
 *
 * 局限性（为 Step 03 Supervisor 做铺垫）：
 *   - 路由是硬编码的 if-else，不支持多步骤任务
 *   - 如果用户同时问天气+知识，Router 只能选一个
 *   - 无法自动处理"先查A再查B"的依赖关系
 *
 * 对应真实设计：
 *   OpenAI Swarm 的 handoff 原语：Agent A 调用 handoff(Agent B) 转移控制权。
 *   LangGraph 的 Command(goto="agent_b") 实现类似效果。
 *
 * 跑法：pnpm run:multi-agent-supervisor:step2
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
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
  printSeparator("Step 02: 手动 Handoff — 两个 Agent 通过 Router 手动交接");

  if (!API_KEY) {
    console.log("⚠️  跳过（未配置 LLM_API_KEY）");
    return;
  }

  // 两个专门 Agent：每个只拥有一个工具，System Prompt 极短
  const weatherAgent = createAgent({
    name: "weather_agent",
    model: llm,
    tools: [lookupWeatherTool],
    systemPrompt: "你只处理天气查询。必须先调用 lookup_weather，再用中文简要说明天气情况。",
  });

  const triviaAgent = createAgent({
    name: "trivia_agent",
    model: llm,
    tools: [lookupCityTriviaTool],
    systemPrompt: "你只讲城市知识和景点。必须先调用 lookup_city_trivia，再用人话转述。",
  });

  // Router: 用 LLM 判断意图
  async function routeIntent(query: string): Promise<"weather" | "trivia" | "unknown"> {
    const routerPrompt = new SystemMessage(
      `你是一个路由分类器。分析用户输入，判断意图类型，只输出一个词：
- 如果用户问天气、气温、下雨、空气质量 → 输出 "weather"
- 如果用户问城市知识、景点、历史、文化 → 输出 "trivia"
- 否则 → 输出 "unknown"

只输出一个词，不要解释。`
    );

    const result = await llm.invoke([routerPrompt, new HumanMessage(query)]);
    const content = typeof result.content === "string" ? result.content.trim().toLowerCase() : "";
    if (content.includes("weather")) return "weather";
    if (content.includes("trivia")) return "trivia";
    return "unknown";
  }

  // 演示 1：纯天气查询
  const query1 = "杭州今天天气怎么样？";
  console.log(`\n📝 演示 1：「${query1}」`);
  const intent1 = await routeIntent(query1);
  console.log(`🔀 Router 判断意图：${intent1}`);

  if (intent1 === "weather") {
    console.log("👉 交接给 weather_agent ...");
    const result = await weatherAgent.graph.invoke({
      messages: [new HumanMessage(query1)],
    });
    console.log("🤖 weather_agent 回答：", lastMessageText(result).slice(0, 150));
  }

  // 演示 2：纯知识查询
  const query2 = "杭州有什么著名的历史文化景点？";
  console.log(`\n📝 演示 2：「${query2}」`);
  const intent2 = await routeIntent(query2);
  console.log(`🔀 Router 判断意图：${intent2}`);

  if (intent2 === "trivia") {
    console.log("👉 交接给 trivia_agent ...");
    const result = await triviaAgent.graph.invoke({
      messages: [new HumanMessage(query2)],
    });
    console.log("🤖 trivia_agent 回答：", lastMessageText(result).slice(0, 150));
  }

  // 演示 3：复合查询 —— 暴露局限性
  const query3 = "杭州今天天气怎么样？另外有什么景点推荐？";
  console.log(`\n📝 演示 3（复合查询）：「${query3}」`);
  const intent3 = await routeIntent(query3);
  console.log(`🔀 Router 判断意图：${intent3}`);
  console.log(`⚠️  Router 只能选一个 Agent！如果用户同时问天气+知识，必然丢失一个。`);

  console.log("-".repeat(72));
  printObservations([
    "Router 模式简单但脆弱：硬编码规则无法处理复合查询",
    "每个 Agent 的 System Prompt 极短（1 句话），职责单一",
    "如果要支持复合查询，需要多次调用 Router 或引入 Supervisor 自动调度",
    "这就是为什么需要 Step 03 的 Supervisor 模式 —— 自动处理多步骤、多 Agent 调度",
  ]);

  console.log("\n✅ Step 02 完成（Handoff 模式已理解，暴露了局限性）\n");
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
