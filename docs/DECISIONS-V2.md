# V2 决策日志（DECISIONS-V2）

> 规格书 §0 要求：任何与 V1 冲突的地方以 `V2-MISSION.md` 为准，并在这里记录理由。
> 读完 M1 之后发现的取舍也追加在这里。历史条目不改写，只追加。

## D1 · `rejected` 是正式状态，不是一条隐式回边

规格 §1.2 的状态图把「二次验收打回」画成 `final_review → integrating` 的一条回边。
M1 落地时改成：

```
final_review ──▶ rejected ──▶ executing（打回具体某张卡）
                             └▶ planning  （拆解本身有问题，整件事重来）
```

**理由：** 打回是用户最关心的一件事（"为什么没过、第几轮了"），如果它只是一条回边，
`rounds` 和"这一版是被谁否掉的"就只剩审计日志里有。做成正式状态后：
人能在 `mesh mission <id>` 里看见 `rejected · 轮次 1`；调度器每 tick 执行一次
`rejected → executing / planning`，所以它既可见、又会自动继续。M1 验收里这条链是被真跑出来的：
`final_review → rejected → executing → integrating → final_review → completed`。

## D2 · `plan_mission` 建的卡是 `draft`，`dispatch_mission` 才发布

规格 §1.2 说 `planning` 之后进 `executing`，§1.3 把 `plan_mission` 和 `dispatch_mission` 分成两个动作。
如果 `plan_mission` 直接让卡片 ready，那 `dispatch_mission` 就只是改一个状态字，还会在 lead
「先拆一半」时就把活放出去。

**理由：** 两个动作应该各自有后果。现在 `plan_mission` 只写卡（`draft`，依赖未满足的继续 waiting），
`dispatch_mission` 才把它们推到 `ready` 让调度器认领。`mesh mission "…" --dry-plan` 也因此有意义：
人可以先看拆解，再决定发不发。

## D3 · `write_report` 必须在 `final_review` 之后

规格 §1.2 的规则是「`final_review` 且 lead 写了 report → `completed`」。M1 把它实现成
**先 `final_verdict(approved)` 才能 `write_report`**，否则 `MESH_MISSION_STATE`。

**理由：** 如果报告能先写，lead 就可以绕过二次验收直接结项——那等于把"由谁宣布完成"（C1 的精神）
从二次验收手上拿回来。现在：验收通过 → `final_review` → 写报告 → `completed`，顺序不可倒。

## D4 · 合并前的"批准"必须对应当前这一次提交

`Board.approvedReview` 原来只取"该任务最近一条 approved 审查"。V2 引入返工循环后这成了个洞：
第二次验收打回 → 返工 → 重新 submit（新 commit）→ 旧审查仍然"批准"，于是新代码可以不经审查就合并。

**修法：** 只认 `submission_commit === task.submission.commit` 的审查记录。`mergeWithScopeGate`
一行都没有动——洞在它上游的准入判断里，不在终审里。

## D5 · `TaskCard` 追加 `preferred_agent`

规格 §1.3 的 `plan_mission.tasks[].agent` 是"可省略；省略则由调度器择优"。要让这个字段真的生效，
得有个地方存它。选择在 TaskCard 上追加 `preferred_agent: string | null`（可为空），
调度器 `pickAgent` 先看它，**但只在这名 agent 同时满足能力/并发/SoD 时**才优先。

**理由：** 换掉另一种做法（把 agent id 塞进 `tags` 或另建一张映射表）都会造出一个没有 schema、
没人校验的暗通道。宁可加一个字段。C7 不被覆盖：lead 的意愿不能越过职责分离。

## D6 · 无进程的 lead 会话不算"在跑"

`planning` 的自动推进条件是「lead 会话 exited」。人类 lead（`mesh-human`）通过
`mesh mission lead` 拿到的会话没有子进程，它会一直是 `active`——按字面读，"lead 没 exited"，
于是 mission 永远进不了 `executing`。

**修法：** `MissionService.leadIsRunning()` 要求"有 pid 且进程活着"。没有进程的会话是**署名句柄**
（它让人可以用 CLI 以 lead 身份动作），不是正在跑的一轮。这条也顺带修正了 `status` 里
"lead 会话在跑"的显示。

## D7 · lead 会话由 CLI 代签 hello

`mesh mission lead` 创建的会话没有进程，没有人会替它调用 `hello`。若不处理，
`plan-mission --session S-x` 会被 `MESH_SESSION_HELLO_REQUIRED` 拒绝。
M1 让 CLI 在建会话后**立即 hello**（这是"人在这里、我以这个身份签字"的等价物）。
真实 agent 的 lead 会话依然由 agent 自己 hello —— 双重注入没有变。

## D8 · `mission_id` 与 `msg_id` 共用 `M-` 前缀

规格 §1.1 规定 `mission_id: "M-000001"`；V1 的 `msg_id` 也是 `M-000001`。
M1 按规格实现，两者各自独立计数、各自独立目录（`.mesh/missions/` vs `.mesh/messages/`），
所以不会撞库，但人读日志时会看到两种 `M-xxxxxx`。

**理由：** 规格明确写了这个格式，改它才是违约；记录在此，供人决定要不要在 V2.1 换前缀（如 `MS-`）。

## D9 · `pickLead` 是过渡实现

规格 §1.4 的 `pickLead` 依赖 `quality_score`，那是 M2 的 `AgentProfile`。
M1 的规则：`config.mission_lead_agent`（人工指定）→ 非 builtin 优先 → `cost_tier` 小优先 →
`agent_id` 字典序（保证可复现）。M2 换成打分排序后，这条自动失效。

## D10 · 任务状态机加了 `merged → rejected` 一条边

V1 的 `merged` 是终态。V2 的二次验收要能打回一张**已合并**的卡，所以加一条边。
它不削弱 C1：打回不删除已合并的 commit，只是在账本上追加"这一版被否了"，
返工要重新走 submit → 独立审查 → scope 终审。

## D11 · 默认并发 4 → 16，新增三个 mission 配置

按规格 §6：`max_concurrent_sessions: 16`（"够用即可，不做硬限制叙事"）、
`reassign_after_rejections: 2`（M2 用）、`mission_max_depth: 3`、`mission_lead_agent: null`。
其余上限（任务数、轮次、agent 数）**没有**加任何默认限制。

## D12 · JSON 读写容忍 UTF-8 BOM

验收跑的时候被现实打了一巴掌：Windows PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，
`JSON.parse` 遇 BOM 直接抛错。M1 在 `fsx.ts` 的 JSON/JSONL 读取和 CLI 的 `--file` 解析里都剥掉 BOM。

**理由：** 这不只是测试脚本的问题——`.mesh/board/tasks/*.json` 是"文件即真相"，人手改一张卡
（记事本保存）就会带上 BOM，然后那张卡会被 `readJsonIfExists` 静默当成"不存在"。剥 BOM 是修 bug，
不是迁就环境。

## D13 · 验收跑带来的两个观察（未改，留给 M2/M4）

1. **合并失败会每 tick 重试**。验收时我让工作树变脏，`mergeTask` 每次都回
   `main working tree is not clean`，`mesh up` 每 3 秒打印一次。行为是对的（拒绝合并），
   但缺一个"连续失败 N 次就 blocked 上报"的上限。M2 处理 `rejection_count` 时顺手加。
2. **`plan.json` / `report.md` 不能放项目根**。它们会让工作树变脏，进而被合并终审拒绝。
   这是平台正确行为，但值得在 M4 的 `mesh mission export` 文档里写明"中间文件放 `.mesh/`"。

---

# M2 追加

## D14 · `specialtyMatch` 的具体定义（规格只说了"词面匹配"）

```
entries = strengths ∪ specialties
probes(entry) = 英文词（长度≥3）∪ 中文连续段（长度≥2）∪ 每个中文二字词
haystack = (任务标题 + 角色名，下划线换成空格).toLowerCase()
match = entries 中被任一 probe 命中的条目数 / entries 总数   （0..1）
```

**理由：** 不引向量、不引 LLM —— lead 必须能预测"这次会派给谁"。中文没有空格，
所以额外切二字词，让「后端接口」能命中「接口」。上限 1，权重只有 0.10，
所以它只在分数咬得很紧时才起作用。

## D15 · `rejected_by` 存的是"被否过的人"

§2.3 的候选排除句写的是「排除 `task.implementer_agent` 与所有 `rejected_by` 里出现过的人」，
所以数组里必须是**历史实现者**，而不是打回他的人。落地：`recordVerdict(rejected)` 时
把当前的 `implementer_agent` 追加进去（去重）。打回的人记在 `ReviewRecord.reviewer_agent` 里。

## D16 · `pickAgent(role, task, mission?)` 的 `mission` 参数不参与打分

规格给的签名有三个参数，但 §2.2 的公式里没有 mission 项。M2 接受该参数并留作决策记录
（谁被考虑过、为什么），**不**让它给"已在 mission 里的 agent"加权——那会让新 agent 永远
接不到活，而且没人能从公式里看出来。真要这么做应该在 V2.1 明写进公式。

## D17 · `--timeout` 的默认单位从毫秒改成秒

用户实测：`--timeout 300` 被当成 300ms，回合瞬间被杀。现在裸数字 = **秒**，
并支持后缀：`500ms` / `30s` / `5m` / `1h`。这是刻意的破坏性变更（此前没有任何脚本依赖它），
理由：一次性 CLI 的回合以秒计，"300" 这个数字在人类心里就是五分钟。

## D18 · 被审查打回的卡每 tick 自动回队

不这样做的话 `rejection_count` 永远到不了 2：打回后会话结束，卡停在 `rejected`，
没有任何东西会再派它，换人规则就永远不触发。现在的循环是：

```
rejected ──(下一个 tick)──▶ ready ──pickAgent──▶ 同一人（count < 2，重试）
                                             └▶ 换人（count ≥ 2，排除历史实现者）
```

`reassign_after_rejections` 是阈值不是"重试次数"：默认 2 意味着第 2 次打回之后才换人。

## D19 · 修掉一个 V1 就存在的返工 claim bug（M2 单测逼出来的）

`claimLocked` 里有两处问题，只有"同一个 agent 想去返工自己被否的卡"时才会同时暴露：

1. `claimed_by` 还指着上一轮的会话 → `CLAIM_CONFLICT`，谁也领不到；
2. `applyTransition(task, 'claimed')` 从 `rejected` 出发不是合法边（`TASK_TRANSITIONS.rejected`
   里只有 `in_progress`/`ready`/`blocked`/`cancelled`）。

修法：允许"自己的 rejected 卡"越过 `claimed_by` 检查，并按合法边进入 `in_progress`
（语义也对：这不是新领活，是继续干）。M2 的 reassign 单测第一次真正走到这条路径。

## D20 · `manual_locked` 的高分可以顶着 0% 成功率

验收跑里 `scripted-bad` 被打回 2 次（可靠性 0、成功率 0%），但手编的 `quality_score=99`
仍然保留，因此它仍可能被派到最好的活。这是规格的直译（`manual_locked=true` 时互评不覆盖），
也是"人来兜底"的意思——但同一个 `mesh profile list` 表里两列并排放着，
人一眼能看见"99 分 / 0%"。若以后想自动降级，得新增规则，不能偷偷改这一条。

## D21 · `stats` 的自动口径

- `tasks`：每次派发 +1（`spawnWorker`）
- `approved` / `rejected`：每次 `recordVerdict` 给实现者记一笔
- `rounds`：一阶打回 +1，mission 二次验收打回再加 1（`noteRound`）
- `missions`：首次作为某 mission 的参与者时 +1
- `reliability = round(100 × approved / (approved + rejected))`，没有判决时保持默认 70
  （不是 0——没干过活不等于不可靠）

所有统计写入都是 best-effort：写 profile 失败只往 stderr 打一行，绝不让裁决流程失败。

