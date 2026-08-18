# Agent 规划：从直答到 Plan-and-Execute 的动态规划

《Agent 怎么"先想再做"？》配套代码。5 步渐进式，每步独立可运行，展示 Agent 规划能力的演进：

```
articles/agent-planning/
├── package.json          # 依赖 + 每步运行脚本
├── README.md             # 本文
└── src/
    ├── shared.ts         # LLM 初始化 + 4 个模拟工具 + 计划 Schema + 状态类型（多步复用）
    ├── index.ts          # 汇总入口（默认跑全部 5 步，--stepN 单跑）
    └── steps/
        ├── step-01-direct.ts            # 无规划直答（痛点基线）
        ├── step-02-plan-execute.ts      # 先列计划再执行（Plan-then-Execute 雏形）
        ├── step-03-tool-loop.ts         # 计划 + 工具闭环（依赖调度 + 结果回填）
        ├── step-04-planner-executor.ts  # 规划器/执行器分离（Planner/Executor）
        └── step-05-replan.ts            # 动态重规划（失败时重新拆解剩余步骤）
```

## 运行

前置：仓库根目录 `.env` 配置 `LLM_API_KEY`（支持 DeepSeek 或任意 OpenAI 兼容端点）。

```bash
# 全部 5 步依次执行
pnpm run:planning

# 单步执行
pnpm run:planning:step1   # 无规划直答
pnpm run:planning:step2   # 先列计划再执行
pnpm run:planning:step3   # 计划 + 工具闭环
pnpm run:planning:step4   # 规划器/执行器分离
pnpm run:planning:step5   # 动态重规划

# 或直接指定包
pnpm --filter @articles/agent-planning run start:step3
```

## 5 步演进路径

| Step | 主题              | 核心机制                                  | 解决什么                           |
| ---- | ----------------- | ----------------------------------------- | ---------------------------------- |
| 01   | 无规划直答        | 单次调用直接回答多步任务                  | 基线：暴露漏步骤/顺序乱/数据编造   |
| 02   | 先列计划再执行    | LLM 先输出 JSON 计划，再按顺序执行        | 规划先行：步骤齐全、依赖明确       |
| 03   | 计划 + 工具闭环   | 依赖调度（pending→done/failed）+ 结果回填 | 闭环：依赖不满足会等待，结果可复用 |
| 04   | 规划器/执行器分离 | Planner 只拆计划、Executor 只执行单步     | 职责单一：规划与执行独立演化       |
| 05   | 动态重规划        | 失败触发 replan，重新拆解剩余步骤         | 自适应：计划不是一次性的           |

## 演示场景

多步任务（含依赖关系）：
"查询用户张三的信息和他的订单历史，计算他应得的折扣金额，然后生成一份简明报告。"

```
step-1 (get_user_info)  ─┐
                          ├→ step-3 (calculate_discount) → step-4 (generate_report)
step-2 (get_orders)     ─┘
```

Step 05 会模拟 get_orders 调用超时，展示重规划如何调整剩余计划。

## 对应真实设计

- Step 02 → 神光课程 todoListMiddleware（write_todos 先列步骤再执行）
- Step 03 → LangGraph Plan-and-Execute 教程的依赖调度
- Step 04 → deepagents 的 createDeepAgent（Planner/Executor 分离）
- Step 05 → LangGraph replan 节点 / dsh 失败后的 replan 策略
