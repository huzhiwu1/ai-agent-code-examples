---
feishu_doc: HO3adhoQFoIu6Ax6SkPcOE6Inrf
---

# 服务一重启，Agent 就"失忆"？把状态从进程内存挪进 PostgreSQL

林女士上周报修了一副耳机，客服 Agent 记下了她的工单号 RT-2026-0826-001。第二天她回来问"我的退款到哪一步了"，Agent 一脸茫然："请问您的工单号是？"

不是你产品经理的 Agent 笨，是**状态放错了地方**。

本地开发时一切正常——你连续问它十句它都记得。因为开发时状态存在进程内存里，进程没死，记忆就在。可生产环境有三件事必然发生：

- 发版、崩溃、扩缩容 → **进程会重启**
- K8s 至少两个副本 → **请求会落到不同实例**
- 用户隔天回来 → **开的是新会话**

这三件事，内存态一个都扛不住。这篇文章就用林女士这笔退款工单当主线，一步步把 Agent 的状态从"进程内存"挪进 PostgreSQL。看完你能回答一个面试必问题：**checkpointer、store、向量库，到底各管什么？**

代码都在 `ai-agent-code-examples/articles/agent-pg-persistence/`，7 个 step 各自独立可跑，每个文件顶部注释都写清了"这一步解决什么问题 + 对应官方文档"。跑法：

```bash
# 1. 启动 PostgreSQL（含 pgvector 扩展）
docker run -d --name pgvector -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16

# 2. 仓库根目录 .env 配好 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL / EMBEDDING_*

# 3. 跑某一步（01~07 任选）
cd ~/workspace/ai-agent-code-examples && pnpm run pg:step:01
```

## 先说三个词

- **checkpointer**：Agent 的存档点。每次对话结束，框架把当时的完整状态存到这里；下次对话前先读档，就能"接着聊"。
- **thread_id**：存档编号。同一个编号 = 同一场会话，框架拿它去读对应的存档；换个编号 = 开新局。
- **进程内存**：Node 进程里的一块内存，进程退出就被操作系统回收，什么都不剩。

## 公共骨架：7 步共用的一份代码

7 个 step 的代码都不自包含，它们共用同一份"骨架"——`src/shared.ts`。下面的代码就是它的完整内容，**后面每一步的代码都默认从它 import**，不重复贴：

```typescript
// 文件：src/shared.ts（7 步共用，真实文件，完整可跑）
import pg from "pg";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import * as dotenv from "dotenv";

// 读取仓库根目录 .env（LLM_* / EMBEDDING_*）
dotenv.config({ path: "./.env", override: true });

// 本地 PG 连接串（docker 启动方式见上文）
export const DB_URI = "postgresql://postgres:postgres@localhost:5432/postgres?sslmode=disable";

// 生产要点：连接池全局唯一、复用，而不是每步 new 一个（step-07 专门讲）
export function createPool(max = 10) {
  return new pg.Pool({ connectionString: DB_URI, max });
}

// LLM 客户端：读环境变量，默认 DeepSeek
export function createLLM() {
  return new ChatOpenAI({
    model: process.env.LLM_MODEL ?? "deepseek-chat",
    apiKey: process.env.LLM_API_KEY,
    configuration: { baseURL: process.env.LLM_BASE_URL },
    temperature: 0.2,
    maxTokens: 2048,
  });
}

// Embeddings：读环境变量，默认 DashScope text-embedding-v3
export function createEmbeddings() {
  return new OpenAIEmbeddings({
    model: process.env.EMBEDDING_MODEL ?? "text-embedding-v3",
    apiKey: process.env.EMBEDDING_API_KEY,
    configuration: { baseURL: process.env.EMBEDDING_BASE_URL },
  });
}

// 业务主线：老用户林女士 8 月 27 日报修耳机，申请退款
export const CUSTOMER = {
  name: "林女士",
  userId: "user-8001",
  memberTier: "白金会员",
};

export const TICKET = {
  id: "RT-2026-0826-001",
  product: "M20 无线降噪耳机",
  orderAmount: 1299,
  issue: "左耳 8 月 27 日开始频繁断连，重置后仍然复现",
  applyTime: "2026-08-27 10:24",
};

// 售后政策知识库（step-06 用）
export const REFUND_POLICY = [
  "7 天无理由退换：自签收日起 7 天内，商品不影响二次销售，可申请无理由退款，运费由买家承担。",
  "15 天质量问题换货：自签收日起 15 天内出现非人为损坏的质量问题，可申请换货，运费由卖家承担。",
  "一年质保维修：自签收日起 1 年内出现质量问题，可免费维修；维修期间超过 7 天可选择换货。",
  "退款时效：审核通过后，退款将在 1-3 个工作日原路退回支付账户。",
  "特殊商品除外：定制类、贴身类（入耳式耳机配件）拆封后不支持无理由退换，但质量问题仍适用三包。",
];

// 取 Agent 回复的最后一条文本（7 步打印结果都用它）
export function lastMessageText(result: { messages?: Array<{ content?: unknown }> }) {
  const last = result.messages?.at(-1)?.content;
  if (typeof last === "string") return last;
  return JSON.stringify(last ?? result);
}
```

后面每个 step 我只贴"这个 step 自己新增的代码"，开头都注明它 import 了什么、哪些来自这份骨架。**想跑完整代码：直接打开 `src/steps/step-0X.ts` 就是全部。**

## Step 1 崩给你看：MemorySaver 为什么一重启就失忆

完整文件：`src/steps/step-01-memorysaver-lost.ts`

先看最朴素的方案——`MemorySaver`，LangGraph 默认的 checkpointer，开箱即用。它的问题：状态存在**当前进程的内存对象**里，进程一死，记忆全没。下面用两个 `MemorySaver` 实例模拟"发版前"和"发版后"两个进程：

```typescript
// import 新增：MemorySaver（langgraph 内置）、createReactAgent（预置 ReAct Agent）、HumanMessage（消息类型）
// 上下文：createLLM / TICKET / lastMessageText 来自上面的 shared.ts
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";

// ① 进程 1：同一个进程内连续对话
const llm = createLLM();
const agent1 = createReactAgent({
  llm,
  tools: [],
  checkpointSaver: new MemorySaver(), // checkpointer 选内存版
  prompt: "你是售后客服，记住用户提供的工单信息。",
});

// 用户报修：同一个 thread_id = 同一场会话
const config = { configurable: { thread_id: TICKET.id } };
await agent1.invoke(
  {
    messages: [
      new HumanMessage(
        `耳机坏了，申请退款。工单号 ${TICKET.id}，金额 ¥${TICKET.orderAmount}，问题：${TICKET.issue}`
      ),
    ],
  },
  config
);
const r = await agent1.invoke({ messages: [new HumanMessage("我的工单号是多少来着？")] }, config);
console.log(lastMessageText(r)); // ✅ 记得

// ② 进程 2：new 一个全新的 MemorySaver = 模拟生产重启后的空内存
//    （代码上它和进程 1 的 saver 没有任何关系，就像发版后新进程里什么都没有）
const agent2 = createReactAgent({
  llm: createLLM(),
  tools: [],
  checkpointSaver: new MemorySaver(), // ← 空存档
  prompt: "你是售后客服，记住用户提供的工单信息。",
});

// 还是同一个 thread_id，但换了"进程"
const r2 = await agent2.invoke(
  { messages: [new HumanMessage("我的工单号是多少来着？处理到哪一步了？")] },
  { configurable: { thread_id: TICKET.id } }
);
console.log(lastMessageText(r2)); // ❌ 失忆
```

真实运行结果：进程 1 记得，进程 2 全忘——

```text
👤 用户（同会话追问）：我的工单号是多少来着？
🤖 Agent：您的工单号是 RT-2026-0826-001，已为您记录。   ← 进程 1 ✅

👤 用户（"重启"后回来追问）：我的工单号是多少来着？处理到哪一步了？
🤖 Agent：您好，请提供一下您的订单号或手机号，我帮您查询工单信息哦～  ← 进程 2 ❌
```

💥 崩点：**同一个 thread_id，换了进程就全忘**。用户的体感就是"客服换人了，什么都要重新说一遍"。生产结论只有一句：进程必然重启，内存态不可用，存档点必须放在进程之外——数据库。

## Step 2 存档进 PostgreSQL：换一行代码，重启就能续档

完整文件：`src/steps/step-02-postgres-saver-basics.ts`

把 checkpointer 从 `MemorySaver` 换成 `PostgresSaver`——Agent 的图代码一字不改，只是存档点从"内存对象"变成"PG 表"：

```typescript
// import 新增：PostgresSaver（@langchain/langgraph-checkpoint-postgres 包，专门给 PG 用的 checkpointer）
// 上下文：createLLM / TICKET / DB_URI / lastMessageText 来自 shared.ts
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";

// 进程 1：setup() 自动建表（幂等，可重复调用）+ 首次对话
const saver1 = PostgresSaver.fromConnString(DB_URI); // 从连接串创建（内部自带连接池）
await saver1.setup(); // 首次使用必须调用：建 checkpoints 等表
const agent1 = createReactAgent({
  llm: createLLM(),
  tools: [],
  checkpointSaver: saver1, // ← 唯一变化：内存版 → 数据库版
  prompt: "你是售后客服，记住用户提供的工单信息。",
});
await agent1.invoke(
  {
    messages: [
      new HumanMessage(
        `我的 ${TICKET.product} 坏了，申请退款。工单号 ${TICKET.id}，金额 ¥${TICKET.orderAmount}。`
      ),
    ],
  },
  { configurable: { thread_id: TICKET.id } }
);

// 模拟进程退出：关掉 saver 内部的连接池
await saver1.end();

// 进程 2："新进程"重连同一个数据库 → 状态还在
const saver2 = PostgresSaver.fromConnString(DB_URI);
await saver2.setup(); // 表已存在，幂等
const agent2 = createReactAgent({
  llm: createLLM(),
  tools: [],
  checkpointSaver: saver2,
  prompt: "你是售后客服。",
});
const res = await agent2.invoke(
  { messages: [new HumanMessage("我的工单号是多少来着？处理到哪一步了？")] },
  { configurable: { thread_id: TICKET.id } } // 同一个 thread_id
);
console.log(lastMessageText(res)); // ✅ 记得
```

真实运行结果：新进程不仅记得工单号，还记得"仍在处理中"——状态是从数据库完整恢复的：

```text
👤 用户（重启后回来）：我的工单号是多少来着？处理到哪一步了？
🤖 Agent：您的工单号是 RT-2026-0826-001，目前仍在处理中，暂无新进展。有结果我会第一时间通知您。
```

跑完真的去库里看一眼（step-02 会打印），checkpoints 表长这样：

```text
表 checkpoints 的列结构：
  • thread_id            text
  • checkpoint_ns        text
  • checkpoint_id        text
  • parent_checkpoint_id text
  • type                 text
  • checkpoint           jsonb
  • metadata             jsonb
```

这个 thread 的存档记录（每轮对话 = 一代 checkpoint）：

```text
[1]  checkpoint_id=1f1a69e9…  source=input  step=-1  blob数=24
[2]  checkpoint_id=1f1a69e9…  source=loop  step=0   blob数=24
[3]  checkpoint_id=1f1a69e9…  source=loop  step=1   blob数=24
[12] checkpoint_id=1f1a69ef…  source=loop  step=10  blob数=24
```

答案是**三张表分工**，不是一张大表：

- `checkpoints`：每代存档的"目录"（thread_id + checkpoint_id + 元信息）
- `checkpoint_writes`：每步节点的中间写入
- `checkpoint_blobs`：messages 等 channel 的实际内容（序列化按版本存）

这就是"重启还能续档"的物理基础：**记忆不在进程里，在数据库里**。

## Step 3 流程跑到一半崩了：checkpointer 存的不是聊天记录，是执行进度

完整文件：`src/steps/step-03-multi-step-recovery.ts`

Step 2 只证明了"聊天记录能恢复"。但生产里的 Agent 常常在跑一条多步业务流——林女士的退款要走"提交工单 → 审核 → 打款"。假设审核刚通过、打款在等支付网关人工确认时，服务重启了。重启后该**从头再来**，还是**从断点继续打款**？

答案取决于 checkpointer 存了什么。这里不再用黑盒的 ReAct Agent，而是显式定义一个 `StateGraph`——图状态（TicketState）就是一笔工单的完整生命周期变量：

```typescript
// import 新增：Annotation/START/END/StateGraph/Command/interrupt/messagesStateReducer（langgraph 核心）
//          PostgresSaver、HumanMessage/SystemMessage/BaseMessage（消息类型）
// 上下文：createLLM / TICKET / DB_URI 来自 shared.ts
import {
  Annotation,
  START,
  END,
  StateGraph,
  Command,
  interrupt,
  messagesStateReducer,
} from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { HumanMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";

// ── 图状态：一笔退款工单的完整生命周期变量 ──
const TicketState = Annotation.Root({
  ticketId: Annotation<string>,
  status: Annotation<string>, // submitted → approved → paid
  reviewNote: Annotation<string>, // 审核意见（中间变量）
  refundId: Annotation<string>, // 打款流水号（中间变量）
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer }),
});

// ── 节点 1：提交工单（登记工单信息） ──
function submitTicketNode(_state: typeof TicketState.State) {
  return { ticketId: TICKET.id, status: "submitted" };
}

// ── 节点 2：审核（LLM 出意见 + 规则判定，写入中间变量 reviewNote） ──
async function reviewTicketNode(_state: typeof TicketState.State) {
  const ai = await createLLM().invoke([
    new SystemMessage("你是售后审核员。基于用户描述给出审核意见，一句话。"),
    new HumanMessage(
      `商品: ${TICKET.product}，金额: ¥${TICKET.orderAmount}，问题: ${TICKET.issue}`
    ),
  ]);
  const approved = TICKET.orderAmount < 2000; // 规则：小额且非定制类 → 自动通过
  return {
    status: approved ? "approved" : "rejected",
    reviewNote: `审核意见：${String(ai.content).trim()}（规则判定：${approved ? "通过" : "拒绝"}）`,
  };
}

// ── 节点 3：打款 —— interrupt() 在这里暂停并存档，等外部指令 ──
async function payoutNode(_state: typeof TicketState.State) {
  const decision = interrupt("支付网关确认：是否继续打款？");
  return { status: "paid", refundId: `REF-${Date.now().toString(36).toUpperCase()}` };
}

// ── 组装图：submit → review → payout（编译时挂 checkpointer） ──
function buildGraph(checkpointer: PostgresSaver) {
  return new StateGraph(TicketState)
    .addNode("submit_ticket", submitTicketNode)
    .addNode("review_ticket", reviewTicketNode)
    .addNode("payout", payoutNode)
    .addEdge(START, "submit_ticket")
    .addEdge("submit_ticket", "review_ticket")
    .addEdge("review_ticket", "payout")
    .addEdge("payout", END)
    .compile({ checkpointer });
}
```

第一次运行：提交、审核都执行完，`payout` 跑到 `interrupt()` 暂停——这不是崩溃，是"等外部输入"，暂停瞬间的进度已经落库：

```typescript
// 进程 1：跑到 payout 的 interrupt 暂停点停下
const saver1 = PostgresSaver.fromConnString(DB_URI);
await saver1.setup();
const graph1 = buildGraph(saver1);
const config = { configurable: { thread_id: TICKET.id } };
await graph1.invoke(
  { messages: [new HumanMessage(`申请退款：${TICKET.product}，${TICKET.issue}`)] },
  config
);
// ⏸️ 暂停时进度：提交 ✅ → 审核 ✅ → 打款 ⏸️（进程随后退出）

// 用 getState 读一下存档：中间变量 + 下一步待办都在库里
const snap = await graph1.getState(config);
// 🔍 真实输出：
//   • ticketId    = RT-2026-0826-001
//   • status      = approved
//   • reviewNote  = 审核意见：符合7天质量问题退货政策，建议同意退货。（规则判定：通过）
//   • next 待执行 = ["payout"]   ← "未完成的任务"也存起来了
await saver1.end(); // 进程退出
```

进程 2 启动后，同一个 thread_id + `Command({ resume })` 把外部指令传给暂停点——**已完成的 submit/review 绝不重跑，只有 payout 从断点接着执行**：

```typescript
// 进程 2：向暂停点传入"同意打款"，从断点恢复
const saver2 = PostgresSaver.fromConnString(DB_URI);
await saver2.setup();
const graph2 = buildGraph(saver2);
const res = await graph2.invoke(new Command({ resume: "同意打款" }), config);
```

真实运行结果：

```text
🚀 进程 2 启动（支付网关确认指令已到），同一个 thread_id，继续跑：
  ▶ [节点] payout —— 收到打款指令: 同意打款

📦 续跑结果：submit 未重跑 ✅ / review 未重跑 ✅ / 只有 payout 从断点接着执行
  • 最终 status = paid，refundId = REF-MTJRYH5F
```

这就是生产里 human-in-the-loop（人工审批、异步回调）的地基：**已完成的节点绝不重跑，未完成的接着执行**。没有断点续跑的话，审核节点会重跑一遍（白烧一次 LLM 调用），人工审过的单子还可能重复出单。

## Step 4 多实例共享状态：没有共享存档，就没有水平扩展

完整文件：`src/steps/step-04-multi-instance-shared.ts`

生产没有"单实例"这回事。林女士第一条消息被负载均衡打到 pod-a，第二条打到 pod-b——两个 pod 各有一个 `MemorySaver`，谁也看不见谁：

```typescript
// import 新增：MemorySaver、PostgresSaver、createReactAgent、HumanMessage
// 上下文：createLLM / TICKET / DB_URI / lastMessageText 来自 shared.ts
import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";

// 注意：prompt 里【不】含任何工单信息——工单细节只能来自对话历史（checkpoint）
const AGENT_PROMPT =
  "你是某电商平台的售后客服，请简洁回答用户问题。不知道的信息要坦白说不知道，不要编造。";

// ── A 版：MemorySaver 双实例 = 两个 pod 各存各的 ──
const agentA = createReactAgent({
  // pod-a
  llm: createLLM(),
  tools: [],
  checkpointSaver: new MemorySaver(), // pod-a 的私有内存
  prompt: AGENT_PROMPT,
});
const agentB = createReactAgent({
  // pod-b
  llm: createLLM(),
  tools: [],
  checkpointSaver: new MemorySaver(), // pod-b 的私有内存（和 pod-a 毫无关系）
  prompt: AGENT_PROMPT,
});

// 消息 1 打到 pod-a
await agentA.invoke(
  {
    messages: [
      new HumanMessage(
        `你好，我的 ${TICKET.product} 坏了，申请退款，工单号 ${TICKET.id}，金额 ¥${TICKET.orderAmount}，问题：${TICKET.issue}。`
      ),
    ],
  },
  { configurable: { thread_id: `${TICKET.id}-mem` } }
);
// 消息 2 打到 pod-b —— 同一个 thread_id！
const rB = await agentB.invoke(
  { messages: [new HumanMessage("我的工单是什么商品？金额多少？")] },
  { configurable: { thread_id: `${TICKET.id}-mem` } }
);
console.log(lastMessageText(rB));
```

真实运行结果：pod-b 完全不记得上一轮 pod-a 收的工单——状态断裂实锤：

```text
🤖 pod-b：您好，请问您能提供一下您的订单号或工单编号吗？我需要这些信息才能帮您查询具体的商品和金额。
```

换成 PostgresSaver 后，两个 pod 连**同一张 checkpoint 表**（两个独立连接池、同一个数据库），pod-a 写的存档 pod-b 照样读：

```typescript
// ── B 版：PostgresSaver 双实例 = 两个 pod 连同一张表 ──
const saverA = PostgresSaver.fromConnString(DB_URI); // pod-a 的连接池
const saverB = PostgresSaver.fromConnString(DB_URI); // pod-b 的连接池
await saverA.setup();
await saverB.setup();

const agentP = createReactAgent({
  llm: createLLM(),
  tools: [],
  checkpointSaver: saverA,
  prompt: AGENT_PROMPT,
}); // pod-a
const agentQ = createReactAgent({
  llm: createLLM(),
  tools: [],
  checkpointSaver: saverB,
  prompt: AGENT_PROMPT,
}); // pod-b

await agentP.invoke(
  {
    messages: [
      new HumanMessage(
        `你好，我的 ${TICKET.product} 坏了，申请退款，工单号 ${TICKET.id}，金额 ¥${TICKET.orderAmount}。`
      ),
    ],
  },
  { configurable: { thread_id: `${TICKET.id}-pg` } }
);
const rQ = await agentQ.invoke(
  { messages: [new HumanMessage("我的工单是什么商品？金额多少？处理到哪一步了？")] },
  { configurable: { thread_id: `${TICKET.id}-pg` } }
);
console.log(lastMessageText(rQ));
```

真实运行结果：pod-a 写的存档，pod-b 照样读，连工单状态都能查到——状态连续 ✅：

```text
🤖 pod-b：您好，根据工单RT-2026-0826-001，商品是M20无线降噪耳机，申请退款金额为¥1299。
目前该工单状态显示为"待审核"……
```

这一步是"生产为什么必须 DB 持久化"最硬核的理由——**不是为了防重启，是为了支撑水平扩展**。状态外置后，Agent 变成无状态 worker：实例随便加、随便重启，谁处理都一样。

## Step 5 短时记忆和长时记忆是两回事：checkpointer + store

完整文件：`src/steps/step-05-longterm-memory.ts`

前四步解决的是"这场会话内"的连续性。但林女士这周开新会话（新 thread_id）来问进度，Agent 还认不认识她这个**白金会员**？checkpointer 管不了——它按 thread 分档，会话结束档案就归档了。先看只有 checkpointer 的 A 版有多失忆：

```typescript
// import 新增：MemorySaver、PostgresStore（长时记忆）、DynamicTool（自定义工具）、HumanMessage
// 上下文：createLLM / CUSTOMER / TICKET / DB_URI / lastMessageText 来自 shared.ts
import { MemorySaver } from "@langchain/langgraph";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { DynamicTool } from "@langchain/core/tools";
import { HumanMessage } from "@langchain/core/messages";

// ── A 版：只有 checkpointer，没有 store ──
const agentA = createReactAgent({
  llm: createLLM(),
  tools: [],
  checkpointSaver: new MemorySaver(),
  prompt: "你是售后客服，简洁回答。不知道的要说不知道。",
});

// 会话 A（thread-A）：用户自报家门
await agentA.invoke(
  {
    messages: [
      new HumanMessage(
        `你好，我是${CUSTOMER.name}，${CUSTOMER.memberTier}，工单 ${TICKET.id} 的申请人。请优先人工客服帮我跟进。`
      ),
    ],
  },
  { configurable: { thread_id: `${TICKET.id}-A` } }
);
// 会话 B（thread-B，全新会话）：问"我是谁"
const rA2 = await agentA.invoke(
  { messages: [new HumanMessage("我是谁？什么会员等级？")] },
  { configurable: { thread_id: `${TICKET.id}-B` } } // 新 thread_id = 空白档案
);
console.log(lastMessageText(rA2));
```

真实运行结果：**新会话 = 空白档案**——

```text
🤖 会话 B：您好，我是售后客服，无法查看您的个人信息和会员等级。
建议您登录APP在"我的"页面查看，或提供订单号以便查询……
```

LangGraph 的标准答案是**双层记忆**：checkpointer 管短时（会话内），`store` 管长时（按用户跨会话）。store 是个 KV：`namespace` 像文件夹，`key` 像文件名。生产用 `PostgresStore` 落库，再通过两个工具让 Agent 自己读写画像：

```typescript
// ── B 版：checkpointer（短时）+ PostgresStore（长时），各管一摊 ──
const STORE_NAMESPACE = ["customers", CUSTOMER.userId]; // 每个用户一个"格子"
const PROFILE_KEY = "profile";

const store = PostgresStore.fromConnString(DB_URI); // 长时记忆落库
await store.setup();

// 写记忆工具：Agent 在对话中把用户画像写入 store
const saveProfileTool = new DynamicTool({
  name: "save_customer_profile",
  description:
    '保存用户画像（会员等级、偏好等），必须传入 JSON 字符串，如 {"memberTier":"白金会员"}。',
  func: async (input: string) => {
    await store.put(STORE_NAMESPACE, PROFILE_KEY, JSON.parse(input));
    return "已保存到用户画像";
  },
});

// 读记忆工具：Agent 回答身份问题前先查 store
const loadProfileTool = new DynamicTool({
  name: "load_customer_profile",
  description: "读取用户画像（会员等级、偏好等），返回 JSON。",
  func: async () => {
    const item = await store.get(STORE_NAMESPACE, PROFILE_KEY);
    return item ? JSON.stringify(item.value) : "暂无画像";
  },
});

// 挂上 store 的 Agent
const agentB = createReactAgent({
  llm: createLLM(),
  tools: [saveProfileTool, loadProfileTool],
  checkpointSaver: new MemorySaver(), // 短时记忆照旧（演示用内存版即可）
  store, // ← 关键：长时记忆挂到 Agent 上
  prompt:
    "当用户告知会员等级/偏好时，调用 save_customer_profile 保存画像。回答涉及用户身份/会员信息前，先调用 load_customer_profile 查画像，再作答。",
});

// 会话 A：自报家门 → Agent 调用保存工具，画像落库
await agentB.invoke(
  {
    messages: [
      new HumanMessage(
        `你好，我是${CUSTOMER.name}，${CUSTOMER.memberTier}，工单 ${TICKET.id} 的申请人，喜欢优先人工客服。请记住我。`
      ),
    ],
  },
  { configurable: { thread_id: `${TICKET.id}-B1` } }
);

// 会话 B（全新 thread_id）：不认识？查 store 就认识了
const rB2 = await agentB.invoke(
  { messages: [new HumanMessage("我是谁？什么会员等级？能优先处理我的工单吗？")] },
  { configurable: { thread_id: `${TICKET.id}-B2` } }
);
console.log(lastMessageText(rB2));
```

真实运行结果——store 里已存画像，新会话靠查 store 认出老用户：

```text
🔍 store 里已存: {"name":"林女士","ticketId":"RT-2026-0826-001","memberTier":"白金会员","preference":"优先人工客服"}

🤖 会话 B：您好，林女士！根据您的画像信息，我为您确认如下：
  姓名：林女士 / 会员等级：白金会员 / 工单号：RT-2026-0826-001 / 偏好：优先人工客服
  ……（完整回复较长已节选）
```

代码里还做了"断开 store 连接 → 重连再读"的验证——真实运行结果：`重启后 store.get → {"name":"林女士","ticketId":"RT-2026-0826-001","memberTier":"白金会员","preference":"优先人工客服"}`，长时记忆跨重启仍在。**判断标准记牢**：数据跟着"会话"走放 checkpointer，跟着"用户"走放 store。生产里两者可以共库分表，生命周期各自管理（会话结束可清理 checkpoint，用户画像长期保留）。

## Step 6 知识库也得持久化：向量进 PG，政策才不会重启就丢

完整文件：`src/steps/step-06-vector-knowledge.ts`

Agent 要回答"我这个耳机能退吗、运费谁出"，靠检索售后政策。政策文档要是以 embedding 存在内存版 `MemoryVectorStore`，重启照样归零——和 Step 1 一个道理。生产方案是 `PGVectorStore`：向量直接存进 PostgreSQL 的 pgvector 扩展，和业务数据同库同事务：

```typescript
// import 新增：PGVectorStore / DistanceStrategy（@langchain/pgvector）
// 上下文：REFUND_POLICY / createEmbeddings / createPool 来自 shared.ts
import { PGVectorStore, DistanceStrategy } from "@langchain/pgvector";

// 第一步：写入政策文档（initialize 自动建向量表，幂等）
const store = await PGVectorStore.initialize(createEmbeddings(), {
  postgresConnectionOptions: {
    type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    user: "postgres",
    password: "postgres",
    database: "postgres",
  },
  tableName: "refund_policy_kb",
  columns: {
    idColumnName: "id",
    vectorColumnName: "embedding",
    contentColumnName: "content",
    metadataColumnName: "metadata",
  },
  distanceStrategy: "cosine" as DistanceStrategy,
  // ⚠️ dimensions 必须和 embedding 模型实际输出维度一致（text-embedding-v3 = 1024），对不上写入报错
  dimensions: 1024,
});

// 第二步：把 5 条售后政策写入向量库
const docs = REFUND_POLICY.map((text, i) => ({
  pageContent: text,
  metadata: { ruleId: `R-${i + 1}`, category: "退款政策" },
}));
await store.addDocuments(docs);

// 第三步：相似度检索
const hits = await store.similaritySearch("耳机买来 3 天就坏了，能换吗？", 2);
```

跑 `pnpm run pg:step:06`，真实输出长这样（含"断开重连"验证）：

```text
[写入] 5 条售后政策已存入 PGVectorStore（表 refund_policy_kb）

🔍 检索「耳机买来 3 天就坏了，能换吗？」：
  [1] 特殊商品除外：定制类、贴身类（入耳式耳机配件）拆封后不支持无理由退换，但质量问题仍适用三包。
  [2] 15 天质量问题换货：自签收日起 15 天内出现非人为损坏的质量问题，可申请换货，运费由卖家承担。

🔌 断开 PGVectorStore 连接（模拟重启）...

🚀 重启后重新连接，检索「退款多久到账？」：
  [1] 退款时效：审核通过后，退款将在 1-3 个工作日原路退回支付账户。
  [2] 7 天无理由退换：自签收日起 7 天内，商品不影响二次销售，可申请无理由退款，运费由买家承担。

✅ 重启后向量数据仍在——知识库持久化成功！
```

小提醒：5 条小语料上相似度区分度有限（"3 天坏了"先命中了特殊商品条款），生产语料到几百上千条后，HNSW 索引 + 更大语料下的排序才有区分意义——但"重启后检索不丢"这个结论是稳的。

数据库工程师视角还有一课：**生产必须建 ANN 索引，否则每次检索都是全表扫描**，几百万行时直接卡死：

```sql
-- HNSW：精度高、无训练期，生产首选（数据量 < 1000 万推荐）
CREATE INDEX ON refund_policy_kb USING hnsw (embedding vector_cosine_ops);

-- ivfflat：训练期需要数据、召回略低，但内存占用小（备选）
CREATE INDEX ON refund_policy_kb USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- 注意：索引距离函数必须和查询距离策略一致（cosine → vector_cosine_ops）
```

扒开这张向量表，四列分工（真实运行结果）：

```text
表 refund_policy_kb 的列结构：
  • id          uuid
  • content     text
  • metadata    jsonb
  • embedding   USER-DEFINED（pgvector 的 vector 类型）
```

至此三层记忆全部落库：会话状态（checkpointer）、用户画像（store）、知识（向量库）。最后一层是"上线以后会不会炸"。

## Step 7 demo 到生产的最后一公里：连接池 / 清理 / 幂等 / 降级

完整文件：`src/steps/step-07-production-hardening.ts`

状态、记忆、知识都落库了，但 demo 能跑 ≠ 生产能上线。四个加固点：

**① 连接池全局复用。** 数据库连接很贵（TCP + 鉴权），不能每请求 new 一个。生产里这个 pool 在服务启动时创建一次，所有请求/所有 Agent 共用：

```typescript
// import 新增：pg、PostgresSaver、createReactAgent、HumanMessage
// 上下文：TICKET / createLLM / createPool 来自 shared.ts
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import pg from "pg";

const pool = createPool(); // 全局唯一，服务启动时创建
// 直接把共享 pool 传给 PostgresSaver 构造函数（而不是 fromConnString 内部再建一个）
const saver = new PostgresSaver(pool);
await saver.setup();
console.log("✅ 共享连接池 + PostgresSaver 组装完成");
```

**② checkpoint 要清理。** 表按 thread 无限增长会拖垮性能。API 级按需删 + SQL 级定时批量清：

```typescript
// 方式 A：API 级删除（按 thread_id，例如用户注销/工单完结归档时调用）
await saver.deleteThread(`${TICKET.id}-done-1`);
```

```sql
-- 方式 B：SQL 级批量清理（TTL 任务，生产里 cron 每夜跑一次）
-- 每会话只保留最新 50 代 checkpoint，控制表体量不膨胀
DELETE FROM checkpoints c USING (
  SELECT thread_id, checkpoint_id,
         row_number() OVER (PARTITION BY thread_id ORDER BY checkpoint_id DESC) AS rn
  FROM checkpoints
) ranked
WHERE ranked.thread_id = c.thread_id
  AND ranked.checkpoint_id = c.checkpoint_id
  AND ranked.rn > 50;
```

真实运行结果：清理前 checkpoints 表共 **26 行** → `deleteThread` 删掉 1 个完结会话 → SQL 批量清理后剩 **23 行**。

**③ 副作用要幂等。** 用户手滑重发、消息队列重放，退款不能退两次。最可靠的做法不是代码里 if 判断，而是 DB 唯一约束兜底——`ticket_id` 做主键，同一工单第二次 INSERT 必然撞唯一约束：

```typescript
// 业务表：ticket_id 主键 = 同一工单只允许一笔打款（DB 层面保证）
await pool.query(`
  CREATE TABLE IF NOT EXISTS refund_payments (
    ticket_id TEXT PRIMARY KEY,
    refund_id TEXT NOT NULL,
    paid_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

const payOnce = async (ticketId: string) => {
  try {
    await pool.query(`INSERT INTO refund_payments (ticket_id, refund_id) VALUES ($1, $2)`, [
      ticketId,
      `REF-${Date.now().toString(36).toUpperCase()}`,
    ]);
    return "✅ 打款成功";
  } catch (err) {
    // 唯一约束冲突（23505）= 这笔工单已经打过款 → 幂等命中，直接跳过
    if ((err as { code?: string }).code === "23505")
      return "♻️ 重复请求，检测到已打款，跳过（幂等）";
    throw err;
  }
};

console.log(await payOnce(TICKET.id)); // 第 1 次：用户正常发起
console.log(await payOnce(TICKET.id)); // 第 2 次：手滑重发（网络重试/双击）
console.log(await payOnce(TICKET.id)); // 第 3 次：消息队列重放
```

真实运行结果：第 1 次打款成功，第 2、3 次都命中唯一约束被跳过：

```text
[第 1 次] 支付请求：工单 RT-2026-0826-001
→ ✅ 打款成功
[第 2 次] 用户手滑重发（网络重试/双击）：同一个 RT-2026-0826-001
→ ♻️ 重复请求，检测到已打款，跳过（幂等）
[第 3 次] 消息队列重放：还是同一个 RT-2026-0826-001
→ ♻️ 重复请求，检测到已打款，跳过（幂等）
```

（Agent 侧同理：重放同一输入时，用 checkpoint_id 从存档恢复，不重跑节点。）

**④ DB 挂了要降级，别裸奔 500。** 连接失败要捕获、要告警、要给用户明确话术，而不是让异常穿透到前端。下面故意连一个不存在的端口（59999）模拟 DB 故障：

```typescript
// 模拟：生产故障切换时 DB 短暂不可达（故意连不存在的端口）
const brokenPool = new pg.Pool({
  connectionString: "postgresql://postgres:postgres@localhost:59999/postgres?sslmode=disable",
});
const brokenSaver = new PostgresSaver(brokenPool);
const degradedAgent = createReactAgent({
  llm: createLLM(),
  tools: [],
  checkpointSaver: brokenSaver,
  prompt: "你是某电商平台的售后客服，请简洁回答。",
});

try {
  await degradedAgent.invoke(
    { messages: [new HumanMessage("我的退款到哪一步了？")] },
    { configurable: { thread_id: `${TICKET.id}-degraded` } }
  );
} catch (err) {
  // 生产代码在这里：① 触发告警（AlertManager/日志告警）
  //                   ② 返回降级话术给用户
  //                   ③ 请求进重试队列，DB 恢复后配合幂等表自动补处理
  // 注意：pg 连接失败常抛 AggregateError（message 为空，详情在 .errors 数组里）
  const aggregate = (err as { errors?: Array<{ message: string }> }).errors;
  const firstLine =
    aggregate?.map((e) => e.message).find((m) => m.trim()) ??
    String((err as Error).message)
      .split("\n")
      .find((l) => l.trim()) ??
    String((err as Error).message);
  console.log(`💥 数据库连接失败：${firstLine}`);
  // → 降级话术：「系统正在升级维护，您的工单 RT-2026-0826-001 已记录，请稍后重试或联系人工客服。」
} finally {
  await brokenPool.end();
}
```

真实运行结果：异常被捕获，日志里是 `💥 数据库连接失败：connect ECONNREFUSED ::1:59999`——此时走降级话术，而不是把 500 甩给用户。

七步走完，回顾一下这条主线：**失忆（内存）→ 存档进 PG → 断点续跑 → 多实例共享 → 长短记忆分层 → 知识库持久化 → 生产加固**。现在可以放心把自己的 Agent 从 MemorySaver 换成 PostgreSQL 了。

## 总结

Agent "失忆"的根因是状态放进了进程内存。生产里进程必然重启、实例必然扩容、用户必然开新会话，所以存档点必须外置到数据库——`MemorySaver` 换成 `PostgresSaver` 只改一行代码，换来的是重启不丢、断点续跑、多实例共享。

但持久化不等于"一张表存聊天记录"：checkpointer 存的是整张图的状态（中间变量 + 未完成任务），所以多步业务流能从 `interrupt()` 的暂停点精确续跑；`store` 按用户存跨会话事实，和 thread 无关；向量知识库用 pgvector 同库持久化，生产记得建 HNSW 索引。

选型时记住一句话：**数据跟着会话走 → checkpointer；跟着用户走 → store；跟着内容走 → 向量库**。最后别忘生产四件套：连接池复用、checkpoint 清理、副作用幂等、DB 故障降级。

## 面试考点

- **MemorySaver 和 PostgresSaver 有什么区别？为什么生产必须用后者？** MemorySaver 把 checkpoint 存在进程内存，重启即丢、多实例不共享；PostgresSaver 存进 PostgreSQL 表，重启/扩容后仍能按 thread_id 恢复。[参考文档：LangGraph JS Persistence]
- **checkpointer 到底存了什么？** 不是只有聊天记录，而是整张图的状态：各 channel 的值（含 messages）、中间业务变量，以及 `next`（未完成的任务列表）——这正是断点续跑和 human-in-the-loop 能实现的原因。[参考文档：LangGraph JS Human-in-the-loop / 作者归纳]
- **interrupt() 和 Command({ resume }) 是怎么配合实现断点续跑的？** interrupt() 在节点里暂停并保存 checkpoint（含待执行任务）；重启后新实例用同一个 thread_id + Command({ resume: value }) 向暂停点传外部输入，已完成的节点不重跑，从暂停节点继续。[参考文档：LangGraph JS Human-in-the-loop]
- **checkpointer 和 store 的区别？** checkpointer 是短时记忆，按 thread_id 隔离，管会话内连续性；store 是长时记忆，按 namespace + key（通常带 user_id）存跨会话稳定事实。生产两层都挂。[参考文档：LangGraph JS Memory]
- **PGVectorStore 生产化要注意哪两点？** ① dimensions 必须和 embedding 模型实际输出维度对齐（对不上写入直接报错）；② 必须建 ANN 索引（HNSW/ivfflat），且索引距离函数要和查询距离策略一致，否则全表扫描。[参考文档：langchain-pgvector README / 作者归纳]
- **Agent 状态持久化方案里，幂等为什么必须靠 DB 而不是代码判断？** 网络重试、消息重放、用户双击都会产生重复请求，代码层判断有竞态窗口；用带唯一约束的表（同 key 只生效一次）是数据库层面的原子保证。[作者归纳，来自 step-07 演示]

## 参考来源

- [LangGraph JS：Persistence（MemorySaver vs PostgresSaver、三张 checkpoint 表）](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [LangGraph JS：Memory（checkpointer 短时 / store 长时）](https://docs.langchain.com/oss/javascript/langgraph/memory)
- [LangGraph JS：Human-in-the-loop（interrupt / Command resume）](https://docs.langchain.com/oss/javascript/langgraph/human-in-the-loop)
- [LangGraph JS：State（自定义状态与 StateGraph）](https://docs.langchain.com/oss/javascript/langgraph/state)
- [@langchain/langgraph-checkpoint-postgres（setup / fromConnString / 表结构）](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-postgres)
- [@langchain/pgvector（initialize / columns / distanceStrategy / 建索引）](https://github.com/langchain-ai/langchainjs/tree/main/libs/langchain-pgvector)
- [pgvector 官方：HNSW / ivfflat / 距离策略](https://github.com/pgvector/pgvector#indexing)
