/**
 * `mesh mission …` — the V2 entry, plus the lead-side commands that mirror the
 * `plan_mission` / `dispatch_mission` / `final_verdict` / `write_report` tools.
 *
 * Two audiences again:
 *  - humans: create a mission, watch it, read the report;
 *  - the lead (any agent, or the human operator driving a builtin lead): plan it,
 *    dispatch it, give the second acceptance, write the report.
 */

import fs from 'node:fs'
import path from 'node:path'
import { MeshError, MESH_ERRORS } from '../hub/core/errors.ts'
import { Scheduler } from '../hub/scheduler/scheduler.ts'
import type { Hub } from '../hub/core/hub.ts'
import type { MissionCard, MissionStatus } from '../hub/core/types.ts'
import type { PlanTaskInput } from '../hub/core/missions.ts'
import {
  bool,
  duration,
  list,
  num,
  printJson,
  relativeTime,
  sessionIdFrom,
  statusBadge,
  str,
  style,
  table,
} from './common.ts'
import type { ParsedArgs } from './common.ts'
import { humanIdentity } from './human.ts'

const MISSION_ID = /^M-\d{6}$/

function missionBadge(status: MissionStatus | string): string {
  const map: Record<string, string> = {
    intake: style.cyan('intake'),
    planning: style.cyan('planning'),
    executing: style.yellow('executing'),
    integrating: style.magenta('integrating'),
    final_review: style.magenta('final_review'),
    completed: style.green('completed'),
    rejected: style.red('rejected'),
    blocked: style.red('blocked'),
    cancelled: style.dim('cancelled'),
  }
  return map[status] ?? status
}

/** Read a JSON payload from --file / --text / stdin-free: shape-checked by the caller. */
function readJsonArg(parsed: ParsedArgs, flag: string): unknown {
  const file = str(parsed, flag)
  const inline = str(parsed, 'text')
  let raw: string | undefined
  if (file) raw = fs.readFileSync(path.resolve(file), 'utf8')
  else if (inline) raw = inline
  if (raw === undefined) {
    throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `missing --${flag} <path> (or --text '<json>')`)
  }
  try {
    // Tolerate a UTF-8 BOM: editors and PowerShell add one, JSON.parse does not.
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as unknown
  } catch (e) {
    throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `--${flag} is not valid JSON: ${(e as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// human: mesh mission / mesh missions
// ---------------------------------------------------------------------------

export function cmdMissions(parsed: ParsedArgs, hub: Hub): number {
  const status = str(parsed, 'status')
  const missions = hub.store.listMissions().filter((m) => !status || m.status === status)
  if (bool(parsed, 'json')) {
    printJson(missions)
    return 0
  }
  if (missions.length === 0) {
    process.stdout.write(`${style.dim('还没有 mission。用 `mesh mission "你想做什么"` 开一个。')}\n`)
    return 0
  }
  const rows = missions.map((m) => {
    const view = hub.missions.getView(m.mission_id)
    return [
      m.mission_id,
      missionBadge(m.status),
      m.title.length > 34 ? `${m.title.slice(0, 33)}…` : m.title,
      m.lead_agent,
      `${view.progress.merged}/${view.progress.total}`,
      String(m.rounds),
      relativeTime(m.updated_at),
    ]
  })
  process.stdout.write(`${table(['Mission', '状态', '标题', 'Lead', '卡', '轮次', '更新'], rows)}\n`)
  return 0
}

export function cmdMission(parsed: ParsedArgs, hub: Hub): number | Promise<number> {
  const first = parsed.positionals[0]
  if (first === 'report') return cmdMissionReport(parsed, hub)
  if (first === 'lead') return cmdMissionLead(parsed, hub)
  if (first && MISSION_ID.test(first)) return cmdMissionDetail(parsed, hub, first)
  return createAndStart(parsed, hub)
}

function cmdMissionDetail(parsed: ParsedArgs, hub: Hub, missionId: string): number {
  const view = hub.missions.getView(missionId)
  const m = view.mission
  if (bool(parsed, 'json')) {
    // Same flattened shape as the `get_mission` tool, so scripts can use either.
    printJson({ ...m, task_summaries: view.tasks, progress: view.progress, lead_session_live: view.lead_session_live })
    return 0
  }
  process.stdout.write(`${style.bold(m.mission_id)} ${m.title}  ${missionBadge(m.status)}\n\n`)
  process.stdout.write(`${style.dim('用户原话')}  ${m.brief}\n`)
  if (m.acceptance.length > 0) {
    process.stdout.write(`${style.dim('Mission 验收')}\n`)
    m.acceptance.forEach((a, i) => process.stdout.write(`  ${i + 1}. ${a}\n`))
  }
  process.stdout.write(
    `${style.dim('Lead')}      ${m.lead_agent}${m.lead_session ? ` · ${m.lead_session}` : ''}　` +
      `${style.dim('轮次')} ${m.rounds}　${style.dim('来源')} ${m.source}\n`,
  )
  process.stdout.write(`${style.dim('队友')}      ${m.teammates.join(' → ')}\n`)
  process.stdout.write(
    `${style.dim('进度')}      ${view.progress.merged}/${view.progress.total} 合并` +
      `${view.progress.cancelled ? ` · ${view.progress.cancelled} 取消` : ''}` +
      `${view.lead_session_live ? ` · ${style.cyan('lead 会话在跑')}` : ''}\n`,
  )
  if (m.plan.length > 0) {
    process.stdout.write(`\n${style.bold('计划')}\n`)
    for (const p of m.plan) process.stdout.write(`  ${p.task_id} ${p.role.padEnd(14)} ${p.why}\n`)
  }
  if (view.tasks.length > 0) {
    process.stdout.write(`\n${style.bold('任务')}\n`)
    const rows = view.tasks.map((t) => [
      t.task_id,
      statusBadge(t.status),
      t.role,
      t.title.length > 30 ? `${t.title.slice(0, 29)}…` : t.title,
      t.implementer_agent ?? '—',
      t.reviewer_agent ?? '—',
      t.merge_commit ? t.merge_commit.slice(0, 8) : '—',
    ])
    process.stdout.write(`${table(['卡', '状态', '角色', '标题', '实现', '审查', '合并'], rows)}\n`)
  }
  if (m.report) {
    process.stdout.write(`\n${style.bold('报告')} ${style.dim(`(${m.report_at ?? ''} · mesh mission report ${m.mission_id})`)}\n`)
    const head = m.report.split('\n').slice(0, 6).join('\n')
    process.stdout.write(`${style.dim(head)}\n${style.dim('…')}\n`)
  }
  process.stdout.write(`\n${style.dim('轨迹')}\n`)
  for (const h of m.history.slice(-10)) {
    process.stdout.write(`  ${style.dim(h.at.slice(11, 19))} ${h.from ?? '∅'} → ${h.to}  ${style.dim(h.note ?? '')}\n`)
  }
  return 0
}

function cmdMissionReport(parsed: ParsedArgs, hub: Hub): number {
  const missionId = parsed.positionals[1]
  if (!missionId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh mission report <M-000001>')
  const m = hub.store.requireMission(missionId)
  const text = m.report ?? hub.store.readMissionReport(missionId)
  if (!text) {
    process.stdout.write(`${style.dim('这个 mission 还没有报告（lead 通过 write_report 写）')}\n`)
    return 0
  }
  process.stdout.write(`${text.trimEnd()}\n`)
  return 0
}

/** Open a lead session for a mission so a human can drive it by hand. */
export function cmdMissionLead(parsed: ParsedArgs, hub: Hub): number {
  const missionId = parsed.positionals[1]
  if (!missionId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh mission lead <M-000001>')
  const mission = hub.store.requireMission(missionId)
  const existing = hub.identity.leadSessionOf(missionId)
  if (existing) {
    process.stdout.write(`${style.green('✔')} 已有 lead 会话：${existing.session_id}\n`)
    process.stdout.write(`  ${style.dim(`mesh plan-mission ${missionId} --file plan.json --session ${existing.session_id}`)}\n`)
    return 0
  }
  const session = hub.missions.createLeadSession(missionId, { spawned_by: 'mesh.cli' })
  // A CLI-created lead session has no process, so nothing will call hello for it.
  // Register it here; otherwise every lead command would be refused as "no rights".
  hub.identity.hello(session.session_id)
  process.stdout.write(`${style.green('✔')} lead 会话 ${session.session_id}（${mission.lead_agent}，mission ${missionId}）\n`)
  process.stdout.write(`\n下一步：\n`)
  process.stdout.write(`  mesh plan-mission ${missionId} --file plan.json --session ${session.session_id}\n`)
  process.stdout.write(`  mesh dispatch-mission ${missionId} --session ${session.session_id}\n`)
  return 0
}

/**
 * Platform entry: `mesh mission "…"`.
 *
 * Creates the mission and — when the lead is a real agent — runs its planning turn
 * right away, in the foreground, so the human sees the breakdown as it happens.
 * A builtin lead (the human operator) is not spawned: the CLI prints the commands.
 */
async function createAndStart(parsed: ParsedArgs, hub: Hub): Promise<number> {
  const title = parsed.positionals.join(' ').trim()
  if (!title) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh mission "你想做什么" [--accept "…"] [--lead id]')
  const brief = str(parsed, 'brief') ?? title
  const acceptance = list(parsed, 'accept')
  const { identity } = humanIdentity(hub, 'planner')
  const mission = hub.missions.createMission(
    {
      title,
      brief,
      acceptance,
      lead_agent: str(parsed, 'lead') ?? null,
      source: 'platform',
    },
    identity,
  )
  process.stdout.write(`${style.green('✔')} ${mission.mission_id} ${missionBadge(mission.status)} ${mission.title}\n`)
  process.stdout.write(
    `  lead ${mission.lead_agent}${acceptance.length > 0 ? ` · 验收 ${acceptance.length} 条` : ''}　${style.dim(`by ${identity.agent.agent_id}/${identity.session.session_id}`)}\n`,
  )

  if (bool(parsed, 'dry-plan')) {
    process.stdout.write(`\n${style.dim('--dry-plan：只登记，不动手。')}\n`)
    process.stdout.write(`  mesh mission lead ${mission.mission_id}     # 开 lead 会话，然后 plan-mission\n`)
    return 0
  }

  const leadAgent = hub.store.requireAgent(mission.lead_agent)
  if (leadAgent.kind === 'builtin') {
    process.stdout.write(
      `\n${style.dim(`${leadAgent.agent_id} 是内置实体（人类/内核），不会自动开会话。手工驱动：`)}\n`,
    )
    process.stdout.write(`  mesh mission lead ${mission.mission_id}\n`)
    return 0
  }

  const session = hub.missions.createLeadSession(mission.mission_id, { spawned_by: 'mesh.mission' })
  const scheduler = new Scheduler(hub)
  process.stdout.write(`\n${style.dim(`── lead turn · ${mission.lead_agent} · ${session.session_id} ──`)}\n\n`)
  const result = scheduler.runTurn(session.session_id, {
    timeoutMs: duration(parsed, 'timeout') ?? 900_000,
    extraSection: hub.missions.leadBrief(hub.store.requireMission(mission.mission_id), 'planning'),
  })
  const answer = (result.stdout || '').trim()
  if (answer) process.stdout.write(`${answer}\n`)
  if (result.timedOut) process.stdout.write(`${style.yellow('⚠ 超时，进程已结束')}\n`)

  const fresh = hub.store.requireMission(mission.mission_id)
  process.stdout.write(
    `\n${style.dim(`mission ${fresh.mission_id} → ${fresh.status} · ${fresh.tasks.length} 张卡`)}\n`,
  )
  if (fresh.status === 'intake') {
    process.stdout.write(`${style.dim(`lead 还没拆卡；看日志：`)} ${hub.paths.rel(hub.paths.sessionLog(session.session_id))}\n`)
  }
  return 0
}

// ---------------------------------------------------------------------------
// lead surface (mirrors the mission tools)
// ---------------------------------------------------------------------------

export function cmdPlanMission(parsed: ParsedArgs, hub: Hub): number {
  const missionId = parsed.positionals[0]
  if (!missionId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh plan-mission <M-000001> --file plan.json')
  const payload = readJsonArg(parsed, 'file')
  const tasks = (Array.isArray(payload) ? payload : (payload as { tasks?: unknown }).tasks) as PlanTaskInput[] | undefined
  if (!Array.isArray(tasks)) {
    throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'plan JSON must be an array of tasks, or {"tasks": [...]}')
  }
  const session = sessionIdFrom(parsed)
  const result = hub.missions.planMission(session, missionId, tasks)
  if (bool(parsed, 'json')) {
    printJson({ mission: result.mission, created: result.created.map((t) => t.task_id) })
    return 0
  }
  process.stdout.write(`${style.green('✔')} ${missionId} → ${missionBadge(result.mission.status)}，建了 ${result.created.length} 张卡\n`)
  for (const t of result.created) process.stdout.write(`  ${t.task_id} ${t.role.padEnd(14)} ${t.title}\n`)
  process.stdout.write(`\n${style.dim(`下一步：mesh dispatch-mission ${missionId} --session ${session}`)}\n`)
  return 0
}

export function cmdDispatchMission(parsed: ParsedArgs, hub: Hub): number {
  const missionId = parsed.positionals[0]
  if (!missionId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh dispatch-mission <M-000001>')
  const session = sessionIdFrom(parsed)
  const mission = hub.missions.dispatchMission(session, missionId)
  process.stdout.write(`${style.green('✔')} ${missionId} → ${missionBadge(mission.status)}（${mission.tasks.length} 张卡进入看板）\n`)
  return 0
}

export function cmdFinalVerdict(parsed: ParsedArgs, hub: Hub): number {
  const missionId = parsed.positionals[0]
  if (!missionId) {
    throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh final-verdict <M-000001> --approve|--reject --notes "…"')
  }
  const approve = bool(parsed, 'approve')
  const reject = bool(parsed, 'reject')
  if (approve === reject) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'pass exactly one of --approve / --reject')
  const notes = str(parsed, 'notes') ?? ''
  const rejects = list(parsed, 'reject-task')
  const session = sessionIdFrom(parsed)
  const result = hub.missions.finalVerdict(session, missionId, approve, notes, approve ? undefined : rejects)
  process.stdout.write(
    `${style.green('✔')} ${missionId} 二次验收 ${approve ? '通过' : '不通过'} → ${missionBadge(result.mission.status)}（第 ${result.mission.rounds} 轮）\n`,
  )
  if (result.rejected_tasks.length > 0) process.stdout.write(`  打回：${result.rejected_tasks.join(', ')}\n`)
  if (result.replan) process.stdout.write(`  ${style.dim('未点名具体卡 → mission 回到 planning 重拆')}\n`)
  return 0
}

export function cmdWriteReport(parsed: ParsedArgs, hub: Hub): number {
  const missionId = parsed.positionals[0]
  if (!missionId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh write-report <M-000001> --file report.md')
  const file = str(parsed, 'file')
  const inline = str(parsed, 'text')
  const markdown = file ? fs.readFileSync(path.resolve(file), 'utf8') : inline
  if (!markdown) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'missing --file <report.md> (or --text "…")')
  const session = sessionIdFrom(parsed)
  const result = hub.missions.writeReport(session, missionId, markdown)
  process.stdout.write(`${style.green('✔')} ${missionId} → ${missionBadge(result.mission.status)}，报告 ${result.path}\n`)
  return 0
}

export function cmdGetMission(parsed: ParsedArgs, hub: Hub): number {
  const missionId = parsed.positionals[0]
  if (!missionId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh get-mission <M-000001>')
  return cmdMissionDetail(parsed, hub, missionId)
}

/** Agent-side create (the chat entry: whoever received the job leads it). */
export function cmdCreateMission(parsed: ParsedArgs, hub: Hub): number {
  const title = parsed.positionals.join(' ').trim()
  if (!title) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh create-mission "标题" [--brief "…"] [--lead me]')
  const leadFlag = str(parsed, 'lead')
  const session = sessionIdFrom(parsed)
  const identity = hub.identity.requireIdentity(session)
  const lead = leadFlag === 'me' ? identity.agent.agent_id : (leadFlag ?? identity.agent.agent_id)
  const mission = hub.missions.createMission(
    {
      title,
      brief: str(parsed, 'brief') ?? title,
      acceptance: list(parsed, 'accept'),
      lead_agent: lead,
      source: identity.agent.kind === 'builtin' ? 'platform' : 'chat',
    },
    identity,
  )
  process.stdout.write(`${style.green('✔')} ${mission.mission_id} ${missionBadge(mission.status)} lead=${mission.lead_agent}\n`)
  return 0
}

/** Mission summary used by `mesh status`. */
export function missionLines(hub: Hub): string[] {
  const missions = hub.store.listMissions().filter((m) => m.status !== 'completed' && m.status !== 'cancelled')
  if (missions.length === 0) return []
  const lines: string[] = [`${style.bold('Mission')}`]
  for (const m of missions.slice(-5)) {
    const view = hub.missions.getView(m.mission_id)
    lines.push(`  ${m.mission_id} ${missionBadge(m.status)} ${m.title.slice(0, 38)}  ${view.progress.merged}/${view.progress.total}  lead ${m.lead_agent}`)
  }
  return lines
}

export function missionCount(hub: Hub): { total: number; open: number } {
  const all = hub.store.listMissions()
  return { total: all.length, open: all.filter((m) => !['completed', 'cancelled'].includes(m.status)).length }
}

export type { MissionCard }
