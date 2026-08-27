/**
 * Step 05 — 会话状态 ≠ 用户记忆：checkpointer 存短时，store 存长时
 * ============================================================================
 *
 * 【这一步解决什么问题】
 * 前几步的 PostgresSaver 存的是「会话状态」——按 thread_id 分档，会话结束就
 * 归档。但用户还有另一类记忆：他的会员等级、沟通偏好、历史工单——这些要
 * 跨会话长期有效。用户开了一个新会话（新 thread_id），Agent 还得认识他。
 * LangGraph 的答案是双层记忆：checkpointer（短时，按 thread）+ store（长时，
 * 按 user_id 跨会话）。生产里两者分开存、生命周期不同。
 *
 * 【为什么这么设计】
 * 同一套对话分别跑两次：
 *   A 版：只有 checkpointer → 新会话完全失忆（不知道用户是白金会员）
 *   B 版：checkpointer + PostgresStore → 新会话通过 store 读到用户画像
 * 再用「断开重连」验证 PostgresStore 的长时数据跨重启仍在。
 *
 * 【收益】
 * 1. 建立「会话状态」和「用户记忆」是两回事的心智模型
 * 2. 学会 BaseStore API（put / get，namespace + key 的 KV 模型）
 * 3. 生产方案：PostgresStore 落库，重启、多实例都不丢
 *
 * 【对应官方文档】
 * - LangGraph JS Memory（InMemoryStore / PostgresStore）:
 *   https://docs.langchain.com/oss/javascript/langgraph/memory
 * - PostgresStore 源码: node_modules/@langchain/langgraph-checkpoint-postgres/dist/store/index.d.ts
 *
 * 【跑法】pnpm run pg:step:05（需要本地 Docker PG 已启动）
 */

import { MemorySaver } from "@langchain/langgraph";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { DynamicTool } from "@langchain/core/tools";
import { HumanMessage } from "@langchain/core/messages";
import { CUSTOMER, TICKET, DB_URI, createLLM, divider, lastMessageText, termsBox } from "../shared";

const STORE_NAMESPACE = ["customers", CUSTOMER.userId];
const PROFILE_KEY = "profile";

export async function main() {
  divider("Step 05 | 短时记忆（checkpointer）+ 长时记忆（store）双层架构");

  termsBox("会话状态和用户记忆，为什么是两回事？", [
    ["checkpointer", "短时记忆：按 thread_id 存会话状态，会话结束生命周期就到头了"],
    ["store", "长时记忆：按 user_id 存跨会话信息（偏好/黑名单/历史），和会话无关"],
    ["namespace", "store 的目录结构：['customers', userId] 就是「每个用户一个格子」"],
  ]);

  console.log(`
📦 业务场景：${CUSTOMER.name}（${CUSTOMER.memberTier}）上周在会话 A 里说过自己的偏好。
  这周她开了个新会话 B（新 thread_id）来问工单进度——Agent 应该还认识她。`);

  const llm = createLLM();

  // ════════════════════ A 版：只有 checkpointer → 新会话失忆 ════════════════════

  console.log(`
【A 版 · 只有 checkpointer】会话 A 记住偏好 → 会话 B（新 thread_id）追问`);

  const saverA = new MemorySaver();
  const agentA = createReactAgent({
    llm,
    tools: [],
    checkpointSaver: saverA,
    // 注意：prompt 不含用户身份——「他是谁」只能来自对话历史或 store
    prompt: `你是某电商平台的售后客服，请简洁回答用户问题。不知道的信息要坦白说不知道，不要编造。`,
  });

  // 会话 A：用户自我介绍
  await agentA.invoke(
    {
      messages: [
        new HumanMessage(
          `你好，我是${CUSTOMER.name}，${CUSTOMER.memberTier}，工单 ${TICKET.id} 的申请人。请优先人工客服帮我跟进。`
        ),
      ],
    },
    { configurable: { thread_id: `${TICKET.id}-A` } }
  );

  // 会话 B：全新 thread_id —— checkpointer 里找不到任何上下文
  const rA2 = await agentA.invoke(
    { messages: [new HumanMessage("我是谁？什么会员等级？")] },
    { configurable: { thread_id: `${TICKET.id}-B` } }
  );
  console.log(`🤖 会话 B：${lastMessageText(rA2)}`);
  console.log(`
💥 崩点：新会话（新 thread_id）= 空白档案。checkpointer 只管「本会话内」，
   用户偏好这类长时信息，它管不了。`);

  // ════════════════════ B 版：checkpointer + PostgresStore → 跨会话认识老用户 ════════════════════

  console.log(`
【B 版 · 生产方案】checkpointer（短时）+ PostgresStore（长时），各管一摊`);

  // 长时记忆：PostgresStore 落库（生产换它，数据跨重启/跨实例）
  // 对应文档: https://docs.langchain.com/oss/javascript/langgraph/memory
  const store = PostgresStore.fromConnString(DB_URI);
  await store.setup();

  // 写记忆工具：Agent 在对话中把用户偏好写入 store
  const saveProfileTool = new DynamicTool({
    name: "save_customer_profile",
    description: `保存用户画像（会员等级、偏好等），必须传入 JSON 字符串，如 {"memberTier":"白金会员"}。`,
    func: async (input: string) => {
      await store.put(STORE_NAMESPACE, PROFILE_KEY, JSON.parse(input));
      return "已保存到用户画像";
    },
  });

  // 读记忆工具：Agent 在回答前查 store
  const loadProfileTool = new DynamicTool({
    name: "load_customer_profile",
    description: "读取用户画像（会员等级、偏好等），返回 JSON。",
    func: async () => {
      const item = await store.get(STORE_NAMESPACE, PROFILE_KEY);
      return item ? JSON.stringify(item.value) : "暂无画像";
    },
  });

  const agentB = createReactAgent({
    llm,
    tools: [saveProfileTool, loadProfileTool],
    checkpointSaver: new MemorySaver(), // 短时记忆照旧（这里用内存版即可，重点看 store）
    store, // 关键：把长时记忆挂到 Agent 上
    prompt: `你是某电商平台的售后客服。
当用户告知会员等级/偏好时，调用 save_customer_profile 保存画像。
回答涉及用户身份/会员信息前，先调用 load_customer_profile 查画像，再作答。`,
  });

  // 会话 A（线程 A）：用户自报家门，Agent 写入 store
  console.log(
    `\n👤 会话 A：你好，我是${CUSTOMER.name}，${CUSTOMER.memberTier}，工单 ${TICKET.id} 的申请人。请优先人工客服帮我跟进。`
  );
  await agentB.invoke(
    {
      messages: [
        new HumanMessage(
          `你好，我是${CUSTOMER.name}，${CUSTOMER.memberTier}，工单 ${TICKET.id} 的申请人，喜欢优先人工客服。请记住我。`
        ),
      ],
    },
    { configurable: { thread_id: `${TICKET.id}-B1` } }
  );

  // 验证：store 里确实有了画像
  const saved = await store.get(STORE_NAMESPACE, PROFILE_KEY);
  console.log(
    `  🔍 store 里已存: ${saved ? JSON.stringify(saved.value) : "（未写入，Agent 未调用保存工具）"}`
  );

  // 会话 B（新 thread_id）：不认识？查 store 就认识了
  console.log(`\n👤 会话 B（全新 thread_id）：我是谁？什么会员等级？`);

  const rB2 = await agentB.invoke(
    { messages: [new HumanMessage("我是谁？什么会员等级？能优先处理我的工单吗？")] },
    { configurable: { thread_id: `${TICKET.id}-B2` } }
  );
  console.log(`🤖 会话 B：${lastMessageText(rB2)}`);

  // 断开重连：验证长时记忆跨重启
  console.log(`\n🔌 断开 store 连接（模拟重启）→ 重连后直接读：`);
  await store.stop();
  const store2 = PostgresStore.fromConnString(DB_URI);
  await store2.setup();
  const afterRestart = await store2.get(STORE_NAMESPACE, PROFILE_KEY);
  console.log(
    `  🔍 重启后 store.get → ${afterRestart ? JSON.stringify(afterRestart.value) : "无"}`
  );

  console.log(`
✅ 解决：双层记忆各司其职——
   • 会话内上下文（聊到哪了）→ checkpointer（按 thread）
   • 跨会话用户记忆（他是谁、什么偏好）→ store（按 user_id）
   生产里 PostgresStore 和 PostgresSaver 可以共库分表，生命周期各自管理。`);

  // 清理演示数据
  await store2.delete(STORE_NAMESPACE, PROFILE_KEY);
  await store2.stop();

  console.log("\n✅ Step 05 完成\n");
}

// 单文件直接运行时执行（被 index.ts import 时不重复执行）
if (require.main === module) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
