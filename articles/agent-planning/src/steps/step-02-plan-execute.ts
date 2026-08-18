/**
 * Step 02 – 先列计划再执行：Plan-then-Execute 雏形
 *
 * 学习目标：理解"规划先行"如何解决 Step 01 的痛点。
 *
 * 做法（两步走）：
 *   1. 第一次调用 LLM：只输出步骤列表（JSON，带依赖关系），不执行
 *   2. 第二次起：按计划逐条执行，每步调对应工具，结果回填后走下一步
 *
 * 与 Step 03 的区别：
 *   - Step 02 是"顺序执行"：按 steps 数组顺序一条条跑（简单直观）
 *   - Step 03 是"闭环"：支持并行依赖、失败标记、多 step 往返
 *
 * 对应真实设计：
 *   - 神光课程的 todoListMiddleware（write_todos 先列步骤再执行）
 *   - LangGraph 官方 Plan-and-Execute 教程的雏形
 *   - dsh 的 planner 相关插件（先 plan 后 act）
 *
 * 跑法：pnpm run:planning --step2 （或 pnpm --filter @articles/agent-planning run start:step2）
 */

import "dotenv/config";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { llm, TASK, PlanSchema, PlanStep, toolMap } from "../shared";

/** 生成计划：LLM structured output 输出 JSON 计划（只规划，不执行） */
async function generatePlan(task: string): Promise<PlanStep[]> {
  const planLLM = llm.withStructuredOutput(PlanSchema, {
    method: "functionCalling",
    name: "generate_plan",
  });

  const systemPrompt = new SystemMessage(
    "你是一个任务规划助手。用户会给你一个多步任务，你需要：\n" +
      "1. 分析任务需要哪些步骤\n" +
      "2. 确定每个步骤要用哪个工具（可选工具：get_user_info、get_orders、calculate_discount、generate_report）\n" +
      "3. 确定步骤间的依赖关系（depends_on）\n" +
      "4. 输出 JSON 格式的计划\n\n" +
      "注意：\n" +
      "- get_user_info 和 get_orders 没有依赖关系，可以并行执行\n" +
      "- calculate_discount 依赖前两步的结果\n" +
      "- generate_report 依赖所有前面的步骤\n" +
      "- 每个步骤的 id 必须是 step-1, step-2, ... 格式"
  );

  const result = await planLLM.invoke([systemPrompt, new HumanMessage(task)]);

  return (result as unknown as { steps: PlanStep[] }).steps;
}

/** 顺序执行计划：按 steps 数组顺序逐条执行（Step 02 简化版，不做依赖调度） */
async function executePlanSequential(steps: PlanStep[]): Promise<void> {
  console.log("\n── 执行计划（顺序执行）──\n");

  for (const step of steps) {
    console.log(`  ▶ ${step.id}: ${step.description}`);
    console.log(`    工具: ${step.tool}, 参数: ${JSON.stringify(step.args)}`);

    try {
      const tool = toolMap.get(step.tool);
      if (!tool) {
        throw new Error(`未知工具: ${step.tool}`);
      }
      const rawResult = await tool.invoke(step.args);
      const preview = rawResult.length > 100 ? rawResult.slice(0, 100) + "..." : rawResult;
      console.log(`  ← 结果: ${preview}`);
      console.log(`  ✅ ${step.id} 完成\n`);
    } catch (err) {
      console.log(`  ❌ ${step.id} 失败: ${(err as Error).message}\n`);
    }
  }
}

export async function main() {
  console.log("=".repeat(72));
  console.log("Step 02: 先列计划再执行 — Plan-then-Execute 雏形");
  console.log("=".repeat(72));

  console.log(`\n任务：「${TASK}」\n`);

  // 阶段 1：生成计划（只规划，不执行）
  console.log("── 阶段 1: 计划生成 ──\n");
  const steps = await generatePlan(TASK);
  console.log(`计划步骤 (${steps.length} 步):\n`);
  for (const step of steps) {
    const deps =
      step.depends_on.length > 0 ? ` [依赖: ${step.depends_on.join(", ")}]` : " [无依赖]";
    console.log(`  ${step.id}: ${step.description}${deps}`);
    console.log(`    工具: ${step.tool}, 参数: ${JSON.stringify(step.args)}`);
  }

  // 阶段 2：顺序执行
  await executePlanSequential(steps);

  console.log("观察点：");
  console.log("  ① 规划先行解决了'漏步骤'吗？（计划里四件事是否齐全）");
  console.log("  ② 依赖对吗？（calculate_discount 是否排在 get_user_info/get_orders 之后）");
  console.log("  ③ 局限：顺序执行遇到依赖没满足时不会等待/跳过，Step 03 解决");
  console.log("\n✅ Step 02 完成\n");
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
