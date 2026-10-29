/**
 * Human-facing commands: the operator console.
 *
 * A human's authority is real: `mesh verdict` and `mesh merge` run as the
 * `mesh-human` agent, so an override is attributed, and still has to go through
 * the same review and scope-gate code as an agent would.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { initMesh, renderInitReport } from '../hub/core/init.ts'
import { HubApi } from '../hub/core/api.ts'
import { MeshError, MESH_ERRORS } from '../hub/core/errors.ts'
import { resolveGitBinary } from '../hub/core/git.ts'
import { loadConfig, patchConfig } from '../hub/core/config.ts'
import { Scheduler } from '../hub/scheduler/scheduler.ts'
import { Hub } from '../hub/core/hub.ts'
import { Sentinel } from '../hub/sentinel/sentinel.ts'
import { detectAgents, defaultDetectContext } from '../hub/adapters/detect.ts'
import { ROLE_CARDS, getRoleCard, isRoleId } from '../hub/roles/cards.ts'
import { ensureMeshRef, scopeCheck } from '../hub/core/mergeGate.ts'
import { isProcessAlive } from '../hub/core/lock.ts'
import { buildTeammates } from '../hub/core/teammates.ts'
import { sleepSync, writeJsonAtomic } from '../hub/core/fsx.ts'
import type { RoleId } from '../hub/core/types.ts'
import {
  bool,
  duration,
  list,
  num,
  printJson,
  relativeTime,
  requireHub,
  statusBadge,
  str,
  style,
  table,
  tryHub,
} from './common.ts'
import type { ParsedArgs } from './common.ts'

const HUMAN_AGENT = 'mesh-human'

/** Ensure the human operator has a Session to act through (attributed, audited). */
export function humanIdentity(hub: Hub, role: RoleId): { identity: ReturnType<Hub['identity']['requireIdentity']>; session_id: string } {
  let agent = hub.store.getAgent(HUMAN_AGENT)
  if (!agent) {
    agent = {
      agent_id: HUMAN_AGENT,
      display_name: 'Human operator (mesh CLI)',
      kind: 'builtin',
      enabled: true,
      command: '',
      args: [],
      capabilities: ['coordinator', 'supervisor', 'integrator', 'planner', 'architect', 'lead'],
      concurrency: 1,
      cost_tier: 1,
      transport: 'in-process',
      mcp_inject: 'none',
      extra_env: {},
      strip_env: [],
      prompt_mode: 'arg',
      prompt_flag: null,
      headless_args: [],
      ttl_seconds: 3600,
      notes: 'the person at the keyboard; used for manual verdict/merge/board edits',
    }
    hub.store.saveAgent(agent)
  }
  const live = hub.store.liveSessions().find((s) => s.agent_id === HUMAN_AGENT && s.role === role)
  if (live) {
    return { identity: hub.identity.requireIdentity(live.session_id), session_id: live.session_id }
  }
  const session = hub.identity.createSession({
    agent_id: HUMAN_AGENT,
    role,
    spawned_by: 'mesh.cli',
    lifespan: 'daemon',
    ttl_seconds: 86_400,
  })
  hub.identity.hello(session.session_id)
  return { identity: hub.identity.requireIdentity(session.session_id), session_id: session.session_id }
}

// ---------------------------------------------------------------------------
// init / status / doctor
// ---------------------------------------------------------------------------

export function cmdInit(parsed: ParsedArgs): number {
  const root = str(parsed, 'dir') ?? process.cwd()
  const result = initMesh({ root, detect: !bool(parsed, 'no-detect'), ensureCommit: !bool(parsed, 'no-commit') })
  process.stdout.write(`${renderInitReport(result)}\n`)
  return 0
}

export function cmdStatus(parsed: ParsedArgs, hub: Hub): number {
  const summary = hub.board.summary()
  const sessions = hub.store.liveSessions()
  const agents = hub.store.listAgents()
  const config = loadConfig(hub.paths)
  const lastMerge = (hub.store.merges().at(-1) ?? null) as Record<string, unknown> | null
  const violations = hub.store.violations()

  if (bool(parsed, 'json')) {
    printJson({
      project: hub.store.getState().project,
      board: summary,
      sessions: sessions.map((s) => ({ id: s.session_id, role: s.role, agent: s.agent_id, task: s.task, status: s.status, pid: s.pid })),
      agents: agents.map((a) => ({ id: a.agent_id, kind: a.kind, enabled: a.enabled, caps: a.capabilities.length })),
      config,
      violations: violations.length,
      last_merge: lastMerge,
    })
    return 0
  }

  const state = hub.store.getState()
  process.stdout.write(`${style.bold(state.project)} ${style.dim(`· ${hub.paths.meshDir}`)}\n`)
  process.stdout.write(`${style.dim(`main: ${state.main_branch} @ ${(state.base_commit ?? '').slice(0, 8)}`)}\n\n`)

  const boardRows = Object.entries(summary.counts)
    .sort()
    .map(([s, c]) => [statusBadge(s), String(c)])
  process.stdout.write(`${table(['看板', '数量'], boardRows)}\n\n`)

  const sessionRows = sessions.map((s) => [
    s.session_id,
    statusBadge(s.status),
    s.role,
    s.agent_id,
    s.task ?? style.dim('-'),
    s.pid ? String(s.pid) : style.dim('-'),
    relativeTime(s.last_heartbeat_at),
  ])
  process.stdout.write(`${style.bold('活跃会话')}\n${table(['会话', '状态', '角色', 'Agent', '任务', 'PID', '心跳'], sessionRows)}\n\n`)

  const agentRows = agents.map((a) => [
    a.agent_id,
    a.kind,
    a.enabled ? style.green('on') : style.dim('off'),
    `${a.capabilities.length} roles`,
    String(a.concurrency),
    a.transport,
  ])
  process.stdout.write(`${style.bold('Agent')}\n${table(['Agent', '类型', '状态', '能力', '并发', '通道'], agentRows)}\n\n`)

  process.stdout.write(
    `${style.bold('配置')}  auto_integrate=${config.auto_integrate ? 'on' : 'off'}  auto_review=${config.auto_review ? 'on' : 'off'}  coordinator=${config.coordinator_agent ?? '-'}\n`,
  )
  const openMissions = hub.store.listMissions().filter((m) => !['completed', 'cancelled'].includes(m.status))
  if (openMissions.length > 0) {
    process.stdout.write(`\n${style.bold('Mission')}\n`)
    for (const m of openMissions.slice(-5)) {
      const view = hub.missions.getView(m.mission_id)
      process.stdout.write(
        `  ${m.mission_id} ${statusBadge(m.status)} ${m.title.slice(0, 36)}  ${view.progress.merged}/${view.progress.total}  lead ${m.lead_agent}\n`,
      )
    }
  }
  if (violations.length > 0) {
    const recent = violations.slice(-3)
    process.stdout.write(`\n${style.yellow(`⚠ ${violations.length} 条审计记录`)}\n`)
    for (const v of recent) process.stdout.write(`  ${style.dim(v.at.slice(11, 19))} ${v.kind} ${v.detail.slice(0, 90)}\n`)
  }
  if (lastMerge) {
    process.stdout.write(`\n${style.dim(`最近合并 ${String(lastMerge['task_id'])} → ${String(lastMerge['merge_commit']).slice(0, 8)} (${String(lastMerge['mode'])})`)}\n`)
  }
  return 0
}

export function cmdDoctor(parsed: ParsedArgs): number {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  const push = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

  const [major = 0, minor = 0] = process.versions.node.split('.').map((n) => Number(n))
  push('node >= 22.6 (native TS + node:sqlite)', major > 22 || (major === 22 && minor >= 6), `node ${process.versions.node}`)

  const gitVersion = spawnSync(resolveGitBinary(), ['--version'], { encoding: 'utf8', windowsHide: true })
  push('git available', gitVersion.status === 0, (gitVersion.stdout ?? '').trim() || 'not found')

  const hub = tryHub()
  push('mesh initialised (.mesh/state.json)', Boolean(hub), hub?.paths.meshDir ?? 'run `mesh init`')
  if (!hub) {
    printChecks(checks, parsed)
    return 1
  }

  // MCP server handshake: does it expose tools over stdio?
  try {
    const serverPath = path.join(hub.paths.root, '..', 'agentmesh', 'hub', 'mcp', 'server.ts')
    const fallback = path.resolve(import.meta.dirname, '..', 'hub', 'mcp', 'server.ts')
    const target = fs.existsSync(serverPath) ? serverPath : fallback
    const res = spawnSync(process.execPath, [target, '--list-tools'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    const tools = JSON.parse(res.stdout || '[]') as Array<{ name: string }>
    push('hub MCP server exposes tools', tools.length > 10, `${tools.length} tools`)
  } catch (e) {
    push('hub MCP server exposes tools', false, (e as Error).message)
  }

  const agents = hub.store.listAgents()
  for (const agent of agents) {
    if (agent.kind === 'builtin') {
      push(`agent ${agent.agent_id} (builtin)`, true, agent.notes)
      continue
    }
    if (!agent.enabled) {
      // A disabled recipe for a CLI that is not installed is not a fault.
      push(`agent ${agent.agent_id} (${agent.kind})`, true, `disabled — recipe kept for portability (${agent.notes})`)
      continue
    }
    const probe = spawnSync(agent.command, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    })
    const ok = probe.status === 0 || Boolean(probe.stdout)
    push(`agent ${agent.agent_id} (${agent.kind})`, ok, ok ? `${agent.command} · channel ${agent.mcp_inject}` : `cannot run ${agent.command}`)
  }

  const state = hub.store.getState()
  const baseOk = Boolean(hub.git.headSha())
  push('git HEAD exists', baseOk, hub.git.headSha()?.slice(0, 8) ?? 'no commits')
  push('main branch recorded', Boolean(state.main_branch), state.main_branch)

  const sandboxes = hub.git.listSandboxes(hub.paths.worktreesDir)
  push('task sandboxes (self-contained clones)', true, `${sandboxes.length} under .mesh/worktrees`)

  const staleLocks = fs.existsSync(hub.paths.locksDir)
    ? fs.readdirSync(hub.paths.locksDir).filter((f) => {
        try {
          const body = JSON.parse(fs.readFileSync(path.join(hub.paths.locksDir, f), 'utf8')) as { pid?: number }
          return body.pid ? !isProcessAlive(body.pid) : false
        } catch {
          return true
        }
      })
    : []
  push('no stale locks', staleLocks.length === 0, staleLocks.length ? staleLocks.join(', ') : 'clean')

  const decisions = fs.existsSync(hub.paths.decisionsFile)
  push('decisions.md present', decisions, hub.paths.rel(hub.paths.decisionsFile))

  const quickref = fs.existsSync(path.join(path.dirname(hub.paths.meshDir), 'PROTOCOL.md'))
  push('protocol snapshot', fs.existsSync(hub.paths.protocolSnapshot), hub.paths.rel(hub.paths.protocolSnapshot))
  void quickref

  const failures = checks.filter((c) => !c.ok).length
  printChecks(checks, parsed)
  process.stdout.write(
    failures === 0 ? `\n${style.green('✔ 全部检查通过')}\n` : `\n${style.red(`✖ ${failures} 项需要处理`)}\n`,
  )
  return failures === 0 ? 0 : 1
}

function printChecks(checks: Array<{ name: string; ok: boolean; detail: string }>, parsed: ParsedArgs): void {
  if (bool(parsed, 'json')) {
    printJson(checks)
    return
  }
  for (const c of checks) {
    process.stdout.write(`${c.ok ? style.green('✔') : style.red('✖')} ${c.name}\n   ${style.dim(c.detail)}\n`)
  }
}

// ---------------------------------------------------------------------------
// board / tasks
// ---------------------------------------------------------------------------

export function cmdBoard(parsed: ParsedArgs, hub: Hub): number {
  const status = str(parsed, 'status')
  const tasks = hub.board.board({
    status: status ? (status.includes(',') ? (status.split(',') as never) : (status as never)) : undefined,
    role: (str(parsed, 'role') as RoleId) ?? undefined,
  })
  if (bool(parsed, 'json')) {
    printJson(tasks.map((t) => ({ ...t, history: undefined, submission: t.submission })))
    return 0
  }
  const rows = tasks.map((t) => [
    t.task_id,
    statusBadge(t.status),
    t.role,
    t.title.length > 42 ? `${t.title.slice(0, 41)}…` : t.title,
    t.scope.write.length > 0 ? (t.scope.write[0]!.length > 24 ? `${t.scope.write[0]!.slice(0, 23)}…` : t.scope.write[0]!) : '-',
    t.reviews.length > 0 ? String(t.reviews.length) : style.dim('-'),
    relativeTime(t.updated_at),
  ])
  process.stdout.write(`${table(['任务', '状态', '角色', '标题', 'scope', '审查', '更新'], rows)}\n`)
  const summary = hub.board.summary()
  process.stdout.write(`\n${style.dim(`共 ${summary.total} 张卡 · ${Object.entries(summary.counts).map(([k, v]) => `${k}:${v}`).join(' · ')}`)}\n`)
  return 0
}

export function cmdTask(parsed: ParsedArgs, hub: Hub): number {
  const taskId = parsed.positionals[0]
  if (!taskId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh task <T-000001>')
  const task = hub.store.requireTask(taskId)
  if (bool(parsed, 'json')) {
    printJson(task)
    return 0
  }
  process.stdout.write(`${style.bold(task.task_id)} ${task.title}  ${statusBadge(task.status)}\n\n`)
  process.stdout.write(`角色      ${task.role}\n`)
  process.stdout.write(`分支      ${task.branch}${task.base_commit ? `  base ${task.base_commit.slice(0, 8)}` : ''}\n`)
  process.stdout.write(`沙箱      ${task.worktree ?? '-'}\n`)
  process.stdout.write(`依赖      ${task.depends_on.length ? task.depends_on.join(', ') : '-'}\n`)
  process.stdout.write(`领取      ${task.claimed_by ?? '-'}${task.implementer_agent ? ` （${task.implementer_agent}）` : ''}\n`)
  process.stdout.write(`scope     write: ${task.scope.write.join(', ')}\n`)
  if (task.scope.read.length) process.stdout.write(`          read : ${task.scope.read.join(', ')}\n`)
  process.stdout.write(`\n${style.bold('验收标准')}\n`)
  task.acceptance.forEach((a, i) => process.stdout.write(`  ${i + 1}. ${a}\n`))
  if (task.submission) {
    process.stdout.write(`\n${style.bold('提交')} ${task.submission.commit.slice(0, 8)} · ${task.submission.summary}\n`)
    process.stdout.write(`  文件: ${task.submission.files.join(', ')}\n`)
  }
  if (task.reviews.length > 0) {
    process.stdout.write(`\n${style.bold('审查记录')}\n`)
    for (const r of hub.store.listReviews(task.task_id)) {
      const mark = r.verdict === 'approved' ? style.green('approved') : style.red('rejected')
      process.stdout.write(`  ${r.review_id} ${mark} by ${r.reviewer_agent} · ${r.notes.slice(0, 100)}\n`)
      for (const c of r.criteria) process.stdout.write(`     ${c.pass ? style.green('✔') : style.red('✖')} ${c.criterion} — ${c.evidence}\n`)
    }
  }
  if (task.merge) {
    process.stdout.write(`\n${style.bold('合并')} ${task.merge.merge_commit.slice(0, 8)} · ${task.merge.mode}${task.merge.stripped.length ? ` · 剥离 ${task.merge.stripped.join(', ')}` : ''}\n`)
  }
  if (task.blocked_reason) process.stdout.write(`\n${style.yellow('阻塞')} ${task.blocked_reason}\n`)
  process.stdout.write(`\n${style.dim('历史')}\n`)
  for (const h of task.history.slice(-8)) {
    process.stdout.write(`  ${style.dim(h.at.slice(11, 19))} ${h.from ?? '∅'} → ${h.to}  ${style.dim(h.note ?? '')}\n`)
  }
  let check: ReturnType<typeof scopeCheck> | null = null
  try {
    if (task.base_commit) {
      const ref = ensureMeshRef(hub.git, hub.paths, task)
      check = scopeCheck(hub.git, task, { rev: ref })
    }
  } catch {
    check = null
  }
  if (check) {
    process.stdout.write(
      check.ok
        ? `\n${style.green('scope 终审预检：干净')}\n`
        : `\n${style.red(`scope 终审预检：${check.out_of_scope.length} 个越界文件`)} ${check.out_of_scope.join(', ')}\n`,
    )
  }
  return 0
}

export function cmdNew(parsed: ParsedArgs, hub: Hub): number {
  const title = parsed.positionals.join(' ')
  if (!title) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh new "标题" --role backend_dev --write src/x/** --accept "条目"')
  const role = (str(parsed, 'role') ?? 'backend_dev') as RoleId
  if (!isRoleId(role)) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `unknown role: ${role}`)
  const write = list(parsed, 'write')
  const read = list(parsed, 'read')
  const accept = list(parsed, 'accept')
  const deps = list(parsed, 'dep')
  if (write.length === 0) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'at least one --write glob is required (scope.write)')
  if (accept.length === 0) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'at least one --accept criterion is required')
  const { identity, label } = actorFor(hub, 'planner', parsed)
  const task = hub.board.createTask(
    { title, role, scope: { write, read }, acceptance: accept, depends_on: deps, publish: !bool(parsed, 'draft') },
    identity,
  )
  process.stdout.write(`${style.green('✔')} ${task.task_id} ${statusBadge(task.status)} ${task.title}  ${style.dim(`by ${label}`)}\n`)
  process.stdout.write(`  scope ${task.scope.write.join(', ')}\n  acceptance ${task.acceptance.length} 条\n`)
  return 0
}

export function cmdAssign(parsed: ParsedArgs, hub: Hub): number {
  const taskId = parsed.positionals[0]
  if (!taskId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh assign <T-000001> [--agent dsh-01]')
  const task = hub.store.requireTask(taskId)
  const scheduler = new Scheduler(hub)
  const recovered = scheduler.recover()
  if (recovered.released.length > 0) {
    process.stdout.write(`${style.yellow('↺')} 回收了 ${recovered.released.length} 个失联任务：${recovered.released.map((r) => r.task_id).join(', ')}\n`)
  }
  const agentId = str(parsed, 'agent')
  const agent = agentId ? hub.store.requireAgent(agentId) : scheduler.pickAgent(task.role, task)
  if (!agent) throw new MeshError(MESH_ERRORS.CAPABILITY_MISSING, `no eligible agent for role ${task.role}`)
  if (!agent.capabilities.includes(task.role)) {
    throw new MeshError(MESH_ERRORS.CAPABILITY_MISSING, `${agent.agent_id} cannot take role ${task.role}`, {
      capabilities: agent.capabilities,
    })
  }
  const conflict = hub.identity.sodConflict(task, agent.agent_id, task.role)
  if (conflict) throw new MeshError(MESH_ERRORS.SOD_VIOLATION, conflict)
  if (task.status !== 'ready' && task.status !== 'rejected') {
    throw new MeshError(MESH_ERRORS.TRANSITION_ILLEGAL, `task ${taskId} is ${task.status}; only ready/rejected can be dispatched`)
  }
  if (task.status === 'rejected') hub.board.publishTask(taskId) // rejected → ready path for rework dispatch
  const record = scheduler.spawnWorker(hub.store.requireTask(taskId), agent)
  process.stdout.write(`${style.green('✔')} 已派发 ${taskId} → ${agent.agent_id}\n`)
  process.stdout.write(`  session ${record.session_id}  pid ${record.pid ?? '-'}\n`)
  process.stdout.write(`  注入    ${record.injection}\n`)
  process.stdout.write(`  日志    ${record.log}\n`)
  if (bool(parsed, 'wait')) {
    process.stdout.write(`\n${style.dim('等待进程结束…')}\n`)
    const deadline = Date.now() + (duration(parsed, 'timeout') ?? 900_000)
    while (Date.now() < deadline) {
      const s = hub.store.getSession(record.session_id)
      if (!s || s.status !== 'active' || !s.pid || !isProcessAlive(s.pid)) break
      sleepSync(500)
    }
    process.stdout.write(`${scheduler.recentLog(record.session_id, 40)}\n`)
  }
  return 0
}

// ---------------------------------------------------------------------------
// agents / sessions
// ---------------------------------------------------------------------------

/** Human view of the artifact store (channel C deliverables). */
export function cmdArtifacts(parsed: ParsedArgs, hub: Hub): number {
  const entries = hub.store.artifactIndexEntries()
  const files = hub.store.listArtifacts()
  if (bool(parsed, 'json')) {
    printJson({ entries, files })
    return 0
  }
  if (files.length === 0) {
    process.stdout.write(`${style.dim('（还没有工件）')}\n`)
    return 0
  }
  const rows = entries.slice(-30).map((e) => [
    String(e['relpath']),
    `${String(e['bytes'])}B`,
    String(e['role'] ?? '—'),
    String(e['session_id'] ?? '—'),
    String(e['created_at'] ?? '').slice(5, 19).replace('T', ' '),
  ])
  process.stdout.write(`${table(['工件', '大小', '角色', '产出会话', '时间'], rows)}\n`)
  process.stdout.write(`\n${style.dim(`共 ${files.length} 个工件，位于 .mesh/artifacts/`)}\n`)
  return 0
}

/** Print the platform decision log. */
export function cmdDecisions(parsed: ParsedArgs, hub: Hub): number {
  const file = hub.paths.decisionsFile
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (bool(parsed, 'json')) {
    printJson({ path: hub.paths.rel(file), markdown: text })
    return 0
  }
  process.stdout.write(text || `${style.dim('（决策日志还是空的）')}\n`)
  return 0
}

export function cmdAgents(parsed: ParsedArgs, hub: Hub): number {
  const sub = parsed.positionals[0] ?? 'list'
  if (sub === 'doctor') return cmdDoctor(parsed)
  if (sub === 'verify') return 2 // async-only; routed in mesh.ts
  if (sub === 'list') {
    if (bool(parsed, 'json')) {
      printJson(hub.store.listAgents())
      return 0
    }
    const rows = hub.store.listAgents().map((a) => [
      a.agent_id,
      a.kind,
      a.enabled ? style.green('on') : style.dim('off'),
      a.capabilities.join(','),
      String(a.concurrency),
      a.mcp_inject,
      a.notes.slice(0, 46),
    ])
    process.stdout.write(`${table(['Agent', '类型', '状态', '能力', '并发', '注入', '说明'], rows)}\n`)
    return 0
  }
  if (sub === 'detect') {
    const detected = detectAgents(defaultDetectContext([hub.paths.root]))
    for (const d of detected) {
      process.stdout.write(
        `${d.available ? style.green('✔') : style.dim('·')} ${d.card.agent_id.padEnd(18)} ${d.available ? d.source : style.dim(d.source)}${d.version ? ` ${style.dim(d.version)}` : ''}\n`,
      )
    }
    process.stdout.write(`\n${style.dim('用 `mesh agents add <id>` 把探测结果写入注册表')}\n`)
    return 0
  }
  if (sub === 'add') {
    const id = parsed.positionals[1]
    const detected = detectAgents(defaultDetectContext([hub.paths.root]))
    const pick = id ? detected.find((d) => d.card.agent_id === id) : detected.find((d) => d.available && d.card.kind !== 'builtin')
    if (!pick) throw new MeshError(MESH_ERRORS.UNKNOWN_ENTITY, `no detected agent ${id ?? ''}`)
    hub.store.saveAgent(pick.card)
    process.stdout.write(`${style.green('✔')} 已注册 ${pick.card.agent_id}（${pick.card.enabled ? 'enabled' : 'disabled'}）\n`)
    return 0
  }
  if (sub === 'enable' || sub === 'disable') {
    const id = parsed.positionals[1]
    if (!id) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `usage: mesh agents ${sub} <agent_id>`)
    const card = hub.store.requireAgent(id)
    card.enabled = sub === 'enable'
    hub.store.saveAgent(card)
    process.stdout.write(`${style.green('✔')} ${id} ${card.enabled ? 'enabled' : 'disabled'}\n`)
    return 0
  }
  if (sub === 'roles') {
    const id = parsed.positionals[1]
    const card = hub.store.requireAgent(id ?? '')
    card.capabilities = parsed.positionals.slice(2).filter((r): r is RoleId => isRoleId(r))
    hub.store.saveAgent(card)
    process.stdout.write(`${style.green('✔')} ${card.agent_id} capabilities = ${card.capabilities.join(', ')}\n`)
    return 0
  }
  throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `unknown agents subcommand: ${sub}`)
}

/**
 * `mesh agents verify <agent_id>` — the superset check from execution instruction 7.
 *
 * Spawns one real P-Session for the agent with the coordinator role and a harmless
 * prompt: register (hello), report who you are, list the hub tools you can see,
 * then stop. Success is not judged by what the model *says*: the check passes when
 * the session actually reaches `hello_at`, which only happens through the injected
 * toolbelt. That is the difference between "the prompt mentions tools" and "the
 * agent has them".
 */
export async function cmdVerifyAgent(parsed: ParsedArgs, hub: Hub): Promise<number> {
  const agentId = parsed.positionals[1] ?? parsed.positionals[0]
  const agents = hub.store.listAgents().filter((a) => a.enabled && a.kind !== 'builtin')
  const targets = agentId ? agents.filter((a) => a.agent_id === agentId) : agents
  if (targets.length === 0) {
    throw new MeshError(MESH_ERRORS.UNKNOWN_ENTITY, `no enabled non-builtin agent${agentId ? ` named ${agentId}` : ''}`, {
      agents: agents.map((a) => a.agent_id),
    })
  }
  const timeoutMs = duration(parsed, 'timeout') ?? 300_000
  let failures = 0
  for (const agent of targets) {
    if (!agent.capabilities.includes('coordinator') && !agent.capabilities.includes('researcher')) {
      process.stdout.write(`${style.yellow('▲')} ${agent.agent_id}: 没有 coordinator/researcher 能力，跳过实跑（配方仍在册）\n`)
      continue
    }
    const role: RoleId = agent.capabilities.includes('coordinator') ? 'coordinator' : 'researcher'
    const session = hub.identity.createSession({
      agent_id: agent.agent_id,
      role,
      spawned_by: 'mesh.agents.verify',
      lifespan: 'ephemeral',
      ttl_seconds: Math.max(agent.ttl_seconds, 900),
    })
    process.stdout.write(`${style.dim(`▶ ${agent.agent_id} (${agent.kind}, ${agent.mcp_inject}) → ${session.session_id}`)}\n`)
    const scheduler = new Scheduler(hub)
    const started = Date.now()
    try {
      scheduler.runTurn(session.session_id, {
        timeoutMs,
        extraSection: [
          '## 这是一次能力自检（不要改任何东西）',
          '',
          '1. 调用 hello 注册身份（文件协议：`mesh hello`）。',
          '2. 调用 whoami 确认身份（文件协议：`mesh whoami`）。',
          '3. 列出你现在能看到的 hub 工具名（或你能执行的 mesh 命令），一行一个。',
          '4. 再列出你**自己的**原生工具（Bash/读写/搜索/子 Agent/Web…）。',
          '5. 然后结束，不要建任务、不要提交、不要改文件。',
        ].join('\n'),
      })
    } catch (e) {
      failures++
      process.stdout.write(`${style.red('✖')} ${agent.agent_id} 启动失败：${(e as Error).message}\n`)
      continue
    }
    const after = hub.store.requireSession(session.session_id)
    const log = scheduler.recentLog(session.session_id, 400)
    const helloOk = Boolean(after.hello_at)
    // Evidence of a real tool channel: the MCP tool name or the CLI command appears.
    const channelSeen = /mcp__hub__|hub_|mesh (hello|whoami)|"hello"|claim_task/.test(log)
    const nativeSeen = /bash|shell|read|write|edit|search|web|grep|glob/i.test(log)
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    if (helloOk) {
      process.stdout.write(
        `${style.green('✔')} ${agent.agent_id}: hello 已到达（channel=${agent.mcp_inject}${channelSeen ? '，日志中可见 hub 调用' : ''}${nativeSeen ? '，日志中可见原生工具' : ''}，${elapsed}s）\n`,
      )
    } else {
      failures++
      process.stdout.write(`${style.red('✖')} ${agent.agent_id}: 会话未到达 hello —— hub 工具没有接上\n`)
      process.stdout.write(`${style.dim(log.split('\n').slice(-10).join('\n'))}\n`)
    }
    const tail = log.split('\n').filter((l) => l.trim()).slice(-4)
    for (const line of tail) process.stdout.write(`${style.dim(`   ${line.slice(0, 160)}`)}\n`)
  }
  return failures === 0 ? 0 : 1
}

export function cmdSessions(parsed: ParsedArgs, hub: Hub): number {
  const sub = parsed.positionals[0] ?? 'ps'
  if (sub === 'ps') {
    const sessions = bool(parsed, 'all') ? hub.store.listSessions() : hub.store.liveSessions()
    if (bool(parsed, 'json')) {
      printJson(sessions)
      return 0
    }
    const rows = sessions.map((s) => [
      s.session_id,
      statusBadge(s.status),
      s.role,
      s.agent_id,
      s.task ?? style.dim('-'),
      s.pid && isProcessAlive(s.pid) ? style.green(String(s.pid)) : style.dim(s.pid ? String(s.pid) : '-'),
      relativeTime(s.last_heartbeat_at),
      s.lifespan,
    ])
    process.stdout.write(`${table(['会话', '状态', '角色', 'Agent', '任务', 'PID', '心跳', '生命周期'], rows)}\n`)
    return 0
  }
  if (sub === 'logs') {
    const id = parsed.positionals[1]
    if (!id) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh sessions logs <session_id>')
    const lines = num(parsed, 'lines') ?? 60
    const scheduler = new Scheduler(hub)
    process.stdout.write(`${scheduler.recentLog(id, lines)}\n`)
    return 0
  }
  if (sub === 'kill') {
    const id = parsed.positionals[1]
    if (!id) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh sessions kill <session_id>')
    const session = hub.store.requireSession(id)
    if (session.pid) {
      try {
        process.kill(session.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    hub.identity.closeSession(id, 'killed', { code: null, note: 'mesh sessions kill' })
    process.stdout.write(`${style.green('✔')} ${id} killed\n`)
    return 0
  }
  throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `unknown sessions subcommand: ${sub}`)
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

export async function cmdUp(parsed: ParsedArgs, hub: Hub): Promise<number> {
  const scheduler = new Scheduler(hub)
  const sentinel = new Sentinel(hub)
  const once = bool(parsed, 'once')
  const interval = num(parsed, 'interval') ?? hub.config.dispatch_interval_ms
  let ticks = 0
  process.stdout.write(`${style.bold('AgentMesh dispatcher')} ${once ? style.dim('(single pass)') : style.dim(`every ${interval}ms`)} · ${hub.paths.root}\n`)

  const onSigint = () => {
    process.stdout.write(`\n${style.dim('stopping dispatcher (children keep running; `mesh down` reaps them)')}\n`)
    process.exit(0)
  }
  if (!once) process.on('SIGINT', onSigint)

  await scheduler.run({
    once,
    intervalMs: interval,
    onTick: (report) => {
      ticks++
      const parts: string[] = []
      if (report.dispatched.length) parts.push(style.cyan(`spawn ${report.dispatched.length}`))
      if (report.reviews.length) parts.push(style.magenta(`review ${report.reviews.length}`))
      if (report.merged.length) parts.push(style.green(`merge ${report.merged.length}`))
      if (report.released.length) parts.push(style.yellow(`release ${report.released.length}`))
      if (report.reaped.length) parts.push(style.dim(`reap ${report.reaped.length}`))
      if (report.expired.length) parts.push(style.red(`expired ${report.expired.length}`))
      if (report.blocked.length) parts.push(style.red(`blocked ${report.blocked.length}`))
      const stamp = new Date().toISOString().slice(11, 19)
      process.stdout.write(
        `${style.dim(stamp)} #${String(ticks).padStart(3)} ${parts.length ? parts.join('  ') : style.dim('idle')}\n`,
      )
      for (const d of report.dispatched) {
        process.stdout.write(`  ${style.dim('→')} ${d.task_id} ${d.agent_id} ${style.dim(`(${d.role}, pid ${d.pid ?? '-'})`)}\n`)
      }
      for (const m of report.merged) {
        process.stdout.write(`  ${style.green('✔')} ${m.task_id} merged ${m.merge_commit.slice(0, 8)} (${m.mode})\n`)
      }
      for (const b of report.blocked) {
        process.stdout.write(`  ${style.red('✖')} ${b.task_id} ${b.reason}\n`)
      }
      if (bool(parsed, 'verbose')) {
        for (const s of report.skipped) process.stdout.write(`  ${style.dim(`· ${s.task_id ?? '-'} ${s.reason}`)}\n`)
      }
      if (ticks % 5 === 0) {
        const scan = sentinel.scan()
        if (scan.new_findings.length > 0) {
          process.stdout.write(`  ${style.yellow(`sentinel: ${scan.new_findings.length} new`)}\n`)
        }
      }
    },
  })
  return 0
}

export function cmdDown(parsed: ParsedArgs, hub: Hub): number {
  const scheduler = new Scheduler(hub)
  const killed = scheduler.stopAll()
  if (bool(parsed, 'json')) {
    printJson({ stopped: killed })
    return 0
  }
  process.stdout.write(`${style.green('✔')} 停止了 ${killed.length} 个会话${killed.length ? `：${killed.join(', ')}` : ''}\n`)
  return 0
}

export async function cmdTalk(parsed: ParsedArgs, hub: Hub): Promise<number> {
  const text = parsed.positionals.join(' ')
  if (!text) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh talk "你想做什么"')
  const config = loadConfig(hub.paths)
  const agentId = str(parsed, 'agent') ?? config.coordinator_agent
  if (!agentId) {
    throw new MeshError(MESH_ERRORS.CONFIG_INVALID, 'no coordinator agent configured; run `mesh init` or `mesh agents add`', {
      config: hub.paths.resolve('config.json'),
    })
  }
  const agent = hub.store.requireAgent(agentId)
  if (!agent.capabilities.includes('coordinator')) {
    throw new MeshError(MESH_ERRORS.CAPABILITY_MISSING, `${agentId} is not registered for the coordinator role`, {
      capabilities: agent.capabilities,
    })
  }
  hub.store.auditEvent('talk.user_message', { text, coordinator_agent: agentId })

  const session = hub.identity.createSession({
    agent_id: agentId,
    role: 'coordinator',
    spawned_by: 'mesh.talk',
    lifespan: 'ephemeral',
    ttl_seconds: Math.max(agent.ttl_seconds, 1800),
  })
  const scheduler = new Scheduler(hub)
  process.stdout.write(`${style.dim(`── coordinator turn · ${agentId} · ${session.session_id} ──`)}\n\n`)
  const result = scheduler.runTurn(session.session_id, {
    userMessage: text,
    timeoutMs: duration(parsed, 'timeout') ?? 900_000,
  })
  const answer = (result.stdout || '').trim()
  if (answer) process.stdout.write(`${answer}\n`)
  if (result.timedOut) process.stdout.write(`${style.yellow('⚠ 超时，进程已结束')}\n`)
  if (!answer) {
    process.stdout.write(`${style.dim('（coordinator 没有输出文本；查看日志）')} ${hub.paths.rel(hub.paths.sessionLog(session.session_id))}\n`)
    const tail = scheduler.recentLog(session.session_id, 15)
    if (tail.trim()) process.stdout.write(`${style.dim(tail)}\n`)
  }
  const summary = hub.board.summary()
  process.stdout.write(
    `\n${style.dim(`看板：${Object.entries(summary.counts).map(([k, v]) => `${k}:${v}`).join(' ') || '（空）'}`)}\n`,
  )
  return 0
}

/**
 * One coordinator turn with no human message: process the inbox, re-plan, unblock.
 * This is how escalations sitting in the role queue actually get answered.
 */
export async function cmdCoordinator(parsed: ParsedArgs, hub: Hub): Promise<number> {
  const config = loadConfig(hub.paths)
  const agentId = str(parsed, 'agent') ?? config.coordinator_agent
  if (!agentId) throw new MeshError(MESH_ERRORS.CONFIG_INVALID, 'no coordinator agent configured')
  const pending = hub.store
    .inbox(agentId, { unreadOnly: true })
    .filter((m) => m.type === 'escalation' || m.type === 'question.ask')
  const blocked = hub.board.board({ status: 'blocked' })
  process.stdout.write(
    `${style.dim(`coordinator 回合 · ${agentId} · 待处理升级 ${pending.length} 条 · 阻塞任务 ${blocked.length} 张`)}\n\n`,
  )
  const session = hub.identity.createSession({
    agent_id: agentId,
    role: 'coordinator',
    spawned_by: 'mesh.coordinator',
    lifespan: 'ephemeral',
    ttl_seconds: 1800,
  })
  const scheduler = new Scheduler(hub)
  const result = scheduler.runTurn(session.session_id, {
    timeoutMs: duration(parsed, 'timeout') ?? 900_000,
    extraSection: [
      '## 本回合的职责',
      '',
      `- 收件箱里有 ${pending.length} 条升级/提问，逐条处理：能决定的直接决定，用 send 回复对应角色线程。`,
      `- 看板上有 ${blocked.length} 张 blocked 卡：要么给出解除方案（说明怎么继续），要么拆成新任务，要么上报用户。`,
      '- 你没有写代码的权限；需要实现就建任务卡。',
      '- 处理完就结束这一轮，不要空转。',
    ].join('\n'),
  })
  const answer = (result.stdout || '').trim()
  if (answer) process.stdout.write(`${answer}\n`)
  return 0
}

export function cmdBlock(parsed: ParsedArgs, hub: Hub): number {
  const taskId = parsed.positionals[0]
  if (!taskId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh block <T-000001> --reason "..."')
  const reason = str(parsed, 'reason') ?? 'blocked by operator'
  const task = hub.board.blockTask(taskId, reason, HUMAN_AGENT)
  process.stdout.write(`${style.yellow('▲')} ${taskId} → ${task.status}：${reason}\n`)
  return 0
}

export function cmdUnblock(parsed: ParsedArgs, hub: Hub): number {
  const taskId = parsed.positionals[0]
  if (!taskId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh unblock <T-000001> [--note "..."]')
  const task = hub.board.unblockTask(taskId, HUMAN_AGENT, str(parsed, 'note'))
  process.stdout.write(`${style.green('✔')} ${taskId} → ${statusBadge(task.status)}\n`)
  return 0
}

// ---------------------------------------------------------------------------
// review / verdict / merge
// ---------------------------------------------------------------------------

/** Resolve who is acting: an agent session when one is in scope, else the human operator. */
function actorFor(hub: Hub, role: RoleId, parsed: ParsedArgs) {
  const session = str(parsed, 'session') ?? process.env['MESH_SESSION_ID']
  if (session) {
    const identity = hub.identity.requireIdentity(session)
    return { identity, label: `${identity.agent.agent_id}/${identity.session.session_id}` }
  }
  const human = humanIdentity(hub, role)
  return { identity: human.identity, label: `${HUMAN_AGENT}/${human.session_id}` }
}

export function cmdReview(parsed: ParsedArgs, hub: Hub): number {
  const taskId = parsed.positionals[0]
  if (!taskId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh review <T-000001>')
  const { identity, label } = actorFor(hub, 'supervisor', parsed)
  const task = hub.board.requestReview(identity.session.session_id, taskId)
  process.stdout.write(`${style.green('✔')} ${taskId} → ${task.status}  ${style.dim(`by ${label}`)}\n`)
  return 0
}

export function cmdVerdict(parsed: ParsedArgs, hub: Hub): number {
  const taskId = parsed.positionals[0]
  if (!taskId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh verdict <T-000001> --approve|--reject --notes "..."')
  const approve = bool(parsed, 'approve')
  const reject = bool(parsed, 'reject')
  if (approve === reject) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'pass exactly one of --approve / --reject')
  const notes = str(parsed, 'notes') ?? ''
  const criteria = list(parsed, 'criterion')
  const { identity, label } = actorFor(hub, 'supervisor', parsed)
  const task = hub.store.requireTask(taskId)
  const results = (criteria.length > 0 ? criteria : task.acceptance).map((criterion) => ({
    criterion,
    pass: approve,
    evidence: approve ? notes || '人工裁决通过' : notes || '人工裁决不通过',
  }))
  const result = hub.board.recordVerdict(identity, taskId, approve ? 'approved' : 'rejected', results, notes, {
    allowStripMerge: bool(parsed, 'allow-strip'),
  })
  process.stdout.write(`${style.green('✔')} ${taskId} ${result.review.verdict} by ${label} (${result.review.review_id})\n`)
  process.stdout.write(`  status → ${statusBadge(result.task.status)}\n`)
  return 0
}

export function cmdMerge(parsed: ParsedArgs, hub: Hub): number {
  const taskId = parsed.positionals[0]
  if (!taskId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh merge <T-000001> [--allow-strip]')
  const { identity, label } = actorFor(hub, 'integrator', parsed)
  const result = hub.board.mergeTask(taskId, { identity, allowStrip: bool(parsed, 'allow-strip') })
  process.stdout.write(`${style.green('✔')} ${taskId} merged ${result.merge_commit.slice(0, 8)} (${result.mode}) by ${label}\n`)
  process.stdout.write(`  文件 ${result.files.join(', ')}\n`)
  if (result.stripped.length) process.stdout.write(`  ${style.yellow(`剥离 ${result.stripped.join(', ')}`)}\n`)
  return 0
}

// ---------------------------------------------------------------------------
// audit / sentinel / roles
// ---------------------------------------------------------------------------

export function cmdAudit(parsed: ParsedArgs, hub: Hub): number {
  const sub = parsed.positionals[0] ?? 'digest'
  if (sub === 'digest') {
    const text = new Sentinel(hub).hub.audit.writeDigest()
    if (bool(parsed, 'json')) {
      printJson({ digest: text, path: hub.paths.rel(hub.paths.digestFile) })
      return 0
    }
    process.stdout.write(`${text}\n${style.dim(`→ ${hub.paths.rel(hub.paths.digestFile)}`)}\n`)
    return 0
  }
  if (sub === 'violations') {
    const violations = hub.store.violations()
    if (bool(parsed, 'json')) {
      printJson(violations)
      return 0
    }
    const rows = violations.slice(-40).map((v) => [v.at.slice(5, 19).replace('T', ' '), v.kind, v.severity, v.task_id ?? '-', v.detail.slice(0, 80)])
    process.stdout.write(`${table(['时间', '类型', '级别', '任务', '说明'], rows)}\n`)
    process.stdout.write(`\n${style.dim(`${violations.length} 条（detect-only，不会阻断任何操作）`)}\n`)
    return 0
  }
  if (sub === 'merges') {
    const merges = hub.store.merges()
    if (bool(parsed, 'json')) {
      printJson(merges)
      return 0
    }
    const rows = merges.map((m) => [
      String(m['at']).slice(5, 19).replace('T', ' '),
      String(m['task_id']),
      String(m['merge_commit']).slice(0, 8),
      String(m['mode']),
      Array.isArray(m['stripped']) && m['stripped'].length ? String((m['stripped'] as string[]).length) : '-',
      Array.isArray(m['files']) ? String((m['files'] as string[]).length) : '-',
    ])
    process.stdout.write(`${table(['时间', '任务', '提交', '模式', '剥离', '文件'], rows)}\n`)
    return 0
  }
  if (sub === 'reviews') {
    const reviews = hub.store.listReviews()
    if (bool(parsed, 'json')) {
      printJson(reviews)
      return 0
    }
    const rows = reviews.map((r) => [r.review_id, r.task_id, r.verdict, r.reviewer_agent, r.notes.slice(0, 60)])
    process.stdout.write(`${table(['审查', '任务', '结论', '审查者', '说明'], rows)}\n`)
    return 0
  }
  if (sub === 'scope') {
    const taskId = parsed.positionals[1]
    if (!taskId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh audit scope <T-000001>')
    const check = new Sentinel(hub).inspectTask(taskId)
    if (bool(parsed, 'json')) {
      printJson(check)
      return 0
    }
    process.stdout.write(`${check.ok ? style.green('✔ scope 干净') : style.red(`✖ ${check.out_of_scope.length} 个越界文件`)}\n`)
    for (const f of check.files) {
      process.stdout.write(`  ${check.out_of_scope.includes(f) ? style.red('✖') : style.green('✔')} ${f}\n`)
    }
    return 0
  }
  if (sub === 'events') {
    const events = hub.store.auditEvents().slice(-(num(parsed, 'lines') ?? 40))
    if (bool(parsed, 'json')) {
      printJson(events)
      return 0
    }
    for (const e of events) process.stdout.write(`${String(e['at']).slice(11, 19)} ${String(e['event'])}\n`)
    return 0
  }
  throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `unknown audit subcommand: ${sub}`)
}

export function cmdSentinel(parsed: ParsedArgs, hub: Hub): number {
  const sentinel = new Sentinel(hub)
  const report = sentinel.scan({ notify: !bool(parsed, 'quiet') })
  if (bool(parsed, 'json')) {
    printJson(report)
    return 0
  }
  process.stdout.write(
    `${style.bold('Sentinel')} 扫描 ${report.checked.tasks} 个任务分支 / ${report.checked.sessions} 个会话 / ${report.checked.main_commits} 个主分支提交 / ${report.checked.reviews} 条审查\n`,
  )
  if (report.findings.length === 0) {
    process.stdout.write(`${style.green('✔ 没有发现问题')}\n`)
  } else {
    const rows = report.findings.map((f) => [f.kind, f.severity, f.task_id ?? '-', f.detail.slice(0, 90)])
    process.stdout.write(`\n${table(['类型', '级别', '任务', '说明'], rows)}\n`)
    process.stdout.write(`\n${style.dim(`本次新增 ${report.new_findings.length} 条 · detect-only：不影响任何任务状态`)}\n`)
  }
  if (report.artifact_path) process.stdout.write(`${style.dim(`报告：.mesh/artifacts/${report.artifact_path}`)}\n`)
  return 0
}

export function cmdRoles(parsed: ParsedArgs): number {
  if (bool(parsed, 'json')) {
    printJson([...ROLE_CARDS.values()])
    return 0
  }
  const rows = [...ROLE_CARDS.values()].map((c) => [
    c.role,
    c.title,
    c.can_write_code ? style.yellow('code') : style.dim('doc'),
    c.can_review ? style.magenta('review') : style.dim('-'),
    c.can_merge ? style.green('merge') : style.dim('-'),
    c.lifespan,
    c.output_globs.join(',') || style.dim('-'),
  ])
  process.stdout.write(`${table(['角色', '名称', '写码', '审查', '合并', '生命周期', '工件路径'], rows)}\n`)
  const role = parsed.positionals[0]
  if (role && isRoleId(role)) {
    const card = getRoleCard(role)
    process.stdout.write(`\n${style.bold(card.title)}\n`)
    process.stdout.write(`${card.prompt}\n\n${style.dim('约束：')}\n`)
    for (const c of card.constraints) process.stdout.write(`  - ${c}\n`)
  }
  return 0
}

export function cmdConfig(parsed: ParsedArgs, hub: Hub): number {
  if (parsed.positionals[0] === 'set') {
    const key = parsed.positionals[1]
    const value = parsed.positionals[2]
    if (!key || value === undefined) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh config set <key> <value>')
    const patch: Record<string, unknown> = {}
    const current = loadConfig(hub.paths) as unknown as Record<string, unknown>
    const existing = current[key]
    if (typeof existing === 'boolean') patch[key] = value === 'true' || value === '1' || value === 'on'
    else if (typeof existing === 'number') patch[key] = Number(value)
    else patch[key] = value
    const next = patchConfig(hub.paths, patch as never)
    printJson(next)
    return 0
  }
  printJson(loadConfig(hub.paths))
  return 0
}

/**
 * `mesh teammates [--mission M-000001]` — the CLI mirror of `list_teammates`.
 *
 * Read-only and session-optional: a human inspecting a mission should not need a
 * worker session first. The rows come from the same builder that fills the context
 * package, so the table here and the table injected into an agent cannot disagree.
 */
export function cmdTeammates(parsed: ParsedArgs, hub: Hub): number {
  const missionId = str(parsed, 'mission') ?? parsed.positionals[0]
  if (!missionId) {
    throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh teammates <M-000001>   (or --mission <id>)')
  }
  const mission = hub.store.requireMission(missionId)
  const rows = buildTeammates(hub.store, missionId)
  if (bool(parsed, 'json')) {
    printJson({ mission_id: mission.mission_id, title: mission.title, lead_agent: mission.lead_agent, teammates: rows })
    return 0
  }
  process.stdout.write(
    `${style.bold(mission.mission_id)} ${mission.title}  ${style.dim(`lead ${mission.lead_agent} · ${rows.length} 人参与`)}\n\n`,
  )
  const body = rows.map((r) => [
    r.is_lead ? `${r.agent_id} ${style.cyan('lead')}` : r.agent_id,
    r.personality || '—',
    r.strengths.join('、') || '—',
    r.weaknesses.join('、') || '—',
    String(r.quality_score),
    String(r.cost_tier),
    r.role_in_mission,
  ])
  process.stdout.write(`${table(['agent', '性格', '擅长', '弱势', '质量分', '花费', '本轮负责'], body)}\n`)
  return 0
}

export function cmdServe(parsed: ParsedArgs, hub: Hub): Promise<number> {
  const port = num(parsed, 'port') ?? 8787
  const host = str(parsed, 'host') ?? '127.0.0.1'
  // `--dir` lets you watch a project without cd-ing into it.
  const dir = str(parsed, 'dir')
  const target = dir ? Hub.openOrThrow(path.resolve(dir)) : hub
  return import('../hub/web/server.ts')
    .then((mod) => mod.startServer({ hub: target, port, host }))
    .then((started) => {
      process.stdout.write(`${style.green('✔')} dashboard: ${started.url}\n`)
      process.stdout.write(`${style.dim(`  项目：${target.paths.root}`)}\n`)
      process.stdout.write(`${style.dim('  Ctrl+C 退出（只读观察台；写操作仍走 CLI / agent 工具）')}\n`)
      return new Promise<number>(() => {
        process.on('SIGINT', () => process.exit(0))
      })
    })
}
