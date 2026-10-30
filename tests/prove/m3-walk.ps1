# M3 acceptance walk: the injection is real — grep it out of a spawned session's log.
#
#   powershell -NoProfile -File tests/prove/m3-walk.ps1
#
# UTF-8 with BOM (Windows PowerShell 5.1 reads .ps1 as ANSI otherwise).

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$repo = "<PROJECT>"
$scratch = "<WORKSPACE>\dsh\.mesh-v2-m3"
$meshCli = Join-Path $repo 'cli\mesh.ts'

function mesh {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & node $meshCli @Args 2>&1 | ForEach-Object { "$_" }
}
function step { param([string]$Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function cardOf([string]$Id) {
  $f = Join-Path $scratch ".mesh\board\tasks\$Id.json"
  if (-not (Test-Path $f)) { return $null }
  return (Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json)
}
function newestLog {
  return (Get-ChildItem (Join-Path $scratch '.mesh\logs') -Filter '*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}
function readShared([string]$path) {
  # The spawned child keeps its log fd open for as long as it runs, so a plain
  # ReadAllText fails with a sharing violation. Read with FileShare.ReadWrite.
  $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
    return $sr.ReadToEnd()
  } finally {
    if ($sr) { $sr.Dispose() }
    $fs.Dispose()
  }
}
function showExcerpt([string]$path, [string]$marker, [int]$length = 900) {
  $text = readShared $path
  $i = $text.IndexOf($marker)
  if ($i -lt 0) { return $null }
  $slice = $text.Substring($i, [Math]::Min($length, $text.Length - $i))
  # The prompt sits inside the log's `cmd:` line as a JSON-escaped argument,
  # so literal \n are the newlines an agent actually sees.
  return ($slice -replace '\\n', "`n" -replace '\\"', '"')
}

step "0. scratch project"
if (Test-Path $scratch) { Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
Push-Location $scratch
git init -b main | Out-Null
git config user.name "M3 Walk"
git config user.email "walk@example.com"
Set-Content README.md "# m3 walk scratch"
New-Item -ItemType Directory -Force -Path src | Out-Null
git add -A; git commit -q -m "chore: scratch"

step "1. init + scripted agents + profile text (so the table has something to say)"
mesh init --no-detect | Select-Object -First 4
& node (Join-Path $repo 'tests\fixtures\register-scripted.ts') $scratch
mesh profile set scripted-01 personality "老实、照契约办事" | Select-Object -First 1
mesh profile set scripted-01 strengths "接口实现,提交规范" | Select-Object -First 1
mesh profile set scripted-01 weaknesses "不做视觉设计" | Select-Object -First 1
mesh profile set scripted-02 personality "挑剔、只看证据" | Select-Object -First 1
mesh profile set scripted-02 strengths "审查,逐条对照验收" | Select-Object -First 1

step "2. mission with a human lead + two cards"
mesh mission "做一个带登录的博客" --lead mesh-human --accept "登录可用" | Select-Object -First 2
mesh mission lead M-000001 | Select-Object -First 1
$lead = (node $meshCli mission M-000001 --json | ConvertFrom-Json).lead_session
$plan = @'
[
  { "title": "实现登录接口", "role": "backend_dev", "scope": { "write": ["src/auth.ts"] },
    "acceptance": ["POST /api/login 返回 200"], "why": "接口层" },
  { "title": "实现登录页", "role": "frontend_dev", "scope": { "write": ["src/login.ts"] },
    "acceptance": ["表单可用"], "why": "页面层" }
]
'@
Set-Content .mesh\plan.json $plan -Encoding UTF8
mesh plan-mission M-000001 --file .mesh\plan.json --session $lead | Select-Object -First 3
mesh dispatch-mission M-000001 --session $lead | Select-Object -First 1

step "3. spawn a real worker for T-000001"
mesh up --once | Select-String -Pattern 'spawn' | Select-Object -First 2
Start-Sleep -Seconds 9
$log = newestLog
Write-Host "session log: $($log.Name)"

step "4. grep the injection out of the session log"
$raw = readShared $log.FullName
$checks = [ordered]@{
  '## 你在哪'          = $raw.Contains('## 你在哪')
  '## 队友'            = $raw.Contains('## 队友')
  'lead：mesh-human'   = $raw.Contains('Lead：mesh-human')
  '自己的 task_id'      = $raw.Contains('T-000001')
  '自己的角色'          = $raw.Contains('角色 backend_dev')
  '队友表头'            = $raw.Contains('| agent | 性格 | 擅长 | 弱势 | 质量分 | 花费 | 本轮负责 |')
  'scripted-01 的性格'  = $raw.Contains('老实、照契约办事')
  '## 这个平台怎么用'   = $raw.Contains('## 这个平台怎么用（速查）')
}
foreach ($k in $checks.Keys) {
  $mark = if ($checks[$k]) { "OK  " } else { "MISS" }
  $color = if ($checks[$k]) { 'Green' } else { 'Red' }
  Write-Host ("  [{0}] {1}" -f $mark, $k) -ForegroundColor $color
}
Write-Host "`n--- 日志里 agent 实际看到的节选 ---" -ForegroundColor Cyan
Write-Host (showExcerpt $log.FullName '## 你在哪' 1200)

step "5. the same package on disk (what claim_task hands over)"
$ctx = Join-Path $scratch '.mesh\context\T-000001.md'
$ctxRaw = [System.IO.File]::ReadAllText($ctx, [System.Text.Encoding]::UTF8)
Write-Host ("context file: .mesh/context/T-000001.md ({0} bytes)" -f $ctxRaw.Length)
foreach ($m in @('## 你在哪', '## 队友', 'Lead：mesh-human', 'T-000001', '角色 backend_dev')) {
  Write-Host ("  [{0}] {1}" -f $(if ($ctxRaw.Contains($m)) { 'OK  ' } else { 'MISS' }), $m)
}

step "6. the structured version (same rows as the table)"
mesh teammates M-000001

step "7. minimal level: the next worker must NOT get the teammate table"
# finish card 1 so card 2 unlocks (worker + supervisor do the work)
for ($i = 1; $i -le 12; $i++) {
  mesh up --once | Out-Null
  Start-Sleep -Milliseconds 1500
  if ((cardOf 'T-000001').status -eq 'merged') { break }
}
Write-Host ("T-000001 = " + (cardOf 'T-000001').status)
mesh config set context_level minimal | Select-Object -First 1
$before = (Get-ChildItem (Join-Path $scratch '.mesh\logs') -Filter '*.log' | Measure-Object).Count
mesh up --once | Select-String -Pattern 'spawn' | Select-Object -First 2
Start-Sleep -Seconds 9
$log2 = newestLog
$raw2 = readShared $log2.FullName
Write-Host ("session log: " + $log2.Name)
Write-Host ("  [{0}] ## 你在哪（紧凑）" -f $(if ($raw2.Contains('## 你在哪（紧凑）')) { 'OK  ' } else { 'MISS' }))
Write-Host ("  [{0}] ## 队友（minimal 档必须没有）" -f $(if ($raw2.Contains('## 队友')) { 'MISS' } else { 'OK  ' }))
Write-Host ("  [{0}] ## 这个平台怎么用（minimal 档必须没有）" -f $(if ($raw2.Contains('## 这个平台怎么用')) { 'MISS' } else { 'OK  ' }))
Write-Host "`n--- minimal 档 agent 看到的 ---" -ForegroundColor Cyan
Write-Host (showExcerpt $log2.FullName '## 你在哪' 420)

Pop-Location
Write-Host "`nDONE" -ForegroundColor Green
