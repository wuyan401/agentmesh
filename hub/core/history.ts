/**
 * Collaboration history (V2 §4): "干净简洁明显的整理与保存好每一次协作的历史".
 *
 * When a mission ends we freeze it into a directory a human can actually read:
 *
 *   .mesh/missions/M-000001/
 *     report.md      the lead's final report
 *     timeline.md    every claim/submit/review/merge/message, in order
 *     tasks.json     terminal snapshot of every card, reviews included in full
 *     context/       a copy of each context package handed out (evidence)
 *
 * …and one line per mission in `.mesh/HISTORY.md`, which is the first thing a person
 * opens. Everything here is derived from append-only ledgers (audit + board, reviews,
 * cards); nothing is reconstructed from memory or rewritten later.
 */

import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, writeFileAtomic, writeJsonAtomic } from './fsx.ts'
import { buildTeammates } from './teammates.ts'
import type { MeshStore } from './store.ts'
import type { MissionCard, ReviewRecord, TaskCard } from './types.ts'

export interface TimelineEvent {
  at: string
  kind: string
  /** Human label for the kind ("领取", "合并"); the raw `kind` is for machines. */
  label: string
  actor: string | null
  text: string
  task_id: string | null
  session_id: string | null
  /** Which ledger the row came from: audit (permissions), board (work), message. */
  source: 'audit' | 'board' | 'message'
}

export interface MissionBundle {
  mission_id: string
  dir: string
  files: string[]
}

/** Audit events that belong to a mission, newest last, in ledger order. */
function eventBelongsTo(event: Record<string, unknown>, mission: MissionCard): boolean {
  if (event['mission_id'] === mission.mission_id) return true
  const taskId = event['task_id']
  return typeof taskId === 'string' && mission.tasks.includes(taskId)
}

const KIND_LABEL: Record<string, string> = {
  'mission.created': '创建 mission',
  'mission.lead_session': '开 lead 会话',
  'mission.planned': '拆卡',
  'mission.dispatched': '派活',
  'mission.verdict': '二次验收',
  'mission.advanced': '状态推进',
  'mission.completed': '完成',
  'mission.closed': '归档',
  'task.created': '建卡',
  'task.ready': '可领取',
  'task.published': '发布',
  'task.requeued': '重新排队',
  'task.claimed': '领取',
  'task.in_progress': '开始实现',
  'task.submitted': '提交审查',
  'task.reviewing': '开始审查',
  'task.approved': '审查通过',
  'task.rejected': '审查打回',
  'task.verdict': '审查裁决',
  'task.merged': '合并',
  'task.rejected_after_merge': '打回已合并的卡',
  'task.blocked': '阻塞',
  'task.released': '释放',
  'sandbox.rebased': '沙箱重定位',
  'review.attempt': '开始审查',
  'profile.set': '手编 profile',
  'profile.rate_peer': '互评',
  message: '消息',
}

/** One human-readable line per event, built from the event's own payload. */
function describe(event: Record<string, unknown>): string {
  const kind = String(event['event'] ?? '')
  const base = String(event['event'] ?? '')
  switch (kind) {
    case 'mission.created':
      return `创建「${String(event['title'] ?? '')}」，lead ${String(event['lead_agent'] ?? '')}`
    case 'mission.planned':
      return `拆出 ${Array.isArray(event['tasks']) ? (event['tasks'] as unknown[]).length : '?'} 张卡`
    case 'mission.advanced':
      return `${String(event['from'])} → ${String(event['to'])}（${String(event['note'] ?? '')}）`
    case 'mission.verdict':
      return event['approved'] === true
        ? `二次验收通过：${String(event['notes'] ?? '')}`
        : `二次验收不通过：${String(event['notes'] ?? '')}`
    case 'mission.completed':
      return `完成，报告 ${String(event['report'] ?? '')}`
    case 'task.created':
      return `建卡 ${String(event['task_id'] ?? '')}${event['title'] ? `「${String(event['title'])}」` : ''}${event['role'] ? `（${String(event['role'])}）` : ''}`
    case 'task.ready':
      return `${String(event['task_id'] ?? '')} 可领取${event['reason'] ? `（${String(event['reason'])}）` : ''}`
    case 'task.claimed':
      return `领取 ${String(event['task_id'] ?? '')}`
    case 'task.submitted': {
      // Board events carry the commit and the file count, not a prose summary.
      const commit = String(event['commit'] ?? '').slice(0, 8)
      const files = event['files']
      const detail = [commit && `commit ${commit}`, typeof files === 'number' && `${files} 个文件`].filter(Boolean).join('，')
      return `提交 ${String(event['task_id'] ?? '')}${detail ? `（${detail}）` : ''}${event['summary'] ? `：${String(event['summary'])}` : ''}`
    }
    case 'task.reviewing':
      return `开始审查 ${String(event['task_id'] ?? '')}`
    case 'task.approved':
      return `通过 ${String(event['task_id'] ?? '')}`
    case 'task.rejected':
      return `打回 ${String(event['task_id'] ?? '')}${event['notes'] ? `：${String(event['notes'])}` : ''}`
    case 'sandbox.rebased':
      return `沙箱重定位 ${String(event['task_id'] ?? '')}`
    case 'task.verdict':
      return `${String(event['verdict'] ?? '')} ${String(event['task_id'] ?? '')}${event['notes'] ? `：${String(event['notes'])}` : ''}`
    case 'task.merged':
      return `合并 ${String(event['task_id'] ?? '')} ${String(event['merge_commit'] ?? '').slice(0, 8)}（${String(event['mode'] ?? '')}）`
    case 'task.rejected_after_merge':
      return `打回 ${String(event['task_id'] ?? '')}：${String(event['note'] ?? '')}`
    case 'task.blocked':
      return `阻塞 ${String(event['task_id'] ?? '')}：${String(event['reason'] ?? '')}`
    default:
      return base
  }
}

export class MissionHistory {
  readonly store: MeshStore

  constructor(store: MeshStore) {
    this.store = store
  }

  /**
   * Events for a mission, in ledger order.
   *
   * Two ledgers, both append-only: the audit log records permissions (who was allowed
   * to do what), the board log records work (claim/submit/verdict/merge). Reading only
   * one of them would be half a story, so both are merged and de-duplicated.
   */
  timelineEvents(mission: MissionCard): TimelineEvent[] {
    const out: TimelineEvent[] = []
    const seen = new Set<string>()
    const push = (event: Record<string, unknown>, source: 'audit' | 'board'): void => {
      const kind = String(event['event'] ?? '')
      const at = String(event['at'] ?? '')
      const taskId = typeof event['task_id'] === 'string' ? event['task_id'] : null
      // The ledgers overlap for a few kinds; keep the first (audit wins).
      const key = `${at}|${kind}|${taskId ?? ''}`
      if (seen.has(key)) return
      seen.add(key)
      out.push({
        at,
        kind,
        label: KIND_LABEL[kind] ?? kind,
        actor:
          typeof event['agent'] === 'string'
            ? event['agent']
            : typeof event['reviewer'] === 'string'
              ? event['reviewer']
              : typeof event['by'] === 'string'
                ? event['by']
                : typeof event['session_id'] === 'string'
                  ? event['session_id']
                  : typeof event['session'] === 'string'
                    ? event['session']
                    : typeof event['agent_id'] === 'string'
                      ? event['agent_id']
                      : null,
        text: describe(event),
        task_id: taskId,
        session_id: typeof event['session_id'] === 'string' ? event['session_id'] : null,
        source,
      })
    }

    for (const event of this.store.auditEvents()) {
      if (!eventBelongsTo(event, mission)) continue
      // `review.attempt` duplicates the board's `task.reviewing` row one line later,
      // with a worse actor (session id instead of agent). Keep the board one.
      if (event['event'] === 'review.attempt') continue
      push(event, 'audit')
    }
    for (const event of this.store.boardEvents()) {
      if (!eventBelongsTo(event, mission)) continue
      push(event, 'board')
    }

    // Messages that mention this mission or one of its cards, inside its lifetime.
    const start = Date.parse(mission.created_at) || 0
    const end = Date.parse(mission.report_at ?? mission.updated_at) || Number.MAX_SAFE_INTEGER
    for (const message of this.store.logMessages()) {
      const at = Date.parse(message.created_at)
      if (Number.isNaN(at) || at < start || at > end) continue
      const body = message.body ?? ''
      const mentions = body.includes(mission.mission_id) || mission.tasks.some((t) => body.includes(t))
      if (!mentions) continue
      out.push({
        at: message.created_at,
        kind: 'message',
        label: KIND_LABEL['message']!,
        actor: message.from.agent,
        text: `[${message.type}] ${body.replace(/\s+/g, ' ').slice(0, 200)}`,
        task_id: null,
        session_id: message.from.session ?? null,
        source: 'message',
      })
    }
    // Stable: same timestamp keeps ledger order (Array.prototype.sort is stable).
    out.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
    return out
  }

  renderTimeline(mission: MissionCard, events: TimelineEvent[]): string {
    const lines: string[] = []
    lines.push(`# ${mission.mission_id}「${mission.title}」时间线`)
    lines.push('')
    lines.push(
      `> 自动生成（来源：\`.mesh/audit/events.jsonl\` + \`.mesh/board/events.jsonl\` + 消息账本）。生成时间：${new Date().toISOString()}`,
    )
    lines.push('')
    lines.push(`- Lead：${mission.lead_agent}`)
    lines.push(`- 状态：${mission.status}　轮次：${mission.rounds}　卡数：${mission.tasks.length}`)
    lines.push(`- 起止：${mission.created_at} → ${mission.report_at ?? mission.updated_at}`)
    lines.push('')
    if (events.length === 0) {
      lines.push('（没有记录到事件）')
      return `${lines.join('\n')}\n`
    }
    lines.push('| 时间 | 事件 | 谁 | 说明 |')
    lines.push('|---|---|---|---|')
    for (const e of events) {
      const who = e.actor ?? '—'
      lines.push(`| ${e.at.slice(11, 19)} | ${KIND_LABEL[e.kind] ?? e.kind} | ${who} | ${e.text.replace(/\|/g, '/')} |`)
    }
    lines.push('')
    return `${lines.join('\n')}\n`
  }

  /** Every card of the mission, terminal state, with its reviews in full. */
  tasksSnapshot(
    mission: MissionCard,
  ): Array<TaskCard & { reviews_full: ReviewRecord[]; sessions: Array<Record<string, unknown>> }> {
    const out: Array<TaskCard & { reviews_full: ReviewRecord[]; sessions: Array<Record<string, unknown>> }> = []
    for (const taskId of mission.tasks) {
      const task = this.store.getTask(taskId)
      if (!task) continue
      out.push({
        ...task,
        reviews_full: this.store.listReviews(taskId),
        sessions: this.store.sessionsOfTask(taskId).map((s) => ({
          session_id: s.session_id,
          agent_id: s.agent_id,
          role: s.role,
          status: s.status,
          created_at: s.created_at,
          exit: s.exit ? { code: s.exit.code, at: s.exit.at, note: s.exit.note ?? null } : null,
        })),
      })
    }
    return out
  }

  /**
   * Freeze a mission into its directory. Idempotent: re-running rewrites the same
   * files from the same ledgers, so a `mesh mission close` after the fact cannot
   * invent history.
   */
  close(missionId: string): MissionBundle {
    const mission = this.store.requireMission(missionId)
    const dir = this.store.paths.missionDir(missionId)
    ensureDir(dir)
    ensureDir(path.join(dir, 'context'))
    const files: string[] = []

    const report = mission.report ?? this.store.readMissionReport(missionId) ?? ''
    if (report.trim()) {
      writeFileAtomic(path.join(dir, 'report.md'), `${report.trimEnd()}\n`)
      files.push('report.md')
    }

    const events = this.timelineEvents(mission)
    writeFileAtomic(path.join(dir, 'timeline.md'), this.renderTimeline(mission, events))
    files.push('timeline.md')

    writeJsonAtomic(path.join(dir, 'tasks.json'), {
      mission_id: mission.mission_id,
      title: mission.title,
      status: mission.status,
      lead_agent: mission.lead_agent,
      rounds: mission.rounds,
      created_at: mission.created_at,
      updated_at: mission.updated_at,
      report_at: mission.report_at,
      acceptance: mission.acceptance,
      teammates: buildTeammates(this.store, missionId),
      tasks: this.tasksSnapshot(mission),
    })
    files.push('tasks.json')

    // Context packages are evidence of what each agent was actually told.
    for (const taskId of mission.tasks) {
      const src = this.store.paths.contextFile(taskId)
      if (!fs.existsSync(src)) continue
      fs.copyFileSync(src, path.join(dir, 'context', `${taskId}.md`))
      files.push(`context/${taskId}.md`)
    }

    this.writeHistoryIndex()
    // No audit event for closing: it renders existing ledgers, it does not change
    // state. Auditing it would put "archive" rows in the very timeline it generates,
    // one more each time somebody rebuilds the bundle.
    return { mission_id: missionId, dir: this.store.paths.rel(dir), files }
  }

  durationOf(mission: MissionCard): number {
    const start = Date.parse(mission.created_at) || 0
    const end = Date.parse(mission.report_at ?? mission.updated_at) || start
    return Math.max(0, end - start)
  }

  /** Human-friendly duration: `3m 12s`, `45s`, `2h 05m`. */
  static humanDuration(ms: number): string {
    const total = Math.round(ms / 1000)
    if (total < 60) return `${total}s`
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  }

  /**
   * Rebuild `.mesh/HISTORY.md` from the mission list.
   *
   * Rebuilt, not appended: that is what makes "one line per mission" true even if a
   * mission is closed twice, and it keeps the order (oldest first) stable.
   */
  writeHistoryIndex(): string {
    const missions = [...this.store.listMissions()].sort((a, b) => a.mission_id.localeCompare(b.mission_id))
    const lines: string[] = []
    lines.push('# AgentMesh 协作史')
    lines.push('')
    lines.push('> 自动生成：`write_report` 完成一个 mission 时刷新，也可 `mesh mission close <id>` 手动重建。')
    lines.push('> 一行一个 mission；点报告看 lead 写给用户的成品。')
    lines.push('')
    if (missions.length === 0) {
      lines.push('（还没有 mission）')
    } else {
      lines.push('| # | Mission | 标题 | Lead | 卡 | 轮次 | 耗时 | 状态 | 报告 |')
      lines.push('|---|---|---|---|---|---|---|---|---|')
      missions.forEach((mission, index) => {
        const snapshot = this.tasksSnapshot(mission)
        const merged = snapshot.filter((t) => t.status === 'merged').length
        const total = snapshot.length
        const duration = MissionHistory.humanDuration(this.durationOf(mission))
        const title = mission.title.replace(/\|/g, '/')
        const reportFile = path.join(this.store.paths.missionDir(mission.mission_id), 'report.md')
        const reportLink = fs.existsSync(reportFile) ? `[报告](missions/${mission.mission_id}/report.md)` : '—'
        lines.push(
          `| ${index + 1} | ${mission.mission_id} | ${title} | ${mission.lead_agent} | ${merged}/${total} | ` +
            `${mission.rounds} | ${duration} | ${mission.status} | ${reportLink} |`,
        )
      })
      lines.push('')
      lines.push(`共 ${missions.length} 个 mission。`)
    }
    lines.push('')
    const file = this.store.paths.historyFile
    writeFileAtomic(file, `${lines.join('\n')}`)
    return this.store.paths.rel(file)
  }

  /** Copy the whole mission bundle somewhere else (`mesh mission export`). */
  export(missionId: string, outDir: string): { out: string; files: string[] } {
    const bundle = this.close(missionId)
    const source = path.resolve(this.store.paths.root, bundle.dir)
    const target = path.resolve(outDir)
    ensureDir(target)
    const copied: string[] = []
    const walk = (from: string, to: string): void => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name)
        const dest = path.join(to, entry.name)
        if (entry.isDirectory()) {
          ensureDir(dest)
          walk(src, dest)
        } else {
          fs.copyFileSync(src, dest)
          copied.push(path.relative(target, dest).split(path.sep).join('/'))
        }
      }
    }
    walk(source, target)
    return { out: target, files: copied }
  }
}
