/**
 * Step 03 – Supervisor 自动路由：声明式多 Agent 调度（含循环问题实测）
 *
 * 学习目标：
 *   1. 理解 createSupervisor 的自动路由机制（调度员 LLM 选人，子 Agent 干活）
 *   2. 亲眼看到它的循环缺陷，理解根因 —— 为 Step 05 的确定性路由做铺垫
 *
 * ⚠️ 实测结论（本仓库多次运行 DeepSeek 验证）：
 *   createSupervisor 的循环问题是"概率性的"，没有软配置能根治：
 *   - outputMode: "full_history" 提供工具调用证据 → 降低循环概率，但不保证
 *   - Prompt 顺序式措辞（"先调 X 再调 Y"）→ 降低概率，但不保证
 *   - 模型随机性极大：同样的配置，这次循环 9 次，下次 1 次就过
 *
 *   循环根因：Supervisor 每轮都从用户原始消息重新推导计划，
 *   历史里的子 Agent 回答不足以让它确认"该任务已完成"，
 *   于是反复重新调度同一个 Agent，直到耗尽 recursion limit 或模型放弃。
 *
 *   生产级结论：
 *   - createSupervisor 适合快速原型验证
 *   - 生产防循环必须上"硬约束"：Step 05 的 visitedAgents（确定性任务分配）
 *     或 Step 07 的预算/轮数熔断
 *
 * DeepSeek 兼容配置：
 *   addHandoffMessages: false —— 绕开 DeepSeek 的 tool_calls 严格配对校验
 *   （模型并行发多个 handoff 调用时，多个 Command 只有一个生效，
 *     历史里会出现未配对的 tool_calls → 400 invalid_tool_results）
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
  isDirectRun,
  lastMessageText,
  printSeparator,
  printObservations,
} from "../shared";

/** 复合查询演示的最大调度轮数（防止循环演示烧太多 token） */
const DEMO_RECURSION_LIMIT = 14;

export async function main() {
  printSeparator("Step 03: Supervisor 自动路由 — 声明式调度（含循环问题实测）");

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

  const workflow = createSupervisor({
    agents: [weatherAgent.graph, triviaAgent.graph],
    llm,
    supervisorName: "supervisor",
    includeAgentName: "inline",
    // DeepSeek 兼容：避免 tool_calls 配对校验失败（invalid_tool_results 400）
    addHandoffMessages: false,
    // 减少噪声：子 Agent 完成后不插入「交接回 Supervisor」的标记消息
    addHandoffBackMessages: false,
    prompt: `你是调度员（Supervisor），只负责选人，绝对不要自己报气温或讲城市百科。

你的子 Agent 及其职责：
- weather_agent：查天气、气温、下雨、空气质量
- trivia_agent：讲城市小知识、景点、历史、文化

规则：
1. 分析用户请求，每次只调用一个 Agent
2. 如果用户问天气 → 调 weather_agent
3. 如果用户问知识 → 调 trivia_agent
4. 如果用户同时问天气+知识 → 先调 weather_agent，再调 trivia_agent
5. 绝对不要重复调用同一个 Agent，每个 Agent 最多调用一次
6. 绝对不要自己编造数据，必须交给子 Agent 处理`,
  });

  const app = workflow.compile();

  // 打印图结构
  console.log("\n📊 Supervisor 图结构（Mermaid）：");
  const graph = await app.getGraphAsync();
  console.log(graph.drawMermaid({ withStyles: true }));

  // ── 演示 1：复合查询 —— 亲眼看看循环问题 ──
  // 说明：recursion_limit 设为 14（约 7 轮调度），防止循环演示烧太多 token
  const query = "查一下杭州的天气，再讲一条和杭州有关的小知识。";
  console.log(`\n📝 复合查询：「${query}」`);
  console.log(`⚠️  注意观察执行路径：Supervisor 可能反复调用同一个 Agent（循环）\n`);

  const nodePath: string[] = [];
  let finalState: { messages?: Array<{ content?: unknown }> } | null = null;
  let loopError: Error | null = null;

  try {
    const stream = await app.stream(
      { messages: [new HumanMessage(query)] },
      { streamMode: ["updates", "values"], recursionLimit: DEMO_RECURSION_LIMIT }
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
  } catch (err) {
    // 循环撞到 recursion limit 时会抛 GraphRecursionError —— 这也是循环的现场证据
    loopError = err as Error;
  }

  const weatherCount = nodePath.filter((n) => n === "weather_agent").length;
  const triviaCount = nodePath.filter((n) => n === "trivia_agent").length;

  console.log("🔀 执行路径:", nodePath.join(" → "));
  console.log(`📊 调度统计: weather_agent × ${weatherCount} | trivia_agent × ${triviaCount}`);
  if (loopError) {
    console.log(
      `❌ 循环触达 recursion limit（${DEMO_RECURSION_LIMIT} 步）被强制终止：${loopError.message.split(".")[0]}。`
    );
    console.log("   这就是生产事故现场：同一 Agent 被反复调度，直到安全网兜底。");
  } else if (weatherCount > 1) {
    console.log("❌ 循环发生了：同一个 Agent 被反复调度（生产事故现场）");
  } else {
    console.log("✅ 这次没有循环（模型随机性大，多跑几次就可能循环）");
  }

  console.log("\n🤖 最终回答:\n");
  console.log(lastMessageText(finalState ?? {}));

  console.log("-".repeat(72));
  printObservations([
    "createSupervisor 能自动处理复合查询，但循环是概率性问题：软配置（full_history / prompt 措辞）只能降低概率，不能根治",
    "循环根因：Supervisor 每轮都重新从用户消息推导计划，历史中的子 Agent 回答不足以确认任务已完成",
    "production 结论：createSupervisor 适合原型验证；生产防循环必须上硬约束",
    "硬约束方案：Step 05 的 visitedAgents（确定性任务分配，代码层拒绝重复调度）",
    "兜底方案：Step 07 的预算/轮数熔断 + recursion_limit（防止循环烧钱）",
    "DeepSeek 兼容：addHandoffMessages=false 绕开 tool_calls 配对校验（否则 400 invalid_tool_results）",
  ]);

  console.log("\n✅ Step 03 完成（理解了 Supervisor 的能力与边界）\n");
}

// 仅当本文件被直接运行时才执行 main：避免被 index.ts 批量模式 import 时重复执行
if (isDirectRun("step-03-supervisor.ts")) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
