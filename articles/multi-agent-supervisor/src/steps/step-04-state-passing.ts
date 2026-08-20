/**
 * Step 04 – 状态传递：在 Agent 间共享上下文
 *
 * 学习目标：理解 Supervisor 如何在 Agent 间传递结构化状态，
 * 让后续 Agent 能"看到"前序 Agent 的输出结果。
 *
 * 核心机制：
 *   1. **消息历史传递**：Supervisor 默认把完整消息历史传给每个 Agent
 *      → Agent B 可以从对话历史中读取 Agent A 的输出
 *   2. **outputMode 控制**：
 *      - "last_message"（默认）：只传最后一条消息，节省 Token
 *      - "full_history"：传完整历史，Agent B 能看到 Agent A 的完整输出
 *   3. **结构化响应**：用 responseFormat 让 Supervisor 输出结构化 JSON
 *
 * 实战场景：
 *   用户问"杭州天气如何？如果下雨推荐室内餐厅"——
 *   需要 Agent A（天气）先输出结果，Agent B（餐厅）基于天气结果做推荐。
 *
 * 对应真实设计：
 *   LangGraph 的 StateGraph 天然支持状态在节点间传递。
 *   Supervisor 底层也是 StateGraph，消息历史就是"共享状态"。
 *
 * 跑法：pnpm run:multi-agent-supervisor:step4
 */

import { HumanMessage } from "@langchain/core/messages";
import { createSupervisor } from "@langchain/langgraph-supervisor";
import { createAgent } from "langchain";
import {
  API_KEY,
  llm,
  lookupWeatherTool,
  lookupRestaurantsTool,
  lastMessageText,
  printSeparator,
  printObservations,
} from "../shared";

export async function main() {
  printSeparator("Step 04: 状态传递 — Agent 间共享上下文");

  if (!API_KEY) {
    console.log("⚠️  跳过（未配置 LLM_API_KEY）");
    return;
  }

  const weatherAgent = createAgent({
    name: "weather_agent",
    description: "专门查天气的子 Agent。",
    model: llm,
    tools: [lookupWeatherTool],
    systemPrompt: `你只处理天气。必须先调用 lookup_weather，然后输出结构化的天气信息。
输出格式：简要说明天气概况、温度、是否下雨。`,
  });

  const restaurantAgent = createAgent({
    name: "restaurant_agent",
    description: "专门推荐餐厅的子 Agent。",
    model: llm,
    tools: [lookupRestaurantsTool],
    systemPrompt: `你只推荐餐厅。必须先调用 lookup_restaurants 获取数据。
重要：你需要查看对话历史中 weather_agent 的天气结果。
- 如果下雨 → 推荐室内/商场内的餐厅，并说明"因为今天下雨，推荐以下室内餐厅"；
- 如果晴天 → 推荐户外/露台餐厅，并说明"今天天气不错，推荐以下适合户外的餐厅"；
- 如果没有天气信息 → 正常推荐不做特殊说明。`,
  });

  // 关键：使用 full_history 模式，让餐厅 Agent 能读到天气 Agent 的输出
  // addHandoffMessages: false — DeepSeek 兼容性配置
  const workflow = createSupervisor({
    agents: [weatherAgent.graph, restaurantAgent.graph],
    llm,
    supervisorName: "supervisor",
    includeAgentName: "inline",
    addHandoffMessages: false,
    addHandoffBackMessages: false,
    outputMode: "full_history", // 关键配置：让 Agent 看到完整对话历史
    prompt: `你是调度员。根据用户请求选择合适的 Agent：

你的子 Agent：
- weather_agent：查天气、气温、是否下雨
- restaurant_agent：推荐餐厅，会根据天气情况调整推荐策略

规则：
1. 如果用户先问天气再问餐厅 → 先调 weather_agent 再调 restaurant_agent
2. 如果用户只问餐厅 → 直接调 restaurant_agent
3. 所有需求满足后，输出 FINISH
4. 不要自己回答问题，交给子 Agent 处理`,
  });

  const app = workflow.compile();

  // 演示：先天气后餐厅 —— 餐厅 Agent 需要读取天气结果
  const query = "杭州今天天气怎么样？如果下雨的话，推荐一些适合雨天去的餐厅。";
  console.log(`\n📝 用户请求：「${query}」\n`);
  console.log("🔑 关键配置：outputMode = 'full_history' → 餐厅 Agent 能读到天气 Agent 的输出\n");

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

  // 展示消息历史传递
  console.log("\n" + "-".repeat(72));
  console.log("📬 消息历史中的 Agent 间传递（共", finalState?.messages?.length ?? 0, "条消息）：");
  finalState?.messages?.forEach((msg, i) => {
    const content =
      typeof msg.content === "string"
        ? msg.content.slice(0, 80)
        : JSON.stringify(msg.content).slice(0, 80);
    const type = (msg as { _getType?: () => string })._getType?.() ?? "unknown";
    console.log(`  [${i}] ${type}: ${content}...`);
  });

  printObservations([
    "outputMode='full_history' 让餐厅 Agent 看到天气 Agent 的完整输出",
    "餐厅 Agent 的 System Prompt 明确要求「根据天气结果调整推荐策略」→ 这就是状态传递",
    "如果改成 outputMode='last_message'（默认），餐厅 Agent 可能看不到天气信息",
    "实际生产中可以进一步用 stateSchema 自定义状态字段，传递结构化数据",
  ]);

  console.log("\n✅ Step 04 完成（状态传递机制已理解）\n");
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
