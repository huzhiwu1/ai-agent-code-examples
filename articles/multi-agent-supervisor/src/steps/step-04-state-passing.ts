/**
 * Step 04 – 状态传递与上下文管理：Agent 间共享上下文 + Token 成本意识
 *
 * 学习目标：
 *   1. 理解 outputMode 如何控制 Agent 间的上下文共享
 *   2. 掌握生产级上下文管理：状态传递 vs Token 成本 / 上下文去噪
 *
 * 生产级要点：
 *   ① full_history 让后序 Agent 看到前序 Agent 的完整执行轨迹
 *     —— 这是"状态传递"的基石（餐厅 Agent 要读天气结果才能做雨天推荐）
 *   ② Token 成本意识：多 Agent 系统因冗余上下文共享，消耗是理论值的
 *     1.5x ~ 7x（Galileo 实测：MetaGPT 72% / CAMEL 86% 的 token 是重复的）。
 *     本 Step 会真实打印每次运行的 token 消耗，让你建立成本直觉
 *   ③ 上下文去噪：LangChain 官方 Benchmark 发现"从子 Agent 上下文中移除
 *     交接消息"能让 Supervisor 性能提升近 50% —— 上下文里的噪声对模型
 *     可靠性的影响远超直觉
 *
 * 实战场景：
 *   用户问"杭州天气如何？如果下雨推荐室内餐厅"——
 *   需要 Agent A（天气）先输出结果，Agent B（餐厅）基于天气结果做推荐。
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
  isDirectRun,
  lastMessageText,
  printSeparator,
  printObservations,
} from "../shared";

/** 从消息历史中累计所有 AI 消息的 token 用量（usage_metadata 由模型返回） */
function sumTokenUsage(messages: Array<{ usage_metadata?: { total_tokens?: number } }>): number {
  return messages.reduce((sum, m) => sum + (m.usage_metadata?.total_tokens ?? 0), 0);
}

export async function main() {
  printSeparator("Step 04: 状态传递 — Agent 间共享上下文 + Token 成本");

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
  const workflow = createSupervisor({
    agents: [weatherAgent.graph, restaurantAgent.graph],
    llm,
    supervisorName: "supervisor",
    includeAgentName: "inline",
    // DeepSeek 兼容 + 上下文去噪（详见 Step 03）
    addHandoffMessages: false,
    addHandoffBackMessages: false,
    // 生产级关键配置：完整对话历史 → 后序 Agent 能看到前序 Agent 的输出
    outputMode: "full_history",
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

  const query = "杭州今天天气怎么样？如果下雨的话，推荐一些适合雨天去的餐厅。";
  console.log(`\n📝 用户请求：「${query}」\n`);
  console.log("🔑 关键配置：outputMode = 'full_history' → 餐厅 Agent 能读到天气 Agent 的输出\n");

  const nodePath: string[] = [];
  // 用显式 interface 承载最终状态（避免 typeof 循环推断导致 never）
  interface StepState {
    messages?: Array<{ content?: unknown; usage_metadata?: { total_tokens?: number } }>;
  }
  let finalState: StepState | null = null;

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
      finalState = payload as unknown as StepState;
    }
  }

  console.log("🔀 执行路径:", nodePath.join(" → "));
  console.log("\n🤖 最终回答:\n");
  console.log(lastMessageText(finalState ?? {}));

  // 展示消息历史传递
  const messages = finalState?.messages ?? [];
  console.log("\n" + "-".repeat(72));
  console.log(`📬 消息历史中的 Agent 间传递（共 ${messages.length} 条消息）：`);
  messages.forEach((msg, i) => {
    const content =
      typeof msg.content === "string"
        ? msg.content.slice(0, 60)
        : JSON.stringify(msg.content).slice(0, 60);
    const type = (msg as { _getType?: () => string })._getType?.() ?? "unknown";
    console.log(`  [${i}] ${type}: ${content}...`);
  });

  // Token 成本统计（真实 usage_metadata）
  const totalTokens = sumTokenUsage(
    messages as Array<{ usage_metadata?: { total_tokens?: number } }>
  );
  console.log("\n💰 Token 消耗统计（真实 usage_metadata）：");
  console.log(`  - 全流程累计消耗: ${totalTokens} tokens`);
  console.log(
    `  - LLM 调用次数: ${messages.filter((m) => m.usage_metadata).length} 次（Supervisor 路由 + 各 Agent 推理）`
  );
  console.log(`  - 对比参考: 单 Agent + 2 工具通常只需 2~3 次调用、几千 tokens`);

  printObservations([
    "outputMode='full_history' 让餐厅 Agent 看到天气 Agent 的完整输出 → 这就是状态传递",
    "full_history 的代价是 Token 更高：每次路由决策都要携带完整历史",
    "生产级取舍：依赖链场景用 full_history；独立任务用 last_message 省 Token",
    "上下文去噪：移除交接消息（addHandoffMessages=false）既兼容 DeepSeek，又能提升模型可靠性",
    "多 Agent 不是银弹：如果单 Agent + 工具能完成任务，Token 成本和延迟都更低",
  ]);

  console.log("\n✅ Step 04 完成（状态传递 + 成本意识已掌握）\n");
}

// 仅当本文件被直接运行时才执行 main：避免被 index.ts 批量模式 import 时重复执行
if (isDirectRun("step-04-state-passing.ts")) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
