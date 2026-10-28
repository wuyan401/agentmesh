/**
 * The board: the deterministic task lifecycle (§7.2, §7.3, §13).
 *
 * Everything that changes a TaskCard goes through this class, always under the
 * task's file lock and always through the state machine. The board is also where
 * the platform's verdict is composed: submit → review → merge, with the scope
 * gate as the final word.
 */

import path from 'node:path'
import fs from 'node:fs'
import { MeshError, MESH_ERRORS } from './errors.ts'
import { matchAnyGlob, nowIso, normRel, outOfScope } from './fsx.ts'
import { withLock } from './lock.ts'
import { applyTransition } from './stateMachine.ts'
import { getRoleCard } from '../roles/cards.ts'
import { mergeWithScopeGate, scopeCheck, ScopeViolation, MergeRefused, ensureMeshRef } from './mergeGate.ts'
import type { Audit } from './audit.ts'
import type { ContextBuilder, ContextLevel } from './context.ts'
import type { Git } from './git.ts'
import type { Identity, IdentityService } from './identity.ts'
import type { MessageBus } from './messages.ts'
import type { MeshStore } from './store.ts'
import type { Message, MergeMode, ReviewCriterionResult, ReviewRecord, RoleId, TaskCard, TaskStatus } from './types.ts'
import { ROLE_IDS, canPlan, PLAN_ROLES } from './types.ts'

export interface CreateTaskInput {
  title: string
  role: RoleId
  scope: { write: string[]; read?: string[] }
  acceptance: string[]
  depends_on?: string[]
  estimate?: '1-session' | 'multi-session'
  parent?: string | null
  tags?: string[]
  publish?: boolean
  created_by?: string | null
}

export interface BoardFilter {
  role?: RoleId
  status?: TaskStatus | TaskStatus[]
  claimed_by?: string
  thread?: string
}

const MAX_ACCEPTANCE = 7

export class Board {
  readonly store: MeshStore
  readonly git: Git
  readonly identity: IdentityService
  readonly bus: MessageBus
  readonly audit: Audit
  readonly context: ContextBuilder

  constructor(deps: {
    store: MeshStore
    git: Git
    identity: IdentityService
    bus: MessageBus
    audit: Audit
    context: ContextBuilder
  }) {
    this.store = deps.store
    this.git = deps.git
    this.identity = deps.identity
    this.bus = deps.bus
    this.audit = deps.audit
    this.context = deps.context
  }

  // -- creation ------------------------------------------------------------

  /** Granularity is a hard rule, not advice: oversized tasks are refused. */
  private assertGranularity(input: CreateTaskInput): void {
    const acceptance = input.acceptance.filter((a) => a.trim().length > 0)
    if (acceptance.length === 0) {
      throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'a task needs at least one acceptance criterion', {})
    }
    if (acceptance.length > MAX_ACCEPTANCE) {
      this.audit.violation({
        kind: 'granularity.oversized',
        detail: `task "${input.title}" has ${acceptance.length} acceptance criteria (max ${MAX_ACCEPTANCE}); split it`,
        evidence: { acceptance_count: acceptance.length },
      })
      throw new MeshError(
        MESH_ERRORS.GRANULARITY,
        `accepted criteria = ${acceptance.length} > ${MAX_ACCEPTANCE}: split this task before creating it`,
        { max: MAX_ACCEPTANCE, got: acceptance.length, title: input.title },
      )
    }
    if ((input.estimate ?? '1-session') !== '1-session') {
      this.audit.violation({
        kind: 'granularity.oversized',
        detail: `task "${input.title}" is estimated multi-session; split it`,
        evidence: { estimate: input.estimate },
      })
      throw new MeshError(
        MESH_ERRORS.GRANULARITY,
        'estimate must be 1-session: a task must fit one agent in one session',
        { estimate: input.estimate, title: input.title },
      )
    }
    if (!ROLE_IDS.includes(input.role)) {
      throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `unknown role: ${String(input.role)}`, { role: input.role })
    }
    if (!input.scope || input.scope.write.length === 0) {
      throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'scope.write must not be empty', {})
    }
  }

  createTask(input: CreateTaskInput, actor?: Identity): TaskCard {
    this.assertGranularity(input)
    if (actor && !canPlan(actor.session.role)) {
      throw new MeshError(
        MESH_ERRORS.ROLE_FORBIDDEN,
        `role ${actor.session.role} may not create task cards; only ${PLAN_ROLES.join('/')} can order work`,
        { role: actor.session.role, plan_roles: [...PLAN_ROLES] },
      )
    }
    for (const dep of input.depends_on ?? []) {
      if (!this.store.getTask(dep)) {
        throw new MeshError(MESH_ERRORS.UNKNOWN_ENTITY, `depends_on references unknown task ${dep}`, { depends_on: dep })
      }
    }
    const taskId = this.store.nextId('task')
    const roleCard = getRoleCard(input.role)
    const base = this.git.headSha() ?? null
    const task: TaskCard = {
      task_id: taskId,
      title: input.title.trim(),
      role: input.role,
      created_by: actor ? actor.session.session_id : (input.created_by ?? null),
      created_at: nowIso(),
      updated_at: nowIso(),
      status: 'draft',
      depends_on: (input.depends_on ?? []).slice(),
      context_package: null,
      context_level: null,
      scope: { write: input.scope.write.map(normRel), read: (input.scope.read ?? []).map(normRel) },
      acceptance: input.acceptance.filter((a) => a.trim().length > 0),
      estimate: '1-session',
      base_commit: base,
      branch: `mesh/${taskId}`,
      worktree: this.store.paths.worktreeRel(taskId),
      claimed_by: null,
      implementer_agent: null,
      submission: null,
      reviews: [],
      merge: null,
      blocked_reason: null,
      parent: input.parent ?? null,
      tags: input.tags ?? [],
      history: [],
    }
    if (!roleCard.can_implement && !roleCard.can_review && !roleCard.can_merge) {
      // Documentation/planning roles own a card too; their scope is documentation.
      task.scope.write = task.scope.write.length > 0 ? task.scope.write : ['.mesh/board/**']
    }
    task.history.push({
      at: task.created_at,
      from: null,
      to: 'draft',
      by: actor?.session.session_id ?? input.created_by ?? 'hub',
      note: 'created',
    })
    this.store.saveTask(task)
    this.store.boardEvent({ event: 'task.created', task_id: task.task_id, role: task.role, title: task.title })
    if (input.publish !== false) this.publishTask(task.task_id, actor)
    return this.store.requireTask(taskId)
  }

  /** draft → ready, but only once every dependency is merged. */
  publishTask(taskId: string, actor?: Identity): TaskCard {
    return withLock(this.store.paths.lockFile(`task-${taskId}`), () => {
      const task = this.store.requireTask(taskId)
      if (task.status !== 'draft') return task
      const unmet = this.unmetDependencies(task)
      if (unmet.length > 0) {
        task.blocked_reason = `waiting on ${unmet.join(', ')}`
        this.store.saveTask(task)
        return task
      }
      applyTransition(task, 'ready', { by: actor?.session.session_id ?? 'hub', note: 'published' })
      this.store.saveTask(task)
      this.store.boardEvent({ event: 'task.ready', task_id: task.task_id })
      return task
    })
  }

  unmetDependencies(task: TaskCard): string[] {
    return task.depends_on.filter((depId) => {
      const dep = this.store.getTask(depId)
      return !dep || dep.status !== 'merged'
    })
  }

  /** When a task merges, its dependents become ready. */
  unlockDependents(mergedTaskId: string): string[] {
    const unlocked: string[] = []
    for (const task of this.store.listTasks()) {
      if (task.status !== 'draft' && task.status !== 'blocked') continue
      if (!task.depends_on.includes(mergedTaskId)) continue
      if (this.unmetDependencies(task).length > 0) continue
      const updated = withLock(this.store.paths.lockFile(`task-${task.task_id}`), () => {
        const fresh = this.store.requireTask(task.task_id)
        if (fresh.status !== 'draft' && fresh.status !== 'blocked') return null
        if (this.unmetDependencies(fresh).length > 0) return null
        applyTransition(fresh, 'ready', { by: 'hub', note: `dependency ${mergedTaskId} merged` })
        this.store.saveTask(fresh)
        return fresh
      })
      if (updated) {
        unlocked.push(updated.task_id)
        this.store.boardEvent({ event: 'task.ready', task_id: updated.task_id, reason: `dep ${mergedTaskId} merged` })
      }
    }
    return unlocked
  }

  // -- claim ---------------------------------------------------------------

  /**
   * The atomic claim primitive. Exactly one Session can own a task: the whole
   * decision (re-read the card, check the rules, transition, persist) happens
   * under the task's file lock, so N concurrent claimants produce exactly one
   * winner and N-1 CLAIM_CONFLICT errors (M1 acceptance).
   */
  private claimLocked(taskId: string, sessionId: string, agentId: string, role: RoleId, note?: string): {
    task: TaskCard
    already: boolean
  } {
    return withLock(
      this.store.paths.lockFile(`task-${taskId}`),
      () => {
        const task = this.store.requireTask(taskId)
        if (task.claimed_by && task.claimed_by !== sessionId) {
          const holder = this.store.getSession(task.claimed_by)
          throw new MeshError(MESH_ERRORS.CLAIM_CONFLICT, `task ${taskId} is already claimed by ${task.claimed_by}`, {
            task_id: taskId,
            holder_session: task.claimed_by,
            holder_agent: holder?.agent_id ?? null,
            holder_status: holder?.status ?? null,
          })
        }
        if (task.claimed_by === sessionId) return { task, already: true }
        if (role !== task.role) {
          throw new MeshError(
            MESH_ERRORS.SESSION_ROLE_MISMATCH,
            `role mismatch: this session is ${role}, task ${taskId} needs ${task.role}`,
            { session_role: role, task_role: task.role },
          )
        }
        const rework = task.status === 'rejected' && task.implementer_agent === agentId
        if (task.status !== 'ready' && !rework) {
          throw new MeshError(
            MESH_ERRORS.TRANSITION_ILLEGAL,
            `task ${taskId} is ${task.status}; only a ready task (or your own rejected one) can be claimed`,
            { task_id: taskId, status: task.status },
          )
        }
        const conflict = this.identity.sodConflict(task, agentId, role)
        if (conflict) {
          throw new MeshError(MESH_ERRORS.SOD_VIOLATION, conflict, { task_id: taskId, agent_id: agentId })
        }
        const unmet = this.unmetDependencies(task)
        if (unmet.length > 0) {
          throw new MeshError(
            MESH_ERRORS.DEPENDENCY_UNMET,
            `task ${taskId} depends on ${unmet.join(', ')} which are not merged`,
            { task_id: taskId, unmet },
          )
        }
        applyTransition(task, 'claimed', { by: sessionId, note: note ?? (rework ? 'rework after rejection' : 'claimed') })
        task.claimed_by = sessionId
        task.implementer_agent = agentId
        if (!task.base_commit) task.base_commit = this.git.headSha()
        this.store.saveTask(task)
        return { task, already: false }
      },
      { owner: `claim:${taskId}` },
    )
  }

  /**
   * Scheduler-side binding: reserve a task for a Session whose process has not
   * started yet. No hello required (there is no process to call it), but the
   * Session card already carries its role, and the same lock protects the card.
   */
  preclaimTask(sessionId: string, taskId: string): TaskCard {
    const session = this.store.requireSession(sessionId)
    const result = this.claimLocked(taskId, sessionId, session.agent_id, session.role, 'bound by scheduler')
    const task = result.task
    if (!result.already) {
      this.prepareSandbox(task)
      this.store.boardEvent({ event: 'task.claimed', task_id: taskId, session: sessionId, agent: session.agent_id, by: 'scheduler' })
    }
    return this.store.requireTask(taskId)
  }

  /** Agent-side claim: needs a live Session that has called hello(). Returns the context package. */
  claimTask(
    sessionId: string,
    taskId: string,
    opts: { contextLevel?: ContextLevel } = {},
  ): { task: TaskCard; contextPath: string; message: string } {
    const identity = this.identity.requireIdentity(sessionId)
    const result = this.claimLocked(taskId, sessionId, identity.agent.agent_id, identity.session.role)
    const task = result.task
    if (!result.already) {
      this.prepareSandbox(task)
      this.store.boardEvent({
        event: 'task.claimed',
        task_id: taskId,
        session: sessionId,
        agent: identity.agent.agent_id,
        by: 'agent',
      })
      this.bus.send(identity, {
        to: { role: task.role, thread: task.task_id },
        type: 'task.assign',
        body: `任务 ${task.task_id} 已由 ${identity.agent.agent_id} 领取：${task.title}`,
      })
    }
    const built = this.context.build({ taskId, level: opts.contextLevel ?? 'standard', sessionId })
    const updated = this.store.requireTask(taskId)
    updated.context_package = built.path
    updated.context_level = built.level
    this.store.saveTask(updated)
    return {
      task: this.store.requireTask(taskId),
      contextPath: path.resolve(this.store.paths.root, built.path),
      message: `上下文包已生成：${built.path}（${built.level}）`,
    }
  }

  /**
   * Create the sandbox if it does not exist yet. Idempotent.
   *
   * The base commit is decided *here*, not when the card was written: a task can wait
   * on the board for a long time while its dependencies merge, and a worker must
   * build on today's main, not on the tree that existed when the card was created.
   * Getting this wrong gives the worker a stale tree (missing the specs it depends
   * on) and floods the audit with phantom out-of-scope files at submit time.
   *
   * If a previous sandbox cannot be removed (a sandboxed agent can leave an
   * undeletable ACL behind), the platform uses the next slot: the sandbox path is
   * recorded on the card, so "where this task lived" is never a convention.
   */
  prepareSandbox(task: TaskCard): string {
    const head = this.git.headSha() ?? ''
    let lastError: unknown = null
    for (let slot = 1; slot <= 9; slot++) {
      const name = slot === 1 ? task.task_id : `${task.task_id}-${slot}`
      const abs = this.store.paths.resolve('worktrees', name)
      const existing = this.git.sandboxState(abs) === 'clone'
      const base = existing ? (task.base_commit ?? head) : head || task.base_commit || ''
      if (!base) throw new MeshError(MESH_ERRORS.GIT_FAILED, 'no base commit for sandbox')
      try {
        this.git.ensureSandbox(abs, task.branch, base)
        const updated = this.store.requireTask(task.task_id)
        updated.worktree = this.store.paths.rel(abs)
        if (base !== updated.base_commit) {
          if (updated.base_commit && !existing) {
            this.store.auditEvent('sandbox.rebased', {
              task_id: task.task_id,
              from: updated.base_commit,
              to: base,
              reason: 'dispatched after dependencies merged',
            })
          }
          updated.base_commit = base
        }
        this.store.saveTask(updated)
        return abs
      } catch (e) {
        lastError = e
      }
    }
    throw new MeshError(MESH_ERRORS.GIT_FAILED, `could not prepare a sandbox for ${task.task_id}`, {
      last_error: (lastError as Error)?.message ?? String(lastError),
    })
  }

  // -- progress / submit ---------------------------------------------------

  reportProgress(identity: Identity, taskId: string, pct: number, blockers?: string): TaskCard {
    const task = this.store.requireTask(taskId)
    this.assertOwnWork(identity, task)
    if (task.status === 'claimed') {
      applyTransition(task, 'in_progress', { by: identity.session.session_id, note: `progress ${pct}%` })
    }
    this.store.saveTask(task)
    const clamped = Math.max(0, Math.min(100, Math.round(pct)))
    this.bus.send(identity, {
      to: { role: 'coordinator', thread: taskId },
      type: 'heartbeat',
      body: `T ${taskId} ${clamped}%${blockers ? ` — 阻塞：${blockers}` : ''}`,
      ttl_seconds: 3600,
    })
    return task
  }

  private assertOwnWork(identity: Identity, task: TaskCard): void {
    if (task.implementer_agent && task.implementer_agent !== identity.agent.agent_id) {
      throw new MeshError(
        MESH_ERRORS.ROLE_FORBIDDEN,
        `${identity.agent.agent_id} is not the implementer of ${task.task_id}`,
        { task_id: task.task_id, implementer: task.implementer_agent },
      )
    }
  }

  /** Channel B: commit on the task branch, then submit. */
  submitTask(identity: Identity, taskId: string, summary: string): {
    task: TaskCard
    scope: ReturnType<typeof scopeCheck>
    warnings: string[]
  } {
    if (!identity.role.can_implement) {
      throw new MeshError(MESH_ERRORS.ROLE_FORBIDDEN, `role ${identity.session.role} may not submit implementation work`, {
        role: identity.session.role,
      })
    }
    const task = this.store.requireTask(taskId)
    this.assertOwnWork(identity, task)
    if (!['claimed', 'in_progress', 'rejected'].includes(task.status)) {
      throw new MeshError(MESH_ERRORS.TRANSITION_ILLEGAL, `cannot submit a task in status ${task.status}`, {
        task_id: taskId,
        status: task.status,
      })
    }
    const worktree = path.resolve(this.store.paths.root, task.worktree ?? this.store.paths.worktreeRel(taskId))
    if (this.git.statusPorcelain(worktree).trim() !== '') {
      throw new MeshError(
        MESH_ERRORS.GIT_FAILED,
        'your sandbox has uncommitted changes: commit them first, then submit',
        { status: this.git.statusPorcelain(worktree).split('\n').slice(0, 20) },
      )
    }
    const head = this.git.sandboxHead(worktree)
    if (!head) throw new MeshError(MESH_ERRORS.GIT_FAILED, 'task branch has no commit')
    const branch = this.git.currentBranch(worktree)
    if (!branch || branch === 'HEAD') {
      throw new MeshError(
        MESH_ERRORS.GIT_FAILED,
        `your sandbox is on a detached HEAD; check out ${task.branch} before submitting`,
        { expected_branch: task.branch },
      )
    }
    const base = task.base_commit ?? head
    const files = this.git.sandboxChangedFiles(worktree, base, head)
    if (files.length === 0) {
      throw new MeshError(MESH_ERRORS.GIT_FAILED, 'no changes on the task branch relative to base; nothing to submit', {
        base,
        head,
      })
    }
    const oos = outOfScope(files, task.scope.write)
    const warnings: string[] = []
    if (oos.length > 0) {
      warnings.push(
        `越界改动 ${oos.length} 个路径：${oos.slice(0, 6).join(', ')}（合并终审会整单拒绝，请在 submit 前处理）`,
      )
      // detect-only, early: tell the truth now rather than at merge time.
      this.audit.violation({
        kind: 'scope.out-of-write',
        task_id: taskId,
        session_id: identity.session.session_id,
        agent_id: identity.agent.agent_id,
        detail: `submission touches ${oos.length} path(s) outside scope.write`,
        evidence: { out_of_scope: oos, files, base, head },
      })
    }
    task.submission = {
      commit: head,
      branch,
      summary: summary.trim(),
      submitted_at: nowIso(),
      session_id: identity.session.session_id,
      files,
    }
    if (task.status === 'claimed' || task.status === 'rejected') {
      applyTransition(task, 'in_progress', {
        by: identity.session.session_id,
        note: task.status === 'rejected' ? 'rework submitted' : 'submitted',
      })
    }
    applyTransition(task, 'submitted', { by: identity.session.session_id, note: summary.slice(0, 200) })
    task.reviews = []
    this.store.saveTask(task)
    this.store.boardEvent({ event: 'task.submitted', task_id: taskId, commit: head, files: files.length })
    this.bus.send(identity, {
      to: { role: 'supervisor', thread: taskId },
      type: 'task.assign',
      body: `请审查 ${taskId}（commit ${head.slice(0, 8)}）：${summary}`,
    })
    const ref = (() => {
      try {
        return ensureMeshRef(this.git, this.store.paths, task)
      } catch {
        return null
      }
    })()
    const check = ref
      ? scopeCheck(this.git, task, { rev: ref })
      : { task_id: taskId, branch: task.branch, base: task.base_commit ?? '', files, out_of_scope: oos, scope_write: [...task.scope.write], ok: oos.length === 0 }
    return { task: this.store.requireTask(taskId), scope: check, warnings }
  }

  // -- review --------------------------------------------------------------

  requestReview(sessionId: string, taskId: string): TaskCard {
    const identity = this.identity.requireIdentity(sessionId)
    return withLock(this.store.paths.lockFile(`task-${taskId}`), () => {
      const task = this.store.requireTask(taskId)
      if (task.status === 'reviewing') return task
      if (task.status !== 'submitted') {
        throw new MeshError(MESH_ERRORS.TRANSITION_ILLEGAL, `cannot review a task in status ${task.status}`, {
          task_id: taskId,
          status: task.status,
        })
      }
      if (identity.session.role !== 'supervisor') {
        throw new MeshError(MESH_ERRORS.ROLE_FORBIDDEN, `only a supervisor session can open a review`, {
          role: identity.session.role,
        })
      }
      this.identity.assertIndependentReviewer(task, identity.agent.agent_id)
      applyTransition(task, 'reviewing', { by: identity.session.session_id })
      this.store.saveTask(task)
      this.store.boardEvent({ event: 'task.reviewing', task_id: taskId, reviewer: identity.agent.agent_id })
      return task
    })
  }

  recordVerdict(
    identity: Identity,
    taskId: string,
    verdict: 'approved' | 'rejected',
    criteria: ReviewCriterionResult[],
    notes: string,
    opts: { allowStripMerge?: boolean } = {},
  ): { task: TaskCard; review: ReviewRecord } {
    if (!identity.role.can_review) {
      throw new MeshError(MESH_ERRORS.ROLE_FORBIDDEN, `role ${identity.session.role} may not issue verdicts`, {
        role: identity.session.role,
      })
    }
    const reviewId = this.audit.nextReviewId()
    const outcome = withLock(this.store.paths.lockFile(`task-${taskId}`), () => {
      const task = this.store.requireTask(taskId)
      this.identity.assertIndependentReviewer(task, identity.agent.agent_id)
      if (task.status !== 'reviewing' && task.status !== 'submitted') {
        throw new MeshError(MESH_ERRORS.TRANSITION_ILLEGAL, `cannot verdict a task in status ${task.status}`, {
          task_id: taskId,
          status: task.status,
        })
      }
      if (task.status === 'submitted') applyTransition(task, 'reviewing', { by: identity.session.session_id })
      const review: ReviewRecord = {
        review_id: reviewId,
        task_id: taskId,
        reviewer_session: identity.session.session_id,
        reviewer_agent: identity.agent.agent_id,
        implementer_agent: task.implementer_agent ?? 'unknown',
        verdict,
        criteria,
        notes,
        independent: task.implementer_agent !== identity.agent.agent_id,
        allow_strip_merge: opts.allowStripMerge === true,
        at: nowIso(),
        submission_commit: task.submission?.commit ?? '',
      }
      this.store.saveReview(review)
      task.reviews.push(reviewId)
      applyTransition(task, verdict === 'approved' ? 'approved' : 'rejected', {
        by: identity.session.session_id,
        note: `${reviewId} ${verdict}`,
      })
      this.store.saveTask(task)
      return { task, review }
    })

    this.store.boardEvent({ event: `task.${verdict}`, task_id: taskId, review_id: reviewId, by: identity.agent.agent_id })
    if (verdict === 'approved') {
      this.bus.send(identity, {
        to: { role: 'integrator', thread: taskId },
        type: 'review.verdict',
        body: `${reviewId} approved ${taskId}，可执行 hub.merge(${taskId})。${opts.allowStripMerge ? '（授权 strip 模式）' : ''}`,
      })
    } else {
      const failed = criteria.filter((c) => !c.pass).map((c) => `- ${c.criterion}：${c.evidence}`).join('\n')
      this.bus.send(identity, {
        to: { role: outcome.task.role, thread: taskId },
        type: 'task.feedback',
        body: `${reviewId} rejected ${taskId}。\n${failed}\n\n说明：${notes}`,
      })
    }
    return outcome
  }

  // -- merge ---------------------------------------------------------------

  approvedReview(task: TaskCard): ReviewRecord | null {
    const reviews = this.store.listReviews(task.task_id)
    const approved = reviews.filter((r) => r.verdict === 'approved')
    return approved.length > 0 ? (approved[approved.length - 1] ?? null) : null
  }

  mergeTask(
    taskId: string,
    opts: {
      identity?: Identity | null
      auto?: boolean
      allowStrip?: boolean
      actorId?: string
    } = {},
  ): {
    task: TaskCard
    merge_commit: string
    files: string[]
    stripped: string[]
    mode: MergeMode
  } {
    const task = this.store.requireTask(taskId)
    const actorId = opts.identity?.session.session_id ?? opts.actorId ?? 'hub(auto-integrator)'
    const review = this.approvedReview(task)
    if (!review) {
      throw new MeshError(MESH_ERRORS.REVIEW_MISSING, `task ${taskId} has no approved review; it cannot be merged (C1)`, {
        task_id: taskId,
      })
    }
    if (opts.identity) {
      if (!opts.identity.role.can_merge) {
        throw new MeshError(MESH_ERRORS.ROLE_FORBIDDEN, `role ${opts.identity.session.role} may not merge`, {
          role: opts.identity.session.role,
        })
      }
      this.identity.assertIndependentIntegrator(task, opts.identity.agent.agent_id)
    }
    if (task.status !== 'approved') {
      throw new MeshError(MESH_ERRORS.TRANSITION_ILLEGAL, `only an approved task can be merged (status is ${task.status})`, {
        task_id: taskId,
        status: task.status,
      })
    }
    const allowStrip = opts.allowStrip ?? review.allow_strip_merge
    let outcome: ReturnType<typeof mergeWithScopeGate>
    try {
      const ref = ensureMeshRef(this.git, this.store.paths, task)
      outcome = mergeWithScopeGate(this.git, task, {
        mainBranch: this.store.getState().main_branch,
        allowStrip,
        ref,
      })
    } catch (e) {
      if (e instanceof MergeRefused || e instanceof ScopeViolation) {
        const outOfScopePaths = e instanceof MergeRefused ? e.check.out_of_scope : e.out_of_scope
        const evidence = e instanceof MergeRefused ? e.evidence : JSON.stringify(e.detail, null, 2)
        const file = this.audit.writeEvidence(`scope-${taskId}-${Date.now()}.md`, evidence)
        this.audit.violation({
          kind: 'scope.merge-blocked',
          task_id: taskId,
          session_id: opts.identity?.session.session_id ?? null,
          agent_id: task.implementer_agent,
          detail: `merge gate refused ${taskId}: ${outOfScopePaths.length} out-of-scope path(s)`,
          evidence: { out_of_scope: outOfScopePaths, evidence_file: this.store.paths.rel(file) },
        })
        const updated = withLock(this.store.paths.lockFile(`task-${taskId}`), () => {
          const fresh = this.store.requireTask(taskId)
          if (fresh.status === 'approved') {
            applyTransition(fresh, 'rejected', { by: actorId, note: 'merge gate: out-of-scope changes' })
            this.store.saveTask(fresh)
          }
          return fresh
        })
        const sender = opts.identity ?? this.systemIdentity()
        this.bus.send(sender, {
          to: { role: updated.role, thread: taskId },
          type: 'task.feedback',
          body: [
            `合并终审拒绝 ${taskId}：改动超出 scope.write。`,
            `越界文件：${outOfScopePaths.slice(0, 10).join(', ')}`,
            `证据：${this.store.paths.rel(file)}`,
            '请只保留 scope 内的改动后重新 submit；整单已打回。',
          ].join('\n'),
        })
        throw e
      }
      throw e
    }

    const merged = withLock(this.store.paths.lockFile(`task-${taskId}`), () => {
      const fresh = this.store.requireTask(taskId)
      fresh.merge = {
        commit: fresh.submission?.commit ?? '',
        merge_commit: outcome.merge_commit,
        merged_at: nowIso(),
        session_id: actorId,
        mode: outcome.mode,
        stripped: outcome.stripped,
        files: outcome.files,
      }
      applyTransition(fresh, 'merged', {
        by: actorId,
        note: `${outcome.mode} merge ${outcome.merge_commit.slice(0, 8)}${outcome.stripped.length > 0 ? ` stripped=${outcome.stripped.length}` : ''}`,
      })
      this.store.saveTask(fresh)
      return fresh
    })
    this.store.appendMerge({
      event: 'merge',
      task_id: taskId,
      merge_commit: outcome.merge_commit,
      pre_merge_head: outcome.pre_merge_head,
      branch: task.branch,
      mode: outcome.mode,
      stripped: outcome.stripped,
      files: outcome.files,
      actor: actorId,
      review_id: review.review_id,
    })
    this.store.boardEvent({ event: 'task.merged', task_id: taskId, merge_commit: outcome.merge_commit, mode: outcome.mode })
    if (outcome.mode === 'strip') {
      // A strip merge is an exception worth auditing; a clean merge is the norm and
      // lives in audit/merges.jsonl, not in the violation log.
      this.audit.violation({
        kind: 'scope.merge-blocked',
        severity: 'info',
        task_id: taskId,
        detail: `merged ${taskId} in strip mode; dropped ${outcome.stripped.length} out-of-scope path(s)`,
        evidence: { merge_commit: outcome.merge_commit, stripped: outcome.stripped },
      })
    }
    const unlocked = this.unlockDependents(taskId)
    const sender = opts.identity ?? this.systemIdentity()
    this.bus.notifyCoordinator(
      sender,
      'board.update',
      `${taskId} 已合并（${outcome.mode}，${outcome.files.length} 个文件）${unlocked.length > 0 ? `，解锁：${unlocked.join(', ')}` : ''}`,
      taskId,
    )
    return { task: merged, merge_commit: outcome.merge_commit, files: outcome.files, stripped: outcome.stripped, mode: outcome.mode }
  }

  /** A synthetic identity for hub-initiated (auto) actions that still need to send. */
  systemIdentity(): Identity {
    const agent = {
      agent_id: 'mesh-hub',
      display_name: 'AgentMesh Hub',
      kind: 'builtin' as const,
      enabled: true,
      command: '',
      args: [],
      capabilities: [...ROLE_IDS],
      concurrency: 999,
      cost_tier: 1 as const,
      transport: 'in-process' as const,
      mcp_inject: 'none' as const,
      extra_env: {},
      strip_env: [],
      prompt_mode: 'arg' as const,
      prompt_flag: null,
      headless_args: [],
      ttl_seconds: 3600,
      notes: 'deterministic platform core',
    }
    return {
      session: {
        session_id: this.store.getState().flags['hub_session']?.toString() ?? 'S-000000',
        agent_id: 'mesh-hub',
        role: 'coordinator',
        task: null,
        mode: 'platform',
        lifespan: 'daemon',
        spawned_by: 'hub',
        sandbox: null,
        status: 'active',
        pid: process.pid,
        created_at: nowIso(),
        last_heartbeat_at: nowIso(),
        ttl_seconds: 3600,
        hello_at: nowIso(),
        resume_token: null,
        turns: 0,
        exit: null,
      },
      agent,
      role: getRoleCard('coordinator'),
    }
  }

  // -- escalation / blocking ----------------------------------------------

  blockTask(taskId: string, reason: string, by: string): TaskCard {
    return withLock(this.store.paths.lockFile(`task-${taskId}`), () => {
      const task = this.store.requireTask(taskId)
      if (task.status === 'blocked') return task
      if (task.status === 'merged') {
        throw new MeshError(MESH_ERRORS.TRANSITION_ILLEGAL, 'a merged task cannot be blocked', { task_id: taskId })
      }
      applyTransition(task, 'blocked', { by, note: reason })
      this.store.saveTask(task)
      this.store.boardEvent({ event: 'task.blocked', task_id: taskId, reason })
      this.store.auditEvent('task.blocked', { task_id: taskId, by, reason })
      return task
    })
  }

  unblockTask(taskId: string, by: string, note?: string): TaskCard {
    return withLock(this.store.paths.lockFile(`task-${taskId}`), () => {
      const task = this.store.requireTask(taskId)
      if (task.status !== 'blocked') return task
      const holder = task.claimed_by ? this.store.getSession(task.claimed_by) : null
      const holderLive = Boolean(holder && (holder.status === 'active' || holder.status === 'starting'))
      const target: TaskStatus = holderLive ? 'in_progress' : 'ready'
      if (!holderLive) {
        // Nobody is holding it any more: the card goes back to the board, not to a ghost.
        task.claimed_by = null
        task.implementer_agent = null
      }
      applyTransition(task, target, { by, note: note ?? 'unblocked' })
      task.blocked_reason = null
      this.store.saveTask(task)
      this.store.boardEvent({ event: 'task.unblocked', task_id: taskId, to: target, by })
      // The audit log is the one the scheduler reads to reset retry budgets, so an
      // unblock must land there too — otherwise "try again" silently doesn't.
      this.store.auditEvent('task.unblocked', { task_id: taskId, to: target, by, note: note ?? null })
      return task
    })
  }

  // -- queries -------------------------------------------------------------

  /** What a Session may see: its own role's work, its task's dependencies, and its claims. */
  board(filter: BoardFilter = {}, identity?: Identity): TaskCard[] {
    let tasks = this.store.listTasks()
    if (filter.status) {
      const wanted = Array.isArray(filter.status) ? filter.status : [filter.status]
      tasks = tasks.filter((t) => wanted.includes(t.status))
    }
    if (filter.role) tasks = tasks.filter((t) => t.role === filter.role)
    if (filter.claimed_by) tasks = tasks.filter((t) => t.claimed_by === filter.claimed_by)
    if (filter.thread) tasks = tasks.filter((t) => t.task_id === filter.thread)
    if (identity) {
      const role = identity.session.role
      const globalView: RoleId[] = ['coordinator', 'supervisor', 'integrator', 'sentinel', 'planner', 'architect']
      if (!globalView.includes(role)) {
        const myTask = identity.session.task
        const depIds = myTask ? (this.store.getTask(myTask)?.depends_on ?? []) : []
        tasks = tasks.filter(
          (t) =>
            t.role === role ||
            t.claimed_by === identity.session.session_id ||
            t.task_id === myTask ||
            depIds.includes(t.task_id),
        )
      }
    }
    return tasks
  }

  summary(): { counts: Record<string, number>; total: number } {
    const counts: Record<string, number> = {}
    const tasks = this.store.listTasks()
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1
    return { counts, total: tasks.length }
  }

  /** Tasks whose dependencies are all merged but which are still drafts. */
  readyCandidates(): TaskCard[] {
    return this.store
      .listTasks()
      .filter((t) => t.status === 'draft' && this.unmetDependencies(t).length === 0)
  }

  tasksPendingReview(): TaskCard[] {
    return this.store.listTasks().filter((t) => t.status === 'submitted' || t.status === 'reviewing')
  }

  tasksPendingMerge(): TaskCard[] {
    return this.store.listTasks().filter((t) => t.status === 'approved')
  }

  /**
   * Append to the platform decision log (`.mesh/decisions.md`).
   *
   * This is deliberately *not* an artifact: decisions are the platform's memory of
   * why the board looks the way it does, they must survive task cleanup, and they
   * are what the next coordinator session reads first.
   */
  appendDecision(identity: Identity, text: string, title?: string): { bytes: number; path: string } {
    if (!canPlan(identity.session.role)) {
      throw new MeshError(MESH_ERRORS.ROLE_FORBIDDEN, `role ${identity.session.role} may not write the decision log`, {
        role: identity.session.role,
        plan_roles: [...PLAN_ROLES],
      })
    }
    const file = this.store.paths.decisionsFile
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const header = `\n\n---\n\n## ${title?.trim() || '决策'} · ${nowIso()}\n\n> 由 ${identity.agent.agent_id} / ${identity.session.session_id}（${identity.session.role}）记录\n\n`
    fs.appendFileSync(file, `${header}${text.trim()}\n`)
    this.store.auditEvent('decision.appended', {
      session_id: identity.session.session_id,
      agent_id: identity.agent.agent_id,
      role: identity.session.role,
      title: title ?? null,
      bytes: Buffer.byteLength(text, 'utf8'),
    })
    return { bytes: Buffer.byteLength(`${header}${text}`, 'utf8'), path: this.store.paths.rel(file) }
  }

  /** Submit a non-code artifact through channel C, with role-path enforcement. */
  putArtifact(
    identity: Identity,
    relpath: string,
    content: string,
    opts: { taskId?: string | null } = {},
  ): { path: string; sha256: string; bytes: number } {
    const rel = normRel(relpath)
    const globs = identity.role.output_globs
    const allowed = globs.some((g) => matchAnyGlob([g], rel))
    const message = `artifact write denied for role ${identity.session.role}: ${rel}`
    if (!allowed) {
      const looksLikeCode = /\.[cm]?[jt]sx?$|\.py$|\.go$|\.rs$|\.java$|\.rb$|\.css$|\.vue$|\.html?$/.test(rel)
      const kind = looksLikeCode && !identity.role.can_write_code ? 'role.code-attempt' : 'role.artifact-denied'
      this.audit.violation({
        kind,
        task_id: opts.taskId ?? null,
        session_id: identity.session.session_id,
        agent_id: identity.agent.agent_id,
        detail: message,
        evidence: { path: rel, allowed_globs: globs, role: identity.session.role },
      })
      throw new MeshError(MESH_ERRORS.ARTIFACT_DENIED, message, {
        path: rel,
        allowed_globs: globs,
        hint: 'code belongs on the task branch (channel B); hub.put_artifact only accepts non-code deliverables',
      })
    }
    const sha = this.store.putArtifact(rel, content, {
      session_id: identity.session.session_id,
      role: identity.session.role,
      task_id: opts.taskId ?? null,
    })
    this.store.auditEvent('artifact.put', {
      path: rel,
      sha256: sha.sha256,
      bytes: sha.bytes,
      session_id: identity.session.session_id,
      role: identity.session.role,
    })
    return sha
  }

  availableMessages(identity: Identity): Message[] {
    return this.store.inbox(identity.agent.agent_id, { unreadOnly: true })
  }
}
