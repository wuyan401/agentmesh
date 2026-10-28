/**
 * The scheduler (§13): turn board state into running Sessions, and clean up after
 * them. It never decides *content* — it only chooses who works, ensures the world
 * is ready (worktree, context package), launches the process, and reaps it.
 *
 * Every decision is recorded: a spawn, a release, an expiry and an automatic
 * merge all leave an audit event. That is what makes `mesh up` safe to run in a
 * loop — nothing happens off the record.
 */

import path from 'node:path'
import fs from 'node:fs'
import { MeshError } from '../core/errors.ts'
import { nowIso } from '../core/fsx.ts'
import { isProcessAlive } from '../core/lock.ts'
import { applyTransition } from '../core/stateMachine.ts'
import { withLock } from '../core/lock.ts'
import { buildSpawnPlan, describePlan, toolPrefixFor } from '../adapters/index.ts'
import { rankAgents, scoreAgent } from './scoring.ts'
import type { ScoredAgent } from './scoring.ts'
import { spawnSessionProcess, killProcess, tailLog, runForeground } from './process.ts'
import { buildPrompt, buildThreadDigest } from './prompt.ts'
import type { SpawnPlan as SpawnPlanType } from '../adapters/types.ts'
import type { Hub } from '../core/hub.ts'
import type { AgentCard, MissionCard, RoleId, SessionCard, TaskCard } from '../core/types.ts'
import type { SpawnContext } from '../adapters/types.ts'

export interface SpawnRecord {
  session_id: string
  agent_id: string
  role: RoleId
  task_id: string | null
  pid: number | null
  log: string
  injection: string
  command: string
}

export interface TickReport {
  at: string
  released: Array<{ task_id: string; session_id: string; reason: string }>
  reaped: string[]
  expired: string[]
  dispatched: SpawnRecord[]
  reviews: SpawnRecord[]
  merged: Array<{ task_id: string; merge_commit: string; mode: string }>
  blocked: Array<{ task_id: string; reason: string }>
  skipped: Array<{ task_id: string | null; reason: string }>
  dead_messages: number
  /** V2: mission transitions and lead turns made this tick. */
  missions: {
    advanced: Array<{ mission_id: string; from: string; to: string; note: string }>
    leads: SpawnRecord[]
  }
}

const MAX_RELEASES_PER_TASK = 3
const MAX_REVIEW_ATTEMPTS = 3

export class Scheduler {
  readonly hub: Hub
  private ticks = 0

  constructor(hub: Hub) {
    this.hub = hub
  }

  // -- public loop ---------------------------------------------------------

  async run(opts: {
    once?: boolean
    intervalMs?: number
    maxTicks?: number
    onTick?: (report: TickReport) => void
    sleep?: (ms: number) => Promise<void>
  } = {}): Promise<void> {
    const interval = opts.intervalMs ?? this.hub.config.dispatch_interval_ms
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const maxTicks = opts.once ? 1 : (opts.maxTicks ?? Number.POSITIVE_INFINITY)
    for (let i = 0; i < maxTicks; i++) {
      const report = await this.tick()
      opts.onTick?.(report)
      if (opts.once) return
      await sleep(interval)
    }
  }

  // -- one tick ------------------------------------------------------------

  async tick(): Promise<TickReport> {
    this.ticks++
    const report: TickReport = {
      at: nowIso(),
      released: [],
      reaped: [],
      expired: [],
      dispatched: [],
      reviews: [],
      merged: [],
      blocked: [],
      skipped: [],
      dead_messages: 0,
      missions: { advanced: [], leads: [] },
    }

    this.sweepSessions(report)
    this.releaseStrandedTasks(report)
    this.reapSubmittedWork(report)
    this.releaseAbandonedReviews(report)
    this.requeueRejected(report)
    this.publishUnblocked()
    // Missions first: a planning mission that just finished needs its cards to become
    // claimable in this same tick, not the next one.
    this.advanceMissions(report)
    this.dispatchLeadTurns(report)
    this.dispatchWorkers(report)
    this.dispatchReviews(report)
    this.integrate(report)
    if (this.ticks % 5 === 0 || this.ticks === 1) {
      report.dead_messages = this.hub.bus.sweep().dead
    }
    return report
  }

  /** Recovery-only pass: reap dead sessions and release their work, dispatch nothing. */
  recover(): { released: TickReport['released']; reaped: string[]; expired: string[] } {
    const report: TickReport = {
      at: nowIso(),
      released: [],
      reaped: [],
      expired: [],
      dispatched: [],
      reviews: [],
      merged: [],
      blocked: [],
      skipped: [],
      dead_messages: 0,
      missions: { advanced: [], leads: [] },
    }

    this.sweepSessions(report)
    this.releaseStrandedTasks(report)
    this.reapSubmittedWork(report)
    this.releaseAbandonedReviews(report)
    this.publishUnblocked()
    return { released: report.released, reaped: report.reaped, expired: report.expired }
  }

  // -- session hygiene -----------------------------------------------------

  private sweepSessions(report: TickReport): void {
    for (const session of this.hub.store.liveSessions()) {
      // 1. process actually gone?
      if (session.pid && !isProcessAlive(session.pid)) {
        this.hub.identity.closeSession(session.session_id, 'exited', { code: null, note: 'process exited' })
        this.releaseIfOrphaned(session, report, 'worker process exited without submitting')
        continue
      }
      // 2. lease expired?
      if (this.hub.identity.isExpired(session)) {
        if (session.pid) killProcess(session.pid)
        this.hub.identity.closeSession(session.session_id, 'expired', { code: null, note: 'ttl expired' })
        report.expired.push(session.session_id)
        this.hub.audit.violation({
          kind: 'liveness.stale-session',
          session_id: session.session_id,
          agent_id: session.agent_id,
          task_id: session.task,
          detail: `session ${session.session_id} exceeded its ${session.ttl_seconds}s lease and was reclaimed`,
        })
        this.releaseIfOrphaned(session, report, 'session expired')
      }
    }
  }

  /**
   * Cards whose claiming Session is gone. A crash, a `mesh sessions kill`, or a
   * worker that exited without submitting all leave the same trace: a claimed card
   * with no live holder. Without this pass the board would keep a ghost claim
   * forever, which looks exactly like a stuck platform.
   */
  private releaseStrandedTasks(report: TickReport): void {
    for (const task of this.hub.store.listTasks()) {
      if (task.status !== 'claimed' && task.status !== 'in_progress') continue
      const session = task.claimed_by ? this.hub.store.getSession(task.claimed_by) : null
      const live =
        session &&
        (session.status === 'active' || session.status === 'starting') &&
        (session.pid === null || isProcessAlive(session.pid))
      if (live) continue
      this.releaseTask(task.task_id, task.claimed_by ?? 'none', report, 'claiming session is no longer live')
    }
  }

  private releaseTask(taskId: string, sessionId: string, report: TickReport, reason: string): void {
    const task = this.hub.store.getTask(taskId)
    if (!task || (task.status !== 'claimed' && task.status !== 'in_progress')) return
    const attempts = this.hub.store
      .auditEvents()
      .filter((e) => e['event'] === 'task.released' && e['task_id'] === taskId).length
    if (attempts >= MAX_RELEASES_PER_TASK) {
      this.hub.board.blockTask(taskId, `released ${attempts} times (${reason}); needs coordinator arbitration`, 'hub.scheduler')
      report.blocked.push({ task_id: taskId, reason: `released ${attempts} times` })
      return
    }
    withLock(this.hub.paths.lockFile(`task-${taskId}`), () => {
      const fresh = this.hub.store.requireTask(taskId)
      if (fresh.status !== 'claimed' && fresh.status !== 'in_progress') return
      applyTransition(fresh, 'ready', { by: 'hub.scheduler', note: reason })
      fresh.claimed_by = null
      fresh.implementer_agent = null
      this.hub.store.saveTask(fresh)
    })
    this.hub.store.auditEvent('task.released', { task_id: taskId, session_id: sessionId, reason })
    this.hub.store.boardEvent({ event: 'task.released', task_id: taskId, reason })
    report.released.push({ task_id: taskId, session_id: sessionId, reason })
  }

  /** A dead Session's unfinished task goes back to the board — with an attempt budget. */
  private releaseIfOrphaned(session: SessionCard, report: TickReport, reason: string): void {
    if (!session.task) return
    const task = this.hub.store.getTask(session.task)
    if (!task) return
    if (task.status !== 'claimed' && task.status !== 'in_progress') return
    if (task.claimed_by && task.claimed_by !== session.session_id) return
    this.releaseTask(task.task_id, session.session_id, report, reason)
  }

  /** "ephemeral: the process dies the moment it submits" (§4.4). */
  private reapSubmittedWork(report: TickReport): void {
    for (const session of this.hub.store.liveSessions()) {
      if (session.lifespan !== 'ephemeral' || !session.task) continue
      if (session.role === 'supervisor' || session.role === 'integrator') continue
      const task = this.hub.store.getTask(session.task)
      if (!task) continue
      if (!['submitted', 'reviewing', 'approved', 'merged'].includes(task.status)) continue
      const stillRunning = session.pid ? isProcessAlive(session.pid) : false
      if (stillRunning && task.status === 'submitted') {
        // Give the worker a moment to exit on its own after submit.
        const age = Date.now() - Date.parse(session.last_heartbeat_at)
        if (age < 15_000) continue
      }
      if (stillRunning && session.pid) killProcess(session.pid)
      this.hub.identity.closeSession(session.session_id, 'exited', { code: 0, note: 'work submitted' })
      report.reaped.push(session.session_id)
    }
  }

  /**
   * Put rejected cards back on the open board (§2.3).
   *
   * A rejection ends the working session, so a rejected card is nobody's work. It has
   * to go back to `ready` or the counter could never reach the threshold and the card
   * would sit there until a human noticed. Who gets it next is the picker's decision:
   * below `reassign_after_rejections` the same agent may try again, at/above it the
   * rejectees are excluded and the best remaining agent takes over.
   */
  private requeueRejected(report: TickReport): void {
    const threshold = this.hub.config.reassign_after_rejections
    for (const task of this.hub.store.listTasks()) {
      if (task.status !== 'rejected') continue
      const count = task.rejection_count ?? 0
      const requeued = this.hub.board.requeueRejectedTask(
        task.task_id,
        count >= threshold ? `reassigned after ${count} rejections` : `retry (${count}/${threshold} rejections)`,
      )
      if (requeued) {
        report.skipped.push({
          task_id: task.task_id,
          reason: count >= threshold ? `requeued for reassignment (${count} rejections)` : `requeued for retry (${count} rejections)`,
        })
      }
    }
  }

  private publishUnblocked(): void {
    for (const draft of this.hub.board.readyCandidates()) {
      this.hub.board.publishTask(draft.task_id)
    }
  }

  // -- missions (V2) -------------------------------------------------------

  /** Run the mission auto-advance rules (spec §1.2) once. */
  private advanceMissions(report: TickReport): void {
    for (const change of this.hub.missions.advanceMissions()) {
      report.missions.advanced.push(change)
    }
  }

  /**
   * Spawn one lead turn for a mission and return what was launched.
   *
   * Public because the chat entry (`start_mission`) wants the lead working *now*, not
   * on the next tick — the caller ends its own turn immediately after.
   */
  spawnLeadTurn(mission: MissionCard, phase: 'planning' | 'integrating', session?: SessionCard): SpawnRecord {
    const agent = this.hub.store.requireAgent(mission.lead_agent)
    const lead = session ?? this.hub.missions.createLeadSession(mission.mission_id, { spawned_by: 'hub.scheduler' })
    return this.launch(lead, agent, null, null, {
      extraSection: this.hub.missions.leadBrief(mission, phase),
    })
  }

  /**
   * Spawn the lead turn for a mission that needs one: `intake` (plan it) or
   * `integrating` (integrate + second acceptance + report).
   *
   * A builtin lead (the human operator) is not spawned — the human drives it through
   * the CLI, which is exactly how the M1 acceptance walk works.
   */
  private dispatchLeadTurns(report: TickReport): void {
    const pending = this.hub.missions.missionsNeedingLead()
    if (pending.length === 0) return
    for (const { mission, phase } of pending) {
      const agent = this.hub.store.getAgent(mission.lead_agent)
      if (!agent || !agent.enabled) {
        report.skipped.push({ task_id: null, reason: `mission ${mission.mission_id}: lead agent ${mission.lead_agent} is not usable` })
        continue
      }
      if (agent.kind === 'builtin') {
        report.skipped.push({
          task_id: null,
          reason: `mission ${mission.mission_id}: builtin lead — drive it by hand (mesh mission plan …)`,
        })
        continue
      }
      const running = this.hub.store.liveSessions().filter((s) => s.lifespan === 'ephemeral' || s.pid !== null)
      if (running.length >= this.hub.config.max_concurrent_sessions) {
        report.skipped.push({ task_id: null, reason: `mission ${mission.mission_id}: no session budget for the lead turn` })
        continue
      }
      try {
        report.missions.leads.push(this.spawnLeadTurn(mission, phase))
      } catch (e) {
        report.skipped.push({
          task_id: null,
          reason: `mission ${mission.mission_id}: ${e instanceof MeshError ? `${e.code}: ${e.message}` : (e as Error).message}`,
        })
      }
    }
  }

  /** Record first participation so the mission's teammate list stays in order. */
  private noteMissionParticipant(taskId: string, agentId: string): void {
    const mission = this.hub.missions.missionOfTask(taskId)
    if (mission) this.hub.missions.noteParticipant(mission.mission_id, agentId)
  }

  // -- dispatching ---------------------------------------------------------

  private activeCount(agentId: string): number {
    return this.hub.store.activeSessionsOfAgent(agentId).length
  }

  /**
   * Rank the eligible agents for a card by the §2.2 score.
   *
   * Eligibility is exactly V1's: enabled, not the builtin core, holds the role,
   * has concurrency left, and passes SoD. Scoring only decides the *order* of
   * people who are already allowed to do the work — it never grants permission.
   */
  rankCandidates(role: RoleId, task: TaskCard | null, mission?: MissionCard | null): ScoredAgent[] {
    const scored: ScoredAgent[] = []
    for (const agent of this.hub.store.listAgents()) {
      if (!agent.enabled || agent.kind === 'builtin') continue
      if (!agent.capabilities.includes(role)) continue
      if (this.hub.identity.concurrencyAvailable(agent) <= 0) continue
      if (task && this.hub.identity.sodConflict(task, agent.agent_id, role) !== null) continue
      scored.push(
        scoreAgent({
          agent,
          profile: this.hub.store.getProfile(agent.agent_id),
          load: this.activeCount(agent.agent_id),
          task,
        }),
      )
    }
    void mission
    return rankAgents(scored)
  }

  /** The effective choice: highest score, ties broken by agent_id (reproducible). */
  pickAgent(role: RoleId, task: TaskCard | null, mission?: MissionCard | null): AgentCard | null {
    return this.selectAgent(role, task, mission).agent
  }

  /**
   * The full dispatch decision, including *why* it is not somebody.
   *
   * §2.3 is enforced here rather than in the caller: once a card has been rejected
   * `reassign_after_rejections` times, the agents who were already rejected on it are
   * removed from the candidate set. If that empties the set the card is blocked —
   * "绝不悄悄重派同一个人" is a property of this function, not of the caller's manners.
   */
  selectAgent(
    role: RoleId,
    task: TaskCard | null,
    mission?: MissionCard | null,
  ): { agent: AgentCard | null; scored: ScoredAgent[]; excluded: string[]; blocked: string | null } {
    const reassignAt = this.hub.config.reassign_after_rejections
    const rejectionCount = task?.rejection_count ?? 0
    const mustReassign = Boolean(task) && rejectionCount >= reassignAt
    const excluded = new Set<string>()
    if (mustReassign && task) {
      if (task.implementer_agent) excluded.add(task.implementer_agent)
      for (const agentId of task.rejected_by ?? []) excluded.add(agentId)
    }

    const ranked = this.rankCandidates(role, task, mission)
    const remaining = ranked.filter((s) => !excluded.has(s.agent_id))

    if (remaining.length === 0) {
      if (mustReassign) {
        return {
          agent: null,
          scored: ranked,
          excluded: [...excluded].sort(),
          // §2.3 wording, verbatim: the human reading the board must see this exact reason.
          blocked: '需要更强或更多的 agent',
        }
      }
      return { agent: null, scored: ranked, excluded: [...excluded].sort(), blocked: null }
    }

    // The lead's explicit choice wins — but never over the exclusion list above.
    if (!mustReassign && task?.preferred_agent) {
      const preferred = remaining.find((s) => s.agent_id === task.preferred_agent)
      if (preferred) {
        return {
          agent: this.hub.store.requireAgent(preferred.agent_id),
          scored: remaining,
          excluded: [...excluded].sort(),
          blocked: null,
        }
      }
    }

    const best = remaining[0]!
    return {
      agent: this.hub.store.requireAgent(best.agent_id),
      scored: remaining,
      excluded: [...excluded].sort(),
      blocked: null,
    }
  }

  private dispatchWorkers(report: TickReport): void {
    // Only Sessions that actually own a process count against the budget: a
    // CLI-attributed or builtin daemon Session has no process and must not starve
    // the board of worker slots.
    const running = this.hub.store.liveSessions().filter((s) => s.lifespan === 'ephemeral' || s.pid !== null)
    const budget = Math.max(0, this.hub.config.max_concurrent_sessions - running.length)
    if (budget === 0) return
    const ready = this.hub.store.listTasks().filter((t) => t.status === 'ready')
    for (const task of ready) {
      if (report.dispatched.length >= budget) {
        report.skipped.push({ task_id: task.task_id, reason: 'concurrency budget reached' })
        continue
      }
      const mission = this.hub.missions.missionOfTask(task.task_id)
      const decision = this.selectAgent(task.role, task, mission)
      if (!decision.agent) {
        if (decision.blocked) {
          // §2.3: nobody left who is allowed to touch it → stop, with the reason on the card.
          this.hub.board.blockTask(task.task_id, decision.blocked, 'hub.scheduler')
          report.blocked.push({ task_id: task.task_id, reason: decision.blocked })
        } else {
          report.skipped.push({ task_id: task.task_id, reason: `no eligible agent for role ${task.role}` })
        }
        continue
      }
      try {
        report.dispatched.push(this.spawnWorker(task, decision.agent))
      } catch (e) {
        const msg = e instanceof MeshError ? `${e.code}: ${e.message}` : (e as Error).message
        report.skipped.push({ task_id: task.task_id, reason: msg })
      }
    }
  }

  /** Build the world for one worker and launch it. */
  spawnWorker(task: TaskCard, agent: AgentCard): SpawnRecord {
    const session = this.hub.identity.createSession({
      agent_id: agent.agent_id,
      role: task.role,
      task: task.task_id,
      spawned_by: 'hub.scheduler',
      sandbox: this.hub.paths.worktreeRel(task.task_id),
      lifespan: 'ephemeral',
    })
    try {
      this.hub.board.preclaimTask(session.session_id, task.task_id)
      // The claim may have picked a different sandbox slot; record the real one.
      const claimed = this.hub.store.requireTask(task.task_id)
      const bound = this.hub.store.requireSession(session.session_id)
      bound.sandbox = claimed.worktree
      this.hub.store.saveSession(bound)
      this.noteMissionParticipant(claimed.task_id, agent.agent_id)
      this.hub.profiles.noteTask(agent.agent_id)
      const contextPath = this.ensureContext(task.task_id, session.session_id)
      return this.launch(bound, agent, claimed, contextPath)
    } catch (e) {
      this.hub.identity.closeSession(session.session_id, 'failed', { code: null, note: (e as Error).message })
      throw e
    }
  }

  private dispatchReviews(report: TickReport): void {
    const pending = this.hub.store.listTasks().filter((t) => t.status === 'submitted' || t.status === 'reviewing')
    for (const task of pending) {
      const already = this.hub.store
        .liveSessions()
        .some((s) => s.role === 'supervisor' && s.task === task.task_id)
      if (already) {
        report.skipped.push({ task_id: task.task_id, reason: 'a supervisor is already on it' })
        continue
      }
      // Count only attempts since the last unblock: a human saying "try again" is a
      // decision, and it should reset the retry budget.
      const events = this.hub.store.auditEvents()
      const lastUnblock = events.map((e) => (e['event'] === 'task.unblocked' && e['task_id'] === task.task_id ? String(e['at']) : '')).filter(Boolean).sort().pop() ?? ''
      const attempts = events.filter(
        (e) => e['event'] === 'review.attempt' && e['task_id'] === task.task_id && String(e['at']) > lastUnblock,
      ).length
      if (attempts >= MAX_REVIEW_ATTEMPTS) {
        this.hub.board.blockTask(
          task.task_id,
          `review failed ${attempts} times without a verdict; needs coordinator arbitration`,
          'hub.scheduler',
        )
        report.blocked.push({ task_id: task.task_id, reason: `review attempts exhausted (${attempts})` })
        continue
      }
      const agent = this.pickAgent('supervisor', task)
      if (!agent) {
        report.skipped.push({ task_id: task.task_id, reason: 'no eligible supervisor (SoD or capacity)' })
        continue
      }
      try {
        report.reviews.push(this.spawnReviewer(task, agent))
      } catch (e) {
        const msg = e instanceof MeshError ? `${e.code}: ${e.message}` : (e as Error).message
        report.skipped.push({ task_id: task.task_id, reason: msg })
      }
    }
  }

  /**
   * A reviewer process can die without writing a verdict (crash, profile lock,
   * timeout). The card then said "reviewing" with nobody reviewing it, which is how
   * a board silently stalls. Put it back to `submitted` so the next tick retries —
   * and count the attempt, so a task whose reviews keep failing eventually needs a
   * human instead of looping forever.
   */
  private releaseAbandonedReviews(report: TickReport): void {
    for (const task of this.hub.store.listTasks()) {
      if (task.status !== 'reviewing') continue
      const liveSupervisor = this.hub.store
        .liveSessions()
        .some((s) => s.role === 'supervisor' && s.task === task.task_id)
      if (liveSupervisor) continue
      const decided = this.hub.store.listReviews(task.task_id).some((r) => r.submission_commit === task.submission?.commit)
      if (decided) continue
      withLock(this.hub.paths.lockFile(`task-${task.task_id}`), () => {
        const fresh = this.hub.store.requireTask(task.task_id)
        if (fresh.status !== 'reviewing') return
        applyTransition(fresh, 'submitted', { by: 'hub.scheduler', note: 'review abandoned without a verdict' })
        this.hub.store.saveTask(fresh)
      })
      this.hub.store.auditEvent('review.abandoned', { task_id: task.task_id })
      report.skipped.push({ task_id: task.task_id, reason: 'review abandoned; returned to submitted' })
    }
  }

  spawnReviewer(task: TaskCard, agent: AgentCard): SpawnRecord {
    const session = this.hub.identity.createSession({
      agent_id: agent.agent_id,
      role: 'supervisor',
      task: task.task_id,
      spawned_by: 'hub.scheduler',
      sandbox: this.hub.paths.worktreeRel(task.task_id),
      lifespan: 'ephemeral',
    })
    try {
      const contextPath = this.ensureContext(task.task_id, session.session_id)
      const fresh = this.hub.store.requireTask(task.task_id)
      const bound = this.hub.store.requireSession(session.session_id)
      bound.sandbox = fresh.worktree
      this.hub.store.saveSession(bound)
      this.noteMissionParticipant(fresh.task_id, agent.agent_id)
      this.hub.store.auditEvent('review.attempt', {
        task_id: task.task_id,
        session_id: session.session_id,
        agent_id: agent.agent_id,
      })
      return this.launch(bound, agent, fresh, contextPath, { extraSection: this.reviewBrief(fresh) })
    } catch (e) {
      this.hub.identity.closeSession(session.session_id, 'failed', { code: null, note: (e as Error).message })
      throw e
    }
  }

  private reviewBrief(task: TaskCard): string {
    const base = task.base_commit ?? ''
    const commit = task.submission?.commit ?? ''
    const sandbox = task.worktree ? path.resolve(this.hub.paths.root, task.worktree) : this.hub.paths.worktree(task.task_id)
    return [
      '## 审查材料',
      '',
      `- 沙箱（可直接读代码）：${sandbox}`,
      `- 改动范围：\`git diff ${base.slice(0, 8)}..${commit.slice(0, 8)} --stat\``,
      task.submission ? `- 提交摘要：${task.submission.summary}` : '',
      `- 改动文件：${(task.submission?.files ?? []).join(', ')}`,
      '',
      '裁决时：逐条 acceptance 给出 pass/evidence，然后调用 verdict。发现越界文件（scope.write 之外）要指出来——合并终审会独立再查一遍，但你的审查应该先发现它。',
    ]
      .filter(Boolean)
      .join('\n')
  }

  /** Build the context package and return its absolute path (agents live in a sandbox cwd). */
  private ensureContext(taskId: string, sessionId: string | null): string {
    const built = this.hub.context.build({ taskId, level: this.hub.config.context_level, sessionId })
    const task = this.hub.store.requireTask(taskId)
    task.context_package = built.path
    task.context_level = built.level
    this.hub.store.saveTask(task)
    return path.resolve(this.hub.paths.root, built.path)
  }

  /** Compose the prompt and the launch plan for one Session (no side effects beyond scratch files). */
  private prepare(
    session: SessionCard,
    agent: AgentCard,
    task: TaskCard | null,
    contextPath: string | null,
    extras: { extraSection?: string; userMessage?: string; threadDigest?: string } = {},
  ): { ctx: SpawnContext; plan: SpawnPlanType; logFile: string } {
    const worktree = task
      ? path.resolve(this.hub.paths.root, task.worktree ?? this.hub.paths.worktreeRel(task.task_id))
      : this.hub.paths.root
    if (!fs.existsSync(worktree)) fs.mkdirSync(worktree, { recursive: true })

    const threadDigest =
      extras.threadDigest ??
      (session.role === 'coordinator' || session.role === 'supervisor'
        ? buildThreadDigest(this.hub.bus.threadHistory(task?.task_id ?? '*'))
        : undefined)

    const prompt = buildPrompt({
      paths: this.hub.paths,
      session,
      agent,
      role: session.role,
      task,
      worktree,
      toolPrefix: toolPrefixFor(agent),
      contextPath,
      threadDigest,
      userMessage: extras.userMessage,
      extraSection: extras.extraSection,
      // V2 §3: "你在哪 + 队友" goes into the prompt itself, at the configured level.
      // Rendered by ContextBuilder so the prompt and the context package can never
      // tell the agent two different stories.
      contextSections: this.contextSections(task, session, session.role),
    })

    const ctx: SpawnContext = {
      hub: this.hub,
      session,
      agent,
      role: session.role,
      task,
      worktree,
      prompt,
      scratch: this.hub.paths.sessionScratch(session.session_id),
      contextPath,
    }
    const plan = buildSpawnPlan(ctx)
    fs.mkdirSync(ctx.scratch, { recursive: true })
    fs.writeFileSync(path.join(ctx.scratch, 'prompt.md'), prompt)
    return { ctx, plan, logFile: this.hub.paths.sessionLog(session.session_id) }
  }

  private markSpawned(session: SessionCard, agent: AgentCard, task: TaskCard | null, plan: SpawnPlanType, pid: number | null, logFile: string): SpawnRecord {
    const updated = this.hub.store.requireSession(session.session_id)
    updated.pid = pid
    updated.status = 'active'
    updated.last_heartbeat_at = nowIso()
    this.hub.store.saveSession(updated)
    this.hub.store.auditEvent('session.spawned', {
      session_id: session.session_id,
      agent_id: agent.agent_id,
      role: session.role,
      task: task?.task_id ?? null,
      pid,
      injection: plan.injection,
      command: describePlan(plan),
      log: this.hub.paths.rel(logFile),
    })
    return {
      session_id: session.session_id,
      agent_id: agent.agent_id,
      role: session.role,
      task_id: task?.task_id ?? null,
      pid,
      log: this.hub.paths.rel(logFile),
      injection: plan.injection,
      command: describePlan(plan),
    }
  }

  /** §3.1 + §3.2, at the level the project configured (`minimal` = compact only). */
  private contextSections(task: TaskCard | null, session: SessionCard, role: RoleId): string | undefined {
    if (!task) return undefined
    const level = this.hub.config.context_level
    const parts: string[] = [this.hub.context.renderMissionSection(task, session.session_id, level)]
    if (level !== 'minimal') parts.push(this.hub.context.renderPlatformSection(role))
    return parts.join('\n\n')
  }

  private launch(
    session: SessionCard,
    agent: AgentCard,
    task: TaskCard | null,
    contextPath: string | null,
    extras: { extraSection?: string; userMessage?: string; threadDigest?: string } = {},
  ): SpawnRecord {
    const { plan, logFile } = this.prepare(session, agent, task, contextPath, extras)
    const spawned = spawnSessionProcess(plan, logFile)
    return this.markSpawned(session, agent, task, plan, spawned.pid, logFile)
  }

  /**
   * One turn for a daemon session (coordinator / supervisor / integrator).
   * Continuity comes from the platform's own message log, not from a provider
   * session id: every turn sees the recent thread, which keeps it auditable.
   */
  turn(
    sessionId: string,
    opts: { userMessage?: string; taskId?: string | null; extraSection?: string; threadDigest?: string } = {},
  ): SpawnRecord {
    const session = this.hub.store.requireSession(sessionId)
    const agent = this.hub.store.requireAgent(session.agent_id)
    const task = opts.taskId ? this.hub.store.getTask(opts.taskId) : null
    const contextPath = task ? this.ensureContext(task.task_id, session.session_id) : null
    return this.launch(session, agent, task, contextPath, {
      userMessage: opts.userMessage,
      extraSection: opts.extraSection,
      threadDigest: opts.threadDigest,
    })
  }

  /** Foreground turn: block until the agent answers (what `mesh talk` needs). */
  runTurn(
    sessionId: string,
    opts: {
      userMessage?: string
      taskId?: string | null
      extraSection?: string
      threadDigest?: string
      timeoutMs?: number
    } = {},
  ): { record: SpawnRecord; stdout: string; stderr: string; code: number | null; timedOut: boolean } {
    const session = this.hub.store.requireSession(sessionId)
    const agent = this.hub.store.requireAgent(session.agent_id)
    const task = opts.taskId ? this.hub.store.getTask(opts.taskId) : null
    const contextPath = task ? this.ensureContext(task.task_id, session.session_id) : null
    const { plan, logFile } = this.prepare(session, agent, task, contextPath, {
      userMessage: opts.userMessage,
      extraSection: opts.extraSection,
      threadDigest: opts.threadDigest,
    })
    // Mark it live for the duration so in-flight hub calls from the child resolve.
    const live = this.hub.store.requireSession(sessionId)
    live.status = 'active'
    live.last_heartbeat_at = nowIso()
    live.turns += 1
    this.hub.store.saveSession(live)
    const result = runForeground(plan, logFile, opts.timeoutMs ?? 900_000)
    this.hub.identity.closeSession(sessionId, 'exited', { code: result.code, note: 'turn finished' })
    return {
      record: this.markSpawned(session, agent, task, plan, process.pid, logFile),
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      timedOut: result.timedOut,
    }
  }

  // -- integration ---------------------------------------------------------

  /** A deterministic integrator Session, so merges are attributed to a real identity. */
  ensureDaemonSession(agentId: string, role: RoleId): SessionCard | null {
    const existing = this.hub.store
      .liveSessions()
      .find((s) => s.agent_id === agentId && s.role === role && s.task === null)
    if (existing) {
      this.hub.identity.touch(existing.session_id)
      return this.hub.store.requireSession(existing.session_id)
    }
    const agent = this.hub.store.getAgent(agentId)
    if (!agent || !agent.enabled || !agent.capabilities.includes(role)) return null
    const session = this.hub.identity.createSession({
      agent_id: agentId,
      role,
      spawned_by: 'hub.scheduler',
      lifespan: 'daemon',
      ttl_seconds: 86_400,
    })
    this.hub.identity.hello(session.session_id)
    return this.hub.store.requireSession(session.session_id)
  }

  private integrate(report: TickReport): void {
    if (!this.hub.config.auto_integrate) return
    const pending = this.hub.board.tasksPendingMerge()
    if (pending.length === 0) return
    const integratorSession = this.ensureDaemonSession('mesh-hub', 'integrator')
    const identity = integratorSession ? this.hub.store.requireSession(integratorSession.session_id) : null
    const integratorIdentity = identity ? this.hub.identity.requireIdentity(identity.session_id) : null
    for (const task of pending) {
      try {
        const result = this.hub.board.mergeTask(task.task_id, {
          identity: integratorIdentity ?? null,
          auto: integratorIdentity === null,
          actorId: integratorIdentity ? undefined : 'hub(auto-integrator)',
        })
        report.merged.push({ task_id: task.task_id, merge_commit: result.merge_commit, mode: result.mode })
      } catch (e) {
        report.blocked.push({
          task_id: task.task_id,
          reason: e instanceof MeshError ? `${e.code}: ${e.message}` : (e as Error).message,
        })
      }
    }
  }

  // -- operator helpers ----------------------------------------------------

  /** Kill every live session (used by `mesh down`). */
  stopAll(): string[] {
    const stopped: string[] = []
    for (const session of this.hub.store.liveSessions()) {
      if (session.pid) killProcess(session.pid)
      this.hub.identity.closeSession(session.session_id, 'killed', { code: null, note: 'mesh down' })
      stopped.push(session.session_id)
    }
    return stopped
  }

  recentLog(sessionId: string, lines = 20): string {
    return tailLog(this.hub.paths.sessionLog(sessionId), lines)
  }
}
