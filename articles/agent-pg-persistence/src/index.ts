/**
 * PG + AI Agent 持久化：Agent 重启后怎么记住状态？
 * ====================================================================
 *
 * 主题：Agent 重启后怎么记住状态？PostgreSQL 持久化实战
 *
 * 四个演示场景：
 *   1. MemorySaver 重启丢状态 —— 演示开发版的问题
 *   2. PostgresSaver 持久化   —— 换生产级 checkpointer，重启后状态仍在
 *   3. PGVectorStore 向量持久化 —— 嵌入向量存 PG，重启后检索仍在
 *   4. 完整链路               —— Agent + PostgresSaver + PGVectorStore
 *
 * 运行前置条件：
 *   1. 安装依赖：pnpm install
 *   2. 启动 PostgreSQL（含 pgvector 扩展）：
 *      docker run -d --name pgvector \
 *        -p 5432:5432 \
 *        -e POSTGRES_PASSWORD=postgres \
 *        pgvector/pgvector:pg16
 *   3. 根目录 .env 配置 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
 *      （见 ../../../.env）
 *
 * 运行命令：cd articles/agent-pg-persistence && pnpm start
 *   （或从 monorepo 根目录：npx tsx articles/agent-pg-persistence/src/index.ts）
 *
 * 注意：本示例需要 LLM 和 Embeddings 两个 API。
 *   - LLM：使用 LLM_BASE_URL + LLM_API_KEY（如 DeepSeek）
 *   - Embeddings：需要另外配置 OpenAI 兼容的 embeddings 端点
 *     （如 DashScope text-embedding-v3、OpenAI text-embedding-3-small 等）
 *     通过 env OPENAI_API_KEY / OPENAI_BASE_URL 传入，缺省时复用 LLM_* 配置
 *     （但 DeepSeek 不支持 embeddings，会报 404）
 */

import "dotenv/config";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { randomUUID } from "node:crypto";

// ---------- LangGraph 核心 ----------
import { MemorySaver, Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

// ---------- PGVectorStore ----------
import { PGVectorStore } from "@langchain/pgvector";
import type { DistanceStrategy } from "@langchain/pgvector";

// ---------- LLM / Embeddings ----------
import { ChatOpenAI } from "@langchain/openai";
import { OpenAIEmbeddings } from "@langchain/openai";

// ---------- 消息 & 工具 ----------
import { SystemMessage, HumanMessage, BaseMessage } from "@langchain/core/messages";
import { DynamicTool } from "@langchain/core/tools";

// ---------- pg ----------
import pg from "pg";

// ====================================================================
// 加载根目录 .env
// ====================================================================
dotenv.config({ path: path.resolve(__dirname, "../../../.env"), override: true });

// ====================================================================
// 配置常量
// ====================================================================
const DB_URI = "postgresql://postgres:postgres@localhost:5432/postgres?sslmode=disable";

const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
const LLM_MODEL = process.env.LLM_MODEL ?? "deepseek-chat";

// Embeddings 配置：优先读 OPENAI_* 环境变量，缺省用 LLM_* 配置
// ⚠️ 注意：DeepSeek 不支持 embeddings API，需要换成 DashScope、OpenAI 等
const EMBEDDING_API_KEY = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || "";
const EMBEDDING_BASE_URL =
  process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || "https://api.deepseek.com";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";

// ====================================================================
// 共享的 LLM 实例
// ====================================================================
function createLLM() {
  return new ChatOpenAI({
    model: LLM_MODEL,
    apiKey: LLM_API_KEY,
    configuration: { baseURL: LLM_BASE_URL },
    temperature: 0.2,
    maxTokens: 2048,
  });
}

function createEmbeddings() {
  return new OpenAIEmbeddings({
    model: EMBEDDING_MODEL,
    apiKey: EMBEDDING_API_KEY,
    configuration: { baseURL: EMBEDDING_BASE_URL },
  });
}

// ====================================================================
// 辅助：打印分隔线
// ====================================================================
function divider(title: string) {
  const len = 68;
  const pad = Math.max(0, len - title.length - 2);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  console.log(`\n${"=".repeat(len)}`);
  console.log(`=${" ".repeat(left)}${title}${" ".repeat(right)}=`);
  console.log(`${"=".repeat(len)}\n`);
}

// ====================================================================
// 1. MemorySaver 重启丢状态演示
// ====================================================================
async function demoMemorySaverRestart() {
  divider("1. MemorySaver 重启丢状态演示");

  // ── 第 1 轮：创建 Agent + MemorySaver，正常对话 ──
  const llm1 = createLLM();
  const checkpointer1 = new MemorySaver();
  const agent1 = createReactAgent({
    llm: llm1,
    tools: [],
    checkpointSaver: checkpointer1,
    prompt: "你是一个乐于助人的助手。回答保持简洁。",
  });

  const config1 = { configurable: { thread_id: "demo-memory-1" } };

  console.log("【第 1 轮】Agent 启动，用户说：我叫张三");
  const res1 = await agent1.invoke(
    { messages: [new HumanMessage("你好，我叫张三，请记住我的名字。")] },
    config1
  );
  console.log(`  Agent：${res1.messages[res1.messages.length - 1].content}`);

  console.log("【第 2 轮】同一会话，用户问：我叫什么名字？");
  const res2 = await agent1.invoke({ messages: [new HumanMessage("我叫什么名字？")] }, config1);
  console.log(`  Agent：${res2.messages[res2.messages.length - 1].content}`);
  console.log("  → ✅ MemorySaver 在同一进程内工作正常，Agent 记得名字\n");

  // ── 第 2 轮：模拟"重启进程"——新建 MemorySaver 实例 ──
  const llm2 = createLLM();
  const checkpointer2 = new MemorySaver(); // ← 模拟进程重启！全新内存
  const agent2 = createReactAgent({
    llm: llm2,
    tools: [],
    checkpointSaver: checkpointer2,
    prompt: "你是一个乐于助人的助手。回答保持简洁。",
  });

  // 用同一个 thread_id 提问
  console.log("【重启后】同一 thread_id，用户问：我叫什么名字？");
  const res3 = await agent2.invoke(
    { messages: [new HumanMessage("我叫什么名字？")] },
    { configurable: { thread_id: "demo-memory-1" } }
  );
  console.log(`  Agent：${res3.messages[res3.messages.length - 1].content}`);
  console.log("  → ❌ 重启后 MemorySaver 丢失状态，Agent 不记得之前对话\n");
}

// ====================================================================
// 2. PostgresSaver 持久化（断点续跑）
// ====================================================================
async function demoPostgresSaver() {
  divider("2. PostgresSaver 持久化（断点续跑）");

  // ── 第 1 轮：创建 PostgresSaver，首次对话 ──
  const llm1 = createLLM();
  const checkpointer1 = PostgresSaver.fromConnString(DB_URI);
  // ⚠️ 首次使用必须调用 setup() 建表
  await checkpointer1.setup();
  console.log("  [setup] PostgresSaver 检查点表已就绪");

  const agent1 = createReactAgent({
    llm: llm1,
    tools: [],
    checkpointSaver: checkpointer1,
    prompt: "你是一个乐于助人的助手。回答保持简洁。",
  });

  const config = { configurable: { thread_id: "demo-pg-1" } };

  console.log("【第 1 轮】用户说：我是李四，请记住我");
  const res1 = await agent1.invoke(
    { messages: [new HumanMessage("我是李四，请记住我。")] },
    config
  );
  console.log(`  Agent：${res1.messages[res1.messages.length - 1].content}`);

  console.log("【第 2 轮】用户问：我是谁？");
  const res2 = await agent1.invoke({ messages: [new HumanMessage("我是谁？")] }, config);
  console.log(`  Agent：${res2.messages[res2.messages.length - 1].content}`);
  console.log("  → ✅ 进程内 PostgresSaver 工作正常\n");

  // ── 断开连接，模拟进程重启 ──
  // 访问 PostgresSaver 内部的 pool 并关闭
  // @ts-expect-error - pool 是 PostgresSaver 的内部属性
  await checkpointer1.pool.end();
  console.log("  [断开] 数据库连接已关闭，模拟进程重启\n");

  // ── 第 2 轮：重新连接，检查状态是否还在 ──
  const llm2 = createLLM();
  const checkpointer2 = PostgresSaver.fromConnString(DB_URI);
  // 注意：第二次不需要 setup()，表已经存在
  // 但 setup() 是幂等的（IF NOT EXISTS），调用也无妨
  await checkpointer2.setup();

  const agent2 = createReactAgent({
    llm: llm2,
    tools: [],
    checkpointSaver: checkpointer2,
    prompt: "你是一个乐于助人的助手。回答保持简洁。",
  });

  console.log("【重启后】同一 thread_id，用户问：我是谁？");
  const res3 = await agent2.invoke(
    { messages: [new HumanMessage("我是谁？")] },
    { configurable: { thread_id: "demo-pg-1" } }
  );
  console.log(`  Agent：${res3.messages[res3.messages.length - 1].content}`);
  console.log("  → ✅ 重启后 PostgresSaver 从数据库恢复状态，Agent 还记得\n");

  // 清理：关闭连接
  // @ts-expect-error - pool 是内部属性
  await checkpointer2.pool.end();
}

// ====================================================================
// 3. PGVectorStore 向量持久化
// ====================================================================
async function demoPGVectorStore() {
  divider("3. PGVectorStore 向量持久化");

  const embeddings = createEmbeddings();
  const TABLE_NAME = "documents_pg_demo";

  // ── 第 1 轮：初始化 PGVectorStore，写入文档 ──
  console.log("  [初始化] PGVectorStore 建表...");
  const vectorStore1 = await PGVectorStore.initialize(embeddings, {
    postgresConnectionOptions: {
      type: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "postgres",
      password: "postgres",
      database: "postgres",
    } as pg.PoolConfig,
    tableName: TABLE_NAME,
    columns: {
      idColumnName: "id",
      vectorColumnName: "vector",
      contentColumnName: "content",
      metadataColumnName: "metadata",
    },
    distanceStrategy: "cosine" as DistanceStrategy,
  });

  // 写入示例文档
  const docs = [
    {
      pageContent: "PostgreSQL 是一个功能强大的开源关系型数据库，支持 ACID 事务。",
      metadata: { topic: "database" },
    },
    {
      pageContent: "pgvector 是 PostgreSQL 的向量扩展，支持余弦距离、内积等相似度计算。",
      metadata: { topic: "vector" },
    },
    {
      pageContent: "LangGraph 的 PostgresSaver 可以把 Agent 状态持久化到 PostgreSQL 中。",
      metadata: { topic: "langgraph" },
    },
    {
      pageContent: "PGVectorStore 是 LangChain 官方推荐的 PostgreSQL 向量存储方案。",
      metadata: { topic: "langchain" },
    },
    {
      pageContent: "Agent 重启后，MemorySaver 丢失状态，PostgresSaver 从数据库恢复。",
      metadata: { topic: "persistence" },
    },
  ];

  const ids = docs.map(() => randomUUID());
  await vectorStore1.addDocuments(docs, { ids });
  console.log(`  [写入] ${docs.length} 条文档已存入 PGVectorStore\n`);

  // 搜索验证
  console.log("【第 1 轮】搜索：向量数据库持久化");
  const results1 = await vectorStore1.similaritySearch("向量数据库持久化", 2);
  for (const doc of results1) {
    console.log(`  - ${doc.pageContent} [${JSON.stringify(doc.metadata)}]`);
  }
  console.log();

  // 关闭连接
  await vectorStore1.end();
  console.log("  [断开] PGVectorStore 连接已关闭，模拟重启\n");

  // ── 第 2 轮：重新连接，验证数据还在 ──
  console.log("  [重启] 创建新的 PGVectorStore 实例...");
  const vectorStore2 = await PGVectorStore.initialize(embeddings, {
    postgresConnectionOptions: {
      type: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "postgres",
      password: "postgres",
      database: "postgres",
    } as pg.PoolConfig,
    tableName: TABLE_NAME,
    columns: {
      idColumnName: "id",
      vectorColumnName: "vector",
      contentColumnName: "content",
      metadataColumnName: "metadata",
    },
    distanceStrategy: "cosine" as DistanceStrategy,
  });

  console.log("【重启后】搜索：向量数据库持久化");
  const results2 = await vectorStore2.similaritySearch("向量数据库持久化", 2);
  for (const doc of results2) {
    console.log(`  - ${doc.pageContent} [${JSON.stringify(doc.metadata)}]`);
  }
  console.log("  → ✅ 重启后 PGVectorStore 向量数据仍在，搜索正常\n");

  // 清理：删除测试表
  try {
    const pool = (vectorStore2 as unknown as { pool: pg.Pool }).pool;
    await pool.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
    await pool.query(`DROP TABLE IF EXISTS "collections"`);
    console.log("  [清理] 测试表已删除\n");
  } catch {
    // 忽略清理失败
  }

  await vectorStore2.end();
}

// ====================================================================
// 4. 完整链路：Agent + PostgresSaver + PGVectorStore
// ====================================================================
async function demoFullPipeline() {
  divider("4. 完整链路：Agent + PostgresSaver + PGVectorStore");

  // ── 准备向量知识库 ──
  const embeddings = createEmbeddings();
  const KB_TABLE = "knowledge_base";

  // 用连接池的方式初始化并写入知识
  const kbVectorStore = await PGVectorStore.initialize(embeddings, {
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
      vectorColumnName: "vector",
      contentColumnName: "content",
      metadataColumnName: "metadata",
    },
    distanceStrategy: "cosine" as DistanceStrategy,
  });

  const knowledgeDocs = [
    {
      pageContent:
        "LangGraph 支持两种持久化方案：MemorySaver（内存）和 PostgresSaver（PostgreSQL）。",
      metadata: { source: "langgraph-docs" },
    },
    {
      pageContent:
        "PostgresSaver 需要调用 setup() 方法创建检查点表，该表存储 thread_id 和 checkpoint JSON。",
      metadata: { source: "langgraph-docs" },
    },
    {
      pageContent:
        "PGVectorStore 是 @langchain/pgvector 包提供的向量存储，支持余弦距离、内积等距离策略。",
      metadata: { source: "pgvector-docs" },
    },
    {
      pageContent:
        "Agent 的短时记忆通过 checkpointer 持久化，长时记忆通过 store（BaseStore）持久化。",
      metadata: { source: "langchain-concepts" },
    },
    {
      pageContent:
        "生产环境建议使用 PostgresSaver + PostgreSQL 替代 MemorySaver，支持多实例共享和进程重启。",
      metadata: { source: "best-practices" },
    },
  ];

  const kbIds = knowledgeDocs.map(() => randomUUID());
  await kbVectorStore.addDocuments(knowledgeDocs, { ids: kbIds });
  console.log("  [知识库] 已写入 5 条知识文档\n");

  // 关闭知识库连接（后续 Agent 工具中重新连接）
  await kbVectorStore.end();

  // ── 创建 Agent 工具：搜索知识库 ──
  const searchKnowledgeTool = new DynamicTool({
    name: "search_knowledge",
    description: "搜索 PG + AI Agent 持久化相关的知识库，输入搜索关键词，返回相关文档内容。",
    func: async (query: string) => {
      const kb = await PGVectorStore.initialize(embeddings, {
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
          vectorColumnName: "vector",
          contentColumnName: "content",
          metadataColumnName: "metadata",
        },
        distanceStrategy: "cosine" as DistanceStrategy,
      });
      const results = await kb.similaritySearch(query, 3);
      await kb.end();
      return results.map((d) => d.pageContent).join("\n");
    },
  });

  // ── 创建 Agent（PostgresSaver 持久化）──
  const checkpointer = PostgresSaver.fromConnString(DB_URI);
  await checkpointer.setup();

  const agent = createReactAgent({
    llm: createLLM(),
    tools: [searchKnowledgeTool],
    checkpointSaver: checkpointer,
    prompt:
      "你是一个知识库助手，掌握 PG + AI Agent 持久化相关的知识。" +
      "当用户问及持久化、状态恢复、向量存储等问题时，调用 search_knowledge 工具搜索知识库获取准确信息。" +
      "回答保持简洁、准确。",
  });

  const config = { configurable: { thread_id: "full-pipeline-1" } };

  // ── 对话轮次 ──
  console.log("【第 1 轮】用户问：Agent 重启后状态怎么恢复？");
  const r1 = await agent.invoke(
    { messages: [new HumanMessage("Agent 重启后状态怎么恢复？有哪些方案？")] },
    config
  );
  console.log(`  Agent：${r1.messages[r1.messages.length - 1].content}\n`);

  console.log("【第 2 轮】用户问：PGVectorStore 和 PostgresSaver 有什么区别？");
  const r2 = await agent.invoke(
    { messages: [new HumanMessage("PGVectorStore 和 PostgresSaver 有什么区别？")] },
    config
  );
  console.log(`  Agent：${r2.messages[r2.messages.length - 1].content}\n`);

  // ── 模拟重启 ──
  // @ts-expect-error - pool 是内部属性
  await checkpointer.pool.end();
  console.log("  [断开] 数据库连接已关闭，模拟进程重启\n");

  // ── 重启后继续对话 ──
  const checkpointer2 = PostgresSaver.fromConnString(DB_URI);
  await checkpointer2.setup();

  const agent2 = createReactAgent({
    llm: createLLM(),
    tools: [searchKnowledgeTool],
    checkpointSaver: checkpointer2,
    prompt:
      "你是一个知识库助手，掌握 PG + AI Agent 持久化相关的知识。" +
      "当用户问及持久化、状态恢复、向量存储等问题时，调用 search_knowledge 工具搜索知识库获取准确信息。" +
      "回答保持简洁、准确。",
  });

  console.log("【重启后】用户问：我刚才问了什么？");
  // 注意：重启后 Agent 的上下文包含了之前的对话历史（因为 PostgresSaver 恢复了状态）
  const r3 = await agent2.invoke(
    { messages: [new HumanMessage("我刚才问了什么？")] },
    { configurable: { thread_id: "full-pipeline-1" } }
  );
  console.log(`  Agent：${r3.messages[r3.messages.length - 1].content}\n`);

  console.log("【重启后】用户问：那生产环境应该用哪个？");
  const r4 = await agent2.invoke(
    { messages: [new HumanMessage("生产环境应该用哪个方案？")] },
    { configurable: { thread_id: "full-pipeline-1" } }
  );
  console.log(`  Agent：${r4.messages[r4.messages.length - 1].content}\n`);

  console.log("  → ✅ 完整链路：Agent 重启后状态和知识库都完整恢复！\n");

  // 清理：关闭连接
  // @ts-expect-error - pool 是内部属性
  await checkpointer2.pool.end();

  // 清理知识库表
  try {
    console.log("  [清理] 删除知识库测试表...");
    const cleanupPool = new pg.Pool({
      connectionString: DB_URI,
    });
    await cleanupPool.query(`DROP TABLE IF EXISTS "${KB_TABLE}"`);
    await cleanupPool.query(`DROP TABLE IF EXISTS "collections"`);
    await cleanupPool.end();
    console.log("  [清理] 完成\n");
  } catch {
    // 忽略清理失败
  }
}

// ====================================================================
// 主入口
// ====================================================================
async function main() {
  if (!LLM_API_KEY) {
    console.error("❌ 缺少 LLM_API_KEY，请检查 ../../../.env");
    process.exit(1);
  }

  console.log(`\n  LLM 模型: ${LLM_MODEL} @ ${LLM_BASE_URL}`);
  console.log(`  Embeddings 模型: ${EMBEDDING_MODEL} @ ${EMBEDDING_BASE_URL}`);
  console.log(`  DB_URI: ${DB_URI}`);
  console.log(`  ⚠️  确保 PostgreSQL 已启动：`);
  console.log(
    `     docker run -d --name pgvector -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16\n`
  );

  try {
    // 1. MemorySaver 重启丢状态（不需要 PG）
    await demoMemorySaverRestart();

    // 2. PostgresSaver 持久化（需要 PG）
    await demoPostgresSaver();

    // 3. PGVectorStore 向量持久化（需要 PG + Embeddings API）
    await demoPGVectorStore();

    // 4. 完整链路（需要 PG + Embeddings API）
    await demoFullPipeline();

    divider("全部场景跑完，总结");
    console.log("  ✅ MemorySaver：进程内工作正常，重启后状态丢失（开发/测试用）");
    console.log("  ✅ PostgresSaver：重启后状态从 PostgreSQL 恢复（生产用）");
    console.log("  ✅ PGVectorStore：重启后向量数据仍在，搜索正常");
    console.log("  ✅ 完整链路：Agent 状态 + 知识库检索，重启后完整恢复\n");
  } catch (err) {
    console.error("\n❌ 运行出错：", (err as Error).message);
    console.error("  请检查：");
    console.error("    1. PostgreSQL 是否已启动（docker ps）");
    console.error("    2. .env 配置是否正确");
    console.error("    3. Embeddings API 是否可用（DeepSeek 不支持 embeddings）");
    process.exit(1);
  }
}

main();
