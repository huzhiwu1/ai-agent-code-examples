# AI Agent Code Examples

AI Agent 知识文章的**可运行代码示例库**（pnpm monorepo，每篇文章一个独立包）。每篇文章配一份 TypeScript 代码，用真实 LLM 跑通核心机制，而不是纸面概念。

> 💡 **注意**：这是「AI Agent 通用知识」文章（记忆管理、上下文工程等）的代码示例仓库。
> **DeepSeek Harness 源码精读系列**的代码和解析在另一个仓库：[ai-agent-code-lab](https://github.com/huzhiwu1/ai-agent-code-lab)。

## 📖 示例文章（附可运行代码）

**文章正文 = `articles/<slug>/README.md`，和代码放在同一个目录**，本地与飞书双向协同：

- 改完文章想同步到飞书：`bash scripts/sync-articles.sh <slug>`（或 `all` 全推）
- 每篇 README 的 front matter `feishu_doc` 记录对应飞书文档 token

| 文章                                                                                                               | 代码                                                                 | 跑法                                  |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------- |
| [怎么让 Agent 记住上次对话？](articles/agent-memory/README.md)                                                     | [articles/agent-memory/](articles/agent-memory/)                     | `pnpm run run:memory`                 |
| [上下文工程：模型窗口有限，放什么比怎么写更重要](articles/context-eng/README.md)                                   | [articles/context-eng/](articles/context-eng/)                       | `pnpm run run:context-eng`            |
| [Agentic RAG：让 Agent 自己决定要不要检索](articles/agentic-rag/README.md)                                         | [articles/agentic-rag/](articles/agentic-rag/)                       | `pnpm run run:agentic-rag`            |
| [多 Agent 一定比单 Agent 更好吗？Supervisor/Handoff 怎么分工才不打架？](articles/multi-agent-supervisor/README.md) | [articles/multi-agent-supervisor/](articles/multi-agent-supervisor/) | `pnpm run run:multi-agent-supervisor` |
| [Agent 怎么先想再做？从直答到 Plan-and-Execute 的动态规划](articles/agent-planning/README.md)                      | [articles/agent-planning/](articles/agent-planning/)                 | `pnpm run run:planning`               |
| [Agent 内部到底在干什么？怎么观测和评估它？](articles/agent-observability/README.md)                               | [articles/agent-observability/](articles/agent-observability/)       | `pnpm run run:agent-observability`    |
| [Agent 接入工具为什么要标准化？MCP 到底解决了什么痛点？](articles/mcp-tools/README.md)                             | [articles/mcp-tools/](articles/mcp-tools/)                           | `pnpm run run:mcp-tools`              |
| [怎么规范地写一个 MCP Server？从脚手架到错误处理](articles/mcp-server-guide/README.md)                             | [articles/mcp-server-guide/](articles/mcp-server-guide/)             | `pnpm run run:mcp-server-guide`       |

## 🚧 待写文章（代码已完成，正文未发布）

| 代码                                                             | 跑法                                             | 说明                                 |
| ---------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------ |
| [articles/agent-token-budget/](articles/agent-token-budget/)     | `cd articles/agent-token-budget && pnpm start`   | Token 预算/成本控制                  |
| [articles/agent-pg-persistence/](articles/agent-pg-persistence/) | `cd articles/agent-pg-persistence && pnpm start` | PG 持久化                            |
| [articles/mcp-adapters/](articles/mcp-adapters/)                 | `cd articles/mcp-adapters && pnpm start`         | MCP 全链路演示（mcp-tools 补充素材） |

> 完整索引（含纯知识点文章与飞书链接）：[articles/README.md](articles/README.md)
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
