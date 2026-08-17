/**
 * MCP stdio server：一个极简的本地 MCP 服务端（weather + echo 两个工具）
 * ------------------------------------------------------------------
 * 这是"工具提供方"：工具的定义（schema + 实现）只在这里写一次。
 * 任何 MCP 客户端（LangChain、Claude Desktop、Cursor……）通过协议
 * 都能自动发现并调用，客户端不需要知道实现细节。
 *
 * 运行方式：作为子进程被客户端拉起（见 src/index.ts 的演示 2）：
 *   node <tsx-cli> mcp-server.ts
 *
 * ⚠️ 注意：stdio server 的输出通道（stdout）是 JSON-RPC 协议专用，
 * 任何日志都只能走 stderr（console.error），绝不能 console.log 到 stdout。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3"; // 与 @langchain/core 内部一致的 v3 兼容层；SDK 会把 zod schema 自动转成 JSON Schema 发给客户端

const server = new McpServer({
  name: "weather-echo-server",
  version: "1.0.0",
});

/* ------------------------------------------------------------------ */
/* 工具 1：get_weather —— 查真实天气（open-meteo，免费、无需 key）       */
/* 参数用 zod schema 声明，SDK 自动转成 JSON Schema 暴露给客户端         */
/* ------------------------------------------------------------------ */
server.registerTool(
  "get_weather",
  {
    title: "获取天气",
    description:
      "根据城市名称与经纬度查询该地当前天气（温度、风速、天气代码）。" +
      "open-meteo 免费接口，无需 API key。",
    inputSchema: {
      city: z.string().describe("城市名称，如：北京"),
      latitude: z.number().describe("纬度，如北京 39.9"),
      longitude: z.number().describe("经度，如北京 116.4"),
    },
  },
  async ({ city, latitude, longitude }) => {
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}` +
        `&longitude=${longitude}&current_weather=true`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        current_weather?: { temperature?: number; windspeed?: number; time?: string };
      };
      const w = data.current_weather ?? {};
      const text =
        `${city} 当前天气：温度 ${w.temperature ?? "?"}°C，` +
        `风速 ${w.windspeed ?? "?"} km/h，观测时间 ${w.time ?? "?"}`;
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: `查询 ${city} 天气失败：${e instanceof Error ? e.message : String(e)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/* ------------------------------------------------------------------ */
/* 工具 2：echo —— 回显文本，用来演示"server 加新工具，客户端零改动"      */
/* ------------------------------------------------------------------ */
server.registerTool(
  "echo",
  {
    title: "回显文本",
    description: "把传入的文本原样返回，用于验证 MCP 工具调用链路是否通畅。",
    inputSchema: {
      text: z.string().describe("要回显的文本"),
    },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `echo: ${text}` }],
  })
);

/* ------------------------------------------------------------------ */
/* 用 stdio transport 挂到标准输入/输出上，等待客户端通过 JSON-RPC 通信   */
/* ------------------------------------------------------------------ */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-server] weather-echo-server 已就绪，等待客户端请求…");
}

main().catch((err) => {
  console.error("[mcp-server] 启动失败:", err);
  process.exit(1);
});
