---
feishu_doc: Ny8wdpZx7otZDExGSjDcobScnEg
---

# 全栈 AI Agent 工程师 · 08-13 · SSE 流式输出

上一篇讲了 Function Calling 让模型能调工具，但还有个更基础的问题：模型回答要等好几秒，用户盯着空白页干等。AI 聊天产品里，用户最烦的不是慢，而是"没反馈"——如果一个回答要等 6 秒才整包返回，用户会觉得系统卡死了；但如果 200ms 就开始吐字，哪怕总耗时一样，体感也完全不同。

这篇文章不依赖任何框架，从 Node.js 原生 http 模块开始，手写一个 SSE 服务，再对比 NestJS 的 @Sse() 装饰器帮你做了什么。

## 先上手：10 行写一个 SSE 服务

SSE 不是什么复杂协议，它就是一个 HTTP 长连接，服务端持续往客户端写 data 事件。先把响应头设成 text/event-stream，然后循环 res.write 就行：

```typescript
import http from "node:http";

const server = http.createServer((req, res) => {
  if (req.url !== "/sse") {
    res.writeHead(404).end();
    return;
  }

  // 三个响应头缺一不可
  res.writeHead(200, {
    "Content-Type": "text/event-stream", // 告诉浏览器这是事件流
    "Cache-Control": "no-cache", // 禁止代理缓存
    Connection: "keep-alive", // 保持长连接
  });

  let i = 0;
  const timer = setInterval(() => {
    res.write(`data: 消息 ${i}\n\n`); // 每个事件用空行分隔
    i++;
    if (i >= 5) {
      res.write("event: done\ndata: 流结束\n\n");
      res.end();
      clearInterval(timer);
    }
  }, 500);
});

server.listen(3100, () => console.log("SSE http://localhost:3100/sse"));
```

用 curl 测试（-N 禁用缓冲，否则 curl 会攒到一起才输出）：

```bash
$ curl -sN http://localhost:3100/sse
data: 消息 0

data: 消息 1

data: 消息 2

data: 消息 3

data: 消息 4

event: done
data: 流结束
```

这就是 SSE 的全部：Content-Type: text/event-stream + 循环写 data 行 + 空行分隔。没了。

## 前端怎么收：EventSource 一行代码

浏览器端不需要任何第三方库，EventSource 是原生 API：

```typescript
const es = new EventSource("http://localhost:3100/sse");

// 默认事件（data 行不带 event 字段的）
es.onmessage = (e) => console.log("收到:", e.data);

// 自定义事件（data 行前面有 event: done 的）
es.addEventListener("done", (e) => {
  console.log("结束:", e.data);
  es.close(); // 主动关闭连接
});

// 断线自动重连（默认 3 秒后重试，可用 retry 字段调整）
es.onerror = () => console.log("连接断开，自动重连中...");
```

EventSource 帮你做了三件事：自动按空行拆事件、按 event 字段分发到不同监听器、断线后自动重连。你不需要手写任何解析逻辑。

## 加 id 和 retry：断线续传

生产环境里网络会断、代理会超时，所以每条事件要带 id 支持断点续传，再加 retry 调整重连间隔：

```typescript
res.write("retry: 3000\n"); // 告诉浏览器断线后等 3 秒再重连

let seq = 0;
const timer = setInterval(() => {
  seq++;
  res.write(`id: ${seq}\n`); // 事件编号，断线后浏览器带 Last-Event-ID 重连
  res.write(`data: 消息 ${seq}\n\n`);
  if (seq >= 5) {
    res.write("event: done\ndata: 流结束\n\n");
    res.end();
    clearInterval(timer);
  }
}, 500);
```

服务端收到重连请求时，读请求头里的 Last-Event-ID，从上次断开的地方继续推。EventSource 在浏览器端自动处理这一切——你只需要保证事件 id 幂等。

## NestJS 的 @Sse() 帮你做了什么

手写 SSE 就是设响应头 + 循环 write。NestJS 的 @Sse() 装饰器把"持续产出"封装成你熟悉的 Observable 模型：

```typescript
import { Controller, Sse, MessageEvent } from "@nestjs/common";
import { Observable, interval, map } from "rxjs";

@Controller("chat")
export class ChatController {
  @Sse("stream")
  stream(): Observable<MessageEvent> {
    return interval(500).pipe(map((i) => ({ data: `token-${i}` })));
  }
}
```

@Sse() 内部做的事和你手写的一模一样：设 text/event-stream 响应头 → 订阅 Observable → 每次 next 序列化成 data: ...\n\n 写入响应流 → error 写 error 事件 → complete 结束响应。装饰器只是帮你省了手写响应头和处理 Observable 订阅的样板代码，不是魔法。

真实项目里，interval(500) 的位置换成 LLM 的 token 流（ChatOpenAI.stream() 返回的 async iterable），就是真正的 AI 流式输出。

## 生产环境三件事

SSE 部署到生产环境有三个绕不开的问题：

- **心跳保活**：代理/Nginx 会把"长时间没数据"的连接当死连接掐掉。每 30 秒发一个 `: ping\n\n`（冒号开头是 SSE 注释行，浏览器会忽略，但能保持 TCP 连接活跃）。
- **断线重连 + 幂等**：EventSource 默认能重连，但如果事件不幂等，前端会收到重复数据。用 id 标记每条事件，客户端重连时带 Last-Event-ID，服务端做去重。
- **日志**：流式接口的日志要比普通接口更细，记录首 token 时间、总时长、断开原因、最后一次推送内容。

## 对比：SSE vs WebSocket vs 一次性 JSON

| 方案        | 优点                     | 代价                     | 适用                       |
| ----------- | ------------------------ | ------------------------ | -------------------------- |
| SSE         | 浏览器原生支持，实现简单 | 只能服务端推送，不能双向 | AI 聊天 token 流、进度推送 |
| WebSocket   | 双向实时                 | 协议更复杂，运维成本更高 | 多人协作、频繁双向通信     |
| 一次性 JSON | 最简单，接口调试直接     | 长任务期间完全没反馈     | 短任务、非流式场景         |

我的建议很明确：聊天 token 流和任务进度流优先 SSE，只有你真的需要客户端频繁回传状态，才上 WebSocket。别为了"看起来高级"把自己架在更难维护的位置。

## 总结

SSE 不是复杂协议，就是一个 HTTP 长连接加上一套极简的行格式：Content-Type: text/event-stream + 循环写 data 行 + 空行分隔。浏览器 EventSource 原生支持，不需要任何第三方库。

手写 SSE 就是设响应头 + 循环 res.write。NestJS 的 @Sse() 把"持续产出"封装成 Observable 模型，底层干的活一模一样。

生产环境要加三样东西：心跳保活（防代理掐连接）、id 断点续传（防重复数据）、日志（排查流式问题）。

## 面试考点

- **SSE 和 WebSocket 怎么选？** 单向推送用 SSE，双向交互用 WebSocket。别把简单问题做重。
- **为什么 AI 聊天常用 SSE？** 浏览器原生支持、实现成本低、流式体验足够好。
- **生产上 SSE 会遇到什么问题？** 代理缓冲、超时、断线重连、心跳保活、幂等。
- **EventSource 和 fetch 读流有什么区别？** EventSource 自动处理重连和事件解析，但只能用 GET 请求；fetch 读流更灵活（可 POST、可自定义 header），但要自己处理重连和解析。

## 参考来源

- [MDN：EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)
- [MDN：Using Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [NestJS：Server-Sent Events（@Sse 装饰器）](https://docs.nestjs.com/techniques/server-sent-events)
