---
feishu_doc: D9Gddf1vPozeHcx0KnAcYJlnnWb
---

# Prompt Template 完全入门指南

> 面向小白的 LangChain Prompt Template 学习文档
>
> 配套代码

<figure view-type="Card"><source name="01-prompt-template.mjs" href="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=OWRkOWJiMjk5NWY2ZDg4ODFlMTFkOWQ5NTBmZmI3NzZfNmI3NjE0ZjgyNDE1ZDFiMjhmMWVmYzY4MWNhNjNkNmVfSUQ6NzYzNjQyODc5MzE2MjQzNTc3M18xNzg3MjM2MDQzOjE3ODcyMzk2NDNfVjM" mime="text/javascript" size="2266" token="RowLbgPXzoCaZMxRtNLc8GUBnop"/></figure>

<figure view-type="Card"><source name="02-chat-prompt-template.mjs" href="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=MmM3OTI4ZGYyYjVhNGRiMTYyMTRlZWUyMWRmZmYzOGJfYzEzZTc4MzY2NjZkNmQ5YTBhNGU1NGM0NjljOGViMGFfSUQ6NzYzNjQyODc5OTE2NDMwNDM0N18xNzg3MjM2MDQzOjE3ODcyMzk2NDNfVjM" mime="text/javascript" size="2675" token="XlJYbSLjKoh3tSxrwGRcyUutnTg"/></figure>

<figure view-type="Card"><source name="03-fewshot-prompt-template.mjs" href="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=ZjJkYjA5OTNmNzJmOTc2MjllYmIyNGU4ZmUzZGM5ZWNfZDFjZmUyMTk2NGI3ODkyOTJjZmRmYWQyMzg1OTJmZWFfSUQ6NzYzNjQyODc5ODkwMDIxMDY1MF8xNzg3MjM2MDQzOjE3ODcyMzk2NDNfVjM" mime="text/javascript" size="3613" token="GTl5bTNx1oHqqfxPN7Rcb2nHnFc"/></figure>

<figure view-type="Card"><source name="04-messages-placeholder.mjs" href="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NmE4Y2IzMjYxNjE4MDM4YjVmMGUwODBiN2E2ZTMyOTFfYTE5YTJlMzE5Njc0M2JlOGIzYjI4ZWVlNzBlNDBiMzdfSUQ6NzYzNjQyODgwMzQ5NzE1MTY5M18xNzg3MjM2MDQzOjE3ODcyMzk2NDNfVjM" mime="text/javascript" size="2984" token="WdlLbyffqopipnx551wccz8AnHm"/></figure>

<figure view-type="Card"><source name="05-example-selector.mjs" href="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=OTNhYjEyM2JlNTgzOGNkYmQ2N2QyMWFlNmY5MTEwOWRfNDkwMjBhOTNiNmIyZmE2MGI3ZWIxYzFjMDEyNWNmM2JfSUQ6NzYzNjQyODgwNDk5NDYxNjUyMF8xNzg3MjM2MDQzOjE3ODcyMzk2NDNfVjM" mime="text/javascript" size="4564" token="J6QDbI6DfowMZGxCiGncfQgonGg"/></figure>

<figure view-type="Card"><source name="06-pipeline-prompt-template.mjs" href="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=Y2VhM2RhNGYwMzQ4NTY4YjgwNzEzODVhNzI2ZjI2MWZfOWUwZTg2YTAxZDFjMTk0NzlmM2FlNjBiMTNhNjAzNDlfSUQ6NzYzNjQyODgwOTc5Mjc4NTM2MV8xNzg3MjM2MDQzOjE3ODcyMzk2NDNfVjM" mime="text/javascript" size="3990" token="BFTIbFOl1o14ehxVGKNcNOmAnjc"/></figure>

<figure view-type="Card"><source name="07-weekly-report-writer.mjs" href="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=ZDA0YTk5ODdjNjk3ZjIxNGRhNGExYzc5MTgzNWUxYmJfN2M2NzgxZTg5YzIwZDFhMTA5ODFhYzQ2MDM1MTRjNTFfSUQ6NzYzNjQyODgxMzA5Nzg2NDM3Ml8xNzg3MjM2MDQzOjE3ODcyMzk2NDNfVjM" mime="text/javascript" size="5541" token="QcxSbkPx5ozpmqx4SwZcSqANnyd"/></figure>

---

## **一、为什么需要 Prompt Template？**

想象你要让 AI 写周报，每次都要手写一大段提示词：

```Plain Text
你是一名工程团队负责人，需要根据本周数据写一份周报...
公司：xxx，团队：xxx，时间：xxx...
```

**痛点**：

- 每次复制粘贴，容易遗漏关键信息
- 风格不统一，这周写的和上周不一样
- 团队协作时，每个人写的 prompt 质量参差不齐

**Prompt Template 解决的就是这个问题**：把「固定的框架」和「动态的数据」分开，像填空题一样，框架写好，数据填入。

---

## **二、七大核心概念（按学习顺序）**

### **01. PromptTemplate —— 最基础的字符串模板**

**是什么**：带占位符 \`{xxx}\` 的字符串模板，用实际数据替换后生成完整 prompt。

**核心代码**：

```JavaScript
import { PromptTemplate } from "@langchain/core/prompts"

// 定义模板（带占位符）
const template = PromptTemplate.fromTemplate(`
你是一名工程团队负责人...
公司：{company}
团队：{team}
开发活动：{activities}
`)

// 填入数据，生成完整 prompt
const prompt = await template.format({
    company: "星航科技",
    team: "数据智能平台组",
    activities: "- 阿兵：完成 Canary 发布，提交 27 次"
})

// prompt 现在是一串完整的字符串，直接发给 LLM
const response = await model.invoke(prompt)
```

**知识扩展**：

- `{xxx}` 是模板语法，类似字符串插值，但功能更强
- 适合简单场景：一次性任务、不需要区分角色的调用
- 如果 LLM 是聊天模型（Chat Model），更推荐用 ChatPromptTemplate（见下一节）

---

### **02. ChatPromptTemplate —— 聊天消息模板**

**是什么**：生成「消息数组」而非纯字符串，每条消息带角色标签（system / human / ai）。

**为什么需要角色？**

| 角色     | 作用                             | 权重                                    |
| -------- | -------------------------------- | --------------------------------------- |
| `system` | 设定全局人设（你是谁、什么风格） | 最高，影响整个回复                      |
| `human`  | 用户输入                         | 告诉 LLM "这是用户的问题"               |
| `ai`     | 助手回复                         | 多轮对话时让 LLM 知道"我之前这么回答过" |

**核心代码**：

```JavaScript
import { ChatPromptTemplate } from "@langchain/core/prompts"

const chatPrompt = ChatPromptTemplate.fromMessages([
    // system 设定全局人设
    ["system", "你是一名资深工程团队负责人，写作风格：{tone}。"],

    // human 提供用户输入
    ["human", `公司：{company}，团队：{team}，请写周报。`]
])

// 生成消息数组（不是字符串！）
const messages = await chatPrompt.formatMessages({
    tone: "专业、清晰",
    company: "星航科技",
    team: "AI 平台组"
})

// messages = [SystemMessage, HumanMessage]
const response = await model.invoke(messages)
```

**知识扩展**：

- Chat Model（如 GPT-4、Qwen）更适合接收消息数组，效果更好
- system 消息虽然只出现一次，但对整个回复的「调性」影响最大
- 位置很重要：`system → human`，LLM 先读人设，再看问题

---

### **03. FewShotPromptTemplate —— 给 AI 看示例，让它"照猫画虎"**

**是什么**：在 prompt 里塞几个「输入 → 期望输出」的示例，让 LLM 模仿风格和结构。

**为什么有效？**

写规则教 AI "周报要有表格、语气要专业" 很难。但给 2-3 个写得好的示例，AI 的注意力机制会自动"关注"示例中的模式，新任务时自动模仿。

> 示例质量 > 数量：2-3 个高质量示例 > 10 个 mediocre 示例

**核心代码**：

```JavaScript
import { FewShotPromptTemplate, PromptTemplate } from "@langchain/core/prompts"

// 步骤 1：准备示例
const examples = [
    {
        requirement: "重点突出稳定性",
        style: "稳健、保守",
        snippet: "- 处理 P1 故障 1 起...\n- 补充限流与熔断策略..."
    },
    {
        requirement: "偏向对外展示成果",
        style: "积极、突出成果",
        snippet: "- 上线实时订单看板...\n- 完成 2 场跨部门分享..."
    }
]

// 步骤 2：定义单条示例长什么样
const examplePrompt = PromptTemplate.fromTemplate(`
用户需求：{requirement}
期望风格：{style}
示例输出：{snippet}
---`)

// 步骤 3：组合成 FewShotPromptTemplate
const fewShotPrompt = new FewShotPromptTemplate({
    examples,
    examplePrompt,
    prefix: "下面是几条周报示例：\n",
    suffix: "\n现在请根据示例风格，为新场景写周报：\n场景：{current_requirement}",
    inputVariables: ["current_requirement"]
})

// 步骤 4：传入新任务
const prompt = await fewShotPrompt.format({
    current_requirement: "我们本周在做 AI 助手项目..."
})
```

**知识扩展**：

- Few-shot 是教 LLM 最快的方式，比写规则更有效
- 示例要覆盖不同场景（保守型、积极型、简洁型），让 AI 学会"变通"
- 适用于：风格迁移、格式固定（表格/JSON）、复杂推理

---

### **04. MessagesPlaceholder —— 动态插入对话历史**

**是什么**：在 ChatPromptTemplate 中预留一个「插槽」，运行时动态插入不确定数量的消息。

**解决什么问题？**

多轮对话的历史长度不固定（2轮、5轮、10轮都可能），没法用固定模板写死。MessagesPlaceholder 就是专门放「不确定数量」的内容。

**核心代码**：

```JavaScript
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts"
import { HumanMessage, AIMessage } from "@langchain/core/messages"

const chatPrompt = ChatPromptTemplate.fromMessages([
    ["system", "你是一名资深顾问..."],

    // 预留一个插槽，名字叫 'history'
    new MessagesPlaceholder("history"),

    ["human", "这是新问题：{current_input}"]
])

// 构造历史对话（长度不固定）
const history = [
    new HumanMessage("我们团队在做周报自动生成工具。"),
    new AIMessage("先把数据源梳理清楚。"),
    new HumanMessage("已经把 Prompt 拆成了四块。"),
    new AIMessage("接下来可以做成 Pipeline。")
]

// history 自动插入到 MessagesPlaceholder 的位置
const messages = await chatPrompt.formatMessages({
    history,
    current_input: "现在想优化协同编辑流程，有什么建议？"
})

// messages = [SystemMessage, HumanMessage, AIMessage, HumanMessage, AIMessage, HumanMessage]
```

**知识扩展**：

- MessagesPlaceholder 是"容器"，短期记忆是"数据来源"
- 位置很重要：`system → history → human`，LLM 先读人设，再读历史，最后看新问题
- 生产环境中，history 通常来自数据库或向量检索的记忆系统

---

### **05. ExampleSelector —— 智能选择最相关的示例**

**是什么**：FewShot 的「智能筛选器」，根据任务特征自动挑选最合适的示例，而不是把所有示例都塞进去。

**解决什么问题？**

- 示例多了浪费 token（LLM 上下文窗口有限）
- 示例少了覆盖不全
- 不同任务需要不同示例（稳定性场景 vs 成果展示场景）

**核心代码**：

```JavaScript
import { LengthBasedExampleSelector } from "@langchain/core/example_selectors"

// 准备一批示例（不同长度）
const examples = [
    { requirement: "突出稳定性", snippet: "- 处理 P1 故障..." },
    { requirement: "展示成果", snippet: "- 上线看板..." },
    { requirement: "非常简短", snippet: "本周运行平稳..." },
    { requirement: "详细技术周报", snippet: "- 研发：...\n- 测试：...\n- 上线：..." }
]

// 创建 Selector：按长度选择，总长度不超过 700 字符
const exampleSelector = await LengthBasedExampleSelector.fromExamples(examples, {
    examplePrompt,
    maxLength: 700,
    getTextLength: (text) => text.length
})

// 传给 FewShotPromptTemplate（替代固定的 examples 数组）
const fewShotPrompt = new FewShotPromptTemplate({
    examplePrompt,
    exampleSelector,  // 关键：用 Selector 替代 examples
    prefix: "...",
    suffix: "...",
    inputVariables: ["current_requirement"]
})
```

**知识扩展**：

- `LengthBasedExampleSelector`：按文本长度选，适合控制 prompt 总长度
- `SemanticSimilarityExampleSelector`：按语义相似度选（需要向量数据库），找"最像"的示例
- 生产环境常用策略：先用 Selector 选出 Top-K，再传给 FewShot

---

### **06. PipelinePromptTemplate —— 模块化组合 Prompt**

**是什么**：把一个大 Prompt 拆成多个可复用的小模块（人设、背景、任务、格式），再组合成最终 Prompt。

**为什么拆分？**

就像代码的组件化：小模块好维护、好测试、好复用。

| 模块 | 作用                     | 复用场景                |
| ---- | ------------------------ | ----------------------- |
| 人设 | 告诉 AI 它是谁、什么风格 | 周报、OKR、项目总结都用 |
| 背景 | 公司和团队信息           | 所有文档都需要          |
| 任务 | 本周具体工作             | 每周不同                |
| 格式 | Markdown/JSON/邮件       | 按需切换                |

**核心代码**：

```JavaScript
import { PipelinePromptTemplate, PromptTemplate } from "@langchain/core/prompts"

// 模块 A：人设（可复用）
const personaPrompt = PromptTemplate.fromTemplate(
    `你是一名资深工程团队负责人，写作风格：{tone}。`
)

// 模块 B：背景（可复用）
const contextPrompt = PromptTemplate.fromTemplate(
    `公司：{company}，团队：{team}，时间：{week}`
)

// 模块 C：任务
const taskPrompt = PromptTemplate.fromTemplate(
    `本周开发活动：{activities}，请提炼亮点、风险、计划。`
)

// 模块 D：格式
const formatPrompt = PromptTemplate.fromTemplate(
    `请用 Markdown 输出，结构：1.概览 2.详细拆分 3.表格`
)

// 最终模板：把模块拼在一起
const finalPrompt = PromptTemplate.fromTemplate(
    `{persona_block}\n{context_block}\n{task_block}\n{format_block}\n\n请生成周报：`
)

// 用 Pipeline 组合
const pipeline = new PipelinePromptTemplate({
    pipelinePrompts: [
        { name: "persona_block", prompt: personaPrompt },
        { name: "context_block", prompt: contextPrompt },
        { name: "task_block", prompt: taskPrompt },
        { name: "format_block", prompt: formatPrompt }
    ],
    finalPrompt
})

// 传入所有变量
const formatted = await pipeline.format({
    tone: "专业、清晰",
    company: "星航科技",
    team: "AI 平台组",
    week: "2025-05-05 ~ 2025-05-11",
    activities: "- 小李：完成工单流转..."
})
```

**知识扩展**：

- 改一处（如公司名），所有场景同步更新
- 不同场景可以复用相同模块：周报用「人设+背景」，OKR回顾也用「人设+背景」
- 和代码的"组件化"思想完全一致

---

### **07. 综合实战 —— 组合拳**

**是什么**：把 Pipeline + FewShot + ExampleSelector + ChatPromptTemplate 组合起来，做一个生产级的智能周报生成器。

**为什么组合这么多？** 因为单一技术解决不了一个复杂问题：

| 组件               | 解决什么问题                             |
| ------------------ | ---------------------------------------- |
| Pipeline           | 结构混乱 → 模块化、可复用                |
| FewShot            | 风格不对 → 让 AI 模仿示例语气            |
| ExampleSelector    | 示例太多 → 只选最相关的 2-3 个           |
| ChatPromptTemplate | 角色不清 → system 设定人设，human 给任务 |

**核心架构**：

```JavaScript
// 1. FewShot + ExampleSelector：准备示例库
const fewShotPrompt = new FewShotPromptTemplate({
    examplePrompt,
    exampleSelector,  // 智能筛选
    prefix: "...",
    suffix: "..."
})

// 2. Pipeline：模块化 Prompt
const pipeline = new PipelinePromptTemplate({
    pipelinePrompts: [
        { name: "persona_block", prompt: personaPrompt },
        { name: "context_block", prompt: contextPrompt },
        { name: "task_block", prompt: taskPrompt },
        { name: "format_block", prompt: formatPrompt },
        { name: "fewshot_block", prompt: fewShotPrompt }  // 把 FewShot 也作为一个模块
    ],
    finalPrompt: finalTemplate
})

// 3. ChatPromptTemplate：包装成消息数组
const chatPrompt = ChatPromptTemplate.fromMessages([
    ["system", "你是一名资深工程团队负责人。"],
    ["human", formatted]  // Pipeline 生成的最终 prompt
])
```

**知识扩展**：

- 生产环境的 Agent 几乎都是这种"组合拳"，没有银弹
- 每个组件解决一个小问题，组合起来解决大问题
- 这就像搭积木：Pipeline 是框架，FewShot 是风格，Selector 是优化，Chat 是载体

---

## **三、速查表**

```Plain Text
PromptTemplate        → 填空题模板（纯字符串）
ChatPromptTemplate    → 聊天消息（带角色标签 system/human/ai）
FewShot               → 给示例学风格
MessagesPlaceholder   → 动态插历史对话
ExampleSelector       → 智能挑示例省 token
Pipeline              → 模块化拼积木
```

---

## **四、学习路径**

```Bash
# 按顺序执行，每步理解一个概念
node src/prompt-template/01-prompt-template.mjs
node src/prompt-template/02-chat-prompt-template.mjs
node src/prompt-template/03-fewshot-prompt-template.mjs
node src/prompt-template/04-messages-placeholder.mjs
node src/prompt-template/05-example-selector.mjs
node src/prompt-template/06-pipeline-prompt-template.mjs
node src/prompt-template/07-weekly-report-writer.mjs
```

每执行一个文件，观察控制台输出的：

1. **格式化后的 Prompt** —— 理解模板是怎么被填充的

2. **AI 生成的内容** —— 理解不同组件对输出风格的影响
