/**
 * Agentic RAG —— 从简单 RAG 到 Agentic RAG 的渐进式示例
 *
 * 三步演示：
 *   Step 1: 简单 RAG（retrieve → generate，不管需不需要都检索）
 *   Step 2: Agentic RAG（agent 自己判断要不要检索，简单问题直接答）
 *   Step 3: 多跳 Agentic RAG（复杂问题拆解子问题，迭代检索）
 *
 * 运行方式：
 *   仓库根目录：pnpm run run:agentic-rag
 *   本包目录：  pnpm start（或 pnpm dev 监听模式）
 *
 * 环境变量（从仓库根目录 .env 读取）：
 *   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
 *   EMBEDDING_API_KEY / EMBEDDING_MODEL / EMBEDDING_BASE_URL（可选，缺省回退到 LLM 配置）
 */

import * as dotenv from "dotenv";
import * as path from "node:path";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { Annotation, MessagesAnnotation, StateGraph, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// 从仓库根目录加载 .env：路径基于本文件位置推导（src → 仓库根），
// 无论从根目录还是子包目录启动都能正确读取配置
dotenv.config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

// ============================================================
// 共享配置
// ============================================================

/**
 * 校验必需环境变量：缺失时打印明确指引并退出，
 * 避免下游抛出难懂的 "Missing credentials" 异常
 */
function assertEnv(): void {
  if (!process.env.LLM_API_KEY) {
    console.error(
      "❌ 未找到 LLM_API_KEY 环境变量。\n" +
        "   请在仓库根目录 .env 中配置（可参考 .env.example），再重新运行示例。"
    );
    process.exit(1);
  }
}

assertEnv();

const llm = new ChatOpenAI({
  temperature: 0,
  model: process.env.LLM_MODEL || "deepseek-chat",
  configuration: { baseURL: process.env.LLM_BASE_URL || "https://api.deepseek.com/v1" },
  apiKey: process.env.LLM_API_KEY,
});

// embedding 缺省复用 LLM 的 key 与 base URL，配置了独立的 EMBEDDING_* 时优先使用
const embeddings = new OpenAIEmbeddings({
  model: process.env.EMBEDDING_MODEL || "text-embedding-v3",
  configuration: { baseURL: process.env.EMBEDDING_BASE_URL || process.env.LLM_BASE_URL },
  apiKey: process.env.EMBEDDING_API_KEY || process.env.LLM_API_KEY,
});

// ============================================================
// 知识库：一段小故事（和神光课程相同的数据）
// ============================================================
const documents = [
  new Document({
    pageContent:
      "光光是一个活泼开朗的小男孩，他有一双明亮的大眼睛。光光最喜欢踢足球，在球场上奔跑时像一道阳光。",
    metadata: { chapter: 1, character: "光光" },
  }),
  new Document({
    pageContent: "东东是光光最好的朋友，安静而聪明，喜欢读书和画画。他们从幼儿园就认识了。",
    metadata: { chapter: 2, character: "东东" },
  }),
  new Document({
    pageContent:
      "学校要举办足球比赛，光光邀请东东一起参加。东东担心拖累光光，光光说：'没关系，我们一起练习！'",
    metadata: { chapter: 3, character: "光光和东东" },
  }),
  new Document({
    pageContent: "光光每天放学教东东踢足球，东东画了一幅画送给光光——两个小男孩在球场上一起踢球。",
    metadata: { chapter: 4, character: "光光和东东" },
  }),
  new Document({
    pageContent: "比赛那天，东东传出一个漂亮的球，光光射门得分！他们赢得了比赛，友谊更加深厚。",
    metadata: { chapter: 5, character: "光光和东东" },
  }),
  new Document({
    pageContent:
      "多年后，光光成为职业足球运动员，东东成为插画师。东东为光光设计了球衣图案，他们证明了真正的友情跨越时间和距离。",
    metadata: { chapter: 7, character: "光光和东东" },
  }),
];

// ============================================================
// 共享工具：内存向量库（三个 Step 复用，文档只做一次 embedding）
// ============================================================

/** 惰性构建的内存向量库：三个 Step 共用同一实例，避免重复向量化 */
let sharedVectorStore: MemoryVectorStore | null = null;

/**
 * 获取共享向量库，首次调用时用知识库文档构建
 * @returns 已就绪的内存向量库实例
 */
async function getVectorStore(): Promise<MemoryVectorStore> {
  if (!sharedVectorStore) {
    sharedVectorStore = await MemoryVectorStore.fromDocuments(documents, embeddings);
  }
  return sharedVectorStore;
}

// ============================================================
// Step 1: 简单 RAG —— 不管需不需要，都先检索再说
// ============================================================

/**
 * Step 1：固定流程 retrieve → generate。
 * 无论问题是否需要知识库都会先检索，是对比基准。
 */
async function step1SimpleRAG(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Step 1: 简单 RAG（retrieve → generate）");
  console.log("=".repeat(60));

  const vectorStore = await getVectorStore();
  const retriever = vectorStore.asRetriever({ k: 3 });

  const GraphState = Annotation.Root({
    question: Annotation<string>(),
    documents: Annotation<string[]>(),
    answer: Annotation<string>(),
  });

  // 检索节点：不管问题是什么，先检索
  const retrieve = async (state: typeof GraphState.State) => {
    console.log(`\n  [检索] 问题: "${state.question}"`);
    const docs = await retriever.invoke(state.question);
    console.log(`  [检索] 命中 ${docs.length} 条文档`);
    return { documents: docs.map((d) => d.pageContent) };
  };

  // 生成节点：把检索结果注入 prompt
  const generate = async (state: typeof GraphState.State) => {
    const context = (state.documents ?? []).map((c, i) => `[片段${i + 1}] ${c}`).join("\n");
    const prompt = `基于以下故事片段回答问题。如果没有提到就说"故事里没提到"。

${context}

问题：${state.question}
回答：`;
    const resp = await llm.invoke(prompt);
    console.log(`  [生成] ${(resp.content as string).slice(0, 80)}...`);
    return { answer: resp.content as string };
  };

  const graph = new StateGraph(GraphState)
    .addNode("retrieve", retrieve)
    .addNode("generate", generate)
    .addEdge(START, "retrieve")
    .addEdge("retrieve", "generate")
    .addEdge("generate", END)
    .compile();

  // 问题1：需要检索的
  const r1 = await graph.invoke({ question: "光光最好的朋友是谁？" });
  console.log(`\n  📌 最终回答: ${r1.answer}\n`);

  // 问题2：不需要检索的（但简单 RAG 也检索了！）
  const r2 = await graph.invoke({ question: "1+1 等于几？" });
  console.log(`\n  📌 最终回答: ${r2.answer}`);
  console.log("\n  ⚠️ 问题2 不需要检索知识库，但简单 RAG 仍然检索了——这是浪费。");
}

// ============================================================
// Step 2 & 3 共享：检索工具 + agent 循环图
// ============================================================

/**
 * 图路由：agent 最后一条消息若携带 tool_calls 则进入 tools 节点，否则结束
 * @param state 当前图状态
 * @returns "tools"（继续检索）或 END（直接结束）
 */
function routeAfterAgent(state: typeof MessagesAnnotation.State): string {
  const lastMsg = state.messages[state.messages.length - 1];
  const toolCalls = (lastMsg as { tool_calls?: unknown[] }).tool_calls ?? [];
  return toolCalls.length > 0 ? "tools" : END;
}

/**
 * 构建「agent ⇄ 检索工具」循环图：
 * agent 先思考，决定需要知识库时调用 search_knowledge_base，拿到结果后继续思考，直到直接作答。
 * @param vectorStore 共享的内存向量库
 * @param topK 每次检索返回的文档条数
 * @param systemPrompt 可选的系统提示词（用于引导复杂问题拆解检索）
 * @returns 编译好的 LangGraph 图
 */
function buildAgentGraph(vectorStore: MemoryVectorStore, topK: number, systemPrompt?: string) {
  // 关键：检索是 agent 的一个工具，agent 自行决定是否调用、调用几次
  const retrieveTool = tool(
    async ({ query }: { query: string }) => {
      const docs = await vectorStore.similaritySearch(query, topK);
      const results = docs.map(
        (d, i) =>
          `[${i + 1}] (章节 ${d.metadata.chapter}, 角色: ${d.metadata.character}) ${d.pageContent}`
      );
      console.log(`  [检索工具] 查询 "${query}" → 命中 ${docs.length} 条`);
      return results.join("\n");
    },
    {
      name: "search_knowledge_base",
      description:
        "搜索故事知识库，获取故事人物的信息和情节。需要回答故事内容相关问题时调用此工具；复杂问题可分多次调用，每次检索一个子问题。",
      schema: z.object({ query: z.string().describe("检索查询语句") }),
    }
  );

  const llmWithTools = llm.bindTools([retrieveTool]);

  const callModel = async (state: typeof MessagesAnnotation.State) => {
    const messages = systemPrompt
      ? [{ role: "system" as const, content: systemPrompt }, ...state.messages]
      : state.messages;
    const response = await llmWithTools.invoke(messages);
    return { messages: [response] };
  };

  return new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", new ToolNode([retrieveTool]))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent)
    .addEdge("tools", "agent")
    .compile();
}

// ============================================================
// Step 2: Agentic RAG —— agent 自己判断要不要检索
// ============================================================

/**
 * Step 2：检索变成 agent 的工具，agent 对简单问题（如 1+1）直接作答，不浪费检索
 */
async function step2AgenticRAG(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("Step 2: Agentic RAG（agent 决定是否检索）");
  console.log("=".repeat(60));

  const graph = buildAgentGraph(await getVectorStore(), 3);

  // 问题1：需要检索
  console.log('\n  问题1: "光光最好的朋友是谁？"');
  const r1 = await graph.invoke({
    messages: [{ role: "user", content: "光光最好的朋友是谁？" }],
  });
  const a1 = r1.messages[r1.messages.length - 1];
  console.log(`  📌 回答: ${(a1.content as string).slice(0, 120)}...`);

  // 问题2：不需要检索
  console.log('\n  问题2: "1+1 等于几？"');
  const r2 = await graph.invoke({
    messages: [{ role: "user", content: "1+1 等于几？" }],
  });
  const a2 = r2.messages[r2.messages.length - 1];
  console.log(`  📌 回答: ${a2.content}`);
  console.log("\n  ✅ 问题2 agent 没有调用检索工具，直接回答——节省了一轮检索。");
}

// ============================================================
// Step 3: 多跳 Agentic RAG（复杂问题拆解，迭代检索）
// ============================================================

/**
 * Step 3：复杂问题由 agent 拆成子问题，迭代调用检索工具后再综合作答
 */
async function step3MultiHopAgenticRAG(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("Step 3: 多跳 Agentic RAG（拆解复杂问题，迭代检索）");
  console.log("=".repeat(60));

  const systemPrompt =
    "你是故事问答助手。对于复杂问题，用 search_knowledge_base 工具分步检索，每次查一个子问题，然后综合所有检索结果回答。";
  const graph = buildAgentGraph(await getVectorStore(), 4, systemPrompt);

  const question = "光光最好的朋友是谁？他后来成为了什么？他们之间发生了什么故事？";
  console.log(`\n  问题: "${question}"`);
  const result = await graph.invoke({
    messages: [{ role: "user", content: question }],
  });
  const answer = result.messages[result.messages.length - 1];
  console.log(`\n  📌 最终回答:\n${answer.content}`);
}

// ============================================================
// 主入口
// ============================================================

/** 依次演示三个 Step，展示从简单 RAG 到 Agentic RAG 的演进 */
async function main(): Promise<void> {
  console.log("🤖 Agentic RAG 渐进式示例\n");
  await step1SimpleRAG();
  await step2AgenticRAG();
  await step3MultiHopAgenticRAG();
  console.log("\n✅ 三步完成。");
}

main().catch(console.error);
