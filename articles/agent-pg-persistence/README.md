---
feishu_doc: ""
status: 文章待写（代码已完成）
---

# PG + AI Agent 持久化：售后客服 Agent 的退款工单，为什么重启不丢？

> ⚠️ 本文尚未发布到飞书。代码已完成（`src/steps/step-01.ts` ~ `step-07.ts` 7 步渐进式，每步可独立运行），文章正文待写。

## 一句话

一条真实业务主线（用户林女士的退款工单 **RT-2026-0826-001**）贯穿 7 步：
从 MemorySaver 重启失忆的崩点开始，一步步换成 PostgresSaver（会话状态）、PostgresStore（用户长时记忆）、PGVectorStore（政策知识库），最后补上连接池 / 清理 / 幂等 / 降级，拿到「demo 到生产」的完整检查清单。

## 7 步渐进式

| Step                                                                   | 生产环节                           | 哲学点                                                                | 跑法                  |
| ---------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------- | --------------------- |
| 01 [memorysaver-lost](src/steps/step-01-memorysaver-lost.ts)           | 会话状态存在哪？MemorySaver 的真相 | MemorySaver = 进程内存，重启即失；开发没问题，生产重启/发版就丢       | `pnpm run pg:step:01` |
| 02 [postgres-saver-basics](src/steps/step-02-postgres-saver-basics.ts) | 把 Agent 状态从内存挪到 PG         | 状态持久化 = 重启还能续档；checkpoint 本质是一张表                    | `pnpm run pg:step:02` |
| 03 [multi-step-recovery](src/steps/step-03-multi-step-recovery.ts)     | 退款审批流走到一半崩了             | checkpointer 存的不只是对话，是**执行进度**（状态机）；重启从断点续跑 | `pnpm run pg:step:03` |
| 04 [multi-instance-shared](src/steps/step-04-multi-instance-shared.ts) | K8s 多副本交替处理同一会话         | 状态跨实例共享 → Agent 变成无状态 worker → 支撑水平扩展               | `pnpm run pg:step:04` |
| 05 [longterm-memory](src/steps/step-05-longterm-memory.ts)             | 会话状态存了，用户偏好呢？         | 双层记忆：短时 checkpointer（按 thread）+ 长时 store（按 user_id）    | `pnpm run pg:step:05` |
| 06 [vector-knowledge](src/steps/step-06-vector-knowledge.ts)           | 售后政策知识库重启后还在吗         | 向量也进 PG（PGVectorStore）；生产必须建 HNSW 索引                    | `pnpm run pg:step:06` |
| 07 [production-hardening](src/steps/step-07-production-hardening.ts)   | 上线前最后一公里                   | 连接池复用 / checkpoint TTL 清理 / 幂等兜底 / DB 故障降级             | `pnpm run pg:step:07` |

全部跑一遍：`pnpm run:pg-persistence`（或单步 `pnpm run:pg-persistence --step3`）

## 运行前置条件

```bash
# 1. 启动 PostgreSQL（含 pgvector 扩展）
docker run -d --name pgvector -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16

# 2. 仓库根目录 .env 配置（step 1-5、7 用 LLM_*；step 06 用 EMBEDDING_*）
#    LLM_API_KEY / LLM_BASE_URL / LLM_MODEL        （DeepSeek，对话）
#    EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL  （DashScope text-embedding-v3，向量）

# 3. 跑某一步（在仓库根目录）
pnpm run pg:step:01   # ~ pg:step:07
```

## 代码组织

- `src/shared.ts`：公共依赖（env 加载、DB_URI、createLLM/createEmbeddings、工单场景常量、console 工具）
- `src/steps/step-01.ts` ~ `step-07.ts`：每步一个真实生产环节 + AB 对比（💥 崩点 → ✅ 解决）+ 术语先行，每步自足可独立运行
- `src/index.ts`：总装入口（默认全部 7 步，`--stepN` 单步）

## 关联

- 大纲：`ai-agent-knowledge/outline-pg-agent.md`
- 选题背景：8/18 规划的「工程化 40%」文章，暂未排期
