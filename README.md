# AgentMesh

**让异构 CLI Agent 像团队一样协作的操作系统。**

平台负责分工、调度、通信、审查与裁决；Agent 保有全部原生能力、各司其职。

```
用户  ── mesh talk ──▶  Coordinator（拆解、下发、统筹）
                              │
                     AgentMesh Hub（确定性内核）
   任务状态机 · 消息总线 · 身份与 SoD · 调度器 · 合并终审 · 审计哨兵
                              │  spawn：cwd=沙箱 + 角色卡 + hub 工具 + TTL
        ┌─────────────┬───────┴───────┬─────────────┐
   DeepSeek Harness   Hermes      Claude Code      Codex / OpenCode
        每个 P-Session = 独立进程 + 独立 git 沙箱 + 全部原生工具 + hub.*
```

一句话记住它：**平台划定世界的边界和产出的规则，但不没收工人的工具。**

---

## 30 秒上手

```bash
# 1. 在任意 git 项目里初始化协作空间（幂等）
mesh init

# 2. 看看平台认出了哪些 Agent
mesh agents list
mesh doctor

# 3. 一句话拉起一个团队
mesh talk "做一个带登录的博客网站"

# 或者手工建卡、自己盯着调度
mesh new "实现登录页" --role frontend_dev \
  --write "web/src/pages/login/**" \
  --accept "表单含邮箱/密码字段" --accept "提交调用 POST /api/auth/login"
mesh up --interval 5000        # 调度循环：派活 → 审查 → 合并 → 回收
mesh board                     # 看板
mesh status                    # 总览
mesh serve --port 8787         # 打开只读观察台
```

Node ≥ 22.6（需要原生 TypeScript 执行 + `node:sqlite`），git 2.x。**运行时零第三方依赖。**

---

## V2：mission —— 谁收到任务，谁主导

V1 是「人建卡 → 平台派活」。V2 多了一层：任务以 **mission** 为单位下发，
收到任务的那个 agent 成为 **lead**——由它拆解、派给擅长的队友、把审查交给另一个 agent，
最后自己整合、二次验收、出报告。验收不过就打回；多次不过就换评分更高的 agent 接手。

### 两个入口

```bash
# 平台入口：人在仓库里直接下发
mesh mission "做一个留言板：邮箱必填、提交即渲染、刷新后数据保留" \
  --accept "邮箱非法不允许提交" --accept "刷新后数据仍在" --lead dsh-01

# agent 对话入口：在任意 agent 的会话里说「用 AgentMesh 做这件事」
#   → 该 agent 调 start_mission(title, brief, acceptance) 后结束自己这一轮，
#     平台把它作为 lead 拉起。只有用户明确要求时才走这条路，见 docs/INTEGRATION.md
```

### 评分决定谁上

每个 agent 有一份九维画像（性格 / 擅长 / 弱势 / 能力范围 / 独特细节 / 质量分 / 花费 / 可靠性 / 速度）。

```bash
mesh profile list                         # 九个维度 + 战绩
mesh profile show dsh-01
mesh profile set dsh-01 quality_score 90  # 手编；锁定后不再被互评覆盖
```

调度按 `0.55×质量 + 0.20×省钱 + 0.15×可靠 + 0.10×专长匹配 − 0.05×负载` 选人。
同一次 mission 里真正合作过的 agent 可以 `rate_peer` 互评，加权进画像。

打回会累加 `rejection_count`：达到阈值后，之前所有经手过这张卡的 agent 都被排除，
换评分最高的人上；没有可用候选时卡变 `blocked`，并写明「需要更强或更多的 agent」。

### 协作史

每完成一次 mission 会落成一份人能直接读的目录：

```
.mesh/HISTORY.md                 一行一个 mission
.mesh/missions/M-000001/
  report.md                      lead 的交付报告
  timeline.md                    每次领取/提交/审查/合并/消息，按时间升序
  tasks.json                     每张卡的终态 + 完整审查记录（含逐条 evidence）
  context/                       发出去的每一份上下文包（证据）
```

`mesh serve` 打开观察台，missions 页可直接看状态链、时间线、卡片与证据、交付报告（含 390px 移动端）。

**上下文注入**：每个 worker 启动时都会拿到「你在哪」（哪个 mission、哪张卡、第几个执行者、谁是 lead）
和「队友表」（每个人的性格/擅长/弱势/质量分/本轮在做什么）；`minimal` 档只带紧凑版。

---

## 它解决什么问题

单个 Agent 很能干，但拿到任务会倾向端到端独自做完：不会分工、不会并行、不会互相校验。
而“让它别自己包办”不能靠劝——**能劝的东西都能被绕过**。

所以 AgentMesh 不改变 Agent 的能力，只改变它的**世界**和**产出的规则**：

| 做法 | 说明 |
|---|---|
| 每个任务一个独立 git 沙箱 | Agent 的 cwd 就是它的任务；它面前的世界只有一个任务卡 |
| 产出必须过裁决 | commit → `submit` → 独立审查者通过 → 平台 scope 终审 → 合并 |
| 工具一件不少 | Bash、读写、搜索、子 Agent、联网全都可用。约束“做什么”，不约束“用什么做” |
| 平台是确定性代码 | 状态机、锁、合并、审计都是代码，LLM 是平台的用户，不是法官 |

**没有任何公司靠没收螺丝刀来防止员工越权。**

---

## 核心模型

### 三元分离：Agent / Role / Session

| 概念 | 是什么 | 生命周期 |
|---|---|---|
| **Agent** | 物理实体：某个 CLI 及其启动配方（`dsh-01`、`hermes-01`…） | 长期，注册制 |
| **Role** | 逻辑职能：coordinator / planner / architect / researcher / frontend_dev / backend_dev / executor / supervisor / integrator / sentinel | 永久 |
| **Session** | 某 Agent 以某角色做某任务的一次会话 | 任务级 |

角色绑定在 **Session** 上，不在 Agent 上。同一个 Agent 上午是前端、下午是审查者，两个 Session 互不相通。
权限随 Session 走：未 `hello` 的会话没有任何权限。

### 双模会话：平台会话 vs 直接会话

- **P-Session**（平台拉起）：出生即绑定角色、cwd 在任务沙箱、注入 hub 工具、全量留痕、产出必须合并才生效。
- **D-Session**（你直接打开 CLI）：平台**零干预、零感知**。平台不会往你的直接会话里注入任何东西，也不会阻断你对主分支的操作；它只会由哨兵记录「主分支出现非平台来源的提交」——**detect-only，不回滚**。

判定标准只有一条：**谁发起的会话**。

### 产出三通道

| 通道 | 内容 | 规则 |
|---|---|---|
| **A 工作通道** | 沙箱内一切：读写、跑测试、装依赖、子 Agent、联网 | 完全自由，平台不看不管 |
| **B 产出通道** | `git commit` 到任务分支 → `hub.submit()` → 审查 → 合并 | 唯一合法出口 |
| **C 协作通道** | 领任务、收发消息、上报进度、升级、非代码工件入库 | 走 `hub.*`，角色权限校验 |

---

## 八条宪法（不可协商）

| # | 条款 | 代码在哪强制 |
|---|---|---|
| C1 | “完成”只能由平台授予：submit → review 通过 → 合并终审通过 | `hub/core/board.ts` `mergeTask` 检查 `approvedReview` |
| C2 | P-Session 必须是 D-Session 的严格超集 | `hub/adapters/*` 无任何工具限制字段；`docs/ACCEPTANCE.md` 的超集验证 |
| C3 | D-Session 中平台零干预、零感知 | 适配器只写**会话私有的** `--patch` 覆盖，不碰共享 profile |
| C4 | 约束“做什么”，永不约束“用什么做” | `RoleCard` 没有 tool 字段；schema 校验器会拒绝带 `tools` 的卡 |
| C5 | Hub 是确定性状态机，LLM 是平台的用户 | `hub/core/stateMachine.ts` 是唯一能改任务状态的地方 |
| C6 | Session 出生即绑定单一角色 | `IdentityService.createSession` + 每次调用的 `requireIdentity` |
| C7 | 任何 Agent 不得同时是同一任务的实现者与审查者 | `assertIndependentReviewer` + 调度器 SoD 过滤 |
| C8 | 跨 Agent 通信一律经 Hub | `MessageBus.send` 只接受 `{role, thread}`，点对点直接拒绝 |

改任何一条都要先升级用户裁决（认这个项目的人），不许自行解释放宽。

---

## 合并终审：最后一道防线

```
git diff base..task-branch --name-only   → 改动清单
改动清单 − TaskCard.scope.write           → 越界集
越界集为空 → 合并
越界集非空 → 整个提交拒绝 + 打回 + 附 diff 证据
             （Supervisor 可授权 strip 模式：剥离越界文件后合并，剥离内容记审计）
```

实现是一个**事务**：`git merge --no-commit` → 校验每一个 staged 路径 → 提交或 `merge --abort`；
提交后再做一次事后校验，万一越界就 `reset --hard` 回滚并抛错。

**结论：无论 Agent 用什么工具、以什么方式工作，scope 外改动零进入主分支。**

---

## 命令速查

人类：

| 命令 | 作用 |
|---|---|
| `mesh init` / `mesh status` / `mesh doctor` | 初始化 / 总览 / 体检 |
| `mesh up [--once] [--interval ms]` | 调度循环：派活、审查、合并、回收、扫描 |
| `mesh talk "…"` / `mesh coordinator` | 与主决策者对话 / 只跑一个协调回合（处理升级、解阻塞、下任务卡） |
| `mesh board` / `mesh task <id>` | 看板 / 任务卡详情（含 scope 预检） |
| `mesh new …` / `mesh assign <id>` | 建卡 / 手动派发 |
| `mesh agents verify [id]` | **实跑一次会话验证超集性**（原生工具 + hub 工具都在） |
| `mesh agents …` / `mesh sessions …` | Agent 注册表 / 会话与日志 |
| `mesh audit …` / `mesh sentinel` | 审计（违规、合并、审查、scope）/ 扫描 |
| `mesh review` / `verdict` / `merge` | 人工裁决（记录为 `mesh-human`，仍走同一套校验） |
| `mesh block` / `mesh unblock` | 仲裁 |
| `mesh serve` | 只读观察台 |

Agent（文件协议，会话自动从 `MESH_SESSION_ID` 读取）：

```bash
mesh hello                      # 注册身份（不调用则无任何权限）
mesh claim T-000042             # 原子领取，拿上下文包
mesh messages                   # 收件箱
mesh submit T-000042 --summary "…"
mesh new "…" --role backend_dev --write "src/x.ts" --accept "…"   # 规划角色才能下单
mesh escalate "需要契约补充"      # 上报但不中断；--block 才停下
```

MCP 工具与 CLI 一一对应（21 个工具，含 `create_task` / `verdict` / `merge`），见 [PROTOCOL.md](PROTOCOL.md)。

---

## 仓库结构

```
agentmesh/
├─ PROTOCOL.md            协议总纲（含约 500 token 速览版，注入每个上下文包）
├─ hub/
│  ├─ core/               确定性内核
│  │  ├─ stateMachine.ts  任务状态机（唯一能改状态的代码）
│  │  ├─ board.ts         生命周期：claim / submit / verdict / merge
│  │  ├─ mergeGate.ts     scope 终审（§10.3）
│  │  ├─ lock.ts          跨进程文件锁（原子 claim 的来源）
│  │  ├─ fsx.ts           原子写入、glob、JSONL 流水
│  │  ├─ identity.ts      三元模型、SoD、租约
│  │  ├─ messages.ts      消息总线（角色线程寻址、TTL、死信）
│  │  ├─ context.ts       上下文包三档（minimal/standard/full）
│  │  ├─ git.ts           沙箱（自包含 clone）与合并事务
│  │  └─ hub.ts / api.ts  Hub 装配与 agent 面接口
│  ├─ mcp/server.ts       MCP stdio 服务器（零依赖手写协议层）
│  ├─ adapters/           启动配方：dsh / hermes / cli-generic / detect
│  ├─ scheduler/          调度器、进程管理、prompt 组装
│  ├─ sentinel/           审计哨兵（detect-only）
│  ├─ roles/cards.ts      十张角色卡（身份唯一来源）
│  └─ web/server.ts       只读观察台 API + 静态资源
├─ cli/                   mesh 命令行（human.ts / agent.ts）
├─ web/                   观察台前端（零构建、零依赖）
├─ tests/                 单测 + 红队 T1–T10
└─ .mesh/                 运行时协作空间（每个项目一份，默认 git 忽略）
```

`.mesh/` 的结构（角色卡、Agent 注册表、Session、任务卡、消息、上下文包、工件、审计、沙箱、锁）见 [PROTOCOL.md](PROTOCOL.md) 第 2 节。

---

## 接入一个新 Agent

1. `mesh agents detect` 看本机有什么；
2. 在 `.mesh/agents/<id>.json` 写一张 AgentCard（或 `mesh agents add <id>`）：

```jsonc
{
  "agent_id": "my-cli-01",
  "kind": "generic",
  "enabled": true,
  "command": "my-cli",
  "args": [],
  "capabilities": ["frontend_dev", "backend_dev"],   // 人工配置，先不自动探测
  "concurrency": 2,
  "cost_tier": 2,
  "transport": "mcp",                                 // 没有 MCP 就填 "file"
  "mcp_inject": "mcp-json",                           // 怎么把 hub 工具塞进去
  "prompt_flag": "-p",
  "headless_args": ["--headless"],
  "ttl_seconds": 1800
}
```

3. `mesh agents doctor` 验证可执行；
4. `mesh assign <task> --agent my-cli-01 --wait` 实跑一次，确认**超集性**：
   原生工具都能用 + hub 工具能调。适配器的验收标准就是这一条。

现成的配方：`dsh`（MCP via `--patch`）、`hermes`（文件协议）、`claude-code`（`--mcp-config`）、`codex`（`-c mcp_servers.*`）、`opencode`（config 文档）、`generic`（任意一次性 CLI）。

---

## 常见问题

**为什么要用自包含 clone 而不是 `git worktree` 做沙箱？**
因为 `git worktree` 会把该 worktree 的元数据放在 `<主仓库>/.git/worktrees/<name>`——**沙箱外面**。
任何自带工作区写沙箱的 CLI（DeepSeek Harness、Claude Code、Codex…）都无法给索引加锁，`git commit` 直接失败。
这是真实踩到的坑：第一个真实 Worker 就是卡在这里。改成 clone 后，`.git` 在沙箱内，最严格的沙箱也能提交，
而且隔离更强（不共享索引锁，没有从沙箱通往主仓库对象库的路径）。

**为什么是 JSON 不是 YAML？**
零依赖解析、严格校验、可 diff、崩溃安全。CLI 会渲染成 YAML 风格的视图，语义与计划书一致。

**为什么文件协议要求能写 `.mesh/`？**
`mesh` CLI 需要把会话、消息写到协作空间。自带工作区沙箱的 CLI 请走 MCP 通道（hub 服务器在沙箱外运行），
或把项目根纳入它的可写范围。这条边界在 `PROTOCOL.md` 里写明了。

**沙箱删不掉怎么办？**
沙箱化 Agent 可能留下拒绝删除的 ACL。平台会自动换到下一个沙箱槽位（`T-000042-2`），
路径记录在任务卡上而不是靠约定，所以不会卡住；残留目录手工删掉即可。

**Hermes 很慢？**
它每回合有 ~50s 启动开销。默认 `cost_tier: 3`，调度器会优先把活派给更快的 Agent，只在需要深度时用它。

**任务卡住了？**
```bash
mesh status                     # 看谁在跑
mesh sessions logs <id> --lines 200
mesh unblock <task>             # 领它的会话已经死了就回到 ready
mesh down                       # 全部停掉重来
```

---

## 文档

- [PROTOCOL.md](PROTOCOL.md) —— 协议总纲：三元模型、五类 schema、状态机、三通道、工具接口、合并终审、错误码
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) —— M0–M5 验收报告与红队 T1–T10 证据
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 分层与不变量（为什么这么设计）
- [schemas/](schemas/) —— 五类卡片的 JSON Schema

---

## 状态

M0–M5 全部实现并验证：协议基线、Hub 内核（跨进程原子 claim、崩溃恢复）、身份与 SoD、
沙箱与适配器与调度器、监督闭环与 Sentinel、多 Agent 端到端。

红队 T1–T10 全部通过；真实 Agent（DeepSeek Harness + Hermes）跑通过完整流水线。
详细证据见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。
