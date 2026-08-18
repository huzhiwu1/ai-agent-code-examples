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
 * 运行方式：cd ~/workspace/ai-agent-code-examples && pnpm run run:agentic-rag
 * 环境变量（从根目录 .env 读取）：
 *   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL / EMBEDDING_API_KEY / EMBEDDING_MODEL / EMBEDDING_BASE_URL
 */

import "dotenv/config";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { Annotation, MessagesAnnotation, StateGraph, START, END } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ToolNode } from "@langchain/langgraph/prebuilt";

// ============================================================
// 共享配置
// ============================================================
const llm = new ChatOpenAI({
  temperature: 0,
  model: process.env.LLM_MODEL || "deepseek-chat",
  configuration: { baseURL: process.env.LLM_BASE_URL || "https://api.deepseek.com/v1" },
  apiKey: process.env.LLM_API_KEY,
});

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
// Step 1: 简单 RAG
// ============================================================
async function step1SimpleRAG() {
  console.log("=".repeat(60));
  console.log("Step 1: 简单 RAG（retrieve → generate）");
  console.log("=".repeat(60));

  const vectorStore = await MemoryVectorStore.fromDocuments(documents, embeddings);
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
// Step 2: Agentic RAG（基础版）
// ============================================================
async function step2AgenticRAG() {
  console.log("\n" + "=".repeat(60));
  console.log("Step 2: Agentic RAG（agent 决定是否检索）");
  console.log("=".repeat(60));

  const vectorStore = await MemoryVectorStore.fromDocuments(documents, embeddings);

  const retrieveTool = tool(
    async ({ query }: { query: string }) => {
      const docs = await vectorStore.similaritySearch(query, 3);
      const results = docs.map(
        (d, i) => `[${i + 1}] (章节 ${d.metadata.chapter}) ${d.pageContent}`
      );
      console.log(`  [检索工具] 查询 "${query}" → 命中 ${docs.length} 条`);
      return results.join("\n");
    },
    {
      name: "search_knowledge_base",
      description:
        "搜索故事知识库，获取故事人物的信息和情节。当你需要回答关于故事内容的问题时调用此工具。",
      schema: z.object({ query: z.string().describe("检索查询语句") }),
    }
  );

  const llmWithTools = llm.bindTools([retrieveTool]);

  const callModel = async (state: typeof MessagesAnnotation.State) => {
    const response = await llmWithTools.invoke(state.messages);
    return { messages: [response] };
  };

  const routeTools = (state: typeof MessagesAnnotation.State) => {
    const lastMsg = state.messages[state.messages.length - 1];
    const tc = (lastMsg as { tool_calls?: unknown[] }).tool_calls ?? [];
    return tc.length > 0 ? "tools" : END;
  };

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", new ToolNode([retrieveTool]))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeTools)
    .addEdge("tools", "agent")
    .compile();

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
async function step3MultiHopAgenticRAG() {
  console.log("\n" + "=".repeat(60));
  console.log("Step 3: 多跳 Agentic RAG（拆解复杂问题，迭代检索）");
  console.log("=".repeat(60));

  const vectorStore = await MemoryVectorStore.fromDocuments(documents, embeddings);

  const retrieveTool = tool(
    async ({ query }: { query: string }) => {
      const docs = await vectorStore.similaritySearch(query, 4);
      const results = docs.map(
        (d, i) =>
          `[${i + 1}] (章节 ${d.metadata.chapter}, 角色: ${d.metadata.character}) ${d.pageContent}`
      );
      console.log(`  [检索] "${query}" → ${docs.length} 条`);
      return results.join("\n");
    },
    {
      name: "search_knowledge_base",
      description:
        "搜索故事知识库。对于需要多步推理的复杂问题，请分多次调用此工具，每次查询不同的子问题。",
      schema: z.object({ query: z.string().describe("检索查询") }),
    }
  );

  const llmWithTools = llm.bindTools([retrieveTool]);

  const callModel = async (state: typeof MessagesAnnotation.State) => {
    const systemMsg = {
      role: "system" as const,
      content:
        "你是故事问答助手。对于复杂问题，用 search_knowledge_base 工具分步检索，每次查一个子问题，然后综合所有检索结果回答。",
    };
    const response = await llmWithTools.invoke([systemMsg, ...state.messages]);
    return { messages: [response] };
  };

  const routeTools = (state: typeof MessagesAnnotation.State) => {
    const lastMsg = state.messages[state.messages.length - 1];
    const tc = (lastMsg as { tool_calls?: unknown[] }).tool_calls ?? [];
    return tc.length > 0 ? "tools" : END;
  };

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", new ToolNode([retrieveTool]))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeTools)
    .addEdge("tools", "agent")
    .compile();

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

  const vectorStore = await MemoryVectorStore.fromDocuments(documents, embeddings);

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
    const router = llm.withStructuredOutput(RouteSchema);
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
    const topScore = results.length > 0 ? results[0][1] : 0;
    console.log(`  [检索] 命中 ${results.length} 条，最高相似度: ${(1 - topScore).toFixed(4)}`);

    // 相似度门槛：低于阈值 → 放弃检索结果
    if (1 - topScore < SIMILARITY_THRESHOLD) {
      console.log(
        `  ⚠️ 最高相似度 ${(1 - topScore).toFixed(4)} < 阈值 ${SIMILARITY_THRESHOLD}，检索结果不可靠`
      );
      return { documents: [], top_score: 1 - topScore };
    }
    return {
      documents: results.map(([doc]) => doc.pageContent),
      top_score: 1 - topScore,
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

  const vectorStore = await MemoryVectorStore.fromDocuments(documents, embeddings);

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
    const decomposer = llm.withStructuredOutput(DecomposeSchema);
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
        `[相似度 ${(1 - score).toFixed(3)}] 章节${doc.metadata.chapter}: ${doc.pageContent}`
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
    const planner = llm.withStructuredOutput(PlanNextSchema);
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
    // 硬上限兜底
    if (!result.need_more || count >= (state.max_retrievals ?? 6) - 1) {
      return {};
    }
    return { current_sub_idx: idx }; // 保持不变，retrieve 会再取下一个
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
async function main() {
  console.log("🤖 Agentic RAG 渐进式示例（5 步）\n");
  await step1SimpleRAG();
  await step2AgenticRAG();
  await step3MultiHopAgenticRAG();
  await step4EnhancedStep2();
  await step5EnhancedStep3();
  console.log("\n✅ 五步完成。");
}

main().catch(console.error);
