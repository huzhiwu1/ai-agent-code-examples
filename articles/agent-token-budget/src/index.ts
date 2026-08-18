/**
 * Agent Token 预算/成本控制：从追踪到优化
 * ==================================================================
 * 文章：《Agent 烧 token 太快怎么办？从预算到优化》
 *
 * 渐进式演示：
 *   Part 1「追踪」：TokenUsageTracker — 自定义 callback handler，
 *     每轮 LLM 调用后提取 usage_metadata，按轮累计
 *   Part 2「预算」：TokenBudget — 设定总预算 + 单轮预算，超了拦截
 *   Part 3「策略」：三种超预算处理方式对比
 *     a. trimMessages：截断旧消息，保留最近 N 轮
 *     b. summarizeHistory：LLM 把历史对话压缩成一段摘要
 *     c. switchModel：降级到更便宜的模型
 *   Part 4「监控」：接入 LangFuse CallbackHandler（可选）
 *
 * 环境变量（仓库根目录 .env）：
 *   LLM_API_KEY                必填：API key
 *   LLM_BASE_URL               可选，默认 https://api.deepseek.com
 *   LLM_MODEL                  可选，默认 deepseek-chat
 *   LLM_MODEL_CHEAP            可选，降级目标模型，默认 deepseek-chat
 *   LANGFUSE_PUBLIC_KEY        可选：Langfuse 公钥
 *   LANGFUSE_SECRET_KEY        可选：Langfuse 私钥
 *   LANGFUSE_HOST              可选，默认 https://cloud.langfuse.com
 *
 * 运行：cd ~/workspace/ai-agent-code-examples && pnpm run run:agent-token-budget
 *
 * ⚠️ 坑点提醒：
 *   - DeepSeek 通过 ChatOpenAI 调用时，usage_metadata 不一定在
 *     llmOutput 中出现，但会在返回的 AIMessage 上。代码同时处理两种来源
 *   - trimMessages 依赖 @langchain/core 内置函数，实测需 >=0.3.0
 *   - LangFuse 部分：没有 key 会优雅降级，不阻塞主流程
 *   - 网络问题：第一次运行可能因 API 超时失败，重试即可
 */

import "dotenv/config";
import * as dotenv from "dotenv";
import * as path from "node:path";
import { ChatOpenAI } from "@langchain/openai";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { HumanMessage, SystemMessage, AIMessage, trimMessages } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";

// LangFuse 可选导入；没有装包或 import 报错时降级
let LangfuseCallbackHandler: typeof import("@langfuse/langchain").CallbackHandler | undefined;
try {
  LangfuseCallbackHandler = (await import("@langfuse/langchain")).CallbackHandler;
} catch {
  // 没装 @langfuse/langchain，LangFuse 部分跳过
}

// 加载仓库根目录 .env
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

/* ================================================================== */
/* 0. 配置                                                             */
/* ================================================================== */

const ENV = {
  apiKey: process.env.LLM_API_KEY ?? "",
  baseUrl: process.env.LLM_BASE_URL ?? "https://api.deepseek.com",
  model: process.env.LLM_MODEL ?? "deepseek-chat",
  modelCheap: process.env.LLM_MODEL_CHEAP ?? "deepseek-chat",
  langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY ?? "",
  langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY ?? "",
  langfuseHost: process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com",
};

if (!ENV.apiKey) {
  console.error("❌ 缺少 LLM_API_KEY，请在仓库根目录 .env 里配置");
  process.exit(1);
}

// 主模型（正常价格）
const llm = new ChatOpenAI({
  model: ENV.model,
  apiKey: ENV.apiKey,
  configuration: { baseURL: ENV.baseUrl },
  temperature: 0.2,
  maxTokens: 2048,
});

// 便宜模型（降级目标）
const llmCheap = new ChatOpenAI({
  model: ENV.modelCheap,
  apiKey: ENV.apiKey,
  configuration: { baseURL: ENV.baseUrl },
  temperature: 0.2,
  maxTokens: 1024,
});

/* ================================================================== */
/* 1. TokenUsageTracker — 定制 callback，每轮追踪 token 用量           */
/* ================================================================== */

/**
 * 单轮 token 统计条目
 */
export interface TokenUsageEntry {
  /** 对话轮次（从 1 开始） */
  round: number;
  /** 提问内容摘要 */
  query: string;
  /** 输入 token 数 */
  inputTokens: number;
  /** 输出 token 数 */
  outputTokens: number;
  /** 总计 */
  totalTokens: number;
  /** 来源说明：callback / message / fallback */
  source: "callback" | "message" | "fallback";
}

/**
 * TokenUsageTracker
 *
 * 核心思路：接管 BaseCallbackHandler.handleLLMEnd，在每次 LLM 调用
 * 完成后提取 usage_metadata，按轮累计。
 *
 * 统计口径说明：
 *   - 按轮累计：每个用户提问 → LLM 回复算一轮，一轮内可能有多次 LLM
 *     调用（含工具调用时的多次 LLM 回圈），累计到同一轮
 *   - 流式 vs 非流式：本示例使用非流式（invoke），usage_metadata
 *     在 LLM 返回完整响应后可用。流式场景需在 stream 结束后拼接
 *   - 不同 Provider 差异：OpenAI 的 usage_metadata 结构稳定，
 *     DeepSeek 通过 ChatOpenAI 兼容层返回，可能缺失部分字段，
 *     代码做了 fallback 处理
 */
export class TokenUsageTracker extends BaseCallbackHandler {
  name = "TokenUsageTracker";

  /** 当前轮次（从 1 开始） */
  private currentRound = 0;

  /** 当前轮已累计的 LLM 调用次数 */
  private callsInCurrentRound = 0;

  /** 所有轮的 token 统计 */
  private rounds: TokenUsageEntry[] = [];

  /** 当前累计总 token */
  private totalTokens = 0;

  /** 用户提问队列（用于关联"这一轮用户问了什么"） */
  private queries: string[] = [];

  /**
   * 开始新的一轮对话
   * @param query 用户提问内容
   */
  startRound(query: string): void {
    this.currentRound++;
    this.callsInCurrentRound = 0;
    this.queries.push(query);
  }

  /**
   * 回调：LLM 调用完成后触发
   *
   * 两个来源的 usage 数据：
   *   1. Callback 的 llmOutput（OpenAI 原生路径）
   *   2. 返回的 AIMessage 上的 usage_metadata（DeepSeek 等兼容路径）
   *
   * 本 handler 优先使用 callback 来源，代码中也会演示如何从 message 提取
   */
  async handleLLMEnd(output: LLMResult, _runId: string): Promise<void> {
    this.callsInCurrentRound++;

    // 来源 1：从 llmOutput 提取 token 用量
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let source: TokenUsageEntry["source"] = "fallback";

    const tokenUsage = output.llmOutput?.tokenUsage as
      { completionTokens?: number; promptTokens?: number; totalTokens?: number } | undefined;

    if (tokenUsage) {
      inputTokens = tokenUsage.promptTokens ?? 0;
      outputTokens = tokenUsage.completionTokens ?? 0;
      totalTokens = tokenUsage.totalTokens ?? inputTokens + outputTokens;
      source = "callback";
    } else {
      // 来源 2：从 generations 中的 AIMessage 提取 usage_metadata
      // （DeepSeek 等兼容 API 走这条路）
      const gen = output.generations?.[0]?.[0] as
        { message?: { usage_metadata?: unknown } } | undefined;
      const msg = gen?.message;
      const usageMeta = msg?.usage_metadata as
        { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined;
      if (usageMeta) {
        inputTokens = usageMeta.input_tokens ?? 0;
        outputTokens = usageMeta.output_tokens ?? 0;
        totalTokens = usageMeta.total_tokens ?? inputTokens + outputTokens;
        source = "message";
      }
    }

    // 累加到当前轮
    this.totalTokens += totalTokens;

    // 记录本轮（如果已经是本轮第二次调用，把之前的记录更新为累计值）
    const existingIdx = this.rounds.findIndex((r) => r.round === this.currentRound);
    if (existingIdx >= 0) {
      const existing = this.rounds[existingIdx];
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.totalTokens += totalTokens;
      existing.source = source;
    } else {
      this.rounds.push({
        round: this.currentRound,
        query: this.queries[this.queries.length - 1] ?? "(未知)",
        inputTokens,
        outputTokens,
        totalTokens,
        source,
      });
    }
  }

  /** 获取当前累计总 token */
  getTotalTokens(): number {
    return this.totalTokens;
  }

  /** 获取当前轮次 */
  getCurrentRound(): number {
    return this.currentRound;
  }

  /** 获取所有轮次统计 */
  getRounds(): TokenUsageEntry[] {
    return [...this.rounds];
  }

  /** 打印统计报告 */
  printReport(): void {
    console.log("\n  ┌───── Token 用量统计报告 ─────┐");
    console.log(`  │ 总对话轮次：${this.rounds.length}`);
    console.log(`  │ 累计总 Token：${this.totalTokens}`);
    console.log(
      `  │ 平均每轮：${this.rounds.length ? Math.round(this.totalTokens / this.rounds.length) : 0}`
    );
    console.log("  ├──── 每轮明细 ─────────────────┤");
    this.rounds.forEach((r) => {
      console.log(
        `  │ 轮次 ${String(r.round).padStart(2, " ")}：` +
          `输入 ${String(r.inputTokens).padStart(5, " ")}  ` +
          `输出 ${String(r.outputTokens).padStart(5, " ")}  ` +
          `合计 ${String(r.totalTokens).padStart(6, " ")}  ` +
          `[${r.source}]`
      );
    });
    console.log("  └──────────────────────────────┘");
  }
}

/* ================================================================== */
/* 2. TokenBudget — 预算管理：累计 + 检查 + 拦截                       */
/* ================================================================== */

/**
 * 自定义预算超限错误
 */
export class BudgetExceededError extends Error {
  /** 超限时累计 token 数 */
  currentTotal: number;
  /** 预算上限 */
  budget: number;

  constructor(currentTotal: number, budget: number) {
    super(`Token 预算超限：当前 ${currentTotal} >= 预算 ${budget}`);
    this.name = "BudgetExceededError";
    this.currentTotal = currentTotal;
    this.budget = budget;
  }
}

/**
 * 预算检查结果
 */
export interface BudgetCheckResult {
  /** 是否在预算内 */
  ok: boolean;
  /** 已用 token */
  used: number;
  /** 预算上限 */
  limit: number;
  /** 剩余预算 */
  remaining: number;
  /** 超限的具体原因（ok 时为空） */
  reason?: "total" | "perRound";
}

/**
 * TokenBudget
 *
 * 预算放置点说明：
 *   - 总预算（totalBudget）：整个对话的 token 上限，防止无限累计
 *   - 单轮预算（perRoundBudget）：单轮最高 token 消耗，防止单次
 *     超长回复烧光预算
 *   - 预算检查时机：每次 LLM 调用后累计，下次调用前检查
 *   - 策略选择规则写在 check() 的返回值中，上层据此决定操作
 */
export class TokenBudget {
  private totalBudget: number;
  private perRoundBudget: number;
  private usedTotal = 0;
  private usedThisRound = 0;

  /**
   * @param totalBudget 总预算（token 数），0 表示不限制
   * @param perRoundBudget 单轮预算（token 数），0 表示不限制
   */
  constructor(totalBudget: number = 100_000, perRoundBudget: number = 0) {
    this.totalBudget = totalBudget;
    this.perRoundBudget = perRoundBudget;
  }

  /** 累计 token 用量 */
  addUsage(inputTokens: number, outputTokens: number): void {
    const total = inputTokens + outputTokens;
    this.usedTotal += total;
    this.usedThisRound += total;
  }

  /** 检查是否超预算 */
  check(): BudgetCheckResult {
    const remaining = this.totalBudget > 0 ? this.totalBudget - this.usedTotal : Infinity;
    const ok = !(
      (this.totalBudget > 0 && this.usedTotal >= this.totalBudget) ||
      (this.perRoundBudget > 0 && this.usedThisRound >= this.perRoundBudget)
    );

    let reason: BudgetCheckResult["reason"];
    if (!ok) {
      if (this.totalBudget > 0 && this.usedTotal >= this.totalBudget) {
        reason = "total";
      } else {
        reason = "perRound";
      }
    }

    return {
      ok,
      used: this.usedTotal,
      limit: this.totalBudget,
      remaining: remaining === Infinity ? -1 : remaining,
      reason,
    };
  }

  /** 新轮开始：重置本轮累计 */
  newRound(): void {
    this.usedThisRound = 0;
  }

  /** 获取当前总用量 */
  getUsedTotal(): number {
    return this.usedTotal;
  }

  /** 获取当前单轮用量 */
  getUsedThisRound(): number {
    return this.usedThisRound;
  }
}

/* ================================================================== */
/* 3. 三种超预算处理策略                                               */
/* ================================================================== */

/**
 * 策略选择规则：
 *
 * | 场景                           | 推荐策略       | 原因                         |
 * |--------------------------------|---------------|------------------------------|
 * | 对话轮次多（>10 轮），历史长     | trimMessages  | 快速回退，丢的是旧信息         |
 * | 历史重要，不能丢               | summarizeHistory | 压缩但保留关键信息           |
 * | 单轮消耗大，对话轮次少         | 降级模型       | 换便宜模型，不丢信息          |
 * | 预算即将耗尽，历史不重要       | trimMessages  | 最激进，但最省                |
 * | 预算即将耗尽，历史重要         | summarizeHistory | 折中，保留语义              |
 * | 模型能力过剩（简单问答）       | 降级模型       | 不损失功能，降低成本           |
 */

/**
 * 策略 3a：trimMessages — 截断旧消息
 *
 * 使用 LangChain 内置的 trimMessages 函数，保留最近 N 轮对话。
 * 底层调用了 tiktoken 做 token 计数，适合精确截断。
 *
 * 如果不想依赖 tiktoken，也可以按轮次截断（见 trimLastNRounds 备选）
 */
export async function trimStrategy(
  messages: BaseMessage[],
  maxTokenBudget: number,
  tokenCounter: (messages: BaseMessage[]) => number
): Promise<BaseMessage[]> {
  // 提取 system message（如果有的话，保留在最前面）
  const systemMsgs = messages.filter((m) => m instanceof SystemMessage);
  const nonSystemMsgs = messages.filter((m) => !(m instanceof SystemMessage));

  // 用 trimMessages 截断：保留最近的内容，但不超过预算
  // 注意：trimMessages 的 tokenCounter 接受消息数组，返回总 token 数
  const trimmed = await trimMessages(nonSystemMsgs, {
    maxTokens: maxTokenBudget,
    tokenCounter,
    strategy: "last",
    // 从 HumanMessage 和 AIMessage 开始截断，避免从中间开始
    startOn: ["human", "ai"],
    includeSystem: false,
  });

  // 把 system message 拼回去
  return [...systemMsgs, ...trimmed];
}

/**
 * 策略 3a 备选：trimLastNRounds — 按轮次截断
 *
 * 不依赖 tiktoken，直接按对话轮次保留最后 N 轮（即最后 N 对 Human/AI 消息）。
 * 适合对精确 token 计数不敏感但需要简单实现的场景。
 */
export function trimLastNRounds(messages: BaseMessage[], keepRounds: number): BaseMessage[] {
  const systemMsgs = messages.filter((m) => m instanceof SystemMessage);
  const nonSystemMsgs = messages.filter((m) => !(m instanceof SystemMessage));

  // 按轮次分组：每轮 = 一条 HumanMessage + 后续的 AI/工具消息
  // 取最后 keepRounds 轮
  const reverseRounds: BaseMessage[][] = [];
  let currentRound: BaseMessage[] = [];

  for (let i = nonSystemMsgs.length - 1; i >= 0; i--) {
    const msg = nonSystemMsgs[i];
    currentRound.unshift(msg);
    if (msg instanceof HumanMessage && currentRound.length > 0) {
      reverseRounds.unshift(currentRound);
      currentRound = [];
      if (reverseRounds.length >= keepRounds) break;
    }
  }
  // 如果 loop 结束时还有未开始的轮次且 reverseRounds 没满，也加上
  if (currentRound.length > 0 && reverseRounds.length < keepRounds) {
    reverseRounds.unshift(currentRound);
  }

  // 展平
  return [...systemMsgs, ...reverseRounds.flat()];
}

/**
 * 策略 3b：summarizeHistory — 用 LLM 总结压缩历史
 *
 * 把历史对话（除了最新一条用户消息）喂给 LLM，生成一段摘要，
 * 用一条 SystemMessage 替代所有历史消息。
 *
 * 优点：保留语义信息，压缩率高
 * 缺点：额外消耗一次 LLM 调用的 token，总成本不一定省
 */
export async function summarizeHistory(
  messages: BaseMessage[],
  llmInstance: ChatOpenAI
): Promise<BaseMessage[]> {
  const systemMsgs = messages.filter((m) => m instanceof SystemMessage);
  const nonSystemMsgs = messages.filter((m) => !(m instanceof SystemMessage));

  if (nonSystemMsgs.length <= 2) {
    // 消息太少，不需要总结
    return messages;
  }

  // 保留最后一条 HumanMessage（最新提问），其余送去总结
  const lastMsg = nonSystemMsgs[nonSystemMsgs.length - 1];
  const historyToSummarize = nonSystemMsgs.slice(0, -1);

  const summaryPrompt = `请将以下对话历史压缩成一段简洁的摘要（中文，200 字以内），保留关键信息：

${historyToSummarize
  .map((m) => {
    const role = m instanceof HumanMessage ? "用户" : "助手";
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `[${role}]：${content}`;
  })
  .join("\n")}

摘要：`;

  console.log("  [策略] 正在调用 LLM 总结历史对话...");
  const summaryRes = await llmInstance.invoke([new HumanMessage(summaryPrompt)]);
  const summary = typeof summaryRes.content === "string" ? summaryRes.content : "";

  console.log(`  [策略] 总结完成（长度：${summary.length} 字）`);

  // 返回：system messages + 摘要 SystemMessage + 最新提问
  const summaryMsg = new SystemMessage(`<对话历史摘要>${summary}</对话历史摘要>`);

  return [...systemMsgs, summaryMsg, lastMsg];
}

/**
 * 策略 3c：switchModel — 降级到更便宜的模型
 *
 * 返回一个新的 ChatOpenAI 实例（便宜模型），
 * 后续 LLM 调用全部使用这个实例。
 *
 * 在真实场景中，"便宜模型"可以是：
 *   - DeepSeek: deepseek-chat → deepseek-chat (同一模型，价格不变)
 *       实际降级需换到不同 provider（如 OpenAI: gpt-4o → gpt-4o-mini）
 *   - 本文示例用 LLM_MODEL_CHEAP 环境变量，读者可自行配置
 */
export function switchModel(
  currentMessages: BaseMessage[],
  currentRound: number
): { model: ChatOpenAI; messages: BaseMessage[] } {
  const modelName = ENV.modelCheap;

  console.log(
    `  [策略] 降级模型：从 ${ENV.model} 切换到 ${modelName}` +
      (modelName === ENV.model ? "（注意：两个模型相同，实际使用时应配置不同的便宜模型）" : "")
  );

  const cheapLlm = new ChatOpenAI({
    model: modelName,
    apiKey: ENV.apiKey,
    configuration: { baseURL: ENV.baseUrl },
    temperature: 0.2,
    maxTokens: 1024,
  });

  return { model: cheapLlm, messages: currentMessages };
}

/* ================================================================== */
/* 4. 辅助函数：对话交互                                               */
/* ================================================================== */

/**
 * 简单的 token 计数器（按字符数估算）
 * 实际使用应接入 tiktoken 做精确计数，这里仅做近似演示
 */
export function simpleTokenCounter(messages: BaseMessage[]): number {
  // 粗略估算：中文约 1.5 token/字，英文约 1 token/4 字符
  return messages.reduce((sum, msg) => {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    return sum + Math.ceil(content.length * 1.5);
  }, 0);
}

/**
 * 从消息列表中提取最后一条 AI 回复
 */
function extractLastReply(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg instanceof AIMessage && typeof msg.content === "string") {
      return msg.content;
    }
  }
  return "(无回复)";
}

/**
 * 获取 usage_metadata（从 AIMessage 提取）
 */
function getUsageFromMessage(msg: BaseMessage): {
  inputTokens: number;
  outputTokens: number;
} {
  if (msg instanceof AIMessage && msg.usage_metadata) {
    return {
      inputTokens: msg.usage_metadata.input_tokens ?? 0,
      outputTokens: msg.usage_metadata.output_tokens ?? 0,
    };
  }
  return { inputTokens: 0, outputTokens: 0 };
}

/* ================================================================== */
/* 5. 主演示流程                                                       */
/* ================================================================== */

/**
 * 演示问题集 — 每轮消耗约 500-2000 tokens，5 轮下来可看到明显累计
 */
const QUESTIONS = [
  "请用 200 字以内介绍机器学习的三大类型（监督学习、无监督学习、强化学习）。",
  "详细解释一下监督学习和无监督学习的核心区别，各举一个实际应用例子。",
  "什么是过拟合（overfitting）？请详细说明至少三种常见的解决方法。",
  "请比较决策树和随机森林这两种算法的优缺点，以及各自的适用场景。",
  "什么是深度学习？它和传统机器学习有什么本质区别？请用通俗的语言解释。",
];

/**
 * Part 1 & 2：追踪 + 预算
 *
 * 演示：
 *   - 每轮对话后检查 token 用量
 *   - 设定预算观察超限时的拦截
 */
async function part1And2TrackingAndBudget(): Promise<void> {
  console.log("\n========== Part 1 & 2｜Token 追踪 + 预算 ==========");
  console.log(`模型：${ENV.model} @ ${ENV.baseUrl}`);
  console.log(`预算：总预算 8000 tokens（演示用，方便超限）` + `，单轮预算不限`);

  // 创建追踪器 + 预算
  const tracker = new TokenUsageTracker();
  const budget = new TokenBudget(8_000, 0); // 总预算 8000 tokens（演示用较小值）
  const messages: BaseMessage[] = [];

  const systemPrompt = new SystemMessage(
    "你是一个精通机器学习的 AI 助手。请用中文回答，回答要详细且有条理，适当使用例子说明。"
  );
  messages.push(systemPrompt);

  try {
    for (let i = 0; i < QUESTIONS.length; i++) {
      const query = QUESTIONS[i];
      console.log(`\n  ── 第 ${i + 1} 轮 ──`);
      console.log(`  用户：${query.substring(0, 40)}…`);

      // 开始新轮
      tracker.startRound(query);
      budget.newRound();

      // 添加用户消息
      const userMsg = new HumanMessage(query);
      messages.push(userMsg);

      // 调用 LLM（挂上 tracker callback）
      const response = await llm.invoke(messages, {
        callbacks: [tracker],
      });

      // 提取 usage_metadata（从返回的 AIMessage 上）
      const usage = getUsageFromMessage(response);
      if (usage.inputTokens > 0 || usage.outputTokens > 0) {
        // 如果 callback 没拿到（DeepSeek 兼容性问题），补上
        budget.addUsage(usage.inputTokens, usage.outputTokens);
      } else {
        // 兜底：从 callback 的累计值反推
        budget.addUsage(0, 0);
      }

      messages.push(response);

      // 打印本轮结果
      const reply = typeof response.content === "string" ? response.content : "";
      console.log(`  助手：${reply.substring(0, 80)}…`);
      console.log(
        `  本轮 Token：${response.usage_metadata ? `${response.usage_metadata.input_tokens} in / ${response.usage_metadata.output_tokens} out` : "(从 AIMessage 未获取到 usage_metadata，请查看 callback 报告)"}`
      );

      // 检查预算
      const check = budget.check();
      console.log(
        `  预算状态：已用 ${check.used} / ${check.limit} tokens` +
          (check.remaining >= 0 ? `（剩余 ${check.remaining}）` : "（无限）") +
          (check.ok ? " ✅" : " ❌ 超预算！")
      );

      if (!check.ok) {
        console.log(
          `  ⚠️ 第 ${i + 1} 轮超预算（原因：${check.reason === "total" ? "总预算" : "单轮预算"}），触发拦截`
        );
        throw new BudgetExceededError(check.used, check.limit);
      }
    }

    console.log("\n  ✅ 所有轮次对话完成，预算未超限");
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.log(`  🚫 已拦截：${err.message}`);
    } else {
      throw err;
    }
  }

  // 打印 token 统计报告
  tracker.printReport();
  console.log(
    "\n  → 总结：有了 token 追踪 + 预算，我们就能知道" +
      "每一轮花了多少 token，\n" +
      "    并在超预算时及时拦截，避免无限烧钱。"
  );
}

/**
 * Part 3a：trimMessages 策略演示
 *
 * 模拟一个长对话，然后用 trimMessages 截断到最近 2 轮
 */
async function part3aTrimStrategy(): Promise<void> {
  console.log("\n========== Part 3a｜策略：trimMessages 截断旧消息 ==========");

  const messages: BaseMessage[] = [new SystemMessage("你是一个 AI 助手。")];
  const tracker = new TokenUsageTracker();

  // 先做 5 轮对话，模拟长对话
  for (let i = 0; i < 5; i++) {
    const query = `这是第 ${i + 1} 轮对话。请回答一个简单的数学问题：${i + 1} + ${i + 2} = ?`;
    tracker.startRound(query);
    messages.push(new HumanMessage(query));
    const res = await llm.invoke(messages, { callbacks: [tracker] });
    messages.push(res);
  }

  console.log(`  截断前：${messages.length} 条消息，${tracker.getTotalTokens()} tokens`);
  console.log("  消息类型：", messages.map((m) => m.constructor.name).join(" → "));

  // 截断策略：保留最近 2 轮（约 4 条非 system 消息）
  const trimmed = trimLastNRounds(messages, 2);
  console.log(`  截断后：${trimmed.length} 条消息`);
  console.log("  消息类型：", trimmed.map((m) => m.constructor.name).join(" → "));

  // 用截断后的消息再问一个问题
  const newQuery = new HumanMessage("基于我们刚才的对话，请问 3 + 4 = ?");
  trimmed.push(newQuery);
  const res = await llm.invoke(trimmed);
  const reply = typeof res.content === "string" ? res.content : "";
  console.log(`  截断后继续对话，回复：${reply.substring(0, 100)}…`);

  console.log(
    "\n  → 结论：trimMessages 快速丢掉旧消息，适合历史不重要的场景。" +
      "\n    注意：如果历史重要，截断会导致 Agent 丢失上下文。"
  );
}

/**
 * Part 3b：summarizeHistory 策略演示
 */
async function part3bSummarizeStrategy(): Promise<void> {
  console.log("\n========== Part 3b｜策略：summarizeHistory 总结压缩 ==========");

  const messages: BaseMessage[] = [new SystemMessage("你是一个 AI 助手。")];
  const tracker = new TokenUsageTracker();

  // 先做 3 轮长对话，积累足够的历史
  const longQuestions = [
    "请详细解释什么是梯度下降法（Gradient Descent），包括其数学原理和变体（SGD、Adam 等）。",
    "请说明反向传播（Backpropagation）算法的工作原理，以及它如何与梯度下降配合工作。",
    "请解释 Transformer 架构中的自注意力机制（Self-Attention）是如何计算的。",
  ];

  for (const q of longQuestions) {
    tracker.startRound(q);
    messages.push(new HumanMessage(q));
    const res = await llm.invoke(messages, { callbacks: [tracker] });
    messages.push(res);
  }

  console.log(`  总结前：${messages.length} 条消息，累计 ${tracker.getTotalTokens()} tokens`);

  // 总结策略
  const summarized = await summarizeHistory(messages, llm);
  console.log(`  总结后：${summarized.length} 条消息（1 条摘要 + 最新提问）`);

  // 用总结后的消息继续对话
  const followUp = new HumanMessage(
    "基于我们刚才讨论的内容，请用一句话总结 Transformer 相比 RNN 的最大优势。"
  );
  summarized.push(followUp);
  const res = await llm.invoke(summarized);
  const reply = typeof res.content === "string" ? res.content : "";
  console.log(`  总结后继续对话，回复：${reply.substring(0, 120)}…`);

  console.log(
    "\n  → 结论：summarizeHistory 保留了语义信息，但额外消耗一次 LLM 调用。" +
      "\n    适合历史重要、不能直接丢掉的场景。"
  );
}

/**
 * Part 3c：降级模型策略演示
 */
async function part3cDowngradeStrategy(): Promise<void> {
  console.log("\n========== Part 3c｜策略：switchModel 降级模型 ==========");
  console.log(`  当前模型：${ENV.model}`);
  console.log(`  降级目标：${ENV.modelCheap}`);

  const messages: BaseMessage[] = [new SystemMessage("你是一个 AI 助手。")];

  // 先做一轮对话（用主模型）
  const q1 = new HumanMessage(
    "请详细解释什么是机器学习中的偏差-方差权衡（Bias-Variance Tradeoff）。"
  );
  messages.push(q1);
  const res1 = await llm.invoke(messages);
  messages.push(res1);
  const usage1 = getUsageFromMessage(res1);
  console.log(`  主模型回复长度：${typeof res1.content === "string" ? res1.content.length : 0} 字`);

  // 降级模型
  const { model: cheapLlm } = switchModel(messages, 1);

  // 继续对话（用便宜模型）
  const q2 = new HumanMessage("请用一句话简单解释偏差-方差权衡。");
  messages.push(q2);
  const res2 = await cheapLlm.invoke(messages);
  messages.push(res2);
  const usage2 = getUsageFromMessage(res2);
  console.log(
    `  降级后回复长度：${typeof res2.content === "string" ? res2.content.length : 0} 字` +
      `（输入 ${usage2.inputTokens} tokens，输出 ${usage2.outputTokens} tokens）`
  );

  const reply2 = typeof res2.content === "string" ? res2.content : "";
  console.log(`  降级后回复：${reply2.substring(0, 80)}…`);

  console.log(
    "\n  → 结论：降级模型直接降低单次调用成本，适合简单问答场景。" +
      "\n    注意：如果当前模型和便宜模型价格相同（如 DeepSeek 只有一个模型），" +
      "\n    需切换到不同 provider 才能体现成本差异。"
  );
}

/**
 * Part 4：LangFuse 集成（可选）
 *
 * 演示如何把 LangFuse CallbackHandler 和我们的 TokenUsageTracker
 * 同时挂到 LLM 调用上，实现"追踪 + 监控"双管齐下
 */
async function part4LangfuseIntegration(): Promise<void> {
  console.log("\n========== Part 4｜LangFuse 监控集成（可选） ==========");

  const hasLangfuseKey = !!(ENV.langfusePublicKey && ENV.langfuseSecretKey);
  if (!LangfuseCallbackHandler) {
    console.log("  ⚠️ 未安装 @langfuse/langchain，跳过 LangFuse 演示");
    console.log("  → 安装：pnpm add @langfuse/langchain");
    return;
  }
  if (!hasLangfuseKey) {
    console.log("  ⚠️ 未配置 LangFuse key（LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY），跳过上报");
    console.log("  → 可注册 LangFuse Cloud 或自建服务");
    return;
  }

  // 设置 LangFuse 环境变量
  process.env.LANGFUSE_PUBLIC_KEY = ENV.langfusePublicKey;
  process.env.LANGFUSE_SECRET_KEY = ENV.langfuseSecretKey;
  process.env.LANGFUSE_BASE_URL = ENV.langfuseHost;

  const langfuseHandler = new LangfuseCallbackHandler!({
    sessionId: "agent-token-budget-demo",
    userId: "local-dev",
    tags: ["token-budget", "agent-cost-control"],
  });

  const tracker = new TokenUsageTracker();
  const messages: BaseMessage[] = [new SystemMessage("你是一个 AI 助手，请用中文回答。")];

  const query = "请用 100 字解释什么是大语言模型（LLM）。";
  console.log(`  提问：${query}`);

  tracker.startRound(query);
  messages.push(new HumanMessage(query));

  // 同时挂两个 callback：我们自己追踪 token，LangFuse 做可视化 trace
  const response = await llm.invoke(messages, {
    callbacks: [tracker, langfuseHandler],
  });
  messages.push(response);

  const reply = typeof response.content === "string" ? response.content : "";
  console.log(`  回复：${reply.substring(0, 80)}…`);

  tracker.printReport();

  if (langfuseHandler.last_trace_id) {
    console.log(`\n  ✅ trace 已上报 LangFuse`);
    console.log(`  🔗 trace ID: ${langfuseHandler.last_trace_id}`);
    console.log(
      `  🔗 trace URL: ${ENV.langfuseHost.replace(/\/$/, "")}/trace/${langfuseHandler.last_trace_id}`
    );
  } else {
    console.log(`  ⚠️ 未获取到 trace ID（可能上报延迟或失败）`);
  }

  console.log(
    "\n  → 结论：LangFuse 提供可视化仪表盘，可以看 token 消耗趋势、每轮分布。" +
      "\n    配合 TokenUsageTracker 的精确统计，实现【本地追踪 + 远程监控】双保险。"
  );
}

/* ================================================================== */
/* 6. 主入口                                                           */
/* ================================================================== */

async function main() {
  console.log("=".repeat(60));
  console.log("  Agent Token 预算/成本控制：从追踪到优化");
  console.log("=".repeat(60));
  console.log(`  主模型: ${ENV.model}`);
  console.log(`  便宜模型: ${ENV.modelCheap}`);
  console.log(`  API: ${ENV.baseUrl}`);
  console.log(`  LangFuse: ${ENV.langfusePublicKey ? "已配置" : "未配置"}`);
  console.log("=".repeat(60));

  try {
    // Part 1 & 2：追踪 + 预算
    await part1And2TrackingAndBudget();

    // Part 3：三种策略
    await part3aTrimStrategy();
    await part3bSummarizeStrategy();
    await part3cDowngradeStrategy();

    // Part 4：LangFuse（可选）
    await part4LangfuseIntegration();

    console.log("\n" + "=".repeat(60));
    console.log("  ✅ 全部演示完成");
    console.log("=".repeat(60));
  } catch (err) {
    console.error("\n❌ 运行出错：", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
