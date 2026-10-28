# M2 acceptance walk: scoring changes who gets the work, and a twice-rejected card
# changes hands — with real processes, no LLM.
#
#   powershell -NoProfile -File tests/prove/m2-walk.ps1
#
# UTF-8 with BOM (Windows PowerShell 5.1 reads .ps1 as ANSI otherwise).

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$repo = "D:\AI\workspace\dsh\agentmesh"
$scratch = "D:\AI\workspace\dsh\.mesh-v2-m2"
$meshCli = Join-Path $repo 'cli\mesh.ts'

function mesh {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & node $meshCli @Args 2>&1 | ForEach-Object { "$_" }
}
function step { param([string]$Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
# Read the card file directly: the file IS the truth, and it avoids array plumbing.
function cardOf([string]$Id) {
  $f = Join-Path $scratch ".mesh\board\tasks\$Id.json"
  if (-not (Test-Path $f)) { return $null }
  return (Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json)
}
function brief([string]$Id) {
  $c = cardOf $Id
  if (-not $c) { return "$Id (none)" }
  return ("{0} status={1} impl={2} rejections={3} rejected_by=[{4}]" -f $Id, $c.status, $c.implementer_agent, $c.rejection_count, ($c.rejected_by -join ','))
}

step "0. scratch project"
if (Test-Path $scratch) { Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
Push-Location $scratch
git init -b main | Out-Null
git config user.name "M2 Walk"
git config user.email "walk@example.com"
Set-Content README.md "# m2 walk scratch"
New-Item -ItemType Directory -Force -Path src | Out-Null
git add -A; git commit -q -m "chore: scratch"

step "1. init + four scripted agents (01 and 03 are interchangeable workers)"
mesh init --no-detect | Select-Object -First 4
& node (Join-Path $repo 'tests\fixtures\register-scripted.ts') $scratch

step "2. profiles on day one (nine dimensions, §2.2 defaults)"
mesh profile list

step "3. two identical workers -> the tie-break must be agent_id (scripted-01)"
mesh new "实现限流器" --role executor --write src/rate.ts --accept "能限流" | Select-Object -First 2
mesh up --once | Select-String -Pattern 'spawn' | Select-Object -First 2
Write-Host ("T-000001 implementer = " + (cardOf 'T-000001').implementer_agent)

step "4. hand-edit scripted-03 -> the NEXT dispatch must obey it"
mesh profile set scripted-03 quality_score 95
mesh new "实现缓存层" --role executor --write src/cache.ts --accept "能缓存" | Select-Object -First 2
mesh up --once | Select-String -Pattern 'spawn|review' | Select-Object -First 2
Write-Host ("T-000002 implementer = " + (cardOf 'T-000002').implementer_agent + "   (expected scripted-03)")

step "5. reassignment: the bad worker has one shot too many, then §2.3 excludes it"
# Scores are set far apart on purpose: the switch must happen because the rejectees are
# excluded, not because another agent happens to score higher.
mesh profile set scripted-bad quality_score 99
mesh profile set scripted-01 quality_score 40
mesh profile set scripted-03 quality_score 40
mesh new "实现导出功能" --role executor --write src/export.ts --accept "能导出" | Select-Object -First 2
Write-Host ("T-000003 starts as: " + (brief 'T-000003'))
for ($i = 1; $i -le 26; $i++) {
  $before = cardOf 'T-000003'
  mesh up --once | Select-String -Pattern 'spawn|review|merge|block|requeued' | Select-Object -First 2
  Start-Sleep -Milliseconds 1600
  $after = cardOf 'T-000003'
  if ($after.status -ne $before.status -or $after.implementer_agent -ne $before.implementer_agent) {
    Write-Host ("  T-000003: {0}/{1} -> {2}/{3}  (rejections={4})" -f $before.status, $before.implementer_agent, $after.status, $after.implementer_agent, $after.rejection_count) -ForegroundColor Yellow
  }
  if ($after.status -eq 'merged') { break }
}
Write-Host ("T-000003 final: " + (brief 'T-000003')) -ForegroundColor Green

step "6. what the profiles learned"
mesh profile list
Write-Host ""
mesh profile show scripted-bad | Select-Object -First 16

step "7. board + main branch"
mesh board
Write-Host ""
git log --oneline | Select-Object -First 8

Pop-Location
Write-Host "`nDONE" -ForegroundColor Green
