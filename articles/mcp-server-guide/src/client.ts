/**
 * 《怎么规范地写一个 MCP Server？》—— 客户端接入验证
 * ==================================================================
 * 本文档配套 server.ts，做两件事：
 *
 *   ① 协议级验证（SDK Client 直连）：
 *      - 握手后列出资源模板，读取一篇文档（docs://mcp-guide/{id}）全文
 *      - 故意读一个不存在的资源，现场演示 McpError(InvalidParams) 如何冒泡到客户端
 *      - 这一节验证 server 的"资源能力 + 协议级错误"是真实可用的
 *
 *   ② 智能体级验证（LangGraph + DeepSeek）：
 *      - MultiServerMCPClient 自动发现 server 声明的工具（含 JSON Schema），
 *        打印出来 —— 这就是"规范的工具描述"最终长什么样、喂给了 LLM 什么
 *      - createReactAgent + DeepSeek 真实调用 get_weather / calculate / search_docs，
 *        其中特意安排一次"除以 0"：现场演示业务错误走 isError 通道、LLM 如何消化它
 *
 * 运行：仓库根目录  pnpm run run:mcp-server-guide
 * LLM：DeepSeek（OpenAI 兼容），key 从仓库根 .env 的 LLM_API_KEY 读取
 */

import * as dotenv from "dotenv";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

/* ================================================================== */
/* 0. 初始化：读仓库根 .env，定位 tsx CLI 与 server 文件                */
/* ================================================================== */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../.."); // articles/mcp-server-guide/src -> 仓库根
dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true, override: true });

const MODEL = process.env.LLM_MODEL ?? "deepseek-chat";
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
const API_KEY = process.env.LLM_API_KEY ?? "";
if (!API_KEY) {
  console.error("❌ 缺少 LLM_API_KEY：请在仓库根目录 .env 里配置后重试。");
  process.exit(1);
}

// tsx CLI 绝对路径：node <tsx-cli> server.ts 把 TS 写的 MCP server 当子进程拉起
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const serverFile = path.join(__dirname, "server.ts");

const llm = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  configuration: { baseURL: BASE_URL },
  temperature: 0,
  maxTokens: 1024,
});

/* ================================================================== */
/* 1. 协议级验证：SDK Client 直连，验证资源能力 + 协议级错误            */
/* ================================================================== */

async function verifyProtocolLevel() {
  console.log("════════ ① 协议级验证：资源读取 + 协议错误（McpError） ════════");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, serverFile],
    cwd: REPO_ROOT,
  });
  const client = new Client({ name: "guide-protocol-client", version: "1.0.0" });
  await client.connect(transport);

  // 握手后：server 的能力声明 + instructions（写给 LLM 的使用说明）
  const capabilities = client.getServerCapabilities();
  const instructions = client.getInstructions();
  console.log("\n[握手] server 能力声明:");
  console.log(`  capabilities: ${JSON.stringify(capabilities ?? {})}`);
  console.log(`  instructions: ${instructions ?? "(无)"}`);

  // 列出资源模板 —— 与 search_docs 返回的 uri 是同一套地址空间
  const templates = await client.listResourceTemplates();
  console.log("\n[资源模板] server 声明的资源:");
  for (const t of templates.resourceTemplates ?? []) {
    console.log(`  - ${t.uriTemplate}  （${t.name}：${t.description ?? ""}）`);
  }

  // 读一篇真实存在的文档全文（search_docs 会返回 docs://mcp-guide/{id} 引用）
  const ok = await client.readResource({ uri: "docs://mcp-guide/error-handling" });
  const text = ok.contents[0] && "text" in ok.contents[0] ? ok.contents[0].text : "";
  console.log("\n[读资源] docs://mcp-guide/error-handling 全文：");
  console.log(
    text
      .split("\n")
      .slice(0, 3)
      .map((l) => `  ${l}`)
      .join("\n")
  );

  // 故意读不存在的资源：规范里"协议级错误抛 McpError"的现场演示 ——
  // 客户端拿到的是 JSON-RPC error（-32602 InvalidParams），而不是一个"内容为空的成功响应"
  try {
    await client.readResource({ uri: "docs://mcp-guide/not-exist" });
    console.log("\n[读资源] docs://mcp-guide/not-exist：意外成功（不该发生）");
  } catch (e) {
    if (e instanceof McpError) {
      console.log("\n[读资源] docs://mcp-guide/not-exist → 抛 McpError ✅");
      console.log(`  code: ${e.code}（${e.code === -32602 ? "InvalidParams 协议错误" : ""}）`);
      console.log(`  message: ${e.message}`);
    } else {
      throw e;
    }
  }

  await client.close();
  console.log("\n");
}

/* ================================================================== */
/* 2. 智能体级验证：MultiServerMCPClient 自动发现 + LangGraph 真实调用  */
/* ================================================================== */

// 工具 schema 摘要：MCP 工具被转成 LangChain DynamicStructuredTool 后，
// schema 就是一个纯 JSON Schema 对象（{ type, properties, required }）——
// 这正好就是 server 端 zod inputSchema 转出来的、LLM 实际看到的那份 schema。
function toolSchemaSummary(tool: { name: string; description: string; schema: unknown }): string {
  const s = tool.schema as {
    properties?: Record<string, unknown>;
    required?: string[];
  } | null;
  const props = s?.properties ?? {};
  if (Object.keys(props).length === 0) {
    return `      (schema: ${JSON.stringify(s)})`;
  }
  return Object.entries(props)
    .map(([k, v]) => {
      // 每个属性在 JSON Schema 里是一个 { type, description, default?, enum? } 对象
      const p = v as {
        type?: string;
        description?: string;
        default?: unknown;
        enum?: string[];
      };
      const req = s?.required?.includes(k) ? "必填" : "可选";
      const desc = p.description ? `，${p.description}` : "";
      const def =
        p.default !== undefined && !desc.includes("默认")
          ? `，默认 ${JSON.stringify(p.default)}`
          : "";
      const enumHint = p.enum ? `（可选值: ${p.enum.join("/")}）` : "";
      return `      ${k}: ${p.type}${enumHint}${desc}${def} [${req}]`;
    })
    .join("\n");
}

async function runAgentDemo() {
  console.log("════════ ② 智能体级验证：LangGraph + DeepSeek 真实调用 ════════");

  // 规范 ① 的客户端视角：一个 MultiServerMCPClient 拉起 server 子进程，
  // 完成握手后 getTools() 自动把 server 声明的工具（schema + 实现）变成 LangChain 工具。
  const mcp = new MultiServerMCPClient({
    "prod-mcp-guide": {
      transport: "stdio",
      command: process.execPath,
      args: [tsxCli, serverFile],
      cwd: REPO_ROOT,
    },
  });
  const mcpTools = await mcp.getTools();

  // 打印自动发现的工具（含 schema）—— 这就是"规范的工具描述 + zod schema"最终喂给 LLM 的东西
  console.log(`\n[自动发现] 工具列表（${mcpTools.length} 个，含 schema）:`);
  for (const t of mcpTools) {
    console.log(`  - ${t.name}：${t.description?.split("\n")[0] ?? ""}`);
    console.log(toolSchemaSummary(t));
  }

  const agent = createReactAgent({ llm, tools: mcpTools });

  const questions = [
    {
      label: "get_weather（真实调用外部 API）",
      text: "请调用 get_weather 查询北京（纬度 39.9，经度 116.4）当前的天气，然后告诉我温度、风速和天气现象。",
    },
    {
      label: "calculate（纯计算）",
      text: "请调用 calculate 计算 (12.5 × 3.2) + 7 的结果，一步一步来。",
    },
    {
      label: "calculate 除零（业务错误走 isError 通道）",
      text: "请调用 calculate 计算 10 ÷ 0，然后告诉我发生了什么。",
    },
    {
      label: "search_docs（本地知识检索，工具+资源配合）",
      text: "请调用 search_docs 在本地知识库检索「错误处理」相关的规范文档，总结检索到的内容。",
    },
  ];

  for (const q of questions) {
    console.log(`\n───── 提问：${q.label} ─────`);
    console.log(`🧑 用户: ${q.text}`);
    const result = await agent.invoke({ messages: [new HumanMessage(q.text)] });
    const last = result.messages.at(-1);
    console.log(
      `🤖 Agent 最终回答: ${typeof last?.content === "string" ? last.content : JSON.stringify(last?.content)}`
    );
  }

  await mcp.close();
  console.log("\n✅ 全部验证通过，MCP 连接已关闭。");
}

/* ================================================================== */
/* 3. 入口                                                             */
/* ================================================================== */

async function main() {
  try {
    await verifyProtocolLevel();
  } catch (e) {
    console.error("【协议级验证失败】", e);
    process.exitCode = 1;
  }
  try {
    await runAgentDemo();
  } catch (e) {
    console.error("【智能体级验证失败】", e);
    process.exitCode = 1;
  }
}

main();
