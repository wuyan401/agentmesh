#Requires -Version 5.1
<#
.SYNOPSIS
    AgentMesh 环境前提自检脚本（四条）。

.DESCRIPTION
    对应 docs/ENVIRONMENT.md 记录的 worker 环境前提，逐条检查，任一不满足即
    打印 FAIL 并以非 0 退出；全部满足打印 PASS 并以 0 退出。

      1. DSH seat 目录存在：$DSH_HOME/profiles/<seat>，未设 DSH_HOME 时是
         ~/.dsh/profiles/<seat>（见 packages/util/home-paths/lib/index.js）
      2. dsh-01 的卡片是 file-protocol
         （MCP 通道下 hub 的 submit 找不到 git，会 spawnSync ENOENT）
      3. 共享 node 仍是 Medium Mandatory Level
         （不能为了 worker 把全机共享的 node 降成 Low，那是给全机埋雷）
      4. 项目目录 icacls 含 HP: 且权限为 (F) 或 (M)
         （worker 的受限令牌要能从 ACL 拿到写权）

    退出码：0 = 全部通过；1 = 至少一条不满足。

.PARAMETER Seat
    DSH seat 名。默认 headless（对应 dsh 卡片的 --profile headless）。

.PARAMETER DshHome
    DSH home。默认取 $env:DSH_HOME；未设则用 ~/.dsh。

.PARAMETER OfficeAgent
    要检查注入方式的 agent id。默认 dsh-01。

.PARAMETER NodeExe
    共享 node 的路径。默认 <HERMES_HOME>\tools\node-26.7.0-win32-x64\node.exe。
    换机器 / 换安装位置时用参数或 MESH_SHARED_NODE 环境变量覆盖。

.PARAMETER ProjectDir
    项目目录。默认本脚本所在 docs 目录的上一级（即仓库根）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File docs/CHECK-ENVIRONMENT.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File docs/CHECK-ENVIRONMENT.ps1 -ProjectDir <WORKSPACE>\mesh-workspace

.NOTES
    已知边界：Low 完整性的 DSH worker 读不了带 AppContainer package-SID ACE 的
    目录（<HERMES_HOME>\tools\* 就是），所以这条 node 检查要在普通（非受限令牌）
    PowerShell 里跑才是可信的；在 worker 沙箱里它会如实报 FAIL（fail closed）。
#>
[CmdletBinding()]
param(
    [string]$Seat = 'headless',
    [string]$DshHome = $env:DSH_HOME,
    [string]$OfficeAgent = 'dsh-01',
    [string]$NodeExe = $(if ($env:MESH_SHARED_NODE) { $env:MESH_SHARED_NODE } else { '<HERMES_HOME>\tools\node-26.7.0-win32-x64\node.exe' }),
    [string]$ProjectDir = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Continue'

# DSH home resolution mirrors packages/util/home-paths/lib/index.js:
# an explicit $DSH_HOME wins, otherwise it is <homedir>/.dsh.
if (-not $DshHome) {
    $DshHome = Join-Path $HOME '.dsh'
}
$SeatDir = Join-Path (Join-Path $DshHome 'profiles') $Seat

# $PSScriptRoot is not reliably populated while parameter defaults are evaluated
# (Windows PowerShell 5.1 + -File), so resolve the project root here instead.
if (-not $ProjectDir) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
    $ProjectDir = Split-Path -Parent $scriptDir
}

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

# The worker's PATH is minimal (it may not contain C:\Windows\System32), so
# never rely on `icacls` resolving through PATH: use the absolute path.
function Resolve-Icacls {
    foreach ($name in @(
            (Join-Path $env:SystemRoot 'System32\icacls.exe'),
            (Join-Path $env:SystemRoot 'Sysnative\icacls.exe')
        )) {
        if (Test-Path -LiteralPath $name -PathType Leaf) { return $name }
    }
    $cmd = Get-Command 'icacls.exe' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

$script:Icacls = Resolve-Icacls
if (-not $script:Icacls) {
    Write-Host 'FAIL'
    Write-Host '  找不到 icacls.exe（本机 System32 与 PATH 都不存在），无法检查完整性标签。'
    exit 1
}

# Runs icacls and returns { Ok, Code, Text }.
function Invoke-Icacls {
    param([Parameter(Mandatory)][string]$Path)

    $out = & $script:Icacls $Path 2>&1
    $code = $LASTEXITCODE
    $text = ($out | ForEach-Object { "$_" }) -join "`n"
    return [pscustomobject]@{ Ok = ($code -eq 0); Code = $code; Text = $text }
}

# Extracts the mandatory label text from icacls output, e.g.
#   Mandatory Label\Low Mandatory Level:(NW)  ->  'Low Mandatory Level'
# Returns $null when the object carries no explicit label (it then inherits one
# from its parent; the default when nothing is labelled is Medium).
function Get-MandatoryLabel {
    param([Parameter(Mandatory)][string]$Text)

    $m = [regex]::Match($Text, 'Mandatory Label\\(?<label>[^:\r\n]+):')
    if ($m.Success) { return $m.Groups['label'].Value.Trim() }
    return $null
}

# Project-directory ACE lines look like one of:
#   HP:(OI)(CI)(F)
#   DESKTOP-XXXX\HP:(I)(OI)(CI)(M)
#   Everyone:(CI)(DENY)(S,DC)
# The machine name may be non-ASCII, so match on the `HP:` suffix only.
function Get-HpAces {
    param([Parameter(Mandatory)][string]$Text)

    $aces = @()
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match '(?:^|[\\\s])HP:') {
            $rights = @([regex]::Matches($line, '\((?<r>[A-Z,]+)\)') |
                    ForEach-Object { $_.Groups['r'].Value })
            $aces += [pscustomobject]@{
                Line   = $line.Trim()
                Rights = $rights
                Deny   = ($rights -contains 'DENY')
            }
        }
    }
    return $aces
}

$passCount = 0
$failCount = 0
$failures = New-Object System.Collections.Generic.List[string]

function Write-Check {
    param(
        [string]$Index,
        [string]$Name,
        [bool]$Pass,
        [string[]]$Detail = @()
    )

    $tag = if ($Pass) { 'PASS' } else { 'FAIL' }
    Write-Host ("[{0}] {1,-34} {2}" -f $Index, $Name, $tag)
    foreach ($d in $Detail) { Write-Host ("       {0}" -f $d) }

    if ($Pass) {
        $script:passCount++
    } else {
        $script:failCount++
        $script:failures.Add($Name)
    }
}

# ---------------------------------------------------------------------------
# 1. DSH seat 目录：<DSH_HOME 或 ~/.dsh>/profiles/<seat>
#
# 这里**不**检查 <DSH_HOME>\profiles：那个路径既不是 CLI 的 home，DSH 也从没往
# 里写过。CLI（node apps/cli/lib/bin.js --profile <seat>）的 home 由
# packages/util/home-paths 解析：$DSH_HOME 优先，未设则 ~/.dsh。
# ---------------------------------------------------------------------------
$seatExists = $false
try {
    $seatExists = Test-Path -LiteralPath $SeatDir -PathType Container -ErrorAction Stop
} catch {
    $seatExists = $false
}

$cordisPath = Join-Path $SeatDir 'cordis.yml'
$cordisExists = Test-Path -LiteralPath $cordisPath -PathType Leaf -ErrorAction SilentlyContinue
$homeNote = if ($env:DSH_HOME) { "`$env:DSH_HOME=$env:DSH_HOME" } else { 'DSH_HOME 未设 → 回退到 ~/.dsh' }

if (-not $seatExists) {
    Write-Check '1/4' 'DSH seat dir' $false @(
        "路径: $SeatDir",
        $homeNote,
        '目录不存在：确认 dsh 卡片里的 --profile 名与 -Seat 一致'
    )
} elseif (-not $cordisExists) {
    Write-Check '1/4' 'DSH seat dir' $false @(
        "路径: $SeatDir",
        $homeNote,
        'cordis.yml 不存在：DSH 还没在这个 home 里写过 profile（跑一次该 seat 即可生成）'
    )
} else {
    $cordisAt = (Get-Item -LiteralPath $cordisPath).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
    Write-Check '1/4' 'DSH seat dir' $true @(
        "路径: $SeatDir",
        $homeNote,
        "cordis.yml: $cordisAt"
    )
}

# ---------------------------------------------------------------------------
# 2. dsh-01 有可用通道：file-protocol，或修复后的 dsh-patch
#
# 历史上 MCP 通道下平台生成的 dsh-hub.patch.yml 只给 hub MCP server 三个环境变量、
# 没有 PATH，hub.submit 内部 spawnSync('git') 因此 ENOENT，卡永远提交不上去。
# 2026-10-29 已修（commit 830144f）：patch 现在带上 PATH/SystemRoot 等 15 个变量，
# 且 hub/core/git.ts 的 resolveGitBinary() 有绝对路径兜底。两种通道都算通过。
# ---------------------------------------------------------------------------
$cardPath = Join-Path (Join-Path (Join-Path $ProjectDir '.mesh') 'agents') "$OfficeAgent.json"
$cardInject = $null
$cardError = $null
try {
    if (-not (Test-Path -LiteralPath $cardPath -PathType Leaf)) {
        $cardError = "卡片不存在: $cardPath"
    } else {
        $card = Get-Content -LiteralPath $cardPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $cardInject = [string]$card.mcp_inject
    }
} catch {
    $cardError = $_.Exception.Message
}

if ($cardError) {
    Write-Check '2/4' 'dsh agent channel' $false @($cardError)
} else {
    $ok = ($cardInject -eq 'file-protocol') -or ($cardInject -eq 'dsh-patch')
    Write-Check '2/4' 'dsh agent channel' $ok @(
        "卡片: .mesh/agents/$OfficeAgent.json",
        "mcp_inject: $cardInject",
        '要求: file-protocol 或 dsh-patch（后者自 830144f 起 patch 已带 PATH）'
    )
}


# ---------------------------------------------------------------------------
# 2. 共享 node：必须是 Medium Mandatory Level
#
# 文档指定的共享 node 在 <HERMES_HOME>\tools\node-<ver>\node.exe。注意：Low 完整性
# 的进程读不了带 AppContainer package-SID ACE 的目录（node 这棵树就是），因此
# worker 沙箱里的 icacls 会 Access denied —— 那是访问边界，不是文件缺失，也不能
# 当作 Medium 的证据；这里一律 fail closed，请在普通 PowerShell 里复核。
# ---------------------------------------------------------------------------
$nodeExists = $false
$nodeProbeError = $null
try {
    $nodeExists = Test-Path -LiteralPath $NodeExe -PathType Leaf -ErrorAction Stop
} catch {
    $nodeExists = $false
    $nodeProbeError = $_.Exception.Message
}

if (-not $nodeExists) {
    $detail = @("路径: $NodeExe")
    if ($nodeProbeError) {
        $detail += "访问被拒: $nodeProbeError"
        $detail += '这是 ACL / 完整性边界，不是“文件缺失”；请在没有受限令牌的普通 PowerShell 里复跑本脚本'
    } else {
        $detail += '文件不存在；不要为了 worker 把它降成 Low（见 docs/ENVIRONMENT.md §2）'
    }
    Write-Check '3/4' 'shared node (Medium)' $false $detail
} else {
    $r = Invoke-Icacls -Path $NodeExe
    $label = Get-MandatoryLabel -Text $r.Text

    if (-not $r.Ok) {
        # Cannot read the security descriptor. That is not proof of Medium, so
        # this is a FAIL (fail closed), with the reason spelled out.
        Write-Check '3/4' 'shared node (Medium)' $false @(
            "路径: $NodeExe",
            ('icacls 失败: ' + $r.Text.Trim()),
            '无法验证完整性标签（fail closed）：请在普通 PowerShell 里复跑本脚本'
        )
    } else {
        # No explicit label means the object inherits its parent's label; with no
        # label anywhere up the tree the effective level is Medium. A `Low`
        # downgrade would always show up as an explicit `Low Mandatory Level`.
        $effective = if ($label) { $label } else { 'Medium Mandatory Level (继承)' }
        $ok = ($label -eq 'Medium Mandatory Level') -or (-not $label)
        Write-Check '3/4' 'shared node (Medium)' $ok @(
            "路径: $NodeExe",
            "实际: $effective"
        )
    }
}

# ---------------------------------------------------------------------------
# 3. 项目目录：HP 的 ACE 且权限为 (F) 或 (M)
# ---------------------------------------------------------------------------
$projectExists = $false
try {
    $projectExists = Test-Path -LiteralPath $ProjectDir -PathType Container -ErrorAction Stop
} catch {
    $projectExists = $false
}

if (-not $projectExists) {
    Write-Check '4/4' 'project dir (HP F/M)' $false @(
        "路径: $ProjectDir",
        '目录不存在或不可访问'
    )
} else {
    $r = Invoke-Icacls -Path $ProjectDir
    if (-not $r.Ok) {
        Write-Check '4/4' 'project dir (HP F/M)' $false @(
            "路径: $ProjectDir",
            ('icacls 失败: ' + $r.Text.Trim())
        )
    } else {
        $aces = @(Get-HpAces -Text $r.Text)
        $strong = $false
        foreach ($a in $aces) {
            if ((-not $a.Deny) -and (($a.Rights -contains 'F') -or ($a.Rights -contains 'M'))) {
                $strong = $true
            }
        }
        $shown = if ($aces.Count -gt 0) { ($aces | ForEach-Object { $_.Line }) -join '; ' } else { '(没有 HP 的 ACE)' }
        Write-Check '4/4' 'project dir (HP F/M)' $strong @(
            "路径: $ProjectDir",
            "HP ACE: $shown",
            '要求: HP 的权限为 (F) 或 (M)'
        )
    }
}

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
Write-Host ''
if ($failCount -eq 0) {
    Write-Host ("SUMMARY: {0}/{0} 通过" -f $passCount)
    Write-Host 'PASS'
    exit 0
}

Write-Host ("SUMMARY: {0} 项通过, {1} 项失败: {2}" -f $passCount, $failCount, ($failures -join ', '))
Write-Host 'FAIL'
exit 1
