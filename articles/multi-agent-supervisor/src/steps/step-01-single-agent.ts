/**
 * Step 01 – 单 Agent 痛点：一个 Agent 管所有事
 *
 * 学习目标：先看「万能 Agent」的困境——工具膨胀、prompt 过长、决策混乱，
 * 为后续多 Agent 分工提供动机。
 *
 * 做法：把所有工具（天气、趣闻、餐厅、旅行贴士）都塞给一个 Agent，
 * 让它处理复杂的旅行规划请求。
 *
 * 预期观察点：
 *   1. 工具选择是否准确？（该查天气时会不会去查餐厅？）
 *   2. 回答是否完整覆盖了所有需求？
 *   3. 随着工具增多，System Prompt 越来越长——这是单 Agent 的硬伤
 *   4. 多个工具调用之间是否有逻辑错乱？
 *
 * 对应真实设计：
 *   这是所有多 Agent 架构的「零号基线」。LangChain《Benchmarking Multi-Agent
 *   Architectures》（Tau-bench）实测：单 Agent 的性能随工具/上下文数量增加急剧
 *   下降，即使新增上下文与任务完全无关（distractor）也会被带偏。
 *   这个 Step 让你亲身体验这个问题。
 *
 * 跑法：pnpm run:multi-agent-supervisor:step1
 */

import { HumanMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import {
  API_KEY,
  llm,
  allTools,
  isDirectRun,
  lastMessageText,
  printSeparator,
  printObservations,
} from "../shared";

export async function main() {
  printSeparator("Step 01: 单 Agent 痛点 — 把所有工具塞给一个 Agent");

  if (!API_KEY) {
    console.log("⚠️  跳过（未配置 LLM_API_KEY）");
    return;
  }

  // createAgent 参数：
  //   name：Agent 在日志/图里的名字
  //   model：驱动它的 LLM
  //   tools：它可用的工具列表（这里把全部 4 个工具都给它 → 工具选择容易出错）
  //   systemPrompt：角色设定，领域越多越长 → 这是单 Agent 的硬伤
  const megaAgent = createAgent({
    name: "mega_agent",
    model: llm,
    tools: allTools,
    systemPrompt: `你是一个万能旅行助手，可以处理以下所有类型的请求：
- 天气查询：使用 lookup_weather 工具
- 城市知识/景点介绍：使用 lookup_city_trivia 工具
- 餐厅推荐：使用 lookup_restaurants 工具
- 旅行贴士：使用 lookup_travel_tips 工具

注意：用户可能同时问多个问题，你需要逐一调用对应工具，确保所有需求都被满足。`,
  });

  const query = "帮我规划一趟杭州三日游，需要了解天气、景点知识、美食推荐和旅行贴士";

  console.log(`\n📝 用户请求：「${query}」\n`);
  console.log(
    `🔧 该 Agent 拥有 ${allTools.length} 个工具：${allTools.map((t) => t.name).join(", ")}`
  );
  console.log(
    `📏 System Prompt 长度："mega_agent" 的提示词覆盖了天气、知识、餐厅、贴士 4 个领域\n`
  );

  // graph.invoke：运行 Agent 编译后的图（内部是 LangGraph 状态机），
  //   传入消息数组，返回最终状态（含完整消息历史）
  const result = await megaAgent.graph.invoke({
    messages: [new HumanMessage(query)],
  });

  console.log("🤖 Agent 回答：\n");
  // lastMessageText：从状态里取出最后一条 AI 消息的文本内容
  console.log(lastMessageText(result));
  console.log("-".repeat(72));

  printObservations([
    "Agent 是否调用了全部 4 个工具？还是漏掉了某些？",
    "工具调用顺序是否合理？（比如先查天气再推荐餐厅是合理的）",
    "如果再加 3 个工具（机票、酒店、攻略），System Prompt 会多长？Agent 还能准确选择吗？",
    "这就是多 Agent 分工的动机：让每个 Agent 只专注一个领域，各司其职。",
  ]);

  console.log("\n✅ Step 01 完成（痛点基线已建立）\n");
}

// 仅当本文件被直接运行时才执行 main：避免被 index.ts 批量模式 import 时重复执行
if (isDirectRun("step-01-single-agent.ts")) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
