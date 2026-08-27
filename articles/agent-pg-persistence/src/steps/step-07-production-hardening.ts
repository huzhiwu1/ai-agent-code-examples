/**
 * Step 07 — 生产加固：连接池 / 数据清理 / 幂等 / 降级（总装）
 * ============================================================================
 *
 * 【这一步解决什么问题】
 * 前六步把「状态 + 记忆 + 知识」都落库了，但 demo 到生产还有最后一公里：
 *   ① 每个实例每次请求都 new 连接？→ 连接池要全局复用
 *   ② checkpoint 表无限膨胀？→ 要有清理策略（按 thread / 按时间）
 *   ③ 用户疯狂点重试、消息重发？→ 副作用要幂等
 *   ④ 数据库挂了，Agent 直接 500？→ 要优雅降级、明确报错
 *
 * 【为什么这么设计】
 * 这步不再造新机制，而是把前面所有组件「总装」成一套生产级用法，
 * 每个加固点一个小节、一段可跑的最小代码 + 一句 SQL。全部演示完，
 * 你就拿到了「demo 到生产」的完整检查清单。
 *
 * 【收益】
 * 1. 连接池：PostgresSaver 直接用共享 pg.Pool（不每次 new 连接）
 * 2. 清理：deleteThread() API + 按时间批量清理 SQL
 * 3. 幂等：DB 唯一约束兜底「同一工单只打款一次」
 * 4. 降级：DB 不可用时，错误被捕获并转成清晰的降级提示
 *
 * 【对应官方文档】
 * - PostgresSaver 源码（构造函数 / deleteThread / list）:
 *   node_modules/@langchain/langgraph-checkpoint-postgres/dist/index.d.ts
 * - LangGraph JS Persistence:
 *   https://docs.langchain.com/oss/javascript/langgraph/persistence
 *
 * 【跑法】pnpm run pg:step:07（需要本地 Docker PG 已启动）
 */

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import pg from "pg";
import { TICKET, createLLM, createPool, divider, termsBox } from "../shared";

export async function main() {
  divider("Step 07 | 生产加固总装：demo 能跑 ≠ 生产能上线");

  termsBox("上线前要补的四门课", [
    ["连接池", "数据库连接很贵（TCP + 鉴权），全局一个池子复用，而不是每次请求新建"],
    ["数据清理", "checkpoint 按 thread 无限增长：要有 TTL 归档/删除策略，否则表会拖垮性能"],
    ["幂等", "同一请求重放（重试/双击/消息重发）不能产生重复副作用：退款不能退两次"],
    ["降级", "依赖（DB）不可用时，给用户明确提示而不是裸奔 500"],
  ]);

  const llm = createLLM();

  // ════════════════════ ① 共享连接池 ════════════════════

  console.log(`
━━━ ① 连接池：全局唯一，复用 ━━━
   （生产里这个 pool 在服务启动时创建，所有请求/所有 Agent 共用）`);
  const pool = createPool();
  // 直接传 pool 给 PostgresSaver 构造函数（而不是 fromConnString 内部再建一个）
  // 对应源码: dist/index.d.ts 构造函数 constructor(pool, serde?, options?)
  const saver = new PostgresSaver(pool);
  await saver.setup();
  console.log("  ✅ 共享连接池 + PostgresSaver 组装完成（池内连接复用，不再每请求新建）");

  // ════════════════════ ② checkpoint 数据清理 ════════════════════

  console.log(`
━━━ ② 数据清理：checkpoint 不是「只写不删」的日志 ━━━`);

  // 先造 3 个「已结束的会话」供清理演示
  const agent = createReactAgent({
    llm,
    tools: [],
    checkpointSaver: saver,
    prompt: `你是某电商平台的售后客服，请简洁回答。`,
  });
  for (const tid of [`${TICKET.id}-done-1`, `${TICKET.id}-done-2`, `${TICKET.id}-done-3`]) {
    await agent.invoke(
      { messages: [new HumanMessage("已完结工单，无需回复。")] },
      { configurable: { thread_id: tid } }
    );
  }
  const before = await pool.query(`SELECT count(*)::int AS c FROM checkpoints`);
  console.log(`  [清理前] checkpoints 表共 ${before.rows[0].c} 行`);

  // 方式 A：API 级删除（按 thread_id，例如用户注销/工单完结归档时）
  await saver.deleteThread(`${TICKET.id}-done-1`);
  console.log(`  ✅ deleteThread("${TICKET.id}-done-1") 已删除（用户注销时调用）`);

  // 方式 B：SQL 级批量清理（TTL 任务，生产里 cron 每夜跑一次）
  // 注意：checkpoints 表没有内置时间列（时间戳在 checkpoint_id 的 ULID 里），
  // 生产常见做法是业务侧维护「会话活跃时间表」，这里演示等价的
  // 「每会话只保留最新 N 代存档」——控制表体量不膨胀的通用策略
  await pool.query(`
    DELETE FROM checkpoints c
    USING (
      SELECT thread_id, checkpoint_id,
             row_number() OVER (PARTITION BY thread_id ORDER BY checkpoint_id DESC) AS rn
      FROM checkpoints
    ) ranked
    WHERE ranked.thread_id = c.thread_id
      AND ranked.checkpoint_id = c.checkpoint_id
      AND ranked.rn > 50`);
  console.log(`  ✅ 批量清理：每个会话只保留最新 50 代 checkpoint（其余删除，控制表体量）`);

  const after = await pool.query(`SELECT count(*)::int AS c FROM checkpoints`);
  console.log(
    `  [清理后] checkpoints 表剩 ${after.rows[0].c} 行（其余是 step-02/03 的演示数据，同样适用此策略）`
  );

  // ════════════════════ ③ 幂等：同一请求重放不产生重复副作用 ════════════════════

  console.log(`
━━━ ③ 幂等：退款不能因为重试退两次 ━━━`);

  // 业务侧建一张「打款流水」表，request_id（这里是工单号）做主键做唯一约束
  await pool.query(`
    CREATE TABLE IF NOT EXISTS refund_payments (
      ticket_id  TEXT PRIMARY KEY,           -- 工单号唯一：同一工单只允许一笔打款
      refund_id  TEXT NOT NULL,
      paid_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const payOnce = async (ticketId: string) => {
    try {
      await pool.query(`INSERT INTO refund_payments (ticket_id, refund_id) VALUES ($1, $2)`, [
        ticketId,
        `REF-${Date.now().toString(36).toUpperCase()}`,
      ]);
      return "✅ 打款成功";
    } catch (err) {
      // 唯一约束冲突 = 这笔工单已经打过款 → 幂等命中，直接跳过
      if ((err as { code?: string }).code === "23505")
        return "♻️ 重复请求，检测到已打款，跳过（幂等）";
      throw err;
    }
  };

  console.log(`  [第 1 次] 支付请求：工单 ${TICKET.id}`);
  console.log(`  → ${await payOnce(TICKET.id)}`);
  console.log(`  [第 2 次] 用户手滑重发（网络重试/双击）：同一个 ${TICKET.id}`);
  console.log(`  → ${await payOnce(TICKET.id)}`);
  console.log(`  [第 3 次] 消息队列重放：还是同一个 ${TICKET.id}`);
  console.log(`  → ${await payOnce(TICKET.id)}`);
  console.log(`
  💡 思路：副作用操作（打款/发券/建单）落到一张带唯一约束的表，
     DB 主键/唯一索引天然保证「同 key 只生效一次」——比代码里 if 判断可靠。
     （Agent 侧同理：重放同一输入时，用 checkpoint_id 从存档恢复，不重跑节点）`);

  // ════════════════════ ④ 降级：DB 挂了，Agent 怎么办 ════════════════════

  console.log(`
━━━ ④ 降级：DB 不可用时给用户明确反馈，而不是 500 ━━━`);

  // 模拟：生产故障切换时 DB 短暂不可达（故意连一个不存在的端口）
  const brokenPool = new pg.Pool({
    connectionString: "postgresql://postgres:postgres@localhost:59999/postgres?sslmode=disable", // ← 不存在的端口，模拟 DB 故障
  });
  const brokenSaver = new PostgresSaver(brokenPool);
  const degradedAgent = createReactAgent({
    llm,
    tools: [],
    checkpointSaver: brokenSaver,
    prompt: `你是某电商平台的售后客服，请简洁回答。`,
  });

  try {
    await degradedAgent.invoke(
      { messages: [new HumanMessage("我的退款到哪一步了？")] },
      { configurable: { thread_id: `${TICKET.id}-degraded` } }
    );
  } catch (err) {
    // 生产里这里接告警（alert），并返回降级话术给用户
    // 注意：pg 连接失败常抛 AggregateError（message 为空，详情在 .errors 数组里）
    const aggregate = (err as { errors?: Array<{ message: string }> }).errors;
    const firstLine =
      aggregate?.map((e) => e.message).find((m) => m.trim()) ??
      String((err as Error).message)
        .split("\n")
        .find((l) => l.trim()) ??
      String((err as Error).message);
    console.log(`  💥 数据库连接失败：${firstLine.slice(0, 80)}`);
    console.log(`
  ✅ 降级处理（生产代码里应做的事）：
     • 捕获异常 → 触发告警（AlertManager / 日志告警）
     • 返回降级话术：「系统正在升级维护，您的工单 ${TICKET.id} 已记录，
       请稍后重试或联系人工客服。」
     • 请求进入重试队列，DB 恢复后自动补处理（配合上一条幂等表，重试安全）`);
  } finally {
    await brokenPool.end();
  }

  // ── 收尾清理 ──
  await pool.query(`DROP TABLE IF EXISTS refund_payments`);
  await pool.end();

  console.log(`
✅ Step 07 完成：连接池复用 + TTL 清理 + 幂等兜底 + 优雅降级，
   「能跑」和「能上线」之间的最后一步补齐了。`);

  console.log(`
🎯 七步回顾（一条主线）：
   step-01 崩点：MemorySaver 重启失忆
   step-02 存档进 PG：PostgresSaver + checkpoint 表
   step-03 断点续跑：checkpointer 存的是执行进度（状态机）
   step-04 多实例共享：无状态 worker + 共享状态 = 水平扩展
   step-05 双层记忆：短时 checkpointer + 长时 store（PostgresStore）
   step-06 知识库持久化：PGVectorStore + HNSW 索引
   step-07 生产加固：连接池 / 清理 / 幂等 / 降级
   → 现在可以放心把自己的 Agent 从 MemorySaver 换成 PostgreSQL 了\n`);
}

// 单文件直接运行时执行（被 index.ts import 时不重复执行）
if (require.main === module) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
