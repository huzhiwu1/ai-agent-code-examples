/**
 * 《怎么规范地写一个 MCP Server？》—— 规范版 MCP Server 完整示例
 * ==================================================================
 * 本文件是文章的核心示例：一个"生产级" MCP Server 应该长什么样。
 * 每个规范点旁边都写了"为什么"，方便直接当文章素材。
 *
 * 运行方式：不作为独立进程直接跑，而是由客户端（src/client.ts）
 * 作为子进程拉起：node <tsx-cli> src/server.ts
 *
 * 覆盖的规范点：
 *   ① 用 McpServer + registerTool 声明式注册工具，
 *     不用旧式 Server + setRequestHandler 手写 switch 分发 ——
 *     协议细节（initialize 握手、tools/list、tools/call、参数校验……）全部由 SDK 接管。
 *   ② 3 个工具覆盖三类典型场景：
 *      - get_weather：外部 HTTP API（Open-Meteo，生产级、无需 key）
 *      - calculate：纯计算（含参数校验与业务规则错误）
 *      - search_docs：本地知识检索（与资源模板配合：工具返回引用，客户端可读全文）
 *   ③ 工具 description 按"何时用 / 参数含义 / 返回什么"三段式写，
 *     让 LLM 能正确选工具、正确填参数 —— 这是工具能被智能体用好的关键。
 *   ④ inputSchema 传 zod raw shape（registerTool 的硬性要求），
 *     由 SDK 自动转成 JSON Schema 下发给客户端；不要手写裸 JSON Schema。
 *   ⑤ 返回统一用 content 数组（text 块）；错误分两类，各有用武之地：
 *      - 业务错误 → 返回 { isError: true, content: [...] }（LLM 可读、可据此重试）
 *      - 协议/服务端错误 → 抛 McpError（客户端把整次调用标记为失败）
 *   ⑥ 工具内部 try/catch 兜底：能解释的错误转 isError，解释不了/不该发生的抛 McpError，
 *     不让未处理异常漏到协议层。
 *   ⑦ 所有日志走 console.error（stdio 下 stdout 是 JSON-RPC 数据通道，污染即协议损坏）。
 *   ⑧ 注册资源模板 docs://mcp-guide/{id}，与 search_docs 形成"工具+资源"配合。
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/* ================================================================== */
/* 0. 基础设施：日志、常量、内置知识库                                  */
/* ================================================================== */

// 规范 ⑦：stdio 下 stdout 是 JSON-RPC 协议专用通道，任何日志都必须走 stderr。
// 否则二进制协议流里混入日志文本，客户端 JSON 解析直接崩 —— 这是 stdio server 最经典的翻车点。
function log(...args: unknown[]) {
  console.error("[mcp-guide-server]", ...args);
}

/* ---------------- 知识库（search_docs 用，与资源模板配合） ---------------- */
// 模拟"本地知识检索"：一个简单的文档语料，条目内容正好是 MCP 编写规范本身，
// 让示例既有真实检索价值、又能呼应文章主题。
interface DocEntry {
  id: string;
  title: string;
  tags: string[];
  body: string;
}

const DOC_CORPUS: DocEntry[] = [
  {
    id: "tool-description",
    title: "工具描述规范",
    tags: ["工具", "描述", "LLM", "description"],
    body: "工具 description 要写清三件事：什么时候用（触发条件）、每个参数的含义与取值范围、返回什么格式。描述决定 LLM 能否正确选择工具：写得太泛，模型不知道该不该调；写得太窄，模型遇到边界场景就乱猜。",
  },
  {
    id: "error-handling",
    title: "错误处理规范",
    tags: ["错误", "isError", "McpError", "异常"],
    body: "MCP 错误分两类：业务错误（参数合法但执行失败，如除数为零、上游 API 挂了）返回 { isError: true, content: [...] }，让 LLM 读到可解释的错误信息并决定重试或改参数；协议/服务端错误（请求本身非法、服务端状态损坏）抛 McpError，客户端会把整次调用标记为失败，不走业务结果通道。",
  },
  {
    id: "input-schema",
    title: "入参 Schema 规范",
    tags: ["zod", "schema", "inputSchema", "校验"],
    body: "registerTool 的 inputSchema 必须传 zod raw shape（字段名到 zod schema 的映射），由 SDK 自动转成 JSON Schema 下发客户端并做入参校验。不要手写裸 JSON Schema：容易写错、和代码脱节、丢了 zod 的类型推导。参数校验发生在 handler 之前，不合法直接以 InvalidParams 协议错误返回。",
  },
  {
    id: "logging",
    title: "日志规范",
    tags: ["日志", "stdout", "stderr", "stdio"],
    body: "stdio 传输下，stdout 是 JSON-RPC 数据通道，只能写协议消息。所有应用日志必须走 stderr（console.error / logger）。想给客户端结构化日志，用 MCP 的 logging 能力（logging/message 通知）而不是往 stdout 打文本。",
  },
  {
    id: "resource-cooperation",
    title: "工具与资源配合",
    tags: ["资源", "resource", "uri", "配合"],
    body: "工具适合返回「轻量、结构化、可操作」的结果；当结果背后还有大段全文/原始数据时，工具返回资源引用（如 docs://mcp-guide/xxx），客户端需要细节时再通过 resources/read 读取。这样既不让工具结果臃肿，又保留了深度获取的路径。",
  },
];

// 规范 ⑥：服务端状态（这里指知识库）缺失属于"不该发生的事"，
// 统一抛协议级错误，避免 handler 里到处判空。
function ensureCorpusLoaded(): DocEntry[] {
  if (DOC_CORPUS.length === 0) {
    throw new McpError(ErrorCode.InternalError, "知识库未加载，请检查服务端配置");
  }
  return DOC_CORPUS;
}

/* ---------------- WMO 天气代码 → 可读描述（get_weather 用） ---------------- */
// 生产级细节：原始 API 返回的是 WMO 代码（数字），直接丢给 LLM 可读性差，
// 在服务端翻译成人话，客户端（LLM）拿到就能直接组织答案。
const WMO_WEATHER: Record<number, string> = {
  0: "晴",
  1: "基本晴朗",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "毛毛雨(弱)",
  53: "毛毛雨",
  55: "毛毛雨(强)",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨(弱)",
  67: "冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "米雪",
  80: "阵雨(弱)",
  81: "阵雨",
  82: "强阵雨",
  85: "阵雪(弱)",
  86: "阵雪",
  95: "雷暴",
  96: "雷暴伴小冰雹",
  99: "雷暴伴大冰雹",
};

/* ================================================================== */
/* 1. 创建 server 实例（规范 ①：McpServer + registerTool）               */
/* ================================================================== */

// serverInfo（name + version）是协议要求的身份信息，客户端会在 initialize 握手时拿到；
// capabilities 声明能力：这里开启 tools/resources 的 listChanged（工具/资源列表变更通知）；
// instructions 是给接入的 LLM 看的"使用说明"，写清楚这个 server 提供什么、怎么用，
// 客户端会在系统提示词里带上它 —— 生产级 server 都会写。
const server = new McpServer(
  { name: "prod-mcp-guide", version: "1.0.0" },
  {
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
    },
    instructions:
      "这是一个 MCP 规范示例服务，提供三个工具：" +
      "get_weather（查询实时天气，需要经纬度）、calculate（四则运算）、" +
      "search_docs（检索本地 MCP 规范知识库）。另有文档资源 docs://mcp-guide/{id}，" +
      "search_docs 返回的 uri 可通过资源接口读取全文。",
  }
);

/* ================================================================== */
/* 2. 工具一：get_weather —— 真实调用外部 HTTP API（Open-Meteo）        */
/* ================================================================== */

server.registerTool(
  "get_weather",
  {
    title: "查询实时天气",
    // 规范 ③（核心）：description 按"何时用 → 参数含义 → 返回什么"三段式写。
    // 为什么这么写：工具选择是 LLM 做的，描述就是它的"使用说明书"——
    // 写清触发条件（什么时候该调）、参数语义（含取值范围，模型才不会填出 999 的纬度）、
    // 返回结构（模型才知道结果里有什么、怎么组织答案）。
    description: `获取指定经纬度（WGS84 坐标系）当前的实时天气，数据源为 Open-Meteo（免费、无需 API key）。
何时用：用户询问某地的当前天气、气温、风速等实时气象信息时。
参数：latitude 纬度（-90~90，北纬为正，如北京 39.9）；longitude 经度（-180~180，东经为正，如北京 116.4）；unit 温度单位（celsius 摄氏度 / fahrenheit 华氏度，默认 celsius）。
返回：JSON 文本，含 temperature（温度）、windspeed（风速 km/h）、winddirection（风向角度）、weathercode（天气现象描述）、is_day（是否白天）、time（观测时间）。`,
    // 规范 ④：inputSchema 用 zod raw shape —— 字段名 → zod schema 的映射对象。
    // registerTool 要求的就是这种形状（不能传手写 JSON Schema）：
    // SDK 负责把它转成 JSON Schema 下发给客户端，并在调用前自动校验参数
    // （不合法直接抛 InvalidParams 协议错误，handler 里拿到的参数一定形状合法）。
    inputSchema: {
      latitude: z.number().min(-90).max(90).describe("纬度（WGS84，北纬为正，如北京 39.9）"),
      longitude: z.number().min(-180).max(180).describe("经度（WGS84，东经为正，如北京 116.4）"),
      unit: z.enum(["celsius", "fahrenheit"]).default("celsius").describe("温度单位，默认 celsius"),
    },
  },
  async ({ latitude, longitude, unit }) => {
    // 规范 ⑥：工具内部 try/catch 兜底 —— 外部 API 失败是"可预期的业务失败"，
    // 转成 isError 结构化结果返回（而不是抛异常），LLM 能读到原因并决定重试/换参数。
    try {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.searchParams.set("latitude", String(latitude));
      url.searchParams.set("longitude", String(longitude));
      url.searchParams.set("current_weather", "true");
      if (unit === "fahrenheit") url.searchParams.set("temperature_unit", "fahrenheit");
      // 生产级细节：给外部调用加超时，避免第三方 API 卡死整个工具调用
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        throw new Error(`Open-Meteo 返回 HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        current_weather?: {
          temperature?: number;
          windspeed?: number;
          winddirection?: number;
          weathercode?: number;
          is_day?: number;
          time?: string;
        };
      };
      const cw = data.current_weather ?? {};

      // 规范 ⑤：正常返回统一走 content 数组（text 块）。
      // 结构化数据序列化成 JSON 字符串放进 text 块 —— 协议层面不区分"结构化"，LLM 自会解析。
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                latitude,
                longitude,
                unit,
                temperature: cw.temperature,
                windspeed: cw.windspeed,
                winddirection: cw.winddirection,
                weather: WMO_WEATHER[cw.weathercode ?? -1] ?? `未知天气代码 ${cw.weathercode}`,
                is_day: cw.is_day === 1,
                observed_at: cw.time,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // 规范 ⑤+⑥：业务错误 → { isError: true, content: [...] }。
      // 为什么用 isError 而不是抛 McpError：这是"业务上失败但协议上合法"的调用，
      // 客户端（LLM）需要拿到可读的错误描述来组织回答，而不是把整个调用视为协议故障。
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `查询天气失败：${reason}。请稍后重试或检查经纬度参数。` },
        ],
      };
    }
  }
);

/* ================================================================== */
/* 3. 工具二：calculate —— 纯计算，演示参数校验与业务规则错误           */
/* ================================================================== */

server.registerTool(
  "calculate",
  {
    title: "四则运算计算器",
    description: `对两个数字执行四则运算（加/减/乘/除）。
何时用：用户要求做算术计算，或需要把多个数字算出一个结果时；不适合查天气（用 get_weather）或查资料（用 search_docs）。
参数：operation 运算类型（add 加 / subtract 减 / multiply 乘 / divide 除）；a、b 两个操作数。
返回：形如 "add: 1 + 2 = 3" 的文本；除数为 0 时返回错误结果（isError），LLM 应据此向用户说明或改用其他参数。`,
    inputSchema: {
      operation: z
        .enum(["add", "subtract", "multiply", "divide"])
        .describe("运算类型：add/subtract/multiply/divide"),
      a: z.number().describe("第一个操作数"),
      b: z.number().describe("第二个操作数"),
    },
  },
  ({ operation, a, b }) => {
    // 规范 ④：参数校验由 SDK 在 handler 之前完成（zod 校验，不合法抛 InvalidParams），
    // 所以这里不需要再校验类型 —— 只处理"参数合法但业务规则不允许"的情况。
    if (operation === "divide" && b === 0) {
      // 规范 ⑤：可预期的业务错误 → isError 结果块。
      // 让 LLM 拿到"除数为 0"这个明确原因，它可以决定换参数重试或直接向用户解释，
      // 而不是收到一个协议级异常（那样 LLM 只能复述"调用失败了"）。
      return {
        isError: true,
        content: [
          { type: "text" as const, text: "除数为 0：不能执行除法运算，请提供一个非零的 b 再试。" },
        ],
      };
    }

    const result =
      operation === "add"
        ? a + b
        : operation === "subtract"
          ? a - b
          : operation === "multiply"
            ? a * b
            : a / b; // 到这里 b 一定非零（上面已拦截）

    // 浮点精度整理：避免 10/3 输出一长串 3.3333333333333335
    const display = Number.isInteger(result)
      ? String(result)
      : String(Math.round(result * 1e10) / 1e10);
    const symbol = { add: "+", subtract: "-", multiply: "×", divide: "÷" }[operation];
    return {
      content: [{ type: "text" as const, text: `${operation}: ${a} ${symbol} ${b} = ${display}` }],
    };
  }
);

/* ================================================================== */
/* 4. 工具三：search_docs —— 本地知识检索（工具 + 资源配合）            */
/* ================================================================== */

server.registerTool(
  "search_docs",
  {
    title: "检索本地 MCP 规范知识库",
    description: `在本地 MCP 编写规范知识库中按关键词检索文档片段。
何时用：用户问"规范里怎么说 / 文档里有没有提到某主题"这类需要查资料的问题；不适合：实时天气（用 get_weather）、算术计算（用 calculate）。
参数：query 搜索关键词（多个词用空格分隔，命中的词越多排序越靠前）；limit 返回条数上限（默认 3）。
返回：JSON 数组，每项含 id、title、score（命中关键词数）、snippet（片段）、uri（资源地址 docs://mcp-guide/{id}，可通过资源接口读取全文）；无命中时返回空数组。`,
    inputSchema: {
      query: z.string().min(1).max(100).describe("搜索关键词，多个词用空格分隔"),
      limit: z.number().int().min(1).max(10).default(3).describe("返回条数上限，默认 3"),
    },
  },
  async ({ query, limit }) => {
    try {
      const corpus = ensureCorpusLoaded();
      const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = corpus
        .map((doc) => {
          // 极简检索：标题/标签/正文里命中关键词数即得分（示例足够，生产可换向量检索）
          const haystack = `${doc.title} ${doc.tags.join(" ")} ${doc.body}`.toLowerCase();
          const score = keywords.reduce((sum, kw) => sum + (haystack.includes(kw) ? 1 : 0), 0);
          return { doc, score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      // 无命中不是错误：返回空数组是合法业务结果，LLM 会据此告诉用户"没找到"或换关键词
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              hits.map(({ doc, score }) => ({
                id: doc.id,
                title: doc.title,
                score,
                snippet: doc.body.slice(0, 120) + (doc.body.length > 120 ? "…" : ""),
                // 规范 ⑧：工具返回资源引用（uri），客户端需要全文时走 resources/read，
                // 工具结果保持轻量，深度信息按需获取 —— 这就是"工具+资源"的配合方式。
                uri: `docs://mcp-guide/${doc.id}`,
              })),
              null,
              2
            ),
          },
        ],
      };
    } catch (e) {
      // 规范 ⑤+⑥：知识库没加载属于"服务端内部状态错误"（不该发生、客户端也无法补救），
      // 抛 McpError —— 客户端会把整次调用标记为失败。
      // 对比 get_weather 的 isError：可预期的业务失败让 LLM 处理；
      // 不可预期的服务端故障直接以协议错误暴露，避免 LLM 把异常当业务结果硬编进回答。
      if (e instanceof McpError) throw e;
      throw new McpError(
        ErrorCode.InternalError,
        `知识库检索失败：${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
);

/* ================================================================== */
/* 5. 资源模板：docs://mcp-guide/{id} —— 与 search_docs 配合            */
/* ================================================================== */

// 规范 ⑧：注册一个"资源模板"（ResourceTemplate，{id} 是变量）。
// 资源 = 由 server 管理的、可寻址的内容（文档/文件/数据库行……）；
// 工具返回引用、资源承载内容，两者配合是 MCP 的典型用法。
// 注意：模板必须传 ResourceTemplate 实例（字符串会被当成静态资源 URI），
// 同时提供 list 回调让客户端能枚举出该模板下的所有资源。
server.registerResource(
  "mcp-guide-doc",
  new ResourceTemplate("docs://mcp-guide/{id}", {
    list: async () => ({
      resources: ensureCorpusLoaded().map((doc) => ({
        uri: `docs://mcp-guide/${doc.id}`,
        name: doc.title,
        description: doc.tags.join(" / "),
        mimeType: "text/markdown",
      })),
    }),
  }),
  {
    title: "MCP 规范知识条目",
    description: "本地 MCP 编写规范知识库中的一条文档（markdown），id 见 search_docs 返回结果",
    mimeType: "text/markdown",
  },
  async (uri, variables) => {
    const id = String(variables.id ?? "");
    const doc = ensureCorpusLoaded().find((d) => d.id === id);
    if (!doc) {
      // 规范 ⑤：读一个不存在的资源 = 请求本身非法（参数错误），
      // 属于协议级错误，抛 McpError(InvalidParams)；而不是返回"内容为空"——那会误导调用方。
      throw new McpError(ErrorCode.InvalidParams, `文档不存在: docs://mcp-guide/${id}`);
    }
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/markdown" as const,
          text: `# ${doc.title}\n\n${doc.body}`,
        },
      ],
    };
  }
);

/* ================================================================== */
/* 6. 启动：stdio transport + 就绪日志                                  */
/* ================================================================== */

async function main() {
  // 规范 ①：transport 只管"字节通道"，协议处理全在 SDK 内部，
  // server.connect() 之后就不用再关心 JSON-RPC 细节了。
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 规范 ⑦：就绪日志走 console.error（stderr）—— stdout 是协议通道，绝不能打日志。
  log(
    "已就绪：prod-mcp-guide v1.0.0（tools: get_weather/calculate/search_docs；resources: docs://mcp-guide/{id}）"
  );
}

main().catch((err) => {
  log("启动失败:", err);
  process.exit(1);
});
