/**
 * Step 01 — MemorySaver 的真相：为什么开发好好的，一发生产就「失忆」？
 * ============================================================================
 *
 * 【这一步解决什么问题】
 * 售后客服 Agent 在本地跑得好好的——用户报修耳机、Agent 记下工单号，
 * 多轮对话上下文连贯。可一上生产，发个版、扩个容，用户回来问「我的工单
 * 处理到哪了？」，Agent 一脸茫然。因为生产环境进程必然重启（发版/崩溃/扩缩容），
 * 而 MemorySaver 把状态存在进程内存里，进程一没，记忆全没。
 *
 * 【为什么这么设计】
 * 先让你亲眼看一次「崩」，才知道后面为什么要换 PostgresSaver。
 * 本步刻意不碰任何数据库：MemorySaver 是 LangGraph 默认 checkpointer，
 * 开箱即用，但它是「进程内对象」——和 Node 进程同生共死。
 *
 * 【收益】
 * 建立第一个心智模型：checkpointer 分「内存版」和「数据库版」；
 * 开发环境随便用内存版，生产环境必须换能跨进程存活的版本。
 *
 * 【对应官方文档】
 * - LangGraph JS Persistence（MemorySaver vs PostgresSaver）:
 *   https://docs.langchain.com/oss/javascript/langgraph/persistence
 * - MemorySaver 源码: node_modules/@langchain/langgraph-checkpoint/dist/store/memory.js
 *
 * 【跑法】pnpm run pg:step:01
 */

import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import { CUSTOMER, TICKET, createLLM, divider, lastMessageText, termsBox } from "../shared";

export async function main() {
  divider("Step 01 | MemorySaver 的真相：进程内存 = 重启即失");

  termsBox("为什么开发好好的，一发生产就失忆？", [
    ["checkpointer", "Agent 的存档点：每次对话结束把状态存到这里，下次对话从这里续上"],
    ["thread_id", "存档编号：同一编号 = 同一会话，Agent 用它对上号续档"],
    ["进程内存", "Node 进程内部的一块内存，进程退出就被操作系统回收，什么都不剩"],
  ]);

  console.log(`
📦 业务场景：${CUSTOMER.name}（${CUSTOMER.memberTier}）报修 ${TICKET.product}
  工单号 ${TICKET.id}：${TICKET.issue}
  客服 Agent 需要跨多轮对话记住这笔工单的信息。`);

  // ════════════════════ A 版：MemorySaver，同一进程内对话 ════════════════════

  console.log("\n【A 版 · 朴素方案】MemorySaver + 同一进程内连续对话");

  const llm = createLLM();
  // checkpointer: Agent 的存档点。MemorySaver 就是「存内存里的存档点」
  // 对应文档: https://docs.langchain.com/oss/javascript/langgraph/persistence
  const checkpointer = new MemorySaver();
  const agent = createReactAgent({
    llm,
    tools: [],
    checkpointSaver: checkpointer,
    prompt: `你是某电商平台的售后客服。用户会提供工单信息，请用简洁的口吻确认收到的信息，并记住当前工单（用户会在后续对话中追问进度）。`,
  });

  // 同一 thread_id = 同一会话（存档编号）
  const config = { configurable: { thread_id: TICKET.id } };

  console.log(
    `\n👤 用户：你好，我的耳机坏了，申请退款。工单号 ${TICKET.id}，订单金额 ¥${TICKET.orderAmount}。`
  );
  const r1 = await agent.invoke(
    {
      messages: [
        new HumanMessage(
          `你好，我的 ${TICKET.product} 坏了，申请退款。工单号 ${TICKET.id}，订单金额 ¥${TICKET.orderAmount}，问题：${TICKET.issue}`
        ),
      ],
    },
    config
  );
  console.log(`🤖 Agent：${lastMessageText(r1)}`);

  console.log(`\n👤 用户：好的，帮我记一下。`);

  console.log(`\n👤 用户（同会话追问）：我的工单号是多少来着？`);
  const r2 = await agent.invoke({ messages: [new HumanMessage("我的工单号是多少来着？")] }, config);
  console.log(`🤖 Agent：${lastMessageText(r2)}`);
  console.log("\n✅ 同一进程内：MemorySaver 工作正常，Agent 记得工单号。");

  // ════════════════════ 💥 模拟「生产重启」：新建一个进程（新的 MemorySaver） ════════════════════

  console.log(`
💥 模拟生产重启：发版 / 崩溃 / 扩缩容，进程被杀 → 新进程拉起
   （代码上就是：new 一个全新的 MemorySaver 实例——它和旧实例没有任何关系）`);

  // 关键：这是另一个「进程」，内存里什么都没有
  const newProcessSaver = new MemorySaver(); // ← 模拟新进程的全新内存
  const restartedAgent = createReactAgent({
    llm: createLLM(),
    tools: [],
    checkpointSaver: newProcessSaver,
    prompt: `你是某电商平台的售后客服。用户会提供工单信息，请用简洁的口吻确认收到的信息，并记住当前工单（用户会在后续对话中追问进度）。`,
  });

  console.log(`\n👤 用户（重启后回来追问）：我的工单号是多少来着？处理到哪一步了？`);
  const r3 = await restartedAgent.invoke(
    { messages: [new HumanMessage("我的工单号是多少来着？处理到哪一步了？")] },
    { configurable: { thread_id: TICKET.id } } // ← 还是同一个 thread_id！
  );
  console.log(`🤖 Agent：${lastMessageText(r3)}`);

  console.log(`
❌ 崩点：还是同一个 thread_id，但新进程的 MemorySaver 是空的——
    Agent 完全不知道这单工单。用户的体验是「客服换人了，什么都要重新说一遍」。

📌 生产结论：进程必然重启（发版、崩溃、水平扩容），内存态不可用。
   下一步（step-02）把存档点从「进程内存」挪到「数据库」，重启后就能续档。`);

  console.log("\n✅ Step 01 完成（崩点已建立，为换 PostgresSaver 提供动机）\n");
}

// 单文件直接运行时执行
if (require.main === module) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
