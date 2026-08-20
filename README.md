# AI Agent Code Examples

AI Agent 知识文章的**可运行代码示例库**（pnpm monorepo，每篇文章一个独立包）。每篇文章配一份 TypeScript 代码，用真实 LLM 跑通核心机制，而不是纸面概念。

> 💡 **注意**：这是「AI Agent 通用知识」文章（记忆管理、上下文工程等）的代码示例仓库。
> **DeepSeek Harness 源码精读系列**的代码和解析在另一个仓库：[ai-agent-code-lab](https://github.com/huzhiwu1/ai-agent-code-lab)。

## 📖 文章与代码

**文章正文 = `articles/<slug>/README.md`，和代码放在同一个目录**，本地与飞书双向协同：

- 完整索引（27 篇：24 篇已发布 + 3 篇待写）：[articles/README.md](articles/README.md)
- 改完文章想同步到飞书：`bash scripts/sync-articles.sh <slug>`（或 `all` 全推）
- 每篇 README 的 front matter `feishu_doc` 记录对应飞书文档 token

| 文章（slug）                                | 代码                                                                 | 跑法                                  |
| ------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------- |
| agent-memory（怎么让 Agent 记住上次对话？） | [articles/agent-memory/](articles/agent-memory/)                     | `pnpm run run:memory`                 |
| context-eng（上下文工程）                   | [articles/context-eng/](articles/context-eng/)                       | `pnpm run run:context-eng`            |
| agentic-rag（Agent 自己决定要不要检索）     | [articles/agentic-rag/](articles/agentic-rag/)                       | `pnpm run run:agentic-rag`            |
| multi-agent-supervisor（多 Agent 编排）     | [articles/multi-agent-supervisor/](articles/multi-agent-supervisor/) | `pnpm run run:multi-agent-supervisor` |
| agent-planning（Plan-and-Execute）          | [articles/agent-planning/](articles/agent-planning/)                 | `pnpm run run:planning`               |
| agent-observability（观测与评估）           | [articles/agent-observability/](articles/agent-observability/)       | `pnpm run run:agent-observability`    |
| mcp-tools / mcp-server-guide / mcp-adapters | [articles/mcp-tools/](articles/mcp-tools/) 等                        | 见各目录 package.json                 |

> 代码示例库里的 `src/index.ts` 是文章引用的真实代码；文章里引用路径以仓库相对路径为准（如 `src/index.ts`），禁止引用不存在的文件。

## 快速开始

```bash
git clone git@github.com:huzhiwu1/ai-agent-code-examples.git
cd ai-agent-code-examples
pnpm install

# 复制环境变量模板并填写 LLM key
cp .env.example .env

# 跑某个示例（真实 LLM 调用，需要配置 LLM_API_KEY）
pnpm run run:memory
```

## 🔧 环境要求

- Node.js ≥ 20
- pnpm ≥ 9
- 任意 OpenAI 兼容的 LLM 端点（默认 DeepSeek：`https://api.deepseek.com`，也支持网关）
- `.env` 配置：`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`

## License

MIT
