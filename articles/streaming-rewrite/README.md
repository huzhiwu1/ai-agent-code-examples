---
feishu_doc: FVuhdjXXcoDntfxUb9ncxIj3n9f
---

# 全栈 AI Agent 工程师 · 08-16 · LLM 的回答怎么做到"边生成边显示"？

上一篇我们解决了会话的脏状态，但聊天界面还有个更基础的问题：用户发完消息，要等好几秒，然后模型回答"整段"突然出现，用着很呆。ChatGPT 那种一个字一个字蹦出来的效果是怎么做到的？

这篇文章我先查了 AI SDK 官方文档（Generating Text / useChat 两篇），确认了标准链路长什么样，再动手复现两种错误写法，最后搭一个带会话的流式聊天服务。全程不依赖任何项目仓库，你自己建个空目录就能跟着跑。

## 实验 0：等全部生成完才返回

先看最常见的错误写法——用 res.text() 把响应体一次性读完。这个 API 的行为是"等整个响应体收完才返回"，所以流式接口在它手里也会变成整段：

```typescript
const res = await fetch("/api/chat", { method: "POST", body: JSON.stringify({ messages }) });
const rawText = await res.text(); // ← 会等整个响应体收完才返回
render(rawText); // ← 只能一次性渲染，用户看到"卡顿后整段出现"
```

真实输出：服务端其实分 4 个事件陆续推了内容，但 res.text() 全收完才拿到：

```bash
原始 SSE 报文（服务端 4 个事件，逐个到达）：
data: {"type":"text-delta","text":"你好"}
data: {"type":"text-delta","text":"，我是"}
data: {"type":"text-delta","text":"AI 客服。"}
data: [DONE]

res.text() 一次性拿到的内容（生成完才有）：
data: {...}data: {...}data: {...}data: [DONE]

→ 问题：LLM 生成要几秒，这期间前端什么都渲染不了。
```

问题很清楚：模型是边生成边推的（4 个事件陆续到达），但 res.text() 把流攒成了整段。用户体验就是"卡顿几秒 → 整段出现"。

## 实验 1：手写解析，[DONE] 混进正文

好，不用 res.text() 了，改成自己拆字符串。但手写解析有个经典坑——SSE 协议的结束标记 [DONE] 被当成正文拼进去了：

```typescript
const parsed = rawText
  .split("\n") // 按换行拆成一行行
  .filter((line) => line.startsWith("data:")) // 只留 data: 开头的行（SSE 事件格式）
  .map((line) => line.replace("data:", "").trim()) // 去掉 data: 前缀
  .join(""); // 拼成一段
// 坑：没有处理 [DONE] 结束标记，它被当成正文拼进去了
```

```bash
前端渲染结果：
{"type":"text-delta","text":"你好"}{"type":"text-delta","text":"，我是"}{"type":"text-delta","text":"AI 客服。"}[DONE]

→ 问题：[DONE] 结束标记混进正文，用户看到 '[DONE]' 两个字。
```

除了 [DONE]，手写还要处理：data: 前缀、多行 data、JSON 半行（一个块可能切在 JSON 中间）、断线重连。这些细节加起来，就是"手写流式很难"的原因。

## 实验 2：原生 fetch 流式读，边读边渲染

正确姿势其实也不复杂：用 reader.read() 循环逐块读响应体，每收到一块就解析渲染，不等全部收完。这段代码是流式输出的地基，值得背下来：

```typescript
const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "用一句话介绍你自己" }],
    stream: true, // 关键：流式模式，模型边生成边推送
  }),
});

const reader = res.body!.getReader(); // ReadableStream 的读取器
const decoder = new TextDecoder(); // 把二进制块（Uint8Array）解码成字符串
let buffer = "";
while (true) {
  const { done, value } = await reader.read(); // done=true 表示流读完了
  if (done) break;
  buffer += decoder.decode(value, { stream: true }); // 处理多字节字符被切半

  const lines = buffer.split("\n");
  buffer = lines.pop() ?? ""; // 最后一行可能不完整（JSON 被切半），留到下次拼
  for (const line of lines) {
    if (!line.startsWith("data:")) continue; // 只处理 data: 开头的行
    const payload = line.slice(5).trim(); // 去掉 "data:" 前缀
    if (payload === "[DONE]") continue; // [DONE] 是结束标记，不是正文
    const json = JSON.parse(payload);
    const delta = json.choices?.[0]?.delta?.content ?? ""; // 本轮的增量文本
    if (delta) render(delta); // ← 边读边渲染，核心就这一行
  }
}
```

真实跑一遍（DeepSeek 官方 API，2026-08-16 实测），终端里能看到文字逐块蹦出来：

```bash
我是DeepSeek，一个由深度求索公司创造的AI助手，乐于为你解答问题、提供帮助。

→ 共 23 个增量块。模型边生成边吐字，前端每收到一块就渲染一次。
```

23 个增量块，每收到一块就打印一次。把 render(delta) 换成 React 的 setState，就是逐字渲染的效果。流式输出的本质，就是这一小段 reader 循环。

## 工程化：AI SDK 标准链路（官方新版 API）

手写 reader 循环能跑，但每次都要处理协议细节。官方文档（ai-sdk.dev）给出的标准做法是用 AI SDK 把两端都包成标准件：后端 streamText 包装模型流，前端 useChat 消费并逐字渲染，一行解析都不用写。

先看后端。AI SDK 最新版（v5）的推荐写法，POST 接口用 streamText 调模型，再用 createUIMessageStreamResponse 包装成标准流协议返回：

```typescript
import { streamText, createUIMessageStreamResponse, convertToModelMessages } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

// 用 OpenAI 兼容协议接 DeepSeek
const deepseek = createOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com/v1",
});

export async function POST(req: Request) {
  const { messages } = await req.json();
  const result = streamText({
    model: deepseek("deepseek-v4-flash"),
    messages: await convertToModelMessages(messages),
  });
  // 返回 AI SDK 标准数据流协议（SSE 格式），useChat 开箱即用
  return createUIMessageStreamResponse({ stream: result.toUIMessageStream() });
}
```

前端用 useChat。官方新版 API 通过 transport 指定接口地址，sendMessage 发消息，status 表示当前状态（submitted/streaming/ready/error），stop 中断生成：

```typescript
"use client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState } from "react";

export default function Chat() {
  const { messages, sendMessage, status, stop } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const [input, setInput] = useState("");

  return (
    <div>
      {messages.map((m) => (
        <p key={m.id}><b>{m.role === "user" ? "我" : "AI"}：</b>{m.content}</p>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); if (input.trim()) { sendMessage({ text: input }); setInput(""); } }}>
        <input value={input} onChange={(e) => setInput(e.target.value)}
               disabled={status !== "ready"} placeholder="说点什么..." />
        <button type="submit" disabled={status !== "ready"}>发送</button>
        {(status === "submitted" || status === "streaming") && (
          <button type="button" onClick={() => stop()}>停止生成</button>
        )}
      </form>
    </div>
  );
}
```

注意：早期版本（ai@3.x）的写法是 useChat({ api: "/api/chat" }) + handleSubmit + isLoading，功能一样，但官方文档现在推荐 transport + sendMessage + status 这套新版 API，语义更明确（status 直接给出 streaming/ready/error 状态，不用自己猜 isLoading）。

## 实战：从零搭一个带会话的流式聊天服务

前面都是片段，现在拼一个完整的：不依赖任何框架，一个 Node HTTP server + 原生 fetch 调 DeepSeek，提供"带多轮记忆的流式聊天 API"。整个文件就一个 chat-server.ts，四块代码，每块都能单独看懂，最后串起来就是完整服务。

第零块：文件头。Node 内置 http 模块起服务，KEY 从环境变量读（source \~/.zshrc 里 export 过）：

```typescript
import http from "node:http";

const KEY = process.env.DEEPSEEK_API_KEY ?? "";
const MAX_ROUNDS = 6; // 上下文截断：保留最近 N 轮对话
const MODEL_TIMEOUT_MS = 30_000; // 模型 30s 没响应就断流
```

第一块：会话存储 + 上下文截断。演示用 Map 存历史（生产换 Redis），每次只保留系统提示 + 最近 6 轮，防止历史无限膨胀：

```typescript
// 会话存储：sessionId → 消息历史
const sessions = new Map<string, Array<Record<string, unknown>>>();

function getSession(sessionId: string) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, [{ role: "system", content: "你是聊天助手。回答要简洁，用中文。" }]);
  }
  return sessions.get(sessionId)!;
}

// 截断：系统提示 + 最近 MAX_ROUNDS 轮（每轮 = user + assistant 两条）
function trimHistory(messages: Array<Record<string, unknown>>) {
  const system = messages.filter((m) => m.role === "system");
  const tail = messages.filter((m) => m.role !== "system").slice(-MAX_ROUNDS * 2);
  return [...system, ...tail];
}
```

第二块：流式调模型。把实验 2 的 reader 循环封装成 streamChat，回调 onDelta 逐块吐字，支持 AbortSignal 中断（超时/客户端断开都能用）：

```typescript
async function streamChat(
  messages: Array<Record<string, unknown>>,
  onDelta: (text: string) => void,
  signal: AbortSignal
) {
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: "deepseek-v4-flash", messages, stream: true }),
    signal, // 超时 / 客户端断开时中止
  });
  if (!res.ok || !res.body) throw new Error(`模型接口 ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content ?? "";
      if (delta) onDelta(delta);
    }
  }
}
```

第三块：HTTP 服务。SSE 响应头 + 会话读写 + 超时兜底 + 客户端断开 abort，把上面两块串起来：

```typescript
const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/chat") {
    res.writeHead(404).end();
    return;
  }
  // 读请求体：{ sessionId, message }
  let body = "";
  for await (const chunk of req) body += chunk;
  const { sessionId = "default", message } = JSON.parse(body);

  // SSE 响应头
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // 会话：追加用户消息 → 截断 → 流式
  const history = getSession(sessionId);
  history.push({ role: "user", content: message });

  // 超时：30s 没响应就发 error 事件断流
  const timeout = setTimeout(() => {
    res.write(`d:${JSON.stringify({ type: "error", message: "模型响应超时" })}\n`);
    res.write(`e:${JSON.stringify({ type: "done" })}\n`);
    res.end();
  }, 30_000);

  // 停止：客户端断开（关页面/点停止）→ abort 模型请求，不再烧 token
  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  try {
    let full = "";
    await streamChat(
      trimHistory(history),
      (delta) => {
        full += delta;
        res.write(`0:${JSON.stringify(delta)}\n`); // 文本增量
      },
      abortController.signal
    );
    clearTimeout(timeout);
    history.push({ role: "assistant", content: full }); // 记入历史，供下一轮用
    res.write(`e:${JSON.stringify({ type: "done" })}\n`);
    res.end();
  } catch (err) {
    clearTimeout(timeout);
    if (abortController.signal.aborted) {
      res.end(); // 主动停止：只是断流，不写 error
    } else {
      res.write(`d:${JSON.stringify({ type: "error", message: (err as Error).message })}\n`);
      res.write(`e:${JSON.stringify({ type: "done" })}\n`);
      res.end();
    }
  }
});

server.listen(8787, () => {
  console.log("聊天服务已启动: http://127.0.0.1:8787/chat");
});
```

启动服务，用 curl 真实测三组（DeepSeek 官方 API，2026-08-16 实测）。测试 1 先让 s1 会话记住"我叫小明"，协议行是逐字增量加结束标记：

```bash
$ curl -N -X POST http://127.0.0.1:8787/chat -H "Content-Type: application/json" \
  -d '{"sessionId":"s1","message":"我叫小明"}'
0:"你好"
0:"，"
0:"小明"
0:"！"
0:"很高兴"
0:"认识"
0:"你"
0:"。"
0:"有什么"
0:"我可以"
0:"帮"
0:"你的"
0:"吗"
0:"？"
e:{"type":"done"}
→ 完整回答：你好，小明！很高兴认识你。有什么我可以帮你的吗？
```

测试 2 是关键——同一会话第二问，模型记得上下文：

```bash
$ curl -N -X POST http://127.0.0.1:8787/chat -H "Content-Type: application/json" \
  -d '{"sessionId":"s1","message":"我叫什么名字？"}'
0:"你"
0:"刚才"
0:"告诉我"
0:"你"
0:"叫"
0:"小明"
0:"，"
0:"所以我"
0:"记得"
0:"你"
0:"叫"
0:"小明"
0:"！"
e:{"type":"done"}
→ 完整回答：你刚才告诉我你叫小明，所以我记得你叫小明！ ✅ 多轮记忆生效
```

测试 3 换新会话 s2，模型不认识"小明"——会话隔离正确：

```bash
$ curl -N -X POST http://127.0.0.1:8787/chat -H "Content-Type: application/json" \
  -d '{"sessionId":"s2","message":"我叫什么名字？"}'
0:"我还"
0:"不知道"
0:"你的"
0:"名字"
0:"呢"
0:"，"
0:"方便"
0:"告诉我"
0:"吗"
0:"？"
e:{"type":"done"}
→ 完整回答：我还不知道你的名字呢，方便告诉我吗？ ✅ 会话隔离
```

这个例子覆盖了生产要件的四件事：多轮记忆（会话 Map + 历史回填）、上下文控制（截断防止 token 爆炸）、超时兜底（30s 发 error 事件）、停止生成（req close → abort）。把 HTTP 层换成 Next.js route handler、streamChat 换成 streamText、前端接 useChat，就是完整的产品形态。

## 总结

流式输出的本质是 reader 循环：fetch 响应体逐块读，每收到一块就解析渲染，不等全部生成完。核心就两件事：请求带 stream: true，响应用 getReader() 边读边 render。

手写解析的坑集中在协议细节：data: 前缀、[DONE] 结束标记、JSON 半行、断线重连。能写对，但每次都要写。

AI SDK 把两端标准化：后端 streamText 包装模型流，前端 useChat 消费逐字渲染，附赠 status/stop。理解了 reader 循环这层地基，再用 useChat 就知道它在替你干什么。

带会话的完整服务还要管四件事：多轮记忆、上下文截断、超时兜底、停止时 abort。这四件是生产聊天服务的基本功，缺一个都会在真实使用中暴露问题。

## 面试考点

- **为什么需要流式输出？** 高分要点：LLM 生成要几秒，等全部返回用户盯着空白页干等；边生成边渲染让第一行字几百毫秒内出现。结合项目：聊天界面从"整段出现"改成逐字渲染。
- **手写流式读取的核心代码是什么？** 高分要点：fetch 带 stream: true → res.body.getReader() 循环 read() → TextDecoder 解码 → 按行拆 data: → 跳过 [DONE] → 解析 delta.content 渲染。要能背出 reader 循环的骨架。
- **useChat 帮你做了什么？** 高分要点：发请求、解析流协议（text-delta/finish 等事件）、维护 messages 数组增量更新、提供 status/stop；stop 通过 AbortController 中断请求。
- **追问：前端 stop 之后后端还在跑怎么办？** 要点：前端 abort 只是断开连接，后端要监听 req close / 取消信号来中断模型调用（本例是 req.on("close") → abortController.abort()），否则还在烧 token。

## 参考来源

- [AI SDK 文档：Generating and Streaming Text（streamText / generateText）](https://ai-sdk.dev/docs/ai-sdk-core/generating-text)
- [AI SDK 文档：useChat（transport / sendMessage / status / stop）](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot)
- [MDN：ReadableStream（getReader / read）](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream)
- [MDN：TextDecoder（stream: true 处理多字节字符切半）](https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder)
