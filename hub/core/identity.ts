/**
 * Identity: Agents, Sessions, and the separation-of-duties rules (C6, C7).
 *
 * A Session is the only thing that can act. It is created by the scheduler (or
 * by `mesh assign`), bound to exactly one role at birth, and must call
 * `hello()` before it holds any right at all. Roles never attach to Agents, so
 * the same CLI binary can be a frontend dev this morning and a supervisor this
 * afternoon without either Session knowing about the other.
 */

import { MeshError, MESH_ERRORS } from './errors.ts'
import { nowIso } from './fsx.ts'
import { getRoleCard } from '../roles/cards.ts'
import type { MeshStore } from './store.ts'
import type { AgentCard, Identity, RoleCard, RoleId, SessionCard, TaskCard } from './types.ts'

export type { Identity }

export interface CreateSessionInput {
  agent_id: string
  role: RoleId
  task?: string | null
  spawned_by: string
  sandbox?: string | null
  lifespan?: 'ephemeral' | 'daemon'
  ttl_seconds?: number
  pid?: number | null
  resume_token?: string | null
  /** V2: bind the session to a mission (null for V1-style standalone work). */
  mission?: string | null
  /** V2: this session is the mission lead. */
  is_lead?: boolean
}

export class IdentityService {
  readonly store: MeshStore

  constructor(store: MeshStore) {
    this.store = store
  }

  // -- agents --------------------------------------------------------------

  agentCanTakeRole(agent: AgentCard, role: RoleId): boolean {
    return agent.enabled && agent.capabilities.includes(role)
  }

  requireAgent(agentId: string): AgentCard {
    return this.store.requireAgent(agentId)
  }

  eligibleAgents(role: RoleId): AgentCard[] {
    return this.store.listAgents().filter((a) => this.agentCanTakeRole(a, role))
  }

  // -- sessions ------------------------------------------------------------

  createSession(input: CreateSessionInput): SessionCard {
    const agent = this.store.requireAgent(input.agent_id)
    if (!agent.enabled) {
      throw new MeshError(MESH_ERRORS.ROLE_FORBIDDEN, `agent ${agent.agent_id} is disabled`, { agent_id: agent.agent_id })
    }
    if (!this.agentCanTakeRole(agent, input.role)) {
      throw new MeshError(
        MESH_ERRORS.CAPABILITY_MISSING,
        `agent ${agent.agent_id} is not registered for role ${input.role}`,
        { agent_id: agent.agent_id, role: input.role, capabilities: agent.capabilities },
      )
    }
    const roleCard = getRoleCard(input.role)
    const sessionId = this.store.nextId('session')
    const now = nowIso()
    const session: SessionCard = {
      session_id: sessionId,
      agent_id: agent.agent_id,
      role: input.role,
      task: input.task ?? null,
      mode: 'platform',
      lifespan: input.lifespan ?? roleCard.lifespan,
      spawned_by: input.spawned_by,
      sandbox: input.sandbox ?? null,
      status: 'starting',
      pid: input.pid ?? null,
      created_at: now,
      last_heartbeat_at: now,
      ttl_seconds: input.ttl_seconds ?? agent.ttl_seconds,
      hello_at: null,
      resume_token: input.resume_token ?? null,
      mission: input.mission ?? null,
      is_lead: input.is_lead ?? false,
      turns: 0,
      exit: null,
    }
    this.store.saveSession(session)
    this.store.auditEvent('session.created', {
      session_id: session.session_id,
      agent_id: session.agent_id,
      role: session.role,
      task: session.task,
      spawned_by: session.spawned_by,
      lifespan: session.lifespan,
      mission: session.mission,
      is_lead: session.is_lead,
    })
    return session
  }

  /** Register the Session as live and hand back its role card (double injection). */
  hello(sessionId: string): { session: SessionCard; roleCard: RoleCard; agent: AgentCard } {
    const session = this.store.requireSession(sessionId)
    if (session.status === 'exited' || session.status === 'expired' || session.status === 'killed' || session.status === 'failed') {
      throw new MeshError(MESH_ERRORS.SESSION_DEAD, `session ${sessionId} is ${session.status}`, {
        session_id: sessionId,
        status: session.status,
      })
    }
    const agent = this.store.requireAgent(session.agent_id)
    if (!session.hello_at) session.hello_at = nowIso()
    if (session.status === 'starting') session.status = 'active'
    session.last_heartbeat_at = nowIso()
    session.turns += 1
    this.store.saveSession(session)
    this.store.auditEvent('session.hello', {
      session_id: session.session_id,
      agent_id: session.agent_id,
      role: session.role,
      task: session.task,
    })
    return { session, roleCard: getRoleCard(session.role), agent }
  }

  /**
   * Resolve an acting Session to its identity. This is the single gate before
   * every privileged operation: unknown → refused, not hello'd → refused.
   */
  requireIdentity(sessionId: string | null | undefined): Identity {
    if (!sessionId) {
      throw new MeshError(MESH_ERRORS.SESSION_HELLO_REQUIRED, 'no session id supplied: call hub.hello() and pass session_id', {
        hint: 'every privileged hub.* call needs the session_id returned by hello',
      })
    }
    const session = this.store.getSession(sessionId)
    if (!session) {
      throw new MeshError(MESH_ERRORS.SESSION_UNKNOWN, `unknown session: ${sessionId}`, { session_id: sessionId })
    }
    if (!session.hello_at) {
      throw new MeshError(
        MESH_ERRORS.SESSION_HELLO_REQUIRED,
        `session ${sessionId} has not called hub.hello() and holds no rights`,
        { session_id: sessionId },
      )
    }
    if (session.status !== 'active' && session.status !== 'starting') {
      throw new MeshError(MESH_ERRORS.SESSION_DEAD, `session ${sessionId} is ${session.status}`, {
        session_id: sessionId,
        status: session.status,
      })
    }
    const agent = this.store.requireAgent(session.agent_id)
    const role = getRoleCard(session.role)
    return { session, agent, role }
  }

  touch(sessionId: string): void {
    const session = this.store.getSession(sessionId)
    if (!session) return
    session.last_heartbeat_at = nowIso()
    this.store.saveSession(session)
  }

  closeSession(sessionId: string, status: 'exited' | 'expired' | 'killed' | 'failed', exit?: { code: number | null; note?: string }): void {
    const session = this.store.getSession(sessionId)
    if (!session) return
    session.status = status
    session.exit = { code: exit?.code ?? null, at: nowIso(), ...(exit?.note ? { note: exit.note } : {}) }
    this.store.saveSession(session)
    this.store.auditEvent('session.closed', {
      session_id: sessionId,
      agent_id: session.agent_id,
      role: session.role,
      task: session.task,
      status,
      code: exit?.code ?? null,
    })
  }

  /** Deadline for a Session: hard TTL for one-shot workers, idle TTL for daemons. */
  deadline(session: SessionCard): number {
    const anchor = session.lifespan === 'ephemeral' ? session.created_at : session.last_heartbeat_at
    return Date.parse(anchor) + session.ttl_seconds * 1000
  }

  isExpired(session: SessionCard, at: number = Date.now()): boolean {
    if (session.status !== 'active' && session.status !== 'starting') return false
    return at > this.deadline(session)
  }

  /** The Session currently holding `role` for `thread`, if any. Role-thread addressing. */
  activeHolder(role: RoleId, thread: string | null): SessionCard | null {
    const candidates = this.store.liveSessions().filter((s) => s.role === role)
    const matching = candidates.filter((s) => {
      if (!thread) return true
      return s.task === thread || s.task === null
    })
    if (matching.length === 0) return null
    // Prefer a session bound to this exact task; otherwise the most recent daemon.
    const exact = matching.filter((s) => s.task === thread)
    const pool = exact.length > 0 ? exact : matching.filter((s) => s.task === null)
    const chosen = (pool.length > 0 ? pool : matching).sort((a, b) => b.created_at.localeCompare(a.created_at))
    return chosen[0] ?? null
  }

  holdersOf(role: RoleId): SessionCard[] {
    return this.store.liveSessions().filter((s) => s.role === role)
  }

  // -- mission lead (V2) ---------------------------------------------------

  /**
   * Resolve a session that is the lead of `missionId`.
   *
   * Permission order is spec'd as **is_lead + mission first, role second**: a lead
   * holds mission-scoped rights regardless of which role card it also carries, and a
   * session that is not the lead of *this* mission never gets them, even if it leads
   * another one.
   */
  requireLead(sessionId: string, missionId: string): Identity {
    const identity = this.requireIdentity(sessionId)
    const mission = this.store.requireMission(missionId)
    const matchesMission = identity.session.is_lead && identity.session.mission === missionId
    if (!matchesMission) {
      throw new MeshError(
        MESH_ERRORS.NOT_LEAD,
        `session ${sessionId} is not the lead of ${missionId}`,
        {
          session_id: sessionId,
          mission_id: missionId,
          session_mission: identity.session.mission,
          is_lead: identity.session.is_lead,
          lead_session: mission.lead_session,
          hint: 'lead rights are per mission; whoever received the job leads it',
        },
      )
    }
    if (mission.lead_session && mission.lead_session !== sessionId) {
      throw new MeshError(
        MESH_ERRORS.NOT_LEAD,
        `session ${sessionId} is a former lead of ${missionId}; current lead is ${mission.lead_session}`,
        { session_id: sessionId, mission_id: missionId, lead_session: mission.lead_session },
      )
    }
    return identity
  }

  /** Live lead session of a mission, if any. */
  leadSessionOf(missionId: string): SessionCard | null {
    return (
      this.store
        .liveSessions()
        .filter((s) => s.is_lead && s.mission === missionId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
    )
  }

  // -- separation of duties ------------------------------------------------

  /** C7: an Agent may never be both implementer and reviewer of the same task. */
  assertIndependentReviewer(task: TaskCard, reviewerAgentId: string): void {
    if (task.implementer_agent && task.implementer_agent === reviewerAgentId) {
      throw new MeshError(
        MESH_ERRORS.REVIEW_NOT_INDEPENDENT,
        `agent ${reviewerAgentId} implemented ${task.task_id} and cannot review it (C7)`,
        { task_id: task.task_id, agent_id: reviewerAgentId },
      )
    }
  }

  /** An integrator that implemented the task would be marking its own homework. */
  assertIndependentIntegrator(task: TaskCard, integratorAgentId: string): void {
    if (task.implementer_agent && task.implementer_agent === integratorAgentId) {
      throw new MeshError(
        MESH_ERRORS.SOD_VIOLATION,
        `agent ${integratorAgentId} implemented ${task.task_id} and cannot integrate it`,
        { task_id: task.task_id, agent_id: integratorAgentId },
      )
    }
  }

  /**
   * Scheduler filter (T8): would assigning `agentId` to `task` violate SoD?
   * Returns null when the assignment is legal, or a reason string.
   */
  sodConflict(task: TaskCard, agentId: string, role: RoleId): string | null {
    if (role === 'supervisor' || role === 'integrator') {
      if (task.implementer_agent === agentId) {
        return `agent ${agentId} already implemented ${task.task_id}; cannot also ${role === 'supervisor' ? 'review' : 'integrate'} it`
      }
    }
    if (role !== 'supervisor' && role !== 'integrator') {
      // A worker may not implement a task it is currently reviewing.
      const reviewing = this.store
        .listReviews(task.task_id)
        .some((r) => r.reviewer_agent === agentId && r.verdict === 'approved')
      if (reviewing && task.implementer_agent !== agentId) {
        return `agent ${agentId} already reviewed ${task.task_id}; cannot implement it`
      }
    }
    return null
  }

  /** Concurrency available for an Agent right now. */
  concurrencyAvailable(agent: AgentCard): number {
    const live = this.store.activeSessionsOfAgent(agent.agent_id).filter((s) => s.status === 'active' || s.status === 'starting')
    return agent.concurrency - live.length
  }
}
