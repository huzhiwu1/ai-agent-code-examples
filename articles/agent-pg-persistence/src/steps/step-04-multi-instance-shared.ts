/**
 * Step 04 — 两个实例同时处理一个会话：水平扩展的硬性要求
 * ============================================================================
 *
 * 【这一步解决什么问题】
 * 生产环境没有「单实例」——K8s 至少 2 个副本、多 worker 并行是常态。
 * 同一用户的两条消息，可能被负载均衡打到不同实例上。
 * MemorySaver 的存档点在各自进程内存里，两个实例各存各的 → 用户会话在两个
 * 实例间跳来跳去，上下文对不上（上一轮说的工单号，下一轮实例不知道）。
 * PostgresSaver 的存档点在同一张数据库表里 → 状态天然跨实例共享。
 *
 * 【为什么这么设计】
 * 用「两个 checkpointer 实例交替处理同一 thread」模拟两个 pod：
 * 实例 A 说一句、实例 B 接一句，看状态是否连续。这是「为什么生产一定要 DB
 * 持久化」最硬核的理由——不是为了防重启，是**支撑水平扩展**。
 *
 * 【收益】
 * 1. 理解「Agent 变成无状态 worker」：进程不存状态，状态在 DB，实例随便加
 * 2. 直观看到 MemorySaver 双实例的状态断裂 vs PostgresSaver 双实例的状态连续
 *
 * 【对应官方文档】
 * - LangGraph JS Persistence（多实例共享 checkpointer）:
 *   https://docs.langchain.com/oss/javascript/langgraph/persistence
 * - PostgresSaver 源码: node_modules/@langchain/langgraph-checkpoint-postgres/dist/index.d.ts
 *
 * 【跑法】pnpm run pg:step:04（需要本地 Docker PG 已启动）
 */

import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import { CUSTOMER, TICKET, DB_URI, createLLM, divider, lastMessageText, termsBox } from "../shared";

// 注意：prompt 里【不】含任何工单信息——工单细节只能来自对话历史（checkpoint）
const AGENT_PROMPT = `你是某电商平台的售后客服，请简洁回答用户问题。不知道的信息要坦白说不知道，不要编造。`;

export async function main() {
  divider("Step 04 | 多实例共享状态：无状态 Agent 才有水平扩展");

  termsBox("为什么多实例必须共享状态？", [
    ["多实例", "K8s 多副本 / 多 worker：同一服务的多个进程实例，负载均衡轮询分发请求"],
    ["共享状态", "所有实例连同一张 checkpoint 表，谁的进程处理都一样，状态永远连续"],
    ["无状态应用", "进程不保存任何会话数据 → 可以随便扩缩容、重启，这正是 12-factor 原则"],
  ]);

  console.log(`
📦 业务场景：客服系统扩容到 2 个实例（pod-a / pod-b）。
  ${CUSTOMER.name} 的消息被负载均衡交替分发：这条到 pod-a，下一条到 pod-b。`);

  // ════════════════════ A 版：MemorySaver 双实例 → 状态断裂 ════════════════════

  console.log(`
【A 版 · MemorySaver 双实例】两个 pod 各有一个「私有存档点」`);

  const agentA = createReactAgent({
    llm: createLLM(),
    tools: [],
    checkpointSaver: new MemorySaver(), // pod-a 的私有内存
    prompt: AGENT_PROMPT,
  });
  const agentB = createReactAgent({
    llm: createLLM(),
    tools: [],
    checkpointSaver: new MemorySaver(), // pod-b 的私有内存（和 pod-a 毫无关系）
    prompt: AGENT_PROMPT,
  });
  const threadId = `${TICKET.id}-mem`;

  console.log(
    `\n👤 用户（打到 pod-a）：你好，我的 ${TICKET.product} 坏了，申请退款，工单号 ${TICKET.id}。`
  );
  await agentA.invoke(
    {
      messages: [
        new HumanMessage(
          `你好，我的 ${TICKET.product} 坏了，申请退款，工单号 ${TICKET.id}，金额 ¥${TICKET.orderAmount}，问题：${TICKET.issue}。`
        ),
      ],
    },
    { configurable: { thread_id: threadId } }
  );
  console.log(`👤 用户（下一条打到 pod-b）：我的工单是什么商品？金额多少？`);
  const rB = await agentB.invoke(
    { messages: [new HumanMessage("我的工单是什么商品？金额多少？")] },
    { configurable: { thread_id: threadId } } // 同一个 thread_id！
  );
  console.log(`🤖 pod-b：${lastMessageText(rB)}`);
  console.log(`
💥 崩点：pod-b 的内存里没有这笔会话，完全接不上。
   用户的体验 = 每次请求都像换了个新客服。实例越多，断裂越随机。`);

  // ════════════════════ B 版：PostgresSaver 双实例 → 状态连续 ════════════════════

  console.log(`
【B 版 · PostgresSaver 双实例】两个 pod 连同一张 checkpoint 表，存档点共享`);

  // 两个实例 = 两个独立连接池，但连的是同一个数据库（同一张表）
  const saverA = PostgresSaver.fromConnString(DB_URI);
  const saverB = PostgresSaver.fromConnString(DB_URI);
  await saverA.setup();
  await saverB.setup();

  const agentP = createReactAgent({
    llm: createLLM(),
    tools: [],
    checkpointSaver: saverA, // pod-a
    prompt: AGENT_PROMPT,
  });
  const agentQ = createReactAgent({
    llm: createLLM(),
    tools: [],
    checkpointSaver: saverB, // pod-b
    prompt: AGENT_PROMPT,
  });

  const pgThread = `${TICKET.id}-pg`;

  console.log(
    `\n👤 用户（打到 pod-a）：你好，我的 ${TICKET.product} 坏了，申请退款，工单号 ${TICKET.id}。`
  );
  await agentP.invoke(
    {
      messages: [
        new HumanMessage(
          `你好，我的 ${TICKET.product} 坏了，申请退款，工单号 ${TICKET.id}，金额 ¥${TICKET.orderAmount}，问题：${TICKET.issue}。`
        ),
      ],
    },
    { configurable: { thread_id: pgThread } }
  );
  console.log(`👤 用户（下一条打到 pod-b）：我的工单是什么商品？金额多少？处理到哪一步了？`);
  const rQ = await agentQ.invoke(
    { messages: [new HumanMessage("我的工单是什么商品？金额多少？处理到哪一步了？")] },
    { configurable: { thread_id: pgThread } }
  );
  console.log(`🤖 pod-b：${lastMessageText(rQ)}`);

  console.log(`
✅ 解决：状态在数据库里，谁处理都一样——pod-a 写的存档，pod-b 照样读。
   💡 这就是生产架构的真相：Agent 变成「无状态 worker」，
     状态（checkpoint）和知识（向量库）全部外置，实例可以随便加。`);

  // 清理演示用的 thread，避免污染后续步骤
  await saverB.deleteThread(pgThread);
  await saverA.end();
  await saverB.end();

  console.log("\n✅ Step 04 完成\n");
}

// 单文件直接运行时执行（被 index.ts import 时不重复执行）
if (require.main === module) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
