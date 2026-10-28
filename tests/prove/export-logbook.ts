/**
 * Export a real run logbook from a project's `.mesh/` into markdown.
 *
 * The acceptance report must quote what actually happened, not what we remember
 * happening. This script reads the collaboration space and renders it, so the
 * numbers and commits in the report can always be re-derived.
 *
 *   node tests/prove/export-logbook.ts <project-dir> > docs/RUN-LOGBOOK.md
 */

import fs from 'node:fs'
import path from 'node:path'
import { Hub } from '../../hub/core/hub.ts'
import { MeshPaths } from '../../hub/core/paths.ts'
import { Sentinel } from '../../hub/sentinel/sentinel.ts'

const projectDir = process.argv[2] ?? process.cwd()
const paths = MeshPaths.discover(projectDir)
const hub = new Hub(paths)
const state = hub.store.getState()
const tasks = hub.store.listTasks()
const sessions = hub.store.listSessions()
const reviews = hub.store.listReviews()
const merges = hub.store.merges()
const violations = hub.store.violations()
const messages = hub.store.logMessages()

const out: string[] = []
const p = (s = ''): void => {
  out.push(s)
}

p(`# 真实运行记录 · ${state.project}`)
p()
p(`> 本文件由 \`tests/prove/export-logbook.ts\` 从 \`.mesh/\` 直接导出，不含手写内容。`)
p()
p(`- 导出时间：${new Date().toISOString()}`)
p(`- 项目目录：\`${paths.root}\``)
p(`- 主分支：\`${state.main_branch}\`，基线 \`${(state.base_commit ?? '').slice(0, 8)}\``)
p(`- 初始化：${state.created_at}`)
p()

p('## 看板')
p()
p('| 任务 | 角色 | 状态 | 标题 | scope | 实现者 | 审查者 | 合并 |')
p('|---|---|---|---|---|---|---|---|')
for (const t of tasks) {
  const taskReviews = reviews.filter((r) => r.task_id === t.task_id)
  const reviewer = taskReviews.length > 0 ? taskReviews[taskReviews.length - 1]!.reviewer_agent : '—'
  const merged = t.merge ? `\`${t.merge.merge_commit.slice(0, 8)}\` (${t.merge.mode})` : '—'
  p(
    `| ${t.task_id} | ${t.role} | ${t.status} | ${t.title.replace(/\|/g, '\\|')} | ${t.scope.write.join('<br>')} | ${t.implementer_agent ?? '—'} | ${reviewer} | ${merged} |`,
  )
}
p()

p('## 逐卡详情')
p()
for (const t of tasks) {
  p(`### ${t.task_id} · ${t.title}`)
  p()
  p(`- 角色：${t.role}　状态：**${t.status}**${t.merge ? `（已合并 \`${t.merge.merge_commit.slice(0, 8)}\`，模式 ${t.merge.mode}）` : ''}`)
  p(`- 分支：\`${t.branch}\`　沙箱：\`${t.worktree ?? '—'}\``)
  p(`- 依赖：${t.depends_on.length > 0 ? t.depends_on.join(', ') : '无'}`)
  p(`- scope.write：${t.scope.write.map((s) => `\`${s}\``).join('、')}`)
  p()
  p('验收标准：')
  t.acceptance.forEach((a, i) => p(`${i + 1}. ${a}`))
  p()
  if (t.submission) {
    p(`提交：\`${t.submission.commit.slice(0, 8)}\` · ${t.submission.summary.replace(/\n+/g, ' ').slice(0, 400)}`)
    p()
    p(`改动文件：${t.submission.files.map((f) => `\`${f}\``).join('、')}`)
    p()
  }
  const taskReviews = reviews.filter((r) => r.task_id === t.task_id)
  if (taskReviews.length > 0) {
    for (const r of taskReviews) {
      p(`审查 \`${r.review_id}\` · **${r.verdict}** · 审查者 \`${r.reviewer_agent}\`（独立=${r.independent}）`)
      p()
      for (const c of r.criteria) {
        p(`- ${c.pass ? '✔' : '✖'} ${c.criterion} — ${String(c.evidence).replace(/\n+/g, ' ').slice(0, 300)}`)
      }
      if (r.notes) p(`- 说明：${r.notes.replace(/\n+/g, ' ').slice(0, 300)}`)
      p()
    }
  }
  p('状态轨迹：')
  for (const h of t.history) p(`- \`${h.at.slice(11, 19)}\` ${h.from ?? '∅'} → **${h.to}**${h.note ? `　${h.note.slice(0, 120)}` : ''}`)
  p()
}

p('## 合并账本')
p()
if (merges.length === 0) p('_（无）_')
else {
  p('| 时间 | 任务 | 合并提交 | 模式 | 文件 | 剥离 |')
  p('|---|---|---|---|---|---|')
  for (const m of merges) {
    const files = Array.isArray(m['files']) ? (m['files'] as string[]) : []
    const stripped = Array.isArray(m['stripped']) ? (m['stripped'] as string[]) : []
    p(
      `| ${String(m['at']).slice(0, 19).replace('T', ' ')} | ${String(m['task_id'])} | \`${String(m['merge_commit']).slice(0, 8)}\` | ${String(m['mode'])} | ${files.length} | ${stripped.length > 0 ? stripped.join('<br>') : '—'} |`,
    )
  }
}
p()

p('## 会话')
p()
p('| 会话 | Agent | 角色 | 任务 | 状态 | PID | 生命周期 | hello | 出口 |')
p('|---|---|---|---|---|---|---|---|---|')
for (const s of sessions) {
  p(
    `| ${s.session_id} | ${s.agent_id} | ${s.role} | ${s.task ?? '—'} | ${s.status} | ${s.pid ?? '—'} | ${s.lifespan} | ${s.hello_at ? '✔' : '—'} | ${s.exit ? `code ${s.exit.code ?? '?'}` : '—'} |`,
  )
}
p()

p('## 消息总线')
p()
const byType = new Map<string, number>()
for (const m of messages) byType.set(m.type, (byType.get(m.type) ?? 0) + 1)
p(`共 ${messages.length} 条：${[...byType.entries()].map(([k, v]) => `${k}×${v}`).join('、') || '无'}`)
p()
const queued = messages.filter((m) => m.resolved === null)
if (queued.length > 0) {
  p(`其中 ${queued.length} 条因角色空缺进入队列（宿主角色当时无人），会由下一个接手者收到：`)
  p()
  for (const m of queued.slice(0, 10)) p(`- \`${m.msg_id}\` → ${m.to.role}:${m.thread} · ${m.type} · ${m.body.slice(0, 100).replace(/\n/g, ' ')}`)
  p()
}

p('## 审计')
p()
p(`违规记录 ${violations.length} 条（detect-only）。`)
p()
if (violations.length > 0) {
  p('| 时间 | 类型 | 级别 | 任务 | 说明 |')
  p('|---|---|---|---|---|')
  for (const v of violations) {
    p(`| ${v.at.slice(0, 19).replace('T', ' ')} | ${v.kind} | ${v.severity} | ${v.task_id ?? '—'} | ${v.detail.replace(/\|/g, '\\|').slice(0, 160)} |`)
  }
  p()
}

p('## 主分支最终历史')
p()
const log = hub.git.run(['log', '--oneline', '--graph', '--decorate', '-n', '40'], { allowFailure: true }).stdout.trim()
p('```')
p(log || '(no commits)')
p('```')
p()

p('## 主分支文件树')
p()
const tree = hub.git.run(['ls-tree', '-r', '--name-only', 'HEAD'], { allowFailure: true }).stdout.trim()
p('```')
p(tree || '(empty)')
p('```')
p()

p('## Sentinel 复核')
p()
const scan = new Sentinel(hub).scan({ record: false, notify: false, writeArtifact: false })
p(`- 扫描任务分支：${scan.checked.tasks}　会话：${scan.checked.sessions}　主line 提交：${scan.checked.main_commits}　审查记录：${scan.checked.reviews}`)
p(`- 发现：${scan.findings.length} 条`)
for (const f of scan.findings) p(`  - ${f.kind} (${f.severity}) ${f.detail}`)
p()
p(`- 结论：${scan.findings.length === 0 ? '**0 协议外合并，0 越界写入**' : '见上'}`)

const text = `${out.join('\n')}\n`
const target = process.argv[3]
if (target) {
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true })
  fs.writeFileSync(path.resolve(target), text)
  process.stderr.write(`wrote ${target}\n`)
} else {
  process.stdout.write(text)
}
