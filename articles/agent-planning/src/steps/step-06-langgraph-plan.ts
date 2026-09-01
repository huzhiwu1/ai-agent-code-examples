/**
 * Step 06 – LangGraph Plan-and-Execute：用 StateGraph 替代手动编排循环
 *
 * 学习目标：理解"为什么用 LangGraph"——把手动 while 循环、状态管理、
 * 路由判断全部交给图引擎，每个节点变成纯函数。
 *
 * 与 Step 03/04/05 的对比：
 *   - Step 03-05：手动 while 循环 + 手动 Map 状态管理 + 手动路由
 *   - Step 06：StateGraph 定义状态 → 节点只管"当前状态 → 局部更新" →
 *     条件边自动路由 → 图引擎自动处理循环
 *
 * LangGraph 核心概念（本步体现）：
 *   1. Annotation.Root：定义图状态的结构和 reducer
 *   2. 节点是纯函数：(state) → partial state update
 *   3. 条件边：根据当前状态决定下一步走哪个节点
 *   4. 图引擎自动管理状态传递和循环终止
 *
 * 对应真实设计：
 *   - 基于 LLMCompiler 思想的 LangGraph 自定义实现 —
 *     依赖感知的批量调度（executor ⇄ executor 循环）+ 失败重规划
 *   - 官方教程的 StateGraph 三节点模式（planner → agent → replan）
 *     本步在此基础上做了扩展：批量执行就绪步骤 + 依赖调度
 *   - deepagents 的 createDeepAgent 内部也是 StateGraph
 *
 * 跑法：pnpm run:planning:step6
 */

import "dotenv/config";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import {
  TASK,
  PlanStep,
  StepState,
  createStepState,
  toolMap,
  generatePlan,
  validatePlan,
  aggregateResults,
  resolveArgs,
  isDirectRun,
} from "../shared";

// ════════════════════════════════════════════════════════════════
// 1. 定义图状态：这是 LangGraph 的核心——状态是"整个图的唯一真相来源"
// ════════════════════════════════════════════════════════════════

/**
 * 图状态 Schema
 *
 * 每个字段都有默认值（invoke 时只需传 task），
 * 状态在节点间自动传递，节点只返回自己更新的字段。
 */
const PlanningState = Annotation.Root({
  /** 用户任务 */
  task: Annotation<string>(),
  /** LLM 生成的步骤计划 */
  plan: Annotation<PlanStep[]>(),
  /** 步骤 ID → 步骤状态（pending/in_progress/done/failed） */
  stepStates: Annotation<Record<string, StepState>>(),
  /** 是否需要重规划 */
  needsReplan: Annotation<boolean>(),
  /** 重规划次数（防止无限循环） */
  replanCount: Annotation<number>(),
});

// ════════════════════════════════════════════════════════════════
// 2. 定义节点：每个节点是纯函数 (state) → partial state
// ════════════════════════════════════════════════════════════════

/**
 * Planner 节点：调用 LLM 生成 JSON 计划，初始化步骤状态
 *
 * 职责单一：只生成计划，不执行任何工具。
 * 对比 Step 04 的 Planner 角色，这里用 LangGraph 节点实现。
 */
async function plannerNode(state: typeof PlanningState.State) {
  console.log("── Planner 节点: 生成计划 ──\n");

  const plan = await generatePlan(state.task);

  const validation = validatePlan(plan);
  if (!validation.valid) {
    console.log("⚠️ 计划验证发现问题:");
    for (const err of validation.errors) console.log(`   - ${err}`);
  }

  console.log(`计划步骤 (${plan.length} 步):\n`);
  for (const step of plan) {
    const deps =
      step.depends_on.length > 0 ? ` [依赖: ${step.depends_on.join(", ")}]` : " [无依赖]";
    console.log(`  ${step.id}: ${step.description}${deps}`);
    console.log(`    工具: ${step.tool}, 参数: ${JSON.stringify(step.args)}`);
  }

  // 初始化所有步骤为 pending
  const stepStates: Record<string, StepState> = {};
  for (const step of plan) {
    stepStates[step.id] = createStepState(step);
  }

  return { plan, stepStates, needsReplan: false, replanCount: 0 };
}

/**
 * Executor 节点：找出所有依赖已满足的步骤，批量执行
 *
 * 每次调用 Executor 执行一轮"就绪步骤"，执行完后返回更新后的状态。
 * 图引擎通过条件边判断是否需要再次进入 Executor。
 */
async function executorNode(state: typeof PlanningState.State) {
  // 浅拷贝：节点应该返回新对象，不修改入参
  const stepStates = { ...state.stepStates };
  let hasFailed = false;

  // 找出就绪步骤：pending + 所有依赖已完成
  const readySteps = Object.values(stepStates).filter((s) => {
    if (s.status !== "pending") return false;
    return s.step.depends_on.every((depId) => {
      const dep = stepStates[depId];
      return dep && dep.status === "done";
    });
  });

  if (readySteps.length === 0) {
    console.log("  （本轮回合无就绪步骤，等待图引擎路由）");
    return { stepStates };
  }

  console.log(`\n── Executor 节点: 执行 ${readySteps.length} 个就绪步骤 ──\n`);

  for (const stepState of readySteps) {
    stepState.status = "in_progress";
    const { step } = stepState;
    console.log(`  ▶ ${step.id}: ${step.description}`);
    console.log(`    工具: ${step.tool}, 参数: ${JSON.stringify(step.args)}`);

    try {
      const tool = toolMap.get(step.tool);
      if (!tool) throw new Error(`未知工具: ${step.tool}`);
      // 参数引用解析：$ref:step-1 / $sum($ref:step-2.amount) → 真实值
      const resolvedArgs = resolveArgs(step.args, stepStates);
      const rawResult = await tool.invoke(resolvedArgs);
      stepState.result = rawResult;
      stepState.status = "done";
      const preview = rawResult.length > 100 ? rawResult.slice(0, 100) + "..." : rawResult;
      console.log(`  ← 结果: ${preview}`);
      console.log(`  ✅ ${step.id} 完成\n`);
    } catch (err) {
      stepState.status = "failed";
      stepState.error = (err as Error).message;
      hasFailed = true;
      console.log(`  ❌ ${step.id} 失败: ${(err as Error).message}\n`);
    }
  }

  return { stepStates, needsReplan: hasFailed };
}

/**
 * Replan 节点：某步失败后，LLM 重新生成剩余步骤的计划
 *
 * 与 Step 05 的 replan 逻辑相同，但以 LangGraph 节点形式实现。
 * 节点返回新状态后，图引擎自动路由回 Executor 继续执行。
 */
async function replanNode(state: typeof PlanningState.State) {
  console.log("── Replan 节点: 重规划剩余步骤 ──\n");

  const stepStates = { ...state.stepStates };
  const replanCount = (state.replanCount ?? 0) + 1;

  // 防御：防止无限重规划
  if (replanCount > 3) {
    console.log("  ⚠️ 已达到最大重规划次数 (3)，标记剩余步骤为失败");
    for (const s of Object.values(stepStates)) {
      if (s.status === "pending") {
        s.status = "failed";
        s.error = "超过最大重规划次数";
      }
    }
    return { stepStates, needsReplan: false, replanCount };
  }

  // 构造上下文：已完成 + 失败 + 待执行
  const done = Object.values(stepStates)
    .filter((s) => s.status === "done")
    .map((s) => ({ id: s.step.id, description: s.step.description, result: s.result ?? "" }));
  const failed = Object.values(stepStates)
    .filter((s) => s.status === "failed")
    .map((s) => ({
      id: s.step.id,
      description: s.step.description,
      error: s.error ?? "未知错误",
    }));
  const remaining = Object.values(stepStates)
    .filter((s) => s.status === "pending" || s.status === "failed")
    .map((s) => s.step);

  console.log(`  已完成: ${done.length} | 失败: ${failed.length} | 待重规划: ${remaining.length}`);

  // 调用 LLM 重规划（复用 shared.ts 的 PlanSchema）
  const { HumanMessage, SystemMessage } = await import("@langchain/core/messages");
  const { llm, PlanSchema } = await import("../shared");

  const planLLM = llm.withStructuredOutput(PlanSchema, {
    method: "functionCalling",
    name: "replan",
  });

  const contextStr = [
    "## 已完成步骤",
    ...done.map((d) => `  ${d.id}: ${d.result.slice(0, 100)}`),
    "",
    "## 失败步骤",
    ...failed.map((f) => `  ${f.id}: ${f.error}`),
    "",
    "## 待重规划步骤",
    ...remaining.map((s) => `  ${s.id}: ${s.description} [工具: ${s.tool}]`),
  ].join("\n");

  const result = await planLLM.invoke([
    new SystemMessage(
      "你是重规划助手。原始任务某一步执行失败，你需要根据已完成步骤和失败信息，重新规划剩余步骤。\n" +
        "可以调整失败步骤的执行方式（换工具、改参数），或跳过非关键步骤。\n\n" +
        "## 可用工具及其参数\n" +
        "- get_user_info: { userId: string } — 根据用户名或用户 ID 查询用户信息\n" +
        "- get_orders: { userId: string } — 查询指定用户的订单历史\n" +
        "- calculate_discount: { totalAmount: number, userTier: '普通'|'白银'|'黄金'|'VIP' } — 计算折扣\n" +
        "- generate_report: { sections: string[] } — 生成用户报告\n\n" +
        "重要：args 必须填写工具所需的全部参数，不要留空。\n" +
        "输出 JSON 格式的新计划（只包含剩余步骤）。"
    ),
    new HumanMessage(`原始任务: ${state.task}\n\n当前执行状态:\n${contextStr}`),
  ]);

  const newSteps = (result as unknown as { steps: PlanStep[] }).steps;

  console.log(`  重规划后新计划 (${newSteps.length} 步):\n`);
  for (const step of newSteps) {
    const deps =
      step.depends_on.length > 0 ? ` [依赖: ${step.depends_on.join(", ")}]` : " [无依赖]";
    console.log(`    ${step.id}: ${step.description}${deps}`);
  }

  // 替换：清除旧的 pending/failed 步骤，加入新计划步骤
  for (const id of Object.keys(stepStates)) {
    if (stepStates[id].status === "pending" || stepStates[id].status === "failed") {
      delete stepStates[id];
    }
  }
  for (const step of newSteps) {
    stepStates[step.id] = createStepState(step);
  }

  return { stepStates, needsReplan: false, replanCount };
}

// ════════════════════════════════════════════════════════════════
// 3. 条件边：根据当前状态决定下一步——这是 LangGraph 替代手动循环的关键
// ════════════════════════════════════════════════════════════════

/**
 * Executor 之后的路由逻辑
 *
 * LangGraph 在每次 Executor 执行完后调用此函数，
 * 根据最新状态决定：继续执行 / 重规划 / 结束。
 * 这替代了 Step 03-05 中的手动 while 循环和 if/else 分支。
 */
function routeAfterExecutor(state: typeof PlanningState.State): string {
  const stepStates = state.stepStates;

  // 条件 1：全部完成（done 或 failed）→ 结束
  const allDone = Object.values(stepStates).every(
    (s) => s.status === "done" || s.status === "failed"
  );
  if (allDone) return END;

  // 条件 2：有步骤失败且未重规划 → 进入 replan 节点
  if (state.needsReplan) return "replan";

  // 条件 3：有就绪的待执行步骤 → 继续 executor
  const hasReady = Object.values(stepStates).some((s) => {
    if (s.status !== "pending") return false;
    return s.step.depends_on.every((depId) => {
      const dep = stepStates[depId];
      return dep && dep.status === "done";
    });
  });
  if (hasReady) return "executor";

  // 条件 4：有 pending 但依赖不满足 → 阻塞，结束
  console.log("  ⚠️ 存在阻塞步骤（依赖未满足），图引擎终止");
  return END;
}

// ════════════════════════════════════════════════════════════════
// 4. 构建图：声明节点 + 边，图引擎自动处理循环
// ════════════════════════════════════════════════════════════════

/**
 * 构建 Plan-and-Execute 图
 *
 * 图结构：
 *   START → planner → executor ←→ executor（条件边：有就绪步骤就继续）
 *                        ↓
 *                      replan（条件边：有失败就重规划）
 *                        ↓
 *                      executor（重规划后继续执行）
 *                        ↓
 *                       END（条件边：全部完成）
 *
 * 关键：executor → executor 的条件边就是"循环"——不需要写 while。
 */
function buildGraph() {
  return (
    new StateGraph(PlanningState)
      .addNode("planner", plannerNode)
      .addNode("executor", executorNode)
      .addNode("replan", replanNode)

      // 入口：从 planner 开始
      .addEdge(START, "planner")

      // planner → executor：生成计划后开始执行
      .addEdge("planner", "executor")

      // executor 的条件路由：继续 / 重规划 / 结束
      .addConditionalEdges("executor", routeAfterExecutor, {
        executor: "executor",
        replan: "replan",
        [END]: END,
      })

      // replan → executor：重规划完成后继续执行
      .addEdge("replan", "executor")

      .compile()
  );
}

// ════════════════════════════════════════════════════════════════
// 5. 主入口
// ════════════════════════════════════════════════════════════════

export async function main() {
  console.log("=".repeat(72));
  console.log("Step 06: LangGraph Plan-and-Execute — StateGraph 替代手动循环");
  console.log("=".repeat(72));

  console.log(`\n任务：「${TASK}」\n`);
  console.log("图结构: planner → executor ⇄ executor → replan → executor → END\n");

  const graph = buildGraph();

  // 只需传入 task，其余字段使用默认值
  const result = await graph.invoke({
    task: TASK,
    plan: [],
    stepStates: {},
    needsReplan: false,
    replanCount: 0,
  });

  // 汇总
  console.log("\n── 最终结果汇总 ──\n");
  console.log(aggregateResults(new Map(Object.entries(result.stepStates))));

  console.log("\n观察点：");
  console.log(
    "  ① 对比 Step 03：手动 while 循环 → 图引擎自动处理循环（executor → executor 条件边）"
  );
  console.log("  ② 对比 Step 03：手动 Map 状态管理 → LangGraph Annotation 自动管理状态传递");
  console.log("  ③ 对比 Step 04：两个独立 LLM 实例 → 两个独立节点，职责更清晰");
  console.log(
    "  ④ 对比 Step 05：手动 replan 触发 → 条件边 routeAfterExecutor 自动路由到 replan 节点"
  );
  console.log("  ⑤ 节点是纯函数 (state) → partial state，无副作用，可独立测试");
  console.log(
    "  ⑥ 图结构可可视化：START → planner → executor ⇄ executor → replan → executor → END"
  );
  console.log("\n✅ Step 06 完成\n");
}

// 仅当本文件被直接运行时才执行 main：避免被 index.ts 批量模式 import 时重复执行
if (isDirectRun("step-06-langgraph-plan.ts")) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
