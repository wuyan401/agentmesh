# AgentMesh 观察台使用笔记

观察台是 `mesh serve` 起的一个**只读** Web 界面：服务端只有 `hub/web/server.ts`（JSON API + 静态资源），前端是零依赖、零构建的原生 ES module（`web/index.html`、`web/app.js`、`web/styles.css`）。它把平台的三本账——任务卡、会话、审计与消息——摊开给人看；**写操作一律不在这里做**，仍走 CLI（`mesh new` / `mesh mission` / `mesh up`）与 agent 侧的 `hub.*` 工具。这样任何一次状态变更都留在审计账本里，没人能从浏览器标签页里绕过它。

侧栏一共七个视图，顺序固定：总览、任务单、看板、会话、审计、消息、Agent。

---

## 一、怎么用

### 1. 启动

```bash
mesh serve                  # 默认 http://127.0.0.1:8787
mesh serve --port 9000      # 换端口
mesh serve --host 0.0.0.0   # 换监听地址（默认只监听本机 127.0.0.1）
mesh serve --dir ../proj    # 不开 cd 也能观察另一个项目
```

默认端口 **8787**、默认 host **127.0.0.1** 来自 `cli/human.ts` 的 `cmdServe()`；启动成功后终端打印 `✔ dashboard: http://127.0.0.1:8787`，`Ctrl+C` 退出。

### 2. 打开

浏览器访问 `http://127.0.0.1:8787/`（换了 `--port` 就换成对应端口）。页面是 hash 路由：URL 不带 hash 时 `boot()` 会自动补成 `#/board`，所以第一眼落在看板。

### 3. 路由表

| 地址 | 含义 |
| --- | --- |
| `#/overview` | 总览 |
| `#/missions` | 任务单列表 |
| `#/missions/<MISSION_ID>` | 某个任务单的完整证据页 |
| `#/board` | 看板 |
| `#/board?task=<TASK_ID>` | 看板 + 右侧任务详情面板 |
| `#/board?status=submitted&role=reviewer` | 看板按状态 / 角色筛选 |
| `#/board?sort=id_asc&mode=table` | 换排序、切表格视图 |
| `#/sessions?s=<SESSION_ID>` | 会话，并选中某个会话 |
| `#/audit?atab=merges&doc=decisions` | 审计：合并分类 + decisions.md |
| `#/messages?thread=<THREAD>` | 消息，按线程过滤 |
| `#/agents` | Agent 注册表 |

详情面板的页签也能进 URL：`?task=<TASK_ID>&tab=submission|timeline|context`（默认 `verdict`）；任务单页的「只看未通过」是 `?fail=1`。未知的视图名会回落到 `board`（`parseHash()`）。

### 4. 为什么只能看

服务端只实现 `GET /api/*` 与静态文件，没有任何写接口（`hub/web/server.ts` 的路由表里全是 `sendJson` 只读响应）。所以「改状态」的正确姿势是：CLI 里 `mesh ...`，或者 agent 在会话里调 `hub.submit` / `hub.send` / `hub.merge` 等工具。侧栏页脚那行「模式 只读」说的就是这件事。

---

## 二、全局能力（每个视图都有）

- **实时推送**：前端连 `EventSource('/api/stream')`，服务端每 **3 秒**推一次 `{ counts, live }`（`hub/web/server.ts` 的 `/api/stream` 分支）。顶栏状态灯显示「实时」。
- **降级轮询**：SSE 出错即 `degradeToPolling()`——关流、状态灯变「轮询」、总览条上出现「实时连接中断，已降级为每 8 秒轮询」的横幅，改为每 **8 秒**拉 `/api/overview`；**20 秒**后尝试恢复 SSE，页面重新可见时（`visibilitychange`）也会再试一次。
- **搜索**：顶栏搜索框，`/` 聚焦并全选；输入 180ms 防抖写进 hash 的 `q`，各视图按自己的字段匹配；`Esc` 清空。占位文案随视图变化（`SEARCH_PH`）。
- **手动刷新**：顶栏刷新按钮重拉 overview / tasks / sessions / audit / messages / missions，并清掉任务详情、日志、digest、任务单详情的本地缓存。
- **深浅色**：顶栏主题按钮切换，默认深色，选择存 `localStorage` 的 `agentmesh.theme`。
- **总览条（strip）**：所有视图上方都有一条，显示任务总数、各状态计数、活跃会话数、最近合并、审计异常（含 high 时标红点）、以及 `auto_review` / `auto_integrate` / `max_concurrent_sessions` 三个配置旗标。点状态格子 = 筛看板状态，点「活跃会话」= 去会话页，点「最近合并」/「审计异常」= 去审计页对应分类。
- **快捷键**：

| 键 | 作用 |
| --- | --- |
| `?` | 打开键盘帮助 |
| `/` | 聚焦搜索框 |
| `Esc` | 关详情面板 → 清筛选/搜索 → 失焦 |
| `g` `o` / `r` / `b` / `s` / `a` / `m` | 依次跳总览 / 任务单 / 看板 / 会话 / 审计 / 消息（`g` `g` 跳 Agent） |
| `t` | 看板上切换「分组 ↔ 表格」 |
| `←` `→` | 详情面板页签获得焦点时切换页签 |

`g` 前缀有 1200ms 时间窗（`bind()` 里的 `gPending`）。

---

## 三、七个视图

### 1. 总览

**这个视图回答什么问题**：平台现在什么状况——有多少活、卡在哪些状态、谁在跑、最近合了什么、有没有异常、配置和基线是什么。它是「一眼看全局」，不做深挖。

**主要区域**：

- **任务**：任务总数，按状态分行计数（只列非零状态），下面再按角色分组统计（`counts_by_role`）。
- **会话**：`status = active` 的会话列表，每行给会话 id、角色、pid 是否存活、心跳距今多久。
- **最近合并**：最近几次合并的任务 id、模式、合并提交短 sha、相对时间。
- **审计异常**：最近几条异常的严重度、kind 与时间（标 `detect-only`，只检出、不处理）。
- **平台配置**：把 `config.json` 的键值原样铺开（`loadConfig`）。
- **坐标**：`project`、`main`、`root`、`mesh_dir`、`base` 五个定位信息，排障时先看这里对不对。

**怎么操作**：本页没有写操作；点击上方总览条的格子会跳到对应视图或加上筛选。

**源码锚点**：`renderOverview()`（`web/app.js`）；数据来自 `GET /api/overview`（`hub/web/server.ts`）。

---

### 2. 任务单

**这个视图回答什么问题**：用户下发的每一件「活」（mission）凭什么算做完了——谁带的队、拆了几张卡、每张卡的审查逐条过了没有、最后那份报告在哪。两级模型：mission ⊃ 任务卡。

**主要区域**：

- **列表页**：每行一个 mission，给 id、状态、标题、lead、轮次、更新时间、进度条（已合并 / 总数，取消的走斜纹）、建单到收尾的时长；新的在上面。点行进入详情；页脚给出协作史索引（`.mesh/HISTORY.md`）是否已生成。
- **详情页 — 头部**：mission id、状态、lead 与 lead 会话、轮次、时长、建单/收尾时间、进度、来源、参与 agent、开单时写的验收条款（`missionAcceptance`）、状态轨迹，以及落盘文件清单（缺文件的会标「缺」）。有上级 mission 时给一个跳转 chip。
- **01 时间线**：审计账本 + 消息账本合并出的时间线，按天分隔，每条给时分秒、事件中文标签（后端 `timeline[].label`）、操作者；带 `task_id` 的事件可点进看板对应卡。
- **02 卡片与证据**：每张卡一屏——id、标题、状态、role / impl / rev / scope / merge / commit、打回次数，卡上的验收条款，以及每次审查的逐条 criteria（PASS / FAIL / 未裁决 + evidence）与判词。右上「全部 / 只看未通过」切换（`?fail=1`），并给出条款总数与未通过数。
- **03 交付报告**：报告全文按 markdown 渲染，附落盘路径与字符数；没写报告时明确说明「报告还没写」。

**怎么操作**：列表 → 详情靠 URL 子路径；详情内三段用顶部 01/02/03 按钮页内平滑跳转；「只看未通过」写进 hash；搜索框在列表页搜 mission / 标题 / lead，在详情页搜卡 id / 标题 / 角色 / 验收条款 / 审查者。

**源码锚点**：`renderMissionList()`、`renderMissionDetail()`、`missionTimelineBlock()`、`missionCardsBlock()`、`missionReportBlock()`（`web/app.js`）；数据来自 `GET /api/missions`、`GET /api/missions/<ID>`（`hub/web/server.ts`）。

---

### 3. 看板

**这个视图回答什么问题**：任务卡现在分布在流水线的哪一站，每一张卡是谁实现、谁审、审到什么程度；需要时把某一张卡的全部证据拉出来看。

**主要区域**：

- **头部**：「显示 N / M 张」，右侧是视图模式（**分组 / 表格**）、**角色**下拉、**排序**下拉（更新时间 ↓ / ↑、ID ↑ / ↓、状态、角色）。
- **筛选条**：已生效的状态 / 角色 / 关键词各显示为一枚可点掉的 chip，另有「全部清除」。
- **流程站点图**：`draft → ready → claimed → in_progress → submitted → reviewing → approved → merged` 共 **8 站**，每站一个柱子显示任务数与相对高度；点站点即按该状态筛选（再点清除）。站点图始终按**全部**任务统计，不受当前筛选影响。
- **主体**：
  - **分组**模式：按状态顺序分泳道，泳道头给状态与张数，卡片给 id、相对时间、标题、role、write scope、裁决摘要、轨道进度、impl / rev。末尾列出当前为空的状态。
  - **表格**模式：ID / 状态 / 角色 / 标题 / scope / 实现者 / 审查者 / 轨道 / 更新；ID、角色、更新三列表头可点排序（表头带 `aria-sort`）。
  - 两种模式下点卡片或行都会打开右侧**任务详情面板**（也写进 `?task=`），`Esc` 关闭。
- **详情面板四页签**（`panelShell`）：
  1. **裁决**：验收标准 × 审查裁决逐条对照（✓/✕/?，附审查 id、审查者、是否独立、evidence）、审查额外项、scope 终审（干净 / 越界 / 未复核 + 越界文件与复核文件清单）、合并裁决（合并提交、提交提交、模式、剥离文件、合入文件数、合并会话、时间）、审查记录原文。
  2. **提交**：commit、branch、session、提交时间、基线 → 提交、worktree，本次提交的 diff 文件清单，提交说明。
  3. **时间线**：状态历史（谁在什么时候把卡从什么状态推到什么状态，带备注）、相关会话（点「日志」可展开日志尾部 200 行）、任务卡原始字段（branch / base / claimed_by / context / depends_on / blocked）。
  4. **上下文包**：这张卡的上下文包原文（markdown 渲染）。
  面板头部还有一条轨道：`已合并 / 总站数`，轨道外状态（rejected / blocked / cancelled）会明确标注「轨道外」。

**怎么操作**：站点与 chip 筛状态、下拉选角色与排序、`t` 或分段按钮切分组/表格、点卡开面板、面板内点页签或 `←` `→` 切换。

**源码锚点**：`renderBoard()`、`pipeBlock()`、`lanesView()`、`tasksTable()`、`panelShell()`、`renderVerdictTab()`、`renderSubmissionTab()`、`renderTimelineTab()`、`renderContextTab()`（`web/app.js`）；数据来自 `GET /api/tasks`、`GET /api/tasks/<ID>`（`hub/web/server.ts`，`taskView()` 负责把审查记录、相关会话与 scope 复核拼进响应）。

---

### 4. 会话

**这个视图回答什么问题**：哪些 agent 进程还活着、各自在跑哪张卡、心跳还新不新鲜、它到底在日志里写了什么。进程死没死，比状态字段更可信。

**主要区域**：

- **头部**：会话总数、进程存活数、当前显示数；右侧「全部 / 仅存活」切换（只影响界面，不写进 URL）。
- **左栏会话列表**：每项给 session id、状态、存活点（无进程标「无进程」）、role、agent、task（可点进看板）、心跳距今（过期会变淡）、lifespan、pid。当前选中项高亮。
- **右栏日志面板**：会话身份、role、lifespan、pid、心跳、任务链接，「重载日志」按钮，日志文件路径，然后是**日志尾部**（默认取最后 **200 行**，等宽展示并自动滚到底部）。daemon 会话或日志被清理时明确提示「这个会话没有日志文件」，日志为空也单独提示。

**怎么操作**：点列表项切换日志；`s=` 参数可分享选中项；没选中时优先挑一个带 pid 的会话。

**源码锚点**：`renderSessions()`、`renderLogPane()`、`currentSession()`（`web/app.js`）；数据来自 `GET /api/sessions` 与 `GET /api/sessions/<ID>/log?lines=200`（`hub/web/server.ts`）。

---

### 5. 审计

**这个视图回答什么问题**：平台自己干了什么、有没有越界或漂移、每次合并剥掉了什么、审查给了什么判词；再往右，是平台的三份「法典」原文。

**主要区域**：

- **头部**：`X 异常 · Y 合并 · Z 审查 · W 事件`，标「平台产出，detect-only」。
- **左栏分类**（四个分段按钮，各带计数）：
  - **异常**：严重度、kind、violation id、详情、时间、关联任务（可点）、会话、agent、是否已通知，以及 evidence JSON。
  - **合并**：模式、任务、合并提交、`branch → 主分支`、文件数、是否剥离（剥离几条标红）、执行者、审查 id，并列出合入文件。
  - **审查**：verdict、review id、任务、谁审谁、criteria 条数、是否独立、是否允许 strip 合并，并逐条列出 `[PASS]/[FAIL]` 条款。
  - **事件**：时间 + 事件名 + 操作者/相关角色线程/任务等信息，是平台内核动作的流水账。
- **右栏文档**（三个分段按钮）：`digest`（平台摘要）、`decisions.md`（决策记录）、`protocol`（协议快照；文件缺失时回落到内置的协议速查 `PROTOCOL_QUICKREF`）。三份都以 markdown 渲染。

**怎么操作**：左右两栏各自切换分类与文档，选择都写进 hash（`atab` / `doc`）；总览条的「最近合并」「审计异常」会直接落到对应分类。

**源码锚点**：`renderAudit()`、`violationsList()`、`mergesList()`、`reviewsList()`、`eventsList()`（`web/app.js`）；数据来自 `GET /api/audit`、`GET /api/decisions`、`GET /api/protocol`（`hub/web/server.ts`，接口分别截取最近 200 / 200 / 100 / 150 条）。

---

### 6. 消息

**这个视图回答什么问题**：agent 之间的消息到底投出去了没有、有没有角色空缺导致一直没人领、哪条已经过期成了死信。平台不允许点对点私聊，一切走 `hub.send` 的角色线程，这一页就是那条总线的账本。

**主要区域**：

- **头部**：当前显示条数、**排队中**条数、**死信**条数。
- **线程过滤条**：`全部` 加每条出现过的线程（带条数，全局线程显示为「全局 \*」）；`*` 线程的消息在任何筛选下都会出现。
- **消息列表**（新的在上）：左侧时间与发件 agent / 角色 / 会话；右侧类型、路由 `from → to @thread`、状态徽标（`排队中（角色空缺）` 或 `已解决`）、附件数、正文（过长可展开）、消息 id、TTL 到期时间，以及「未读 · 等目标角色上线认领」或「已读 + 读件人 + 读回时间」。
- **死信区**（页面底部）：无角色认领且已过期的投递，给出类型、id、原因与线程；没有死信时明确写「消息都有落点」。

**怎么操作**：点线程按钮过滤（写进 `?thread=`），搜索框按正文 / 类型 / 发件收件 / 线程匹配。

**源码锚点**：`renderMessages()`（`web/app.js`）；数据来自 `GET /api/messages`（`hub/web/server.ts`，最近 300 条投递、50 条死信）。

---

### 7. Agent

**这个视图回答什么问题**：平台上有哪些可被拉起的 agent、各自的通道与注入方式是什么、谁被停用了。能力决定它能接什么角色，通道决定平台怎么把它拉起来。

**主要区域**：一张注册表，列为 **ID / 名称 / kind / 状态（启用·停用）/ capabilities / 并发 / 通道 / 注入 / 备注**。capabilities 渲染成一排 chip；停用行整体变淡；头部给「共 N 个 · 启用 M 个 · 显示 K 个」。空表时提示用 `mesh agent add` 注册。

**怎么操作**：搜索框按 id / 名称 / kind / 能力 / 注入方式 / 通道过滤；本页只读，增删改走 `mesh agent ...`。

**源码锚点**：`renderAgents()`（`web/app.js`），数据取自 `GET /api/overview` 的 `agents` 字段（`hub/web/server.ts`）。

---

## 四、状态语言速查

看板与详情面板共用同一套状态词，`web/app.js` 顶部常量定义了顺序：

- 主流程 8 站（`PIPE`）：`draft` 草稿 → `ready` 待领取 → `claimed` 已认领 → `in_progress` 进行中 → `submitted` 已提交 → `reviewing` 审查中 → `approved` 已通过 → `merged` 已合并。
- 轨道外终态（`OFF_TRACK`）：`rejected` 已驳回、`blocked` 已阻塞、`cancelled` 已取消。
- mission 另有自己的状态机（`intake` 已接单、`planning` 拆解中、`executing` 执行中、`integrating` 整合中、`final_review` 二次验收、`completed` 已完成），只用于任务单页的状态与副标题，不进看板轨道。

---

## 五、复核方式

文中每一条都能就地核对，不需要相信我：

1. 视图清单与侧栏文案：`web/index.html` 的 `nav.nav-link`（`data-nav` 与 `<span>` 文本），以及 `web/app.js` 的 `VIEWS` / `VIEW_TITLE`。
2. 启动与端口：`cli/human.ts` 的 `cmdServe()`（`?? 8787`、`?? '127.0.0.1'`）、`cli/mesh.ts` 的帮助行 `mesh serve [--port 8787]`。
3. 路由与参数：`web/app.js` 的 `parseHash()`、`syncUiFromRoute()`、`currentParams()`。
4. 交互：`web/app.js` 的 `pipeBlock()`、`filterBar()`、`panelShell()`、`renderSessions()`、`renderLogPane()`、`renderAudit()`、`renderMessages()`、`renderMissionDetail()`、`renderAgents()`。
5. 实时与降级：`web/app.js` 的 `connectStream()`、`degradeToPolling()`、`startPolling()`（`8000` 毫秒）；服务端 `hub/web/server.ts` 的 `/api/stream`（`setInterval(tick, 3000)`）。
6. 只读性质：`hub/web/server.ts` 的 `route()` 里没有任何写方法分支，只有 `sendJson` / `sendText` / 静态文件读取。
7. 快捷键：`web/index.html` 的帮助对话框与 `web/app.js` 的全局 `keydown` 监听（`g` 映射表、`t` 仅在看板生效）。
