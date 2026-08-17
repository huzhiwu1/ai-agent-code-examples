/**
 * MCP 工具服务方（独立进程，由 index.ts 通过 stdio transport 拉起）
 * ------------------------------------------------------------------
 * 这篇文章演示的核心链路：
 *
 *    Agent (LangGraph) ──tools/call──▶ MCP Client ──stdio──▶ 本进程（MCP Server）
 *
 * 本文件就是「被标准化的工具服务方」：它只管把自己的能力用 MCP 协议暴露出来，
 * 不关心调用方是 Claude Desktop、Codex 还是 LangGraph —— 这正是 MCP 的意义：
 * 工具接入从「每家各写一套」变成「会 MCP 就能用」。
 *
 * 暴露两个工具（返回 JSON）：
 *   - get_weather : 查询指定城市天气（本地模拟数据，仅用于演示链路）
 *   - calculate   : 计算数学表达式（自研安全求值器，不用 eval）
 *
 * 协议细节：
 *   - stdio transport：协议消息走 stdout，日志必须走 stderr（否则会污染协议流）
 *   - 使用 @modelcontextprotocol/sdk 1.30.0 的「新版 API」：
 *     McpServer.registerTool(name, { description, inputSchema }, handler)
 *     （旧版是 Server.setRequestHandler + 手写 tools/list、tools/call 分发）
 *
 * 单独运行（调试用）：npx tsx src/mcp-server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* 工具 1 的数据源：按城市名生成确定性伪天气（演示用，不调真实 API）      */
/* ------------------------------------------------------------------ */

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const CONDITIONS = ["晴", "多云", "阴", "小雨", "中雨", "雷阵雨"] as const;

function fakeWeather(city: string, date: string) {
  const h = hashString(`${city}:${date}`);
  const temperature = 8 + (h % 26); // 8 ~ 33 ℃
  const humidity = 40 + (h % 55); // 40 ~ 94 %
  const windLevel = 1 + (h % 5); // 1 ~ 5 级
  const condition = CONDITIONS[h % CONDITIONS.length];
  return {
    city,
    date,
    temperatureCelsius: temperature,
    condition,
    humidityPercent: humidity,
    windLevel,
    source: "本地模拟数据（演示 MCP 协议链路，非真实天气）",
  };
}

/* ------------------------------------------------------------------ */
/* 工具 2 的安全表达式求值器：词法 + 递归下降，无 eval，生产可用          */
/* 支持：+ - * / % ^（右结合幂）、括号、小数、一元正负号                  */
/* ------------------------------------------------------------------ */

type Token =
  | { type: "number"; value: number }
  | { type: "op"; value: string }
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "end" };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const start = i;
      while (i < input.length && /[0-9.]/.test(input[i])) i++;
      const raw = input.slice(start, i);
      if (!/^\d+(\.\d+)?$/.test(raw)) {
        throw new Error(`非法数字: "${raw}"`);
      }
      tokens.push({ type: "number", value: Number(raw) });
      continue;
    }
    if ("+-*/%^".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }
    throw new Error(`表达式包含非法字符: "${ch}"（只支持 + - * / % ^ 括号和数字）`);
  }
  tokens.push({ type: "end" });
  return tokens;
}

/** 递归下降求值器 */
class Evaluator {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectEnd(): void {
    if (this.peek().type !== "end") {
      throw new Error("表达式包含多余内容（运算符缺失或括号不匹配）");
    }
  }

  /** expr := term (('+' | '-') term)* */
  private expr(): number {
    let value = this.term();
    for (;;) {
      const t = this.peek();
      if (t.type !== "op" || (t.value !== "+" && t.value !== "-")) break;
      this.next();
      const rhs = this.term();
      value = t.value === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  /** term := factor (('*' | '/' | '%') factor)* */
  private term(): number {
    let value = this.factor();
    for (;;) {
      const t = this.peek();
      if (t.type !== "op" || !["*", "/", "%"].includes(t.value)) break;
      this.next();
      const rhs = this.factor();
      if (t.value === "*") value = value * rhs;
      else if (t.value === "/") {
        if (rhs === 0) throw new Error("除数为 0");
        value = value / rhs;
      } else {
        if (rhs === 0) throw new Error("取模除数为 0");
        value = value % rhs;
      }
    }
    return value;
  }

  /** factor := ('+' | '-') factor | power   → 一元符号，-2^2 = -(2^2) */
  private factor(): number {
    const t = this.peek();
    if (t.type === "op" && (t.value === "+" || t.value === "-")) {
      this.next();
      const v = this.factor();
      return t.value === "-" ? -v : v;
    }
    return this.power();
  }

  /** power := primary ('^' factor)?   → 右结合：2^3^2 = 2^(3^2) */
  private power(): number {
    const base = this.primary();
    const t = this.peek();
    if (t.type === "op" && t.value === "^") {
      this.next();
      const exponent = this.factor();
      return Math.pow(base, exponent);
    }
    return base;
  }

  private primary(): number {
    const t = this.next();
    if (t.type === "number") return t.value;
    if (t.type === "lparen") {
      const v = this.expr();
      if (this.next().type !== "rparen") throw new Error("缺少右括号 )");
      return v;
    }
    throw new Error("表达式不完整（缺少数字或括号）");
  }

  evaluate(): number {
    const value = this.expr();
    this.expectEnd();
    return value;
  }
}

function evaluateExpression(expression: string): number {
  if (!expression.trim()) throw new Error("表达式为空");
  return new Evaluator(tokenize(expression)).evaluate();
}

/* ------------------------------------------------------------------ */
/* 组装 MCP Server（SDK 1.30 新版 API：McpServer + registerTool）       */
/* ------------------------------------------------------------------ */

const server = new McpServer(
  { name: "weather-calc-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.registerTool(
  "get_weather",
  {
    title: "查询天气",
    description:
      "查询指定城市某一天的天气情况（温度、天气状况、湿度、风力）。" +
      "返回 JSON。数据为本地模拟数据，仅用于演示 MCP 工具接入链路。",
    inputSchema: z.object({
      city: z.string().describe("城市名，如：北京、上海、广州、深圳"),
      date: z.string().optional().describe("日期，格式 YYYY-MM-DD，缺省为今天"),
    }),
  },
  async ({ city, date }) => {
    const day = date ?? new Date().toISOString().slice(0, 10);
    const data = fakeWeather(city, day);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.registerTool(
  "calculate",
  {
    title: "数学计算器",
    description:
      "计算数学表达式，支持 + - * / % ^ 运算符、括号、小数与一元正负号。" +
      "例如：(3.5+12.25)*4-7/2 或 2^10。表达式非法时返回错误信息。",
    inputSchema: z.object({
      expression: z.string().describe("要计算的数学表达式，如 (3.5+12.25)*4-7/2"),
    }),
  },
  async ({ expression }) => {
    try {
      const result = evaluateExpression(expression);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ expression, result }, null, 2),
          },
        ],
      };
    } catch (err) {
      // isError=true：协议层明确标记「调用失败」，客户端（LangGraph）会把它
      // 作为工具错误回传给模型，模型可以修正参数重试 —— 这就是统一的错误语义
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ expression, error: (err as Error).message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  },
);

/* ------------------------------------------------------------------ */
/* 启动：挂上 stdio transport。日志走 stderr，stdout 只留给协议          */
/* ------------------------------------------------------------------ */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[mcp-server] weather-calc-server v1.0.0 已启动，监听 stdio（工具: get_weather, calculate）`,
  );
}

main().catch((err) => {
  console.error("[mcp-server] 启动失败:", err);
  process.exit(1);
});
