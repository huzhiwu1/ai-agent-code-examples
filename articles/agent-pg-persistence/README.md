---
feishu_doc: ""
status: 文章待写（代码已完成）
---

# Agent 重启后怎么记住状态？PostgreSQL 持久化实战

> ⚠️ 本文尚未发布到飞书。代码示例已完成（`src/index.ts`），文章正文待写。

## 代码说明

四个演示场景：

1. MemorySaver 重启丢状态 —— 演示开发版的问题
2. PostgreSQL 持久化 —— 用 PG 存 Agent 状态
3. 向量存储 —— 状态/记忆的语义检索
4. 完整链路 —— 持久化 + 检索组合

## 运行

```bash
cd articles/agent-pg-persistence
pnpm install
pnpm dev   # 需要本地 PostgreSQL，连接配置见 src/index.ts 顶部
```

## 关联

- 大纲：`ai-agent-knowledge/outline-pg-agent.md`
- 选题背景：8/18 规划的「工程化 40%」文章，暂未排期
