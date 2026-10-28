# AgentMesh V2 · Mission 协作模型规格

> 本文是 V2 的唯一施工依据。V1 的八条宪法（C1–C8）全部继续有效，V2 只做**加法**，
> 任何与 V1 冲突的地方以本文为准，并在 `docs/DECISIONS-V2.md` 记录理由。

---

## 0. 用户原话（不可改写、逐条对应实现）

1. **谁收到任务谁主导。** 任务下发到 1 号 agent，它按各 agent 擅长的方面拆给 2/3/4/5/6 号；
   监督与验收交给**另一个**号；最后由 1 号整合并做**二次验收**；不通过打回原 agent 重改，
   **多次打回则改派给评分更强的 agent**；全部通过后由 1 号向用户整理报告。
   任务下发给 2 号，则 2 号主导整个过程。
2. **两个入口。** 用户可以在平台上发任务，也可以在各 agent 的对话里发任务；
   只有用户**明确要求使用本平台**时，才走多 agent 协作流程。
3. **评分系统。** 每个 agent 接入后都有一份多维标注：性格特点、擅长方向、能力范围、弱势方面、
   独特细节、任务质量、花费等。用户可手动编辑；agent 之间也会在任务过程中互相评判。
4. **协作史。** 平台要干净、简洁、明显地整理并保存每一次协作的历史。
5. **上下文注入。** 每次协作都要把平台使用信息与协作队友信息注入 agent 上下文，
   否则它不知道自己是谁、在干什么、有哪些队友。
6. **无限制。** 不设额度、轮次、并发、路径的人为上限（可配置，但默认不卡）。

---

## 1. 核心概念：Mission

V1 只有 `TaskCard`（原子任务）+ 固定 `coordinator` 角色。V2 引入两级：

```
Mission（用户下发的一件事，有 lead，有验收标准，有报告）
  └─ TaskCard × N（lead 拆出来的活，每张一个角色、一个 scope、一组验收标准）
        └─ Review × 1（由非实现者的另一个 agent 做）
```

**Lead 不是全局角色，是 mission 的属性。** 谁收到任务谁当 lead，换 mission 换 lead，互不影响。

### 1.1 MissionCard

`.mesh/missions/<mission_id>.json`

```jsonc
{
  "mission_id": "M-000001",
  "title": "做一个带登录的博客",
  "brief": "用户原话，一字不改",
  "acceptance": ["登录可用", "文章可增删改查"],   // mission 级验收标准，可空
  "lead_agent": "dsh-01",
  "lead_session": "S-000010",
  "status": "intake",
  "tasks": ["T-000010", "T-000011"],
  "teammates": ["dsh-01", "hermes-01"],          // 实际参与过的 agent，按首次参与排序
  "plan": [                                       // lead 的拆解说明，供人看
    { "task_id": "T-000010", "role": "backend_dev", "why": "接口层，dsh 强" }
  ],
  "report": null,                                 // lead 写的最终报告（markdown）
  "report_at": null,
  "rounds": 0,                                    // 二次验收被打回的次数
  "created_at": "...",
  "updated_at": "...",
  "history": [{ "at": "...", "from": null, "to": "intake", "by": "mesh-human", "note": "..." }]
}
```

### 1.2 Mission 状态机

`hub/core/stateMachine.ts` 增加 `MISSION_TRANSITIONS`，与任务状态机同一套写法（唯一白名单）。

```
intake ──▶ planning ──▶ executing ──▶ integrating ──▶ final_review ──▶ completed
                ▲                          ▲              │
                │                          └──────────────┘  (rejected: 打回改，rounds+1)
                └──────────────────────────────────────────┘  (replan: 拆解本身有问题)
任意 ──▶ blocked（人工仲裁）  /  任意 ──▶ cancelled
```

- `intake`：已登记，等 lead 开会话。
- `planning`：lead 会话在跑，正在拆卡。**此状态下 lead 可以 create_task / assign。**
- `executing`：子任务在跑（含各自的 review/merge 子循环）。lead 会话可退出。
- `integrating`：所有子任务 merged，lead 会话被重新拉起做整合。
- `final_review`：lead 对整件事做二次验收。
- `completed`：report 已写，任务归档。
- `rejected`：二次验收不通过 → 打回。打回目标可以是某张卡（`rejected → ready`）或整件事（`→ planning`）。
- `blocked`：需要人。

**自动推进规则（调度器每 tick 执行）：**
- `planning` 且 mission.tasks 非空 且 lead 会话 exited → `executing`
- `executing` 且所有 tasks 都 `merged`/`cancelled` → `integrating` 并拉起 lead 会话做整合
- `final_review` 且 lead 写了 report → `completed`

### 1.3 Lead 的能力

Lead 会话拥有 mission 作用域内的**下单、派发、裁决、合并、报告**权限。
实现方式：`SessionCard` 增加 `mission: string | null` 与 `is_lead: boolean`，
`IdentityService` 增加 `requireLead(sessionId, missionId)`。
权限判定顺序：**先看 is_lead + mission 匹配，再看 role**。

新增 API（`hub/core/api.ts`，同步暴露为 MCP 工具）：

| 工具 | 谁可调 | 作用 |
|---|---|---|
| `create_mission(title, brief, acceptance?, lead_agent?)` | plan 角色 / 人类 / lead（嵌套子 mission） | 建 mission |
| `get_mission(mission_id)` | 任何已 hello 的会话 | 读 mission + 子任务状态汇总 |
| `plan_mission(mission_id, tasks[])` | **仅该 mission 的 lead** | 一次拆多张卡，原子写入；每项含 role/scope/acceptance/depends_on/agent? |
| `dispatch_mission(mission_id)` | **仅 lead** | planning → executing，让调度器开始派活 |
| `final_verdict(mission_id, approved, notes, rejects?)` | **仅 lead** | 二次验收；rejects 指明要打回的卡 |
| `write_report(mission_id, markdown)` | **仅 lead** | 写报告；随后 mission → completed |
| `rate_peer(agent_id, scores, comment)` | 同一 mission 内的参与者 | 互评 |

`plan_mission.tasks[]` 的每一项：
```jsonc
{
  "title": "实现 /api/auth/login",
  "role": "backend_dev",
  "scope": { "write": ["src/server/auth/**"], "read": ["docs/specs/**"] },
  "acceptance": ["POST 返回 200 和 token", "错误密码返回 401"],
  "depends_on": ["T-000010"],     // 可省略；省略时按数组顺序串行
  "agent": "hermes-01"            // 可省略；省略则由调度器按评分择优
}
```

**Lead 写代码是不允许的**（C4 的延伸：职责不是能力）：lead 会话的 role 是 `lead`，
`can_write_code=false`、`can_implement=false`、`can_review=true`、`can_merge=true`。
需要改代码就打回重改或新开卡 —— 这正是用户要的「整合之后再验收」。

### 1.4 谁当 lead

- 平台入口：`mesh mission "…" [--lead <agent_id>]`。省略时按 `pickLead()` 选：
  `enabled && capabilities.includes('lead') && quality_score 最高 && cost_tier 最低（同分时）`。
- 对话入口：agent 自己调用 `create_mission(..., lead_agent=self)` —— **它收到任务，它主导**。

`lead` 是新的 RoleId，追加到 `ROLE_IDS` 末尾（不要插中间，避免破坏既有索引/快照顺序），
并默认加到每个 AgentCard 的 `capabilities` 里（`mesh init` / `mesh agents add` 都加）。

---

## 2. 评分系统

### 2.1 AgentProfile

`.mesh/profiles/<agent_id>.json`，与 AgentCard 分离（AgentCard 是启动配方，Profile 是评价）。

```jsonc
{
  "agent_id": "dsh-01",
  "personality": "沉稳、偏工程化、倾向先读契约再动手；被质疑时会补证据",
  "strengths": ["TypeScript 架构设计", "协议与契约编写", "跨文件重构"],
  "weaknesses": ["前端视觉审美一般", "长任务容易过度设计"],
  "capability_notes": "能独立完成 10 个角色中的任意一个；不擅长视觉设计",
  "specialties": ["会先跑等价验证再宣称完成", "习惯给 diff 级证据"],
  "quality_score": 82,          // 0-100，综合任务质量
  "cost_tier": 2,               // 1 便宜 2 中 3 贵；与 AgentCard 同步
  "reliability": 88,            // 0-100，成功率，自动统计
  "speed_notes": "单卡 3-5 分钟；比 hermes 快约 3 倍",
  "manual_locked": false,       // 用户手编后置 true，互评不再覆盖 quality_score
  "peer_reviews": [
    {
      "by_agent": "hermes-01", "mission_id": "M-000001", "task_id": "T-000012",
      "scores": { "quality": 90, "cooperation": 85, "evidence": 95, "speed": 70 },
      "comment": "证据给得扎实，验收标准逐条对应；但回复偏长",
      "at": "..."
    }
  ],
  "stats": { "missions": 3, "tasks": 11, "approved": 9, "rejected": 2, "rounds": 4 },
  "updated_at": "..."
}
```

**字段口径（必须一致，写进 `mesh profile show` 的表头）：**
性格 / 擅长 / 弱势 / 能力范围 / 独特细节 / 质量分 / 花费 / 可靠性 / 速度。

### 2.2 评分如何影响调度

`Scheduler.pickAgent(role, task, mission?)` 改为**打分排序**（V1 是按 cost_tier + 负载）：

```
score = 0.55 * quality/100
      + 0.20 * (1 - (cost_tier - 1) / 2)        // 便宜加分
      + 0.15 * reliability/100
      + 0.10 * specialtyMatch(task, profile)     // strengths/specialties 与任务标题/角色的词面匹配
      - loadPenalty(agent)                       // 已跑会话数 × 0.05
```

- `manual_locked=true` 的 profile，`quality_score` 用人工值，互评不覆盖。
- 没有 profile 的 agent 用默认值 `quality=60, reliability=70`。
- 排序稳定：分数相同按 agent_id 字典序，保证可复现（测试要断言这一点）。

### 2.3 打回换人（用户要求 1 的硬指标）

`TaskCard` 增加 `rejection_count: number` 与 `rejected_by: string[]`。
`recordVerdict(rejected)` 时 +1。

`pickAgent` 在 `rejection_count >= config.reassign_after_rejections`（默认 **2**）时：
1. 候选集**排除**该任务历史实现者（`task.implementer_agent` 与所有 `rejected_by` 里出现过的人）；
2. 剩余候选按 score 降序取第一；
3. 若剩余候选为空 → 任务进 `blocked`，原因是「需要更强或更多的 agent」，绝不悄悄重派同一个人。

这条必须有单测：`tests/unit/reassign.test.ts`。

### 2.4 互评的边界（防刷分）

- 只有**同一 mission 内实际参与过**（有 task 或 review 记录）的 agent 才能评；
- 不能评自己；
- 每对 (by_agent, agent_id, mission_id) 只能评一次，覆盖式更新；
- `scores` 每项 0-100，越界拒绝；
- 互评对 `quality_score` 的影响是**加权移动平均**：`new = round(0.7*old + 0.3*avg_peer)`，
  且 `avg_peer` 至少 1 条才生效。

---

## 3. 上下文注入（用户要求 5）

`hub/core/context.ts` 的上下文包在 `standard` 与 `full` 档增加两节，`minimal` 只加第一节的紧凑版：

### 3.1 平台与队友（每个会话必注入）

```markdown
## 你在哪
- Mission：M-000001「做一个带登录的博客」（你是第 2/4 个执行者）
- Lead：dsh-01 —— 它拆的任务，最后由它整合、二次验收并给用户报告
- 你这一环：T-000012「实现 /api/auth/login」，角色 backend_dev
- 完成定义：你 submit → 一个独立审查者通过 → 平台 scope 终审合并

## 队友（本次协作，按参与顺序）
| agent | 性格 | 擅长 | 弱势 | 质量分 | 花费 | 本轮负责 |
|---|---|---|---|---|---|---|
| dsh-01 | 沉稳工程化 | 架构、契约 | 视觉一般 | 82 | 2 | M-000001 lead / T-000010 |
| hermes-01 | 严谨啰嗦 | 审查、文档 | 启动慢 | 76 | 3 | T-000010 审查 |
| codex-01 | 快、直接 | 单文件实现 | 不看全局 | 70 | 1 | T-000011 |

> 不了解队友时，用 `hub.list_teammates(mission_id)` 查全量；不要猜。
```

### 3.2 平台使用信息

```markdown
## 这个平台怎么用（速查）
- 你现在在一个 P-Session：cwd 是任务沙箱，身份是 S-xxxxxx，角色是 <role>。
- 领活 `hub.claim_task(task_id)`；交付 `git commit` + `hub.submit(task_id, summary)`。
- 只写 scope.write 内的路径；越界会在合并终审被整单打回。
- 有疑问 `hub.request_clarification`；要越界 `hub.escalate`（不中断你）。
- 你是 lead 时额外可用：`plan_mission` / `dispatch_mission` / `final_verdict` / `write_report`。
```

新增工具 `list_teammates(mission_id)` → 返回上表的结构化版本。

**验收方法**：真实跑一次，从 `session.v4.jsonl.zstd` 里确认注入块存在（不是看 agent 的回答）。

---

## 4. 协作史（用户要求 4）

### 4.1 落盘结构

```
.mesh/missions/
  M-000001.json                  # MissionCard
  M-000001/
    report.md                    # lead 写的最终报告
    timeline.md                  # 自动生成：每一张卡的 claim/submit/review/merge + 每条消息
    tasks.json                   # 该 mission 所有卡的终态快照（含 reviews 全文）
    context/                     # 各会话的上下文包副本（留证）
.mesh/HISTORY.md                 # 全局索引：一行一个 mission
```

`mesh mission close <id>`（或 `write_report` 后自动）生成上述目录。
**`HISTORY.md` 是给人看的第一入口**：mission_id、标题、lead、卡数、轮次、耗时、状态、报告链接。

### 4.2 CLI

```
mesh missions [--status completed]     # 列表：id/标题/lead/卡数/轮次/状态
mesh mission <id>                      # 详情：计划、卡状态、审查、报告
mesh mission report <id>               # 打印 report.md
mesh mission export <id> [--out path]  # 导出整包（md + json）
```

### 4.3 观察台

`mesh serve` 增加 `/#/missions` 与 `/#/missions/<id>`：
- 列表：标题、lead、状态、卡进度条（merged/total）、轮次
- 详情：时间线（谁在什么时候干了什么）、每张卡的审查逐条 evidence、最终报告

保持零构建、零依赖、只读。前端不新增框架。

---

## 5. 两个入口（用户要求 2）

### 5.1 平台入口

```bash
mesh mission "做一个带登录的博客"                 # 自动选 lead
mesh mission "…" --lead hermes-01                # 指定 lead
mesh mission "…" --accept "登录可用" --accept "能发文章"
mesh mission "…" --dry-plan                      # 只让 lead 拆解，不派活（人先看）
```

### 5.2 对话入口（关键：只在用户明确要求时触发）

每个 agent 的接入侧加一条**指令文本**，而不是改平台逻辑：

- MCP 工具名 `start_mission(title, brief, acceptance?)`，内部 = `create_mission` + `dispatch`，
  `lead_agent` 自动取调用者自己。
- 注入到每个 agent 的**全局指令**里（Hermes：skill；DSH：`~/.dsh/AGENTS.md` 追加段；
  Claude Code：`CLAUDE.md` 段；Codex：`AGENTS.md` 段）：

```markdown
## 什么时候用 AgentMesh
只有当用户**明确说**「用 AgentMesh / 用多 agent 协作平台 / 走协作流程」时才用。
判断依据是用户的话，不是任务大小。用户没说，就按你平时的方式自己做，不要起 mission。

用户明确要求时：调用 `start_mission(title, brief, acceptance)`，然后结束这一轮。
你是 lead：拆解、派活、整合、二次验收、写报告都由你在后续被拉起的会话里完成。
```

- **平台侧不猜**：`create_mission` 有一个 `source: "platform" | "chat"` 字段，只记录来源，不做拦截。

### 5.3 首个里程碑必须能跑通这条真实链路

`mesh mission "…"` → lead 会话被拉起 → 它 `plan_mission` 拆卡 → 调度器派给 2/3 号 →
独立审查 → 合并 → lead 被重新拉起整合 → `final_verdict` → `write_report` → 观察台可看。

---

## 6. 无限制（用户要求 6）

默认配置（`hub/core/config.ts`）**不设人为上限**：

| 项 | V1 默认 | V2 默认 |
|---|---|---|
| `max_concurrent_sessions` | 4 | 16（够用即可，不做硬限制叙事） |
| `reassign_after_rejections` | — | 2（这是需求，不是限制） |
| mission 轮次上限 | — | 无（只记录 rounds） |
| 单 mission 卡数上限 | — | 无 |
| 嵌套 mission 深度 | — | 3（防无限递归，可配 0=不限） |
| agent 数量 | — | 无 |

唯一保留的硬约束仍然只有一条：**scope 终审**。那不是限制，是账本正确性。

---

## 7. 施工顺序与验收

每个里程碑必须：`npx tsc --noEmit` 零错误、`node --test` 全绿、**真跑一次**并把证据写进
`docs/ACCEPTANCE-V2.md`。不许只写文档就宣称完成。

### M1 · Mission 内核
- `MissionCard` 类型 + schema + store 读写 + 状态机 + history
- `lead` 角色卡 + `is_lead` / `mission` 字段 + `requireLead`
- `plan_mission` / `get_mission` / `dispatch_mission` / `write_report` / `final_verdict`
- CLI：`mesh mission` / `mesh missions` / `mesh mission <id>`
- 调度器自动推进（planning→executing→integrating→final_review→completed）
- **验收**：不依赖任何真实 agent，用 `mesh-human` 手工走完一个 3 卡 mission，全部状态跃迁正确

### M2 · 评分与换人
- `AgentProfile` + schema + store + 手编 CLI（`mesh profile get/set/list`）
- `rate_peer` + 防刷边界 + 加权移动平均
- `pickAgent` 打分排序 + `specialtyMatch` + `manual_locked`
- 打回换人（`reassign_after_rejections`）+ `rejection_count`
- **验收**：`tests/unit/scoring.test.ts`（打分可复现）、`tests/unit/reassign.test.ts`（换人必换），
  且 `mesh profile set` 能手编并影响下一次派发

### M3 · 上下文注入
- context.ts 两节（平台/队友）+ `list_teammates`
- 三档（minimal/standard/full）都要有，注入内容随 mission 变化
- **验收**：真实 spawn 一次，从会话文件里 grep 到「## 队友」与 lead 名字

### M4 · 协作史
- `.mesh/missions/<id>/` 落盘 + `HISTORY.md` + export
- 观察台 missions 列表/详情（零依赖，只读）
- **验收**：一个真实 mission 结束后，`HISTORY.md` 一行、report.md 有内容、观察台能点开

### M5 · 真实端到端
- 三个及以上 agent（dsh-01 + hermes-01 + 至少一个）真实参与
- 构造一次**打回**（验收标准故意写严，让第一版不过）→ 验证打回重改 → 再打回 → 换人
- lead 整合 → 二次验收 → 报告 → 观察台与 HISTORY.md 可查
- **验收**：`docs/ACCEPTANCE-V2.md` 贴出真实命令、真实时间戳、真实 commit、真实报告

---

## 8. 不许破坏的东西

- C1–C8 全部不变。特别是 **scope 终审**、**SoD 独立审查**、**detect-only 审计**。
- `mergeWithScopeGate` 一行都不要动。V2 的所有能力都建在它之上，不是替代它。
- 现有 55 个测试必须继续全绿（`adapters.test.ts` 里那个 `DSH_HOME` 断言改成 mock，
  它是环境隐式依赖，不是行为契约 —— 修测试，不是改实现）。
- 零运行时依赖保持不变。不引入任何框架、ORM、状态库。

---

## 9. 交互契约（给我看的东西）

每完成一个里程碑，回报里必须包含：

1. 改了哪些文件（路径 + 一句话作用）
2. `npx tsc --noEmit` 的真实输出（尾部 10 行）
3. `node --test` 的真实统计（tests/pass/fail）
4. 真跑的证据：命令、时间戳、关键输出
5. 没做到的，单列一节，不要粉饰

写完 M1 就停下来等我验收，不要一口气做到 M5。
