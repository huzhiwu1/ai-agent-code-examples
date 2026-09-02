# Qoder 任务：补强 multi-agent-supervisor 教学仓库代码与文章

## 目标

把 `articles/multi-agent-supervisor` 改成“代码示例更容易读、教学正文更容易懂、生产级细节更完整”的版本，并让 Qoder 继续补齐对应实现。

## 这次要做的事情

### 1. 让文章里的 Step 2–9 更容易读懂

文章现在的 step 代码片段过于压缩，读者会卡在这些点：

- Step 02 的 `routeIntent()` 只有函数名，没有把“手动交接怎么做”讲透
- Step 03–05 的关键代码只写了一半，读者不容易把“职责边界”“状态硬约束”串起来
- Step 06–09 也需要继续补“函数名 + 功能 + 作用”，哪怕实现略写，也要让读者知道这段代码在干什么

要求：

- 保留真实仓库中的函数名、节点名、工具名
- 可以省略完整实现，但**不能只写 `/* ... */`**，要补上“函数名 + 职责 + 输入输出”的说明
- 重要步骤要补一小段“这一节的重点是什么”，帮助初学者快速抓住主线

### 2. 把 A2A（Agent-to-Agent）内容补进文章

当前文章更偏“Supervisor 调度多个 Worker”，还缺少“Agent 之间直接协作”的设计视角。

建议在文章里新增一个 A2A 小节，至少讲清楚：

- 任务交接时要带哪些字段
- 谁能发起请求，谁能响应
- 多个 Agent 结果冲突时谁来裁决
- 某个 Agent 挂了后怎么回退

要求：

- 不要把 A2A 写成空泛概念
- 要明确它和 Supervisor/Worker 的关系
- 让读者知道：A2A 的关键不是“互相聊天”，而是“协作协议、证据链、裁决和回退”

### 3. 保留可读性，别把代码压得太狠

这篇文章的定位是“生产级实战”，但读者是初学者，所以需要：

- 关键函数至少写出名字和用途
- 可以简写的地方，也要说明“为什么可以省略”
- 不能让示例变成只有骨架没有内容

### 4. 给出一份可交给 Qoder 的代码实现任务

请基于现有仓库，继续完善对应代码。

重点是：

- 代码示例要和文章说法一致
- 如果文章里提到某个函数/节点/步骤，Qoder 能在源码里对应找到
- 如果当前代码已经能跑，只做增强，不改 step 的结构和运行方式

## 你需要重点关注的仓库

- `articles/multi-agent-supervisor/README.md`
- `articles/multi-agent-supervisor/src/shared.ts`
- `articles/multi-agent-supervisor/src/steps/step-02-handoff.ts`
- `articles/multi-agent-supervisor/src/steps/step-03-supervisor.ts`
- `articles/multi-agent-supervisor/src/steps/step-04-state-passing.ts`
- `articles/multi-agent-supervisor/src/steps/step-05-deterministic-routing.ts`
- `articles/multi-agent-supervisor/src/steps/step-06-reflection.ts`
- `articles/multi-agent-supervisor/src/steps/step-07-budget-observability.ts`
- `articles/multi-agent-supervisor/src/steps/step-08-production.ts`
- `articles/multi-agent-supervisor/src/steps/step-09-parallel-fanout.ts`

## 修改原则

- 不改 step 文件名
- 不改 `export async function main()` 签名
- 不改 `src/index.ts` 批量运行方式
- 不改 4 个工具的名字和 schema
- 不改 Step 01–05 的行为，只增强可读性和说明

## 你要交付什么

1. 更新后的文章正文
2. Qoder 可直接执行的代码改进
3. 最后给我一份变更摘要，告诉我：
   - 哪些地方是“补代码示例”
   - 哪些地方是“补说明”
   - 哪些地方是“A2A 新增内容”

## 推荐输出风格

- 先写清楚“这段代码解决什么问题”
- 再写“为什么这么设计”
- 最后再放代码
- 如果某段可以省略实现，一定要写清楚“为什么省略、保留什么信息”
