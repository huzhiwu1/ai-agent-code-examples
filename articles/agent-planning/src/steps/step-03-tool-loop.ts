/**
 * Step 03 – 计划 + 工具闭环：依赖调度 + 结果回填 + 多 step 往返
 *
 * 学习目标：理解"执行闭环"——计划不只是顺序跑，还要处理依赖关系、
 * 失败标记、以及"结果影响后续步骤"的往返。
 *
 * 与 Step 02 的区别：
 *   - Step 02 顺序执行：遇到依赖没满足时直接往下跑（可能用错数据）
 *   - Step 03 闭环调度：每轮只执行"pending 且所有依赖已完成"的步骤，
 *     依赖没满足就等待；失败步骤不再重试；有环/阻塞时标记 failed 并停止
 *
 * 核心机制（对应真实设计）：
 *   - 步骤状态机：pending → in_progress → done / failed
 *   - 依赖检查：depends_on 全部 done 才允许执行
 *   - 结果回填：每步结果存 stateMap，后续步骤执行时可引用
 *   - 对应源码：LLMCompiler 的 DAG 依赖调度（Kim et al., 2023）；
 *     ReWOO 的变量引用与步骤间数据传递（Xu et al., 2023）
 *
 * 跑法：pnpm run:planning --step3 （或 pnpm --filter @articles/agent-planning run start:step3）
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
  aggregateResults,
} from "../shared";

/**
 * 闭环执行：依赖调度版
 *
 * 核心逻辑（对应真实 planner 的调度循环）：
 *   1. 全部步骤初始化为 pending
 *   2. 循环：找出"pending 且所有依赖已完成"的步骤 → 执行 → 更新状态
 *   3. 没有可执行步骤但有 pending → 依赖链有环或前置失败 → 标记 blocked
 *   4. 直到全部 done / failed 或阻塞
 */
async function executePlanClosedLoop(steps: PlanStep[]): Promise<Map<string, StepState>> {
  const stateMap = new Map<string, StepState>();
  for (const step of steps) {
    stateMap.set(step.id, createStepState(step));
  }

  console.log("\n── 执行计划（依赖调度闭环）──\n");

  let iteration = 0;
  const maxIterations = 50;

  while (iteration < maxIterations) {
    iteration++;

    // 是否全部结束
    const allDone = [...stateMap.values()].every(
      (s) => s.status === "done" || s.status === "failed"
    );
    if (allDone) break;

    // 找出当前可执行的步骤：pending 且所有依赖已完成
    const readySteps = [...stateMap.values()].filter((s) => {
      if (s.status !== "pending") return false;
      return s.step.depends_on.every((depId) => {
        const dep = stateMap.get(depId);
        return dep && dep.status === "done";
      });
    });

    if (readySteps.length === 0) {
      // 有 pending 但依赖不满足 → 环或前置失败
      const blocked = [...stateMap.values()].filter((s) => s.status === "pending");
      for (const s of blocked) {
        s.status = "failed";
        s.error = "依赖步骤未完成或失败，无法执行";
      }
      console.log("  ⚠️ 存在阻塞步骤，标记为失败（依赖未满足）");
      break;
    }

    // 执行就绪步骤
    for (const stepState of readySteps) {
      stepState.status = "in_progress";
      const { step } = stepState;
      console.log(`  ▶ ${step.id}: ${step.description}`);
      console.log(`    工具: ${step.tool}, 参数: ${JSON.stringify(step.args)}`);

      try {
        const tool = toolMap.get(step.tool);
        if (!tool) throw new Error(`未知工具: ${step.tool}`);

        const rawResult = await tool.invoke(step.args);
        stepState.result = rawResult;
        stepState.status = "done";

        const preview = rawResult.length > 100 ? rawResult.slice(0, 100) + "..." : rawResult;
        console.log(`  ← 结果: ${preview}`);
        console.log(`  ✅ ${step.id} 完成\n`);
      } catch (err) {
        stepState.status = "failed";
        stepState.error = (err as Error).message;
        console.log(`  ❌ ${step.id} 失败: ${(err as Error).message}\n`);
      }
    }
  }

  return stateMap;
}

export async function main() {
  console.log("=".repeat(72));
  console.log("Step 03: 计划 + 工具闭环 — 依赖调度 + 结果回填");
  console.log("=".repeat(72));

  console.log(`\n任务：「${TASK}」\n`);

  // 阶段 1：生成计划
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

  // 阶段 2：闭环执行（依赖调度）
  const stateMap = await executePlanClosedLoop(steps);

  // 阶段 3：汇总
  console.log("── 阶段 3: 结果汇总 ──\n");
  console.log(aggregateResults(stateMap));

  console.log("\n观察点：");
  console.log(
    "  ① 依赖调度生效了吗？（calculate_discount 是否等 get_user_info/get_orders 完成后才跑）"
  );
  console.log("  ② 结果回填了吗？（generate_report 是否能拿到前面步骤的数据）");
  console.log("  ③ 局限：失败后不会自动调整计划，Step 05 的重规划解决");
  console.log("\n✅ Step 03 完成\n");
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
