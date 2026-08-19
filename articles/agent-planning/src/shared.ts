/**
 * shared.ts — 5 步渐进式共用的基础模块
 *
 * 本文件只放「多步复用」的部分：
 *   - LLM 初始化（读仓库根 .env）
 *   - 4 个模拟工具（get_user_info / get_orders / calculate_discount / generate_report）
 *   - 计划 Schema（Zod + withStructuredOutput 用）
 *   - 步骤状态类型
 *
 * 文章变量规则：首次定义在本文件，后续 step 直接 import 复用，不再重复写。
 */

import * as path from "node:path";
import * as dotenv from "dotenv";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { tool, type StructuredTool } from "@langchain/core/tools";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

// ──────────────── LLM 初始化 ────────────────

dotenv.config({ path: path.resolve(__dirname, "../../../.env"), override: true });

export const MODEL = process.env.LLM_MODEL ?? "deepseek-chat";
export const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
export const API_KEY = process.env.LLM_API_KEY ?? "";

export const llm = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  configuration: { baseURL: BASE_URL },
  temperature: 0.1,
  maxTokens: 4096,
});

// ──────────────── 工具定义（4 个模拟电商后台工具） ────────────────

export const getUserInfo = tool(
  async ({ userId }: { userId: string }) => {
    return JSON.stringify({
      id: userId,
      name: "张三",
      level: "VIP",
      points: 5200,
      registerDate: "2024-03-15",
    });
  },
  {
    name: "get_user_info",
    description: "根据用户名或用户 ID 查询用户信息，返回用户等级、积分等",
    schema: z.object({ userId: z.string().describe("用户名或用户 ID") }),
  }
);

export const getOrders = tool(
  async ({ userId: _userId }: { userId: string }) => {
    return JSON.stringify([
      { id: "ORD-20260801-001", amount: 299, date: "2026-08-01", status: "已完成" },
      { id: "ORD-20260810-002", amount: 1580, date: "2026-08-10", status: "已完成" },
      { id: "ORD-20260815-003", amount: 88, date: "2026-08-15", status: "配送中" },
    ]);
  },
  {
    name: "get_orders",
    description: "查询指定用户的订单历史，返回订单列表（含金额、日期）",
    schema: z.object({ userId: z.string().describe("用户名或用户 ID") }),
  }
);

export const calculateDiscount = tool(
  async ({
    totalAmount,
    userTier,
  }: {
    totalAmount: number;
    userTier: "普通" | "白银" | "黄金" | "VIP";
  }) => {
    const rates: Record<string, number> = { 普通: 0, 白银: 0.05, 黄金: 0.1, VIP: 0.15 };
    const rate = rates[userTier] ?? 0;
    return JSON.stringify({
      originalAmount: totalAmount,
      discountRate: rate,
      discountAmount: Math.round(totalAmount * rate * 100) / 100,
      finalAmount: Math.round(totalAmount * (1 - rate) * 100) / 100,
    });
  },
  {
    name: "calculate_discount",
    description: "计算用户应得的折扣金额，需要总金额和用户等级",
    schema: z.object({
      totalAmount: z.number().describe("订单总金额"),
      userTier: z.enum(["普通", "白银", "黄金", "VIP"]).describe("用户等级"),
    }),
  }
);

export const generateReport = tool(
  async ({ sections }: { sections: string[] }) => {
    const report = [
      "# 用户分析报告",
      "",
      `**生成时间**：${new Date().toISOString().slice(0, 10)}`,
      "",
      "---",
      "",
      ...sections.map((s, i) => `## 第 ${i + 1} 部分\n\n${s}`),
      "",
      "---",
      "",
      "> 报告由 AI Agent 自动生成，数据来源于模拟工具返回结果。",
    ].join("\n");
    return report;
  },
  {
    name: "generate_report",
    description: "根据提供的各部分内容，生成一份完整的用户报告",
    schema: z.object({
      sections: z.array(z.string()).describe("报告的各部分内容，每段是一个字符串"),
    }),
  }
);

/** 工具列表（ReAct / 执行循环用） */
export const tools = [getUserInfo, getOrders, calculateDiscount, generateReport];

/** 工具名称 → 工具实例映射（按名称查找执行） */
export const toolMap = new Map<string, StructuredTool>();
for (const t of tools) {
  toolMap.set(t.name, t);
}

// ──────────────── 参数引用解析（解决"计划参数静态化"问题） ────────────────

/** 步骤状态容器：Map 或 Record 都支持（step-02~05 用 Map，step-06/07 LangGraph 用 Record） */
type StepStateContainer = Map<string, StepState> | Record<string, StepState>;

function getStepState(container: StepStateContainer, id: string): StepState | undefined {
  if (container instanceof Map) return container.get(id);
  return container[id];
}

/**
 * 解析步骤参数中的引用语法，让计划参数可以动态引用前序步骤的结果。
 *
 * 问题背景（Step 02-06 的真实坑）：
 *   LLM 生成计划时不知道执行后的数据，calculate_discount 的 totalAmount
 *   只能填占位值 0，导致计算结果全为 0——"流程跑通但结果是错的"。
 *
 * 解决：LLM 在 args 里写引用语法，执行前用本函数替换成真实值：
 *   - "$ref:step-1"           → step-1 的完整结果（JSON 解析后）
 *   - "$ref:step-1.level"     → step-1 结果里的 level 字段
 *   - "$ref:step-2.amount"    → step-2 结果（数组）里每个元素的 amount 组成的数组
 *   - "$sum($ref:step-2.amount)" → 对上面那个数组求和（订单总金额）
 *   - 数组/对象内嵌的字符串引用也会被递归解析
 *
 * 对应真实设计：LLMCompiler 的 $ref 依赖引用语法 + 执行时动态解析。
 */
export function resolveArgs(
  args: Record<string, unknown>,
  stepStates: StepStateContainer
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    resolved[key] = resolveValue(value, stepStates);
  }
  return resolved;
}

/** 递归解析单个值：字符串引用 → 真实值；数组/对象 → 逐元素解析 */
function resolveValue(value: unknown, stepStates: StepStateContainer): unknown {
  if (typeof value === "string") {
    // $sum($ref:step-N.field)：对引用结果（数组）求和
    const sumMatch = value.match(/^\$sum\(\$ref:([\w.-]+)\)$/);
    if (sumMatch) {
      const data = getRefData(sumMatch[1], stepStates);
      if (Array.isArray(data)) {
        return data.reduce((sum, item) => sum + (Number(item) || 0), 0);
      }
      return 0;
    }
    // $ref:step-N 或 $ref:step-N.field：取引用值
    const refMatch = value.match(/^\$ref:([\w.-]+)$/);
    if (refMatch) {
      const data = getRefData(refMatch[1], stepStates);
      // 对象/数组自动转 JSON 字符串（如 generate_report 的 sections: string[] 引用完整步骤结果）
      if (data !== undefined && typeof data === "object") {
        return JSON.stringify(data);
      }
      return data;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, stepStates));
  }
  if (value && typeof value === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = resolveValue(v, stepStates);
    }
    return obj;
  }
  return value;
}

/** 按路径从已完成步骤的结果中取数据 */
function getRefData(path: string, stepStates: StepStateContainer): unknown {
  const [stepId, ...rest] = path.split(".");
  const state = getStepState(stepStates, stepId);
  if (!state?.result) return undefined;

  // 结果存的是 JSON 字符串，先解析
  let data: unknown;
  try {
    data = JSON.parse(state.result);
  } catch {
    data = state.result;
  }

  for (const key of rest) {
    if (Array.isArray(data)) {
      if (/^\d+$/.test(key)) {
        data = data[Number(key)]; // 数组按索引取
      } else {
        // 数组按字段取：返回每个元素的该字段组成的数组
        data = data
          .map((item) =>
            item && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined
          )
          .filter((v) => v !== undefined);
      }
    } else if (data && typeof data === "object") {
      data = (data as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return data;
}

// ──────────────── 计划生成（多步复用） ────────────────

/**
 * 生成计划：LLM structured output 输出 JSON 计划（只规划，不执行）
 *
 * 所有 Step 共用的标准计划生成函数。Step 04 的 Planner 有独立版本（planOnly），
 * 因为其 prompt 强调"只规划不执行"的角色分离语义。
 */
export async function generatePlan(task: string): Promise<PlanStep[]> {
  const planLLM = llm.withStructuredOutput(PlanSchema, {
    method: "functionCalling",
    name: "generate_plan",
  });

  const systemPrompt = new SystemMessage(
    "你是一个任务规划助手。用户会给你一个多步任务，你需要：\n" +
      "1. 分析任务需要哪些步骤\n" +
      "2. 确定每个步骤要用哪个工具\n" +
      "3. 确定步骤间的依赖关系（depends_on）\n" +
      "4. 为每个步骤填写正确的 args 参数\n" +
      "5. 输出 JSON 格式的计划\n\n" +
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
      "## 注意\n" +
      "- get_user_info 和 get_orders 没有依赖关系，可以并行执行\n" +
      '- calculate_discount 依赖前两步：totalAmount 用 "$sum($ref:step-2.amount)"（订单金额求和），' +
      'userTier 用 "$ref:step-1.level"（用户等级）\n' +
      '- generate_report 依赖所有前面的步骤，sections 里可以引用各步结果（如 "$ref:step-3"）\n' +
      "- 每个步骤的 id 必须是 step-1, step-2, ... 格式\n" +
      "- 不依赖前序结果的参数（如 userId）直接填字面值"
  );

  const result = await planLLM.invoke([systemPrompt, new HumanMessage(task)]);
  return (result as unknown as { steps: PlanStep[] }).steps;
}

// ──────────────── 计划验证 ────────────────

/**
 * 验证计划的正确性：检查工具是否存在、依赖是否合法、是否存在循环依赖
 *
 * 真实场景中，LLM 生成的计划可能有误（引用了不存在的工具、循环依赖等），
 * 在执行前验证可以避免运行时崩溃。
 */
export function validatePlan(
  steps: PlanStep[],
  knownStepIds: Set<string> = new Set()
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  // 已知步骤 = 新计划步骤 + 外部已完成的步骤（replan 场景：新计划可依赖已完成步骤）
  const stepIds = new Set([...steps.map((s) => s.id), ...knownStepIds]);
  const validTools: Set<string> = new Set(tools.map((t) => t.name));

  // 1. 检查每个步骤的工具和依赖
  for (const step of steps) {
    if (!validTools.has(step.tool)) {
      errors.push(`${step.id}: 未知工具 "${step.tool}"，可用工具: ${[...validTools].join(", ")}`);
    }
    for (const depId of step.depends_on) {
      if (!stepIds.has(depId)) {
        errors.push(`${step.id}: 依赖了不存在的步骤 "${depId}"`);
      }
    }
  }

  // 2. 检测循环依赖（DFS 深度优先搜索）
  // 两个集合的分工：
  //   - visited：已经彻底检查完的步骤（确定不会形成环），永久标记，避免重复检查
  //   - inStack：当前这条检查路径上「还没走完」的步骤，临时标记
  // 如果沿着依赖链走到一个还在 inStack 里的步骤 → 依赖关系绕回了原点 → 有环
  //
  // 例：step-1 → step-2 → step-3 → step-2
  //   查 step-1 时 inStack = {1, 2, 3}，查 step-3 的依赖 step-2 时发现
  //   step-2 还在 inStack 里（没走完），说明 2 → 3 → 2 形成了一个环
  const visited = new Set<string>();
  const inStack = new Set<string>();

  /**
   * 递归检查从 nodeId 出发的依赖链是否存在环
   * @param nodeId 当前检查的步骤 ID
   * @returns 从该步骤出发是否发现环
   */
  function hasCycle(nodeId: string): boolean {
    if (inStack.has(nodeId)) return true; // 命中「还没走完」的步骤 → 绕了一圈，有环
    if (visited.has(nodeId)) return false; // 早就查完了 → 不会成环，直接复用结果

    // 首次访问：先假设它在环上（加入 inStack），检查完再解除假设
    visited.add(nodeId);
    inStack.add(nodeId);
    const step = steps.find((s) => s.id === nodeId);
    if (step) {
      for (const depId of step.depends_on) {
        if (hasCycle(depId)) {
          errors.push(`检测到循环依赖: ${nodeId} → ${depId}`);
          return true;
        }
      }
    }
    // 所有依赖都查完没发现环 → 本步骤安全，从当前路径移除（但保留在 visited）
    inStack.delete(nodeId);
    return false;
  }

  for (const step of steps) {
    hasCycle(step.id);
  }

  return { valid: errors.length === 0, errors };
}

// ──────────────── 计划 Schema（Zod + Structured Output） ────────────────

export const PlanStepSchema = z.object({
  id: z.string().describe("步骤唯一标识，如 step-1"),
  description: z.string().describe("该步骤做什么的简短描述"),
  tool: z.string().describe("要调用的工具名称，必须是可用工具之一"),
  args: z.record(z.string(), z.any()).describe("传给工具的参数，key-value 形式"),
  depends_on: z
    .array(z.string())
    .describe("依赖的步骤 ID 列表。只有这些步骤都完成后，本步骤才能执行"),
});

export const PlanSchema = z.object({
  reasoning: z.string().describe("为什么这么规划，以及依赖关系的说明"),
  steps: z.array(PlanStepSchema).describe("计划步骤列表，按依赖关系排序"),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type Plan = z.infer<typeof PlanSchema>;

// ──────────────── 步骤状态跟踪 ────────────────

export type StepStatus = "pending" | "in_progress" | "done" | "failed";

export interface StepState {
  step: PlanStep;
  status: StepStatus;
  result?: string;
  error?: string;
}

export function createStepState(step: PlanStep): StepState {
  return { step, status: "pending" };
}

// ──────────────── 结果汇总（多步复用） ────────────────

/**
 * 汇总计划执行结果：统计成功/失败数，逐步骤打印状态和结果
 * @param stateMap 步骤 ID → 步骤状态的映射
 * @returns 格式化的汇总字符串
 */
export function aggregateResults(stateMap: Map<string, StepState>): string {
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

/** 演示任务：多步 + 有依赖关系 */
export const TASK =
  "查询用户张三的信息和他的订单历史，计算他应得的折扣金额，然后生成一份简明报告。";
