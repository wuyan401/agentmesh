# V2 验收报告

> 依据 `docs/V2-MISSION.md` §7/§9。每个里程碑：`tsc --noEmit` 零错误、`node --test` 全绿、
> **真跑一次**。M1 已验收；本轮做 **M2**，M3–M5 未动。

---

## M1 · Mission 内核 — ✅

`MissionCard` 类型/schema/store/状态机/history、`lead` 角色 + `is_lead`/`mission` + `requireLead`、
`plan_mission` / `get_mission` / `dispatch_mission` / `final_verdict` / `write_report`（另含
`create_mission`，`mesh mission` 需要它）、`mesh mission` / `mesh missions` / `mesh mission <id>`、
调度器自动推进。

### 1. 改了哪些文件

**新增**

| 文件 | 行数 | 作用 |
|---|---|---|
| `hub/core/missions.ts` | 571 | MissionService：建/拆/派/二次验收/报告 + 自动推进规则 + lead 回合 brief |
| `hub/core/../stateMachine.ts`（改） | +80 | `MISSION_TRANSITIONS` + `applyMissionTransition`（与任务状态机同一套写法） |
| `cli/mission.ts` | 345 | `mesh mission/missions`（人）与 `plan-mission` 等（lead 动作） |
| `schemas/mission.schema.json` | 77 | MissionCard 的 JSON Schema |
| `tests/unit/mission.test.ts` | 522 | 18 项：状态机、lead 权限、原子拆解、派发、自动推进、打回/返工、C1 回归 |
| `tests/fixtures/scripted-worker.mjs` | 64 | 验收脚手架：真实进程，claim→写→commit→submit |
| `tests/fixtures/scripted-supervisor.mjs` | 62 | 验收脚手架：检查文件后 verdict |
| `tests/fixtures/register-scripted.ts` | 59 | 把上面两个写成合法 AgentCard |
| `tests/prove/m1-walk.ps1` | 146 | 一次 3 卡 mission 的完整验收脚本（可重跑） |
| `docs/DECISIONS-V2.md` | — | 13 条取舍记录（含与状态图的偏差） |
| `docs/ACCEPTANCE-V2.md` | — | 本文件 |

**修改**

| 文件 | 改了什么 |
|---|---|
| `hub/core/types.ts` | `MISSION_STATUSES`/`MissionCard`/`MissionPlanEntry`；`ROLE_IDS` 末尾加 `lead`；`SessionCard` 加 `mission`/`is_lead`；`TaskCard` 加 `preferred_agent`；任务状态机加 `merged → rejected` |
| `hub/core/schema.ts` | `validateMissionCard` + `SchemaKind` 加 `mission`；session/task 新字段校验 |
| `hub/core/store.ts` | `nextId('mission')`；mission 读写；`writeMissionReport`/`readMissionReport` |
| `hub/core/paths.ts` | `.mesh/missions/`、`M-000001.json`、per-mission 目录 |
| `hub/core/identity.ts` | `createSession` 接受 `mission`/`is_lead`；`requireLead`；`leadSessionOf` |
| `hub/core/board.ts` | `rejectMergedTask`（二次验收打回）、`requeueRejectedTask`（返工回队）、`approvedReview` 只认当前提交的审查（D4）、`createTask` 接受 `preferred_agent` |
| `hub/core/api.ts` | 6 个 mission 工具方法（`create_mission`/`get_mission`/`plan_mission`/`dispatch_mission`/`final_verdict`/`write_report`） |
| `hub/mcp/server.ts` | 同上 6 个 MCP 工具（工具名与规格一致），instructions 补一句 |
| `hub/scheduler/scheduler.ts` | `advanceMissions`、`dispatchLeadTurns`（intake/integrating 拉 lead 回合）、`pickAgent` 尊重 `preferred_agent`、队友入册 |
| `hub/core/config.ts` | `max_concurrent_sessions` 4→16；新增 `mission_lead_agent`/`mission_max_depth`/`reassign_after_rejections` |
| `hub/roles/cards.ts` | `lead` 角色卡（can_write_code=false / can_implement=false / can_review=true / can_merge=true） |
| `hub/core/init.ts`、`hub/adapters/detect.ts`、`cli/human.ts` | 每个 AgentCard 默认带 `lead` 能力；`mesh-human` 也可当 lead；`mesh status` 显示进行中的 mission |
| `cli/mesh.ts` | 9 条新命令路由 + help |
| `hub/core/fsx.ts` | JSON/JSONL 读取剥 UTF-8 BOM（D12） |
| `tests/unit/adapters.test.ts` | **按要求改测试不改实现**：`DSH_HOME` 断言改成 mock 值 `C:\\mock-dsh-home`，并断言它原样透传 |
| `tests/unit/claim.test.ts` | 并发 claim 的失败方允许 `MESH_LOCK_TIMEOUT`（高负载下合法），"恰好一个赢"与 history 唯一性断言不变 |

### 2. `tsc --noEmit` 真实输出

```
$ .\node_modules\.bin\tsc.cmd --noEmit -p tsconfig.json
lines: 0  exit: 0
(no output — zero errors)
```

尾部 10 行就是空的——0 错误时 tsc 不输出任何东西。上面是原样输出（含行数与退出码）。

### 3. `node --test` 真实统计

```
$ node --test tests/unit/*.test.ts tests/redteam/*.test.ts
ℹ tests 73
ℹ suites 0
ℹ pass 73
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 117914.3162
```

55（V1 原有，含红队 T1–T10 的 11 项）+ 18（M1 mission）= **73 全绿**，红队未受影响。

### 4. 真跑证据（不依赖任何真实 agent）

脚本：`tests/prove/m1-walk.ps1`（可重复执行，每次重建 scratch 项目）。

```
$ powershell -NoProfile -File tests/prove/m1-walk.ps1
```

**a) 建 mission（平台入口，人工指定 lead）**

```
✔ M-000001 intake 做一个带登录的博客
  lead mesh-human · 验收 2 条　by mesh-human/S-000001
```

**b) 拆卡 + 派发（lead = 人类，CLI 代签身份）**

```
✔ lead 会话 S-000002（mesh-human，mission M-000001）
✔ M-000001 → planning，建了 3 张卡
  T-000001 backend_dev    实现登录接口
  T-000002 frontend_dev   实现登录页
  T-000003 executor       端到端测试
✔ M-000001 → executing（3 张卡进入看板）
```

**c) 调度器真拉起进程干活（worker/supervisor 都是真实 P-Session 进程）**

```
15:50:41 # 1 spawn 1
15:50:45 # 1 review 1
15:50:48 # 1 merge 1
  ✔ T-000001 merged 1c928606 (strict)
  …（T-000002、T-000003 同）
  mission: executing -> integrating
```

`scripted-01` 实现、`scripted-02` 独立审查（C7：不同 agent），每张卡都经 scope 终审合并。

**d) 二次验收打回 → 返工 → 再合并（完整状态链，带时间戳）**

```
15:50:38 intake → planning          planned 3 task(s)
15:50:39 planning → executing       dispatched
15:51:15 executing → integrating    all 3 task(s) settled
15:51:18 integrating → final_review lead integrating finished
15:51:18 final_review → rejected    二次验收不通过：端到端测试只覆盖了成功路径，补失败路径
15:51:19 rejected → executing       rework round
15:51:30 executing → integrating    all 3 task(s) settled
15:51:33 integrating → final_review lead integrating finished
15:51:34 final_review → completed   report written
```

打回细节：

```
rejecting T-000003 (status merged)
✔ M-000001 二次验收 不通过 → rejected（第 1 轮）
  打回：T-000003
mission: rejected rounds=1
T-000003 status: rejected
```

T-000003 因此**合并了两次**（`1015ec43` 初版、`9e3130aa` 返工版），主分支图可见：

```
*   9e3130a mesh(T-000003): 端到端测试
*   1015ec4 mesh(T-000003): 端到端测试
*   1ae7a94 mesh(T-000002): 实现登录页
*   1c92860 mesh(T-000001): 实现登录接口
* 0ca261a chore: scratch
```

**e) 报告落盘 + mission 完成**

```
✔ M-000001 二次验收 通过 → final_review（第 1 轮）
✔ M-000001 → completed，报告 .mesh/missions/M-000001/report.md

Mission   状态         标题         Lead        卡    轮次
M-000001  completed  做一个带登录的博客  mesh-human  3/3  1
```

`.mesh/missions/M-000001/report.md` 实际内容（前 12 行）：

```markdown
# 交付报告 · 做一个带登录的博客

用户原话：做一个带登录的博客

## 结果

| 任务 | 角色 | 实现 | 审查 | 合并 |
|---|---|---|---|---|
| T-000001 实现登录接口 | backend_dev | scripted-01 | scripted-02 | 1c928606 |
| T-000002 实现登录页 | frontend_dev | scripted-01 | scripted-02 | 1ae7a948 |
| T-000003 端到端测试 | executor | scripted-01 | scripted-02 | 9e3130aa |
```

**f) 不变量仍然成立**

- `git hash-object hub/core/mergeGate.ts` = `53abc7333a2b065c9dcc4f757647c955f0e0e2a2`（与 V1 存档一致，**未改动**）
- 主分支只多了 4 个平台合并提交，没有任何越界文件
- `docs/DECISIONS-V2.md` 记录了 13 条取舍

### 5. 没做到的（不粉饰）

**按指示未做**（M2–M5）：`AgentProfile` 与评分、`rate_peer` 防刷、打分排序 `pickAgent`、
打回换人 `rejection_count`、上下文注入两节、`list_teammates`、协作史目录 + `HISTORY.md` + 导出、
观察台 missions 页、`start_mission` 对话入口注入、`reassign_after_rejections` 的实际生效。
`reassign_after_rejections` 与 `mission_max_depth` 三个新配置项已进 `config.ts`，
但前者只在 M2 才被读，现在写入配置不会有效果。

**M1 内部的缺口**（都是真跑才发现/没做的）：

1. **`dispatchLeadTurns` 没被真跑过**。本机没有可用的真实 LLM lead：验收用人类 lead 驱动，
   `mesh-human` 是 builtin 所以调度器不会拉它的回合。也就是说"自动拉 lead 会话"的逻辑
   只有单测覆盖（`missionsNeedingLead` + `advanceMissions`），没有真实进程证据。
   M5 接真实 agent 时才能补上。
2. **嵌套 mission 只测了创建与深度上限**，没有测"lead 在会话里给自己的 mission 开子 mission"
   的完整链路（`create_mission` 的 `parent_mission` 默认取 `actor.session.mission`，这条未实测）。
3. **合并失败没有重试上限**。验收时我故意让工作树变脏，`mesh up` 每 tick 打印一次
   `MESH_GIT_FAILED`，卡片一直停在 `approved`。拒绝是对的，但缺"连续失败就 blocked"的上限（D13）。
4. **`mesh mission export` 没做**（M4），报表只能看 `.mesh/missions/<id>/report.md`。
5. **观察台没有 missions 页**（M4），目前只能用 CLI 看。
6. **`start_mission` 未暴露**。规格 §5.2 的对话入口是新工具名；M1 只做到 `create_mission`
   （`source: "chat"` 字段已实现并记录来源），`start_mission = create + dispatch` 的薄封装留给 M5，
   因为它要配合各 agent 的全局指令注入一起验证，单独做一个空壳反而误导。
7. **人类 lead 的会话不会自动结束**。`mesh mission lead` 建的署名会话在 mission 完成后仍是
   `active`（无进程），`mesh status` 里会看到一个 `lead` 会话挂着。不影响任何判定（D6），
   但观感上应该由 M4 的 `mesh mission close` 收尾。

---

## M2 · 评分与换人 — ✅

`AgentProfile`（九个维度 + 互评 + 自动统计）、`rate_peer` 防刷边界与加权移动平均、
`pickAgent` 打分排序（稳定可复现）、打回换人（`rejection_count` + `reassign_after_rejections`）。

### 1. 改了哪些文件

**新增**

| 文件 | 行数 | 作用 |
|---|---|---|
| `hub/core/profiles.ts` | 380 | ProfileService：九维读写、`rate_peer` 全部边界、WMA、自动统计 |
| `hub/scheduler/scoring.ts` | 148 | §2.2 公式的纯函数：`scoreAgent` / `specialtyMatch` / `rankAgents`（无 I/O，好测） |
| `cli/profile.ts` | 250 | `mesh profile list/show/get/set/backfill` + `mesh rate-peer` |
| `schemas/profile.schema.json` | 77 | AgentProfile 的 JSON Schema |
| `tests/unit/scoring.test.ts` | 13 项 | 公式可复现、tie-break、`profile set` 影响派发、互评边界 |
| `tests/unit/reassign.test.ts` | 8 项 | 计数、阈值、排除历史实现者、无候选 blocked、`preferred_agent` 不能开后门 |
| `tests/unit/process.test.ts` | 3 项 | 你改的两处 `runForeground` 回归（stdin 不挂、超时仍留输出） |
| `tests/prove/m2-walk.ps1` | 96 | 两条真跑证据：手编影响派发、两次打回换人 |

**修改**

| 文件 | 改了什么 |
|---|---|
| `hub/core/types.ts` | `AgentProfile`/`PeerReview`/`ProfileStats`/`PEER_SCORE_KEYS`；`TaskCard.rejection_count`/`rejected_by`；默认分 60/70 |
| `hub/core/schema.ts` | `validateAgentProfile`（九个维度 + 每条互评 + 统计 + 时间戳） |
| `hub/core/paths.ts` · `store.ts` | `.mesh/profiles/<agent_id>.json`；`listProfiles/getProfile/saveProfile` |
| `hub/core/board.ts` | `recordVerdict(rejected)` 累加 `rejection_count` 并把实现者记进 `rejected_by`；每次判决回写 profile 统计；**修掉返工 claim 的两个 V1 bug**（D19） |
| `hub/scheduler/scheduler.ts` | `rankCandidates` / `selectAgent` / `pickAgent(role,task,mission?)` 打分排序；`requeueRejected` 让打回的卡每 tick 回队；派发器在无候选时按 §2.3 置 blocked |
| `hub/core/hub.ts` | `profiles` 服务接线（Board 与 MissionService 都拿到它） |
| `hub/core/missions.ts` | mission 级打回时给实现者记 `rounds`；参与者入册时记 `missions` |
| `hub/core/api.ts` · `hub/mcp/server.ts` | `get_profile` / `rate_peer` 两个工具 |
| `hub/core/init.ts` | `mesh init` 时给每个 agent 补一份 profile（只补缺，不覆盖） |
| `hub/core/errors.ts` | `MESH_RATE_DENIED` |
| `cli/common.ts` | `duration()`：`--timeout` 默认单位改成**秒**，支持 `500ms`/`30s`/`5m`（D17） |
| `cli/{mesh,human,mission,agent}.ts` | 路由、help（含单位说明）、所有 `--timeout` 改用 `duration()` |
| `tests/fixtures/*` | 四个脚本 agent（两个可互换的 worker + 一个必被拒的坏 worker）；`MESH_SCRIPTED_MODE=bad` 让 worker 产出不合格件 |
| `.gitignore` | 忽略 `.tools/`（我的临时脚本） |

（`hub/scheduler/process.ts` 的改动是你做的两处修复，本轮一并提交，未再改动。）

### 2. `tsc --noEmit` 真实输出

```
$ .\node_modules\.bin\tsc.cmd --noEmit -p tsconfig.json
lines=0 exit=0
```

（0 错误时 tsc 无输出，这里带上了行数与退出码。）

### 3. `node --test` 真实统计

```
ℹ tests 97
ℹ pass 97
ℹ fail 0
ℹ duration_ms 128095.8175
```

**97 = 73（M1 及此前全部）+ 24（M2：13 scoring + 8 reassign + 3 process）**。红队 11 项继续全绿。

### 4. 真跑证据

脚本：`tests/prove/m2-walk.ps1`（每次重建 scratch 项目，真实进程，不接 LLM）。

**a) 两个可互换的 worker：默认同分，按 agent_id 字典序**

```
✔ T-000001 ready 实现限流器
T-000001 implementer = scripted-01          ← 同分 → id 最小者
```

**b) 手编 scripted-03 的 quality_score=95，下一次派发立刻听它的**

```
✔ scripted-03.quality_score = 95
  manual_locked=true · 下一次派发按新分数排序
✔ T-000002 ready 实现缓存层
T-000002 implementer = scripted-03          ← 期望 scripted-03 ✔
```

`mesh profile show scripted-03` 的九个维度（表头就是规格里那九个词）：

```
  性格　　  —        擅长　　  —        弱势　　  —
  能力范围  M1 scaffolding: claim → write → commit → submit, no LLM
  独特细节  —        质量分　  95       花费　　  1
  可靠性　  70       速度　　  —
```

**c) 打回换人：坏的 worker 先干、被拒两次、然后必须换手**

为了让"换人"确实由 §2.3 触发（而不是被别的 agent 的高分顶掉），先把三个 worker 的分数拉开：

```
✔ scripted-bad.quality_score = 99
✔ scripted-01.quality_score = 40
✔ scripted-03.quality_score = 40
```

时间线（真实进程，真实 commit）：

```
T-000003: ready/                 -> claimed/scripted-bad   (rejections=0)
T-000003: claimed/scripted-bad   -> submitted/scripted-bad (rejections=0)
T-000003: submitted/scripted-bad -> rejected/scripted-bad  (rejections=1)   ← 第一次打回
T-000003: rejected/scripted-bad  -> claimed/scripted-bad   (rejections=1)   ← 未到阈值，允许重试
T-000003: submitted/scripted-bad -> rejected/scripted-bad  (rejections=2)   ← 第二次打回
T-000003: rejected/scripted-bad  -> claimed/scripted-01    (rejections=2)   ← 排除历史实现者，换人
T-000003: submitted/scripted-01  -> approved/scripted-01   (rejections=2)
✔ T-000003 merged 36627fd8 (strict)
T-000003 final: status=merged impl=scripted-01 rejections=2 rejected_by=[scripted-bad]
```

（换到 `scripted-01` 而不是 03，因为两者都是 40 分 → 又是 agent_id 字典序。）

**d) 统计是自动攒出来的**

```
Agent         状态     来源  质量分  花费  可靠性  成功率
scripted-bad  ready  手编  99    1    0     0%
  scripted-bad 战绩  任务 2 · 通过 0 · 打回 2 · mission 0 · 轮次 2 · 成功率 0%
  锁定  人工手编（互评不覆盖质量分）
```

主分支上三条合并提交都是 scope 终审过的 strict 合并。

### 5. 没做到的（不粉饰）

**按指示未做**：M3（上下文注入两节 + `list_teammates`）、M4（协作史目录 + 观察台 missions 页 + 导出）、
M5（真实 3 agent e2e + `start_mission` 注入）。

**M2 内部的缺口**：

1. **`rate_peer` 只做了单测，没有真跑证据**。边界都测了（同一 mission、不能自评、一人一次、
   0-100 越界、WMA 精确值、手编锁定），但验收脚本里没有让两个真实进程互相打分——
   脚本 agent 不会主动调用 `rate_peer`，我也没有在 CLI 里伪造一次。
   `mesh rate-peer` 存在且与工具同义，但这条链路的"真跑"欠着。
2. **`stats.rounds` 会重复计数**：一阶打回时 `noteOutcome(rejected)` 已经 +1，
   mission 二次验收打回又 `noteRound` +1。语义上确实是两件事，但同一张卡被打回两次会看到 +3。
   要不要合并成一个口径，需要你定。
3. **换人只看分数，不看"为什么被拒"**。`ReviewRecord.notes` 里写着"缺测试"，
   换人时没用上——没有"按弱势匹配"的逻辑。
4. **`specialtyMatch` 是纯词面匹配**（D14），同义词、缩写、跨语言（"登录" vs "auth"）都不匹配。
5. **手编高分可以顶着 0% 成功率**（D20）。这是规格直译，但值得你知道：
   `scripted-bad` 99 分 / 0% 仍然会被派活，除非人把它改掉。
6. **profile 的 `personality`/`strengths` 等文本维度默认全空**，没有任何自动填充
   （规格没要求，我也没编造人格）。真要用起来得靠人填，或 M4 从协作史里提炼。
7. **观察台不显示 profile**（M4 的事），现在只能 `mesh profile list/show`。

---

## M3 · 上下文注入 — ✅

「你在哪」（mission/lead/你这一环/完成定义）与「队友」（来自 AgentProfile 的表）
进 spawn prompt 与上下文包；`minimal` 档只保留第一节的紧凑版；新增 `list_teammates`。

### 1. 改了哪些文件

**新增**

| 文件 | 行数 | 作用 |
|---|---|---|
| `hub/core/teammates.ts` | 190 | 队友行的一次性构造 + 表格渲染；`missionOfTask`；prompt 与工具共用，不可能漂移 |
| `tests/unit/context.test.ts` | 10 项 | 三档差异、每档都含自己的卡与角色、无 mission 退化、表随 mission 变、表随 profile 变、工具与表一致 |
| `tests/prove/m3-walk.ps1` | 150 | 真跑证据：从真实 spawn 的 session log 里 grep 注入块 |

**修改**

| 文件 | 改了什么 |
|---|---|
| `hub/core/context.ts` | `renderMissionSection()`（三档 + 无 mission 退化）、`renderPlatformSection()`（§3.2）；接到 `build()` 靠前的位置 |
| `hub/scheduler/prompt.ts` | `PromptInput.contextSections`，插在角色卡之后、任务卡之前 |
| `hub/scheduler/scheduler.ts` | `contextSections()`：按 `config.context_level` 渲染，`minimal` 不带 §3.2 |
| `hub/core/api.ts` · `hub/mcp/server.ts` | `list_teammates(mission_id?)` 工具 |
| `hub/core/missions.ts` | `missionOfTask` 改为委托共享实现（去重） |
| `cli/human.ts` · `cli/mesh.ts` | `mesh teammates [M-000001] [--json]` + help |

### 2. `tsc --noEmit`

```
$ .\node_modules\.bin\tsc.cmd --noEmit -p tsconfig.json
(no output — 0 errors, exit 0)
```

### 3. `node --test`

```
ℹ tests 107
ℹ pass 107
ℹ fail 0
ℹ duration_ms 154413.5241
```

**107 = 97（M1+M2 及此前全部）+ 10（M3 context）**。

### 4. 真跑证据

`powershell -NoProfile -File tests/prove/m3-walk.ps1`（真实 spawn，不接 LLM）。

**a) 从真实 session log 里 grep 注入块**（`.mesh/logs/S-000003.log`）

```
[OK  ] ## 你在哪
[OK  ] ## 队友
[OK  ] lead：mesh-human
[OK  ] 自己的 task_id
[OK  ] 自己的角色
[OK  ] 队友表头
[OK  ] scripted-01 的性格
[OK  ] ## 这个平台怎么用
```

**b) agent 实际看到的那一段**（从日志里原样取出）

```markdown
## 你在哪

- Mission：M-000001「做一个带登录的博客」（你是第 1/2 个执行者）
- Lead：mesh-human —— 它拆的任务，最后由它整合、二次验收并给用户报告
- 你这一环：T-000001「实现登录接口」，角色 backend_dev
- 完成定义：你 submit → 一个独立审查者通过 → 平台 scope 终审合并
- Mission 级验收（决定整体算不算完成）：1) 登录可用

## 队友（本次协作，按参与顺序）

| agent | 性格 | 擅长 | 弱势 | 质量分 | 花费 | 本轮负责 |
|---|---|---|---|---|---|---|
| mesh-human | — | — | — | 60 | 1 | lead |
| scripted-01 ← 你 | 老实、照契约办事 | 接口实现、提交规范 | 不做视觉设计 | 60 | 1 | 实现 T-000001 |

> 不了解队友时，用 `hub.list_teammates("M-000001")` 查全量；不要猜。
```

表里的性格/擅长/弱势是前一步 `mesh profile set` 手写进去的，不是模板文本（D23）。

**c) 同一份上下文包在磁盘上**（`claim_task` 返回的那份）

```
context file: .mesh/context/T-000001.md (3009 bytes)
  [OK  ] ## 你在哪
  [OK  ] ## 队友
  [OK  ] Lead：mesh-human
  [OK  ] T-000001
  [OK  ] 角色 backend_dev
```

**d) `mesh teammates M-000001`（工具的表，与注入同一份数据）**

```
agent            性格        擅长        弱势      质量分  花费  本轮负责
mesh-human lead  —         —          —       60   1   lead
scripted-01      老实、照契约办事  接口实现、提交规范  不做视觉设计  60   1   实现 T-000001
```

**e) `minimal` 档真的更少**（`mesh config set context_level minimal` 后再 spawn 一个 worker）

```
session log: S-000005.log
  [OK  ] ## 你在哪（紧凑）
  [OK  ] ## 队友（minimal 档必须没有）
  [OK  ] ## 这个平台怎么用（minimal 档必须没有）

## 你在哪（紧凑）

- Mission：M-000001「做一个带登录的博客」，你是第 2/2 个执行者；lead 是 mesh-human
- 你这一环：T-000002「实现登录页」，角色 frontend_dev
- 完成定义：你 submit → 一个独立审查者通过 → 平台 scope 终审合并
```

### 5. 没做到的（不粉饰）

**按指示未做**：M4（协作史目录 + `HISTORY.md` + 观察台 missions 页 + 导出）、M5（真实 3 agent e2e）。

**M3 内部的缺口**：

1. **队友表只覆盖"这个 mission 的参与者"**。跨 mission 的"我以前跟谁合作过"没有——那要 M4 的协作史。
2. **`minimal` 档在真实运行里只验证了 worker**；lead 回合（`task === null`）根本不注入这两节，
   它靠 `excerptSection`（mission brief）。这意味着 lead 的 prompt 里没有队友表——
   规格没要求，但"lead 也要知道队友是谁"其实挺合理，留给 M5 一起看。
3. **表格对长文本是截断的**（性格 18 字、负责 30 字）。截断用省略号，不撒谎，但信息确实少了；
   全量在 `list_teammates` 里。
4. **"你是第 k/n 个执行者"按卡序算**（D22），如果一个 mission 有卡被取消，n 不变、k 会跳过——可接受，
   但和"人数"不是一回事。
5. **注入文本没做多语言**，全中文；agent 若是英文模型也能读，但没测过。
6. **上下文包体积**：standard 档 3009 bytes，full 档会更大；prompt 也变长了。
   目前没做 token 预算，只是"够小"。

---

## M4 · 协作史 — ✅

mission 结束时落盘 `.mesh/missions/<id>/{report.md,timeline.md,tasks.json,context/}` +
`.mesh/HISTORY.md` 全局索引；CLI 四条命令；观察台两个页面（列表 + 详情）。

### 1. 改了哪些文件

**新增**

| 文件 | 行数 | 作用 |
|---|---|---|
| `hub/core/history.ts` | 365 | `MissionHistory`：合并两个账本出时间线、tasks 快照、`close()` 落盘、`HISTORY.md` 重建、`export()` |
| `tests/unit/history.test.ts` | 8 项 | 目录内容、时间线顺序与账本一致、一行一 mission（重复 close 不增行）、导出、空 mission |
| `tests/m4-missions-ui.py` | 225 | 观察台验收（Playwright，46 条断言，可重跑） |
| `docs/screenshots/m4-*.png` | 7 张 | 列表 / 详情 / 证据 / 报告 / 看板回归 / 390px 两个 |

**修改**

| 文件 | 改了什么 |
|---|---|
| `hub/core/paths.ts` | `historyFile`（`.mesh/HISTORY.md`） |
| `hub/core/fsx.ts` | `listFilesShallow()`（修 D30 的根因） |
| `hub/core/store.ts` | `listMissions()` 改用 shallow；新增 `boardEvents()` 读取 board 账本 |
| `hub/core/missions.ts` | `listSummaries()` / `detail()`（列表与详情视图，CLI 与观察台共用）；`write_report` 后自动 `close()`；`rejected_tasks`（D34） |
| `hub/core/hub.ts` | `history` 服务接线 |
| `hub/core/types.ts` · `schema.ts` · `schemas/mission.schema.json` | `MissionCard.rejected_tasks` + 校验 |
| `hub/web/server.ts` | `GET /api/missions`、`GET /api/missions/<id>` |
| `cli/mission.ts` | `mesh missions` / `mesh mission <id>` 改用新视图；新增 `mesh mission close`、`mesh mission export` |
| `web/{index.html,app.js,styles.css}` | 侧栏「任务单」、`#/missions` 与 `#/missions/<id>`、子路径路由（对其它视图无影响） |

### 2. `tsc --noEmit`

```
$ .\node_modules\.bin\tsc.cmd --noEmit -p tsconfig.json
(no output — 0 errors, exit 0)
```

### 3. `node --test`

```
ℹ tests 116
ℹ pass 116
ℹ fail 0
ℹ duration_ms 173126.4272
```

**116 = 107（M1–M3）+ 8（history）+ 1（M4 期间新增的 mission 回归）**。

### 4. 真跑证据

**a) 一个真实 mission 跑完后（`mesh mission close M-000001`）**

```
✔ M-000001 归档到 .mesh/missions/M-000001
  report.md
  timeline.md
  tasks.json
  context/T-000001.md
  context/T-000002.md
  context/T-000003.md
  全局索引：.mesh/HISTORY.md
```

`.mesh/HISTORY.md` —— **有且只有一行**：

```
| # | Mission | 标题 | Lead | 卡 | 轮次 | 耗时 | 状态 | 报告 |
|---|---|---|---|---|---|---|---|---|
| 1 | M-000001 | 做一个带登录的博客 | mesh-human | 3/3 | 1 | 1m 03s | completed | [报告](missions/M-000001/report.md) |

共 1 个 mission。
```

`report.md` 有内容（领写的交付报告）；`tasks.json`：3 张卡全 merged，reviews 各 1/1/2 条，
`context/` 三份上下文包副本。

**b) timeline 与 audit 对得上**（首 3 条与末 2 条，时间戳逐条吻合）

```
audit:   18:07:16 mission.created   →  timeline: | 18:07:16 | 创建 mission |
audit:   18:07:18 mission.lead_session → timeline: | 18:07:18 | 开 lead 会话 |
audit:   18:07:19 mission.planned   →  timeline: | 18:07:19 | 拆卡 |
audit:   18:08:25 mission.verdict   →  timeline: | 18:08:25 | 二次验收 |
audit:   18:08:26 mission.completed →  timeline: | 18:08:26 | 完成 |
```

（整轮重跑后 53 行，最后一行是「完成」；`归档` 行为 0 —— 见 D29。）

**c) CLI**

```
$ mesh missions
M-000001  completed  做一个带登录的博客  mesh-human  3/3  1  1m 09s  有

$ mesh mission export M-000001 --out .mesh-v2-m1\exported
✔ M-000001 导出到 ...（6 个文件）
  context/T-000001.md  context/T-000002.md  context/T-000003.md
  report.md  tasks.json  timeline.md
```

**d) 观察台**（`mesh serve --dir D:\AI\workspace\dsh\.mesh-v2-m1`）

`GET /api/missions` → `missions=1, M-000001 completed 3/3`；`GET /api/missions/M-000001` →
`timeline=53, tasks=3, files=[report.md,timeline.md,tasks.json]`。

我独立重跑了子 agent 的验收脚本：**46/46 通过，exit 0**。

```
"check": "列表：标题在正文", "ok": true
"check": "列表：进度 3/3", "ok": true
"check": "列表：轮次", "ok": true
"check": "列表：时长 humanised（1m 09s）", "ok": true
"check": "详情：标题在正文", "ok": true
"check": "详情：至少一条 evidence 出现", "ok": true
"check": "详情：逐条条款 POST /api/login 返回 200", "ok": true
"check": "详情：session 被翻成 scripted-02", "ok": true
"check": "详情：卡片链接到 #/board?task=T-000001", "ok": true
"check": "看板回归：#/board 仍渲染（.lane）", "ok": true
"check": "键盘：行可聚焦 + Enter 进详情", "ok": true
"check": "390px：主栏横向溢出 0", "ok": true
"check": "no console errors（除了故意触发的 404）", "ok": true
```

截图见 `docs/screenshots/m4-missions-list.png`、`m4-mission-detail.png`（1440×900）。

### 5. 没做到的（不粉饰）

**按指示未做**：M5（真实 3 agent e2e + `start_mission` 注入）。

**M4 内部的缺口**：

1. **证据在首屏之下**。1440×900 打开详情页，第一屏是封面 + 时间线开头；「每张卡的逐条 evidence」
   要滚。做了带条数的页内跳转（`02 卡片与证据 · 3 卡 · 6 条款`）补救，**没做** sticky 分节导航。
2. **`context/` 是按 task 存的，不是按会话**（D31）。一个任务换过三个会话，只有一份包。
3. **`export` 是复制目录**，没有 zip（零依赖，D32）。
4. **404 页的「重试」按钮只验证了渲染，没点过**。
5. **详情页搜索不覆盖证据正文**，只搜卡（id/标题/角色/人/验收）。
6. **mission 因 cancelled/blocked 结束时不会自动归档**，要手动 `mesh mission close`。
7. **`tasks.json` 是快照，不是"可回放"的完整事务日志**——它含卡的终态与审查全文，但不含每条消息。
8. **观察台的 mission 页没有实时刷新**（其它视图有 SSE 计数，但 mission 详情是打开时拉一次）。
9. **中文术语混用**：CLI 与文档说 "mission"，观察台侧栏叫「任务单」（为了不和顶部的"任务 3"打架）。

### 6. 这一轮顺手修的两个真 bug

- **D30**：`listFiles()` 递归导致历史包里的 `tasks.json` 被当成第二张 mission 卡 →
  HISTORY.md 出现两行、`advanceMissions` 用快照里的旧状态推进真实 mission。
- **D34**：M2 的"打回自动回队"把 mission 级打回的信号洗掉 → 针对性返工被当成整件事重拆
  （状态链 `rejected → planning` 而不是 `rejected → executing`）。观察台把状态链画出来才看见。
