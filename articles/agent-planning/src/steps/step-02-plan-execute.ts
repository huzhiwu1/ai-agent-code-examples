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
 *   - Plan-and-Solve 论文（Wang et al., 2023）的"先规划、后执行"概念
 *   - 神光课程的 todoListMiddleware（write_todos 先列步骤再执行）
 *   - BabyAGI 项目的任务分解思想
 *
 * 跑法：pnpm run:planning --step2 （或 pnpm --filter @articles/agent-planning run start:step2）
 */

import "dotenv/config";
import {
  TASK,
  PlanStep,
  StepState,
  createStepState,
  toolMap,
  generatePlan,
  validatePlan,
  resolveArgs,
  isDirectRun,
} from "../shared";

/** 顺序执行计划：按 steps 数组顺序逐条执行（Step 02 简化版，不做依赖调度） */
async function executePlanSequential(steps: PlanStep[]): Promise<void> {
  console.log("\n── 执行计划（顺序执行）──\n");

  // 记录每步执行结果，供后续步骤的参数引用解析（$ref）
  const stateMap = new Map<string, StepState>();

  for (const step of steps) {
    console.log(`  ▶ ${step.id}: ${step.description}`);
    console.log(`    工具: ${step.tool}, 参数: ${JSON.stringify(step.args)}`);

    // 提示：顺序执行不检查依赖，如有依赖未满足仍会继续执行
    if (step.depends_on.length > 0) {
      console.log(
        `    ⚠️ 声明依赖: ${step.depends_on.join(", ")}（本步顺序执行不做等待，Step 03 解决）`
      );
    }

    try {
      const tool = toolMap.get(step.tool);
      if (!tool) {
        throw new Error(`未知工具: ${step.tool}`);
      }
      // 参数引用解析：把 $ref:step-1 / $sum($ref:step-2.amount) 替换成真实值
      const resolvedArgs = resolveArgs(step.args, stateMap);
      const rawResult = await tool.invoke(resolvedArgs);
      const preview = rawResult.length > 100 ? rawResult.slice(0, 100) + "..." : rawResult;
      console.log(`  ← 结果: ${preview}`);
      console.log(`  ✅ ${step.id} 完成\n`);

      // 保存本步结果，供后续步骤引用
      const doneState = createStepState(step);
      doneState.status = "done";
      doneState.result = rawResult;
      stateMap.set(step.id, doneState);
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

  // 验证计划
  const validation = validatePlan(steps);
  if (!validation.valid) {
    console.log("⚠️ 计划验证发现问题:");
    for (const err of validation.errors) console.log(`   - ${err}`);
  }

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

// 仅当本文件被直接运行时才执行 main：避免被 index.ts 批量模式 import 时重复执行
if (isDirectRun("step-02-plan-execute.ts")) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
