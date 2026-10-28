# V2 验收报告

> 依据 `docs/V2-MISSION.md` §7/§9。每个里程碑：`tsc --noEmit` 零错误、`node --test` 全绿、
> **真跑一次**。本轮只做 **M1**，M2–M5 未动（按指示停下等验收）。

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
