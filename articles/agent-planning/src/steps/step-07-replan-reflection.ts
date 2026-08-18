/**
 * Step 07 – LangGraph Replan + Self-Reflection：失败重规划 + 结果自评
 *
 * 学习目标：在 LangGraph 图结构上叠加 Replan 和 Reflector 两个高级节点，
 * 展示"图的可扩展性"——新增能力只需加节点+边，不动已有代码。
 *
 * 在 Step 06 基础上新增两个节点：
 *   1. Replan 节点：某步执行失败时，LLM 重新生成剩余步骤（同 Step 05）
 *   2. Reflector 节点：全部执行完成后，LLM 评估结果是否满足原始任务
 *      - 如果评估"不满意" → 重新规划
 *      - 如果评估"满意" → 结束
 *
 * 核心知识点（LangGraph 深度）：
 *   1. 图的可组合性：新增节点和边，不影响已有节点
 *   2. 条件边多路路由：executor → {executor, replan, reflector}
 *   3. 生产级 Agent 的三个关键阶段：Plan → Execute → Reflect
 *   4. 防无限循环：replanCount 和 reflectCount 硬上限
 *
 * 对应真实设计：
 *   - Reflexion 论文（Shinn et al., 2023）的核心思想：Agent 执行后自我评估 → 重试
 *   - LangGraph 的 ReAct + Reflection 模式（在官方教程三节点基础上
 *     增加 Reflector 节点，形成 Plan → Execute → Reflect → Replan 闭环）
 *   - dsh 的 error-recovery-with-reflection 策略
 *
 * 跑法：pnpm run:planning:step7
 */

import "dotenv/config";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  llm,
  TASK,
  PlanSchema,
  PlanStep,
  StepState,
  createStepState,
  toolMap,
  generatePlan,
  validatePlan,
  aggregateResults,
  resolveArgs,
} from "../shared";

// ════════════════════════════════════════════════════════════════
// 1. 图状态：比 Step 06 多了 reflection 和 reflectCount
// ════════════════════════════════════════════════════════════════

const PlanningState = Annotation.Root({
  task: Annotation<string>(),
  plan: Annotation<PlanStep[]>(),
  stepStates: Annotation<Record<string, StepState>>(),
  needsReplan: Annotation<boolean>(),
  replanCount: Annotation<number>(),
  /** Reflector 的评估结果 */
  reflection: Annotation<string>(),
  /** 自我反思次数（防止无限循环） */
  reflectCount: Annotation<number>(),
});

// ════════════════════════════════════════════════════════════════
// 2. 节点定义
// ════════════════════════════════════════════════════════════════

/**
 * Planner 节点（同 Step 06）
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
  }

  const stepStates: Record<string, StepState> = {};
  for (const step of plan) {
    stepStates[step.id] = createStepState(step);
  }

  return {
    plan,
    stepStates,
    needsReplan: false,
    replanCount: 0,
    reflection: "",
    reflectCount: 0,
  };
}

/**
 * Executor 节点：依赖调度 + 模拟 get_orders 失败
 *
 * 与 Step 06 的区别：模拟 get_orders 调用超时，
 * 触发 replan 节点，展示重规划流程。
 */
async function executorNode(state: typeof PlanningState.State) {
  const stepStates = { ...state.stepStates };
  let hasFailed = false;

  // 如果是重规划后的执行，打印提示
  if (state.replanCount > 0) {
    console.log("\n── Executor 节点: 执行重规划后的计划 ──\n");
  } else {
    console.log("\n── Executor 节点: 执行就绪步骤 ──\n");
  }

  const readySteps = Object.values(stepStates).filter((s) => {
    if (s.status !== "pending") return false;
    return s.step.depends_on.every((depId) => {
      const dep = stepStates[depId];
      return dep && dep.status === "done";
    });
  });

  if (readySteps.length === 0) {
    console.log("  （本轮回合无就绪步骤）");
    return { stepStates };
  }

  console.log(`  就绪步骤: ${readySteps.map((s) => s.step.id).join(", ")}\n`);

  for (const stepState of readySteps) {
    stepState.status = "in_progress";
    const { step } = stepState;
    console.log(`  ▶ ${step.id}: ${step.description}`);

    // 模拟失败：get_orders 第一次调用超时
    if (step.tool === "get_orders") {
      console.log("  ⚠️ 模拟失败：get_orders 调用超时（网络异常）");
      stepState.status = "failed";
      stepState.error = "调用超时：get_orders 请求超时，目标服务不可达";
      hasFailed = true;
      console.log(`  ❌ ${step.id} 失败: ${stepState.error}\n`);
      continue; // 继续执行其他就绪步骤
    }

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
 * Replan 节点：失败后 LLM 重新生成剩余步骤
 *
 * 同 Step 05 的 replan 逻辑，但以 LangGraph 节点形式实现。
 * 有硬上限（3 次），防止无限重规划。
 */
async function replanNode(state: typeof PlanningState.State) {
  console.log("── Replan 节点: 重规划剩余步骤 ──\n");

  const stepStates = { ...state.stepStates };
  const replanCount = (state.replanCount ?? 0) + 1;

  if (replanCount > 3) {
    console.log("  ⚠️ 已达最大重规划次数 (3)，标记剩余步骤为失败\n");
    for (const s of Object.values(stepStates)) {
      if (s.status === "pending") {
        s.status = "failed";
        s.error = "超过最大重规划次数";
      }
    }
    return { stepStates, needsReplan: false, replanCount };
  }

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

  console.log(`\n  重规划后新计划 (${newSteps.length} 步):`);
  for (const step of newSteps) {
    const deps = step.depends_on.length > 0 ? ` [依赖: ${step.depends_on.join(", ")}]` : "";
    console.log(`    ${step.id}: ${step.description}${deps}`);
  }
  console.log();

  // 替换旧的 pending/failed 步骤
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

/**
 * Reflector 节点：全部执行完成后，LLM 自我评估输出质量
 *
 * 这是 Reflexion 模式的核心——Agent 审视自己的输出，
 * 判断是否满足原始任务要求。不满意则触发重规划。
 *
 * 与 Replan 的区别：
 *   - Replan 是"某步失败"触发的被动调整
 *   - Reflector 是"全部完成"后的主动审视
 */
async function reflectorNode(state: typeof PlanningState.State) {
  console.log("── Reflector 节点: 自我评估执行结果 ──\n");

  const reflectCount = (state.reflectCount ?? 0) + 1;

  if (reflectCount > 2) {
    console.log("  ⚠️ 已达最大反思次数 (2)，接受当前结果\n");
    return { reflection: "已达到最大反思次数", reflectCount };
  }

  // 收集所有已完成步骤的结果
  const done = Object.values(state.stepStates).filter((s) => s.status === "done");
  const failed = Object.values(state.stepStates).filter((s) => s.status === "failed");

  const resultsSummary = done
    .map((s) => `[${s.step.id}] ${s.step.description}: ${(s.result ?? "").slice(0, 150)}`)
    .join("\n");

  const failedSummary = failed
    .map((s) => `[${s.step.id}] ${s.step.description}: ${s.error ?? "未知错误"}`)
    .join("\n");

  // 用 LLM 评估结果质量
  const evaluation = await llm.invoke([
    new SystemMessage(
      "你是一个质量评估器。检查执行结果是否满足原始任务的所有要求。\n" +
        "输出格式：\n" +
        "第一行：SATISFIED（满意）或 UNSATISFIED（不满意）\n" +
        "第二行起：评估理由（简洁）\n\n" +
        "判断标准：\n" +
        "- 原始任务要求的每个部分是否都有结果\n" +
        "- 数据是否合理、完整\n" +
        "- 若有失败步骤，是否影响核心任务"
    ),
    new HumanMessage(
      `原始任务: ${state.task}\n\n` +
        `成功步骤:\n${resultsSummary || "  （无）"}\n\n` +
        `失败步骤:\n${failedSummary || "  （无）"}`
    ),
  ]);

  const reflection =
    typeof evaluation.content === "string"
      ? evaluation.content
      : JSON.stringify(evaluation.content);
  console.log(`  评估结果:\n  ${reflection.replace(/\n/g, "\n  ")}\n`);

  return { reflection, reflectCount };
}

// ════════════════════════════════════════════════════════════════
// 3. 条件边路由
// ════════════════════════════════════════════════════════════════

/**
 * Executor 之后的路由
 *
 * 四条路径：
 *   → executor: 还有就绪步骤，继续执行
 *   → replan:   有步骤失败，触发重规划
 *   → reflector: 全部完成，进入自我评估
 *   → END:      阻塞（依赖死锁），直接结束
 */
function routeAfterExecutor(state: typeof PlanningState.State): string {
  const stepStates = state.stepStates;

  const allDone = Object.values(stepStates).every(
    (s) => s.status === "done" || s.status === "failed"
  );

  // 全部完成 → 进入自我评估
  if (allDone) return "reflector";

  // 有失败 → 触发重规划
  if (state.needsReplan) return "replan";

  // 有就绪步骤 → 继续执行
  const hasReady = Object.values(stepStates).some((s) => {
    if (s.status !== "pending") return false;
    return s.step.depends_on.every((depId) => {
      const dep = stepStates[depId];
      return dep && dep.status === "done";
    });
  });
  if (hasReady) return "executor";

  return END;
}

/**
 * Reflector 之后的路由
 *
 * 检查评估结果：不满意 → 重新规划；满意 → 结束
 */
function routeAfterReflector(state: typeof PlanningState.State): string {
  const reflection = state.reflection ?? "";

  // 不满意 → 触发重规划（注意：这里设 needsReplan 会有点绕，
  // 实际上 reflector 返回后直接走 replan 边）
  if (reflection.toUpperCase().startsWith("UNSATISFIED")) {
    console.log("  → Reflector 判定不满意，触发重规划\n");
    return "replan";
  }

  console.log("  → Reflector 判定满意，结束\n");
  return END;
}

// ════════════════════════════════════════════════════════════════
// 4. 构建图
// ════════════════════════════════════════════════════════════════

/**
 * 生产级 Planning Agent 图结构：
 *
 *                    ┌──────────────────────────┐
 *                    │      executor ⇄ executor │
 *                    └──────────┬───┬───────────┘
 *                               │   │
 *                     (失败)    │   │   (全部完成)
 *                          ┌────┘   └──────┐
 *                          ↓                ↓
 *                       replan          reflector
 *                          │                │
 *                          │           ┌────┴────┐
 *                          │     (不满意)│         │(满意)
 *                          │           ↓         ↓
 *                          └──────→ executor    END
 *
 * 对比 Step 06：多了 reflector 节点和 routeAfterReflector 条件边，
 * 其余节点和边完全不变——这就是图的可扩展性。
 */
function buildGraph() {
  return (
    new StateGraph(PlanningState)
      .addNode("planner", plannerNode)
      .addNode("executor", executorNode)
      .addNode("replan", replanNode)
      .addNode("reflector", reflectorNode)

      .addEdge(START, "planner")
      .addEdge("planner", "executor")

      // executor 的四路路由
      .addConditionalEdges("executor", routeAfterExecutor, {
        executor: "executor",
        replan: "replan",
        reflector: "reflector",
        [END]: END,
      })

      .addEdge("replan", "executor")

      // reflector 的二路路由
      .addConditionalEdges("reflector", routeAfterReflector, {
        replan: "replan",
        [END]: END,
      })

      .compile()
  );
}

// ════════════════════════════════════════════════════════════════
// 5. 主入口
// ════════════════════════════════════════════════════════════════

export async function main() {
  console.log("=".repeat(72));
  console.log("Step 07: LangGraph Replan + Self-Reflection — 生产级 Planning Agent");
  console.log("=".repeat(72));

  console.log(`\n任务：「${TASK}」\n`);
  console.log("⚠️ 本步将模拟 get_orders 调用超时，触发 重规划 + 自我反思 流程\n");
  console.log("图结构: planner → executor ⇄ executor → replan → executor → reflector → END\n");

  const graph = buildGraph();

  const result = await graph.invoke({
    task: TASK,
    plan: [],
    stepStates: {},
    needsReplan: false,
    replanCount: 0,
    reflection: "",
    reflectCount: 0,
  });

  // 汇总
  console.log("── 最终结果汇总 ──\n");
  console.log(aggregateResults(new Map(Object.entries(result.stepStates))));

  if (result.reflection) {
    console.log(`\n📝 Reflector 最终评估:\n  ${result.reflection.replace(/\n/g, "\n  ")}`);
  }

  console.log("\n观察点：");
  console.log("  ① get_orders 超时 → Replan 节点生成替代方案 → Executor 继续执行");
  console.log("  ② 全部执行完 → Reflector 节点评估输出质量");
  console.log("  ③ Reflector 不满意 → 自动触发第二轮重规划");
  console.log("  ④ 对比 Step 06：只加了一个节点(Reflector)+一条条件边，其余代码不变");
  console.log("  ⑤ 这是 Reflexion 模式的核心：Plan → Execute → Reflect → Replan");
  console.log("  ⑥ 硬上限（replanCount≤3, reflectCount≤2）防止无限循环");
  console.log("  ⑦ 生产级 Agent 的完整形态：每个节点可独立替换、独立测试");
  console.log("\n✅ Step 07 完成，7 步渐进式全部跑通\n");
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
