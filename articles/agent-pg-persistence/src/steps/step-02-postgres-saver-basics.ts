/**
 * Step 02 — 换 PostgresSaver：把存档点从进程内存挪进数据库
 * ============================================================================
 *
 * 【这一步解决什么问题】
 * step-01 的崩点：进程一重启，MemorySaver 里存的工单对话全没了。
 * 生产环境进程必然重启，所以存档点必须放在「进程之外」——最自然的选择就是数据库。
 * 本步把 checkpointer 换成 PostgresSaver，并第一次扒开 checkpoint 表，
 * 看看 Agent 的状态到底以什么形式存在数据库里。
 *
 * 【为什么这么设计】
 * 持久化 = 状态写到磁盘/数据库，重启后还能「续档」。PostgresSaver 是 LangGraph
 * 官方的 PostgreSQL checkpointer：本质就是一张表（checkpoints），按 thread_id
 * 存一串 checkpoint JSON。换它只需要改一行代码（MemorySaver → PostgresSaver），
 * 但换来的是「进程可以随便重启」。
 *
 * 【收益】
 * 1. 亲眼看「重启后还记得」的 ✅（断开连接模拟重启，重连后状态仍在）
 * 2. 第一次 SELECT checkpoint 表，知道 Agent 状态在库里长什么样
 * 3. 理解 setup() 建表是首次使用必需的一步
 *
 * 【对应官方文档】
 * - @langchain/langgraph-checkpoint-postgres README（setup / fromConnString / 表结构）:
 *   https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-postgres
 * - LangGraph JS Persistence:
 *   https://docs.langchain.com/oss/javascript/langgraph/persistence
 *
 * 【跑法】pnpm run pg:step:02（需要本地 Docker PG 已启动）
 */

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import {
  CUSTOMER,
  TICKET,
  DB_URI,
  createLLM,
  createPool,
  divider,
  lastMessageText,
  termsBox,
} from "../shared";

export async function main() {
  divider("Step 02 | 换 PostgresSaver：状态存进数据库，重启也能续档");

  termsBox("把存档点从内存挪到数据库，是什么感觉？", [
    ["PostgresSaver", "基于 PostgreSQL 的 checkpointer：Agent 状态写到 PG 表里，进程死了状态不丢"],
    ["setup()", "第一次使用前调用：自动建好 checkpoint 相关的表（幂等，可重复调用）"],
    ["checkpoint 表", "本质是一张表：thread_id + 一串 checkpoint JSON（对话历史、图状态都在这）"],
  ]);

  console.log(`
📦 业务场景：${CUSTOMER.name} 的工单 ${TICKET.id} 还在处理中，
  客服系统今晚要发版（进程会重启）。要求：发版后用户回来追问进度，Agent 必须还记得这笔工单。`);

  // ════════════════════ A 版：还是 MemorySaver（step-01 已崩，这里快速回顾） ════════════════════

  console.log("\n【A 版 · 回顾】MemorySaver：状态在进程内存 → 发版即丢（step-01 已验证）");
  console.log("  进程 = 服务实例；内存 = 实例私有。实例没了，内存跟着没了。");

  // ════════════════════ B 版：PostgresSaver，状态进数据库 ════════════════════

  console.log(`
【B 版 · 生产方案】PostgresSaver：状态写进 PostgreSQL → 进程随便重启`);

  // ── 第一轮：建表 + 首次对话 ──
  // fromConnString: 从连接串创建 PostgresSaver（内部自带连接池）
  // 对应文档: https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-postgres
  const saver1 = PostgresSaver.fromConnString(DB_URI);
  // setup(): 首次使用必须调用，自动建表（checkpoints / checkpoint_blobs / checkpoint_writes）
  // 对应源码: dist/index.js 的 setup()
  await saver1.setup();
  console.log("  [setup] checkpoint 表已就绪（幂等，重复调用无副作用）");

  const agent1 = createReactAgent({
    llm: createLLM(),
    tools: [],
    checkpointSaver: saver1,
    prompt: `你是某电商平台的售后客服。用户会提供工单信息，请用简洁的口吻确认收到的信息，并记住当前工单（用户会在后续对话中追问进度）。`,
  });

  const config = { configurable: { thread_id: TICKET.id } };

  console.log(
    `\n👤 用户：我的 ${TICKET.product} 坏了，申请退款。工单号 ${TICKET.id}，金额 ¥${TICKET.orderAmount}。`
  );
  await agent1.invoke(
    {
      messages: [
        new HumanMessage(
          `我的 ${TICKET.product} 坏了，申请退款。工单号 ${TICKET.id}，订单金额 ¥${TICKET.orderAmount}，问题：${TICKET.issue}`
        ),
      ],
    },
    config
  );
  console.log(`👤 用户：记好了，我明天再来问进度。`);

  console.log(`\n🔌 断开数据库连接（模拟进程被杀 / 发版）...`);
  // end(): 关闭 saver 内部的连接池，模拟进程退出
  await saver1.end();

  // ── 第二轮：重建实例（模拟新进程）→ 状态竟然还在 ──
  console.log(`\n🚀 新进程启动，重新连接 PostgreSQL...`);
  const saver2 = PostgresSaver.fromConnString(DB_URI);
  await saver2.setup(); // 表已存在，setup 是幂等的，可再调（也为了展示这句）
  const agent2 = createReactAgent({
    llm: createLLM(),
    tools: [],
    checkpointSaver: saver2,
    prompt: `你是某电商平台的售后客服。用户会提供工单信息，请用简洁的口吻确认收到的信息，并记住当前工单（用户会在后续对话中追问进度）。`,
  });

  console.log(`\n👤 用户（重启后回来）：我的工单号是多少来着？处理到哪一步了？`);
  const res = await agent2.invoke(
    { messages: [new HumanMessage("我的工单号是多少来着？处理到哪一步了？")] },
    { configurable: { thread_id: TICKET.id } }
  );
  console.log(`🤖 Agent：${lastMessageText(res)}`);
  console.log("\n✅ 重启后 PostgresSaver 从数据库恢复状态，Agent 还记得这笔工单！");

  // ── 展示 checkpoint 表结构：状态在库里到底长什么样 ──
  console.log(`
🔍 扒开 checkpoint 表看看——Agent 的「记忆」在数据库里长什么样：`);

  const pool = createPool();
  // checkpoints 表：thread_id + checkpoint 元数据 + 序列化后的状态
  // 对应源码: dist/sql.js（表结构定义）
  const tableInfo = await pool.query(`
    SELECT column_name, data_type, character_maximum_length
    FROM information_schema.columns
    WHERE table_name = 'checkpoints'
    ORDER BY ordinal_position`);
  console.log("  表 checkpoints 的列结构：");
  for (const col of tableInfo.rows) {
    console.log(
      `    • ${col.column_name.padEnd(22)} ${col.data_type}${col.character_maximum_length ? `(${col.character_maximum_length})` : ""}`
    );
  }

  // 该 thread 存了几代 checkpoint（每轮对话 = 一代存档）
  // 注意：消息内容等 channel 数据不在这张表，而在 checkpoint_blobs / checkpoint_writes
  const cpRows = await pool.query(
    `SELECT c.checkpoint_id,
            c.metadata->>'source' AS source,
            c.metadata->>'step'  AS step,
            (SELECT count(*) FROM checkpoint_blobs b
              WHERE b.thread_id = c.thread_id AND b.checkpoint_ns = c.checkpoint_ns) AS blobs
     FROM checkpoints c WHERE c.thread_id = $1 ORDER BY c.checkpoint_id`,
    [TICKET.id]
  );
  console.log(`\n  thread ${TICKET.id} 的存档记录（每轮对话 = 一代 checkpoint）：`);
  cpRows.rows.forEach((r, i) => {
    console.log(
      `    [${i + 1}] checkpoint_id=${String(r.checkpoint_id).slice(0, 8)}…  ` +
        `source=${r.source ?? "—"}  step=${r.step ?? "—"}  blob数=${r.blobs ?? 0}`
    );
  });
  console.log(`
  说明：状态不是一张大表，而是三张表分工——
    • checkpoints：每代存档的「目录」（thread_id + checkpoint_id + 元信息）
    • checkpoint_writes：每步的中间写入（节点输出）
    • checkpoint_blobs：messages 等 channel 的实际内容（序列化后按版本存储）
  这就是「重启后还能续档」的物理基础——记忆不在进程里，在数据库里。`);

  await pool.end();
  await saver2.end();

  console.log(
    "\n✅ Step 02 完成：一行代码（MemorySaver → PostgresSaver）+ 一次 setup()，换来重启不丢状态\n"
  );
}

// 单文件直接运行时执行（被 index.ts import 时不重复执行）
if (require.main === module) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
