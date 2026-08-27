/**
 * Step 03 — 流程走到一半停了：checkpointer 存的不只是聊天记录，是执行进度
 * ============================================================================
 *
 * 【这一步解决什么问题】
 * step-02 只证明了「对话历史」能恢复。但生产里的 Agent 往往在跑一个多步业务流：
 * 退款工单要先审核、再打款。如果流程跑到「审核通过、等待打款」时服务重启了，
 * 重启后是从头再来（重新提交、重新审核），还是从断点继续（直接打款）？
 * 答案取决于 checkpointer 保存的是什么——它保存的是整张图的**状态**，
 * 包括业务中间变量和**未完成的任务**，不只是 messages。
 *
 * 【为什么这么设计】
 * 用一个显式的 StateGraph（提交 → 审核 → 打款）替代黑盒的 React Agent：
 * 打款节点用 LangGraph 官方的 interrupt() 在「等支付确认」处暂停（模拟人工审批/
 * 异步流程被中断），此时进程退出；重启后重建实例，从 checkpoint 恢复——
 * 未完成的打款任务继续执行，已完成的提交/审核绝不重跑。
 * 这是 LangGraph 官方 human-in-the-loop / durability 的标准做法。
 *
 * 【收益】
 * 1. 建立关键认知：持久化 ≠ 聊天记忆，是「业务流程状态机」的持久化
 * 2. 学会 getState() 读 checkpoint，看到中间变量确实存进了数据库
 * 3. 理解 interrupt 断点机制：已完成的节点不重跑，未完成的接着执行
 *
 * 【对应官方文档】
 * - LangGraph JS State（自定义状态与节点）:
 *   https://docs.langchain.com/oss/javascript/langgraph/state
 * - LangGraph JS Human-in-the-loop（interrupt / resume）:
 *   https://docs.langchain.com/oss/javascript/langgraph/human-in-the-loop
 * - PostgresSaver 源码（getState 由 BaseCheckpointSaver 提供）:
 *   node_modules/@langchain/langgraph-checkpoint-postgres/dist/index.d.ts
 *
 * 【跑法】pnpm run pg:step:03（需要本地 Docker PG 已启动）
 */

import {
  Annotation,
  START,
  END,
  StateGraph,
  Command,
  interrupt,
  messagesStateReducer,
} from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { HumanMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import { CUSTOMER, TICKET, DB_URI, createLLM, divider, lastMessageText, termsBox } from "../shared";

// ──────────────── 图状态：一个退款工单的完整生命周期变量 ────────────────

const TicketState = Annotation.Root({
  ticketId: Annotation<string>,
  product: Annotation<string>,
  amount: Annotation<number>,
  status: Annotation<string>, // submitted → approved → paid
  reviewNote: Annotation<string>, // 审核意见（中间变量）
  refundId: Annotation<string>, // 打款流水号（中间变量）
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer }),
});

// ──────────────── 三个业务节点 ────────────────

/** 节点 1：提交工单（写入工单信息） */
function submitTicketNode(_state: typeof TicketState.State) {
  console.log("  ▶ [节点] submit_ticket —— 登记工单信息");
  return {
    ticketId: TICKET.id,
    product: TICKET.product,
    amount: TICKET.orderAmount,
    status: "submitted",
  };
}

/** 节点 2：审核（LLM 出审核意见 + 规则判定，写入中间变量） */
async function reviewTicketNode(_state: typeof TicketState.State) {
  console.log("  ▶ [节点] review_ticket —— 审核退款申请");
  const llm = createLLM();
  // 生产里这一步是「LLM 读政策 + 规则引擎」混合；这里简化：LLM 出意见，规则判定
  const ai = await llm.invoke([
    new SystemMessage("你是售后审核员。基于用户描述给出审核意见，一句话，不要多余内容。"),
    new HumanMessage(
      `商品: ${TICKET.product}，金额: ¥${TICKET.orderAmount}，问题描述: ${TICKET.issue}，申请时间: ${TICKET.applyTime}`
    ),
  ]);
  const note = String(ai.content).trim();
  // 规则：金额 < 2000 且非定制类 → 自动通过（生产里这是策略引擎）
  const approved = TICKET.orderAmount < 2000;
  return {
    status: approved ? "approved" : "rejected",
    reviewNote: `审核意见：${note}（规则判定：${approved ? "通过" : "拒绝"}）`,
    messages: [new HumanMessage(`[系统] 审核完成：${approved ? "通过" : "拒绝"}。${note}`)],
  };
}

/** 节点 3：打款（在「等待支付确认」处暂停，模拟人工审批/异步流程被中断） */
async function payoutNode(_state: typeof TicketState.State) {
  console.log("  ▶ [节点] payout —— 执行退款打款");
  // interrupt(): 图在这里暂停并保存 checkpoint（未完成任务 = payout 待继续）
  // 对应文档: https://docs.langchain.com/oss/javascript/langgraph/human-in-the-loop
  const decision = interrupt("支付网关确认：是否继续打款？");
  console.log(`  ▶ [节点] payout —— 收到打款指令: ${String(decision)}`);
  return {
    status: "paid",
    refundId: `REF-${Date.now().toString(36).toUpperCase()}`,
    messages: [new HumanMessage("[系统] 退款成功，流水号已生成。")],
  };
}

/** 组装图（两次运行共用同一张图结构，checkpointer 不同） */
function buildGraph(checkpointer: PostgresSaver) {
  return new StateGraph(TicketState)
    .addNode("submit_ticket", submitTicketNode)
    .addNode("review_ticket", reviewTicketNode)
    .addNode("payout", payoutNode)
    .addEdge(START, "submit_ticket")
    .addEdge("submit_ticket", "review_ticket")
    .addEdge("review_ticket", "payout")
    .addEdge("payout", END)
    .compile({ checkpointer });
}

export async function main() {
  divider("Step 03 | 多步流程停到一半：从断点继续，而不是从头再来");

  termsBox("为什么「持久化」不只是聊天记忆？", [
    ["图状态", "StateGraph 里所有变量（工单号、审核意见、打款状态…）的总和，不只是对话"],
    ["interrupt", "在流程中打一个暂停点：图跑到这里保存存档并停下，等外部指令再续"],
    ["断点续跑", "重启后从暂停点继续：已完成的节点不重跑，未完成的接着执行"],
    ["中间变量", "审核意见、退款流水号这类业务数据——它们也随 checkpoint 一起落库"],
  ]);

  console.log(`
📦 业务场景：${CUSTOMER.name} 的工单 ${TICKET.id} 走退款审批流：
   提交工单 → 审核 → 打款。审核通过后，「打款」需要支付网关人工确认——
   确认还没来，服务重启了（发版/崩溃）。`);

  // ════════════════════ A 版：崩溃后从头再来（无断点概念） ════════════════════

  console.log(`
【A 版 · 无持久化的直觉做法】中断 → 用户重新提交 → 审核重跑 → 才到打款
  💥 问题：审核节点重跑（浪费一次 LLM 调用），用户要重新解释一遍问题，
     人工审核过的记录也可能重复出单。多步流程越长，重跑成本越高。`);

  // ════════════════════ B 版：PostgresSaver 保存执行进度 ════════════════════

  console.log(`
【B 版 · 生产方案】PostgresSaver 保存整张图的状态（含未完成的打款任务）`);

  // ── 第一次运行：提交+审核通过，打款等确认时被中断 ──
  const saver1 = PostgresSaver.fromConnString(DB_URI);
  await saver1.setup();
  const graph1 = buildGraph(saver1);
  const config = { configurable: { thread_id: TICKET.id } };

  console.log(`\n🚀 进程 1 启动，用户提交退款工单：`);
  // 第一次 invoke 会执行到 interrupt 暂停点并返回（不是崩溃，是「等待外部输入」）
  await graph1.invoke(
    { messages: [new HumanMessage(`申请退款：${TICKET.product}，${TICKET.issue}`)] },
    config
  );
  console.log(`  ⏸️  流程暂停在 payout（等待支付确认），进程退出...`);
  console.log(`  📦 暂停时进度：提交 ✅ → 审核 ✅ → 打款 ⏸️`);

  // 用 getState 读 checkpoint：中间变量已落库 + 未完成任务已记录
  const snap = await graph1.getState(config);
  const cv = snap.values as Record<string, unknown>;
  console.log(`
  🔍 暂停瞬间的 checkpoint（已落库）:
    • ticketId    = ${cv.ticketId}
    • status      = ${cv.status}
    • reviewNote  = ${String(cv.reviewNote).slice(0, 50)}…
    • next 待执行 = ${JSON.stringify(snap.next)}   ← 「未完成的任务」也存起来了`);
  console.log(`  → 这就是断点续跑的底气：中间变量 + 下一步该干啥，全在数据库里。`);

  // 断开连接，模拟进程退出
  await saver1.end();

  // ── 第二次运行：新进程 + 同一 thread → 从断点继续 ──
  console.log(`
🚀 进程 2 启动（支付网关确认指令已到），同一个 thread_id，继续跑：`);

  const saver2 = PostgresSaver.fromConnString(DB_URI);
  await saver2.setup();
  const graph2 = buildGraph(saver2);

  // Command({ resume: ... })：向暂停点传入外部输入，从断点恢复执行
  // 对应文档: https://docs.langchain.com/oss/javascript/langgraph/human-in-the-loop
  const res = await graph2.invoke(new Command({ resume: "同意打款" }), config);
  console.log(`\n  📦 续跑结果：submit 未重跑 ✅ / review 未重跑 ✅ / 只有 payout 从断点接着执行`);
  console.log(`  • 最终 status = ${res.status}，refundId = ${res.refundId}`);
  console.log(`  🤖 用户看到的 Agent 回复：${lastMessageText(res)}`);

  console.log(`
✅ 解决：状态机 + checkpointer = 业务流程「断点续跑」。
   💡 生产里这正是 LangGraph human-in-the-loop / durability 的地基——
      人工审批、异步回调、服务重启，都靠 checkpoint 里的「未完成任务」续上。`);

  await saver2.end();
  console.log("\n✅ Step 03 完成\n");
}

// 单文件直接运行时执行（被 index.ts import 时不重复执行）
if (require.main === module) {
  main().catch((err) => {
    console.error("🔥 运行出错:", err);
    process.exit(1);
  });
}
