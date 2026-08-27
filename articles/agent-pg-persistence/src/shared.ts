/**
 * shared.ts — 「售后客服 Agent + PostgreSQL 持久化」7 步渐进式共用的基础模块
 *
 * 本文件只放「多步复用」的部分：
 *   - 根 .env 加载（LLM_* / EMBEDDING_*，见仓库根目录 .env）
 *   - DB_URI 与 pg 连接池工厂
 *   - createLLM() / createEmbeddings()
 *   - 贯穿 7 步的「退款工单」业务主线常量（用户 / 工单 / 政策）
 *   - console 辅助函数（divider / banner）
 *
 * 文章变量规则：首次定义在本文件，后续 step 直接 import 复用，不再重复写。
 */

import * as path from "node:path";
import * as dotenv from "dotenv";
import pg from "pg";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";

// ──────────────── 环境加载（仓库根 .env） ────────────────

dotenv.config({ path: path.resolve(__dirname, "../../../.env"), override: true });

export const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
export const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1";
export const LLM_MODEL = process.env.LLM_MODEL ?? "deepseek-chat";

export const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY ?? "";
export const EMBEDDING_BASE_URL =
  process.env.EMBEDDING_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-v3";

// ──────────────── 数据库连接 ────────────────

/**
 * 本地 PG 连接串（docker 启动方式见 README）
 * 对应文档: https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-postgres
 */
export const DB_URI = "postgresql://postgres:postgres@localhost:5432/postgres?sslmode=disable";

/** 生产要点：连接池全局唯一、复用，而不是每步 new 一个连接（step-07 专门讲） */
export function createPool(max = 10): pg.Pool {
  return new pg.Pool({ connectionString: DB_URI, max });
}

// ──────────────── LLM / Embeddings ────────────────

export function createLLM() {
  return new ChatOpenAI({
    model: LLM_MODEL,
    apiKey: LLM_API_KEY,
    configuration: { baseURL: LLM_BASE_URL },
    temperature: 0.2,
    maxTokens: 2048,
  });
}

export function createEmbeddings() {
  return new OpenAIEmbeddings({
    model: EMBEDDING_MODEL,
    apiKey: EMBEDDING_API_KEY,
    configuration: { baseURL: EMBEDDING_BASE_URL },
  });
}

// ──────────────── 业务主线：售后客服「退款工单」场景 ────────────────

/**
 * 贯穿 7 步的统一故事线：
 * 老用户林女士 8 月 26 日买的无线耳机出现断连问题，发起退款工单 RT-2026-0826-001。
 * Agent 要：记下工单信息（step 1-2）→ 走审批状态机（step 3）→ 多实例并发处理（step 4）
 *        → 记得她是会员老客户（step 5）→ 查售后政策（step 6）→ 生产加固（step 7）
 */

export const CUSTOMER = {
  name: "林女士",
  userId: "user-8001",
  memberTier: "白金会员",
  phone: "138****6688",
};

export const TICKET = {
  id: "RT-2026-0826-001",
  product: "M20 无线降噪耳机",
  orderAmount: 1299,
  issue: "左耳 8 月 27 日开始频繁断连，重置后仍然复现",
  applyTime: "2026-08-27 10:24",
};

export const REFUND_POLICY = [
  "7 天无理由退换：自签收日起 7 天内，商品不影响二次销售，可申请无理由退款，运费由买家承担。",
  "15 天质量问题换货：自签收日起 15 天内出现非人为损坏的质量问题，可申请换货，运费由卖家承担。",
  "一年质保维修：自签收日起 1 年内出现质量问题，可免费维修；维修期间超过 7 天可选择换货。",
  "退款时效：审核通过后，退款将在 1-3 个工作日原路退回支付账户。",
  "特殊商品除外：定制类、贴身类（入耳式耳机配件）拆封后不支持无理由退换，但质量问题仍适用三包。",
];

// ──────────────── console 辅助 ────────────────

/** 打印「先懂几个词」术语区 */
export function termsBox(title: string, terms: Array<[string, string]>) {
  console.log("\n━━━ 先懂几个词 ━━━");
  console.log(`  ${title}`);
  for (const [term, explain] of terms) {
    console.log(`  • ${term} = ${explain}`);
  }
  console.log("━━━━━━━━━━━━━━━━");
}

/** 打印 step 分隔横幅 */
export function divider(title: string, char = "=") {
  const len = 72;
  const pad = Math.max(0, len - title.length - 2);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  console.log(`\n${char.repeat(len)}`);
  console.log(`${char}${" ".repeat(left)}${title}${" ".repeat(right)}${char}`);
  console.log(`${char.repeat(len)}\n`);
}

/** 从 Agent 结果里取最后一条消息文本 */
export function lastMessageText(result: { messages?: Array<{ content?: unknown }> }) {
  const last = result.messages?.at(-1)?.content;
  if (typeof last === "string") return last;
  return JSON.stringify(last ?? result);
}
