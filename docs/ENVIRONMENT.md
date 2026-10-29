# 环境前提（AgentMesh worker 必须满足的三件事）

> 这份文档记录**这台机器**上 AgentMesh 能跑通的三条环境前提。
> 每条都按 **现象 → 根因 → 修法 → 判据** 写，判据是可以直接复制粘贴跑的检查。
>
> 一句话主线：**worker 是被降权到 Low 完整性的进程**。凡是它要写的东西，
> 要么带 Low 标签，要么所在目录给了它显式写权限。三条前提都是这条主线的不同表现。
>
> 记录人：拾汐（seasum）。第 1 条的根因诊断与修复由未央（weiyang）完成并实测，
> 第 2、3 条同样是未央实测后交办；我在本机用 `icacls` 复核了全部判据。

---

## 1. DSH worker 需要 `DSH_HOME` 下的 `profiles` 目录存在，且带 Low 完整性标签

### 现象

派一张卡给 DSH 席位（`dsh-01`）时，worker 进程**秒退**，卡在 3 次重试后被平台判 `blocked`：

```
$ mesh board
T-000003  blocked  backend_dev  实现 greet(name) 模块与包入口

$ mesh up
# 19 spawn 1  release 1
  → T-000003 seasum (backend_dev, pid 34848)
# 20 blocked 1
  ✖ T-000003 released 3 times
```

worker 的日志（`.mesh/logs/S-0000xx.log`）尾部是：

```
Error: EPERM: operation not permitted, open
  'D:\AI\DSH\apps\desktop\.desktop-build\development\home\profiles\headless\cordis.yml'
    at prepareProfile (.../profile-boot-*.js:189:2)
    at composeProfile (.../profile-boot-*.js:206:46)
errno: -4048, code: 'EPERM', syscall: 'open'
```

### 根因

两层叠在一起：

1. **DSH 每次启动都要写自己的 profile 合成文件** `profiles/<name>/cordis.yml`。这个文件不存在
   或目录不存在时，它会在启动阶段直接 `writeFileSync` —— 写不进去就崩，且崩在拿到任务之前。
2. **worker 被自己的沙箱降成 Low 完整性**，而 DSH 树在 `D:\AI\DSH` 是默认（Medium）标签。
   Low 进程写 Medium 对象 → `EPERM`。这不是权限位的问题（ACL 里 HP 是 FullControl），
   是**强制完整性级别**的问题，所以 `icacls` 看 ACL 一切正常、只有 `Mandatory Label` 那行能看出区别。

我在排查时被表象误导过：同样的 `spawn` 参数（cwd / env / detached / 长参数）手工跑都成功，
只有平台拉起时失败 —— 因为手工跑的是 Medium 进程，平台拉起的是 Low 进程。

### 修法

```powershell
# 1) 目录必须先存在（DSH 不会自己建它）
New-Item -ItemType Directory -Force -Path "D:\AI\DSH\profiles" | Out-Null
# 2) 打 Low 标签，让 Low 的 worker 写得进去；Medium 的主进程（我/未央）不受影响
icacls "D:\AI\DSH\profiles" /setintegritylevel (OI)(CI)L
```

- **只给这一个目录打标签**，不要给整个 `D:\AI\DSH` 打。
- `(NW)`（NO_WRITE_UP）是这个标签自带的，含义是"低完整性进程不许往上写"；因为这里我们
  要的正好是**低写低**，所以它不碍事。

### 判据

```powershell
# 必须出现 Low Mandatory Level
icacls "D:\AI\DSH\profiles" | Select-String "Mandatory"
#   Mandatory Label\Low Mandatory Level:(NW)

# worker 能真的跑完一张卡（最硬的判据）：卡的历史里要有 claimed → submitted → merged
mesh task T-0000xx
```

真实跑通的记录见仓库根的 `DSH-WORKER-SMOKE.md`（T-000003：`hub.hello()` → S-000010、
`git branch --show-current` → `mesh/T-000003`、产物提交并 `hub.submit`、最终 merged）。

---

## 2. Hermes worker 需要一份**独立的** Low 完整性 node 副本；绝不能翻转共享那份

### 现象

Hermes 席位（`weiyang` / `hermes-01`）当 worker 时，进程能起但**写不了自己的沙箱**：
`node` 的可执行/临时写入被完整性级别挡住，worker 的 pwsh 里几乎每条落盘命令都失败。
极端情况下为了"绕过"会把 `D:\AI\Hermes\tools\node-*\node.exe` 本身翻成 Low ——
**那样会让全机器的 node 都写不了文件**（Medium 主进程写 Low 二进制没问题，但别的东西全乱）。

### 根因

- Hermes 是 Python 包一层 `hermes.exe`，它内部再拉起 `node`（用来跑 MCP / 工具）。
- worker 是 Low 完整性进程；它拉起的 `node` 继承 Low。共享的 `node.exe` 是 Medium 标签，
  且被全机器（其它 agent、我自己、qbot……）共用 —— 动它的完整性等于给全机埋雷。

### 修法

```powershell
# 1) 复制一份 node 到独立目录（不要碰 D:\AI\Hermes 下那份）
New-Item -ItemType Directory -Force -Path "D:\AI\workspace\node-low" | Out-Null
Copy-Item "D:\AI\Hermes\tools\node-*\node.exe" "D:\AI\workspace\node-low\node.exe"
# 2) 只给这份副本打 Low 标签
icacls "D:\AI\workspace\node-low\node.exe" /setintegritylevel L
# 3) 把 Hermes 卡里的 command 指向这份副本（或让它通过 PATH 优先命中）
```

> ⚠️ **绝对不要**对 `D:\AI\Hermes\tools\node-*\node.exe` 执行 `/setintegritylevel`。
> 那份是 Medium、全机共享；翻成 Low 之后，Medium 进程写它、以及依赖它写临时文件的链路会一起坏。

### 判据

```powershell
# 副本是 Low
icacls "D:\AI\workspace\node-low\node.exe" | Select-String "Mandatory"
#   Mandatory Label\Low Mandatory Level:(NW)

# 共享那份**仍然是** Medium —— 这是"没有误伤"的判据
icacls "D:\AI\Hermes\tools\node-26.7.0-win32-x64\node.exe" | Select-String "Mandatory"
#   Mandatory Label\Medium Mandatory Level:(NW)      ← 必须是 Medium
```

Hermes 席位目前**已禁用**（未央去重：只留 `dsh-01` + `weiyang`），所以这条是"将来再开 Hermes
worker 时的前提"，不是现在的阻塞。复核结果：共享 node 仍是 Medium ✔。

---

## 3. mesh 测试项目必须建在 HP 完全控制、且 worker 写得进去的目录下

### 现象

把项目建在 `D:\tmp\...` 这类目录下时，worker 能启动、能 hello，但**一落盘就全失败**：
`pwsh` 里 `New-Item` / `Set-Content` / `git commit` 全套报权限错误，卡永远 submitted 不上去。
换成 `D:\AI\workspace\...` 就正常。

### 根因

Low 完整性 worker 的令牌是受限的，它对目录的写权来自 ACL 与完整性标签的**交集**。
两个目录的实测差异：

| 目录 | 完整性标签 | 关键 ACL 条目 |
|---|---|---|
| `D:\tmp` | （无，继承 Medium） | `BUILTIN\Users: ReadAndExecute`（继承，只读） |
| `D:\AI\workspace\dsh\agentmesh` | （无，继承 Medium） | `NT AUTHORITY\Authenticated Users:(M)` ← **显式 Modify** |
| `D:\AI\workspace\mesh-workspace` | `Low Mandatory Level:(OI)(CI)(NW)` | `HP:(F)` + Low 标签 |

`D:\tmp` 只有继承来的只读授权，没有给 HP/认证用户的显式写权限；worker 的受限令牌
拿不到写权，于是整条落盘链路失败。

### 修法

```powershell
# 项目建在 HP 完全控制的位置（本机约定 D:\AI\workspace\...）
New-Item -ItemType Directory -Force -Path "D:\AI\workspace\<project>" | Out-Null
# 让 worker 一定写得进去：给它显式写权限
icacls "D:\AI\workspace\<project>" /grant "HP:(OI)(CI)F"
# 或者更彻底：把项目也打成 Low（和你自己的 worker 对齐）
icacls "D:\AI\workspace\<project>" /setintegritylevel (OI)(CI)L
```

### 判据

```powershell
# 必须是 HP:(F) 或 (M)，不能只有 Users:(RX)
icacls "D:\AI\workspace\<project>" | Select-String "HP:|Authenticated Users"

# 最硬判据：worker 能在自己的 worktree 里落盘并提交
#   .mesh/worktrees/<task>/ 下出现新文件，且 git log --oneline 多了一条 mesh(<task>): …
```

---

## 判据一览（复制即用）

```powershell
$checks = @(
  @{ name = 'DSH profiles 目录存在';   path = 'D:\AI\DSH\profiles' },
  @{ name = 'shared node（必须 Medium）'; path = 'D:\AI\Hermes\tools\node-26.7.0-win32-x64\node.exe' },
  @{ name = '项目目录';                path = 'D:\AI\workspace\dsh\agentmesh' }
)
foreach ($c in $checks) {
  $exists = Test-Path $c.path
  $label = (icacls $c.path 2>$null | Select-String 'Mandatory') -join '; '
  "{0,-28} exists={1}  {2}" -f $c.name, $exists, ($label.Trim())
}
```

期望（本机当前状态）：

```
DSH profiles 目录存在            exists=True   Mandatory Label\Low Mandatory Level:(NW)
shared node（必须 Medium）       exists=True   Mandatory Label\Medium Mandatory Level:(NW)
项目目录                         exists=True
```

一条可直接跑的自动化版本：`docs/CHECK-ENVIRONMENT.ps1`（三条前提的自检脚本，
由 worker `dsh-01` 在 M-000002 里写并合并，见下节）。

---

## 真实卡验证（2026-10-29）

配置：只启用 `dsh-01`（DSH worker）与 `weiyang`（Hermes，交叉审查），其余 agent 全部 disabled。

| 环节 | 结果 |
|---|---|
| 建卡（我定 scope） | `T-000004`，scope = `docs/CHECK-ENVIRONMENT.ps1`，7 条验收 |
| 派发 | `mesh assign T-000004 --agent dsh-01` → session `S-000017` 绑定沙箱 `.mesh/worktrees/T-000004` |
| 实现 | dsh-01 跑完一轮（约 8.5 分钟），commit `3c0d9f2`，`submit` 成功 |
| 交叉审查 | `mesh up --once` 自动派给 **weiyang**（session `S-000018`，role=supervisor）→ `R-0004` **approved**，7 条验收逐条 True |
| 合并 | `mesh up --once` → **`a74600f4`（strict）**，产物落到 main 的 `docs/CHECK-ENVIRONMENT.ps1` |

产物自检（我在 main 上直接跑）：

```
$ powershell -NoProfile -File docs/CHECK-ENVIRONMENT.ps1
[1/3] DSH profiles (Low)                PASS   D:\AI\DSH\profiles → Low Mandatory Level
[2/3] shared node (Medium)              PASS   ...\node.exe → Medium Mandatory Level
[3/3] project dir (HP F/M)              PASS   .mesh\worktrees\T-000004 → HP:(F)
SUMMARY: 3/3 通过
PASS
exit=0
```

### 这一轮踩到的第 4 个坑（本轮新发现，**未修**）

**现象**：`dsh-01` 的工人会话能写文件、能用 `git`（绝对路径下 `Test-Path` 为真），但调用
`hub.submit` 时报 `spawnSync git ENOENT`，卡在 `in_progress` 提交不上去。

**根因**：dsh 席位默认 `mcp_inject: dsh-patch`，平台生成的 `dsh-hub.patch.yml` 里给 MCP server
写的是**只有三个环境变量**的 env：

```yaml
env:
  MESH_ROOT: "..."
  MESH_SESSION_ID: "S-0000xx"
  MESH_AGENT_ID: "dsh-01"
```

DSH 拉起这个 stdio MCP server 时，**进程的 PATH 没有传进去**；而 hub 的 `submit` 内部要
`spawnSync('git', ...)`，找不到 git 就 ENOENT。所以 MCP 通道下的 submit 在这台机器上必然失败。

**本轮的处理**（绕开，不改平台代码）：把 `dsh-01` 的卡片从 `mcp_inject: dsh-patch` 换成
`file-protocol`，让 worker 走 `mesh submit`（在它自己的 shell 里跑，shell 的 PATH 有 git），
于是整条链通了。

**建议的正解**（属于平台代码，我没有动）：在 `hub/adapters` 生成 patch 时把 `PATH` 一起写进
MCP server 的 env，或者让 MCP server 的 `submit` 不依赖 PATH（绝对路径解析 git）。

