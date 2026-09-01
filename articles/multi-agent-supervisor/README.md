---
feishu_doc: TcU1dAmLnoqyg5xectYcLUXun7d
---

# 多 Agent 协同生产级实战：从单 Agent 痛点走向 Planner-Worker-Reviewer

> 这不是一篇"概念罗列"的文章，而是一份**生产级多 Agent 编排的操作手册**。
> 8 个可独立运行的 Step，覆盖从"单 Agent 为什么会翻车"到"预算熔断 + 程序化质量校验 + Trace 可观测性"的完整链路。
> 文中所有"坑"都是在本仓库真实运行 DeepSeek 实测踩出来的——你在生产上大概率也会遇到同样的坑。

## 先别急着拆团队：单 Agent 为什么会翻车

很多人一上来就想把"查天气、查知识、写总结、做路由"全塞进一个 Agent 里。可真写起来你就会发现，它不是更强，而是更乱：一个 prompt 里职责太多，工具一多就选错，上下文还会互相干扰。

LangChain 官方 Benchmark（Benchmarking Multi-Agent Architectures，Tau-bench）给出了量化证据：**单 Agent 的性能随工具/上下文数量增加急剧下降**——即使新增的上下文与当前任务完全无关（"distractor"），单 Agent 也会被带偏。这正是多 Agent 系统存在的主要动机：**上下文缩放**。

但这篇文章要讲的重点是：**多 Agent 本身不是银弹**。多 Agent 引入的协调开销（路由成本、交接成本、Token 冗余、错误级联）是实打实的。业内统计：多 Agent 系统 Token 冗余率 53%~86%（Galileo 实测：MetaGPT 72% / CAMEL 86% / AgentVerse 53%），约 30% 的 Agent 项目 PoC 后被放弃（行业估算）。所以本教程的每一步都在教你**怎么控制这些开销**。

## 先认识公共骨架：所有 Step 都依赖这段代码

后面 8 个 Step 的代码片段，会反复用到下面这些定义。它们集中在一个文件里（真实仓库就是 `src/shared.ts`），我把它拆成 4 块：**依赖、LLM 初始化、内置数据表、四个工具**。每个 Step 的代码都默认沿用这段骨架，只展示自己新增的部分。

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
});

// ③ 内置数据表：模拟"真实数据源"，工具只查表，不调外部 API
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

// ④ 四个工具（Step 01 会全部塞给一个 Agent，之后逐步拆给专精 Agent）
const lookupWeatherTool = tool(
  async ({ city }: { city: string }) => {
    const w = weatherTable[city.trim()];
    return JSON.stringify(
      w ?? { city, summary: "暂无该城市数据", tempHighC: 20, tempLowC: 12, aqi: "—" }
    );
  },
  {
    name: "lookup_weather",
    description: "查询某城市当天的天气概况、温度区间和空气质量。",
    schema: z.object({ city: z.string().describe("城市名，如 杭州") }),
  }
);
// lookup_city_trivia / lookup_restaurants / lookup_travel_tips 三个工具同构，省略
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
  description: "专门查天气的子 Agent。",
  model: llm,
  tools: [lookupWeatherTool],
  systemPrompt: "你只处理天气。用户提到城市时，必须先调用 lookup_weather，再用中文简短说明。",
});

// 手动路由：先用 LLM 判断意图，再决定把请求交给哪个 Agent
async function routeIntent(query: string): Promise<"weather" | "trivia" | "unknown"> {
  /* ... */
}
```

**实测结果：**纯天气问题和纯知识问题都能准确交接；但"天气 + 景点"这种复合查询，Router 只能选一个方向，另一个需求被丢掉。**手动 Handoff 能跑，但不够聪明。**

## Step 03：Supervisor 自动路由 + 防循环（本文第一个实测大坑）

**为什么这么做：**Supervisor 不负责回答，它只负责选人；而且它可以在一轮结束后再回来继续选人，所以复合任务终于能"先天气、再知识"地串起来。

```typescript
const workflow = createSupervisor({
  agents: [weatherAgent.graph, triviaAgent.graph],
  llm,
  supervisorName: "supervisor",
  includeAgentName: "inline",
  // DeepSeek 兼容：避免 tool_calls 配对校验失败（见下文"实测踩坑"）
  addHandoffMessages: false,
  addHandoffBackMessages: false,
  prompt: `你是调度员（Supervisor）...
5. 绝对不要重复调用同一个 Agent，每个 Agent 最多调用一次`,
});
```

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
const workflow = createSupervisor({
  agents: [weatherAgent.graph, restaurantAgent.graph],
  llm,
  outputMode: "full_history", // 关键：完整对话历史传给子 Agent
  prompt: `...如果用户先问天气再问餐厅 → 先调 weather_agent 再调 restaurant_agent...`,
});
```

**生产级要点（本 Step 会真实打印 token 消耗）：**

- `full_history` 的代价是 Token 更高：每次路由决策都要携带完整历史
- 多 Agent 系统 Token 冗余率 53%~86%（实测数据：MetaGPT 72% / CAMEL 86%）
- **上下文去噪**：LangChain 官方 Benchmark 发现，移除交接消息（与消息转发、工具命名等改进一起）让 Supervisor 在 Tau-bench 上性能提升近 50%——上下文噪声对模型可靠性的影响远超直觉（本仓库 `addHandoffMessages: false` 同时兼做了这件事）
- 生产级取舍：**依赖链场景用 full_history，独立任务用 last_message 省 Token**

## Step 05：确定性路由——手写 StateGraph + 防重复调度

**为什么这么做：**Step 03 的 createSupervisor 是黑盒。生产上你需要完全掌控路由逻辑，特别是**确定性任务分配**——这是 Galileo《10 Multi-Agent Coordination Strategies》的第一条：给任务分配 ID、记录选中的 Agent、拒绝重复分配。

```typescript
const SupervisorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  next: Annotation<string>({ reducer: (_prev, next) => next, default: () => "supervisor" }),
  // 生产级：已调度记录（确定性任务分配的载体）
  visitedAgents: Annotation<string[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
});

async function supervisorNode(state) {
  const decision = await routingLLM.invoke([systemPrompt, ...state.messages]);
  // 硬约束：模型若重复选择已调用过的 Agent，代码层直接强制 FINISH
  if (decision.next !== "FINISH" && state.visitedAgents.includes(decision.next)) {
    return { next: "FINISH", messages: [] };
  }
  return { next: decision.next, messages: [], visitedAgents: [decision.next] };
}
```

**核心洞见：Prompt 是软约束，状态是硬约束。**"不要重复调用"写在 Prompt 里，模型可能不遵守（Step 03 的循环就是证据）；写进 `visitedAgents` 状态里，代码层直接拦截，模型想重复也重复不了。同时 `withStructuredOutput` 强制路由输出为枚举，杜绝模型输出非法节点名。

## Step 06：质量兜底——Reflector 程序化硬校验（本文第二个实测大坑）

**为什么不能只靠 LLM 判断质量（实测踩坑）：**早期版本用纯 LLM 做质量检查，结果 Reflector 被越权的子 Agent 骗过——weather_agent 收到完整用户请求后，违反"只处理天气"指令，**顺手编了一条"小知识"**（数据表里根本没有），Reflector 看到"问题都被回答了"就判通过，trivia_agent 从头到尾没被调度，编造内容直接上线。

**教训：LLM 主观检查（"内容是否完整"）可以被编造的流畅文本骗过；生产级校验必须是可程序化验证的硬检查。**

```typescript
// 用户需求 → 必须出现的工具调用 映射表（硬校验的依据）
const REQUIREMENT_TOOL_MAP = [
  { keywords: ["天气", "气温", "下雨"], toolName: "lookup_weather", agentName: "weather_agent" },
  { keywords: ["小知识", "知识", "景点"], toolName: "lookup_city_trivia", agentName: "trivia_agent" },
];

function hardCheck(state): string[] {
  const problems: string[] = [];
  const userText = /* 首条 human 消息 */;
  const toolNames = new Set(state.messages.filter(m => m.getType() === "tool").map(m => m.name));
  for (const req of REQUIREMENT_TOOL_MAP) {
    const mentioned = req.keywords.some(k => userText.includes(k));
    if (mentioned && !toolNames.has(req.toolName)) {
      problems.push(`用户请求包含「${req.keywords[0]}」需求，但历史里没有 ${req.toolName} 调用记录——数据可能是编造的`);
    }
  }
  return problems;
}
```

**检查逻辑：需求提到了"小知识"，但历史里没有 `lookup_city_trivia` 的工具调用记录 → 直接判不通过，回 Supervisor 重新调度。**这比"让 LLM 看内容是否完整"可靠得多：工具调用记录是确定性的，编不出来。LLM 软检查只兜底完整性和可读性（主观项），数据来源由硬校验负责（客观项）。反思上限 3 次，防止"反思→重试→再反思"本身变成死循环。

## Step 07：防失控——预算熔断 + 超时 + Trace 可观测性

**为什么需要熔断：**多 Agent 系统一次失控循环就能烧掉整月预算。业内实测 token 冗余 53%~86%，而 LangGraph 的 recursion limit 默认 25 步——**25 步已经太晚了**。生产级做法是在图里插入 Guard 节点主动熔断。

```typescript
const BUDGET_LIMITS = { maxTotalTokens: 20_000, maxRounds: 5, maxDurationMs: 90_000 };

async function guardNode(state) {
  if (state.roundCount >= BUDGET_LIMITS.maxRounds)
    return { next: "FINISH", budgetBreaker: "maxRounds" };
  if (state.totalTokens >= BUDGET_LIMITS.maxTotalTokens)
    return { next: "FINISH", budgetBreaker: "maxTokens" };
  // 超时判断省略（生产上用 checkpoint 或挂钟）
  return { next: "supervisor" };
}
```

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
// 图结构：planner → supervisor → (weather/trivia/restaurant/travel) → reviewer → guard → supervisor / FINISH
new StateGraph(ProductionState)
  .addNode("planner", plannerNode) // 角色：规划者（任务分解）
  .addNode("supervisor", supervisorNode) // 角色：协调者（按任务清单调度，防重复）
  .addNode("reviewer", reviewerNode) // 角色：审阅者（硬校验工具调用记录）
  .addNode("guard", guardNode); // 角色：熔断器（预算/轮数/超时）
// ... Worker 节点 ×4、条件边、回流边
```

**实测结果：**4 个 Worker 全部按任务清单串行执行，Reviewer 验证每个领域都有真实工具调用记录后放行，最终输出一份完整的杭州三日游规划。**注意：全程没有并行——JS 版 createSupervisor 的多个 handoff Command 只有第一个生效（见"实测踩坑"第 3 条），"并行"是概念层面的，不是运行时行为。**

## 实测踩坑记录（本仓库真实踩过的坑，生产上都会遇到）

1. **调度循环（概率性问题）**：Supervisor 反复调度同一 Agent（实测 6~9 次）。软配置（outputMode/prompt）只能降低概率不能根治；修复：Step 05 的 visitedAgents 硬约束 + Step 07 熔断兜底。
2. **invalid_tool_results 400**：默认配置（`addHandoffMessages: true`）下，模型一次并行发出多个 `transfer_to_*` 调用时，多个 handoff Command 只有一个生效，其余 ToolMessage 被丢弃 → 历史里出现"有 tool_calls 但没有配对 ToolMessage"的 assistant 消息 → DeepSeek 严格校验直接 400。修复：`addHandoffMessages: false`。
3. **没有真正的并行**：模型可以一次发出多个 handoff 调用（`parallel_tool_calls: false` 对 DeepSeek 无效），但 tools 节点的 control branch 只处理第一个 Command，其余被静默丢弃。所以执行路径永远是串行的 `supervisor → agent → supervisor → agent`。
4. **Reflector 被编造内容骗过**：子 Agent 收到完整用户请求后会越权回答其他领域的问题（编造数据），LLM 主观质量检查会被骗。修复：程序化硬校验工具调用记录。
5. **DeepSeek tool_calls 严格配对**：带 `tool_calls` 的 assistant 消息后面必须逐一响应 ToolMessage，任何"丢消息"的操作都可能触发 400——这是配置第 2、3 条所有 workaround 的根本原因。

## 面试考点（更新版）

**1. 多 Agent 一定比单 Agent 更好吗？**
不一定。单 Agent 在简单任务（Prompt < 500 字、工具 < 5 个）下更优；多 Agent 引入路由成本、交接成本和错误级联（token 冗余 53%~86%），只在任务天然可分工、上下文需要缩放时才值得。

**2. Supervisor 的职责是什么？**
只负责路由和调度，把任务交给最合适的子 Agent，不要自己替它回答专业问题。生产上还要负责：防重复调度（visitedAgents）、防循环（outputMode + recursion limit）、按任务清单推进（Planner 协同）。

**3. 多 Agent 系统常见的生产级失败模式有哪些？**

- 调度循环（反复调度同一 Agent）→ 确定性任务分配 + 熔断
- 子 Agent 越权/编造 → 程序化硬校验工具调用记录
- 上下文冗余导致成本失控 → Token 预算熔断
- 无法诊断的级联失败 → Trace ID + 执行报告
- Prompt injection（OWASP LLM01，Agent 间通信通道）→ 运行时 guardrail

**4. 你项目里怎么做生产级落地？**
Planner-Worker-Reviewer 角色分工：Planner 拆任务清单（结构化输出），Worker 只执行领域工具（职责单一），Reviewer 做程序化校验（工具调用记录检查，不靠 LLM 主观判断），Guard 做预算/轮数/超时熔断，全程 Trace 日志可复盘。模型选 DeepSeek 时注意 tool_calls 配对校验，关闭 handoff 消息并用 full_history 保持状态证据。

## 相关资料

- [LangChain Blog · Benchmarking Multi-Agent Architectures](https://www.langchain.com/blog/benchmarking-multi-agent-architectures)（单 Agent 上下文缩放、Supervisor 性能改进）
- [Galileo · 10 Multi-Agent Coordination Strategies](https://galileo.ai/blog/multi-agent-coordination-strategies)（确定性任务分配、预算熔断、checkpoint）
- [Multi-Agent System Failure Taxonomy (MAST, arXiv 2503.13657)](https://arxiv.org/abs/2503.13657)（1600+ 失败轨迹分类）
- [LangGraph JS · Multi-Agent 概念](https://langchain-ai.github.io/langgraphjs/concepts/multi_agent/)
- [Deep Agents · Subagents](https://docs.langchain.com/oss/javascript/deepagents/subagents)
