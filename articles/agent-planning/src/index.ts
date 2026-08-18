/**
 * Agent 规划：从直答到 Plan-and-Execute 的动态规划（5 步渐进式汇总入口）
 *
 * 建议按顺序跑（每步独立可运行）：
 *   pnpm run:planning:step1   Step 01 无规划直答（痛点基线）
 *   pnpm run:planning:step2   Step 02 先列计划再执行（Plan-then-Execute 雏形）
 *   pnpm run:planning:step3   Step 03 计划 + 工具闭环（依赖调度 + 结果回填）
 *   pnpm run:planning:step4   Step 04 规划器/执行器分离（Planner/Executor）
 *   pnpm run:planning:step5   Step 05 动态重规划（失败时重新拆解剩余步骤）
 *   pnpm run:planning         全部 5 步依次执行
 *
 * 单步跑法：pnpm run:planning --step3（或 pnpm --filter @articles/agent-planning run start:step3）
 */

import "dotenv/config";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { API_KEY } from "./shared";

dotenv.config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

async function main() {
  if (!API_KEY) {
    console.error("❌ 缺少 LLM_API_KEY，请检查仓库根目录的 .env 文件");
    console.error("   .env 需包含: LLM_API_KEY=sk-xxx");
    console.error("   (可选) LLM_BASE_URL / LLM_MODEL");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const stepArg = args.find((a) => a.startsWith("--step"));

  const step = stepArg ? parseInt(stepArg.replace("--step", ""), 10) : 0;

  if (step === 1) {
    const { main: run1 } = await import("./steps/step-01-direct");
    await run1();
  } else if (step === 2) {
    const { main: run2 } = await import("./steps/step-02-plan-execute");
    await run2();
  } else if (step === 3) {
    const { main: run3 } = await import("./steps/step-03-tool-loop");
    await run3();
  } else if (step === 4) {
    const { main: run4 } = await import("./steps/step-04-planner-executor");
    await run4();
  } else if (step === 5) {
    const { main: run5 } = await import("./steps/step-05-replan");
    await run5();
  } else {
    // 默认：全部 5 步依次执行
    console.log("🧠 5 步渐进式全部执行（可加 --step1..5 单跑）\n");
    const { main: run1 } = await import("./steps/step-01-direct");
    await run1();
    const { main: run2 } = await import("./steps/step-02-plan-execute");
    await run2();
    const { main: run3 } = await import("./steps/step-03-tool-loop");
    await run3();
    const { main: run4 } = await import("./steps/step-04-planner-executor");
    await run4();
    const { main: run5 } = await import("./steps/step-05-replan");
    await run5();
  }

  console.log("=".repeat(72));
  console.log("🏁 执行完毕");
  console.log("=".repeat(72));
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
