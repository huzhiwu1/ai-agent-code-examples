/**
 * 多 Agent Supervisor / Handoff 演示
 * ------------------------------------------------------------------
 * 主题：多 Agent 为什么要分工？Supervisor/Handoff 怎么分工才不打架？
 *
 * 读者终点：看完能自己从零搭一个 supervisor，让不同子 Agent 各管一摊，
 * 并解释清楚为什么「多 Agent 不一定更强」，什么时候反而该回到单 Agent + 强工具。
 *
 * 结构：
 *   1. 两个专门子 Agent：weather_agent / trivia_agent
 *   2. Supervisor：根据任务意图把问题交给正确的子 Agent
 *   3. 观察执行路径：谁被调用、最终回答是什么
 *
 * 运行（待志武验证）：cd ~/workspace/ai-agent-code-examples && pnpm run run:multi-agent-supervisor
 * 环境变量：LLM_API_KEY / LLM_BASE_URL / LLM_MODEL（仓库根目录 .env）
 */

import "dotenv/config";
import * as dotenv from "dotenv";
import * as path from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { createSupervisor } from "@langchain/langgraph-supervisor";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, tool } from "langchain";
import { z } from "zod";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const API_KEY = process.env.LLM_API_KEY ?? "";
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.LLM_MODEL ?? "deepseek-chat";

if (!API_KEY) {
  throw new Error("未找到 LLM_API_KEY，请先配置仓库根目录 .env");
}

const llm = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  configuration: { baseURL: BASE_URL },
  temperature: 0.1,
  maxTokens: 1024,
});

function normCity(city: string) {
  return String(city).trim();
}

const weatherTable: Record<
  string,
  { summary: string; tempHighC: number; tempLowC: number; aqi: string }
> = {
  杭州: { summary: "多云转小雨", tempHighC: 22, tempLowC: 15, aqi: "良" },
  北京: { summary: "晴", tempHighC: 26, tempLowC: 12, aqi: "轻度污染" },
  上海: { summary: "阴", tempHighC: 20, tempLowC: 16, aqi: "良" },
};

const triviaTable: Record<string, string> = {
  杭州: "西湖文化景观是世界文化遗产之一。",
  北京: "故宫是世界上现存规模最大的古代宫殿建筑群之一。",
  上海: "外滩万国建筑博览群是近代城市历史的缩影。",
};

const lookupWeatherTool = tool(
  async ({ city }) => {
    const c = normCity(city);
    const w = weatherTable[c];
    return JSON.stringify(
      w
        ? { city: c, ...w }
        : {
            city: c,
            summary: "暂无该城市数据，以下为占位",
            tempHighC: 20,
            tempLowC: 12,
            aqi: "—",
          }
    );
  },
  {
    name: "lookup_weather",
    description: "查询某城市当天的天气概况、温度区间和空气质量。",
    schema: z.object({ city: z.string().describe("城市名，如 杭州") }),
  }
);

const lookupCityTriviaTool = tool(
  async ({ city }) => {
    const c = normCity(city);
    return JSON.stringify({
      city: c,
      trivia: triviaTable[c] ?? `没有为「${c}」准备内置小知识，可换杭州/北京/上海试试。`,
    });
  },
  {
    name: "lookup_city_trivia",
    description: "查询与某城市相关的一句趣味知识。",
    schema: z.object({ city: z.string().describe("城市名，如 杭州") }),
  }
);

const weatherAgent = createAgent({
  name: "weather_agent",
  description: "专门查天气的子 Agent。",
  model: llm,
  tools: [lookupWeatherTool],
  systemPrompt: "你只处理天气。用户提到城市时，必须先调用 lookup_weather，再用中文简短说明。",
});

const triviaAgent = createAgent({
  name: "trivia_agent",
  description: "专门讲城市小知识的子 Agent。",
  model: llm,
  tools: [lookupCityTriviaTool],
  systemPrompt:
    "你只讲城市小知识。必须先调用 lookup_city_trivia，再用人话转述，不要编造工具里没有的内容。",
});

const workflow = createSupervisor({
  agents: [weatherAgent.graph, triviaAgent.graph],
  llm,
  prompt: `你是调度员，只负责选人，不要自己报气温，也不要自己讲城市百科。

- 问天气、气温、下不下雨、空气 → 用 weather_agent
- 问小知识、名胜、历史、一句介绍 → 用 trivia_agent
`,
});

const app = workflow.compile();

function lastMessageText(result: { messages?: Array<{ content?: unknown }> }) {
  const last = result.messages?.at(-1)?.content;
  if (typeof last === "string") return last;
  return JSON.stringify(last ?? result);
}

async function main() {
  const graph = await app.getGraphAsync();
  console.log(graph.drawMermaid({ withStyles: true }));

  const input = {
    messages: [new HumanMessage("查一下杭州的天气，再讲一条和杭州有关的小知识。")],
  };

  const nodePath: string[] = [];
  let finalState: { messages?: Array<{ content?: unknown }> } | null = null;

  const stream = await app.stream(input, { streamMode: ["updates", "values"] });
  for await (const event of stream) {
    const [mode, payload] = event as [string, Record<string, unknown>];
    if (mode === "updates" && payload && typeof payload === "object") {
      nodePath.push(...Object.keys(payload));
    }
    if (mode === "values") {
      finalState = payload as { messages?: Array<{ content?: unknown }> };
    }
  }

  console.log("路径:", nodePath.join(" → "));
  console.log("最终回答:", lastMessageText(finalState ?? {}));
}

main().catch((error) => {
  console.error("执行失败:", error);
  process.exit(1);
});
