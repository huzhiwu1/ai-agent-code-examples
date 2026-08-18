/**
 * Step 05 – 动态重规划：执行失败时重新拆解剩余步骤
 *
 * 学习目标：理解"计划不是一次性的"——执行中某步失败时，
 * Agent 要能根据已完成的结果 + 失败原因，重新生成剩余计划。
 *
 * 核心机制（对应真实设计）：
 *   - 失败触发：某步执行失败（网络超时、参数错误、权限不足…）
 *   - 重规划上下文：把「已完成步骤的结果 + 失败步骤的错误 + 剩余步骤」喂给 LLM
 *   - LLM 重新决策：调整失败步骤的执行方式（换工具/改参数）、跳过非关键路径、
 *     或保持已完成结果继续
 *   - 对应源码：LangGraph Plan-and-Execute 教程的 replan 节点；
 *     dsh 中对应 agent-loop 失败后的 replan 策略
 *
 * 与 Step 04 的区别：
 *   - Step 04：失败只能报错，计划不会变
 *   - Step 05：失败触发 replan，计划动态调整——这是"自适应 Agent"的关键能力
 *
 * 跑法：pnpm run:planning --step5 （或 pnpm --filter @articles/agent-planning run start:step5）
 */

import "dotenv/config";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { llm, TASK, PlanSchema, PlanStep, StepState, createStepState, toolMap } from "../shared";

/** 生成初始计划（复用 shared.ts 的 Schema） */
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
      "注意：get_user_info 和 get_orders 无依赖可并行；calculate_discount 依赖前两步；" +
      "generate_report 依赖所有前面的步骤；id 用 step-1, step-2, ... 格式"
  );

  const result = await planLLM.invoke([systemPrompt, new HumanMessage(task)]);
  return (result as unknown as { steps: PlanStep[] }).steps;
}

/** 构造执行上下文（已完成/失败步骤），用于重规划 */
function buildExecutionContext(stateMap: Map<string, StepState>): {
  done: { id: string; description: string; result: string }[];
  failed: { id: string; description: string; error: string }[];
} {
  const done: { id: string; description: string; result: string }[] = [];
  const failed: { id: string; description: string; error: string }[] = [];

  for (const [, s] of stateMap) {
    if (s.status === "done") {
      done.push({ id: s.step.id, description: s.step.description, result: s.result ?? "" });
    } else if (s.status === "failed") {
      failed.push({ id: s.step.id, description: s.step.description, error: s.error ?? "未知错误" });
    }
  }
  return { done, failed };
}

/** 重规划：LLM 根据当前状态重新生成剩余计划 */
async function replan(
  originalTask: string,
  context: {
    done: { id: string; description: string; result: string }[];
    failed: { id: string; description: string; error: string }[];
  },
  remainingSteps: PlanStep[]
): Promise<PlanStep[]> {
  const planLLM = llm.withStructuredOutput(PlanSchema, {
    method: "functionCalling",
    name: "replan",
  });

  const contextStr = [
    "## 已完成步骤",
    ...context.done.map((d) => `  ${d.id} (${d.description}): ${d.result.slice(0, 100)}`),
    "",
    "## 失败步骤",
    ...context.failed.map((f) => `  ${f.id} (${f.description}): ${f.error}`),
    "",
    "## 剩余待执行步骤（需要重新规划）",
    ...remainingSteps.map((s) => `  ${s.id}: ${s.description} [工具: ${s.tool}]`),
  ].join("\n");

  const systemPrompt = new SystemMessage(
    "你是一个重规划助手。原始任务在执行过程中某一步失败了。\n" +
      "你需要根据：1. 已完成步骤的结果 2. 失败步骤的错误信息 3. 剩余待执行的步骤\n" +
      "重新规划剩余步骤。可以：\n" +
      "- 调整失败步骤的执行方式（比如换工具、改参数）\n" +
      "- 如果失败步骤不是关键路径，可以跳过它\n" +
      "- 保持已完成步骤的结果作为上下文\n" +
      "可选工具：get_user_info、get_orders、calculate_discount、generate_report\n" +
      "输出 JSON 格式的新计划（只包含剩余步骤）。"
  );

  const result = await planLLM.invoke([
    systemPrompt,
    new HumanMessage(`原始任务: ${originalTask}\n\n当前执行状态:\n${contextStr}`),
  ]);

  return (result as unknown as { steps: PlanStep[] }).steps;
}

/**
 * 演示主流程：生成计划 → 执行（模拟 get_orders 失败）→ 触发 replan → 执行新计划
 *
 * 为了让重规划可复现，模拟 get_orders 第一次调用失败（现实可能是网络超时/权限不足）。
 */
async function runPlanWithReplan(task: string): Promise<void> {
  console.log(`\n任务：「${task}」\n`);

  // 阶段 1：生成初始计划
  console.log("── 阶段 1: 生成初始计划 ──\n");
  const plan = await generatePlan(task);
  console.log(`计划步骤 (${plan.length} 步):\n`);
  for (const step of plan) {
    console.log(`  ${step.id}: ${step.description} [工具: ${step.tool}]`);
  }

  // 阶段 2：执行（模拟失败）
  console.log("\n── 阶段 2: 执行计划（get_orders 模拟失败）──\n");

  const stateMap = new Map<string, StepState>();
  for (const step of plan) stateMap.set(step.id, createStepState(step));

  let needsReplan = false;

  for (const step of plan) {
    const s = stateMap.get(step.id)!;

    // 依赖检查（简化版：顺序执行，依赖不满足则跳过）
    const depsMet = step.depends_on.every((depId) => {
      const dep = stateMap.get(depId);
      return dep && dep.status === "done";
    });
    if (!depsMet) {
      s.status = "pending";
      continue;
    }

    s.status = "in_progress";
    console.log(`  ▶ ${step.id}: ${step.description}`);

    // 模拟失败：get_orders 第一次调用超时
    if (step.tool === "get_orders") {
      console.log("  ⚠️ 模拟失败：get_orders 调用超时（网络异常）");
      s.status = "failed";
      s.error = "调用超时：get_orders 请求超时，目标服务不可达";
      needsReplan = true;
      console.log(`  ❌ ${step.id} 失败: ${s.error}\n`);
      break;
    }

    try {
      const tool = toolMap.get(step.tool);
      if (!tool) throw new Error(`未知工具: ${step.tool}`);
      const rawResult = await tool.invoke(step.args);
      s.result = rawResult;
      s.status = "done";
      console.log(`  ✅ ${step.id} 完成\n`);
    } catch (err) {
      s.status = "failed";
      s.error = (err as Error).message;
      needsReplan = true;
      console.log(`  ❌ ${step.id} 失败: ${(err as Error).message}\n`);
      break;
    }
  }

  if (!needsReplan) {
    console.log("  （没有失败，无需重规划）");
    return;
  }

  // 阶段 3：触发重规划
  console.log("── 阶段 3: 触发重规划 ──\n");

  const context = buildExecutionContext(stateMap);
  const remainingSteps = plan.filter((step) => {
    const s = stateMap.get(step.id);
    return s && (s.status === "pending" || s.status === "failed");
  });

  console.log(
    `  已完成: ${context.done.length} 步 | 失败: ${context.failed.length} 步 | 待重规划: ${remainingSteps.length} 步\n`
  );

  const newPlanSteps = await replan(task, context, remainingSteps);

  console.log(`  重规划后新计划 (${newPlanSteps.length} 步):\n`);
  for (const step of newPlanSteps) {
    const deps =
      step.depends_on.length > 0 ? ` [依赖: ${step.depends_on.join(", ")}]` : " [无依赖]";
    console.log(`    ${step.id}: ${step.description}${deps}`);
    console.log(`      工具: ${step.tool}, 参数: ${JSON.stringify(step.args)}`);
  }

  // 阶段 4：执行重规划后的计划
  console.log("\n── 阶段 4: 执行重规划后的计划 ──\n");

  for (const step of newPlanSteps) {
    const s = createStepState(step);
    stateMap.set(step.id, s);

    const depsMet = step.depends_on.every((depId) => {
      const dep = stateMap.get(depId);
      return dep && dep.status === "done";
    });
    if (!depsMet) {
      s.status = "pending";
      continue;
    }

    s.status = "in_progress";
    console.log(`  ▶ ${step.id}: ${step.description}`);

    try {
      const tool = toolMap.get(step.tool);
      if (!tool) throw new Error(`未知工具: ${step.tool}`);
      const rawResult = await tool.invoke(step.args);
      s.result = rawResult;
      s.status = "done";
      const preview = rawResult.length > 100 ? rawResult.slice(0, 100) + "..." : rawResult;
      console.log(`  ✅ ${step.id} 完成: ${preview}\n`);
    } catch (err) {
      s.status = "failed";
      s.error = (err as Error).message;
      console.log(`  ❌ ${step.id} 失败: ${(err as Error).message}\n`);
    }
  }

  // 汇总
  console.log("── 最终结果汇总 ──\n");
  const entries = [...stateMap.entries()];
  const done = entries.filter(([, s]) => s.status === "done");
  const failed = entries.filter(([, s]) => s.status === "failed");
  console.log(`总步骤: ${stateMap.size} | 成功: ${done.length} | 失败: ${failed.length}`);
  for (const [, s] of entries) {
    const icon = s.status === "done" ? "✅" : s.status === "failed" ? "❌" : "⏳";
    console.log(`${icon} ${s.step.id} [${s.status}] ${s.step.description}`);
  }
}

export async function main() {
  console.log("=".repeat(72));
  console.log("Step 05: 动态重规划 — 失败时重新拆解剩余步骤");
  console.log("=".repeat(72));

  await runPlanWithReplan(TASK);

  console.log("\n观察点：");
  console.log("  ① get_orders 失败后，重规划是否给出了替代方案（换工具/跳过/改参数）");
  console.log("  ② 已完成步骤的结果是否被保留（不重复查询用户信息）");
  console.log("  ③ 对比 Step 04：失败不再只是报错，而是动态调整计划——自适应 Agent 的核心");
  console.log("\n✅ Step 05 完成，5 步渐进式全部跑通\n");
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
