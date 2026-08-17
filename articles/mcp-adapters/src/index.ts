/**
 * MCP 标准化工具接入完整链路演示（Host / Agent 侧）
 * ------------------------------------------------------------------
 * 演示问题：Agent 接入工具为什么要标准化？MCP 解决了什么痛点？
 *
 * 完整链路（真实运行，不 mock）：
 *
 *   LangGraph Agent (createReactAgent)
 *        │  LLM 决定调用工具（tools/call，经 @langchain/mcp-adapters 转换）
 *        ▼
 *   MultiServerMCPClient（@langchain/mcp-adapters）
 *        │  stdio transport 拉起并连接子进程
 *        ▼
 *   MCP Server（src/mcp-server.ts，@modelcontextprotocol/sdk）
 *        ├─ get_weather : 查询天气（返回 JSON）
 *        └─ calculate   : 安全表达式求值（返回 JSON）
 *
 * 标准化的体现（对照文章的「痛点」）：
 *   1. 工具发现：host 不需要写死工具清单，initialize 握手后 tools/list 动态发现
 *   2. 调用统一：LLM 只需要会 tools/call 一种语义，就能调所有 server 的工具
 *   3. 可替换：换一个天气服务商 = 换一个 MCP server，Agent 代码零改动
 *
 * 运行：cd /Users/huzhiwu/workspace/ai-agent-code-examples && pnpm run run:mcp-adapters
 * 依赖：根目录 .env 提供 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL（默认 DeepSeek 官方）
 */

import * as dotenv from "dotenv";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/* ------------------------------------------------------------------ */
/* 0. LLM 配置：优先根目录 .env；没有则从 ~/.zshrc 兜底并生成 .env       */
/*    注意：绝不把完整 key 打印到输出                                    */
/* ------------------------------------------------------------------ */

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

function ensureEnv(): void {
  const envFile = path.join(REPO_ROOT, ".env");
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
    return;
  }
  // 兜底：从 ~/.zshrc 里找 DEEPSEEK_API_KEY / LLM_API_KEY
  const zshrc = path.join(os.homedir(), ".zshrc");
  let apiKey = process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
  if (!apiKey && fs.existsSync(zshrc)) {
    const content = fs.readFileSync(zshrc, "utf-8");
    const match =
      content.match(/^export\s+(?:DEEPSEEK_API_KEY|LLM_API_KEY)=["']?([^"'\s]+)/m) ??
      content.match(/\b(?:DEEPSEEK_API_KEY|LLM_API_KEY)=["']?([^"'\s]+)/);
    if (match) apiKey = match[1];
  }
  if (!apiKey) {
    throw new Error(
      "未找到 LLM API Key：请先在仓库根目录创建 .env（LLM_API_KEY=sk-...），" +
        "或在 ~/.zshrc 里 export DEEPSEEK_API_KEY/LLM_API_KEY"
    );
  }
  const envContent = [
    `LLM_API_KEY=${apiKey}`,
    `LLM_BASE_URL=https://api.deepseek.com`,
    `LLM_MODEL=deepseek-chat`,
    "",
  ].join("\n");
  fs.writeFileSync(envFile, envContent, { mode: 0o600 });
  dotenv.config({ path: envFile });
  console.log(`ℹ️  根目录无 .env，已从 ~/.zshrc 生成（key 已写入 ${envFile}，不外显）`);
}

// 必须在读取 MODEL/BASE_URL/API_KEY 之前注入 .env（顶层求值顺序）
ensureEnv();

const MODEL = process.env.LLM_MODEL ?? "deepseek-chat";
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
const API_KEY = process.env.LLM_API_KEY ?? "";

/* ------------------------------------------------------------------ */
/* 1. 拉起本地 MCP stdio server，并做协议握手 + tools/list 工具发现      */
/* ------------------------------------------------------------------ */

const MCP_SERVER_SCRIPT = path.resolve(__dirname, "mcp-server.ts");
const ARTICLE_DIR = path.resolve(__dirname, "..");

async function setupMcpClient() {
  console.log("=".repeat(72));
  console.log("阶段 1/4：启动本地 MCP server（stdio transport，子进程）");
  console.log("=".repeat(72));
  console.log(`  命令: ${process.execPath} --import tsx ${MCP_SERVER_SCRIPT}`);

  const client = new MultiServerMCPClient({
    "weather-calc": {
      transport: "stdio",
      command: process.execPath,
      args: ["--import", "tsx", MCP_SERVER_SCRIPT],
      cwd: ARTICLE_DIR,
      // 生产上这里可以只透传白名单；演示直接透传全部环境变量
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined)
      ) as Record<string, string>,
    },
  });

  // initialize 握手 + tools/list：host 无需写死工具清单，动态发现
  const perServer = await client.initializeConnections();
  const tools = perServer["weather-calc"] ?? [];

  console.log("\n  握手完成，tools/list 发现的工具：");
  for (const tool of tools) {
    const shape = (tool.schema as { shape?: unknown }).shape;
    const keys =
      typeof shape === "function" ? Object.keys(shape()) : Object.keys((shape as object) ?? {});
    const desc = tool.description.split("\n")[0];
    console.log(`    ✅ ${tool.name} — ${desc}`);
    console.log(`       参数: ${keys.join(", ") || "(无)"}`);
  }
  return { client, tools };
}

/* ------------------------------------------------------------------ */
/* 2. 组装 LangGraph React Agent（LLM + MCP 转出来的 LangChain 工具）   */
/* ------------------------------------------------------------------ */

function buildAgent(tools: Awaited<ReturnType<typeof setupMcpClient>>["tools"]) {
  const llm = new ChatOpenAI({
    model: MODEL,
    apiKey: API_KEY,
    configuration: { baseURL: BASE_URL },
    temperature: 0.1,
    maxTokens: 1024,
  });

  return createReactAgent({
    llm,
    tools,
    prompt:
      "你是「MCP 标准化工具接入」演示 Agent，通过 MCP 协议接入了两个工具：\n" +
      "  - get_weather：查询城市天气（必须用它回答天气问题，不要编造）\n" +
      "  - calculate：数学计算（计算类问题必须调用它，不要自己心算）\n" +
      "规则：用户问题需要工具时，先调用工具，再基于工具返回的 JSON 作答；" +
      "回答用中文，简洁，并点明数据来源。",
  });
}

/* ------------------------------------------------------------------ */
/* 3. 跑一轮对话：观察 Agent 如何通过 MCP 完成真实工具调用               */
/* ------------------------------------------------------------------ */

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(截断)` : text;
}

function messageContent(msg: { content: unknown }): string {
  return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
}

async function runTask(agent: ReturnType<typeof buildAgent>, label: string, question: string) {
  console.log(`\n${"-".repeat(72)}`);
  console.log(`阶段 3/4：${label}`);
  console.log(`${"-".repeat(72)}`);
  console.log(`  用户: ${question}\n`);

  const stream = await agent.stream(
    { messages: [new HumanMessage(question)] },
    { streamMode: "values", recursionLimit: 10 }
  );

  for await (const step of stream) {
    const last = step.messages[step.messages.length - 1];
    if (last instanceof ToolMessage) {
      console.log(`  🔧 工具 ${last.name} 返回:`);
      console.log(`     ${truncate(messageContent(last), 420)}`);
    } else if (last instanceof AIMessage && last.tool_calls && last.tool_calls.length > 0) {
      for (const tc of last.tool_calls) {
        console.log(`  🤖 Agent 决定调用工具: ${tc.name}(${JSON.stringify(tc.args)})`);
      }
    } else if (last instanceof AIMessage && last.content) {
      console.log(`  💬 Agent 回答: ${messageContent(last)}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. 主流程                                                           */
/* ------------------------------------------------------------------ */

async function main() {
  ensureEnv();
  if (!API_KEY) {
    throw new Error("LLM_API_KEY 为空，无法调用真实 LLM（本示例不 mock）");
  }
  console.log(`  使用 LLM: ${MODEL} @ ${BASE_URL}（key: ${maskKey(API_KEY)}）\n`);

  const { client, tools } = await setupMcpClient();

  console.log("\n" + "=".repeat(72));
  console.log("阶段 2/4：createReactAgent 组装（LLM + MCP 工具）");
  console.log("=".repeat(72));
  console.log(`  Agent 可用工具: ${tools.map((t) => t.name).join(", ")}`);
  const agent = buildAgent(tools);

  try {
    await runTask(
      agent,
      "任务 A：走 calculate 工具做数学计算",
      "请调用 calculate 工具计算 (3.5+12.25)*4-7/2，告诉我结果。"
    );
    await runTask(
      agent,
      "任务 B：走 get_weather 工具查天气",
      "北京今天天气怎么样？温度多少度？请调用 get_weather 工具查询后再回答。"
    );
    await runTask(
      agent,
      "任务 C：两个工具都要用（多步推理）",
      "先算 2^10 是多少，再查上海天气，把两件事的结果一起告诉我。"
    );
  } finally {
    // 收尾：关闭所有 MCP 连接（子进程随 stdin 关闭而退出）
    console.log("\n" + "=".repeat(72));
    console.log("阶段 4/4：关闭 MCP 连接");
    console.log("=".repeat(72));
    await client.close();
    console.log("  ✅ 所有 MCP 连接已关闭");
  }
}

main().catch((err) => {
  console.error("\n❌ 运行失败:", (err as Error).message);
  process.exit(1);
});
