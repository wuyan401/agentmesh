# AgentMesh 协议总纲（PROTOCOL.md）

> 状态：v1.0 现行 · 与本仓库实现同步
> 读者：接入平台的每一个 Agent，以及维护平台的人
> 一句话：**平台划定世界的边界和产出的规则，但不没收工人的工具。**

<!-- BEGIN PROTOCOL-QUICKREF -->
# AgentMesh 协议速览

你是平台拉起的一个 P-Session：独立进程 + 独立 worktree + 你的全部原生工具 + hub.* 工具。
平台限制「做什么」，从不限制「用什么做」——Bash、读写、搜索、子 Agent、联网全部由你决定。

## 三条通道
- **A 工作通道（自由）**：在沙箱内读写、装依赖、跑测试、查资料。平台不看不管。
- **B 产出通道（唯一合法出口）**：git commit 到当前任务分支 → hub.submit(task_id, summary)。
- **C 协作通道（hub.*）**：领任务、收发消息、上报进度、升级、非代码工件入库。

## 五条硬规则
1. 只写任务卡 scope.write 内的路径；scope 外改动在合并终审处被检出，整单打回。
2. 结项不由你宣布：submit → Supervisor 通过 → 合并终审通过 = 完成。
3. 不直接改主分支，不绕过 hub.merge 合并。
4. 不给别的 Agent 点对点发消息；一切经 hub.send（角色线程寻址）。
5. 不确定就问：hub.request_clarification / hub.escalate，不要自己扩大解释。

## 常用调用
`hub.hello()` → session_id（必做一次，否则无任何权限）
`hub.get_task(task_id)` / `hub.get_board()`
`hub.claim_task(task_id)`
`hub.report_progress(task_id, pct, blockers?)`
`hub.submit(task_id, summary)`
`hub.request_clarification(task_id, question)` / `hub.escalate(reason)` — 升级只是上报，不中断你；只有 `block=true` 才停下
`hub.send({role, thread}, type, body)` / `hub.read_messages()`
`hub.put_artifact(path, content)` — 只收非代码工件
<!-- END PROTOCOL-QUICKREF -->

---

## 1. 三元模型：Agent / Role / Session

| 概念 | 是什么 | 生命周期 |
|---|---|---|
| **Agent** | 物理实体：某台机器上的某个 CLI Agent（`dsh-01`、`hermes-01`…），带一份启动配方 | 长期，注册制 |
| **Role** | 逻辑职能：coordinator / planner / architect / researcher / frontend_dev / backend_dev / executor / supervisor / integrator / sentinel | 永久定义 |
| **Session** | 绑定实例：某 Agent 以某角色做某任务的一次会话 | 任务级 |

规则：

- **角色绑定在 Session 上，不在 Agent 上。** 同一个 Agent 上午是 `frontend_dev`、下午是 `supervisor`，两个 Session 互不相通。
- **Session 出生即绑定单角色，中途不可切换**（C6）。想换角色就开新 Session。
- **权限随 Session 走。** 每一次特权调用都先解析 Session → Agent → RoleCard，再判权。
- **未 hello 的 Session 没有任何权限。** 连看板都读不到。

## 2. 协作空间：`.mesh/`

```
.mesh/
├─ state.json                 # 项目清单 + 计数器（崩溃可恢复的唯一权威）
├─ config.json                # 人类配置：coordinator_agent / auto_integrate / ...
├─ decisions.md               # 决策日志（§18 取舍，不再重新诉讼）
├─ PROTOCOL.snapshot.md       # 协议快照（注入上下文包）
├─ roles/<role>.md            # 角色卡（人可读，代码为准）
├─ agents/<agent_id>.json     # Agent 注册表 + 启动配方
├─ sessions/<S-xxxxxx>.json   # Session 注册表（活跃 + 历史）
├─ board/tasks/<T-xxxxxx>.json# 任务卡
├─ board/events.jsonl         # 看板事件流水
├─ messages/log.jsonl         # 全部消息（只追加）
├─ messages/inbox/<agent>/    # 收件箱（按 msg_id 幂等）
├─ messages/pending/<role>/   # 角色无人时的排队
├─ messages/deadletter/       # 过期/投递失败
├─ context/<T-xxxxxx>.md      # 上下文包（三档）
├─ artifacts/**               # 通道 C 的非代码工件（带 sha256 索引）
├─ audit/violations.log       # 违规（detect-only）
├─ audit/merges.jsonl         # 合并账本（主分支提交来源）
├─ audit/reviews/<T>/*.json   # 审查记录
├─ audit/events.jsonl         # 全量审计事件
├─ audit/digest.md            # 审计摘要（人读）
├─ audit/evidence/            # 拒绝合并时的 diff 证据
├─ worktrees/<T-xxxxxx>/      # 每任务独立 git worktree（= Agent 的 cwd）
├─ locks/                     # 文件锁
└─ logs/<S-xxxxxx>.log        # 每个 Session 的 stdout/stderr
```

`.mesh/` 默认写入 `.git/info/exclude`，不修改被跟踪的 `.gitignore`。

## 3. 五类卡片 Schema

完整 JSON Schema 在 `schemas/`，运行时校验在 `hub/core/schema.ts`。所有卡片都是**文件即真相**：单个 JSON 文件、原子写入、可 diff、可回滚。

### 3.1 RoleCard（角色卡）

```jsonc
{
  "role": "frontend_dev",
  "title": "Frontend Dev 前端开发",
  "duty": ["按任务卡实现前端代码", "在沙箱内自行验证", "commit 并 submit"],
  "constraints": ["只写 scope.write 内的路径", "越界先 escalate"],
  "can_write_code": true,
  "can_implement": true,
  "can_review": false,
  "can_merge": false,
  "lifespan": "ephemeral",
  "output_globs": [],
  "prompt": "……注入 Session 的角色卡正文……"
}
```

### 3.2 AgentCard（物理实体 + 启动配方）

```jsonc
{
  "agent_id": "dsh-01",
  "display_name": "DeepSeek Harness",
  "kind": "dsh",                   // dsh|hermes|claude-code|codex|opencode|generic|file-protocol|builtin
  "enabled": true,
  "command": "node",
  "args": ["D:/…/bin.js", "--profile", "headless"],
  "capabilities": ["planner", "frontend_dev", "supervisor", "..."],  // 人工配置
  "concurrency": 2,
  "cost_tier": 2,
  "transport": "mcp",              // mcp|file|in-process
  "mcp_inject": "dsh-patch",       // 平台怎么把 hub 工具塞进这个 Agent
  "extra_env": {},
  "strip_env": ["DSH_SESSION_ID", "DSH_PROFILE"],
  "prompt_mode": "arg",            // arg|stdin|file
  "prompt_flag": null,
  "headless_args": [],
  "ttl_seconds": 1800,
  "notes": ""
}
```

**启动配方五项全部属于环境层与身份，没有一项是能力剥夺。** 自检标准：找不到任何一个「直接会话能做、平台会话不能做」的操作。

### 3.3 SessionCard

```jsonc
{
  "session_id": "S-000317",
  "agent_id": "dsh-01",
  "role": "frontend_dev",          // 出生即绑定（C6）
  "task": "T-0042",
  "mode": "platform",              // 只有平台会话会被注册；D-Session 永不入库
  "lifespan": "ephemeral",
  "spawned_by": "hub.scheduler",
  "sandbox": ".mesh/worktrees/T-0042",
  "status": "active",              // starting|active|exited|expired|killed|failed
  "pid": 12345,
  "created_at": "…",
  "last_heartbeat_at": "…",
  "ttl_seconds": 1800,
  "hello_at": "…",                 // null = 无任何权限
  "turns": 1,
  "exit": null
}
```

### 3.4 TaskCard

```jsonc
{
  "task_id": "T-0042",
  "title": "实现登录页面",
  "role": "frontend_dev",
  "status": "ready",
  "depends_on": ["T-0039"],
  "scope": {
    "write": ["web/src/pages/login/**"],   // 合并终审唯一依据
    "read":  ["web/src/api/**"]
  },
  "acceptance": ["表单含邮箱/密码字段", "提交调用 POST /api/auth/login", "组件测试覆盖 ≥80%"],
  "estimate": "1-session",                 // multi-session 会被拒
  "base_commit": "abc1234",
  "branch": "mesh/T-0042",
  "worktree": ".mesh/worktrees/T-0042",
  "claimed_by": "S-000317",
  "implementer_agent": "dsh-01",
  "submission": { "commit": "…", "summary": "…", "files": ["…"] },
  "reviews": ["R-0001"],
  "merge": { "merge_commit": "…", "mode": "strict|strip", "stripped": [] },
  "history": [{ "at": "…", "from": "ready", "to": "claimed", "by": "S-000317" }]
}
```

**粒度铁律（代码强制）：** `acceptance` 条目 > 7，或 `estimate = multi-session` → 创建直接被拒（`MESH_GRANULARITY`），并记审计。粒度过大是脱轨头号诱因。

### 3.5 Message

```jsonc
{
  "msg_id": "M-000135",            // 全局唯一；消费方按 msg_id 幂等去重
  "from": { "agent": "coordinator", "session": "S-000301", "role": "coordinator" },
  "to":   { "role": "supervisor", "thread": "T-0042" },   // 角色线程寻址，绝不是 agent id
  "type": "task.assign",           // 见下表
  "body": "…",
  "attachments": [{ "path": "…", "sha256": "…", "bytes": 1024, "inline": true, "text": "…" }],
  "thread": "T-0042",
  "ttl_seconds": 1800,
  "created_at": "…",
  "expires_at": "…",
  "resolved": { "agent_id": "dsh-01", "session_id": "S-000317" },  // 投递时解析
  "read_at": null,
  "status": "queued"               // queued|read|dead
}
```

消息类型：`task.assign` · `task.feedback` · `review.verdict` · `question.ask` · `question.answer` · `escalation` · `heartbeat` · `board.update` · `system.notice`

**附件规则：** < 32KB 内联；≥ 32KB 走 artifact 引用 + sha256 校验。

**投递双通道：** MCP 实时推送（`hub.wait_messages` 长轮询）+ `.mesh/messages/inbox/` 落盘。任一可用即可；无 MCP 的 Agent 走纯文件协议（用 `mesh` CLI），能力降级但不脱轨。

## 4. 任务状态机

```
draft → ready → claimed → in_progress → submitted → reviewing → approved → merged
                     ↑                                              │
                     └────────────── rejected ←────────────────────┘

任意态 → blocked →（coordinator 仲裁）→ ready / in_progress
claimed 超时未提交 → 自动释放 + 重新指派 + 记审计
```

状态只能由 Hub 代码修改（`hub/core/stateMachine.ts`）。非法跃迁抛 `MESH_TRANSITION_ILLEGAL`。

## 5. 产出三通道

| 通道 | 内容 | 规则 |
|---|---|---|
| **A 工作通道** | 沙箱内一切操作：读写代码、跑测试、装依赖、子 Agent 并行探索、Web 查资料 | 完全自由。平台不看、不管、不审计细粒度操作 |
| **B 产出通道** | 代码交付：commit 到任务分支 → `hub.submit()` → review → merge | 唯一合法产出路径；merge 时做 scope 终审 |
| **C 协作通道** | 领任务、收发消息、上报进度、escalate、**非代码工件**入库 | 走 `hub.*`，按 Session 角色校验路径 |

`hub.put_artifact` **不是文件操作闸门**——它是通道 C 的非代码工件入库接口。你在沙箱里用原生 Write 写代码完全合法。真正的闸门是通道 B 的 git diff 校验。

## 6. Hub 工具接口（MCP 工具名 / CLI 等价命令）

| MCP 工具 | CLI | 作用 |
|---|---|---|
| `hello` | `mesh hello` | 注册会话，返回本 Session 角色卡（未调用则无任何权限） |
| `whoami` | `mesh whoami` | 我是谁：角色、任务、沙箱、租约 |
| `heartbeat` | `mesh heartbeat` | 续租 |
| `get_board` | `mesh board` | 看板快照（角色相关子集） |
| `get_task` | `mesh task <id>` | 任务卡全文 + 审查记录 |
| `claim_task` | `mesh claim <id>` | 原子领取，返回上下文包路径 |
| `get_context` | `mesh context <id> [--level]` | 重新生成上下文包 |
| `report_progress` | `mesh progress <id> --pct N` | 进度上报 |
| `request_clarification` | `mesh ask <id> "问题"` | 向 coordinator 提问 |
| `escalate` | `mesh escalate "原因" [--task id]` | 越界需求 / 紧急升级 |
| `submit` | `mesh submit <id> --summary "…"` | 提交进入 review |
| `request_review` | `mesh review <id>` | Supervisor 开启审查 |
| `verdict` | `mesh verdict <id> --approve/--reject --notes "…"` | 裁决 |
| `merge` | `mesh merge <id>` | Integrator 合并（含 scope 终审） |
| `send` | `mesh send --to role:thread --type t --body "…"` | 发消息（角色线程寻址） |
| `read_messages` | `mesh messages` | 读收件箱 |
| `wait_messages` | `mesh wait` | 长轮询收件箱 |
| `put_artifact` | `mesh put <path> --file F` | 非代码工件入库 |
| `get_artifact` | `mesh get <path>` | 读取工件 |
| `list_artifacts` | `mesh artifacts` | 工件列表 |
| `get_file` | — | 跨任务读取主工作区文件（只读） |

MCP 暴露的名字带服务器前缀：`mcp__hub__hello`。CLI 的所有命令都支持 `--session S-xxxxxx`，默认取环境变量 `MESH_SESSION_ID`。

## 7. 文件协议（无 MCP 时的降级通道）

Agent 只要**能跑 shell 命令**就能完整接入：

```bash
# 1. 看清自己是谁（session id 在环境变量 MESH_SESSION_ID 里，也可 --session 显式传）
mesh hello

# 2. 领任务
mesh claim T-0042

# 3. 干活（原生工具，随便用）
#    …写代码、跑测试…

# 4. 提交
git add -A && git commit -m "feat: login page"
mesh submit T-0042 --summary "实现登录页，含 zod 校验与组件测试"

# 5. 收消息
mesh messages
mesh wait --timeout 20000
```

功能不降级，只是少了 MCP 的结构化返回。**这是 T5 红队用例的实现基础。**

## 8. 合并终审（最后防线）

```
git diff base..task-branch --name-only   → 改动文件清单
清单 − TaskCard.scope.write              → 越界改动集
越界集为空     → 合并
越界集非空     → 默认整个提交拒绝 + 打回（附 diff 证据）
                Supervisor 可裁决「剥离 scope 外文件后合并」→ strip 模式，剥离内容记审计
```

实现要点（`hub/core/mergeGate.ts`）：

1. 合并是一个**事务**：`git merge --no-commit` → 校验每一个 staged 路径 → 提交或 `merge --abort`。
2. 提交后再做一次**事后校验**（`changedFiles(preMergeHead, mergeCommit)`）；万一越界，`reset --hard` 回滚并抛错。
3. 无论 Agent 用什么工具、以什么方式工作，**scope 外改动零进入主分支**。“写了主仓库”本身不构成有效产出。

## 9. Sentinel：detect-only

扫描四类问题，**只记录 + 通知，不阻断、不回滚、不改任务状态**：

| 违规类型 | 含义 |
|---|---|
| `scope.out-of-write` | 任务分支改了 scope.write 之外的文件 |
| `scope.merge-blocked` | 合并终审拒绝了一次提交（含 strip 成功记录） |
| `drift.main-branch` | 主分支出现平台没有记录来源的提交（D-Session 直推） |
| `role.artifact-denied` / `role.code-attempt` | 非代码角色试图通过 put_artifact 交代码 |
| `role.overreach` | 实现者试图审查自己的任务等越权 |
| `protocol.unknown-session` | 未注册会话尝试特权操作 |
| `protocol.bus-bypass` | 试图点对点寻址 |
| `liveness.stale-session` | 会话失联 |
| `granularity.oversized` | 任务粒度过大被拒 |

## 10. 宪法条款（C1–C8，不可协商）

| # | 条款 | 内容 |
|---|---|---|
| C1 | 裁决权 | “任务完成”只能由平台授予：submit → review 通过 → 合并终审通过。绕过平台的产出不入库、不生效 |
| C2 | 超集性 | P-Session 必须是 D-Session 的严格超集。任何使平台会话弱于直接会话的设计都是 bug |
| C3 | 双模边界 | D-Session 中平台零干预、零感知。任何后续设计——包括“善意的”自动注入——不得使平台获得对 D-Session 的干预能力 |
| C4 | 职责约束 | 平台约束「做什么」，永不约束「用什么做」 |
| C5 | 确定性核心 | Hub 是确定性状态机代码，LLM 是平台的用户 |
| C6 | 单角色会话 | Session 出生即绑定单一角色，中途不可切换 |
| C7 | 审查独立 | 任何 Agent 不得同时担任同一任务的实现者与审查者 |
| C8 | 总线原则 | 跨 Agent 通信一律经 Hub 中转，不存在点对点暗道 |

改动任何一条都必须升级用户裁决。

## 11. 错误码

| 错误码 | 含义 | 该怎么办 |
|---|---|---|
| `MESH_SESSION_UNKNOWN` | 会话不存在 | 检查 `MESH_SESSION_ID` |
| `MESH_SESSION_HELLO_REQUIRED` | 还没 hello | 先 `hub.hello()` |
| `MESH_SESSION_ROLE_MISMATCH` | Session 角色与任务角色不符 | 换合适的 Session |
| `MESH_SESSION_DEAD` | 会话已结束/过期 | 让调度器重开 |
| `MESH_CLAIM_CONFLICT` | 任务已被别人领走 | 换一张卡 |
| `MESH_TRANSITION_ILLEGAL` | 非法状态跃迁 | 看 `get_task` 的 status |
| `MESH_DEPENDENCY_UNMET` | 依赖未合并 | 等上游 |
| `MESH_SOD_VIOLATION` | 违反职责分离 | 换人 |
| `MESH_REVIEW_NOT_INDEPENDENT` | 自己审自己 | 换人（C7） |
| `MESH_SCOPE_VIOLATION` | 越界改动被拒 | 只保留 scope 内改动后重新 submit |
| `MESH_GRANULARITY` | 任务粒度过大 | 拆卡 |
| `MESH_ARTIFACT_DENIED` | 非代码角色写非法工件路径 | 代码走通道 B |
| `MESH_BUS_BYPASS` | 点对点寻址 | 改成 role + thread |
| `MESH_LOCK_TIMEOUT` | 锁竞争超时 | 重试 |
| `MESH_GIT_FAILED` | git 操作失败 | 看 detail 里的 stderr |

## 12. 角色一览

| 角色 | 职责 | 关键约束 |
|---|---|---|
| Coordinator | 与用户对话、拆解下发、统筹、处理升级 | **禁止写生产代码**（代码级强制） |
| Planner | 里程碑、依赖图、任务卡草案 | 只产出计划与卡片 |
| Architect | 技术选型、模块边界、接口契约 | 只产出设计文档 |
| Researcher | 调研、带出处的摘要 | 不写业务代码 |
| Frontend / Backend Dev | 按任务卡实现 | 只写 scope 内路径 |
| Executor | 批量同构任务 | 从模板队列领任务 |
| Supervisor | 按 acceptance 审查、跑测试、裁决 | 不实现，只评审；不得自审 |
| Integrator | 合并、冲突处理、scope 终审 | 只在 review 通过后操作 |
| Sentinel | 违规扫描、漂移检测、审计日志 | 只读 + 写审计，detect-only |

角色是逻辑职能：任何具备对应 `capabilities` 的 Agent 都可以担任，安全性和“谁担任”无关——它来自 Session 隔离、权限随 Session、以及合并终审。

---

**一句话总结整个协议：** 你拥有完整的工具箱和整个代码库的读权限，但你的产出必须过质检、合并必须过审查。没有公司靠没收螺丝刀防止员工越权。
