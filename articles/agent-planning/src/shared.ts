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

import "dotenv/config";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicStructuredTool } from "@langchain/core/tools";

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

export const getUserInfo = new DynamicStructuredTool({
  name: "get_user_info",
  description: "根据用户名或用户 ID 查询用户信息，返回用户等级、积分等",
  schema: z.object({ userId: z.string().describe("用户名或用户 ID") }),
  func: async ({ userId }) => {
    return JSON.stringify({
      id: userId,
      name: "张三",
      level: "VIP",
      points: 5200,
      registerDate: "2024-03-15",
    });
  },
});

export const getOrders = new DynamicStructuredTool({
  name: "get_orders",
  description: "查询指定用户的订单历史，返回订单列表（含金额、日期）",
  schema: z.object({ userId: z.string().describe("用户名或用户 ID") }),
  func: async ({ userId: _userId }) => {
    return JSON.stringify([
      { id: "ORD-20260801-001", amount: 299, date: "2026-08-01", status: "已完成" },
      { id: "ORD-20260810-002", amount: 1580, date: "2026-08-10", status: "已完成" },
      { id: "ORD-20260815-003", amount: 88, date: "2026-08-15", status: "配送中" },
    ]);
  },
});

export const calculateDiscount = new DynamicStructuredTool({
  name: "calculate_discount",
  description: "计算用户应得的折扣金额，需要总金额和用户等级",
  schema: z.object({
    totalAmount: z.number().describe("订单总金额"),
    userTier: z.enum(["普通", "白银", "黄金", "VIP"]).describe("用户等级"),
  }),
  func: async ({ totalAmount, userTier }) => {
    const rates: Record<string, number> = { 普通: 0, 白银: 0.05, 黄金: 0.1, VIP: 0.15 };
    const rate = rates[userTier] ?? 0;
    return JSON.stringify({
      originalAmount: totalAmount,
      discountRate: rate,
      discountAmount: Math.round(totalAmount * rate * 100) / 100,
      finalAmount: Math.round(totalAmount * (1 - rate) * 100) / 100,
    });
  },
});

export const generateReport = new DynamicStructuredTool({
  name: "generate_report",
  description: "根据提供的各部分内容，生成一份完整的用户报告",
  schema: z.object({
    sections: z.array(z.string()).describe("报告的各部分内容，每段是一个字符串"),
  }),
  func: async ({ sections }) => {
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
});

/** 工具列表（ReAct / 执行循环用） */
export const tools = [getUserInfo, getOrders, calculateDiscount, generateReport];

/** 工具名称 → 工具实例映射（按名称查找执行） */
export const toolMap = new Map<string, DynamicStructuredTool>();
for (const t of tools) {
  toolMap.set(t.name, t);
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

/** 演示任务：多步 + 有依赖关系 */
export const TASK =
  "查询用户张三的信息和他的订单历史，计算他应得的折扣金额，然后生成一份简明报告。";
