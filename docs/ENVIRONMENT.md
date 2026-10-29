# 环境前提（worker 能跑起来的三件事）

> 这份文档只写事实：哪个路径、什么现象、为什么、怎么验。
> 文档里的每条判据都对应 `docs/CHECK-ENVIRONMENT.ps1` 里的一条检查（`powershell -File` 可直接跑）。
>
> 背景：mesh 拉起的 worker 是一个**受限令牌**进程，它能不能写成某个路径，取决于
> 那个路径的 ACL 与完整性标签，而不是"主进程能不能写"。三条前提都是这条事实的不同表现。

---

## 1. DSH worker：seat 目录由 CLI 解析；提交失败的真因是 MCP 通道丢了 PATH

### 1.1 seat 目录在哪

DSH 的 home 解析逻辑在 `packages/util/home-paths/lib/index.js`：**`$DSH_HOME` 优先，未设则 `homedir()/.dsh`**。
worker 的卡片跑的是 `node apps/cli/lib/bin.js --profile headless`（CLI 入口），所以它的 seat 目录是：

```
$DSH_HOME/profiles/headless/          # 设了 DSH_HOME 时
C:\Users\HP\.dsh\profiles\headless\   # 未设时（本机）
```

这个目录**本来就可写**，不需要任何 `icacls /setintegritylevel`。实测：`C:\Users\HP\.dsh\profiles\headless\cordis.yml`
在 2026-10-29 19:49:42 被正常写入过，权限从一开始就是好的。

### 1.2 现象：worker 提交不上去

把卡派给 `dsh-01`（默认 `mcp_inject: dsh-patch`）后，worker 能起、能读、能写、能用 `git`，
但卡永远停在 `in_progress`：

```
$ mesh board
T-000004  in_progress  executor  写 docs/CHECK-ENVIRONMENT.ps1 …
```

worker 日志里 `hub.submit` 一侧报：

```
spawnSync git ENOENT
```

### 1.3 根因：MCP server 的 env 里没有 PATH

平台给 dsh 席位生成的 `.mesh/sessions/<session>/dsh-hub.patch.yml`，给 hub MCP server 的 env 只有三个变量：

```yaml
env:
  MESH_ROOT: "D:/AI/workspace/dsh/agentmesh"
  MESH_SESSION_ID: "S-0000xx"
  MESH_AGENT_ID: "dsh-01"
```

DSH 用这个 env 拉起 stdio MCP server 时，**进程的 PATH 没有带过去**。而 hub 的 `submit` 内部要
`spawnSync('git', …)`（用来做工作树干净检查），找不到 git 就 `ENOENT` —— 于是 MCP 通道下的
`submit` 在这台机器上**必然失败**，和 seat 目录能不能写毫无关系。

### 1.4 修法

**当前采用（配置层，已生效）**：把 dsh 席位的卡片改成文件协议，worker 走 `mesh submit`
（在它自己的 shell 里跑，那个 shell 的 PATH 有 git）：

```powershell
# .mesh/agents/dsh-01.json
#   mcp_inject: "file-protocol"
#   transport:  "file"
```

**平台侧的正解（2026-10-29 已修，commit `830144f`）**：两件事都做了 ——

1. `hub/adapters/dsh.ts` 生成 patch 时把 `PATH`、`PATHEXT`、`COMSPEC`、`SystemRoot` 等 15 个变量
   写进 MCP server 的 `env`（取值大小写不敏感，因为 Windows 上 `{...process.env}` 展开后键名是全大写的）；
2. `hub/core/git.ts` 新增 `resolveGitBinary()`：PATH 探不到就退到已知绝对安装路径，`submit` 不再硬依赖 PATH。

实测（2026-10-29 21:33）：把 `dsh-01` 改回 `mcp_inject: dsh-patch`，派卡 `T-000005`，
**50 秒**到 `submitted`，worker 日志记录 `hub.submit` 返回 `scope_clean: true` 且无 ENOENT，
随后 weiyang 交叉审查通过、合并为 `a1bb4351`。**`dsh-01` 现在不必再走 file-protocol 绕行。**

### 1.5 判据

```powershell
# 1) 自检脚本前两条：seat 目录存在 + dsh-01 有可用通道（file-protocol，或修复后的 mcp）
powershell -NoProfile -ExecutionPolicy Bypass -File docs/CHECK-ENVIRONMENT.ps1

# 2) 硬判据：卡能走完 claimed → submitted → merged
mesh task T-0000xx
```

### 1.6 两个 home 不要混

| home | 路径 | 谁在用 |
|---|---|---|
| CLI home | `$DSH_HOME` → 否则 `~/.dsh` | `node apps/cli/lib/bin.js --profile <seat>`（我们的 card） |
| 桌面版 home | `D:\AI\DSH\apps\desktop\.desktop-build\development\home` | 桌面端应用自身 |

**`D:\AI\DSH\profiles` 是误判产物**：那个目录存在期间一直是空的，DSH 从没往里写过，已删除。
排查时如果看到一条指向它的 `EPERM`，请当作**另一个现象**处理，别按本节修法去改它。

另有一个到目前为止**原因未确认**的现象，仅记录：在 `DSH_HOME` 指向桌面版 home 的环境里拉起
worker，曾出现写 `<桌面 home>/profiles/headless/cordis.yml` 的 `EPERM`；同样这张卡在
`DSH_HOME` 未设（→ `~/.dsh`）的环境里正常。两者的差别在**拉起 worker 的那个环境**，不在目录本身。

---

## 2. Hermes worker 需要一份**独立的** node 副本；绝不能翻转共享那份

### 现象

Hermes 席位当 worker 时，进程能起但写不了自己的沙箱（它内部要再拉起 `node`），
落盘类命令全失败。

### 根因

- 受限令牌的 worker 拉起的 `node` 继承同样的令牌；
- 全机共享的 `D:\AI\Hermes\tools\node-*\node.exe` 是 Medium、被很多进程共用 —— 动它的完整性
  等于给全机埋雷（实测：把它翻成 Low 之后，全机器 node 都写不了文件）。

### 修法

```powershell
New-Item -ItemType Directory -Force -Path "D:\AI\workspace\node-low" | Out-Null
Copy-Item "D:\AI\Hermes\tools\node-*\node.exe" "D:\AI\workspace\node-low\node.exe"
icacls "D:\AI\workspace\node-low\node.exe" /setintegritylevel L   # 只动这份副本
# 再把 Hermes 卡片的 command 指向这份副本
```

> ⚠️ **绝对不要**对 `D:\AI\Hermes\tools\node-*\node.exe` 执行 `/setintegritylevel`。

### 判据

```powershell
icacls "D:\AI\workspace\node-low\node.exe" | Select-String "Mandatory"   # 期望 Low
icacls "D:\AI\Hermes\tools\node-26.7.0-win32-x64\node.exe" | Select-String "Mandatory"  # 期望 Medium
```

现状：Hermes 席位当前只保留 `weiyang`（走文件协议），共享 node 仍是 **Medium** ✔。

---

## 3. mesh 项目必须建在 worker 写得进去的目录下

### 现象

项目建在 `D:\tmp\...` 这类目录下时，worker 能起、能 hello，但一落盘就全失败：
`New-Item` / `Set-Content` / `git commit` 整套报权限错误，卡永远提交不上去。

### 根因

受限令牌能写到哪个目录，来自 ACL 与完整性标签的交集。实测差异：

| 目录 | 完整性标签 | 关键 ACL |
|---|---|---|
| `D:\tmp` | （无，继承 Medium） | `BUILTIN\Users: ReadAndExecute`（继承，只读） |
| `D:\AI\workspace\dsh\agentmesh` | （无，继承 Medium） | `NT AUTHORITY\Authenticated Users:(M)` ← **显式 Modify** |

`D:\tmp` 只有继承来的只读授权，worker 拿不到写权。

### 修法

```powershell
New-Item -ItemType Directory -Force -Path "D:\AI\workspace\<project>" | Out-Null
icacls "D:\AI\workspace\<project>" /grant "HP:(OI)(CI)F"
```

### 判据

```powershell
icacls "D:\AI\workspace\<project>" | Select-String "HP:|Authenticated Users"   # 期望 (F) 或 (M)
# 硬判据：worker 能在 .mesh/worktrees/<task>/ 里落盘并提交
```

---

## 判据一览（复制即用）

最省事的方式：直接跑自检脚本，四条一次过。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs/CHECK-ENVIRONMENT.ps1
```

手工核对时用这几条：

```powershell
# 1) seat 目录跟 $DSH_HOME 走；未设则是 ~/.dsh
$home2 = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
Test-Path "$home2\profiles\headless\cordis.yml"

# 2) dsh 席位必须是 file-protocol
(Get-Content D:\AI\workspace\dsh\agentmesh\.mesh\agents\dsh-01.json -Raw | ConvertFrom-Json).mcp_inject

# 3) 共享 node 必须仍是 Medium
icacls "D:\AI\Hermes\tools\node-26.7.0-win32-x64\node.exe" | Select-String "Mandatory"

# 4) 项目目录要有 HP 的 (F) 或 (M)
icacls "D:\AI\workspace\dsh\agentmesh" | Select-String "HP:"
```

本次实测（普通 PowerShell）：

```
[1/4] DSH seat dir         PASS   $env:DSH_HOME=…\development\home → profiles\headless\cordis.yml (2026-10-29 20:15:37)
[2/4] dsh agent channel    PASS   mcp_inject: file-protocol
[3/4] shared node (Medium) PASS   Medium Mandatory Level
[4/4] project dir (HP F/M) PASS   HP:(F)
SUMMARY: 4/4 通过 / PASS / exit=0
```

> 第 1 条检查会跟着 `$DSH_HOME` 走：设了就看那个 home 下的 seat 目录，没设就看 `~/.dsh`。
> 脚本会把解析到的实际路径打出来，所以不会看混。

---

## 真实卡验证（2026-10-29）

配置：只启用 `dsh-01`（DSH worker）与 `weiyang`（Hermes，交叉审查），其余 agent disabled。

| 环节 | 结果 |
|---|---|
| 建卡（人工定 scope） | `T-000004`，scope = `docs/CHECK-ENVIRONMENT.ps1`，7 条验收 |
| 派发 | `mesh assign T-000004 --agent dsh-01` → session `S-000017`，沙箱 `.mesh/worktrees/T-000004` |
| 实现 | dsh-01 一轮跑完，commit `3c0d9f2`，`submit` 成功 |
| 交叉审查 | `mesh up --once` 自动派给 **weiyang**（`S-000018`，role=supervisor）→ `R-0004` **approved**，7/7 条 True |
| 合并 | `mesh up --once` → **`a74600f4`（strict）**，产物落到 main 的 `docs/CHECK-ENVIRONMENT.ps1` |

这一轮正是 §1 的验证：第一版用 `dsh-patch` 时卡死在 `in_progress`（`spawnSync git ENOENT`），
换成 `file-protocol` 后同一条命令一次通过。

---

## 附：本文档的一次纠错（留痕）

本文档初版把"`D:\AI\DSH\profiles` 建目录 + 打 Low 标签"写成了 §1 的修法。那是误判：

- 那个目录存在期间一直是空的，DSH 从未往里写过，现已删除；
- CLI 的 seat 目录是 `$DSH_HOME`（或 `~/.dsh`）下的 `profiles/<seat>`，权限本来就正常；
- 真正让 worker 跑不通的是 §1.3 的 MCP 通道 PATH 丢失，把它改成 `file-protocol` 才通。

留这段是为了让下一个人不必重复踩：**看到一条 EPERM 路径，先确认它属于哪个 home、哪个进程**。
