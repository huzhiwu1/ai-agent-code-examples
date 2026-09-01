/**
 * 多 Agent 协同：从单 Agent 痛点到生产级编排的 9 步渐进式
 *
 * 建议按顺序跑（每步独立可运行）：
 *   pnpm run:multi-agent-supervisor:step1   Step 01 单 Agent 痛点（痛点基线）
 *   pnpm run:multi-agent-supervisor:step2   Step 02 手动 Handoff（Router 模式）
 *   pnpm run:multi-agent-supervisor:step3   Step 03 Supervisor 自动路由（循环问题实测）
 *   pnpm run:multi-agent-supervisor:step4   Step 04 状态传递（上下文管理 + Token 成本）
 *   pnpm run:multi-agent-supervisor:step5   Step 05 确定性路由（StateGraph + 防重复调度）
 *   pnpm run:multi-agent-supervisor:step6   Step 06 质量兜底（Reflector 程序化硬校验）
 *   pnpm run:multi-agent-supervisor:step7   Step 07 防失控（预算熔断 + Trace 可观测性）
 *   pnpm run:multi-agent-supervisor:step8   Step 08 生产级综合编排（Planner-Worker-Reviewer）
 *   pnpm run:multi-agent-supervisor:step9   Step 09 并行扇出（Send API 同批并行）
 *   pnpm run:multi-agent-supervisor         全部 9 步依次执行
 *
 * 单步跑法：pnpm run:multi-agent-supervisor --step3
 */

import { API_KEY } from "./shared";

const STEPS: Array<{ n: number; file: string; title: string }> = [
  { n: 1, file: "step-01-single-agent", title: "单 Agent 痛点" },
  { n: 2, file: "step-02-handoff", title: "手动 Handoff" },
  { n: 3, file: "step-03-supervisor", title: "Supervisor 自动路由（循环问题实测）" },
  { n: 4, file: "step-04-state-passing", title: "状态传递 + Token 成本" },
  { n: 5, file: "step-05-deterministic-routing", title: "确定性路由 + 防重复调度" },
  { n: 6, file: "step-06-reflection", title: "质量兜底（程序化硬校验）" },
  { n: 7, file: "step-07-budget-observability", title: "预算熔断 + Trace 可观测性" },
  { n: 8, file: "step-08-production", title: "生产级综合编排" },
  { n: 9, file: "step-09-parallel-fanout", title: "并行扇出（Send API）" },
];

async function runStep(step: (typeof STEPS)[number]) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`▶️  Step ${step.n}: ${step.title}`);
  console.log(`${"=".repeat(72)}`);
  const mod = await import(`./steps/${step.file}`);
  await mod.main();
}

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

  if (step >= 1 && step <= STEPS.length) {
    await runStep(STEPS[step - 1]);
  } else {
    // 默认：全部 9 步依次执行
    console.log(`🧠 多 Agent 协同 9 步渐进式全部执行（可加 --step1..9 单跑）\n`);
    for (const s of STEPS) {
      await runStep(s);
    }
  }

  console.log("=".repeat(72));
  console.log("🏁 9 步渐进式执行完毕");
  console.log("=".repeat(72));
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
