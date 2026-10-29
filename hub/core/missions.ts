/**
 * Missions (V2): the two-level model.
 *
 *   Mission（用户下发的一件事，有 lead，有验收标准，有报告）
 *     └─ TaskCard × N（lead 拆出来的活）
 *           └─ Review × 1（由非实现者的另一个 agent 做）
 *
 * The lead is **not a global role, it is a mission property**: whoever received the
 * job leads it, and their rights die with that mission. This module owns the mission
 * state machine's edges: creating, planning, dispatching, the second acceptance, and
 * the report. It never touches the merge gate — scope final review (C1/L3) applies to
 * every card exactly as before.
 */

import path from 'node:path'
import fs from 'node:fs'
import { MeshError, MESH_ERRORS } from './errors.ts'
import { nowIso } from './fsx.ts'
import { isProcessAlive } from './lock.ts'
import { applyMissionTransition, canMissionTransition } from './stateMachine.ts'
import { MissionHistory } from './history.ts'
import type { TimelineEvent } from './history.ts'
import { missionOfTask } from './teammates.ts'
import { loadConfig } from './config.ts'
import type { MeshConfig } from './config.ts'
import type { Board } from './board.ts'
import type { Identity, IdentityService } from './identity.ts'
import type { MeshStore } from './store.ts'
import type { ProfileService } from './profiles.ts'
import type { AgentCard, MissionCard, MissionPlanEntry, RoleId, SessionCard, TaskCard } from './types.ts'

const MISSION_LEAD_ROLE: RoleId = 'lead'

function fsExists(file: string): boolean {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}

export interface CreateMissionInput {
  title: string
  brief: string
  acceptance?: string[]
  lead_agent?: string | null
  source?: 'platform' | 'chat'
  parent_mission?: string | null
}

export interface PlanTaskInput {
  title: string
  role: RoleId
  scope: { write: string[]; read?: string[] }
  acceptance: string[]
  depends_on?: string[]
  /** Preferred implementer; omitted means the scheduler picks. */
  agent?: string | null
  why?: string
}

export interface MissionTaskSummary {
  task_id: string
  title: string
  role: RoleId
  status: string
  implementer_agent: string | null
  reviewer_agent: string | null
  merge_commit: string | null
}

export interface MissionView {
  mission: MissionCard
  tasks: MissionTaskSummary[]
  progress: { total: number; merged: number; cancelled: number; settled: boolean }
  lead_session_live: boolean
}

export class MissionService {
  readonly store: MeshStore
  readonly board: Board
  readonly identity: IdentityService
  readonly profiles: ProfileService
  readonly history: MissionHistory

  constructor(deps: {
    store: MeshStore
    board: Board
    identity: IdentityService
    profiles: ProfileService
    history?: MissionHistory
  }) {
    this.store = deps.store
    this.board = deps.board
    this.identity = deps.identity
    this.profiles = deps.profiles
    this.history = deps.history ?? new MissionHistory(deps.store)
  }

  private config(): MeshConfig {
    return loadConfig(this.store.paths)
  }

  // -- creation ------------------------------------------------------------

  /**
   * Whether an agent is a candidate lead: enabled and registered for the role.
   *
   * M1 has no scoring yet (`pickLead` by quality_score arrives with AgentProfile in
   * M2), so the interim rule is: configured lead first, then the cheapest capable
   * agent, then a stable agent_id tie-break so the choice is reproducible.
   */
  pickLead(): AgentCard | null {
    const config = this.config()
    const capable = this.store
      .listAgents()
      .filter((a) => a.enabled && a.capabilities.includes(MISSION_LEAD_ROLE))
    if (capable.length === 0) return null
    const configured = config.mission_lead_agent ? capable.find((a) => a.agent_id === config.mission_lead_agent) : undefined
    if (configured) return configured
    const ranked = [...capable].sort((a, b) => {
      const aBuiltin = a.kind === 'builtin' ? 1 : 0
      const bBuiltin = b.kind === 'builtin' ? 1 : 0
      if (aBuiltin !== bBuiltin) return aBuiltin - bBuiltin
      if (a.cost_tier !== b.cost_tier) return a.cost_tier - b.cost_tier
      return a.agent_id.localeCompare(b.agent_id)
    })
    return ranked[0] ?? null
  }

  /** Depth of the parent chain, 0 for a root mission. */
  depthOf(mission: MissionCard | null): number {
    let depth = 0
    let cursor = mission
    while (cursor?.parent_mission) {
      depth++
      cursor = this.store.getMission(cursor.parent_mission)
      if (depth > 64) break
    }
    return depth
  }

  createMission(input: CreateMissionInput, actor?: Identity | null): MissionCard {
    const title = String(input.title ?? '').trim()
    const brief = String(input.brief ?? '').trim() || title
    if (!title) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'mission needs a title')
    if (!brief) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'mission needs a brief (the user words)')

    let parent: MissionCard | null = null
    if (input.parent_mission) {
      parent = this.store.requireMission(input.parent_mission)
      const config = this.config()
      const maxDepth = config.mission_max_depth
      if (maxDepth > 0 && this.depthOf(parent) + 1 >= maxDepth) {
        throw new MeshError(MESH_ERRORS.MISSION_STATE, `nested mission depth limit reached (${maxDepth})`, {
          parent_mission: parent.mission_id,
          max_depth: maxDepth,
        })
      }
    }

    const lead = input.lead_agent ? this.store.requireAgent(input.lead_agent) : this.pickLead()
    if (!lead) {
      throw new MeshError(MESH_ERRORS.CAPABILITY_MISSING, 'no agent registered for the lead role', {
        hint: 'run `mesh init` (it adds the lead capability) or `mesh agents roles <id> lead …`',
      })
    }
    if (!lead.enabled) {
      throw new MeshError(MESH_ERRORS.ROLE_FORBIDDEN, `lead agent ${lead.agent_id} is disabled`, { agent_id: lead.agent_id })
    }
    if (!lead.capabilities.includes(MISSION_LEAD_ROLE)) {
      throw new MeshError(MESH_ERRORS.CAPABILITY_MISSING, `agent ${lead.agent_id} is not registered for the lead role`, {
        agent_id: lead.agent_id,
        capabilities: lead.capabilities,
      })
    }

    const missionId = this.store.nextId('mission')
    const now = nowIso()
    const mission: MissionCard = {
      mission_id: missionId,
      title,
      brief,
      acceptance: (input.acceptance ?? []).map((s) => String(s).trim()).filter(Boolean),
      lead_agent: lead.agent_id,
      lead_session: null,
      status: 'intake',
      tasks: [],
      teammates: [lead.agent_id],
      plan: [],
      report: null,
      report_at: null,
      rounds: 0,
      rejected_tasks: [],
      source: input.source ?? (actor ? 'chat' : 'platform'),
      parent_mission: parent?.mission_id ?? null,
      created_at: now,
      updated_at: now,
      history: [{ at: now, from: null, to: 'intake', by: actor?.session.session_id ?? 'mesh-human', note: `lead ${lead.agent_id}` }],
    }
    this.store.saveMission(mission)
    this.store.auditEvent('mission.created', {
      mission_id: missionId,
      title,
      lead_agent: lead.agent_id,
      source: mission.source,
      by: actor?.session.session_id ?? null,
      parent_mission: mission.parent_mission,
    })
    return mission
  }

  // -- reads ---------------------------------------------------------------

  getView(missionId: string): MissionView {
    const mission = this.store.requireMission(missionId)
    const tasks: MissionTaskSummary[] = []
    for (const taskId of mission.tasks) {
      const task = this.store.getTask(taskId)
      if (!task) continue
      const reviews = this.store.listReviews(taskId)
      tasks.push({
        task_id: task.task_id,
        title: task.title,
        role: task.role,
        status: task.status,
        implementer_agent: task.implementer_agent,
        reviewer_agent: reviews.length > 0 ? (reviews[reviews.length - 1]!.reviewer_agent ?? null) : null,
        merge_commit: task.merge?.merge_commit ?? null,
      })
    }
    const merged = tasks.filter((t) => t.status === 'merged').length
    const cancelled = tasks.filter((t) => t.status === 'cancelled').length
    return {
      mission,
      tasks,
      progress: { total: tasks.length, merged, cancelled, settled: tasks.length > 0 && merged + cancelled === tasks.length },
      lead_session_live: this.leadIsRunning(missionId),
    }
  }

  /** Which mission owns a task card (missions hold the task list; no reverse field needed). */
  missionOfTask(taskId: string): MissionCard | null {
    return missionOfTask(this.store, taskId)
  }

  /**
   * Is a lead *actually working* right now?
   *
   * A lead session with no process (the human operator driving by hand, or a builtin
   * lead) is an attribution handle, not a running turn. Counting it as "busy" would
   * freeze every mission whose lead is a human — the auto-advance rule
   * `planning && lead exited → executing` would never fire.
   */
  leadIsRunning(missionId: string): boolean {
    const session = this.identity.leadSessionOf(missionId)
    if (!session) return false
    if (session.pid === null) return false
    return isProcessAlive(session.pid)
  }

  /** Record first-time participation, preserving order (user-facing "who was in this"). */
  noteParticipant(missionId: string, agentId: string): void {
    const mission = this.store.getMission(missionId)
    if (!mission) return
    if (mission.teammates.includes(agentId)) return
    mission.teammates.push(agentId)
    this.store.saveMission(mission)
    this.profiles.noteMission(agentId)
  }

  // -- lead session --------------------------------------------------------

  /**
   * Create the Session that will act as lead for one phase.
   *
   * The lead is `is_lead` + `mission` (+ role `lead`): the role gives it the base
   * capability set, the two session fields are what make it *this* mission's lead.
   */
  createLeadSession(missionId: string, opts: { spawned_by?: string; ttl_seconds?: number } = {}): SessionCard {
    const mission = this.store.requireMission(missionId)
    const agent = this.store.requireAgent(mission.lead_agent)
    const session = this.identity.createSession({
      agent_id: agent.agent_id,
      role: MISSION_LEAD_ROLE,
      spawned_by: opts.spawned_by ?? 'hub.mission',
      lifespan: 'ephemeral',
      ttl_seconds: opts.ttl_seconds ?? agent.ttl_seconds,
      mission: missionId,
      is_lead: true,
    })
    const fresh = this.store.requireMission(missionId)
    fresh.lead_session = session.session_id
    this.store.saveMission(fresh)
    this.store.auditEvent('mission.lead_session', { mission_id: missionId, session_id: session.session_id, agent_id: agent.agent_id })
    return session
  }

  // -- planning ------------------------------------------------------------

  private assertMissionState(mission: MissionCard, allowed: MissionCard['status'][]): void {
    if (!allowed.includes(mission.status)) {
      throw new MeshError(
        MESH_ERRORS.MISSION_STATE,
        `mission ${mission.mission_id} is ${mission.status}; this action needs ${allowed.join('/')}`,
        { mission_id: mission.mission_id, status: mission.status, allowed },
      )
    }
  }

  private validatePlanItem(item: PlanTaskInput, index: number): void {
    const where = `tasks[${index}]`
    if (!item || typeof item !== 'object') throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `${where} must be an object`)
    if (!String(item.title ?? '').trim()) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `${where}.title is required`)
    if (!item.role) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `${where}.role is required`)
    if (!item.scope || !Array.isArray(item.scope.write) || item.scope.write.length === 0) {
      throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `${where}.scope.write must not be empty`)
    }
    if (!Array.isArray(item.acceptance) || item.acceptance.filter((a) => String(a).trim()).length === 0) {
      throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `${where}.acceptance must not be empty`)
    }
    if (item.agent && !this.store.getAgent(item.agent)) {
      throw new MeshError(MESH_ERRORS.UNKNOWN_ENTITY, `${where}.agent ${item.agent} is not a registered agent`, {
        agent: item.agent,
      })
    }
  }

  /**
   * Lead only: split the mission into cards, atomically.
   *
   * "Atomic" is taken seriously: every item is validated before a single card is
   * written, and if card N fails (granularity, unknown dependency, …) cards 1..N-1 are
   * deleted again. A half-planned mission is worse than no plan — the scheduler would
   * start executing a broken breakdown.
   */
  planMission(sessionId: string, missionId: string, tasks: PlanTaskInput[]): { mission: MissionCard; created: TaskCard[] } {
    const identity = this.identity.requireLead(sessionId, missionId)
    const mission = this.store.requireMission(missionId)
    this.assertMissionState(mission, ['intake', 'planning', 'rejected'])
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'plan_mission needs at least one task', { mission_id: missionId })
    }
    tasks.forEach((t, i) => this.validatePlanItem(t, i))

    const config = this.config()
    const links = tasks.map((t, i) => {
      if (t.depends_on && t.depends_on.length > 0) return t.depends_on
      // Omitted dependencies mean "serialize in array order" (spec §1.3).
      return i === 0 ? [] : [`__PREV__`]
    })

    const created: TaskCard[] = []
    const plan: MissionPlanEntry[] = []
    try {
      tasks.forEach((item, index) => {
        const dependsOn = links[index]!.map((d) => (d === '__PREV__' ? created[created.length - 1]!.task_id : d))
        const task = this.board.createTask(
          {
            title: item.title,
            role: item.role,
            scope: { write: item.scope.write, read: item.scope.read ?? [] },
            acceptance: item.acceptance,
            depends_on: dependsOn,
            publish: false, // dispatch_mission is what starts execution (spec §1.3)
            created_by: identity.session.session_id,
            // Back-link the card to its mission. The task view and peer review both
            // read this; without it a card only carried a `mission:` tag and had no
            // parent, so anything that walked upward from a task hit a dead end.
            parent: missionId,
            tags: [`mission:${missionId}`],
            preferred_agent: item.agent ?? null,
          },
          identity,
        )
        created.push(task)
        plan.push({
          task_id: task.task_id,
          role: item.role,
          why: item.why ?? (item.agent ? `指定给 ${item.agent}` : '按擅长方向分派'),
        })
      })
    } catch (e) {
      for (const task of created) this.store.deleteTask(task.task_id)
      throw e
    }

    const fresh = this.store.requireMission(missionId)
    fresh.tasks.push(...created.map((t) => t.task_id))
    fresh.plan.push(...plan)
    const previous = fresh.status
    if (previous === 'intake') {
      applyMissionTransition(fresh, 'planning', { by: sessionId, note: `planned ${created.length} task(s)` })
    } else if (previous === 'rejected') {
      applyMissionTransition(fresh, 'planning', { by: sessionId, note: 'replanned after rejection' })
      fresh.rejected_tasks = []
    } else {
      fresh.updated_at = nowIso()
      fresh.history.push({
        at: fresh.updated_at,
        from: 'planning',
        to: 'planning',
        by: sessionId,
        note: `added ${created.length} task(s)`,
      })
    }
    this.store.saveMission(fresh)
    this.store.auditEvent('mission.planned', {
      mission_id: missionId,
      session_id: sessionId,
      tasks: created.map((t) => t.task_id),
      total_tasks: fresh.tasks.length,
    })
    void config
    return { mission: fresh, created }
  }

  // -- dispatch ------------------------------------------------------------

  dispatchMission(sessionId: string, missionId: string): MissionCard {
    this.identity.requireLead(sessionId, missionId)
    const mission = this.store.requireMission(missionId)
    this.assertMissionState(mission, ['planning'])
    if (mission.tasks.length === 0) {
      throw new MeshError(MESH_ERRORS.MISSION_STATE, 'cannot dispatch a mission with no tasks', { mission_id: missionId })
    }
    applyMissionTransition(mission, 'executing', { by: sessionId, note: 'dispatched' })
    this.store.saveMission(mission)
    // Cards were created unpublished so a human can look at the plan first; dispatch
    // is the moment they become claimable.
    const unlocked: string[] = []
    for (const taskId of mission.tasks) {
      const task = this.store.getTask(taskId)
      if (!task || task.status !== 'draft') continue
      const published = this.board.publishTask(taskId)
      unlocked.push(published.task_id)
    }
    this.store.auditEvent('mission.dispatched', { mission_id: missionId, session_id: sessionId, tasks: unlocked })
    return this.store.requireMission(missionId)
  }

  // -- second acceptance ---------------------------------------------------

  /**
   * Lead only: the second acceptance (mission 级).
   *
   * - approved  → stay in `final_review`; `write_report` then completes it
   * - rejected  → `rejected`, rounds+1, and the named cards go back to work
   *
   * A rejection without `rejects` means "the breakdown itself is wrong" and sends the
   * mission to `planning` for a replan (spec §1.2).
   */
  finalVerdict(
    sessionId: string,
    missionId: string,
    approved: boolean,
    notes: string,
    rejects?: string[],
  ): { mission: MissionCard; rejected_tasks: string[]; replan: boolean } {
    this.identity.requireLead(sessionId, missionId)
    const mission = this.store.requireMission(missionId)
    this.assertMissionState(mission, ['integrating', 'final_review'])

    // integrating → final_review is where the lead's first look happens; record it so
    // the transition chain is visible even when the verdict is immediate.
    if (mission.status === 'integrating') {
      applyMissionTransition(mission, 'final_review', { by: sessionId, note: 'lead integrating finished' })
    }

    const rejectedTasks: string[] = []
    if (approved) {
      mission.history.push({
        at: nowIso(),
        from: 'final_review',
        to: 'final_review',
        by: sessionId,
        note: `二次验收通过：${notes || '(no notes)'}`,
      })
      mission.updated_at = nowIso()
      this.store.saveMission(mission)
      this.store.auditEvent('mission.verdict', { mission_id: missionId, approved: true, session_id: sessionId, notes })
      return { mission: this.store.requireMission(missionId), rejected_tasks: [], replan: false }
    }

    const replan = !rejects || rejects.length === 0
    applyMissionTransition(mission, 'rejected', {
      by: sessionId,
      note: replan ? `二次验收不通过（拆解问题，回到 planning）：${notes}` : `二次验收不通过：${notes}`,
    })
    mission.rounds += 1
    // Remember *which* cards were named: by the time the scheduler decides
    // rejected→executing vs rejected→planning, its own auto-requeue may already have
    // moved those cards back to `ready`, erasing the only card-level signal.
    mission.rejected_tasks = replan ? [] : [...rejects!]

    if (!replan) {
      for (const taskId of rejects!) {
        const task = this.store.getTask(taskId)
        if (!task) throw new MeshError(MESH_ERRORS.UNKNOWN_ENTITY, `reject target ${taskId} is not a task`, { task_id: taskId })
        if (!mission.tasks.includes(taskId)) {
          throw new MeshError(MESH_ERRORS.MISSION_STATE, `${taskId} does not belong to ${missionId}`, {
            task_id: taskId,
            mission_id: missionId,
          })
        }
        if (task.status !== 'merged') {
          throw new MeshError(MESH_ERRORS.MISSION_STATE, `cannot reject ${taskId}: it is ${task.status}, not merged`, {
            task_id: taskId,
            status: task.status,
          })
        }
        this.board.rejectMergedTask(taskId, sessionId, `二次验收打回：${notes}`)
        if (task.implementer_agent) this.profiles.noteRound(task.implementer_agent)
        rejectedTasks.push(taskId)
      }
    }
    this.store.saveMission(mission)
    this.store.auditEvent('mission.verdict', {
      mission_id: missionId,
      approved: false,
      session_id: sessionId,
      notes,
      rejects: rejectedTasks,
      replan,
      rounds: mission.rounds,
    })
    return { mission: this.store.requireMission(missionId), rejected_tasks: rejectedTasks, replan }
  }

  // -- report --------------------------------------------------------------

  writeReport(sessionId: string, missionId: string, markdown: string): { mission: MissionCard; path: string } {
    this.identity.requireLead(sessionId, missionId)
    const mission = this.store.requireMission(missionId)
    this.assertMissionState(mission, ['final_review'])
    const text = String(markdown ?? '').trim()
    if (!text) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'report must not be empty', { mission_id: missionId })

    // writeMissionReport already returns a project-relative path; rel() it again and
    // the second call resolves against cwd instead of the project root.
    const file = this.store.writeMissionReport(missionId, `${text}\n`)
    mission.report = text
    mission.report_at = nowIso()
    applyMissionTransition(mission, 'completed', { by: sessionId, note: 'report written' })
    this.store.saveMission(mission)
    this.store.auditEvent('mission.completed', { mission_id: missionId, session_id: sessionId, report: file })
    // §4.1: `write_report` ends the mission, and ending it freezes the history
    // directory + refreshes HISTORY.md. Best-effort: a history write must never undo
    // a completed mission, but it must be visible if it fails.
    try {
      this.history.close(missionId)
    } catch (e) {
      process.stderr.write(`[mesh] mission history write failed for ${missionId}: ${(e as Error).message}\n`)
    }
    return { mission: this.store.requireMission(missionId), path: file }
  }

  // -- scheduler auto-advance ---------------------------------------------

  /**
   * The three rules from the spec, plus the rework loop, evaluated once per tick.
   * Returns the transitions it made so `mesh up` can print them.
   */
  advanceMissions(): Array<{ mission_id: string; from: string; to: string; note: string }> {
    const done: Array<{ mission_id: string; from: string; to: string; note: string }> = []
    for (const mission of this.store.listMissions()) {
      const before = mission.status
      const view = this.getView(mission.mission_id)
      const leadLive = view.lead_session_live
      let to: MissionCard['status'] | null = null
      let note = ''

      if (before === 'planning' && mission.tasks.length > 0 && !leadLive) {
        to = 'executing'
        note = 'lead finished planning'
      } else if (before === 'executing' && view.progress.settled) {
        to = 'integrating'
        note = `all ${view.progress.total} task(s) settled`
      } else if (before === 'rejected') {
        // Rework loop: send rejected cards back to the board and resume execution,
        // or go back to planning when the breakdown itself was the problem.
        const replan = (mission.rejected_tasks ?? []).length === 0
        if (replan) {
          to = 'planning'
          note = 'replan required'
        } else {
          for (const taskId of mission.rejected_tasks ?? []) {
            const task = this.store.getTask(taskId)
            if (task && task.status === 'rejected') this.board.requeueRejectedTask(taskId, 'mission rework')
          }
          to = 'executing'
          note = `rework round: ${mission.rejected_tasks!.join(', ')}`
        }
      } else if (before === 'final_review' && mission.report && mission.report_at) {
        to = 'completed'
        note = 'report present'
      }

      if (!to) continue
      if (!canMissionTransition(before, to)) continue
      const fresh = this.store.requireMission(mission.mission_id)
      applyMissionTransition(fresh, to, { by: 'hub.scheduler', note })
      // Leaving `rejected` consumes the rejection: no stale card list next time.
      if (before === 'rejected') fresh.rejected_tasks = []
      this.store.saveMission(fresh)
      this.store.auditEvent('mission.advanced', { mission_id: mission.mission_id, from: before, to, note })
      done.push({ mission_id: mission.mission_id, from: before, to, note })
    }
    return done
  }

  /** Missions that need a lead turn right now (used by the scheduler to spawn one). */
  missionsNeedingLead(): Array<{ mission: MissionCard; phase: 'planning' | 'integrating' }> {
    const out: Array<{ mission: MissionCard; phase: 'planning' | 'integrating' }> = []
    for (const mission of this.store.listMissions()) {
      if (this.leadIsRunning(mission.mission_id)) continue
      if (mission.status === 'intake') out.push({ mission, phase: 'planning' })
      else if (mission.status === 'integrating') out.push({ mission, phase: 'integrating' })
    }
    return out
  }

  /** Lead prompt block: what this mission is, and what the lead is expected to do now. */
  leadBrief(mission: MissionCard, phase: 'planning' | 'integrating'): string {
    const view = this.getView(mission.mission_id)
    const lines: string[] = []
    lines.push(`## Mission ${mission.mission_id}「${mission.title}」（${phase === 'planning' ? '规划' : '整合'}阶段）`)
    lines.push('')
    lines.push(`- 你是 **${mission.lead_agent}**，这个 mission 的 Lead。`)
    lines.push(`- 用户原话：${mission.brief}`)
    if (mission.acceptance.length > 0) {
      lines.push(`- Mission 级验收：${mission.acceptance.map((a, i) => `${i + 1}) ${a}`).join(' ')}`)
    }
    lines.push(`- 当前状态：${mission.status}　轮次：${mission.rounds}`)
    lines.push('')
    if (phase === 'planning') {
      lines.push('现在做拆解：')
      lines.push('')
      lines.push('1. `plan_mission(mission_id, tasks[])` 一次写完所有卡（role / scope.write / acceptance / depends_on / agent?）。')
      lines.push('2. 需要看平台怎么用、队友是谁：`get_mission(mission_id)`。')
      lines.push('3. `dispatch_mission(mission_id)` 交棒给调度器，然后结束这一轮。')
      lines.push('')
      lines.push('不要自己写代码。拆卡粒度：单卡单会话可完成，验收 ≤7 条且每条可验证。')
    } else {
      lines.push('所有子任务已合并。现在做整合与二次验收：')
      lines.push('')
      lines.push('1. 读 `get_mission(mission_id)` 看每张卡的产出、审查 evidence、合并 commit。')
      lines.push('2. 有缺口就再开卡（`create_task`）或打回；从整体看它是否真的满足用户原话。')
      lines.push(
        '3. 给每个参与者打分：`hub.rate_peer(agent_id, mission_id, { quality, cooperation, evidence, speed })`——你整合时逐一看了他们的产出，这个判断有依据；每个维度 0-100，评完再裁决。',
      )
      lines.push('4. `final_verdict(mission_id, approved, notes, rejects?)`：不通过时 `rejects` 点名要改的卡；')
      lines.push('   若是拆解本身有问题，rejects 留空（mission 会回到 planning 重拆）。')
      lines.push('5. 通过后 `write_report(mission_id, markdown)` 写给用户看的报告（它会被存成报告文件）。')
    }
    lines.push('')
    lines.push(`已完成：${view.progress.merged}/${view.progress.total} 张卡合并。`)
    return lines.join('\n')
  }

  /** Absolute path of a mission's report file (for CLI/dashboard). */
  reportPath(missionId: string): string {
    return path.join(this.store.paths.missionDir(missionId), 'report.md')
  }

  // -- history views (§4) --------------------------------------------------

  /** One row per mission, for `mesh missions` and the dashboard list. */
  listSummaries(): Array<{
    mission_id: string
    title: string
    status: MissionCard['status']
    lead_agent: string
    rounds: number
    created_at: string
    updated_at: string
    duration_ms: number
    progress: { total: number; merged: number; cancelled: number }
    teammates: string[]
    report_path: string | null
  }> {
    return this.store
      .listMissions()
      .map((mission) => {
        const view = this.getView(mission.mission_id)
        const reportPath = this.reportPath(mission.mission_id)
        return {
          mission_id: mission.mission_id,
          title: mission.title,
          status: mission.status,
          lead_agent: mission.lead_agent,
          rounds: mission.rounds,
          created_at: mission.created_at,
          updated_at: mission.updated_at,
          duration_ms: this.history.durationOf(mission),
          progress: { total: view.progress.total, merged: view.progress.merged, cancelled: view.progress.cancelled },
          teammates: mission.teammates,
          report_path: fsExists(reportPath) ? this.store.paths.rel(reportPath) : null,
        }
      })
      .sort((a, b) => b.mission_id.localeCompare(a.mission_id))
  }

  /**
   * Everything the detail view needs, assembled once: the card, every task with its
   * reviews in full, the timeline from the audit ledger, and the report text.
   */
  detail(missionId: string): {
    mission: MissionCard
    progress: { total: number; merged: number; cancelled: number }
    tasks: ReturnType<MissionHistory['tasksSnapshot']>
    timeline: TimelineEvent[]
    timeline_markdown: string
    report: string
    report_path: string | null
    history_dir: string
    files: Array<{ name: string; path: string; exists: boolean }>
  } {
    const mission = this.store.requireMission(missionId)
    const view = this.getView(missionId)
    const timeline = this.history.timelineEvents(mission)
    const reportPath = this.reportPath(missionId)
    const dir = this.store.paths.missionDir(missionId)
    const files = ['report.md', 'timeline.md', 'tasks.json'].map((name) => {
      const abs = path.join(dir, name)
      return { name, path: this.store.paths.rel(abs), exists: fsExists(abs) }
    })
    return {
      mission,
      progress: { total: view.progress.total, merged: view.progress.merged, cancelled: view.progress.cancelled },
      tasks: this.history.tasksSnapshot(mission),
      timeline,
      timeline_markdown: this.history.renderTimeline(mission, timeline),
      report: mission.report ?? this.store.readMissionReport(missionId) ?? '',
      report_path: fsExists(reportPath) ? this.store.paths.rel(reportPath) : null,
      history_dir: this.store.paths.rel(dir),
      files,
    }
  }
}
