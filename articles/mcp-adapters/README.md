---
feishu_doc: ""
status: 代码示例（无独立文章，MCP 协议的补充素材）
---

# MCP 标准化工具接入完整链路演示（Host / Agent 侧）

> ⚠️ 无独立飞书文章。这是《MCP 到底解决了什么痛点？》（`mcp-tools/README.md`）的补充代码素材。

## 代码说明

完整链路（真实运行，不 mock）：

- LangGraph Agent (`createReactAgent`) 通过 MCP 协议接入工具
- `src/mcp-server.ts`：MCP server 端实现
- `src/index.ts`：Host / Agent 侧接入演示

## 运行

```bash
cd articles/mcp-adapters
pnpm install
pnpm dev   # 或见 run-output.txt 看上一次运行结果
```

## 关联

- 主文章：[mcp-tools](../mcp-tools/README.md)
