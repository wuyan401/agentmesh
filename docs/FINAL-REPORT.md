# AgentMesh V2 交付报告

> 交付时间：2026-10-29 04:45 · 补课时间：2026-10-29 18:00–18:30 · 施工：DSH（5 个里程碑）· 验收：未央（逐里程碑亲手实测）
> 仓库：`<PROJECT>`

## 一句话结论

**任务下发给哪个 agent，那个 agent 就是 lead**：它把活拆给擅长的队友，把审查交给另一个 agent，
最后自己整合、二次验收、写报告；验收不过打回重做，多次不过就换评分更高的 agent 接手。
这条链路不是设计文档里的承诺，是真实进程跑出来的——下面每条都有可复跑的证据。
三项遗留（worker 跑 node、chat 入口真 agent、状态文件加锁）已在 18:00 后补完并实测，见「补课记录」。

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

1. **worker 在沙箱内跑不了 node**（**已修复，见「补课记录 1」**）。DSH 的沙箱给进程打 Low 完整性标签，而 node 在 `<HERMES_HOME>\tools\` 是 Medium，
   所以 worker 只能静态自验。给 worker 配了 Low 的独立副本 + PATH 优先注入，实测 worker/审查者/lead 三个会话都能 `node --version`。
   **不要再对 Hermes 那份 node.exe 做降级**：那会让整机 node 都写不了 Medium 目录。

2. **`mesh mission --timeout` 到点会杀掉 lead**。它是同步跑一个 lead turn，不是投递。
   正确姿势是 `mesh up` 起 daemon 再投递；daemon 有自愈能力（lead 死掉会清理僵尸会话并重建，实测 S-000002 → S-000003）。

3. **chat 入口没有真 agent 端到端验证**（**已修复，见「补课记录 2」**）。`start_mission` 的测试用 `mesh-human` 内置实体替代真 agent，
   只验了契约（lead=调用者、source=chat、无 lead 能力被拒）。现在有一个真 dsh-01 coordinator 会话在对话里调 it，
   audit 里能看到 `mission.created(source=chat)` / `session.spawned` / `mission.planned`。
   补充：`mesh talk` 在**非 tty 的 stdio** 下会让 DSH 直接退出（打印 `stdin is not a tty`），要在交互 shell 或可写日志的前提下用。

4. **目录 ACL 不规范的会被沙箱挡住**。`<WORKSPACE>` 有 `HP:(OI)(CI)(F)` 所以正常；
   我误建的 `D:\tmp` 只有继承的 `Users:(RX)`，worker 每次 `pwsh` 都失败，agent 会烧掉几千 token 才发现。
   `.tools/m5-fixture.py` 现在会先跑 `icacls` 自检。

5. **推进器和验收会话是两个写者**（**已修复，见「补课记录 3」**）。推进器 park 时每轮重写状态文件，曾覆盖掉我刚写的 M5 签字。
   现在两个写者都走 `.tools/state_store.py`：OS 级锁 + 锁内读 + 合并写，压测 160/160 无丢更新。

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

18:00 补课的三项，各自怎么退：

```bash
# 1) worker 的 node 副本：删掉目录即可，代码会自动回退到 Hermes 自己的 node（workerNodeDir 有回退分支）
rm -rf "<WORKSPACE>/.tools/node"

# 3) 状态文件：加锁只在 .tools（不入版本库的验收工具链），回退只需还原写入方
#    auto-advance.py 的旧实现见 git 之外的历史；当前损坏件与还原件在：
#    <HERMES_HOME>\cache\agentmesh-v2\state.json.damaged-20261029-1815.bak
```

后台进程（都已确认可停）：

```bash
# 自动推进器（已自动结束，done=true 后睡眠 30 分钟一轮）
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -like '*auto-advance*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
```

## 数字

- 代码：hub 11,225 行 · tests 4,360 行 · web 3,760 行 · cli 2,542 行（18:00 后 hub 只加了 `workerNodeDir` 与 PATH 注入）
- 测试：14 个文件，**120 个用例全绿**（M5 时的 119 个 + 新增 1 条 PATH 注入用例；V1 红队 T1–T10 一个都没删）
- 文档：ACCEPTANCE-V2 760 行 · DECISIONS-V2 353 行 · V2-MISSION 401 行 · INTEGRATION 71 行 · 截图 7 张
- 真实跑过的 mission：6 个（V2 期间 4 个 + 本轮补课的 2 个：M-000001 node 版本、M-000002 对话入口）

## 遗留（按重要性）

> 2026-10-29 18:00 起的补课：三项全部做完并实测通过。证据在下文「补课记录」。

1. ✅ 给 worker 配可访问的 node 副本（解决局限 1，价值最高）
2. ✅ chat 入口用真 agent 跑一次端到端（解决局限 3）
3. ✅ 状态文件加锁（解决局限 5）

## 补课记录（2026-10-29 18:00–18:30）

### 1. worker 能跑 node 了

**根因**：DSH 沙箱把 worker 进程打到 Low 完整性，而 Hermes 自己的 `node.exe` 在 Medium。
给那个文件本身降级会把整机 node 拖下水（已踩过一次：`EPERM ... .mesh-human.json.tmp`）。

**做法**：给 worker 一份**自己的**副本，Hermes 用自己那份不受影响。

```bash
cp "<HERMES_HOME>/tools/node-26.7.0-win32-x64/node.exe" "<WORKSPACE>/.tools/node/node.exe"
icacls "<WORKSPACE>\.tools\node\node.exe" /setintegritylevel L
# 副本：Mandatory Label\Low Mandatory Level:(NW)，实测 v26.7.0
```

代码：`hub/adapters/types.ts` 新增 `workerNodeDir()`（顺序：`MESH_WORKER_NODE_DIR` → 本机副本 →
`process.execPath` 所在目录，副本不存在时自动回退，所以换机器不会挂），`buildChildEnv` 把该目录
放在 PATH 最前面、Hermes 的 node 目录作为兜底，并去重。`adapters/index.ts` 导出该函数。

**实测**（`<WORKSPACE>\_m6proj`，真 mission 不是 fixture）：

| 环节 | 会话 | 事实 |
|---|---|---|
| lead 拆解 | S-000002 dsh-01 | 拆 1 张卡 T-000001（「该 mission 只有一个产物」）|
| 实现 | S-000003 dsh-02 | 在沙箱里 `node --version` → `v26.7.0`，写入 `node-version.txt` |
| 审查 | S-000004 dsh-01 | 独立复跑，日志原文：「本机 `node` 路径 `<WORKSPACE>\.tools\node\node.exe`，`node --version` → `v26.7.0`」|
| 整合终审 | S-000006 dsh-01 | 再复跑一次，同样得到 `.tools\node\node.exe` / `v26.7.0` / exit 0 |
| 结果 | M-000001 completed | 3m36s，合并 `fd7d2f81`，`node-version.txt` = `v26.7.0`（8 字节，index 里是 LF）|

**判据达成**：worker 侧真实执行并落盘 `v26.7.0`，两个独立会话共用同一份副本路径。

### 2. chat 入口真 agent 端到端

用 `mesh talk` 起了一个**真的 dsh-01 coordinator 会话**（S-000008），只说了「按集成规则调
start_mission」，它自己决定调用：

```
start_mission → {"mission_id":"M-000002","lead_agent":"dsh-01",
                 "lead_session":"S-000009","spawned_session":"S-000009",
                 "source":"chat","status":"intake"}
```

audit 三件齐全（`.mesh/audit/events.jsonl`）：

- `mission.created` — `source":"chat"`, `by":"S-000008"`, `lead_agent":"dsh-01"`
- `session.spawned` — `S-000009` role `lead`, pid 39680（平台真的为它起了 lead 进程）
- `mission.planned` — `S-000009` 拆出 `T-000002`

随后 daemon 把它跑完：T-000002 由 dsh-02 实现、dsh-01 审、合并 `3941f761`，
`chat-entry.txt` 内容 `由对话入口发起`，M-000002 completed。**「一个真 agent 在对话里起
mission，平台把它当 lead 拉起」现在有会话级证据，不再只有契约测试。**

### 3. 状态文件加锁

`.tools/state_store.py` 是 `state.json` 的唯一写协议：

- 锁是**操作系统级字节区锁**（Windows `msvcrt.locking`，POSIX `flock`），加锁失败就退避重试；
- `.lock` 文件**永久保留、永不删除**——最初用「创建/删除锁文件」的写法反而制造了新 bug：
  等待方读锁体与持有方 unlink 撞车，4 进程下 15 秒锁超时、写丢了 2/3 的更新（实测 34/160）；
- 持有者进程死掉，锁由内核释放，不需要「陈旧锁回收」这种容易写错的逻辑（实测 0.00s 恢复）；
- 读在锁内做；`state.json` 用 tmp + `os.replace` 原子替换，并对 Windows 的「别人开着这个文件
  就拒绝替换」做有界重试；
- `commit_state()` 合并而非覆盖：调用者没碰的键保留、`reviewed` 求并集、要删的键显式写进
  `deleted=`；
- 路径**每次调用重新解析**（`AGENTMESH_STATE_FILE`），不是默认参数。

`.tools/auto-advance.py` 已改用它（`commit_state(state, deleted=("pending_review",))`），
验收侧统一走 `.tools/write-verdict.py`（只写 `reviewed[milestone]`，不碰 driver 的
`milestone` / `pending_review`）。

**压测**（`.tools/state-lock-test.py`，每个 case 用同一份负载分别跑旧实现和新实现）：

```
[1a] 4 进程 × 40 次自增，无锁   → 39/160 存活（丢 75%）        ← 复现旧 bug
[1b] 4 进程 × 40 次自增，加锁   → 160/160                    ← 一次不丢
[2a] 判决落在 driver 读写窗口内，无锁 → 判决被吃掉            ← 复现 M5 事故
[2b] 同上，加锁               → 判决存活
[3]  merge 语义               → deleted= 真的删掉、driver 的键赢
[4]  持锁进程被硬杀           → OS 释放，0.00s 后可写
[4b] 旧协议残留的 .lock 文件   → 视为无效，0.00s 通过
[5]  120 次写 + 并发读        → 0 次读到半截 JSON
[6]  blast radius            → 真实 state.json 运行前后字节一致
```

连跑 5 次全绿。

**过程中我自己弄坏过一次 `state.json`**（必须记下来）：第一版 `state_store.py` 把路径写成了
默认参数 `path=STATE_FILE`，测试把模块指向沙箱文件时实际仍在写真实文件，把
`milestone` 覆盖成 `M6`、`history` 清空、`reviewed.M5` 的签字只剩两个字段。已按
`reviewed` 记录、`write-m5-verdict.py` 的原文与 git 提交重建（`history[].at` 由 verdict
时间换算，其余为原值），损坏件留在
`<HERMES_HOME>\cache\agentmesh-v2\state.json.damaged-20261029-1815.bak`，重建说明写在
文件里的 `_restored`。压测的 `[6]` 一条就是为此加的：以后任何测试都先证明自己没碰真实文件。
