# Qoder 任务：重写 articles/agent-pg-persistence —— 真实生产场景渐进式（v2）

## 为什么改（背景）

现有 `articles/agent-pg-persistence/src/index.ts` 是 567 行单文件 demo：MemorySaver 丢状态 → PostgresSaver → PGVectorStore → 完整链路，四个场景挤在一起。问题：

1. **没有真实业务场景**：用户是"张三/李四"记名字，看不出生产里为什么需要持久化
2. **几百行一个文件**：读起来像流水账，不知道每段解决什么生产问题
3. **没有渐进式**：不是一步步"加能力"，而是一口气把四个 API 全塞出来
4. **缺少生产视角**：没讲 checkpoint 表长什么样、多实例并发怎么办、连接怎么管理、数据怎么清理

**本版 v2 的核心要求**：

- **一条真实业务主线贯穿**：不再用"张三记名字"，换成真实生产场景（如**售后客服 Agent 处理退款工单**），每个 step 解决这条主线上一个**真实生产环节**的问题
- **渐进式**：`src/steps/step-01.ts` ~ `step-07.ts`，每步一个文件、一个生产问题、一个哲学点，可单独运行
- **术语先行 + AB 对比**：每步 JSDoc 顶部「先懂几个词」；main() 先跑朴素版（不持久化/不防并发会怎样）→ 💥 崩点 → 再跑生产版 → ✅ 解决
- **注释标注官方文档/API 出处**：每个关键机制标注对应的 LangChain/LangGraph 官方文档章节或源码位置

## 你的角色（双重身份）

1. **资深 AI Agent 工程师**：LangGraph/LangChain 生态生产级用法，懂 checkpointer / store / 向量存储的设计取舍，懂 Agent 会话生命周期管理
2. **资深 PostgreSQL 数据库工程师**：懂表结构设计、索引、连接池、事务、数据清理、pgvector 生产配置；示例中的 SQL/表结构必须符合生产习惯（主键/索引/外键约束/清理策略）

## 必读材料（动笔前先读）

1. **现有实现**（理解 API 用法，不要照抄）：`articles/agent-pg-persistence/src/index.ts`（567 行，四场景）
2. **大纲**：`~/.openclaw/workspace/ai-agent-knowledge/outline-pg-agent.md`（文章读者终点：看完能给自己的 Agent 换掉 MemorySaver，用 PostgreSQL 持久化状态 + 向量存储）
3. **官方文档**（概念核实，链接写进注释）：
   - LangGraph JS Checkpointer：https://docs.langchain.com/oss/javascript/langgraph/persistence（MemorySaver vs PostgresSaver）
   - @langchain/langgraph-checkpoint-postgres README（setup() / fromConnString / 表结构）
   - LangGraph 长时记忆 store：https://docs.langchain.com/oss/javascript/langgraph/memory（InMemoryStore / PostgresStore）
   - @langchain/pgvector README（initialize / columns / distanceStrategy / 建索引）
4. **根目录 .env**（已配好，直接复用）：
   - `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`（DeepSeek，对话用）
   - `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL`（DashScope text-embedding-v3，向量用）

## 环境约定（保持现状，不要改）

- 包名 `@articles/agent-pg-persistence`，依赖已装：`@langchain/langgraph`、`@langchain/langgraph-checkpoint-postgres`、`@langchain/pgvector`、`@langchain/openai`、`@langchain/core`、`pg`、`dotenv`
- **只用 TS**，不要 Python
- PG 连接：`postgresql://postgres:postgres@localhost:5432/postgres`（docker: `pgvector/pgvector:pg16`）
- embeddings 读 `EMBEDDING_*` 环境变量（根 .env 提供，DashScope 兼容 OpenAI 格式）
- 运行：`pnpm run pg:step:01` ~ `pg:step:07`（每步可单独跑，不要互相依赖才能跑）；根 package.json 加 `pg:step:N` 脚本（`pnpm --filter @articles/agent-pg-persistence run step:N`）

## 教学铁律（最高优先级）

1. **真实业务主线**：统一用**「售后客服 Agent」**场景（或你换一个更真实的场景也行，但要贯穿全部 step 且开头点明）：
   - 例：用户提交退款工单 → Agent 需要先查售后政策（向量知识库）→ 再判断是否符合退款条件 → 多步审批流程（提交→审核→打款）→ 过程中用户随时回来追问进度 → 服务器可能重启/发版/扩容
   - 每个 step 的代码和输出都要围绕这条主线，让读者觉得"这就是我生产里会遇到的事"
2. **每步 = 一个真实生产环节 + 一个哲学点**，参考下面"每步规格"，本步用不到的机制只字不提（最多一行注释"生产里还有 XXX，后面 step 会讲"）
3. **术语先行**：每步 JSDoc 顶部「先懂几个词」，专有名词大白话类比（checkpointer = "Agent 的存档点"；thread_id = "存档编号，同号续档"；pgvector = "PG 的向量插件，让 SQL 能按相似度查"）
4. **AB 对比是标配**：每步 main() 先跑朴素版 → 💥 崩点（真实后果，如"用户回来对话全没了""两个实例抢同一会话状态错乱"）→ 再跑生产版 → ✅ 解决
5. **注释标注出处**：每个关键 API/机制旁边注释 `对应官方文档: <URL>` 或 `对应源码: <文件:行号>`

## 每步规格（7 步，每步一个文件）

> 主线设定示例（你可用更贴切的）：**"退款工单处理 Agent"**——用户提交退款 → Agent 查政策、走审批、回进度，跨越多轮对话和多步流程。

#### Step 01 — `step-01-memorysaver-lost.ts`：为什么开发好好的，一发生产就"失忆"？

- **生产环节**：会话状态存在哪？MemorySaver 的真相
- **哲学点**：MemorySaver = 进程内存，重启即失；开发环境没问题，生产重启/发版就丢
- **AB 对比**：朴素版（MemorySaver，同进程内对话正常）→ 💥 模拟重启（新建实例）后同一 thread_id 提问，Agent 不记得之前的事 → 点明：生产环境进程必然重启（发版/崩溃/扩缩容），内存态不可用
- **术语**：checkpointer / thread_id / 进程内存
- **看点**：让读者先看到"崩"，才知道后面为什么要换

#### Step 02 — `step-02-postgres-saver-basics.ts`：换 PostgresSaver，状态存进数据库

- **生产环节**：把 Agent 状态从内存挪到 PG
- **哲学点**：状态持久化到数据库 = 重启后还能"续档"；checkpoint 本质是一张表
- **必写**：setup() 建表 → 同 thread 对话 → 断开连接（模拟重启）→ 重连 → 状态还在；**展示 checkpoint 表结构**（连上去 SELECT 看 thread_id / checkpoint 列，说明存了什么）
- **术语**：PostgresSaver / setup() / checkpoint 表
- **看点**：第一次看到"重启后还记得"的 ✅，以及"状态原来长这样"的实感

#### Step 03 — `step-03-multi-step-recovery.ts`：流程走到一半崩了，怎么从断点继续？

- **生产环节**：多步业务流（如退款审批：提交→审核→打款）中途崩溃/超时
- **哲学点**：Agent 状态不只对话历史，还有**执行进度**；checkpointer 保存的是整个图状态（含中间变量），重启后从断点续跑
- **必写**：带多步流程的 Agent（可用简单 state graph：审核→打款两节点）→ 跑一半人为中断/抛错 → 重建实例 → 从断点继续而非从头再来；演示 checkpoint 里保存了哪些中间状态
- **术语**：图状态 / 断点续跑 / 中间变量
- **看点**：这步是"持久化不只是聊天记忆，是业务流程状态机"的关键认知

#### Step 04 — `step-04-multi-instance-shared.ts`：两个实例同时处理一个会话，会怎样？

- **生产环节**：K8s 多副本 / 多 worker 并行，同一 thread_id 的请求可能打到不同实例
- **哲学点**：PostgresSaver 让状态**跨实例共享**（多实例连同一张表）；MemorySaver 每个实例各自为政
- **必写**：两个 PostgresSaver 实例（模拟两个 pod）交替处理同一 thread → 状态连续；对照 MemorySaver 两个实例各聊各的 → 状态断裂
- **术语**：多实例 / 共享状态 / 无状态应用（Agent 变成无状态 worker，状态在 DB）
- **看点**：这是"为什么生产一定要 DB 持久化"最硬核的理由——不是防重启，是**支撑水平扩展**

#### Step 05 — `step-05-longterm-memory.ts`：会话状态存了，用户偏好呢？（长时记忆）

- **生产环节**：会话状态（checkpointer）≠ 用户长期记忆（偏好/黑名单/历史工单）；重启后"认识老用户"需要 store
- **哲学点**：LangGraph 双层记忆——短时（checkpointer，按 thread）+ 长时（store，按 user_id 跨会话）；生产里两者分开存
- **必写**：InMemoryStore（或 PostgresStore，若 API 稳定）存用户偏好/历史 → 新会话（新 thread_id）仍记得老用户；对照只有 checkpointer 时新会话完全失忆
- **术语**：checkpointer vs store / 短时记忆 vs 长时记忆 / user_id 维度
- **看点**：让读者建立"会话状态"和"用户记忆"是两回事的心智模型

#### Step 06 — `step-06-vector-knowledge.ts`：售后政策知识库，重启后检索还在吗？

- **生产环节**：Agent 需要查政策/文档（向量检索），向量库也得持久化
- **哲学点**：PGVectorStore = 向量数据也进 PG，和业务数据同库同事务；重启后知识库还在；生产配置要点（表结构/索引/距离策略）
- **必写**：写入几条"售后政策"文档 → 相似度检索 → 断开重连 → 检索仍在；**展示向量表结构 + 建索引 SQL**（HNSW/ivfflat 至少提一句，说明生产用哪个）
- **术语**：embedding / pgvector / HNSW / 余弦距离
- **看点**：知识库持久化 + 一个"生产要建索引"的数据库工程师视角

#### Step 07 — `step-07-production-hardening.ts`：生产环境还要注意什么？（总装 + 加固）

- **生产环节**：连接管理 / 数据清理 / 幂等 / 失败降级
- **哲学点**：持久化方案落地生产不是"能跑"就行——连接池要复用、checkpoint 表要清理（TTL/归档）、重复请求要幂等、DB 挂了 Agent 要能降级
- **必写**：① 共享连接池（不每步 new 连接）② checkpoint 清理策略（按 thread 删除/按时间清理，SQL 演示）③ 幂等演示（同一输入重放不产生重复副作用，可简化）④ DB 不可用时降级提示（catch + 明确报错）
- **术语**：连接池 / 数据清理 / 幂等 / 降级
- **看点**：收尾把"demo 到生产"的最后一步补齐，让读者敢上线

## 代码组织要求

- `src/steps/step-01.ts` ~ `step-07.ts`，**每步自足可独立运行**（公共依赖如 createLLM/createEmbeddings/DB_URI 抽到 `src/shared.ts`，每步 import 它）
- 每步文件头部 JSDoc 四段式：① 这一步解决什么问题（真实生产场景）② 为什么这么设计（哲学思想）③ 收益 ④ 对应官方文档/源码位置
- 每步 main() 输出清晰：AB 对比（💥 崩点 / ✅ 解决）+ 关键数据（如 token/表内容/检索结果），console 文案用生产口吻（"用户回来追问进度""pod 重启后"）
- 保留 `src/index.ts` 作为完整链入口（import 各 step 依次跑，或你自己设计更好的总装方式）
- 更新 `articles/agent-pg-persistence/package.json`：`step:01`~`step:07` 脚本
- 更新根 `package.json`：`pg:step:01`~`pg:step:07` + `run:pg-persistence` 脚本
- 更新 `articles/agent-pg-persistence/README.md`：改为 7 步表格（step / 生产环节 / 哲学点 / 跑法），保留"文章待写"占位

## 精简原则（吸取旧版教训）

- **不写死行数**，以"讲透一个生产环节 + AB 对比清楚"为准，写完就是终稿不要反复压缩
- **可省略**：PostgresStore 如果 API 不稳定就用 InMemoryStore + 说明"生产换 PostgresStore"；向量索引只演示建索引 SQL 不必跑真实 ANN 基准；幂等演示简化（说明思路 + 最小代码）
- **必须写**：每步的 AB 对比 + 术语先行 + 真实场景代入 + 出处注释；step-02 的表结构 SELECT 展示；step-06 的建索引 SQL
- **给你发挥空间**：具体场景细节（工单号/用户昵称/政策条目）、console 文案、主线串联方式你自行设计，但要让人觉得"这是真的生产问题"

## 验收清单（写完自查）

1. ✅ 7 个 step 文件 + shared.ts，每步 `pnpm run pg:step:N` 能独立跑通（需要 Docker PG + 根 .env，API 调用用真实 LLM/embeddings）
2. ✅ 每步 JSDoc 四段式齐全（问题/哲学/收益/出处）
3. ✅ 每步有 AB 对比输出（💥 崩点 → ✅ 解决）
4. ✅ 术语先行：每步「先懂几个词」解释本步专有名词
5. ✅ 主线统一：7 步围绕同一个真实业务场景，不是 7 个孤立 demo
6. ✅ 数据库工程师视角：至少出现表结构/索引/连接/清理中的 3 项
7. ✅ 只 TS；不依赖未定义的变量；代码自包含
8. ✅ 旧的 567 行单文件逻辑被替代/拆分，不留重复实现
