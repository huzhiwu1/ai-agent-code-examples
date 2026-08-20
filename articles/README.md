# 文章索引（articles/README.md ↔ 飞书「AI Agent 知识点手册」）

每篇文章 = `articles/<slug>/README.md`（正文，md 格式），front matter 里带 `feishu_doc`（飞书文档 token）。

**双向协同**：改本地 README → 跑 `bash scripts/sync-articles.sh <slug>` 推飞书（overwrite + revision 回读验证）；飞书是发布端，本地是源。

## 已发布（24 篇，本地 ↔ 飞书已同步）

| slug                        | 代码                            | 飞书链接                                                                       |
| --------------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| multi-agent-supervisor      | [src/](multi-agent-supervisor/) | [多 Agent 编排](https://my.feishu.cn/docx/TcU1dAmLnoqyg5xectYcLUXun7d)         |
| mcp-tools                   | [src/](mcp-tools/)              | [MCP 协议](https://my.feishu.cn/docx/Q3RBdocckoltk8xHXeMcFnNVnic)              |
| mcp-server-guide            | [src/](mcp-server-guide/)       | [MCP Server 编写](https://my.feishu.cn/docx/KZF3dIZngoghyMxSGiicl6wBn4g)       |
| agent-observability         | [src/](agent-observability/)    | [Agent 观测评估](https://my.feishu.cn/docx/YJm7dfqYho6DDWxS7hScu6qznkg)        |
| agentic-rag                 | [src/](agentic-rag/)            | [Agentic RAG](https://my.feishu.cn/docx/WUbedtQb0oIGcQxeU25cGg9Sn7g)           |
| agent-planning              | [src/](agent-planning/)         | [Plan-and-Execute](https://my.feishu.cn/docx/IN0Td6b5NoaCHDxcmeFc6QRpnwh)      |
| context-eng                 | [src/](context-eng/)            | [上下文工程](https://my.feishu.cn/docx/J73XdzSQ4oYjqXxBSQzcquUvn6b)            |
| agent-memory                | [src/](agent-memory/)           | [Agent 记忆管理](https://my.feishu.cn/docx/DkcDdigcTo4fqHx0BS4clkXcn0d)        |
| skill-vs-mcp                | —                               | [Skill vs MCP](https://my.feishu.cn/docx/YWlRdWH6boM3KhxMdDMcjwPrn7e)          |
| conditional-routing         | —                               | [条件路由](https://my.feishu.cn/docx/HAg6deTCPo0IkJxzM4wcZdmvnMg)              |
| interrupt-hitl              | —                               | [危险操作确认](https://my.feishu.cn/docx/WSZldYMRRoE5AxxzCrscfvdFnTf)          |
| tool-progress-stream        | —                               | [工具进度流](https://my.feishu.cn/docx/PpS3djZzWotDWrxKByHc4IVjnxh)            |
| sse-streaming               | —                               | [SSE 流式输出](https://my.feishu.cn/docx/Ny8wdpZx7otZDExGSjDcobScnEg)          |
| deepseek-harness            | —                               | [DeepSeek Harness 拆解](https://my.feishu.cn/docx/OcfBd5tkQoADpIxboI0cg6b3nEg) |
| streaming-rewrite           | —                               | [边生成边显示](https://my.feishu.cn/docx/FVuhdjXXcoDntfxUb9ncxIj3n9f)          |
| langgraph-dirty-recovery    | —                               | [脏状态怎么救](https://my.feishu.cn/docx/NgfOddWGzoeW6exoNdTcN72znlf)          |
| dirty-state                 | —                               | [脏状态清理](https://my.feishu.cn/docx/H13NdHKFfoa26JxdP47cxTunngb)            |
| function-calling            | —                               | [Function Calling](https://my.feishu.cn/docx/LVKKd2sA3oRrTGxG8Y8cXEWXnGh)      |
| tool-schema                 | —                               | [工具 Schema 设计](https://my.feishu.cn/docx/GXKtdcWd7oV1r9xb4HwcEKWgnMh)      |
| langchain-structured-output | —                               | [LangChain 结构化输出](https://my.feishu.cn/docx/K852dO70ZowtguxTLLncNFkSnRh)  |
| langgraph-stategraph        | —                               | [LangGraph StateGraph](https://my.feishu.cn/docx/CGTzdRKMkoAzyIxmGuBcmFZ6ntg)  |
| react-pattern               | —                               | [ReAct 模式](https://my.feishu.cn/docx/PxmAdg3nmol6aQxMmsxc1nQ5n8b)            |
| agent-loop                  | —                               | [Agent 循环机制](https://my.feishu.cn/docx/BBeVdLqgRoanWwx2aB0cI8Htnl3)        |
| prompt-template             | —                               | [Prompt Template 指南](https://my.feishu.cn/docx/D9Gddf1vPozeHcx0KnAcYJlnnWb)  |

## 待写文章（代码已完成，README 为占位）

| slug                 | 代码                          | 说明                                                            |
| -------------------- | ----------------------------- | --------------------------------------------------------------- |
| agent-token-budget   | [src/](agent-token-budget/)   | Token 预算/成本控制，大纲在 ai-agent-knowledge/outline-token.md |
| agent-pg-persistence | [src/](agent-pg-persistence/) | PG 持久化，大纲在 ai-agent-knowledge/outline-pg-agent.md        |
| mcp-adapters         | [src/](mcp-adapters/)         | MCP 全链路演示，mcp-tools 的补充素材                            |

## 不属于本仓库的体系

- **DeepSeek Harness 源码精读**（精读一二三 + 知识地图）：代码在 `ai-agent-code-lab`，文档在 `deepseek-harness-study`，同步脚本 `sync-dsh-docs.sh`
- **dsh 精读（一）** `2026-08-16-dsh-agent-loop-analysis.md/xml` 同理归属 dsh 体系
