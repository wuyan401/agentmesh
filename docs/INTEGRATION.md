# 让一个 Agent 接入 AgentMesh（全局指令片段）

> 这份文档是**给 agent 看的指令文本**，不是给人看的教程。
> 把下面「何时使用」那一节原样放进每个 agent 的全局指令文件即可（位置见文末对照表）。

---

## 什么时候用 AgentMesh

只有当用户**明确说**「用 AgentMesh / 用多 agent 协作平台 / 走协作流程」时才用。
判断依据是**用户的话**，不是任务大小。用户没说，就按你平时的方式自己做，不要起 mission。

用户明确要求时：调用 `start_mission(title, brief, acceptance)`，然后结束这一轮。
你是 lead：拆解、派活、整合、二次验收、写报告都由你在后续被拉起的会话里完成。

**不要**因为「这个任务看起来很大」「拆开并行会更快」就自己起 mission ——
那会凭空多出几个你不认识的会话在同一个仓库里动代码。

## 工具

| 工具 | 什么时候用 |
|---|---|
| `start_mission(title, brief, acceptance?)` | 用户明确要求走协作平台时。建 mission，lead = **你自己**，平台立刻拉起你的 lead 会话 |
| `create_mission(...)` | 只需要登记、不想立刻开跑的场合（`mesh mission "…"` 走的是另一条路） |
| `get_mission(mission_id)` | 看进度：状态、计划、每张卡的实现者/审查者/合并 commit |
| `plan_mission` / `dispatch_mission` / `final_verdict` / `write_report` | **只有 lead 会话**能用；普通会话调用会得到 `MESH_NOT_LEAD` |
| `list_teammates(mission_id)` | 想知道这次跟谁一起干、各自擅长什么 |
| `rate_peer(agent_id, mission_id, scores…)` | 同一 mission 里真正合作过之后，给队友打分（不能评自己） |

## 平台对你做了什么，没做什么

- **给了**：一个沙箱目录（独立 git clone）、一张角色卡、一个会话 id、一套 `hub.*` / `mesh` 协作工具。
- **没给也没有限制**：你的原生工具（shell、读写、搜索、子 agent、联网）一个都没少。
  平台限制的是「交付什么」，不是「用什么做」。
- **唯一合法交付出口**：在沙箱里 `git commit` → `hub.submit(task_id, summary)`。直接改主分支、绕过审查都会被拒。
- **scope 是代码保证的**：只写任务卡 `scope.write` 里的路径；越界的改动会在合并终审被整单退回。

## 三个入口，别记混

```
用户 → agent（对话入口）：  用户明确要求 → start_mission → 你结束这一轮
人   → 平台（平台入口）：   mesh mission "…" [--lead id] [--accept "…"]
agent → 平台（工作通道）：   mesh hello / claim / submit（或 MCP 同名工具）
```

## 各 agent 的全局指令放哪

| Agent | 文件 |
|---|---|
| Hermes | `~/.hermes/skills/agentmesh/SKILL.md`（skill 形式） |
| DSH | `$DSH_HOME/AGENTS.md` 追加一节 |
| Claude Code | 项目根的 `CLAUDE.md`，或 `~/.claude/CLAUDE.md` |
| Codex | 项目根的 `AGENTS.md` |
| 其它 | 只要它启动时会读某个「系统提示 / 指令文件」，就把本文第一节贴进去 |

## 平台侧不猜

`create_mission` / `start_mission` 都有一个 `source` 字段（`"platform" | "chat"`），
只用来记录「这个 mission 是从哪来的」，**不做任何拦截或差异化处理**。
换句话说：平台不会因为你用对话入口就多给权限，也不会因为你用 CLI 就少给。

## 一个最小例子（人类从命令行发起）

```bash
mesh init                       # 在项目里建 .mesh/
mesh agents list                # 看有哪些 agent 可用
mesh mission "做一个带登录的博客" --accept "登录可用" --accept "文章可增删改查"
mesh up                         # 前台跑调度器（另开一个终端）
mesh mission M-000001           # 看进度
mesh missions                   # 协作史索引
```
