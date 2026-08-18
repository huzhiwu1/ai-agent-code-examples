/**
 * Step 01 – 无规划直答：把多步任务直接丢给模型
 *
 * 学习目标：先看"不规划"会发生什么——为后面所有步骤立一个痛点基线。
 *
 * 做法：只给模型一个系统提示词（电商助手），不给工具、不引导拆步骤，
 * 直接把多步任务一次性问过去，看它怎么回答。
 *
 * 预期观察点：
 *   1. 会不会漏步骤（比如只查了信息没算折扣）
 *   2. 顺序是否混乱（先算折扣再查订单）
 *   3. 关键数据是不是"编"的（没有工具，用户信息/订单金额从哪来？）
 *
 * 对应真实设计：这是所有 Agent 框架的"零号基线"——先测模型裸能力，
 * 再决定要加什么机制（工具、规划、状态机）。dsh 里对应 agent 的
 * "无工具直答"回退路径（llm.invoke 不带 tools）。
 *
 * 跑法：pnpm run:planning --step1 （或 pnpm --filter @articles/agent-planning run start:step1）
 */

import "dotenv/config";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { llm, TASK } from "../shared";

export async function main() {
  console.log("=".repeat(72));
  console.log("Step 01: 无规划直答 — 多步任务直接问模型");
  console.log("=".repeat(72));

  console.log(`\n任务：「${TASK}」\n`);

  const systemPrompt = new SystemMessage(
    "你是一个电商助手。用户会给你一个任务，请直接回答，不需要调用任何工具。"
  );

  const result = await llm.invoke([systemPrompt, new HumanMessage(TASK)]);

  const content =
    typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  console.log("模型回答：\n");
  console.log(content);
  console.log("\n" + "-".repeat(72));

  console.log("观察点：");
  console.log("  ① 步骤完整吗？（信息→订单→折扣→报告 四件事是否都做了）");
  console.log("  ② 顺序对吗？（折扣必须先有订单金额）");
  console.log("  ③ 数据是编的吗？（没有工具，'VIP 5200 积分'这种数据哪来的？）");
  console.log("\n✅ Step 01 完成（基线已建立）\n");
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
