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
