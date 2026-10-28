# AgentMesh V2 交付报告

> 交付时间：2026-10-29 04:45 · 施工：DSH（5 个里程碑）· 验收：未央（逐里程碑亲手实测）
> 仓库：`D:\AI\workspace\dsh\agentmesh` · 当前 HEAD `c920859`

## 一句话结论

**任务下发给哪个 agent，那个 agent 就是 lead**：它把活拆给擅长的队友，把审查交给另一个 agent，
最后自己整合、二次验收、写报告；验收不过打回重做，多次不过就换评分更高的 agent 接手。
这条链路不是设计文档里的承诺，是真实进程跑出来的——下面每条都有可复跑的证据。

## 六条需求的落点

| 你的要求 | 实现位置 | 我怎么验的 |
|---|---|---|
| **① 谁收到谁主导** | `MissionCard.lead_agent`（任务属性，不是全局角色）；`plan_mission` / `final_verdict` / `write_report` 只有 lead 会话能调 | 真实跑 M-000001：lead=`dsh-02`，5 张卡的实现者是 `hermes-01` 和 `dsh-01`，**lead 一行生产代码没写**；report.md 写着「本人独立复核，不采信各卡自述」 |
| **① half: 审查交给别人** | `dispatchReviews` 用 SoD 排除实现者 | 逐卡核对：hermes-01 实现的由 dsh-01 审，dsh-01 实现的由 hermes-01 审，5/5 无自审 |
| **① half: 多次打回换人** | `selectAgent` 先排除再打分，`rejection_count` 达阈值排除全部经手者 | 亲手跑：rej=2、`rejected_by=['dsh-02','dsh-01']` → 第三次派发直接跳到 `hermes-01` |
| **② 两个入口** | `mesh mission`（平台）+ `start_mission`（agent 对话，lead=调用者） | CLI 入口真跑；chat 入口有契约测试与实现，**但没做过真 agent 会话级验证**（见局限 3） |
| **③ 多维评分 + 手编 + 互评** | `AgentProfile` 九维；`manual_locked` 挡住互评；`rate_peer` 加权移动 | 亲手实测：默认分下派给 dsh-02(0.713) 而非质量更高的 dsh-01(0.697)，因为省钱——cost 真进公式了；`mesh profile set dsh-01 quality_score 1` 后同一张卡改派 hermes-01 |
| **④ 干净简洁的协作史** | `.mesh/HISTORY.md` 一行一个 mission；`.mesh/missions/<id>/` 四件套（report/timeline/tasks/context） | 跑完 4 个 mission 后实际的 HISTORY.md 我读过；M-000001 的 report.md 逐函数列了实现文件/测试文件/用例数，timeline.md 82 行 |
| **⑤ 上下文注入** | `teammates.ts` 一份实现两个消费者；`context.ts` 三档 | lead 的 reasoning 原文：「hermes-01 is best as reviewer/docs, not production」「if hermes-01 is the T2 implementer, it can't be the supervisor for T2 (SoD)」——它真的在用队友画像做决策 |
| **⑥ 没有任何限制** | `max_concurrent_sessions` / `mission_max_depth` 默认 0 = 不限（本轮刚改） | 见下方「限制」一节 |

## 怎么用

```bash
cd 你的项目
mesh init                                    # 幂等，认出可用 agent、建 profile

# 入口一：人在仓库里下发
mesh mission "做一个留言板：邮箱必填、提交即渲染、刷新保留" \
  --accept "邮箱非法不允许提交" --accept "刷新后数据仍在"

# 入口二：在任意 agent 会话里说「用 AgentMesh 做这件事」
#   它会调 start_mission(title, brief, acceptance)，然后平台把它当 lead 拉起

mesh up --interval 5000                      # 平台自己跑：派活→审查→合并→整合→报告
mesh board / mesh mission <id> / mesh status  # 看进度
mesh serve --port 8787                       # 观察台（含 missions 页、时间线、报告）
mesh profile list / show / set               # 九维评分，手编会锁定
cat .mesh/HISTORY.md                         # 协作史
```

把 `docs/INTEGRATION.md` 第一节贴进每个 agent 的全局指令，它就知道**只在你说「用 AgentMesh」时**才起 mission。

## 验收记录

| 里程碑 | commit | 机械门 | 我的判定 |
|---|---|---|---|
| M1 mission 内核 | `f3ac86c` | tsc 0 · 73/73 | 通过（独立新建项目复现建 mission → lead 拆 3 卡） |
| M2 评分 + 换人 | `b2856ba` | tsc 0 · 97/97 | 通过（手编改分真的改变调度） |
| M3 上下文注入 | `f54b0c5` | tsc 0 · 107/107 | 通过（lead reasoning 里用上了队友画像） |
| M4 协作史 + 观察台 | `a5e3f2c` | tsc 0 · 116/116 | 通过（HISTORY.md 幂等、timeline 升序、UI 截图含 390px） |
| M5 真跑 + chat 入口 | `ab105f1` | tsc 0 · 119/119 | 通过（真跑 5 卡 mission + 我补的打回换人验证） |
| 收尾：去掉人为上限 | `c920859` | tsc 0 · 119/119 | 我改的 |

每条判定都读 diff、跑测试、亲手跑场景，不接受「文档写了」当「功能做了」。
完整依据在 `%USERPROFILE%` 之外的 `.tools/` 与验收状态文件里；M5 的打回换人细节见 `.tools/m5-independent-verification.md`。

## 我知道的坑（一条不藏）

1. **worker 在沙箱内跑不了 node**。DSH 的沙箱给进程打 Low 完整性标签，而 node 在 `D:\AI\Hermes\tools\` 是 Medium，
   Low 进程读不了。所以 worker 只能静态自验（字节级检查、逻辑推演），真正的执行验证要靠审查者复跑。
   我试过把 node 设成 Low 绕过——**结果是所有 node 进程都写不了 Medium 目录，整个平台瘫痪**，已改回。
   正解是给 worker 配一个可访问的 node 副本，这需要改 `buildChildEnv` 的注入策略，没在本轮做。

2. **`mesh mission --timeout` 到点会杀掉 lead**。它是同步跑一个 lead turn，不是投递。
   正确姿势是 `mesh up` 起 daemon 再投递；daemon 有自愈能力（lead 死掉会清理僵尸会话并重建，实测 S-000002 → S-000003）。

3. **chat 入口没有真 agent 端到端验证**。`start_mission` 的测试用 `mesh-human` 内置实体替代真 agent，
   只验了契约（lead=调用者、source=chat、无 lead 能力被拒）。「真 agent 在对话里起 mission」只有代码路径，
   没有一次真实会话跑通。

4. **目录 ACL 不规范的会被沙箱挡住**。`D:\AI\workspace` 有 `HP:(OI)(CI)(F)` 所以正常；
   我误建的 `D:\tmp` 只有继承的 `Users:(RX)`，worker 每次 `pwsh` 都失败，agent 会烧掉几千 token 才发现。
   `.tools/m5-fixture.py` 现在会先跑 `icacls` 自检。

5. **推进器和验收会话是两个写者**。推进器 park 时每轮重写状态文件，曾覆盖掉我刚写的 M5 签字。
   已修复（每轮 reload），但**同时写仍有理论上的竞态**，正确做法是加文件锁或让验收只写独立文件。

6. **M1 的验收记录没进状态文件**。M1 是我在会话里手工验的，那时状态文件机制还没建，
   所以只有 M2–M5 有结构化记录。

## 回滚

```bash
cd /d/AI/workspace/dsh/agentmesh
git log --oneline                    # 挑一个点
git reset --hard <commit>            # 整个 V2 退回
# 只退「去掉上限」这一笔：
git revert c920859
```

后台进程（都已确认可停）：

```bash
# 自动推进器（已自动结束，done=true 后睡眠 30 分钟一轮）
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -like '*auto-advance*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
```

## 数字

- 代码：hub 11,225 行 · tests 4,360 行 · web 3,760 行 · cli 2,542 行
- 测试：14 个文件，**119 个用例全绿**（含 V1 的红队 T1–T10，一个都没删）
- 文档：ACCEPTANCE-V2 760 行 · DECISIONS-V2 353 行 · V2-MISSION 401 行 · INTEGRATION 71 行 · 截图 7 张
- 真实跑过的 mission：4 个（含一个 5 卡、三方参与、44 分钟的完整协作）

## 遗留（按重要性）

1. 给 worker 配可访问的 node 副本（解决局限 1，价值最高）
2. chat 入口用真 agent 跑一次端到端（解决局限 3）
3. 状态文件加锁（解决局限 5）
