/**
 * Step 05 – 多 Agent 协作：旅行规划综合场景
 *
 * 学习目标：将多个专门 Agent 组合起来，完成一个复杂的旅行规划任务。
 * 展示 Supervisor 如何协调 4 个 Agent 并行/串行工作。
 *
 * 场景：用户要求规划一趟杭州三日游，需要：
 *   1. 天气信息（weather_agent）→ 决定带什么衣服
 *   2. 景点知识（trivia_agent）→ 了解去哪里玩
 *   3. 餐厅推荐（restaurant_agent）→ 吃什么
 *   4. 旅行贴士（travel_agent）→ 注意事项
 *
 * 核心概念：
 *   - **并行 vs 串行**：天气、知识、贴士之间没有依赖 → 可以并行（Supervisor 自行判断）
 *   - **依赖链**：餐厅推荐可能需要等天气结果（如果下雨推荐室内餐厅）
 *   - **最终汇总**：Supervisor 收集所有 Agent 结果后输出综合建议
 *
 * 核心洞见：多 Agent 不是银弹
 *   - 这个场景中，4 个 Agent 需要 4+ 次 LLM 调用（Supervisor 路由 + 每个 Agent 推理）
 *   - 如果单 Agent 能准确处理，Token 消耗和延迟更低
 *   - 多 Agent 的真正价值在于：复杂依赖、长上下文拆分、多领域专家协作
 *
 * 对应真实设计：
 *   CrewAI 的 "Crew" 概念：多个 Agent 围绕一个任务协作。
 *   AutoGen 的 GroupChat：多个 Agent 在群聊中协作。
 *
 * 跑法：pnpm run:multi-agent-supervisor:step5
 */

import { HumanMessage } from "@langchain/core/messages";
import { createSupervisor } from "@langchain/langgraph-supervisor";
import { createAgent } from "langchain";
import {
  API_KEY,
  llm,
  lookupWeatherTool,
  lookupCityTriviaTool,
  lookupRestaurantsTool,
  lookupTravelTipsTool,
  lastMessageText,
  printSeparator,
  printObservations,
} from "../shared";

export async function main() {
  printSeparator("Step 05: 多 Agent 协作 — 旅行规划综合场景");

  if (!API_KEY) {
    console.log("⚠️  跳过（未配置 LLM_API_KEY）");
    return;
  }

  // 4 个专门 Agent，每个只负责一个领域
  const weatherAgent = createAgent({
    name: "weather_agent",
    description: "查天气。",
    model: llm,
    tools: [lookupWeatherTool],
    systemPrompt: "你只查天气。调用 lookup_weather，用中文简要说明。",
  });

  const triviaAgent = createAgent({
    name: "trivia_agent",
    description: "讲城市知识和景点。",
    model: llm,
    tools: [lookupCityTriviaTool],
    systemPrompt: "你只讲城市知识和景点。调用 lookup_city_trivia，用人话转述。",
  });

  const restaurantAgent = createAgent({
    name: "restaurant_agent",
    description: "推荐餐厅。",
    model: llm,
    tools: [lookupRestaurantsTool],
    systemPrompt:
      "你只推荐餐厅。调用 lookup_restaurants 获取数据，推荐时说明菜系和人均价格。可选：查看对话历史中的天气信息，如果下雨可推荐室内餐厅。",
  });

  const travelAgent = createAgent({
    name: "travel_agent",
    description: "提供旅行贴士。",
    model: llm,
    tools: [lookupTravelTipsTool],
    systemPrompt: "你只提供旅行贴士。调用 lookup_travel_tips，用中文整理成要点。",
  });

  // 4 Agent Supervisor
  // addHandoffMessages: false — DeepSeek 兼容性配置，避免 tool_calls 配对校验失败
  const workflow = createSupervisor({
    agents: [weatherAgent.graph, triviaAgent.graph, restaurantAgent.graph, travelAgent.graph],
    llm,
    supervisorName: "supervisor",
    includeAgentName: "inline",
    addHandoffMessages: false,
    addHandoffBackMessages: false,
    outputMode: "full_history",
    prompt: `你是旅行规划调度员。管理 4 个专家 Agent：

- weather_agent：查天气
- trivia_agent：讲城市知识/景点
- restaurant_agent：推荐餐厅
- travel_agent：提供旅行贴士

规则：
1. 分析用户请求，确定需要哪些 Agent，列出调用顺序
2. 天气、知识、贴士互不依赖，任意顺序调用，但每个 Agent 最多调用一次
3. 餐厅推荐放在天气之后（可根据天气调整推荐策略）
4. 每调用完一个 Agent 就立即调用下一个，不要重复调用同一个 Agent
5. 所有需要的 Agent 都调用完毕后，立即 FINISH，汇总时引用各 Agent 的输出
6. 绝对不要自己编造数据，必须交给子 Agent 处理`,
  });

  const app = workflow.compile();

  console.log("\n📊 4 Agent Supervisor 图结构：");
  const graph = await app.getGraphAsync();
  console.log(graph.drawMermaid({ withStyles: true }));

  const query = "帮我规划一趟杭州三日游，需要了解天气、景点知识、美食推荐和旅行贴士。";
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
  console.log("\n🤖 最终旅行规划:\n");
  console.log(lastMessageText(finalState ?? {}));

  console.log("-".repeat(72));
  printObservations([
    "观察执行路径：哪些 Agent 是并行调用的？哪些是串行的？",
    "4 个 Agent 的 System Prompt 都极短，但组合起来能处理复杂任务 —— 这就是多 Agent 的核心价值",
    "思考：这个场景是否真的需要 4 个 Agent？如果只用 1 个 Agent + 4 个工具，效果会差多少？",
    "Token 消耗：4 个 Agent 意味着 4+ 次 LLM 调用（Supervisor 路由 + 每个 Agent 的推理），成本更高",
    "多 Agent 的适用场景：当单 Agent 的 System Prompt 过长、工具选择准确率下降、或需要不同角色协作时",
  ]);

  console.log("\n✅ Step 05 完成（多 Agent 协作已实践）\n");
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
