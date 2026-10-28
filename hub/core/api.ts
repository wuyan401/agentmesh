/**
 * HubApi — the agent-facing surface (`hub.*`), used identically by the MCP
 * server and the `mesh` CLI's agent mode.
 *
 * Two invariants live here:
 *  - every call resolves a real, hello'd Session before doing anything (C6);
 *  - role capability is checked in code, not asked of the prompt (C5).
 */

import fs from 'node:fs'
import path from 'node:path'
import { MeshError, MESH_ERRORS } from './errors.ts'
import { matchAnyGlob, normRel } from './fsx.ts'
import { getRoleCard } from '../roles/cards.ts'
import { Scheduler } from '../scheduler/scheduler.ts'
import { buildTeammates } from './teammates.ts'
import { canPlan, PLAN_ROLES } from './types.ts'
import type { PeerScore } from './types.ts'
import type { ContextLevel } from './context.ts'
import type { Hub } from './hub.ts'
import type { Identity } from './identity.ts'
import type { Message, MessageType, ReviewCriterionResult, RoleId, TaskCard, TaskStatus } from './types.ts'

export interface ApiResult {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string; detail: Record<string, unknown> }
}

const GLOBAL_BOARD_ROLES: RoleId[] = ['coordinator', 'supervisor', 'integrator', 'sentinel', 'planner', 'architect']

function ok(data: unknown): ApiResult {
  return { ok: true, data }
}

export function toErrorResult(e: unknown): ApiResult {
  if (e instanceof MeshError) {
    return { ok: false, error: { code: e.code, message: e.message, detail: e.detail } }
  }
  const err = e as Error
  return { ok: false, error: { code: MESH_ERRORS.INTERNAL, message: err?.message ?? String(e), detail: {} } }
}

function summariseTask(task: TaskCard): Record<string, unknown> {
  return {
    task_id: task.task_id,
    title: task.title,
    role: task.role,
    status: task.status,
    depends_on: task.depends_on,
    claimed_by: task.claimed_by,
    implementer_agent: task.implementer_agent,
    scope_write: task.scope.write,
    acceptance_count: task.acceptance.length,
    reviews: task.reviews,
    submission_commit: task.submission?.commit ?? null,
    merge_commit: task.merge?.merge_commit ?? null,
    blocked_reason: task.blocked_reason,
    updated_at: task.updated_at,
  }
}

export class HubApi {
  readonly hub: Hub

  constructor(hub: Hub) {
    this.hub = hub
  }

  private identity(sessionId: string): Identity {
    return this.hub.identity.requireIdentity(sessionId)
  }

  // -- identity ------------------------------------------------------------

  /**
   * Register the Session and return its role card. This is the double injection:
   * the same identity that was written into the spawn prompt, restated by the Hub
   * so a drifted agent gets pulled back to who it is.
   */
  hello(sessionId: string): ApiResult {
    const { session, roleCard, agent } = this.hub.identity.hello(sessionId)
    const flushed = this.hub.bus.flushPendingFor(session)
    const card = getRoleCard(session.role)
    const lines: string[] = []
    lines.push(`# 你已接入 AgentMesh · ${card.title}`)
    lines.push('')
    lines.push(`session: ${session.session_id}`)
    lines.push(`agent:   ${agent.agent_id} (${agent.display_name})`)
    lines.push(`role:    ${session.role}`)
    if (session.task) lines.push(`task:    ${session.task}`)
    lines.push(`sandbox: ${session.sandbox ?? '（无，daemon 会话）'}`)
    lines.push('')
    lines.push(`> ${card.prompt.split('\n')[0]}`)
    lines.push('')
    lines.push('## 硬约束')
    for (const c of card.constraints) lines.push(`- ${c}`)
    lines.push('')
    lines.push('## 本会话固定条款')
    lines.push('① 你可能在其他会话中担任其他角色。本会话中你仅是「' + card.title + '」，不得沿用、暗示或援引其他任何会话的身份、权限与上下文。')
    lines.push('② 本任务完成以 Supervisor 通过为准。scope 之外的任何产出不会被合并。')
    lines.push('')
    lines.push('## 你的全部工具都在')
    lines.push('原生 Bash / 读写 / 搜索 / 子 Agent / Web 全部可用，平台不限制工具。')
    lines.push('')
    lines.push('## 下一步')
    if (session.task) {
      lines.push(`- \`hub.get_task("${session.task}")\` 看任务卡与验收标准`)
      lines.push(`- \`hub.claim_task("${session.task}")\` 领取并拿上下文包`)
    } else {
      lines.push('- `hub.get_board()` 看板')
      lines.push('- `hub.read_messages()` 读收件箱')
    }
    return ok({
      session: session.session_id,
      agent: agent.agent_id,
      role: session.role,
      task: session.task,
      sandbox: session.sandbox,
      lifecycle: session.lifespan,
      role_card: lines.join('\n'),
      flushed_messages: flushed,
    })
  }

  whoami(sessionId: string): ApiResult {
    const id = this.identity(sessionId)
    return ok({
      session: id.session.session_id,
      agent: id.agent.agent_id,
      role: id.session.role,
      task: id.session.task,
      status: id.session.status,
      sandbox: id.session.sandbox,
      deadline: new Date(this.hub.identity.deadline(id.session)).toISOString(),
      role_card: getRoleCard(id.session.role).prompt,
    })
  }

  heartbeat(sessionId: string): ApiResult {
    this.hub.identity.touch(sessionId)
    return ok({ alive: true })
  }

  // -- board ---------------------------------------------------------------

  get_board(sessionId: string, filter: { status?: TaskStatus | TaskStatus[]; role?: RoleId } = {}): ApiResult {
    const id = this.identity(sessionId)
    const tasks = this.hub.board.board(filter, id)
    const summary = this.hub.board.summary()
    return ok({
      as: { role: id.session.role, agent: id.agent.agent_id, session: id.session.session_id },
      scope: GLOBAL_BOARD_ROLES.includes(id.session.role) ? 'global' : 'role-local',
      counts: summary.counts,
      tasks: tasks.map(summariseTask),
    })
  }

  get_task(sessionId: string, taskId: string): ApiResult {
    const id = this.identity(sessionId)
    const task = this.hub.store.requireTask(taskId)
    const reviews = this.hub.store.listReviews(taskId)
    const canSeeAll = GLOBAL_BOARD_ROLES.includes(id.session.role)
    const mine =
      task.role === id.session.role || task.claimed_by === id.session.session_id || task.task_id === id.session.task
    const detail: Record<string, unknown> = {
      ...summariseTask(task),
      scope_read: task.scope.read,
      acceptance: task.acceptance,
      branch: task.branch,
      base_commit: task.base_commit,
      worktree: task.worktree,
      context_package: task.context_package,
      submission: task.submission,
      merge: task.merge,
      history: task.history.slice(-20),
      reviews: reviews.map((r) => ({
        review_id: r.review_id,
        verdict: r.verdict,
        reviewer: r.reviewer_agent,
        at: r.at,
        notes: r.notes,
      })),
    }
    if (!canSeeAll && !mine) {
      // Still readable (C4: reads are never restricted) but flag why it looks odd.
      detail['note'] = 'this task is outside your role thread; visible because reads are unrestricted'
    }
    return ok(detail)
  }

  claim_task(sessionId: string, taskId: string, opts: { contextLevel?: ContextLevel } = {}): ApiResult {
    const result = this.hub.board.claimTask(sessionId, taskId, opts)
    const task = result.task
    return ok({
      task_id: task.task_id,
      status: task.status,
      branch: task.branch,
      worktree: task.worktree,
      context_package: result.contextPath,
      message: result.message,
      reminder: `只写这些路径：${task.scope.write.join(', ')}。完成后 commit 到 ${task.branch}，再 hub.submit。`,
    })
  }

  get_context(sessionId: string, taskId: string, level: ContextLevel = 'standard'): ApiResult {
    const id = this.identity(sessionId)
    const built = this.hub.context.build({ taskId, level, sessionId: id.session.session_id })
    return ok({
      level: built.level,
      path: built.path,
      absolute_path: path.resolve(this.hub.paths.root, built.path),
      markdown: built.markdown,
    })
  }

  // -- work ----------------------------------------------------------------

  report_progress(sessionId: string, taskId: string, pct: number, blockers?: string): ApiResult {
    const id = this.identity(sessionId)
    const task = this.hub.board.reportProgress(id, taskId, pct, blockers)
    return ok({ task_id: task.task_id, status: task.status, pct, blockers: blockers ?? null })
  }

  request_clarification(sessionId: string, taskId: string, question: string): ApiResult {
    const id = this.identity(sessionId)
    const task = this.hub.store.requireTask(taskId)
    const msg = this.hub.bus.send(id, {
      to: { role: 'coordinator', thread: taskId },
      type: 'question.ask',
      body: `关于 ${taskId} 的问题：${question}`,
      ttl_seconds: 3600,
    })
    return ok({ msg_id: msg.msg_id, asked: 'coordinator', task_id: taskId, note: '可以继续不依赖该信息的工作；不要停下' })
  }

  /**
   * Report an out-of-scope need or a blocker to the coordinator.
   *
   * Escalating is a *report*, not a stop: by default the task keeps running so a
   * worker that correctly refuses to overreach is not punished with a dead card.
   * `block` is for "I genuinely cannot continue without an answer".
   */
  escalate(sessionId: string, reason: string, taskId?: string, opts: { block?: boolean } = {}): ApiResult {
    const id = this.identity(sessionId)
    const msg = this.hub.bus.send(id, {
      to: { role: 'coordinator', thread: taskId ?? '*'},
      type: 'escalation',
      body: reason,
      ttl_seconds: 7200,
    })
    const blocked = Boolean(taskId && opts.block)
    if (blocked) this.hub.board.blockTask(taskId!, `escalated: ${reason}`, id.session.session_id)
    this.hub.store.auditEvent('escalation', {
      session_id: id.session.session_id,
      agent_id: id.agent.agent_id,
      task_id: taskId ?? null,
      reason,
      blocked,
    })
    return ok({
      msg_id: msg.msg_id,
      escalated_to: 'coordinator',
      task_blocked: blocked,
      note: blocked
        ? '任务已标记 blocked，等 coordinator 仲裁后再继续'
        : '平台已记录。继续做 scope 内的工作，不要因为这次上报停下来',
    })
  }

  submit(sessionId: string, taskId: string, summary: string): ApiResult {
    const id = this.identity(sessionId)
    const result = this.hub.board.submitTask(id, taskId, summary)
    return ok({
      task_id: taskId,
      status: result.task.status,
      commit: result.task.submission?.commit ?? null,
      files: result.task.submission?.files ?? [],
      scope_clean: result.scope.ok,
      out_of_scope: result.scope.out_of_scope,
      warnings: result.warnings,
      next: 'Supervisor 会按 acceptance 审查；通过后由 Integrator 做 scope 终审并合并。',
    })
  }

  request_review(sessionId: string, taskId: string): ApiResult {
    const task = this.hub.board.requestReview(sessionId, taskId)
    return ok({ task_id: task.task_id, status: task.status })
  }

  verdict(
    sessionId: string,
    taskId: string,
    verdict: 'approved' | 'rejected',
    criteria: Array<ReviewCriterionResult | string>,
    notes: string,
    opts: { allow_strip_merge?: boolean } = {},
  ): ApiResult {
    const id = this.identity(sessionId)
    const normalised: ReviewCriterionResult[] =
      criteria.length > 0
        ? criteria.map((c) =>
            typeof c === 'string'
              ? { criterion: c, pass: verdict === 'approved', evidence: verdict === 'approved' ? '满足' : '未满足（见说明）' }
              : c,
          )
        : [{ criterion: 'acceptance', pass: verdict === 'approved', evidence: notes || '见说明' }]
    const result = this.hub.board.recordVerdict(id, taskId, verdict, normalised, notes, {
      allowStripMerge: opts.allow_strip_merge === true,
    })
    return ok({
      task_id: taskId,
      review_id: result.review.review_id,
      verdict,
      status: result.task.status,
      next:
        verdict === 'approved'
          ? 'Integrator 将执行 hub.merge（scope 终审）。'
          : '已打回实现者返工；返工后重新 submit。',
    })
  }

  merge(sessionId: string, taskId: string, opts: { allow_strip?: boolean } = {}): ApiResult {
    const id = this.identity(sessionId)
    const result = this.hub.board.mergeTask(taskId, { identity: id, allowStrip: opts.allow_strip })
    return ok({
      task_id: taskId,
      status: result.task.status,
      merge_commit: result.merge_commit,
      mode: result.mode,
      files: result.files,
      stripped: result.stripped,
    })
  }

  // -- planning ------------------------------------------------------------

  /**
   * Create a task card. Only planning roles may order work — a worker that could
   * mint its own cards would be able to route around the dependency graph.
   */
  create_task(
    sessionId: string,
    input: {
      title: string
      role: RoleId
      write: string[]
      read?: string[]
      acceptance: string[]
      depends_on?: string[]
      parent?: string | null
      tags?: string[]
      publish?: boolean
    },
  ): ApiResult {
    const id = this.identity(sessionId)
    if (!canPlan(id.session.role)) {
      throw new MeshError(MESH_ERRORS.ROLE_FORBIDDEN, `role ${id.session.role} may not create task cards`, {
        role: id.session.role,
        plan_roles: [...PLAN_ROLES],
      })
    }
    const task = this.hub.board.createTask(
      {
        title: input.title,
        role: input.role,
        scope: { write: input.write, read: input.read ?? [] },
        acceptance: input.acceptance,
        depends_on: input.depends_on ?? [],
        parent: input.parent ?? null,
        tags: input.tags ?? [],
        publish: input.publish !== false,
      },
      id,
    )
    return ok({
      task_id: task.task_id,
      status: task.status,
      role: task.role,
      scope_write: task.scope.write,
      acceptance: task.acceptance,
      note: task.status === 'draft' ? '依赖未合并，暂为 draft；依赖合并后自动 ready' : '已进入看板，调度器会处理',
    })
  }

  /** Append to the platform decision log. Planning roles only. */
  append_decision(sessionId: string, text: string, title?: string): ApiResult {
    const id = this.identity(sessionId)
    const result = this.hub.board.appendDecision(id, text, title)
    return ok({ ...result, note: '已写入 .mesh/decisions.md（平台决策日志，不是工件）' })
  }

  /** Read the platform decision log (everyone may read it). */
  get_decisions(sessionId: string): ApiResult {
    this.identity(sessionId)
    const file = this.hub.paths.decisionsFile
    const markdown = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    return ok({ path: this.hub.paths.rel(file), markdown })
  }

  publish_task(sessionId: string, taskId: string): ApiResult {
    const id = this.identity(sessionId)
    if (!canPlan(id.session.role)) {
      throw new MeshError(MESH_ERRORS.ROLE_FORBIDDEN, `role ${id.session.role} may not publish tasks`, {
        role: id.session.role,
      })
    }
    const task = this.hub.board.publishTask(taskId, id)
    return ok({ task_id: task.task_id, status: task.status, blocked_reason: task.blocked_reason })
  }

  // -- missions (V2) -------------------------------------------------------

  /** Build a mission. Planning roles and the human operator may do this. */
  create_mission(
    sessionId: string,
    input: {
      title: string
      brief: string
      acceptance?: string[]
      lead_agent?: string | null
      parent_mission?: string | null
    },
  ): ApiResult {
    const id = this.identity(sessionId)
    const canCreate = canPlan(id.session.role) || id.session.is_lead
    if (!canCreate) {
      throw new MeshError(MESH_ERRORS.ROLE_FORBIDDEN, `role ${id.session.role} may not create missions`, {
        role: id.session.role,
        plan_roles: [...PLAN_ROLES],
      })
    }
    const parent = input.parent_mission ?? (id.session.is_lead ? id.session.mission : null)
    const mission = this.hub.missions.createMission(
      {
        title: input.title,
        brief: input.brief,
        acceptance: input.acceptance ?? [],
        lead_agent: input.lead_agent ?? null,
        parent_mission: parent,
        // Explicit: the chat entry records where it came from; the platform never guesses.
        source: id.agent.kind === 'builtin' ? 'platform' : 'chat',
      },
      id,
    )
    return ok({
      mission_id: mission.mission_id,
      status: mission.status,
      lead_agent: mission.lead_agent,
      source: mission.source,
      next: 'Lead 需要开会话拆解：`plan_mission` 然后 `dispatch_mission`',
    })
  }

  /**
   * §5.2 chat entry: `start_mission` = create + put the lead to work.
   *
   * The lead is the caller — whoever received the job leads it. The scheduler is asked
   * to spawn the lead turn immediately, so the caller can end its own turn right away
   * ("你是 lead：拆解、派活、整合都由你在后续被拉起的会话里完成").
   */
  start_mission(
    sessionId: string,
    title: string,
    brief: string,
    acceptance?: string[],
  ): ApiResult {
    const id = this.identity(sessionId)
    if (!id.session.is_lead && !canPlan(id.session.role)) {
      throw new MeshError(MESH_ERRORS.ROLE_FORBIDDEN, `role ${id.session.role} may not start a mission`, {
        role: id.session.role,
        plan_roles: [...PLAN_ROLES],
      })
    }
    if (!id.agent.capabilities.includes('lead')) {
      throw new MeshError(
        MESH_ERRORS.CAPABILITY_MISSING,
        `${id.agent.agent_id} cannot lead: the 'lead' capability is not registered on its card`,
        { agent_id: id.agent.agent_id, hint: `mesh agents roles ${id.agent.agent_id} lead` },
      )
    }
    const mission = this.hub.missions.createMission(
      {
        title,
        brief,
        acceptance: acceptance ?? [],
        lead_agent: id.agent.agent_id,
        parent_mission: id.session.mission,
        source: 'chat',
      },
      id,
    )
    const leadSession = this.hub.missions.createLeadSession(mission.mission_id, {
      spawned_by: id.session.session_id,
    })
    let spawned: string | null = null
    let note = 'lead 会话已拉起，它会拆卡并派活；你可以结束这一轮了'
    if (id.agent.kind === 'builtin') {
      note = 'lead 是内置实体（人类），不会自动开会话；用 `mesh mission lead <id>` 手工驱动'
    } else {
      const record = new Scheduler(this.hub).spawnLeadTurn(
        this.hub.store.requireMission(mission.mission_id),
        'planning',
        leadSession,
      )
      spawned = record.session_id
    }
    return ok({
      mission_id: mission.mission_id,
      title: mission.title,
      lead_agent: mission.lead_agent,
      lead_session: leadSession.session_id,
      spawned_session: spawned,
      status: this.hub.store.requireMission(mission.mission_id).status,
      source: 'chat',
      note,
    })
  }

  get_mission(sessionId: string, missionId: string): ApiResult {
    this.identity(sessionId)
    const view = this.hub.missions.getView(missionId)
    return ok({
      ...view.mission,
      task_summaries: view.tasks,
      progress: view.progress,
      lead_session_live: view.lead_session_live,
    })
  }

  plan_mission(sessionId: string, missionId: string, tasks: unknown): ApiResult {
    const id = this.hub.identity.requireLead(sessionId, missionId)
    const items = Array.isArray(tasks) ? (tasks as never[]) : []
    const result = this.hub.missions.planMission(id.session.session_id, missionId, items)
    return ok({
      mission_id: missionId,
      status: result.mission.status,
      tasks: result.created.map((t) => ({ task_id: t.task_id, title: t.title, role: t.role, scope_write: t.scope.write })),
      next: '`dispatch_mission` 让调度器开始派活',
    })
  }

  dispatch_mission(sessionId: string, missionId: string): ApiResult {
    const id = this.hub.identity.requireLead(sessionId, missionId)
    const mission = this.hub.missions.dispatchMission(id.session.session_id, missionId)
    return ok({ mission_id: missionId, status: mission.status, tasks: mission.tasks })
  }

  final_verdict(
    sessionId: string,
    missionId: string,
    approved: boolean,
    notes: string,
    rejects?: string[],
  ): ApiResult {
    const id = this.hub.identity.requireLead(sessionId, missionId)
    const result = this.hub.missions.finalVerdict(id.session.session_id, missionId, approved, notes, rejects)
    return ok({
      mission_id: missionId,
      status: result.mission.status,
      rounds: result.mission.rounds,
      rejected_tasks: result.rejected_tasks,
      replan: result.replan,
      next: approved ? '写报告：`write_report(mission_id, markdown)`' : '打回的卡会重新排队；或重拆（planning）',
    })
  }

  write_report(sessionId: string, missionId: string, markdown: string): ApiResult {
    const id = this.hub.identity.requireLead(sessionId, missionId)
    const result = this.hub.missions.writeReport(id.session.session_id, missionId, markdown)
    return ok({ mission_id: missionId, status: result.mission.status, report_path: result.path, note: 'mission 已完成' })
  }

  /**
   * Who else is on this mission (§3.1) — the structured version of the table that is
   * injected into every context package. Same source, so they cannot disagree.
   */
  list_teammates(sessionId: string, missionId?: string | null): ApiResult {
    const id = this.identity(sessionId)
    const mission = missionId ?? id.session.mission
    if (!mission) {
      throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'no mission given, and this session is not bound to one', {
        session_id: id.session.session_id,
        hint: 'pass mission_id explicitly',
      })
    }
    const card = this.hub.store.requireMission(mission)
    const rows = buildTeammates(this.hub.store, mission)
    return ok({
      mission_id: card.mission_id,
      title: card.title,
      status: card.status,
      lead_agent: card.lead_agent,
      you: id.agent.agent_id,
      teammates: rows,
    })
  }

  // -- profiles / peer review (V2 §2) --------------------------------------

  /** Read an agent's profile (any hello'd session may look). */
  get_profile(sessionId: string, agentId: string): ApiResult {
    this.identity(sessionId)
    const agent = this.hub.store.requireAgent(agentId)
    const profile = this.hub.profiles.view(agentId)
    return ok({
      ...profile,
      dimensions: this.hub.profiles.dimensionValues(agentId),
      success_rate: this.hub.profiles.successRate(agentId),
      enabled: agent.enabled,
    })
  }

  /**
   * Rate a teammate. The boundaries in §2.4 are enforced by ProfileService: same
   * mission only, never yourself, one review per (rater, target, mission), and every
   * score 0-100.
   */
  rate_peer(
    sessionId: string,
    agentId: string,
    missionId: string,
    scores: Partial<PeerScore>,
    comment?: string,
    taskId?: string,
  ): ApiResult {
    const id = this.identity(sessionId)
    const result = this.hub.profiles.ratePeer({
      by_agent: id.agent.agent_id,
      agent_id: agentId,
      mission_id: missionId,
      task_id: taskId ?? id.session.task,
      scores,
      comment: comment ?? '',
    })
    return ok({
      agent_id: agentId,
      by_agent: id.agent.agent_id,
      mission_id: missionId,
      quality_before: result.quality_before,
      quality_after: result.quality_after,
      applied: result.applied,
      overwritten: result.overwritten,
      manual_locked: result.profile.manual_locked,
      note:
        result.overwritten
          ? '同一 mission 的互评已覆盖更新（不会叠加刷分）'
          : result.applied
            ? '已按加权移动平均更新 quality_score'
            : '该 profile 已被人工锁定，只记录互评、不改分数',
    })
  }

  // -- messages ------------------------------------------------------------

  send(
    sessionId: string,
    to: { role: RoleId; thread: string },
    type: MessageType,
    body: string,
    ttlSeconds?: number,
  ): ApiResult {
    const id = this.identity(sessionId)
    const msg = this.hub.bus.send(id, { to, type, body, ttl_seconds: ttlSeconds })
    return ok({ msg_id: msg.msg_id, delivered_to: msg.resolved })
  }

  read_messages(sessionId: string, since?: string): ApiResult {
    const id = this.identity(sessionId)
    const messages = this.hub.bus.read(id.agent.agent_id, id.session.session_id, { since })
    return ok({
      count: messages.length,
      messages: messages.map((m: Message) => ({
        msg_id: m.msg_id,
        from: `${m.from.agent}/${m.from.role}`,
        type: m.type,
        thread: m.thread,
        body: m.body,
        created_at: m.created_at,
        attachments: m.attachments.map((a) => ({
          path: a.path,
          bytes: a.bytes,
          sha256: a.sha256,
          inline: a.inline,
          text: a.inline ? a.text : undefined,
        })),
      })),
    })
  }

  async wait_messages(sessionId: string, timeoutMs = 20_000, since?: string): Promise<ApiResult> {
    const id = this.identity(sessionId)
    const messages = await this.hub.bus.wait(id.agent.agent_id, id.session.session_id, timeoutMs, since)
    if (messages.length === 0) return ok({ count: 0, messages: [], timed_out: true })
    return ok({ count: messages.length, messages: messages.map((m) => ({ msg_id: m.msg_id, type: m.type, body: m.body, from: m.from.agent })) })
  }

  // -- artifacts -----------------------------------------------------------

  put_artifact(sessionId: string, relpath: string, content: string, taskId?: string): ApiResult {
    const id = this.identity(sessionId)
    const rel = normRel(relpath)
    const result = this.hub.board.putArtifact(id, rel, content, { taskId: taskId ?? null })
    return ok({ ...result, note: '已入库（通道 C：非代码工件）' })
  }

  get_artifact(sessionId: string, relpath: string): ApiResult {
    this.identity(sessionId)
    const rel = normRel(relpath)
    const content = this.hub.store.readArtifact(rel)
    if (content === null) {
      throw new MeshError(MESH_ERRORS.UNKNOWN_ENTITY, `artifact not found: ${rel}`, { path: rel })
    }
    return ok({ path: rel, content })
  }

  list_artifacts(sessionId: string): ApiResult {
    this.identity(sessionId)
    return ok({ artifacts: this.hub.store.listArtifacts() })
  }

  /** Read a file from the main workspace (cross-task reference, read-only). */
  get_file(sessionId: string, relpath: string): ApiResult {
    const id = this.identity(sessionId)
    const rel = normRel(relpath)
    const abs = this.hub.resolveInside(rel)
    let content: string
    try {
      content = fs.readFileSync(abs, 'utf8')
    } catch {
      throw new MeshError(MESH_ERRORS.UNKNOWN_ENTITY, `file not found: ${rel}`, { path: rel })
    }
    const card = getRoleCard(id.session.role)
    const note = matchAnyGlob(['.mesh/**'], rel) || card.can_write_code ? undefined : 'read-only channel'
    return ok({ path: rel, content, note })
  }
}
