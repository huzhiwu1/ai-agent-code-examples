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

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

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
      "注意：\n" +
      "- get_user_info 和 get_orders 没有依赖关系，可以并行执行\n" +
      "- calculate_discount 依赖前两步的结果（totalAmount 从订单汇总，userTier 从用户信息获取）\n" +
      "- generate_report 依赖所有前面的步骤\n" +
      "- 每个步骤的 id 必须是 step-1, step-2, ... 格式\n" +
      "- args 必须填写工具所需的全部参数，不要留空"
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
export function validatePlan(steps: PlanStep[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const stepIds = new Set(steps.map((s) => s.id));
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

  // 2. 检测循环依赖（DFS）
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(nodeId: string): boolean {
    if (inStack.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
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
