# AI Agent Code Examples

AI Agent 知识文章的**可运行代码示例库**（pnpm monorepo，每篇文章一个独立包）。每篇文章配一份 TypeScript 代码，用真实 LLM 跑通核心机制，而不是纸面概念。

> 💡 **注意**：这是「AI Agent 通用知识」文章（记忆管理、上下文工程等）的代码示例仓库。
> **DeepSeek Harness 源码精读系列**的代码和解析在另一个仓库：[ai-agent-code-lab](https://github.com/huzhiwu1/ai-agent-code-lab)。

## 📖 配套文章

| 文章                                           | 代码                                             | 跑法                       |
| ---------------------------------------------- | ------------------------------------------------ | -------------------------- |
| 怎么让 Agent 记住上次对话？（记忆管理）        | [articles/agent-memory/](articles/agent-memory/) | `pnpm run run:memory`      |
| 上下文工程：模型窗口有限，放什么比怎么写更重要 | [articles/context-eng/](articles/context-eng/)   | `pnpm run run:context-eng` |
| Agentic RAG：让 Agent 自己决定要不要检索       | [articles/agentic-rag/](articles/agentic-rag/)   | `pnpm run run:agentic-rag` |

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
