# M1 acceptance walk (V2): a 3-card mission driven by hand, no LLM involved.
#
#   powershell -NoProfile -File tests/prove/m1-walk.ps1
#
# What it proves: every mission transition happens through the state machine
# (intake -> planning -> executing -> integrating -> final_review -> rejected ->
# executing -> integrating -> final_review -> completed), with real spawned
# worker/supervisor processes, real commits, real scope-gated merges and a report.
#
# This file must stay UTF-8 **with BOM**: Windows PowerShell 5.1 reads .ps1 as ANSI
# otherwise and every Chinese literal becomes mojibake.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$repo = "<PROJECT>"
$scratch = "<WORKSPACE>\dsh\.mesh-v2-m1"
$meshCli = Join-Path $repo 'cli\mesh.ts'

function mesh {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & node $meshCli @Args 2>&1 | ForEach-Object { "$_" }
}

function missionStatus {
  param([string]$Id)
  return (((mesh mission $Id --json) -join "`n") | ConvertFrom-Json).status
}

function missionJson {
  param([string]$Id)
  return ((mesh mission $Id --json) -join "`n") | ConvertFrom-Json
}

function step {
  param([string]$Text)
  Write-Host "`n=== $Text ===" -ForegroundColor Cyan
}

step "0. scratch project"
if (Test-Path $scratch) { Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
Push-Location $scratch
git init -b main | Out-Null
git config user.name "M1 Walk"
git config user.email "walk@example.com"
Set-Content README.md "# m1 walk scratch"
New-Item -ItemType Directory -Force -Path src | Out-Null
git add -A
git commit -q -m "chore: scratch"
Write-Host "project: $scratch"

step "1. mesh init (no auto-detect) + scripted agents"
mesh init --no-detect | Select-Object -First 6
& node (Join-Path $repo 'tests\fixtures\register-scripted.ts') $scratch

step "2. mesh mission (lead = mesh-human, so the human drives it)"
mesh mission "做一个带登录的博客" --lead mesh-human --accept "登录可用" --accept "文章可增删改查"
$missionId = ((mesh missions --json) -join "`n" | ConvertFrom-Json)[0].mission_id
Write-Host "mission: $missionId" -ForegroundColor Green

step "3. mesh mission lead (a lead session with no process — attribution handle)"
mesh mission lead $missionId | Select-Object -First 2
$lead1 = (missionJson $missionId).lead_session
Write-Host "lead session: $lead1"

step "4. plan_mission (3 cards, serial chain)"
$plan = @'
[
  { "title": "实现登录接口", "role": "backend_dev", "scope": { "write": ["src/auth.ts"] },
    "acceptance": ["POST /api/login 返回 200", "错误密码返回 401"], "why": "接口层" },
  { "title": "实现登录页", "role": "frontend_dev", "scope": { "write": ["src/login.ts"] },
    "acceptance": ["表单含邮箱与密码", "调用 POST /api/login"], "why": "页面层" },
  { "title": "端到端测试", "role": "executor", "scope": { "write": ["test/e2e.ts"] },
    "acceptance": ["覆盖登录成功与失败"], "why": "回归基线" }
]
'@
Set-Content .mesh\plan.json $plan -Encoding UTF8
mesh plan-mission $missionId --file .mesh\plan.json --session $lead1
Write-Host ("mission status: " + (missionStatus $missionId))

step "5. dispatch_mission -> executing"
mesh dispatch-mission $missionId --session $lead1
mesh board | Select-Object -First 8

step "6. mesh up --once loop (real worker + supervisor processes)"
for ($i = 1; $i -le 24; $i++) {
  $before = missionStatus $missionId
  mesh up --once | Select-String -Pattern 'spawn|review|merge|release|mission' | Select-Object -First 4
  Start-Sleep -Milliseconds 1200
  $after = missionStatus $missionId
  if ($after -ne $before) { Write-Host "  mission: $before -> $after" -ForegroundColor Yellow }
  if ($after -in @('integrating', 'final_review', 'completed')) { break }
}
Write-Host ("mission status: " + (missionStatus $missionId)) -ForegroundColor Green
mesh board | Select-Object -First 8

step "7. final_verdict --reject (sends the last card back for rework)"
mesh mission lead $missionId | Select-Object -First 1
$lead2 = (missionJson $missionId).lead_session
$tasks = (missionJson $missionId).task_summaries
$lastTask = $tasks[-1].task_id
Write-Host "rejecting $lastTask (status $($tasks[-1].status))"
mesh final-verdict $missionId --reject --notes "端到端测试只覆盖了成功路径，补失败路径" --reject-task $lastTask --session $lead2
$afterReject = missionJson $missionId
Write-Host ("mission: " + $afterReject.status + " rounds=" + $afterReject.rounds)
Write-Host ("$lastTask status: " + (($afterReject.task_summaries | Where-Object { $_.task_id -eq $lastTask }).status))

step "8. rework: rejected -> executing -> re-merge -> integrating"
for ($i = 1; $i -le 24; $i++) {
  $before = missionStatus $missionId
  mesh up --once | Select-String -Pattern 'spawn|review|merge|release|mission' | Select-Object -First 4
  Start-Sleep -Milliseconds 1200
  $after = missionStatus $missionId
  if ($after -ne $before) { Write-Host "  mission: $before -> $after" -ForegroundColor Yellow }
  if ($after -in @('integrating', 'final_review', 'completed')) { break }
}
Write-Host ("mission status: " + (missionStatus $missionId)) -ForegroundColor Green

step "9. final_verdict --approve, then write_report"
mesh mission lead $missionId | Select-Object -First 1
$lead3 = (missionJson $missionId).lead_session
mesh final-verdict $missionId --approve --notes "三张卡都合并了，打回的那张也补了失败路径" --session $lead3
$summary = missionJson $missionId
$reportLines = @(
  "# 交付报告 · $($summary.title)",
  "",
  "用户原话：$($summary.brief)",
  "",
  "## 结果",
  "",
  "| 任务 | 角色 | 实现 | 审查 | 合并 |",
  "|---|---|---|---|---|"
)
foreach ($t in $summary.task_summaries) {
  $short = if ($t.merge_commit) { $t.merge_commit.Substring(0, 8) } else { '—' }
  $reportLines += "| $($t.task_id) $($t.title) | $($t.role) | $($t.implementer_agent) | $($t.reviewer_agent) | $short |"
}
$reportLines += @(
  "",
  "## 过程",
  "",
  "- 二次验收打回 1 次（$lastTask），返工后重新走独立审查与 scope 终审。",
  "- 全部合并提交都经过 scope 终审（strict 模式，无剥离）。",
  "",
  "## 参与",
  "",
  ($summary.teammates -join "、")
)
Set-Content .mesh\lead-report.md ($reportLines -join "`n") -Encoding UTF8
mesh write-report $missionId --file .mesh\lead-report.md --session $lead3

step "10. final state"
mesh mission $missionId
Write-Host ""
mesh missions
Write-Host "`nreport file:"
Get-Content (Join-Path $scratch ".mesh\missions\$missionId\report.md") -Encoding UTF8 | Select-Object -First 8
Write-Host "`nmain branch:"
git log --oneline | Select-Object -First 8

Pop-Location
Write-Host "`nDONE — mission $missionId" -ForegroundColor Green
