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
 *   - LangGraph Plan-and-Execute 设计模式（LangChain Blog, 2024/02）—
 *     Planner 生成计划 + Agent 执行单步，两个独立节点
 *   - deepagents 的 createDeepAgent（Planner/Executor 分离）
 *   - 核心思想：用大模型做规划，用小模型/确定性执行器做执行，降本增效
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
import {
  llm,
  TASK,
  PlanSchema,
  PlanStep,
  StepState,
  createStepState,
  toolMap,
  validatePlan,
  aggregateResults,
  resolveArgs,
  isDirectRun,
} from "../shared";

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
    "2. 确定每个步骤要用哪个工具，并填写正确的 args 参数\n" +
    "3. 确定依赖关系（depends_on）：calculate_discount 依赖 get_user_info/get_orders 的结果，\n" +
    "   generate_report 依赖所有前面的步骤\n" +
    "4. 每个步骤的 id 必须是 step-1, step-2, ... 格式\n\n" +
    "## 可用工具及其参数\n" +
    "- get_user_info: { userId: string } — 根据用户名或用户 ID 查询用户信息\n" +
    "- get_orders: { userId: string } — 查询指定用户的订单历史\n" +
    "- calculate_discount: { totalAmount: number, userTier: '普通'|'白银'|'黄金'|'VIP' } — 计算折扣\n" +
    "- generate_report: { sections: string[] } — 生成用户报告\n\n" +
    "## 参数引用语法（重要）\n" +
    "如果某步骤的参数依赖前序步骤的结果，**不要填占位值（如 0、'普通'）**，" +
    "而是用引用语法，执行时会自动替换成真实值：\n" +
    '- "$ref:step-1" → step-1 的完整结果\n' +
    '- "$ref:step-1.level" → step-1 结果里的 level 字段\n' +
    '- "$ref:step-2.amount" → step-2 结果（数组）里每个元素的 amount 组成的数组\n' +
    '- "$sum($ref:step-2.amount)" → 对上面那个数组求和（订单总金额）\n\n' +
    '例如：calculate_discount 的 totalAmount 用 "$sum($ref:step-2.amount)"，' +
    'userTier 用 "$ref:step-1.level"；generate_report 的 sections 可引用各步结果（如 "$ref:step-3"）\n' +
    "不依赖前序结果的参数（如 userId）直接填字面值。\n" +
    "重要：args 必须填写工具所需的全部参数，不要留空。"
);

async function planOnly(task: string): Promise<PlanStep[]> {
  const result = await plannerLLM.invoke([PLANNER_SYSTEM_PROMPT, new HumanMessage(task)]);
  return (result as unknown as { steps: PlanStep[] }).steps;
}

// ──────────────── Executor：只执行单步，不重新规划 ────────────────
// 每次执行一个步骤：给出步骤定义 + 已完成上下文，返回该步结果
// Executor 是确定性执行器，不依赖 LLM，直接调用工具

/**
 * 执行单步：给定步骤定义 + 已完成上下文，调用对应工具返回结果
 *
 * Executor 是确定性执行器，不依赖 LLM：拿到工具名和参数，直接执行。
 * 这里的 console.log 仅用于演示 Executor 收到的上下文信息。
 */
async function executeOneStep(step: PlanStep, stateMap: Map<string, StepState>): Promise<string> {
  const doneContext = [...stateMap.values()]
    .filter((s) => s.status === "done")
    .map((s) => ({ id: s.step.id, description: s.step.description, result: s.result ?? "" }));
  const contextStr = doneContext
    .map((d) => `  ${d.id} (${d.description}): ${d.result.slice(0, 80)}`)
    .join("\n");

  console.log(`  💬 执行器上下文（已完成步骤）:\n${contextStr || "  (无)"}`);

  // 实际执行：查工具映射，调用工具（真实架构中 Executor 就是确定性执行，不依赖 LLM）
  const tool = toolMap.get(step.tool);
  if (!tool) throw new Error(`未知工具: ${step.tool}`);
  // 参数引用解析：$ref:step-1 / $sum($ref:step-2.amount) → 真实值
  const resolvedArgs = resolveArgs(step.args, stateMap);
  return tool.invoke(resolvedArgs);
}

// ──────────────── 编排层：Planner → 循环 Executor → 汇总 ────────────────

async function orchestrate(task: string): Promise<Map<string, StepState>> {
  // 1. Planner 生成计划
  console.log("── 阶段 1: Planner 生成计划 ──\n");
  const steps = await planOnly(task);

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

      try {
        const rawResult = await executeOneStep(step, stateMap);
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

// 仅当本文件被直接运行时才执行 main：避免被 index.ts 批量模式 import 时重复执行
if (isDirectRun("step-04-planner-executor.ts")) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
