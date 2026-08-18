/**
 * Agentic RAG —— 从简单 RAG 到企业级 Agentic RAG 的渐进式示例
 *
 * 五步演示：
 *   Step 1: 简单 RAG（retrieve → generate，不管需不需要都检索）
 *   Step 2: Agentic RAG（agent 自己判断要不要检索，简单问题直接答）
 *   Step 3: 多跳 Agentic RAG（复杂问题拆解子问题，迭代检索）
 *   Step 4: 增强 Step 2 —— 路由前置 + 相似度门槛（A+B，让 Agent 不再误判）
 *   Step 5: 增强 Step 3 —— 显式拆解 + plan_next 自检 + 硬上限（A+B+C，让多跳不失控）
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
// 知识库
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
// 共享工具：内存向量库（五个 Step 复用，文档只做一次 embedding）
// ============================================================

/**
 * 余弦相似度：值域 [0,1]（embedding 均为非负向量时），越大越相似。
 * 相比 L2 距离，余弦相似度对向量长度不敏感，更适合作为跨查询可比的相似度门槛。
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 惰性构建的内存向量库：五个 Step 共用同一实例，避免重复向量化 */
let sharedVectorStore: MemoryVectorStore | null = null;

/**
 * 获取共享向量库，首次调用时用知识库文档构建
 * @returns 已就绪的内存向量库实例
 */
async function getVectorStore(): Promise<MemoryVectorStore> {
  if (!sharedVectorStore) {
    // 指定余弦相似度作为打分函数，让 similaritySearchWithScore 返回可比分数
    sharedVectorStore = await MemoryVectorStore.fromDocuments(documents, embeddings, {
      similarity: cosineSimilarity,
    });
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

  const retrieve = async (state: typeof GraphState.State) => {
    console.log(`\n  [检索] 问题: "${state.question}"`);
    const docs = await retriever.invoke(state.question);
    console.log(`  [检索] 命中 ${docs.length} 条文档`);
    return { documents: docs.map((d) => d.pageContent) };
  };

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

  const r1 = await graph.invoke({ question: "光光最好的朋友是谁？" });
  console.log(`\n  📌 最终回答: ${r1.answer}\n`);

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

  console.log('\n  问题1: "光光最好的朋友是谁？"');
  const r1 = await graph.invoke({ messages: [{ role: "user", content: "光光最好的朋友是谁？" }] });
  const a1 = r1.messages[r1.messages.length - 1];
  console.log(`  📌 回答: ${(a1.content as string).slice(0, 120)}...`);

  console.log('\n  问题2: "1+1 等于几？"');
  const r2 = await graph.invoke({ messages: [{ role: "user", content: "1+1 等于几？" }] });
  const a2 = r2.messages[r2.messages.length - 1];
  console.log(`  📌 回答: ${a2.content}`);
  console.log("\n  ✅ 问题2 agent 没有调用检索工具，直接回答——节省了一轮检索。");
}

// ============================================================
// Step 3: 多跳 Agentic RAG（基础版）
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
  const result = await graph.invoke({ messages: [{ role: "user", content: question }] });
  const answer = result.messages[result.messages.length - 1];
  console.log(`\n  📌 最终回答:\n${answer.content}`);
}

// ============================================================
// Step 4: 增强 Step 2 —— 路由前置 + 相似度门槛（A + B）
// ============================================================
// 核心改进：
//   A) 路由前置：在 agent 之前加 route_question 节点，用 structured output 判断要不要检索
//   B) 相似度门槛：检索后检查最高相似度，低于阈值直接告知"知识库没有相关内容"
//   让 Agent 不再依赖 tool description 的模糊判断，用确定性逻辑做兜底。

const RouteSchema = z.object({
  needs_retrieval: z.boolean().describe("是否需要检索知识库"),
  reason: z.string().describe("判断理由"),
});

const SIMILARITY_THRESHOLD = 0.5; // 相似度阈值：低于此值认为检索结果不相关

async function step4EnhancedStep2() {
  console.log("\n" + "=".repeat(60));
  console.log("Step 4: 增强 Step 2（路由前置 + 相似度门槛）");
  console.log("=".repeat(60));

  const vectorStore = await getVectorStore();

  const GraphState = Annotation.Root({
    question: Annotation<string>(),
    needs_retrieval: Annotation<boolean>(),
    route_reason: Annotation<string>(),
    documents: Annotation<string[]>(),
    top_score: Annotation<number>(),
    answer: Annotation<string>(),
  });

  // ===== A) 路由前置：用 structured output 判断要不要检索 =====
  const routeQuestion = async (state: typeof GraphState.State) => {
    console.log(`\n  [路由] 分析问题: "${state.question}"`);
    // DeepSeek 不支持 response_format json_schema，改用 function calling 做结构化输出
    const router = llm.withStructuredOutput(RouteSchema, { method: "functionCalling" });
    const result = await router.invoke(
      `判断用户问题是否需要检索故事知识库。

规则：
- 需要检索：问题涉及故事人物、情节、事件、关系等
- 不需要检索：数学计算、常识问答、实时信息、问候语等

用户问题：${state.question}`
    );
    console.log(`  [路由] needs_retrieval=${result.needs_retrieval} (${result.reason})`);
    return { needs_retrieval: result.needs_retrieval, route_reason: result.reason };
  };

  const routeAfterAnalyze = (state: typeof GraphState.State) => {
    return state.needs_retrieval ? "retrieve" : "direct_answer";
  };

  // ===== B) 检索 + 相似度门槛 =====
  const retrieve = async (state: typeof GraphState.State) => {
    const results = await vectorStore.similaritySearchWithScore(state.question, 3);
    // 分数已是余弦相似度（0~1），越大越相似
    const topScore = results.length > 0 ? results[0][1] : 0;
    console.log(`  [检索] 命中 ${results.length} 条，最高相似度: ${topScore.toFixed(4)}`);

    // 相似度门槛：低于阈值 → 放弃检索结果
    if (topScore < SIMILARITY_THRESHOLD) {
      console.log(
        `  ⚠️ 最高相似度 ${topScore.toFixed(4)} < 阈值 ${SIMILARITY_THRESHOLD}，检索结果不可靠`
      );
      return { documents: [], top_score: topScore };
    }
    return {
      documents: results.map(([doc]) => doc.pageContent),
      top_score: topScore,
    };
  };

  const generate = async (state: typeof GraphState.State) => {
    // 相似度门槛兜底：检索结果为空 → 直接告知
    if (!state.documents || state.documents.length === 0) {
      console.log(`  [生成] 检索结果为空或不相关，告知用户`);
      return { answer: `知识库中没有找到与"${state.question}"相关的内容。` };
    }
    const context = (state.documents ?? []).map((c, i) => `[片段${i + 1}] ${c}`).join("\n");
    const resp = await llm.invoke(
      `基于以下故事片段回答问题。如果没有提到就说"故事里没提到"。

${context}

问题：${state.question}
回答：`
    );
    console.log(`  [生成] ${(resp.content as string).slice(0, 80)}...`);
    return { answer: resp.content as string };
  };

  const directAnswer = async (state: typeof GraphState.State) => {
    console.log(`  [直接回答] 跳过检索`);
    const resp = await llm.invoke(`简洁回答：${state.question}`);
    console.log(`  [直接回答] ${(resp.content as string).slice(0, 60)}...`);
    return { answer: resp.content as string };
  };

  const graph = new StateGraph(GraphState)
    .addNode("route_question", routeQuestion)
    .addNode("retrieve", retrieve)
    .addNode("generate", generate)
    .addNode("direct_answer", directAnswer)
    .addEdge(START, "route_question")
    .addConditionalEdges("route_question", routeAfterAnalyze, {
      retrieve: "retrieve",
      direct_answer: "direct_answer",
    })
    .addEdge("retrieve", "generate")
    .addEdge("generate", END)
    .addEdge("direct_answer", END)
    .compile();

  // 问题1：需要检索
  console.log('\n  问题1: "光光最好的朋友是谁？"');
  const r1 = await graph.invoke({ question: "光光最好的朋友是谁？" });
  console.log(`  📌 最终回答: ${r1.answer}\n`);

  // 问题2：不需要检索
  console.log('  问题2: "1+1 等于几？"');
  const r2 = await graph.invoke({ question: "1+1 等于几？" });
  console.log(`  📌 最终回答: ${r2.answer}\n`);

  // 问题3：需要检索但知识库没有相关内容
  console.log('  问题3: "王五是谁？"（知识库没有王五）');
  const r3 = await graph.invoke({ question: "王五是谁？" });
  console.log(`  📌 最终回答: ${r3.answer}`);
  console.log("\n  ✅ 路由前置 + 相似度门槛双重保障，Agent 不再误判。");
}

// ============================================================
// Step 5: 增强 Step 3 —— 显式拆解 + plan_next 自检 + 硬上限（A + B + C）
// ============================================================
// 核心改进：
//   A) 显式拆解：用 structured output 把问题拆成子问题列表，逐个检索（不再靠 ReAct 隐式分解）
//   B) plan_next 自检：每轮检索后显式判断"还缺什么？要不要再搜？"
//   C) 硬上限：maxRetrievals 防止无限循环

const DecomposeSchema = z.object({
  sub_questions: z.array(z.string()).min(1).max(6).describe("有序子问题列表，每个问题独立可检索"),
  reason: z.string().describe("拆解理由"),
});

const PlanNextSchema = z.object({
  need_more: z.boolean().describe("是否还需要继续检索"),
  reason: z.string().describe("理由"),
});

async function step5EnhancedStep3() {
  console.log("\n" + "=".repeat(60));
  console.log("Step 5: 增强 Step 3（显式拆解 + plan_next 自检 + 硬上限）");
  console.log("=".repeat(60));

  const vectorStore = await getVectorStore();

  const GraphState = Annotation.Root({
    question: Annotation<string>(),
    sub_questions: Annotation<string[]>(),
    current_sub_idx: Annotation<number>(),
    documents: Annotation<string[]>(),
    retrieval_count: Annotation<number>(),
    max_retrievals: Annotation<number>(),
    answer: Annotation<string>(),
  });

  // ===== A) 显式拆解 =====
  const decompose = async (state: typeof GraphState.State) => {
    console.log(`\n  [拆解] 分析问题: "${state.question}"`);
    const decomposer = llm.withStructuredOutput(DecomposeSchema, { method: "functionCalling" });
    const result = await decomposer.invoke(
      `将用户问题拆解为有序的子问题列表，每个子问题独立可检索。

规则：
- 链式推理问题必须拆成多条（如"X是谁？他后来怎么样了？"→ 拆成"X是谁？"和"X后来怎么样了？"）
- 每条子问题必须是完整中文问句，禁止使用"他/她/此人"等指代
- 顺序必须符合推理链：先查前置事实，再查后续结论
- 输出 1-6 条

用户问题：${state.question}`
    );
    console.log(`  [拆解] ${result.sub_questions.length} 条子问题: ${result.reason}`);
    result.sub_questions.forEach((q, i) => console.log(`    ${i + 1}. ${q}`));
    return { sub_questions: result.sub_questions, current_sub_idx: 0 };
  };

  // ===== 检索一个子问题 =====
  const retrieve = async (state: typeof GraphState.State) => {
    const idx = state.current_sub_idx ?? 0;
    const subQs = state.sub_questions ?? [];
    const q = subQs[idx];
    const round = (state.retrieval_count ?? 0) + 1;

    console.log(
      `\n  [检索 ${round}/${state.max_retrievals}] 子问题 ${idx + 1}/${subQs.length}: "${q}"`
    );
    const results = await vectorStore.similaritySearchWithScore(q, 3);

    const newDocs = results.map(
      ([doc, score]) =>
        `[相似度 ${score.toFixed(3)}] 章节${doc.metadata.chapter}: ${doc.pageContent}`
    );
    console.log(`    命中 ${results.length} 条`);

    // 去重合并
    const existing = state.documents ?? [];
    const merged = [...existing];
    for (const d of newDocs) {
      if (!merged.some((m) => m === d)) merged.push(d);
    }

    return {
      documents: merged,
      current_sub_idx: idx + 1,
      retrieval_count: round,
    };
  };

  // ===== B) plan_next 自检 =====
  const planNext = async (state: typeof GraphState.State) => {
    const idx = state.current_sub_idx ?? 0;
    const subQs = state.sub_questions ?? [];
    const count = state.retrieval_count ?? 0;
    const remaining = subQs.length - idx;

    // C) 硬上限检查
    if (count >= (state.max_retrievals ?? 6)) {
      console.log(`  [plan_next] 已达最大检索轮数 (${state.max_retrievals})，强制生成`);
      return {};
    }
    if (remaining <= 0) {
      console.log(`  [plan_next] 所有子问题已检索完毕 (${subQs.length}/${subQs.length})，进入生成`);
      return {};
    }

    console.log(`  [plan_next] 已检索 ${count} 轮，剩余 ${remaining} 条子问题，判断是否继续...`);
    const planner = llm.withStructuredOutput(PlanNextSchema, { method: "functionCalling" });
    const result = await planner.invoke(
      `你是多跳 RAG 规划器。用户原始问题：${state.question}

已检索 ${count} 轮，剩余 ${remaining} 条子问题待检索。已召回文档摘要：
${
  (state.documents ?? [])
    .slice(0, 5)
    .map((d, i) => `[${i + 1}] ${d.slice(0, 150)}`)
    .join("\n") || "（无）"
}

判断：已有足够依据回答用户问题吗？${remaining > 0 ? "或者还需要继续检索剩余子问题？" : ""}`
    );
    console.log(`  [plan_next] need_more=${result.need_more} (${result.reason})`);
    // need_more=false 或即将达到硬上限：把子问题索引推到末尾，
    // 让 afterPlan 的 idx >= subQs.length 条件路由到 generate
    if (!result.need_more || count >= (state.max_retrievals ?? 6) - 1) {
      console.log("  [plan_next] 无需继续检索，进入生成");
      return { current_sub_idx: subQs.length };
    }
    // 仍需继续检索：索引在上一轮 retrieve 中已推进，保持不变即可
    return {};
  };

  const afterPlan = (state: typeof GraphState.State) => {
    const idx = state.current_sub_idx ?? 0;
    const subQs = state.sub_questions ?? [];
    const count = state.retrieval_count ?? 0;
    if (idx >= subQs.length || count >= (state.max_retrievals ?? 6)) return "generate";
    return "retrieve";
  };

  const generate = async (state: typeof GraphState.State) => {
    const context = (state.documents ?? []).join("\n\n");
    const subQs = (state.sub_questions ?? []).map((q, i) => `${i + 1}. ${q}`).join("\n");
    console.log(
      `\n  [生成] 综合 ${state.retrieval_count} 轮检索结果 (${state.documents?.length ?? 0} 条去重文档)`
    );
    const resp = await llm.invoke(
      `基于以下检索结果回答问题。综合所有片段，给出完整回答。

检索的子问题：
${subQs}

检索结果：
${context || "（无）"}

用户问题：${state.question}
回答：`
    );
    console.log(`  [生成] ${(resp.content as string).slice(0, 100)}...`);
    return { answer: resp.content as string };
  };

  const graph = new StateGraph(GraphState)
    .addNode("decompose", decompose)
    .addNode("retrieve", retrieve)
    .addNode("plan_next", planNext)
    .addNode("generate", generate)
    .addEdge(START, "decompose")
    .addEdge("decompose", "retrieve")
    .addEdge("retrieve", "plan_next")
    .addConditionalEdges("plan_next", afterPlan, {
      retrieve: "retrieve",
      generate: "generate",
    })
    .addEdge("generate", END)
    .compile();

  const question = "光光最好的朋友是谁？他后来成为了什么？他们之间发生了什么故事？";
  console.log(`\n  问题: "${question}"`);
  const result = await graph.invoke({
    question,
    sub_questions: [],
    current_sub_idx: 0,
    documents: [],
    retrieval_count: 0,
    max_retrievals: 6,
    answer: "",
  });

  console.log(`\n  📌 最终回答:\n${result.answer}`);
  console.log(`\n  ✅ 显式拆解 + plan_next 自检 + 硬上限，多跳不失控。`);
}

// ============================================================
// 主入口
// ============================================================
/** 依次演示五个 Step，展示从简单 RAG 到企业级 Agentic RAG 的演进 */
async function main(): Promise<void> {
  console.log("🤖 Agentic RAG 渐进式示例（5 步）\n");
  await step1SimpleRAG();
  await step2AgenticRAG();
  await step3MultiHopAgenticRAG();
  await step4EnhancedStep2();
  await step5EnhancedStep3();
  console.log("\n✅ 五步完成。");
}

main().catch(console.error);
