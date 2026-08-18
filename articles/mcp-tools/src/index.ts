/**
 * 《Agent 接入工具为什么要标准化？MCP 到底解决了什么痛点？》
 * ------------------------------------------------------------------
 * 渐进式演示，同一句话「查询北京天气」，走两条完全不同的接入路径：
 *
 *   演示 1（痛点，手写工具）：zod schema + fetch 实现 + 错误处理，
 *     全都在客户端手写，再 bindTools 硬绑给"这一个" LLM；
 *     连"调用→执行→回填"的 agent 循环也得自己写。
 *     → 痛点：工具与模型/框架硬编码耦合，加一个工具就要改一堆客户端代码。
 *
 *   演示 2（MCP）：同样的天气能力，在 MCP server 端定义一次（mcp-server.ts），
 *     客户端用 @langchain/mcp-adapters 的 MultiServerMCPClient 自动发现工具
 *     （schema + 实现一起通过协议拿过来），直接喂给 LangGraph createReactAgent。
 *     新增 echo 工具时客户端一行代码都没改。
 *
 * 运行：仓库根目录执行  pnpm run run:mcp-tools
 * LLM：DeepSeek（OpenAI 兼容协议），key 从仓库根 .env 的 LLM_API_KEY 读取
 */

import * as dotenv from "dotenv";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod/v3"; // @langchain/core 1.x 内部用 zod v3 兼容层，这里保持一致
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

/* ================================================================== */
/* 0. 初始化：读仓库根目录 .env，建 DeepSeek LLM 客户端                  */
/* ================================================================== */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../.."); // articles/mcp-tools/src -> 仓库根
dotenv.config({ path: path.join(REPO_ROOT, ".env"), override: true });

const MODEL = process.env.LLM_MODEL ?? "deepseek-chat";
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
const API_KEY = process.env.LLM_API_KEY ?? "";

if (!API_KEY) {
  console.error("❌ 缺少 LLM_API_KEY：请在仓库根目录 .env 里配置后重试。");
  process.exit(1);
}

const llm = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  configuration: { baseURL: BASE_URL },
  temperature: 0,
  maxTokens: 1024,
});

/* ================================================================== */
/* 演示 1（痛点）：手写工具 + bindTools                                 */
/* 下面的每一行都是"人肉"写的：schema、实现、错误处理、返回格式、循环……  */
/* 而且这套东西只服务"当前这一个 LLM"，换个模型或框架就要重写。           */
/* ================================================================== */

// ① 手写输入参数 schema —— 工具每多一个参数，这里就多几行
const weatherInputSchema = z.object({
  city: z.string().describe("城市名，如：北京"),
  latitude: z.number().describe("纬度，如北京 39.9"),
  longitude: z.number().describe("经度，如北京 116.4"),
});

// ② 手写工具实现 —— fetch、超时、错误处理、返回格式全要自己管
const handWrittenWeatherTool = tool(
  async ({ city, latitude, longitude }) => {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}` +
      `&longitude=${longitude}&current_weather=true`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        current_weather?: { temperature?: number; windspeed?: number; time?: string };
      };
      const w = data.current_weather ?? {};
      return `${city} 当前温度 ${w.temperature ?? "?"}°C，风速 ${w.windspeed ?? "?"} km/h（观测时间 ${w.time ?? "?"}）`;
    } catch (e) {
      return `查询 ${city} 天气失败：${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: "get_weather",
    description: "查询指定城市当前天气（需要经纬度）。",
    schema: weatherInputSchema,
  }
);

// ③ 手写"绑定"：把工具塞给这一个 LLM 实例（换模型/换框架就要重新绑）
const llmWithTools = llm.bindTools([handWrittenWeatherTool]);

async function runPainPointDemo() {
  console.log("════════ 演示 1（痛点）：手写工具 + bindTools，无 MCP ════════");
  console.log("工具是手写的：zod schema + fetch 实现 + 错误处理 + bindTools 硬绑定\n");

  const userMsg = new HumanMessage(
    "请调用 get_weather 工具查询北京（纬度 39.9，经度 116.4）现在的天气，然后告诉我温度。"
  );
  const messages = [userMsg];

  // 第一轮：LLM 决定要不要调用工具
  const first = await llmWithTools.invoke(messages);
  const toolCalls = first.tool_calls ?? [];
  if (toolCalls.length === 0) {
    console.log("（LLM 没有发起工具调用，演示提前结束）");
    return;
  }
  for (const tc of toolCalls) {
    console.log(`🤖 LLM 请求调用工具: ${tc.name}(${JSON.stringify(tc.args)})`);
  }

  // 手动执行工具 + 手动把结果包装成 ToolMessage 回填 —— agent 循环也是手写的
  const toolMessages: ToolMessage[] = [];
  for (const tc of toolCalls) {
    // tc.args 来自 LLM 返回的 tool_call，类型是宽松的 Record；这里按工具 schema 断言
    const args = tc.args as { city: string; latitude: number; longitude: number };
    const result = await handWrittenWeatherTool.invoke(args);
    console.log(`🔧 工具执行结果: ${result}`);
    toolMessages.push(new ToolMessage({ tool_call_id: tc.id ?? "", content: String(result) }));
  }

  // 第二轮：把工具结果还给 LLM，得到最终答案
  const final = await llmWithTools.invoke([...messages, first, ...toolMessages]);
  console.log(`💬 LLM 最终回答: ${final.content}\n`);
}

/* ================================================================== */
/* 演示 2（MCP）：本地 stdio MCP server + 自动发现工具                   */
/* 同样的 get_weather，这次在 server 端（mcp-server.ts）定义一次，       */
/* 客户端 loadMCPTools 自动拿到 schema + 实现，一行手写都没有。          */
/* ================================================================== */

async function runMCPDemo() {
  console.log("════════ 演示 2（MCP）：stdio server + @langchain/mcp-adapters ════════");

  // tsx CLI 绝对路径：用来把 TypeScript 写的 MCP server 作为子进程拉起
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");
  const serverFile = path.join(__dirname, "mcp-server.ts");

  // 客户端：一个 MultiServerMCPClient 可以同时连多个 server（stdio / HTTP / SSE 都行）
  const mcp = new MultiServerMCPClient({
    "weather-echo-server": {
      transport: "stdio",
      command: process.execPath, // 用当前 node 执行
      args: [tsxCli, serverFile], // node <tsx-cli> mcp-server.ts
      cwd: REPO_ROOT,
    },
  });

  // 自动发现工具：client 与 server 完成 MCP initialize 握手后，
  // server 声明的工具（含 JSON Schema）被自动转成 LangChain Tool，无需手写
  const mcpTools = await mcp.getTools();
  console.log(`MCP server 自动发现的工具（${mcpTools.length} 个）：`);
  for (const t of mcpTools) {
    console.log(`  - ${t.name}: ${t.description}`);
  }
  console.log();

  // 同样的 createReactAgent，tools 换成 MCP 发现来的 —— 接入方式和手写版没有区别
  const agent = createReactAgent({ llm, tools: mcpTools });

  // 第一问：和演示 1 一模一样的问题
  const answer = await agent.invoke({
    messages: [
      new HumanMessage(
        "请调用 get_weather 工具查询北京（纬度 39.9，经度 116.4）现在的天气，然后告诉我温度。"
      ),
    ],
  });
  console.log(`💬 LLM 最终回答: ${answer.messages.at(-1)?.content}\n`);

  // 第二问：echo 工具是 server 端新增的 —— 客户端代码一行没改，直接用
  const answer2 = await agent.invoke({
    messages: [
      new HumanMessage("请调用 echo 工具把文本「MCP 链路 OK」回显给我，然后告诉我它返回了什么。"),
    ],
  });
  console.log(`💬 LLM 最终回答(echo): ${answer2.messages.at(-1)?.content}\n`);

  // 演示完关闭所有 MCP 连接（会结束子进程）
  await mcp.close();
}

/* ================================================================== */
/* 3. 对比总结 + 入口                                                   */
/* ================================================================== */

function printSummary() {
  console.log("════════ 对比总结 ════════");
  console.log(`
痛点（演示 1）：
  每个工具都要在客户端手写 zod schema + 实现 + 错误处理，
  再 bindTools 硬绑给"这一个" LLM；连"调用→执行→回填"的循环都要自己写。
  工具与模型/框架硬编码耦合 —— 换个 Agent 框架，全部重写。

MCP（演示 2）：
  工具只在 server 端定义一次，通过协议暴露 schema + 实现；
  客户端自动发现（MultiServerMCPClient.getTools()），
  接入 createReactAgent 零手写；server 新增工具（echo），客户端零改动。
  这就是"标准化"的价值：工具接入从"人肉适配"变成"协议即插即用"。`);
}

async function main() {
  try {
    await runPainPointDemo();
  } catch (e) {
    console.error("【演示 1 执行失败】", e);
  }
  try {
    await runMCPDemo();
    printSummary();
  } catch (e) {
    console.error("【演示 2 执行失败】", e);
    process.exitCode = 1;
  }
}

main();
