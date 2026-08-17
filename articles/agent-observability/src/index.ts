/**
 * Agent 可观测性：无观测 vs 有观测（Langfuse Trace）
 * ==================================================================
 * 文章：《Agent 内部到底在干什么？怎么观测和评估它？》
 *
 * 渐进式演示（同一个 LangGraph agent 跑两遍）：
 *   Part 1「痛点」：不接任何可观测性，只能 console.log 手动追踪
 *     → 只能看到最终回复 + 自己埋的日志；看不到每次 LLM 调用的
 *       prompt/completion、工具入参出参、各节点耗时、token 用量
 *   Part 2「主角」：接 Langfuse，同一套 agent 代码零改动（只是
 *     invoke 时多挂一个 CallbackHandler），跑完打印 trace URL
 *     → 完整链路：agent 节点 → LLM 调用 → 工具选择 → 工具执行 →
 *       结果回填 → 最终生成，全部带时间、输入输出、token 统计
 *
 * 环境变量（仓库根目录 .env）：
 *   LLM_API_KEY                必填：DeepSeek key（本文示例）
 *   LLM_BASE_URL               可选，默认 https://api.deepseek.com
 *   LLM_MODEL                  可选，默认 deepseek-chat
 *   LANGFUSE_PUBLIC_KEY        可选：Langfuse 公钥（cloud 或自建）
 *   LANGFUSE_SECRET_KEY        可选：Langfuse 私钥
 *   LANGFUSE_HOST              可选：Langfuse 地址，默认 https://cloud.langfuse.com
 *   没有 Langfuse key 时：跳过上报，仅用 LangChain 内置的
 *   ConsoleCallbackHandler 在本地打印同样的 trace 结构
 *
 * 运行：pnpm run run:agent-observability
 */

import "dotenv/config";
import * as dotenv from "dotenv";
import * as path from "node:path";
import { z } from "zod";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { ConsoleCallbackHandler } from "@langchain/core/tracers/console";
import type { BaseMessage, AIMessage } from "@langchain/core/messages";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
// Langfuse 的 LangGraph/LangChain 集成（CallbackHandler 挂到 invoke 上即可）
import { CallbackHandler } from "@langfuse/langchain";
// Langfuse 的 OTEL span 导出器（v5 SDK 用 span processor 把 trace 上报到 Langfuse）
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

// 加载仓库根目录的 .env（LLM + Langfuse 配置都在那里）
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// 短生命周期脚本：关掉 LangChain 后台 callback，确保 flush 前把 trace 写完
process.env.LANGCHAIN_CALLBACKS_BACKGROUND = "false";

/* ------------------------------------------------------------------ */
/* 0. 配置：LLM（DeepSeek）+ Langfuse                                  */
/* ------------------------------------------------------------------ */

const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
const LLM_MODEL = process.env.LLM_MODEL ?? "deepseek-chat";

const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY ?? "";
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY ?? "";
const LANGFUSE_HOST = process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";

const llm = new ChatOpenAI({
  model: LLM_MODEL,
  apiKey: LLM_API_KEY,
  configuration: { baseURL: LLM_BASE_URL },
  temperature: 0.2,
  maxTokens: 1024,
});

/* ------------------------------------------------------------------ */
/* 1. 工具：查天气 + 计算器（模拟数据，跑通链路即可）                   */
/* ------------------------------------------------------------------ */

const getWeather = tool(
  async ({ city }) => {
    const data: Record<string, string> = {
      shanghai: "31°C，闷热多云",
      tokyo: "28°C，晴",
      beijing: "33°C，晴热",
    };
    return data[city.trim().toLowerCase()] ?? `暂无 ${city} 的天气数据`;
  },
  {
    name: "get_weather",
    description: "查询城市天气（模拟数据）",
    schema: z.object({
      city: z.string().describe("城市英文名，如 Shanghai"),
    }),
  }
);

const calculate = tool(async ({ a, b }) => String(a + b), {
  name: "calculate",
  description: "两个数相加",
  schema: z.object({
    a: z.number(),
    b: z.number(),
  }),
});

const tools = [getWeather, calculate];
const toolNode = new ToolNode(tools);
// 绑定一次工具，agent 节点复用同一个 runnable
const llmWithTools = llm.bindTools(tools);

/* ------------------------------------------------------------------ */
/* 2. Agent：一个标准的 ReAct 小图（LLM 节点 + 工具节点循环）           */
/* ------------------------------------------------------------------ */

const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
});

const SYSTEM_PROMPT = new SystemMessage(
  "你是助手。查天气用 get_weather，加法用 calculate。用简体中文回答，保持简洁。"
);

/**
 * agent 节点：LLM 决定是直接回答，还是调用工具。
 * ⚠️ 痛点 1：这里发生了什么，外部完全看不到——模型到底"想"了什么、
 *    为什么选这个工具、传了什么参数，只能靠下面这行 console.log 猜。
 */
async function agentNode(state: typeof AgentState.State) {
  const res = await llmWithTools.invoke([SYSTEM_PROMPT, ...state.messages]);
  // ⚠️ 痛点 2：手动打日志 = 事后考古。没有统一的 trace，日志格式各写各的，
  //    没有时间戳、没有耗时、没有 token 数，线上排障时根本拼不出完整链路。
  console.log(
    `  [console.log 手动追踪] agent 节点返回：` +
      (res.tool_calls?.length
        ? `要调用工具 ${res.tool_calls.map((tc) => tc.name).join(", ")}`
        : `直接回答（无工具调用）`)
  );
  return { messages: [res] };
}

/** agent 节点之后路由：有工具调用 → 进 tools；否则结束 */
function routeAfterAgent(state: typeof AgentState.State): "tools" | typeof END {
  const last = state.messages[state.messages.length - 1] as AIMessage;
  return last.tool_calls && last.tool_calls.length > 0 ? "tools" : END;
}

/** 构建 agent 图（Part 1 / Part 2 用同一个图，唯一差别是 invoke 时挂不挂观测 handler） */
function buildAgent() {
  return new StateGraph(AgentState)
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent)
    .addEdge("tools", "agent")
    .compile();
}

/** 从结果里取出最终回复文本 */
function extractReply(result: { messages: BaseMessage[] }): string {
  const last = result.messages[result.messages.length - 1];
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .map((part) => (typeof part === "string" ? part : ((part as { text?: string }).text ?? "")))
      .join("");
  }
  return String(last.content ?? "");
}

const QUERY = "查一下 Shanghai 的天气，然后用计算器把 31 和 28 相加，最后总结。";

/* ------------------------------------------------------------------ */
/* 3. Part 1：没有可观测性 —— 只能 console.log                         */
/* ------------------------------------------------------------------ */

async function part1WithoutObservability() {
  console.log("\n========== Part 1｜痛点：没接可观测性，只能 console.log ==========");
  const agent = buildAgent();
  const startedAt = Date.now();

  const result = await agent.invoke({ messages: [new HumanMessage(QUERY)] });

  // ⚠️ 痛点 3：整条链路的"总耗时"都得自己掐表；每一跳花了多久、
  //    哪次 LLM 调用慢、token 花了多少，全部不可见。
  console.log(`  [console.log 手动追踪] 总耗时 ${Date.now() - startedAt}ms`);
  console.log("\n  最终回复：");
  console.log(`  ${extractReply(result)}`);

  // ⚠️ 痛点 4：想复盘中间过程，只能手动翻 messages 列表"考古"，
  //    而且看不到 prompt 原文、看不到工具返回被模型怎么消化。
  console.log("\n  （复盘过程只能翻 messages：）");
  result.messages.forEach((m, i) => {
    const role = m.constructor.name;
    const brief =
      role === "AIMessage" && (m as AIMessage).tool_calls?.length
        ? `工具调用 → ${(m as AIMessage).tool_calls!.map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`).join(", ")}`
        : typeof m.content === "string"
          ? m.content.slice(0, 60) + (m.content.length > 60 ? "…" : "")
          : "(结构化内容)";
    console.log(`    [${i}] ${role}: ${brief}`);
  });
  console.log(
    "\n  → 结论：能跑，但一旦出错（选错工具/参数传错/死循环），\n" +
      "    你只有最终答案和几行自己写的日志，等于盲人摸象。"
  );
}

/* ------------------------------------------------------------------ */
/* 4. Part 2：接入 Langfuse —— 同一套 agent，多挂一个 CallbackHandler  */
/* ------------------------------------------------------------------ */

/**
 * 初始化 Langfuse 观测（v5 SDK：OTEL span processor + 全局 tracer provider）。
 * 返回 true 表示成功接入；false 表示没配 key 或初始化失败（上层降级）。
 */
function setupLangfuse(): { ready: boolean; provider: NodeTracerProvider | null } {
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) return { ready: false, provider: null };
  try {
    // 让 SDK 从环境变量读到 key（CallbackHandler 和 span processor 都认）
    process.env.LANGFUSE_PUBLIC_KEY = LANGFUSE_PUBLIC_KEY;
    process.env.LANGFUSE_SECRET_KEY = LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_BASE_URL = LANGFUSE_HOST;
    // exportMode: "immediate" → span 结束立刻导出，适合短脚本
    const provider = new NodeTracerProvider({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: LANGFUSE_PUBLIC_KEY,
          secretKey: LANGFUSE_SECRET_KEY,
          baseUrl: LANGFUSE_HOST,
          exportMode: "immediate",
        }),
      ],
    });
    provider.register();
    return { ready: true, provider };
  } catch (err) {
    console.error("  ⚠️ Langfuse 初始化报错：", (err as Error).message);
    return { ready: false, provider: null };
  }
}

async function part2WithObservability() {
  console.log("\n========== Part 2｜主角：接入 Langfuse，同一套 agent 跑一遍 ==========");

  const langfuseSetup = setupLangfuse();
  const langfuseReady = langfuseSetup.ready;

  if (!langfuseReady) {
    // 没有 key：明确提示 + 优雅降级，用 LangChain 内置 ConsoleCallbackHandler
    // 在本地打印"同一份 trace 结构"（Chain/LLM/Tool 事件树）
    console.log(
      "  ⚠️ 未配置 Langfuse key（LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY），跳过上报，仅演示本地追踪结构"
    );
    console.log(
      "  → 降级方案：用 LangChain 内置 ConsoleCallbackHandler 打印本次调用的 trace 事件树：\n"
    );
  }

  const agent = buildAgent();

  // Langfuse CallbackHandler（挂到 invoke 的 callbacks 上，LLM/工具/节点全进 trace）
  // 注意：老版本 SDK 的写法是 new CallbackHandler({ publicKey, secretKey, baseUrl })，
  // v5 SDK 改为 key 走环境变量 + span processor 导出，这里两者都兼容（见 setupLangfuse）。
  const langfuseHandler = new CallbackHandler({
    sessionId: "agent-observability-demo",
    userId: "local-dev",
    tags: ["agent-observability"],
  });

  // 有 key 用 Langfuse handler；没 key 用 Console handler 演示同样的结构
  const handler = langfuseReady ? langfuseHandler : new ConsoleCallbackHandler();

  const startedAt = Date.now();
  const result = await agent.invoke(
    { messages: [new HumanMessage(QUERY)] },
    { callbacks: [handler], recursionLimit: 10 }
  );
  const elapsed = Date.now() - startedAt;

  console.log(`\n  最终回复：`);
  console.log(`  ${extractReply(result)}`);

  if (langfuseReady && langfuseHandler.last_trace_id) {
    // 真实上报成功：打印 trace URL（cloud.langfuse.com/project/.../traces/xxx）
    console.log(`\n  ✅ trace 已上报 Langfuse，trace id: ${langfuseHandler.last_trace_id}`);
    console.log(
      `  🔗 trace URL: ${LANGFUSE_HOST.replace(/\/$/, "")}/trace/${langfuseHandler.last_trace_id}`
    );
  } else if (!langfuseReady) {
    console.log(
      `\n  （以上事件树即 trace 的本地形态；配好 Langfuse key 后，这里会打印真实 trace URL）`
    );
    console.log(`  [本地对照] 本次调用总耗时 ${elapsed}ms`);
  } else {
    console.log(`  ⚠️ 没拿到 trace id（可能上报失败），本次耗时 ${elapsed}ms`);
  }

  // 短脚本收尾：显式 flush，确保 span 全部导出后再退出
  if (langfuseReady && langfuseSetup.provider) {
    try {
      await langfuseSetup.provider.forceFlush();
    } catch (err) {
      // 假 key / 网络不通时这里会报错：如实打出来，不影响演示流程
      console.error(
        `  ⚠️ Langfuse flush 失败（key 无效或网络不通，trace 未真正落库）：${(err as Error)?.message ?? String(err)}`
      );
    }
  }

  console.log(
    "\n  → 结论：trace 能回答三个 console.log 回答不了的问题——\n" +
      "    ① 模型到底选了哪个工具、传了什么参数（工具调用的入参出参）\n" +
      "    ② 每一步花了多久（哪个节点是瓶颈）\n" +
      "    ③ 每次 LLM 调用花了多少 token（成本可量化）"
  );
}

/* ------------------------------------------------------------------ */
/* 5. 主入口                                                           */
/* ------------------------------------------------------------------ */

async function main() {
  if (!LLM_API_KEY) {
    console.error("❌ 缺少 LLM_API_KEY，请在仓库根目录 .env 里配置（DeepSeek key）");
    process.exit(1);
  }
  console.log(`模型：${LLM_MODEL} @ ${LLM_BASE_URL}`);
  console.log(
    `Langfuse：${LANGFUSE_PUBLIC_KEY ? "已配置 key" : "未配置（将降级为本地 console trace）"} @ ${LANGFUSE_HOST}`
  );

  try {
    await part1WithoutObservability();
    await part2WithObservability();
    console.log("\n========== 全部演示完成 ==========");
  } catch (err) {
    console.error("\n❌ 运行出错：", (err as Error).message);
    process.exit(1);
  }
}

main();
