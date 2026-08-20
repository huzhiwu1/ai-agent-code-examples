/**
 * shared.ts — 多 Agent 编排 7 步渐进式共用的基础模块
 *
 * 本文件只放「多步复用」的部分：
 *   - LLM 初始化（读仓库根 .env）
 *   - 模拟数据表（天气/趣闻/餐厅/旅行贴士，覆盖 5 个城市）
 *   - 4 个模拟工具
 *   - 工具函数
 *
 * 文章变量规则：首次定义在本文件，后续 step 直接 import 复用，不再重复写。
 */

import "dotenv/config";
import * as dotenv from "dotenv";
import * as path from "node:path";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "langchain";
import { z } from "zod";

// ──────────────── LLM 初始化 ────────────────

dotenv.config({ path: path.resolve(__dirname, "../../../.env"), override: true });

export const API_KEY = process.env.LLM_API_KEY ?? "";
export const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
export const MODEL = process.env.LLM_MODEL ?? "deepseek-chat";

export const llm = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  configuration: { baseURL: BASE_URL },
  temperature: 0.1,
  maxTokens: 1024,
});

// ──────────────── 模拟数据表 ────────────────

function normCity(city: string) {
  return String(city).trim();
}

export interface WeatherData {
  summary: string;
  tempHighC: number;
  tempLowC: number;
  aqi: string;
  humidity: string;
}

export interface RestaurantData {
  name: string;
  cuisine: string;
  specialty: string;
  price: string;
}

export const weatherTable: Record<string, WeatherData> = {
  杭州: { summary: "多云转小雨", tempHighC: 22, tempLowC: 15, aqi: "良", humidity: "78%" },
  北京: { summary: "晴", tempHighC: 26, tempLowC: 12, aqi: "轻度污染", humidity: "35%" },
  上海: { summary: "阴", tempHighC: 20, tempLowC: 16, aqi: "良", humidity: "72%" },
  成都: { summary: "阴转小雨", tempHighC: 18, tempLowC: 13, aqi: "优", humidity: "85%" },
  深圳: { summary: "晴转多云", tempHighC: 28, tempLowC: 22, aqi: "优", humidity: "65%" },
};

export const triviaTable: Record<string, string> = {
  杭州: "西湖文化景观是世界文化遗产。'欲把西湖比西子，淡妆浓抹总相宜'——苏轼笔下的西湖，三面环山、一面临城，有'人间天堂'美誉。",
  北京: "故宫是世界上现存规模最大、保存最完整的古代宫殿建筑群，始建于明永乐四年（1406年），占地72万平方米。",
  上海: "外滩万国建筑博览群是近代上海城市历史的缩影，汇集了52幢风格各异的大楼，被誉为'东方华尔街'。",
  成都: "都江堰是世界上最古老且至今仍在发挥灌溉作用的水利工程，建于公元前256年，体现了古人'因势利导'的智慧。",
  深圳: "深圳从一个小渔村发展为国际化大都市，是中国改革开放的窗口，'深圳速度'曾是全国学习的标杆。",
};

export const restaurantTable: Record<string, RestaurantData[]> = {
  杭州: [
    { name: "楼外楼", cuisine: "杭帮菜", specialty: "西湖醋鱼、东坡肉", price: "人均150" },
    { name: "知味观", cuisine: "小吃", specialty: "猫耳朵、小笼包", price: "人均60" },
    { name: "绿茶餐厅", cuisine: "创意菜", specialty: "面包诱惑、绿茶烤鸡", price: "人均80" },
  ],
  北京: [
    { name: "全聚德", cuisine: "烤鸭", specialty: "北京烤鸭", price: "人均200" },
    { name: "东来顺", cuisine: "涮羊肉", specialty: "手切羊肉", price: "人均150" },
    { name: "护国寺小吃", cuisine: "小吃", specialty: "豆汁、焦圈、驴打滚", price: "人均40" },
  ],
  上海: [
    { name: "老正兴", cuisine: "本帮菜", specialty: "油爆虾、红烧肉", price: "人均180" },
    { name: "南翔馒头店", cuisine: "小吃", specialty: "小笼包", price: "人均60" },
    { name: "光明邨", cuisine: "点心", specialty: "鲜肉月饼", price: "人均50" },
  ],
  成都: [
    { name: "陈麻婆豆腐", cuisine: "川菜", specialty: "麻婆豆腐、宫保鸡丁", price: "人均70" },
    { name: "小龙坎", cuisine: "火锅", specialty: "牛油火锅", price: "人均120" },
    { name: "龙抄手", cuisine: "小吃", specialty: "红油抄手、钟水饺", price: "人均40" },
  ],
  深圳: [
    { name: "潮江春", cuisine: "潮汕菜", specialty: "卤水拼盘、蚝烙", price: "人均160" },
    { name: "润园四季", cuisine: "椰子鸡", specialty: "竹笙椰子鸡", price: "人均120" },
    { name: "点都德", cuisine: "早茶", specialty: "红米肠、虾饺皇", price: "人均90" },
  ],
};

export const travelTipsTable: Record<string, string> = {
  杭州: "建议游玩2-3天，春季（3-5月）最佳。西湖周边建议骑行游览（约3小时环湖），灵隐寺需提前在公众号预约。雨天可去中国丝绸博物馆或茶叶博物馆。",
  北京: "建议游玩3-5天，秋季（9-11月）最佳。故宫需提前7天预约，周一闭馆。长城建议去慕田峪段，人少景美。",
  上海: "建议游玩2-3天，春秋季最佳。外滩建议傍晚去，可同时欣赏日景和夜景。迪士尼需提前购票，工作日人少。",
  成都: "建议游玩3-4天，春秋季最佳。大熊猫基地建议早上8点前到达，熊猫最活跃。宽窄巷子和锦里适合晚上逛。",
  深圳: "建议游玩2-3天，冬季（11-2月）最舒适。世界之窗和欢乐谷适合家庭游，南山区海岸线适合骑行。",
};

// ──────────────── 工具定义 ────────────────

export const lookupWeatherTool = tool(
  async ({ city }) => {
    const c = normCity(city);
    const w = weatherTable[c];
    return JSON.stringify(
      w
        ? { city: c, ...w }
        : {
            city: c,
            summary: "暂无该城市天气数据",
            tempHighC: 20,
            tempLowC: 12,
            aqi: "—",
            humidity: "—",
          }
    );
  },
  {
    name: "lookup_weather",
    description: "查询某城市当天的天气概况、温度区间、空气质量和湿度。",
    schema: z.object({ city: z.string().describe("城市名，如 杭州") }),
  }
);

export const lookupCityTriviaTool = tool(
  async ({ city }) => {
    const c = normCity(city);
    return JSON.stringify({
      city: c,
      trivia: triviaTable[c] ?? `没有为「${c}」准备内置小知识，可换杭州/北京/上海/成都/深圳试试。`,
    });
  },
  {
    name: "lookup_city_trivia",
    description: "查询与某城市相关的趣味知识、历史文化和景点介绍。",
    schema: z.object({ city: z.string().describe("城市名，如 杭州") }),
  }
);

export const lookupRestaurantsTool = tool(
  async ({ city, cuisine }) => {
    const c = normCity(city);
    const all = restaurantTable[c];
    if (!all) {
      return JSON.stringify({ city: c, restaurants: [], hint: "暂无该城市餐厅数据" });
    }
    const filtered = cuisine
      ? all.filter((r) => r.cuisine.includes(cuisine) || r.name.includes(cuisine))
      : all;
    return JSON.stringify({
      city: c,
      cuisine: cuisine ?? "全部",
      restaurants: filtered.length > 0 ? filtered : all,
      count: filtered.length > 0 ? filtered.length : all.length,
    });
  },
  {
    name: "lookup_restaurants",
    description: "查询某城市的餐厅推荐，可按菜系筛选。返回餐厅名称、菜系、特色菜和人均价格。",
    schema: z.object({
      city: z.string().describe("城市名，如 杭州"),
      cuisine: z.string().optional().describe("菜系筛选（可选），如 杭帮菜、川菜、火锅"),
    }),
  }
);

export const lookupTravelTipsTool = tool(
  async ({ city }) => {
    const c = normCity(city);
    return JSON.stringify({
      city: c,
      tips: travelTipsTable[c] ?? `暂无「${c}」的旅行贴士，可换杭州/北京/上海/成都/深圳试试。`,
    });
  },
  {
    name: "lookup_travel_tips",
    description: "查询某城市的旅行建议，包括最佳游玩时间、推荐天数、注意事项等。",
    schema: z.object({ city: z.string().describe("城市名，如 杭州") }),
  }
);

/** 全部工具列表 */
export const allTools = [
  lookupWeatherTool,
  lookupCityTriviaTool,
  lookupRestaurantsTool,
  lookupTravelTipsTool,
];

// ──────────────── 工具函数 ────────────────

/** 从流式结果中提取最后一条消息的文本内容 */
export function lastMessageText(result: { messages?: Array<{ content?: unknown }> }) {
  const last = result.messages?.at(-1)?.content;
  if (typeof last === "string") return last;
  return JSON.stringify(last ?? result);
}

/** 打印分隔线 */
export function printSeparator(title: string, char = "=") {
  console.log(`\n${char.repeat(72)}`);
  console.log(title);
  console.log(char.repeat(72));
}

/** 打印观察点清单 */
export function printObservations(points: string[]) {
  console.log("\n📋 观察点：");
  points.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
}
