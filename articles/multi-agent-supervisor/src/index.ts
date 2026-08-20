/**
 * 多 Agent 编排：从单 Agent 痛点到 Supervisor + Reflection 的 7 步渐进式
 *
 * 建议按顺序跑（每步独立可运行）：
 *   pnpm run:multi-agent-supervisor:step1   Step 01 单 Agent 痛点（痛点基线）
 *   pnpm run:multi-agent-supervisor:step2   Step 02 手动 Handoff（Router 模式）
 *   pnpm run:multi-agent-supervisor:step3   Step 03 Supervisor 自动路由（声明式调度）
 *   pnpm run:multi-agent-supervisor:step4   Step 04 状态传递（Agent 间上下文共享）
 *   pnpm run:multi-agent-supervisor:step5   Step 05 多 Agent 协作（4 Agent 旅行规划）
 *   pnpm run:multi-agent-supervisor:step6   Step 06 从零搭建 Supervisor（StateGraph 手写）
 *   pnpm run:multi-agent-supervisor:step7   Step 07 反思与权衡（Reflection + 单/多 Agent 对比）
 *   pnpm run:multi-agent-supervisor         全部 7 步依次执行
 *
 * 单步跑法：pnpm run:multi-agent-supervisor --step3
 */

import { API_KEY } from "./shared";

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
    const { main: run1 } = await import("./steps/step-01-single-agent");
    await run1();
  } else if (step === 2) {
    const { main: run2 } = await import("./steps/step-02-handoff");
    await run2();
  } else if (step === 3) {
    const { main: run3 } = await import("./steps/step-03-supervisor");
    await run3();
  } else if (step === 4) {
    const { main: run4 } = await import("./steps/step-04-state-passing");
    await run4();
  } else if (step === 5) {
    const { main: run5 } = await import("./steps/step-05-collaboration");
    await run5();
  } else if (step === 6) {
    const { main: run6 } = await import("./steps/step-06-from-scratch");
    await run6();
  } else if (step === 7) {
    const { main: run7 } = await import("./steps/step-07-reflection");
    await run7();
  } else {
    // 默认：全部 7 步依次执行
    console.log("🧠 多 Agent 编排 7 步渐进式全部执行（可加 --step1..7 单跑）\n");

    const { main: run1 } = await import("./steps/step-01-single-agent");
    await run1();
    const { main: run2 } = await import("./steps/step-02-handoff");
    await run2();
    const { main: run3 } = await import("./steps/step-03-supervisor");
    await run3();
    const { main: run4 } = await import("./steps/step-04-state-passing");
    await run4();
    const { main: run5 } = await import("./steps/step-05-collaboration");
    await run5();
    const { main: run6 } = await import("./steps/step-06-from-scratch");
    await run6();
    const { main: run7 } = await import("./steps/step-07-reflection");
    await run7();
  }

  console.log("=".repeat(72));
  console.log("🏁 7 步渐进式执行完毕");
  console.log("=".repeat(72));
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
