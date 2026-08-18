/**
 * Step 04 – 规划器/执行器分离：Planner 只拆计划，Executor 只执行
 *
 * 学习目标：理解"职责分离"——把规划能力和执行能力拆成两个独立角色，
 * 各自只有单一职责，通过计划 JSON 传递。
 *
 * 架构（对应真实设计）：
 *   - Planner Agent：只负责把任务拆成步骤计划（输出 Plan JSON），不执行任何工具
 *   - Executor Agent：只负责执行单步（输入：一个步骤 + 已完成的结果上下文），不重新规划
 *   - 主循环（编排层）：Planner 生成计划 → 循环调度 Executor 执行 → 汇总
 *
 * 对应真实源码：
 *   - deepagents 的 createDeepAgent（Planner/Executor 分离）
 *   - LangGraph Plan-and-Execute 教程的 planner/executor 双节点
 *   - dsh 的 subagent 模式（规划者调度执行者）
 *
 * 与 Step 03 的区别：
 *   - Step 03：一个 LLM 既规划又执行（通过不同 prompt 阶段切换）
 *   - Step 04：两个独立 LLM 实例，prompt 各自锁定单一职责，
 *     模型不会再"执行着执行着自己改了计划"
 *
 * 跑法：pnpm run:planning --step4 （或 pnpm --filter @articles/agent-planning run start:step4）
 */

import "dotenv/config";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { llm, TASK, PlanSchema, PlanStep, StepState, createStepState, toolMap } from "../shared";

// ──────────────── Planner：只规划，不执行 ────────────────
// 独立 LLM 实例，prompt 锁定"只输出计划"，没有任何工具绑定

const plannerLLM = llm.withStructuredOutput(PlanSchema, {
  method: "functionCalling",
  name: "generate_plan",
});

const PLANNER_SYSTEM_PROMPT = new SystemMessage(
  "你是一个任务规划器。你的唯一职责：把用户的多步任务拆成步骤计划。\n" +
    "你【不执行】任何工具，也不回答任务本身，只输出 JSON 计划。\n\n" +
    "规则：\n" +
    "1. 分析任务需要哪些步骤\n" +
    "2. 确定每个步骤要用哪个工具（可选：get_user_info、get_orders、calculate_discount、generate_report）\n" +
    "3. 确定依赖关系（depends_on）：calculate_discount 依赖 get_user_info/get_orders 的结果，\n" +
    "   generate_report 依赖所有前面的步骤\n" +
    "4. 每个步骤的 id 必须是 step-1, step-2, ... 格式"
);

async function planOnly(task: string): Promise<PlanStep[]> {
  const result = await plannerLLM.invoke([PLANNER_SYSTEM_PROMPT, new HumanMessage(task)]);
  return (result as unknown as { steps: PlanStep[] }).steps;
}

// ──────────────── Executor：只执行单步，不重新规划 ────────────────
// 每次执行一个步骤：给出步骤定义 + 已完成上下文，返回该步结果

const EXECUTOR_SYSTEM_PROMPT = new SystemMessage(
  "你是一个任务执行器。你会收到：一个待执行的步骤定义、以及之前已完成步骤的结果。\n" +
    "你的唯一职责：执行这个步骤（调用对应工具），返回结果。\n" +
    "你【不修改计划】、【不跳过步骤】、【不调用计划外的工具】。"
);

async function executeOneStep(
  step: PlanStep,
  doneContext: { id: string; description: string; result: string }[]
): Promise<string> {
  // 先展示执行器如何理解这一步（真实实现中直接调工具；这里保留 LLM 决策层演示）
  const contextStr = doneContext
    .map((d) => `  ${d.id} (${d.description}): ${d.result.slice(0, 80)}`)
    .join("\n");

  const stepDef = JSON.stringify(
    { id: step.id, description: step.description, tool: step.tool, args: step.args },
    null,
    2
  );

  const decision = await llm.invoke([
    EXECUTOR_SYSTEM_PROMPT,
    new HumanMessage(
      `待执行步骤:\n${stepDef}\n\n已完成步骤:\n${contextStr || "  (无)"}\n\n` +
        `请确认你理解要执行的步骤（一句话），然后我将调用工具。`
    ),
  ]);

  const decisionText =
    typeof decision.content === "string" ? decision.content : JSON.stringify(decision.content);
  console.log(`  💬 执行器确认: ${decisionText.slice(0, 100)}`);

  // 实际执行：查工具映射，调用工具（真实架构中这一步由编排层完成）
  const tool = toolMap.get(step.tool);
  if (!tool) throw new Error(`未知工具: ${step.tool}`);
  return tool.invoke(step.args);
}

// ──────────────── 编排层：Planner → 循环 Executor → 汇总 ────────────────

async function orchestrate(task: string): Promise<Map<string, StepState>> {
  // 1. Planner 生成计划
  console.log("── 阶段 1: Planner 生成计划 ──\n");
  const steps = await planOnly(task);
  console.log(`计划步骤 (${steps.length} 步):\n`);
  for (const step of steps) {
    const deps =
      step.depends_on.length > 0 ? ` [依赖: ${step.depends_on.join(", ")}]` : " [无依赖]";
    console.log(`  ${step.id}: ${step.description}${deps}`);
    console.log(`    工具: ${step.tool}, 参数: ${JSON.stringify(step.args)}`);
  }

  // 2. 调度循环：依赖满足的步骤交给 Executor
  console.log("\n── 阶段 2: 编排层调度 Executor 执行 ──\n");

  const stateMap = new Map<string, StepState>();
  for (const step of steps) stateMap.set(step.id, createStepState(step));

  let iteration = 0;
  const maxIterations = 50;

  while (iteration < maxIterations) {
    iteration++;
    const allDone = [...stateMap.values()].every(
      (s) => s.status === "done" || s.status === "failed"
    );
    if (allDone) break;

    // 依赖满足的 ready 步骤
    const readySteps = [...stateMap.values()].filter((s) => {
      if (s.status !== "pending") return false;
      return s.step.depends_on.every((depId) => {
        const dep = stateMap.get(depId);
        return dep && dep.status === "done";
      });
    });

    if (readySteps.length === 0) {
      const blocked = [...stateMap.values()].filter((s) => s.status === "pending");
      for (const s of blocked) {
        s.status = "failed";
        s.error = "依赖步骤未完成或失败，无法执行";
      }
      console.log("  ⚠️ 存在阻塞步骤，标记为失败（依赖未满足）");
      break;
    }

    for (const stepState of readySteps) {
      stepState.status = "in_progress";
      const { step } = stepState;
      console.log(`  ▶ ${step.id}: ${step.description}`);

      const doneContext = [...stateMap.values()]
        .filter((s) => s.status === "done")
        .map((s) => ({ id: s.step.id, description: s.step.description, result: s.result ?? "" }));

      try {
        const rawResult = await executeOneStep(step, doneContext);
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

/** 结果汇总（同 Step 03，首次定义在 step-03，这里内联复用逻辑） */
function aggregateResults(stateMap: Map<string, StepState>): string {
  const entries = [...stateMap.entries()];
  const done = entries.filter(([, s]) => s.status === "done");
  const failed = entries.filter(([, s]) => s.status === "failed");

  const lines: string[] = [];
  lines.push("=== 计划执行结果汇总 ===");
  lines.push(`总步骤: ${stateMap.size} | 成功: ${done.length} | 失败: ${failed.length}`);

  for (const [, s] of entries) {
    const icon = s.status === "done" ? "✅" : s.status === "failed" ? "❌" : "⏳";
    lines.push(`${icon} ${s.step.id} [${s.status}] ${s.step.description}`);
    if (s.result) {
      lines.push(`   结果: ${s.result.length > 150 ? s.result.slice(0, 150) + "..." : s.result}`);
    }
    if (s.error) lines.push(`   错误: ${s.error}`);
  }
  return lines.join("\n");
}

export async function main() {
  console.log("=".repeat(72));
  console.log("Step 04: 规划器/执行器分离 — Planner 只拆计划，Executor 只执行");
  console.log("=".repeat(72));

  console.log(`\n任务：「${TASK}」\n`);

  const stateMap = await orchestrate(TASK);

  console.log("── 阶段 3: 结果汇总 ──\n");
  console.log(aggregateResults(stateMap));

  console.log("\n观察点：");
  console.log("  ① Planner 只输出计划，没有执行任何工具（职责单一）");
  console.log("  ② Executor 每次只处理一个步骤，拿到已完成上下文（不重新规划）");
  console.log("  ③ 对比 Step 03：这里规划逻辑和执行业务彻底分离，可独立替换/升级");
  console.log("  ④ 局限：某步失败后 Executor 只能报错，不会调整计划——Step 05 的重规划解决");
  console.log("\n✅ Step 04 完成\n");
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
