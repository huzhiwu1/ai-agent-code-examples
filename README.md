# AI Agent Code Examples

AI Agent 知识文章的**可运行代码示例库**（pnpm monorepo，每篇文章一个独立包）。每篇文章配一份 TypeScript 代码，用真实 LLM 跑通核心机制，而不是纸面概念。

> 💡 **注意**：这是「AI Agent 通用知识」文章（记忆管理、上下文工程等）的代码示例仓库。
> **DeepSeek Harness 源码精读系列**的代码和解析在另一个仓库：[ai-agent-code-lab](https://github.com/huzhiwu1/ai-agent-code-lab)。

## 📖 文章与代码

**文章正文 = `articles/<slug>/README.md`，和代码放在同一个目录**，本地与飞书双向协同：

- 改完文章想同步到飞书：`bash scripts/sync-articles.sh <slug>`（或 `all` 全推）
- 每篇 README 的 front matter `feishu_doc` 记录对应飞书文档 token

### 有配套代码的文章（9 篇）

| 文章（slug）                                | 代码目录                                                             | 跑法                                     |
| ------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------- |
| agent-memory（怎么让 Agent 记住上次对话？） | [articles/agent-memory/](articles/agent-memory/)                     | `pnpm run run:memory`                    |
| context-eng（上下文工程）                   | [articles/context-eng/](articles/context-eng/)                       | `pnpm run run:context-eng`               |
| agentic-rag（Agent 自己决定要不要检索）     | [articles/agentic-rag/](articles/agentic-rag/)                       | `pnpm run run:agentic-rag`               |
| multi-agent-supervisor（多 Agent 编排）     | [articles/multi-agent-supervisor/](articles/multi-agent-supervisor/) | `pnpm run run:multi-agent-supervisor`    |
| agent-planning（Plan-and-Execute）          | [articles/agent-planning/](articles/agent-planning/)                 | `pnpm run run:planning`                  |
| agent-observability（观测与评估）           | [articles/agent-observability/](articles/agent-observability/)       | `pnpm run run:agent-observability`       |
| mcp-tools（MCP 协议）                       | [articles/mcp-tools/](articles/mcp-tools/)                           | `pnpm run run:mcp-tools`                 |
| mcp-server-guide（写 MCP Server）           | [articles/mcp-server-guide/](articles/mcp-server-guide/)             | `pnpm run run:mcp-server-guide`          |
| mcp-adapters（MCP 全链路演示）              | [articles/mcp-adapters/](articles/mcp-adapters/)                     | `cd articles/mcp-adapters && pnpm start` |

### 纯知识点文章（15 篇，无代码，正文即 README）

| 文章（slug）                              | 位置                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| agent-loop（Agent 循环）                  | [articles/agent-loop/](articles/agent-loop/)                                   |
| skill-vs-mcp（Skill vs MCP）              | [articles/skill-vs-mcp/](articles/skill-vs-mcp/)                               |
| conditional-routing（条件路由）           | [articles/conditional-routing/](articles/conditional-routing/)                 |
| interrupt-hitl（危险操作确认）            | [articles/interrupt-hitl/](articles/interrupt-hitl/)                           |
| tool-progress-stream（工具进度流）        | [articles/tool-progress-stream/](articles/tool-progress-stream/)               |
| sse-streaming（SSE 流式）                 | [articles/sse-streaming/](articles/sse-streaming/)                             |
| streaming-rewrite（边生成边显示）         | [articles/streaming-rewrite/](articles/streaming-rewrite/)                     |
| deepseek-harness（DSH 工程拆解）          | [articles/deepseek-harness/](articles/deepseek-harness/)                       |
| dirty-state（脏状态清理）                 | [articles/dirty-state/](articles/dirty-state/)                                 |
| langgraph-dirty-recovery（脏状态救援）    | [articles/langgraph-dirty-recovery/](articles/langgraph-dirty-recovery/)       |
| function-calling                          | [articles/function-calling/](articles/function-calling/)                       |
| tool-schema（工具 Schema）                | [articles/tool-schema/](articles/tool-schema/)                                 |
| langchain-structured-output（结构化输出） | [articles/langchain-structured-output/](articles/langchain-structured-output/) |
| langgraph-stategraph（StateGraph）        | [articles/langgraph-stategraph/](articles/langgraph-stategraph/)               |
| react-pattern（ReAct 模式）               | [articles/react-pattern/](articles/react-pattern/)                             |
| prompt-template（Prompt 模板）            | [articles/prompt-template/](articles/prompt-template/)                         |

### 待写文章（代码已完成，正文未发布）

| 文章（slug）                      | 代码目录                                                         | 跑法                                             |
| --------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| agent-token-budget（Token 预算）  | [articles/agent-token-budget/](articles/agent-token-budget/)     | `cd articles/agent-token-budget && pnpm start`   |
| agent-pg-persistence（PG 持久化） | [articles/agent-pg-persistence/](articles/agent-pg-persistence/) | `cd articles/agent-pg-persistence && pnpm start` |

> 完整索引（含飞书链接）：[articles/README.md](articles/README.md)
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
