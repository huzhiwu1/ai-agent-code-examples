---
feishu_doc: ""
status: 文章待写（代码已完成）
---

# Agent 烧 token 太快怎么办？从预算到优化

> ⚠️ 本文尚未发布到飞书。代码示例已完成（`src/index.ts`），文章正文待写。

## 代码说明

渐进式演示 Agent Token 预算/成本控制：

- Part 1「追踪」：`TokenUsageTracker` — 自定义 callback handler，每轮 LLM 调用后提取 `usage_metadata`，按轮累计
- Part 2「预算」：给 Agent 设 token 预算，超预算拦截
- Part 3「优化」：上下文裁剪 / 压缩策略

## 运行

```bash
cd articles/agent-token-budget
pnpm install
pnpm dev   # 或 npm run dev，见 package.json scripts
```

## 关联

- 大纲：`ai-agent-knowledge/outline-token.md`
- 选题背景：8/18 规划的「工程化 40%」文章，暂未排期
