---
feishu_doc: TcU1dAmLnoqyg5xectYcLUXun7d
---

# 多 Agent 协同生产级实战：从单 Agent 痛点走向 Planner-Worker-Reviewer

> 这不是一篇"概念罗列"的文章，而是一份**生产级多 Agent 编排的操作手册**。
> 9 个可独立运行的 Step，覆盖从"单 Agent 为什么会翻车"到"并行扇出 + 预算熔断 + 程序化质量校验 + Trace 可观测性"的完整链路。
> 文中所有"坑"都是在本仓库真实运行 DeepSeek 实测踩出来的——你在生产上大概率也会遇到同样的坑。

## 先别急着拆团队：单 Agent 为什么会翻车

很多人一上来就想把"查天气、查知识、写总结、做路由"全塞进一个 Agent 里。可真写起来你就会发现，它不是更强，而是更乱：一个 prompt 里职责太多，工具一多就选错，上下文还会互相干扰。

LangChain 官方 Benchmark（Benchmarking Multi-Agent Architectures，Tau-bench）给出了量化证据：**单 Agent 的性能随工具/上下文数量增加急剧下降**——即使新增的上下文与当前任务完全无关（"distractor"），单 Agent 也会被带偏。这正是多 Agent 系统存在的主要动机：**上下文缩放**。

但这篇文章要讲的重点是：**多 Agent 本身不是银弹**。多 Agent 引入的协调开销（路由成本、交接成本、Token 冗余、错误级联）是实打实的。业内统计：多 Agent 系统 Token 冗余率 53%~86%（Galileo 实测：MetaGPT 72% / CAMEL 86% / AgentVerse 53%），约 30% 的 Agent 项目 PoC 后被放弃（行业估算）。所以本教程的每一步都在教你**怎么控制这些开销**。

## 先认识公共骨架：所有 Step 都依赖这段代码

后面 9 个 Step 的代码片段，会反复用到下面这些定义。它们集中在一个文件里（真实仓库就是 `src/shared.ts`），我把它拆成 4 块：**依赖、LLM 初始化、内置数据表、四个工具**。每个 Step 的代码都默认沿用这段骨架，只展示自己新增的部分。

```typescript
// ========== 公共骨架（真实文件：src/shared.ts）==========

// ① 依赖：langchain（createAgent/tool）+ langgraph-supervisor（createSupervisor）+ zod（工具入参校验）
import "dotenv/config";
import * as path from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { createSupervisor } from "@langchain/langgraph-supervisor";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, tool } from "langchain";
import { z } from "zod";

// ② 环境变量 + LLM 初始化（仓库根目录 .env 里配 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL）
const API_KEY = process.env.LLM_API_KEY ?? "";
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.LLM_MODEL ?? "deepseek-chat";

const llm = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  configuration: { baseURL: BASE_URL },
  temperature: 0.1,
  maxTokens: 1024,
  maxRetries: 2, // 生产级：LLM 瞬时失败（429/5xx）自动重试，最多 2 次
});

// ③ 内置数据表：模拟"真实数据源"，工具只查表，不调外部 API
// 真实仓库覆盖 5 个城市（杭州/北京/上海/成都/深圳），这里只列 3 个示意，其余同构省略
interface WeatherData {
  summary: string;
  tempHighC: number | null; // 查不到的字段为 null，而不是编造默认值
  tempLowC: number | null;
  aqi: string | null;
  humidity: string | null;
}

const weatherTable: Record<string, WeatherData> = {
  杭州: { summary: "多云转小雨", tempHighC: 22, tempLowC: 15, aqi: "良", humidity: "78%" },
  北京: { summary: "晴", tempHighC: 26, tempLowC: 12, aqi: "轻度污染", humidity: "35%" },
  上海: { summary: "阴", tempHighC: 20, tempLowC: 16, aqi: "良", humidity: "72%" },
  // 成都 / 深圳：结构同构，省略
};

const triviaTable: Record<string, string> = {
  杭州: "西湖文化景观是世界文化遗产之一。",
  北京: "故宫是世界上现存规模最大的古代宫殿建筑群之一。",
  上海: "外滩万国建筑博览群是近代城市历史的缩影。",
  // 成都 / 深圳：省略
};

// ④ 四个工具（Step 01 会全部塞给一个 Agent，之后逐步拆给专精 Agent）
const lookupWeatherTool = tool(
  async ({ city }: { city: string }) => {
    const w = weatherTable[city.trim()];
    // 查不到城市 → 返回 null 字段，让下游 Agent 能区分"没数据"和"数据就是 0"
    return JSON.stringify(
      w
        ? { city, ...w }
        : {
            city,
            summary: "暂无该城市天气数据",
            tempHighC: null,
            tempLowC: null,
            aqi: null,
            humidity: null,
          }
    );
  },
  {
    name: "lookup_weather",
    description: "查询某城市当天的天气概况、温度区间、空气质量和湿度。",
    schema: z.object({ city: z.string().describe("城市名，如 杭州") }),
  }
);
// lookup_city_trivia / lookup_restaurants / lookup_travel_tips 三个工具同构，省略
//（省略原因：它们只是"查另一张表 + 换一个 name/description/schema"，不带来新的学习点）
```

记住这套骨架就够了，后面每个 Step 我只贴"新增/变化的部分"。

## Step 01：一个 Agent 背四个工具，先把痛点照出来

**为什么这么做：**不是因为这更好，而是为了把单 Agent 的上限先照出来。工具越多，System Prompt 越长，Agent 越容易在"该查天气还是该查餐厅"这种事上犹豫——这正是 LangChain Benchmark 里"上下文缩放"失效的微观体现。

```typescript
// 上下文：llm / allTools 来自公共骨架
const megaAgent = createAgent({
  name: "mega_agent",
  model: llm,
  tools: allTools,
  systemPrompt: `你是一个万能旅行助手，可以处理以下所有类型的请求：
- 天气查询：使用 lookup_weather 工具
- 城市知识/景点介绍：使用 lookup_city_trivia 工具
- 餐厅推荐：使用 lookup_restaurants 工具
- 旅行贴士：使用 lookup_travel_tips 工具

注意：用户可能同时问多个问题，你需要逐一调用对应工具，确保所有需求都被满足。`,
});
```

**实测结果：**单 Agent 确实能一次性答全天气、景点、美食、贴士，但这是"能跑"，不是"可靠"。**面试要点：单 Agent 适合 System Prompt < 500 字、工具 < 5 个的场景；超过这个阈值，工具选择准确率开始下降。**

## Step 02：先手动交接一次，理解 Handoff 是什么

**为什么这么做：**先不谈 Supervisor，先把最朴素的"谁负责这件事"跑通。这里的 Handoff 还是人工版：先判断意图，再把请求交给对应 Agent。这也是**职责边界（Single Responsibility）**的第一次实践——每个 Agent 只拿一个工具，只干一件事。

```typescript
const weatherAgent = createAgent({
  name: "weather_agent",
  model: llm,
  tools: [lookupWeatherTool],
  systemPrompt: "你只处理天气查询。必须先调用 lookup_weather，再用中文简要说明天气情况。",
});
// triviaAgent 同构：只拿 lookup_city_trivia，systemPrompt 换成"只讲城市知识和景点"，其余一样

/**
 * routeIntent(query) —— 手动 Router：只负责"意图分类"，不负责回答
 * @param query 用户原始输入
 * @returns "weather"（天气类）| "trivia"（知识类）| "unknown"（其他）
 *
 * 职责边界：Router 只"选人"，回答交给子 Agent —— 这就是 Step 03 Supervisor 的雏形
 * 实现三步（完整代码见 src/steps/step-02-handoff.ts）：
 *   ① 构造路由 SystemPrompt：要求模型只输出一个词，不解释
 *   ② llm.invoke([prompt, new HumanMessage(query)])：普通 LLM 调用，不带工具
 *   ③ 返回文本转小写后做字符串匹配（模型输出不可控，所以用 includes 而不是 ===）
 */
async function routeIntent(query: string): Promise<"weather" | "trivia" | "unknown"> {
  // 实现省略（原因）：本 Step 的看点不是 Router 怎么写，而是"交接"这个动作本身——
  // 上面注释里的三步足以复现；真实代码不超过 15 行
}
```

Router 只负责分类，Handoff 还差"交接"这个动作——选好人之后，由主流程手动调用对应 Agent 的图：

```typescript
// 手动 Handoff：Router 选好人后，代码直接调用对应 Agent 的图
if (intent1 === "weather") {
  const result = await weatherAgent.graph.invoke({
    messages: [new HumanMessage(query1)], // 交接物只有一条原始消息——"裸交接"
  });
  console.log("🤖 weather_agent 回答：", lastMessageText(result).slice(0, 150));
}
```

**本节重点：Handoff = 分类 + 交接两个动作。交接时只传了"原始消息"，没有任何协议字段（谁发的、要什么结果、有什么约束，全都没有）——这就是手工交接的脆弱点，也是文末 A2A 小节要补的东西。**

**实测结果：**纯天气问题和纯知识问题都能准确交接；但"天气 + 景点"这种复合查询，Router 只能选一个方向，另一个需求被丢掉。**手动 Handoff 能跑，但不够聪明。**

## Step 03：Supervisor 自动路由 + 防循环（本文第一个实测大坑）

**为什么这么做：**Supervisor 不负责回答，它只负责选人；而且它可以在一轮结束后再回来继续选人，所以复合任务终于能"先天气、再知识"地串起来。

```typescript
// 上下文：weatherAgent / triviaAgent / llm 来自公共骨架
const workflow = createSupervisor({
  agents: [weatherAgent.graph, triviaAgent.graph],
  llm,
  supervisorName: "supervisor",
  includeAgentName: "inline",
  // DeepSeek 兼容：避免 tool_calls 配对校验失败（见下文"实测踩坑"）
  addHandoffMessages: false,
  addHandoffBackMessages: false,
  prompt: `你是调度员（Supervisor），只负责选人，不要自己回答问题。

你的子 Agent：
- weather_agent：查天气、气温、下雨、空气质量
- trivia_agent：讲城市小知识、景点、历史、文化

规则：
1. 每次只调用一个 Agent
2. 如果用户问天气 → 调 weather_agent
3. 如果用户问知识 → 调 trivia_agent
4. 如果用户同时问天气 + 知识 → 先调 weather_agent，再调 trivia_agent
5. 绝对不要重复调用同一个 Agent，每个 Agent 最多调用一次
6. 绝对不要自己编造数据，必须交给子 Agent 处理`,
});
```

**这段代码要看懂的是（函数名 / 节点名都是真实仓库里的名字）：**

- `createSupervisor()` 是调度器工厂，不是回答器：它生成一张图，里面有 `supervisor`（调度员节点）和子 Agent 节点（`weather_agent` / `trivia_agent`）
- `agents` 里放的是子 Agent 图，不是工具列表
- `prompt` 是软规则，能指导但不能拦截
- `addHandoffMessages: false` 是为了去噪 + 兼容 DeepSeek

**职责边界（这一步的架构骨架）：**

- Supervisor 只做"选人"：读用户消息 → 输出下一个要调用的 Agent 名，不自己报气温、不讲百科
- 子 Agent 只做"干活"：各自只拿一个工具，只答自己领域的问题
- **缺席的职责**：没有谁负责"检查任务是否已完成"——防重复调用只能靠 prompt 第 5 条，这是软约束，也正是循环的土壤

**本节重点：Supervisor 引入了"调度"这个新角色，但整张图里没有任何状态字段记录"已调度过谁"，防循环只能靠 prompt。Step 05 会用 visitedAgents 状态字段把这件事变成硬约束。**

**⚠️ 实测大坑 1：循环是概率性的，没有软配置能根治（本文最重要的发现）**

用默认配置跑复合查询，执行路径经常会变成：

```
supervisor → weather_agent → supervisor → weather_agent → ...（循环 9 次）
```

**根因**：Supervisor 每轮都从用户原始消息重新推导计划，历史里的子 Agent 回答不足以让它确认"该任务已完成"，于是反复重新调度同一个 Agent，直到耗尽 recursion limit 或模型放弃后自己编答案。

**我们做过完整的对照实验（同配置多次运行）**：

| 方案                                    | 实测结果                                             |
| --------------------------------------- | ---------------------------------------------------- |
| `outputMode: "last_message"`（默认）    | 循环 6~9 次（多次复现）                              |
| `outputMode: "full_history"`            | 有时 1 次通过，有时循环 9 次 —— 降低概率但**不稳定** |
| 顺序式 Prompt（"先调 X 再调 Y"）        | 同上，降低概率但不稳定                               |
| Prompt 加"检查历史"规则                 | 无效（模型不遵守）                                   |
| preModelHook 注入已调度清单             | 表现最好，但仍是软约束，不保证                       |
| **visitedAgents 状态硬约束（Step 05）** | **100% 防重复调度（代码层拦截）**                    |

**生产级结论：**

1. `createSupervisor` 的软配置（outputMode / prompt 措辞）只能**降低循环概率**，不能根治——模型随机性很大
2. 生产防循环必须上**硬约束**：Step 05 的 visitedAgents（确定性任务分配）或 Step 07 的预算/轮数熔断
3. `recursion_limit`（默认 25）只是最后的安全网，25 步已经烧了很多钱

## Step 04：状态传递与上下文管理（Token 成本意识）

**为什么这么做：**如果天气结果能进入历史，后续推荐就能带条件。`outputMode: "full_history"` 让餐厅 Agent 能看到天气 Agent 输出了什么——这就是**状态传递**。

```typescript
// 上下文：weatherAgent / restaurantAgent 来自上一段
const workflow = createSupervisor({
  agents: [weatherAgent.graph, restaurantAgent.graph],
  llm,
  outputMode: "full_history", // 关键：完整对话历史传给子 Agent
  addHandoffMessages: false,
  addHandoffBackMessages: false,
  prompt: `你是调度员。根据用户请求选择合适的 Agent：

你的子 Agent：
- weather_agent：查天气、气温、是否下雨
- restaurant_agent：推荐餐厅，会根据天气情况调整策略

规则：
1. 如果用户先问天气再问餐厅 → 先调 weather_agent 再调 restaurant_agent
2. 如果用户只问餐厅 → 直接调 restaurant_agent
3. 所有需求满足后输出 FINISH
4. 不要自己回答问题，交给子 Agent 处理`,
});
```

**这里讲的是“状态怎么流”：**

- `full_history` 让后一个 Agent 看到前一个 Agent 做了什么
- 这就是 Agent 间的状态传递
- 状态越多，token 越贵，所以只在有依赖时值得开

**生产级要点（本 Step 会真实打印 token 消耗）：**

- `full_history` 的代价是 Token 更高：每次路由决策都要携带完整历史
- 多 Agent 系统 Token 冗余率 53%~86%（实测数据：MetaGPT 72% / CAMEL 86%）
- **上下文去噪**：LangChain 官方 Benchmark 发现，移除交接消息（与消息转发、工具命名等改进一起）让 Supervisor 在 Tau-bench 上性能提升近 50%——上下文噪声对模型可靠性的影响远超直觉（本仓库 `addHandoffMessages: false` 同时兼做了这件事）
- 生产级取舍：**依赖链场景用 full_history，独立任务用 last_message 省 Token**

**代码里可以省略的部分（省略原因）：**两个子 Agent 的定义与 Step 02/03 完全同构，唯一区别是 `restaurantAgent` 的 systemPrompt 要求它"先看历史里的天气结果再推荐"。本 Step 真正新增的只有两处：`outputMode: "full_history"` 这一行配置，以及统计函数 `sumTokenUsage(messages)`——它把每条 AI 消息的 `usage_metadata.total_tokens` 累加，打印真实的 Token 消耗。

**本节重点：状态传递 = 让后一个 Agent 能读到前一个 Agent 的输出；它的代价是 Token。开不开 full_history，取决于任务之间有没有依赖。**

## Step 05：确定性路由——手写 StateGraph + 防重复调度

**为什么这么做：**Step 03 的 createSupervisor 是黑盒。生产上你需要完全掌控路由逻辑，特别是**确定性任务分配**——这是 Galileo《10 Multi-Agent Coordination Strategies》的第一条：给任务分配 ID、记录选中的 Agent、拒绝重复分配。

```typescript
// ── State：路由决策的"硬状态"（真实文件：src/steps/step-05-deterministic-routing.ts）──
const SupervisorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    // 上下文：对话历史
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  next: Annotation<string>({ reducer: (_prev, next) => next, default: () => "supervisor" }), // 路由结果
  // 生产级：已调度记录（确定性任务分配的载体）
  visitedAgents: Annotation<string[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
});

// ── 路由决策的结构化输出：强制模型只能输出枚举值，杜绝非法节点名 ──
const RoutingDecision = z.object({
  reasoning: z.string().describe("为什么选择这个 Agent"),
  next: z.enum(["weather_agent", "trivia_agent", "FINISH"]).describe("下一个要调用的 Agent"),
});

// ── supervisorNode(state)：读状态 → 决策 → 写状态（只做路由，不回答问题）──
// 输入：SupervisorState（messages + visitedAgents）；输出：{ next, messages, visitedAgents } 增量
async function supervisorNode(state: typeof SupervisorState.State) {
  const routingLLM = llm.withStructuredOutput(RoutingDecision, { method: "functionCalling" });
  const decision = await routingLLM.invoke([systemPrompt, ...state.messages]);
  // 硬约束 1：模型若重复选择已调用过的 Agent，代码层直接强制 FINISH
  if (decision.next !== "FINISH" && state.visitedAgents.includes(decision.next)) {
    return { next: "FINISH", messages: [] };
  }
  // 硬约束 2：首轮至少先调一个，不能一上来就 FINISH
  if (decision.next === "FINISH" && state.visitedAgents.length === 0) {
    return { next: "weather_agent", messages: [], visitedAgents: ["weather_agent"] };
  }
  return {
    next: decision.next,
    messages: [],
    visitedAgents: decision.next === "FINISH" ? [] : [decision.next],
  };
}

// ── 图结构：supervisor 与两个 Agent 节点之间的边（回流边形成"决策循环"）──
new StateGraph(SupervisorState)
  .addNode("supervisor", supervisorNode)
  .addNode("weather_agent", weatherAgentNode) // 包装子 Agent：执行后返回 { next: "supervisor" }
  .addNode("trivia_agent", triviaAgentNode)
  .addEdge(START, "supervisor")
  .addConditionalEdges("supervisor", (state) => state.next, {
    weather_agent: "weather_agent",
    trivia_agent: "trivia_agent",
    FINISH: END,
  })
  .addEdge("weather_agent", "supervisor") // 回流：干完活回来继续决策
  .addEdge("trivia_agent", "supervisor");
```

**这段代码的核心是：**

- `messages` 是上下文
- `next` 是路由结果
- `visitedAgents` 是硬状态，不是提示词
- Prompt 说“不要重复调用”只是建议，`visitedAgents` 才是真拦截

**本节重点：Prompt 是软约束，状态是硬约束。**"不要重复调用"写在 Prompt 里，模型可能不遵守（Step 03 的循环就是证据）；写进 `visitedAgents` 状态里，代码层直接拦截，模型想重复也重复不了。同时 `withStructuredOutput(RoutingDecision)` 强制路由输出为枚举，杜绝模型输出非法节点名。这张手写图就是 `createSupervisor` 内部机制的拆解版——看懂它，黑盒就变白盒了。

## Step 06：质量兜底——Reflector 程序化硬校验（本文第二个实测大坑）

**为什么不能只靠 LLM 判断质量（实测踩坑）：**早期版本用纯 LLM 做质量检查，结果 Reflector 被越权的子 Agent 骗过——weather_agent 收到完整用户请求后，违反"只处理天气"指令，**顺手编了一条"小知识"**（数据表里根本没有），Reflector 看到"问题都被回答了"就判通过，trivia_agent 从头到尾没被调度，编造内容直接上线。

**教训：LLM 主观检查（"内容是否完整"）可以被编造的流畅文本骗过；生产级校验必须是可程序化验证的硬检查。**

```typescript
// ── 硬校验的依据：用户需求关键词 → 必须出现的工具调用（本 Step 只有 2 个领域）──
const REQUIREMENT_TOOL_MAP = [
  {
    keywords: ["天气", "气温", "下雨", "空气质量"],
    toolName: "lookup_weather",
    agentName: "weather_agent",
  },
  {
    keywords: ["小知识", "知识", "景点", "历史", "文化"],
    toolName: "lookup_city_trivia",
    agentName: "trivia_agent",
  },
];

// hardCheck(state): string[] —— 输入当前状态，输出问题清单（空数组 = 通过）
// 只查证据（tool 调用记录），不评文采——确定性代码逻辑，编造内容骗不过它
function hardCheck(state): string[] {
  const problems: string[] = [];
  // 用户需求 = 历史里第一条 human 消息的文本
  const userText = state.messages.find((m) => m.getType() === "human")?.content?.toString() ?? "";
  // 证据 = 历史里出现过的所有 tool 消息的名字
  const toolNames = new Set(
    state.messages.filter((m) => m.getType() === "tool").map((m) => m.name)
  );
  for (const req of REQUIREMENT_TOOL_MAP) {
    const mentioned = req.keywords.some((k) => userText.includes(k));
    if (mentioned && !toolNames.has(req.toolName)) {
      problems.push(
        `用户请求包含「${req.keywords[0]}」需求，但历史里没有 ${req.toolName} 调用记录——数据可能是编造的`
      );
    }
  }
  return problems;
}
```

**这一步的本质是“验票”：**

- `hardCheck()` 不负责文采，只负责查证据
- 证据就是 tool 调用记录
- 用户提了什么需求，就应该能在历史里找到对应工具调用

**检查逻辑：需求提到了"小知识"，但历史里没有 `lookup_city_trivia` 的工具调用记录 → 直接判不通过，回 Supervisor 重新调度。**这比"让 LLM 看内容是否完整"可靠得多：工具调用记录是确定性的，编不出来。LLM 软检查只兜底完整性和可读性（主观项），数据来源由硬校验负责（客观项）。反思上限 3 次，防止"反思→重试→再反思"本身变成死循环。

**这一步用到的其余函数/状态（名字都能在 step-06-reflection.ts 里找到）：**

| 名字                   | 角色       | 职责                                                                      |
| ---------------------- | ---------- | ------------------------------------------------------------------------- |
| `reflectorNode(state)` | 审阅者节点 | 先跑 hardCheck 硬校验，不通过写反馈回 supervisor；通过后再跑 LLM 软检查   |
| `ReflectionResult`     | zod schema | 约束软检查输出为 `{ passed, feedback }`，杜绝自由文本                     |
| `reflectionFeedback`   | 状态字段   | 质量反馈的载体：独立字段，不写进 messages（避免把控制信号伪装成用户消息） |
| `reflectionCount`      | 状态字段   | 反思计数，与 `MAX_REFLECTIONS = 3` 一起防死循环                           |

**本节重点：校验必须"可程序化验证"。工具调用记录是确定性证据，编不出来；LLM 的"看着不错"会被流畅的编造文本骗过（本节开头的实测坑）。所以硬校验管数据来源，LLM 软检查只管完整性和可读性。**

## Step 07：防失控——预算熔断 + 超时 + Trace 可观测性

**为什么需要熔断：**多 Agent 系统一次失控循环就能烧掉整月预算。业内实测 token 冗余 53%~86%，而 LangGraph 的 recursion limit 默认 25 步——**25 步已经太晚了**。生产级做法是在图里插入 Guard 节点主动熔断。

```typescript
// ── 熔断阈值（真实文件：src/steps/step-07-budget-observability.ts）──
const BUDGET_LIMITS = { maxTotalTokens: 20_000, maxRounds: 5, maxDurationMs: 90_000 };

// guardNode(state) —— 熔断器节点：输入状态，输出 { next, budgetBreaker? }
// 三个判断按顺序短路：轮数 → Token → 超时，任何一项超限都强制 FINISH
async function guardNode(state) {
  if (state.roundCount >= BUDGET_LIMITS.maxRounds) {
    return { next: "FINISH", budgetBreaker: "maxRounds" };
  }
  if (state.totalTokens >= BUDGET_LIMITS.maxTotalTokens) {
    return { next: "FINISH", budgetBreaker: "maxTokens" };
  }
  // 超时判断（省略实现）：真实代码用首条消息的 startedAt 时间戳 + Date.now() 估算整体耗时。
  // 省略原因：节点间检查无法中止一次正在挂起的 LLM 请求——生产上的真超时需要
  // 真挂钟 + AbortSignal 取消在途调用，这里用时间戳模拟足够教学用
  return { next: "supervisor" };
}
```

**这一步讲的是"什么时候必须收手"：**

- 轮数太多就停
- token 太多就停
- 不是为了把模型卡住，而是为了避免无限烧钱

**这一步用到的其余函数/状态（名字都能在 step-07-budget-observability.ts 里找到）：**

| 名字                                          | 角色     | 职责                                                                      |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `makeAgentNode(agentName, agentGraph, emoji)` | 节点工厂 | 把"执行 Agent + 记账 + 写 Trace"打包成一个节点，两个 Agent 节点都由它生成 |
| `countTokens(messages)`                       | 记账函数 | 从 AI 消息的 `usage_metadata.total_tokens` 累加本次新增 Token             |
| `traceLogs`                                   | 状态字段 | Trace 日志（谁、为什么、Token、耗时），结束时输出结构化执行报告           |
| `budgetBreaker`                               | 状态字段 | 熔断原因（正常结束为空）——复盘时一眼知道是谁拦下的                        |

**本节重点：熔断器解决的是"什么时候必须收手"——不是把模型卡住，而是避免无限烧钱。轮数/Token/超时三个阈值任何一个先到，立即 FINISH；`budgetBreaker` 记录是谁触发的，Trace 报告让你事后能复盘。**

**可观测性（生产排障的第一手资料）：**每个决策都要记录 `谁 / 为什么 / 花了多少 / 用了多久`。本 Step 会在状态里维护 `traceLogs`，结束时输出结构化执行报告：

```
轮次 1 | supervisor    | → weather_agent         | 423 tokens | 2100ms
轮次 1 | weather_agent | 执行                    | 812 tokens | 3400ms
...
```

生产落地时：Trace 写入 LangSmith / 日志系统并关联 **Trace ID**，跨 Agent 的输入输出和决策路径才能复盘——多 Agent 系统的失败“不仅常见，而且极难诊断”（Why Do Multi-Agent LLM Systems Fail，UC Berkeley，NeurIPS 2025），没有 Trace 只能抓瞎。

## Step 08：生产级综合编排——Planner-Worker-Reviewer 全链路

**把前 7 步的所有要点集成到一张图里：**Planner 拆任务 → Supervisor 调度 4 个 Worker → Reviewer 程序化硬校验 → Guard 熔断 → Trace 报告。这是 DEPART 框架（Amazon Science，NeurIPS 2025：Divide → Evaluate → Plan → Act → Reflect → Track）的工程化落地，也是 CrewAI Crew + Flows 模式在 LangGraph 上的手写实现。

```typescript
// 图结构：planner → supervisor → 4 个 Worker → reviewer → guard → supervisor / FINISH
// （真实文件：src/steps/step-08-production.ts，节点名 / 函数名与源码一一对应）
new StateGraph(ProductionState)
  .addNode("planner", plannerNode) // 角色：规划者（把用户请求拆成 taskList 任务清单）
  .addNode("supervisor", supervisorNode) // 角色：协调者（按任务清单逐个调度，防重复、防提前 FINISH）
  .addNode("weather_agent", weatherWorkerNode) // 角色：执行者（天气）
  .addNode("trivia_agent", triviaWorkerNode) // 角色：执行者（知识）
  .addNode("restaurant_agent", restaurantWorkerNode) // 角色：执行者（餐厅，依赖天气结果）
  .addNode("travel_agent", travelWorkerNode) // 角色：执行者（贴士）
  .addNode("reviewer", reviewerNode) // 角色：审阅者（硬校验工具调用记录 + 完整性检查）
  .addNode("guard", guardNode) // 角色：熔断器（预算/轮数/超时）

  .addEdge(START, "planner")
  .addEdge("planner", "supervisor")
  // supervisor 条件边：next 指向哪个 Worker 就跳哪个，FINISH 结束
  // Worker → reviewer（质量把关）→ guard（预算熔断）→ supervisor / FINISH
  // （边的细节与 Step 05/07 同构，这里省略——省略原因：本 Step 的新增点在节点职责，不在连线方式）

  // 生产级：checkpointer 持久化状态——崩溃恢复、断点续跑、时间旅行调试都靠它；
  // 教学用 MemorySaver（内存），生产换 PostgresSaver/Redis；invoke 时传 thread_id 关联会话
  .compile({ checkpointer: new MemorySaver() });
```

**这一步的关键函数（输入输出都能在源码里查到）：**

| 名字                                          | 输入                                | 输出                                                        | 职责                                                                  |
| --------------------------------------------- | ----------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `plannerNode(state)`                          | 用户消息                            | `taskList`（领域清单，如 weather/trivia/restaurant/travel） | 规划：只拆任务，不执行                                                |
| `supervisorNode(state)`                       | 状态（含 taskList / visitedAgents） | `{ next, visitedAgents }`                                   | 调度：只从"未完成"里选一个 Worker；重复调度和提前 FINISH 都被代码拦截 |
| `makeWorkerNode(nodeName, agentGraph, emoji)` | 工厂参数                            | Worker 节点函数                                             | 执行：包装 4 个 Worker，统一"执行 + 记账 + 写 Trace"                  |
| `reviewerNode(state)`                         | 状态（含 messages / taskList）      | next 为 supervisor 或 FINISH                                | 审阅：硬校验工具调用记录 + 完整性检查                                 |
| `guardNode(state)`                            | 状态（roundCount / totalTokens）    | `{ next, budgetBreaker? }`                                  | 熔断：轮数/Token/超时任一超限立即收手                                 |
| `DOMAIN_TO_AGENT`                             | —                                   | 领域 → 节点/工具映射                                        | 静态配置：Planner 清单与 Worker/工具之间的翻译表                      |

**本节重点：前 7 步的每个零件在这张图里各就各位——Planner 拆任务、Supervisor 调度、Worker 执行、Reviewer 验票、Guard 熔断。角色分工（Planner-Worker-Reviewer）的本质是"拆解 → 执行 → 校验"三段职责分离，谁都不越权。**

**实测结果：**4 个 Worker 全部按任务清单串行执行，Reviewer 验证每个领域都有真实工具调用记录后放行，最终输出一份完整的杭州三日游规划。**注意：本步是刻意串行实现——JS 版 createSupervisor 的多个 handoff Command 只有第一个生效（见"实测踩坑"第 3 条），但手写 StateGraph 完全可以用 Send API 做真并行扇出（见 Step 09）。**

## Step 09：并行扇出——Send API 让无依赖 Worker 同批并行

**为什么需要这一步：**Step 08 的 4 个 Worker 是串行的，端到端延迟随领域数线性增长。但手写 StateGraph 完全有能力并行——只要任务之间没有依赖。

**依赖分析（并行的边界）：**restaurant 依赖 weather 的结果（雨天推室内餐厅，Step 04 的依赖链），所以只能并行 weather / trivia / travel，restaurant 等第一波完成后再跑：

```
第 1 波并行：weather_agent ─┬─ trivia_agent ─┬─ travel_agent
                          │                │
                          └────────────────┴─→ 汇合（reviewer）→ 第 2 波：restaurant_agent
```

**实现核心（LangGraph Send API）：**条件边返回 `Send[]` 数组，LangGraph 在同一个 superstep 内并行执行整批节点，全部完成后再沿各自出边汇合——map-reduce 的 join 语义：

```typescript
import { Send } from "@langchain/langgraph";

// ── 依赖表：restaurant 的推荐要参考天气（雨天 → 室内），必须等 weather 先完成 ──
// 没出现在这张表里的领域都视为无依赖，可以同批并行
const DOMAIN_DEPENDENCIES: Record<string, string[]> = {
  restaurant: ["weather"],
};

// ── supervisorNode(state)（确定性调度，不需要 LLM）──
// 输入：taskList + visitedAgents；输出：{ next, currentBatch, visitedAgents, roundCount }
// 就绪批次公式：ready = 未调度 ∧ 依赖已满足（完整实现见 step-09-parallel-fanout.ts）

// ── 条件边：fanout → 返回 Send[] 并行扇出；否则 → reviewer 终检 ──
.addConditionalEdges("supervisor", (state) => {
  if (state.next !== "fanout") return "reviewer"; // 无就绪任务 → 终检
  // 返回 Send 数组 → 同一 superstep 内并行执行整批 Worker
  // 实测坑 1：Send 的 args 是目标节点的完整输入 state（不与图状态自动合并），
  //   必须显式传 Worker 需要的字段（messages + 波次号），否则节点里是 undefined
  // 实测坑 2：条件边的 edge map 必须声明所有 Send 可能指向的节点，否则编译期抛 UNREACHABLE_NODE
  return state.currentBatch.map(
    (node) => new Send(node, { messages: state.messages, roundCount: state.roundCount })
  );
}, {
  weather_agent: "weather_agent",
  trivia_agent: "trivia_agent",
  restaurant_agent: "restaurant_agent",
  travel_agent: "travel_agent",
  reviewer: "reviewer",
})
```

**这一步看的是并行边界：**

- 没依赖的任务可以同批并行
- 有依赖的任务必须等前一波完成
- `Send[]` 的目的不是炫技，而是把等待时间拆短

**核心洞见：并行调度不需要 LLM。**任务清单（Planner 输出）+ 依赖表（静态配置）+ visitedAgents（状态记录）三者都是确定性的，Supervisor 直接算出就绪批次：`ready = 未调度 ∧ 依赖已满足`。LLM 从调度层退场后，Step 03 的循环、Step 05 拦截的"提前 FINISH / 重复调度"从机制上消失——因为调度不再依赖模型输出。

**本节重点：并行的收益来自依赖图的拓扑分层——weather / trivia / travel 第 1 波并行，restaurant 等 weather 完成后第 2 波。调度公式是纯状态计算，不花 1 个 token 在路由决策上；`DOMAIN_DEPENDENCIES` 这张静态表就是并行的全部边界。**

**生产级要点（本 Step 会真实打印波次 Trace）：**

- 预算语义：一批并行 = 1 轮；各 Worker 只计自己新增消息的 token，Supervisor 调度 0 token
- 状态合并：并行 Worker 都写 messages，靠 `messagesStateReducer`（LangGraph 内置消息 reducer，支持 ID 去重与 RemoveMessage）安全合并——实测：Send 扇出场景下自定义 concat 会与内部消息通道冲突，所以这里显式换用内置 reducer
- 收益：4 个 Worker 串行 ≈ 4 段端到端延迟 → 2 波完成，墙钟时间接近减半（LLM 调用数不变）
- 依赖不可满足（如 Planner 漏了天气却列了餐厅）→ Reviewer 识别并记录，不空转
- Send 第三参数 `{ timeout }` 可给每个 Worker 挂任务级 runTimeout

**实测结果：**weather / trivia / travel 三个 Worker 第 1 波并行完成，restaurant 第 2 波单独执行，Reviewer 终检通过，输出与 Step 08 相同的杭州三日游规划，端到端等待时间显著下降。**但注意：并行不是银弹——有依赖的任务必须串行，真正的收益来自依赖图的拓扑分层。**

## 实测踩坑记录（本仓库真实踩过的坑，生产上都会遇到）

1. **调度循环（概率性问题）**：Supervisor 反复调度同一 Agent（实测 6~9 次）。软配置（outputMode/prompt）只能降低概率不能根治；修复：Step 05 的 visitedAgents 硬约束 + Step 07 熔断兜底。
2. **invalid_tool_results 400**：默认配置（`addHandoffMessages: true`）下，模型一次并行发出多个 `transfer_to_*` 调用时，多个 handoff Command 只有一个生效，其余 ToolMessage 被丢弃 → 历史里出现"有 tool_calls 但没有配对 ToolMessage"的 assistant 消息 → DeepSeek 严格校验直接 400。修复：`addHandoffMessages: false`。
3. **没有真正的并行（createSupervisor 限制）**：模型可以一次发出多个 handoff 调用（`parallel_tool_calls: false` 对 DeepSeek 无效），但 tools 节点的 control branch 只处理第一个 Command，其余被静默丢弃。所以执行路径永远是串行的 `supervisor → agent → supervisor → agent`。手写 StateGraph 则可以用 Send API 做真并行扇出（见 Step 09）。
4. **Reflector 被编造内容骗过**：子 Agent 收到完整用户请求后会越权回答其他领域的问题（编造数据），LLM 主观质量检查会被骗。修复：程序化硬校验工具调用记录。
5. **DeepSeek tool_calls 严格配对**：带 `tool_calls` 的 assistant 消息后面必须逐一响应 ToolMessage，任何"丢消息"的操作都可能触发 400——这是配置第 2、3 条所有 workaround 的根本原因。
6. **Send 的 args 不是增量合并（Step 09 实测坑）**：`new Send(node, {})` 时目标节点拿到的 state 里只有 args 中的字段，其余字段（包括 schema 默认值）都是 `undefined`——Worker 读不到 messages/roundCount，导致 `agentGraph.invoke({ messages: undefined })` 后消息 reducer 崩溃（`Cannot read properties of undefined (reading 'role')`）。修复：Send args 必须显式传目标节点需要的所有字段（如 `{ messages: state.messages, roundCount: state.roundCount }`）。
7. **条件边 edge map 漏节点（Step 09 编译期红线）**：Send 扇出的条件边，edge map 必须声明所有 Send 可能指向的节点，漏掉任何一个 Worker 都会在编译期直接抛 UNREACHABLE_NODE——不是运行时错误，是图结构红线。

## A2A：Agent 之间的协作协议——与 Supervisor/Worker 是什么关系

前面 9 步讲的都是**中心化调度**：Supervisor 是星形拓扑的中心，Worker 之间从不直接对话，所有信息流都经过 Supervisor 和共享状态。A2A（Agent-to-Agent）要补的是另一个视角：**当 Agent 之间要直接协作时，任务交接必须符合协议，而不是互相甩消息。**

先明确关系，避免把 A2A 读成"互相聊天"：

- Supervisor/Worker 解决"谁被调度、按什么顺序干活"（调度问题）
- A2A 解决"一次交接要带什么信息、谁能发起、冲突谁裁决、失败怎么回退"（协议问题）
- 两者不互斥：生产系统通常"Supervisor 负责调度，A2A 协议负责交接质量"。本仓库的 LangGraph 实现里，A2A 的协议字段落在共享状态上（`taskList` / `visitedAgents` / `traceLogs` / `reflectionFeedback`），点对点转接靠 `Command(goto=...)` 或 `Send` 实现

下面按四个问题展开，每个问题都对应到本仓库的真实代码：

### 1. 协作协议：交接要带哪些字段

Step 02 的交接是"裸交接"——`weatherAgent.graph.invoke({ messages: [new HumanMessage(query)] })`，交接物只有一条原始消息：没有任务 ID、没有上下文摘要、没有约束、没有期望输出，接收方只能靠自己猜。

生产级 A2A 交接协议建议明确以下字段（示意接口，本仓库未实现——它是 Step 02 的升级方向）：

```typescript
// A2A 交接协议字段示意（生产升级方向，当前仓库用"共享状态字段"承载同类信息）
interface TaskHandoff {
  taskId: string; // 任务唯一 ID（对应本仓库 visitedAgents 的"任务分配记录"思想）
  fromAgent: string; // 发起方
  toAgent: string; // 接收方
  contextSummary: string; // 已完成的上下文摘要（对应 traceLogs / messages 历史）
  constraints: string[]; // 约束（如"只推荐室内餐厅"）
  expectedOutput: string; // 期望输出（对应 Step 08 plannerNode 输出的 taskList）
}
```

仓库里的对应物：`taskList` 是 `expectedOutput` 的雏形（Planner 说清要什么），`traceLogs` 是 `contextSummary` 的证据（谁做过什么），`visitedAgents` 是 `taskId` 的分配记录（谁已经领过任务）。

### 2. 角色边界：谁能发起、谁能响应

"谁能做什么"必须写清楚，否则越权就是必然（Step 06 的实测坑：weather_agent 越权编了小知识）。本仓库的角色边界：

| 角色                 | 能做什么                            | 不能做什么                 |
| -------------------- | ----------------------------------- | -------------------------- |
| Planner              | 发起任务（写 taskList）             | 不执行、不裁决             |
| Supervisor           | 发起调度（写 next / visitedAgents） | 不自己回答专业问题         |
| Worker               | 响应调度（只写 messages 增量）      | 不改路由状态、不答其他领域 |
| Reviewer / Reflector | 发起裁决（读证据 → 写 next）        | 不替 Worker 补答案         |
| Guard                | 发起熔断（写 budgetBreaker）        | 不重试、不降级             |

生产上的通用写法：**发起方要声明"要什么结果"，响应方只能交付"自己领域的结果"，控制信号（next / feedback）走独立状态字段，不混进 messages**——这正是 Step 06 把 `reflectionFeedback` 从 HumanMessage 改成独立状态字段的原因（避免把控制信号伪装成用户消息）。

### 3. 冲突仲裁：结论不一致时谁拍板

多个 Agent 结果冲突时，仲裁的依据必须是**证据链**，不是"谁写得流畅"。本仓库的仲裁器是 `reviewerNode` / `reflectorNode`：

- 裁决依据：`hardCheck()` 检查"用户要求过的领域，历史里有没有对应工具调用记录"——这是确定性的证据链
- 裁决动作：硬校验不通过 → 写 `reflectionFeedback` → 回 Supervisor 重新调度（Step 06）；完整性不满足 → 继续调度（Step 08/09）
- 无人可裁决时：交给 Guard 熔断兜底（Step 07），`budgetBreaker` 记录最终裁决原因

**为什么不让 LLM 当裁判：**Step 06 的实测坑证明，LLM 主观裁判会被编造的流畅文本骗过。生产上如果一定要 Judge Agent，也要让它只对"可验证项"做裁决（有没有工具调用记录），而不是对"内容好不好"下结论。

### 4. 失败回退：某个 Agent 挂了之后怎么办

回退策略按"谁先兜住"排序，本仓库每层都有对应代码：

1. **自动重试**：`llm` 初始化时的 `maxRetries: 2`（shared.ts）——瞬时失败（429/5xx）自动重试
2. **循环保险**：Step 03 的 `recursionLimit: 14` + try/catch 捕获 `GraphRecursionError`——调度失控时优雅终止而不是崩溃
3. **预算熔断**：Step 07/08/09 的 `guardNode`——轮数/Token/超时任一超限 → FINISH + `budgetBreaker`
4. **任务级超时**：Step 09 的 Send 第三参数 `{ timeout }` 给每个 Worker 挂 runTimeout（配合 AbortSignal 实现真取消）
5. **不可满足依赖**：Step 09 的 `reviewerNode` 检测"依赖不在任务清单里"→ 记录 qualityIssues 并结束，不空转重试
6. **崩溃恢复**：Step 08/09 的 `MemorySaver` checkpointer + `thread_id`——进程崩溃后同一会话可断点续跑

生产上还应有"降级"（用备用数据源/备用 Agent）和"人工介入"（interrupt），本仓库受教学场景限制未实现——但上面 6 层已经覆盖了"重试 → 熔断 → 续跑"的完整回退链。

### 一句总原则

> A2A 的关键不是"Agent 互相聊天"，而是**协作时有协议、转接时有证据、冲突时有裁决、失败时有回退**。前面 9 步的每一步（visitedAgents、hardCheck、guard、traceLogs、checkpointer）都是在为这四件事补零件。

## 面试考点（更新版）

**1. 多 Agent 一定比单 Agent 更好吗？**
不一定。单 Agent 在简单任务（Prompt < 500 字、工具 < 5 个）下更优；多 Agent 引入路由成本、交接成本和错误级联（token 冗余 53%~86%），只在任务天然可分工、上下文需要缩放时才值得。

**2. Supervisor 的职责是什么？**
只负责路由和调度，把任务交给最合适的子 Agent，不要自己替它回答专业问题。生产上还要负责：防重复调度（visitedAgents 硬约束）、防循环（recursion limit 安全网 + 预算熔断）、按任务清单推进（Planner 协同）。

**3. 多 Agent 系统常见的生产级失败模式有哪些？**

- 调度循环（反复调度同一 Agent）→ 确定性任务分配 + 熔断
- 子 Agent 越权/编造 → 程序化硬校验工具调用记录
- 上下文冗余导致成本失控 → Token 预算熔断
- 无法诊断的级联失败 → Trace ID + 执行报告
- Prompt injection（OWASP LLM01，Agent 间通信通道）→ 运行时 guardrail

**4. 你项目里怎么做生产级落地？**
Planner-Worker-Reviewer 角色分工：Planner 拆任务清单（结构化输出），Worker 只执行领域工具（职责单一），Reviewer 做程序化校验（工具调用记录检查，不靠 LLM 主观判断），Guard 做预算/轮数/超时熔断，全程 Trace 日志可复盘。任务无依赖时用 Send API 并行扇出（依赖表 + 确定性调度，LLM 不参与路由），有依赖则按拓扑分层串行。模型选 DeepSeek 时注意 tool_calls 配对校验，关闭 handoff 消息并用 full_history 保持状态证据。

## 相关资料

- [LangGraph JS · Graph API 与 Send 并行扇出](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api)（map-reduce / fan-out 官方示例）
- [LangChain Blog · Benchmarking Multi-Agent Architectures](https://www.langchain.com/blog/benchmarking-multi-agent-architectures)（单 Agent 上下文缩放、Supervisor 性能改进）
- [Galileo · 10 Multi-Agent Coordination Strategies](https://galileo.ai/blog/multi-agent-coordination-strategies)（确定性任务分配、预算熔断、checkpoint）
- [Multi-Agent System Failure Taxonomy (MAST, arXiv 2503.13657)](https://arxiv.org/abs/2503.13657)（1600+ 失败轨迹分类）
- [LangGraph JS · Multi-Agent 概念](https://langchain-ai.github.io/langgraphjs/concepts/multi_agent/)
- [Deep Agents · Subagents](https://docs.langchain.com/oss/javascript/deepagents/subagents)
