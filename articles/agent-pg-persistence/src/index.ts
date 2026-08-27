/**
 * 「售后客服 Agent + PostgreSQL 持久化」7 步渐进式 —— 总装入口
 *
 * 一条主线：用户林女士的退款工单 RT-2026-0826-001
 *   step-01 崩点：MemorySaver 重启失忆（状态在进程内存）
 *   step-02 存档进 PG：PostgresSaver + checkpoint 表（重启续档）
 *   step-03 断点续跑：checkpointer 存执行进度（审批状态机）
 *   step-04 多实例共享：无状态 worker + 共享状态（水平扩展）
 *   step-05 双层记忆：短时 checkpointer + 长时 store（认识老用户）
 *   step-06 知识库持久化：PGVectorStore + HNSW 索引（政策检索）
 *   step-07 生产加固：连接池 / 清理 / 幂等 / 降级
 *
 * 建议按顺序跑（每步独立可运行）：
 *   pnpm run pg:step:01   Step 01 MemorySaver 的真相（重启失忆）
 *   pnpm run pg:step:02   Step 02 PostgresSaver 基础（状态进 DB）
 *   pnpm run pg:step:03   Step 03 多步流程断点续跑（状态机）
 *   pnpm run pg:step:04   Step 04 多实例共享状态（水平扩展）
 *   pnpm run pg:step:05   Step 05 长时记忆 store（认识老用户）
 *   pnpm run pg:step:06   Step 06 向量知识库持久化（政策检索）
 *   pnpm run pg:step:07   Step 07 生产加固总装（上线检查清单）
 *   pnpm run:pg-persistence   全部 7 步依次执行
 *
 * 单步跑法：pnpm run:pg-persistence --step3
 *
 * 前置条件：
 *   1. Docker PG（含 pgvector 扩展）：
 *      docker run -d --name pgvector -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16
 *   2. 仓库根目录 .env 配置 LLM_* / EMBEDDING_*（step 1-5、7 用 LLM，step 6 用 embeddings）
 */

import { LLM_API_KEY, EMBEDDING_API_KEY } from "./shared";

async function main() {
  if (!LLM_API_KEY) {
    console.error("❌ 缺少 LLM_API_KEY，请检查仓库根目录 .env（LLM_API_KEY=sk-xxx）");
    process.exit(1);
  }
  if (!EMBEDDING_API_KEY) {
    console.error(
      "❌ 缺少 EMBEDDING_API_KEY（step-06 需要 embeddings，DashScope text-embedding-v3）"
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const stepArg = args.find((a) => a.startsWith("--step"));
  const step = stepArg ? parseInt(stepArg.replace("--step", ""), 10) : 0;

  const steps: Record<number, { file: string; label: string }> = {
    1: { file: "./steps/step-01-memorysaver-lost", label: "Step 01 MemorySaver 的真相" },
    2: { file: "./steps/step-02-postgres-saver-basics", label: "Step 02 PostgresSaver 基础" },
    3: { file: "./steps/step-03-multi-step-recovery", label: "Step 03 多步流程断点续跑" },
    4: { file: "./steps/step-04-multi-instance-shared", label: "Step 04 多实例共享状态" },
    5: { file: "./steps/step-05-longterm-memory", label: "Step 05 长时记忆 store" },
    6: { file: "./steps/step-06-vector-knowledge", label: "Step 06 向量知识库持久化" },
    7: { file: "./steps/step-07-production-hardening", label: "Step 07 生产加固总装" },
  };

  if (step >= 1 && step <= 7) {
    console.log(`\n🧠 单步执行：${steps[step].label}\n`);
    const mod = await import(steps[step].file);
    await mod.main();
  } else {
    console.log(
      "🧠 「售后客服 Agent + PostgreSQL 持久化」7 步渐进式全部执行（可加 --step1..7 单跑）\n"
    );
    for (let i = 1; i <= 7; i++) {
      const mod = await import(steps[i].file);
      await mod.main();
    }
  }

  console.log("=".repeat(72));
  console.log("🏁 7 步渐进式执行完毕");
  console.log("=".repeat(72));
}

main().catch((err) => {
  console.error("🔥 运行出错:", err);
  process.exit(1);
});
