/**
 * Step 06 — 售后政策知识库：向量也得持久化，否则重启后检索全没了
 * ============================================================================
 *
 * 【这一步解决什么问题】
 * 前几步把「对话状态」和「用户记忆」落库了，但 Agent 要回答「这个商品能不能
 * 退款？」还得查售后政策——政策文档以 embedding 向量存在内存里的 MemoryVectorStore
 * 时，重启后知识库也归零。生产里知识库必须持久化：PGVectorStore 把向量直接存进
 * PostgreSQL（pgvector 扩展），和业务数据同库同事务，重启后检索照常。
 *
 * 【为什么这么设计】
 * 用「售后政策」当知识库内容，完整走一遍：
 *   写入 5 条政策 → 相似度检索 → 断开连接（模拟重启）→ 重连 → 检索仍在。
 * 最后从数据库工程师视角扒开向量表结构 + 给出生产必备的 HNSW 索引 SQL。
 *
 * 【收益】
 * 1. 理解 PGVectorStore = 向量也进 PG，知识库随业务库一起备份/扩容
 * 2. 看懂向量表长什么样（id / content / metadata / vector 四列）
 * 3. 知道生产必须建 HNSW/ivfflat 索引，否则检索是全表扫描
 *
 * 【对应官方文档】
 * - @langchain/pgvector README（initialize / columns / distanceStrategy / 建索引）:
 *   https://github.com/langchain-ai/langchainjs/tree/main/libs/langchain-pgvector
 * - pgvector 官方（HNSW / ivfflat / 距离策略）:
 *   https://github.com/pgvector/pgvector#indexing
 *
 * 【跑法】pnpm run pg:step:06（需要本地 Docker PG 已启动）
 */

import { PGVectorStore, DistanceStrategy } from "@langchain/pgvector";
import type pg from "pg";
import { REFUND_POLICY, createEmbeddings, createPool, divider, termsBox } from "../shared";

// 知识库表名（本步专用，避免污染其他表）
const KB_TABLE = "refund_policy_kb";

function buildVectorStoreConfig() {
  return {
    postgresConnectionOptions: {
      type: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "postgres",
      password: "postgres",
      database: "postgres",
    } as pg.PoolConfig,
    tableName: KB_TABLE,
    columns: {
      idColumnName: "id",
      vectorColumnName: "embedding",
      contentColumnName: "content",
      metadataColumnName: "metadata",
    },
    distanceStrategy: "cosine" as DistanceStrategy,
  };
}

export async function main() {
  divider("Step 06 | 向量知识库持久化：重启后政策检索还在吗？");

  termsBox("知识库持久化要懂的几个词", [
    ["embedding", "把一段文字变成一串数字（向量），语义相近的文字向量距离近"],
    ["pgvector", "PostgreSQL 的向量插件：让 SQL 能按相似度查，不用单独部署向量数据库"],
    ["HNSW", "近似最近邻索引：把向量建图索引，检索从全表扫变成 O(log n)，生产必建"],
    ["余弦距离", "cosine 距离策略：看两段文字的『方向』有多接近，适合政策语义匹配"],
  ]);

  console.log(`
📦 业务场景：客服 Agent 要回答「我这个耳机能退吗？运费谁出？」——
  靠检索售后政策知识库。知识库如果只在内存里，重启就没了。`);

  // ════════════════════ A 版：内存向量库（概念对照） ════════════════════

  console.log(`
【A 版 · 概念对照】MemoryVectorStore：向量在进程内存 → 重启即空（和 step-01 同理）`);
  console.log(`  知识库和会话状态一样：只要在进程里，就逃不过「重启归零」。`);

  // ════════════════════ B 版：PGVectorStore，向量写进 PostgreSQL ════════════════════

  console.log(`
【B 版 · 生产方案】PGVectorStore：向量存进 PG，知识库和业务数据同库同命`);

  const embeddings = createEmbeddings();

  // ── 第一轮：建表 + 写入政策文档 ──
  // initialize: 自动建向量表（若无）+ 返回可用的 store 实例
  // 对应文档: https://github.com/langchain-ai/langchainjs/tree/main/libs/langchain-pgvector
  // dimensions=1024 与 DashScope text-embedding-v3 默认输出维度一致（生产必须对齐，否则写入报错）
  const store1 = await PGVectorStore.initialize(embeddings, {
    ...buildVectorStoreConfig(),
    dimensions: 1024,
  });

  const docs = REFUND_POLICY.map((text, i) => ({
    pageContent: text,
    metadata: { ruleId: `R-${i + 1}`, category: "退款政策" },
  }));
  await store1.addDocuments(docs);
  console.log(`  [写入] ${docs.length} 条售后政策已存入 PGVectorStore（表 ${KB_TABLE}）`);

  const r1 = await store1.similaritySearch("耳机买来 3 天就坏了，能换吗？", 2);
  console.log("\n  🔍 检索「耳机买来 3 天就坏了，能换吗？」：");
  r1.forEach((d, i) => console.log(`    [${i + 1}] ${d.pageContent}`));

  // ── 断开连接，模拟重启 ──
  console.log(`\n  🔌 断开 PGVectorStore 连接（模拟重启）...`);
  await store1.end();

  // ── 第二轮：重连 → 检索仍在 ──
  console.log(`\n  🚀 重启后重新连接，直接检索：`);
  const store2 = await PGVectorStore.initialize(embeddings, {
    ...buildVectorStoreConfig(),
    dimensions: 1024,
  });
  const r2 = await store2.similaritySearch("退款多久到账？", 2);
  r2.forEach((d, i) => console.log(`    [${i + 1}] ${d.pageContent}`));
  console.log("\n  ✅ 重启后向量数据仍在——知识库持久化成功！");

  // ── 数据库工程师视角：表结构 + 生产索引 ──
  console.log(`
🔍 数据库工程师视角：扒开向量表 + 生产必备索引`);

  const pool = createPool();
  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = $1 ORDER BY ordinal_position`,
    [KB_TABLE]
  );
  console.log(`  表 ${KB_TABLE} 的列结构：`);
  for (const c of cols.rows) {
    console.log(`    • ${c.column_name.padEnd(12)} ${c.data_type}`);
  }

  // 生产索引：HNSW（高精度推荐）vs ivfflat（低内存备选）
  // 对应文档: https://github.com/pgvector/pgvector#indexing
  console.log(`
  生产必须建 ANN 索引，否则每次检索都是全表扫描（几百万行时直接卡死）：

  -- HNSW：精度高、无训练期，生产首选（数据量 < 1000 万推荐）
  CREATE INDEX ON ${KB_TABLE} USING hnsw (embedding vector_cosine_ops);

  -- ivfflat：训练期需要数据、召回略低，但内存占用小（备选）
  CREATE INDEX ON ${KB_TABLE} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

  注意：索引距离函数必须和查询距离策略一致（本表 cosine → vector_cosine_ops）。`);

  await store2.end();
  await pool.end();

  console.log("\n✅ Step 06 完成：知识库持久化 + 生产索引，两个点都拿到了\n");
}

// 单文件直接运行时执行（被 index.ts import 时不重复执行）
if (require.main === module) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
