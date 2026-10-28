import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MISSION_TRANSITIONS, applyMissionTransition, canMissionTransition } from '../../hub/core/stateMachine.ts'
import { MeshError } from '../../hub/core/errors.ts'
import { Scheduler } from '../../hub/scheduler/scheduler.ts'
import { addAgent, commitInWorktree, createHarness, newSession, worktreeOf } from '../helpers.ts'
import type { Harness } from '../helpers.ts'
import type { MissionStatus, RoleId } from '../../hub/core/types.ts'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A harness where `dev` implements, `sup` reviews, and `mesh-human` leads by hand. */
function missionHarness(name: string): Harness {
  const h = createHarness(name)
  addAgent(h.hub, 'dev', ['backend_dev', 'frontend_dev', 'executor'])
  addAgent(h.hub, 'sup', ['supervisor'])
  addAgent(h.hub, 'mesh-human', ['planner', 'lead'], { kind: 'builtin', command: '', transport: 'in-process', mcp_inject: 'none' })
  return h
}

/** The human operator acting as mission lead: open the lead session and hello it. */
function leadSession(h: Harness, missionId: string): string {
  const session = h.hub.missions.createLeadSession(missionId, { spawned_by: 'test' })
  h.hub.identity.hello(session.session_id)
  return session.session_id
}

function createMission(h: Harness, title = '做一个带登录的博客'): string {
  const mission = h.hub.missions.createMission({ title, brief: `${title}（用户原话）`, acceptance: ['能登录'], lead_agent: 'mesh-human' })
  return mission.mission_id
}

const PLAN = [
  { title: '登录接口', role: 'backend_dev' as RoleId, scope: { write: ['src/auth.ts'] }, acceptance: ['返回 200'] },
  { title: '登录页', role: 'frontend_dev' as RoleId, scope: { write: ['src/login.tsx'] }, acceptance: ['表单可用'] },
  { title: '端到端测试', role: 'executor' as RoleId, scope: { write: ['test/e2e.ts'] }, acceptance: ['测试通过'] },
]

function planAndDispatch(h: Harness, missionId: string): { lead: string; tasks: string[] } {
  const lead = leadSession(h, missionId)
  const planned = h.hub.missions.planMission(lead, missionId, PLAN)
  h.hub.missions.dispatchMission(lead, missionId)
  return { lead, tasks: planned.created.map((t) => t.task_id) }
}

let fileCounter = 0

/** Drive one card all the way to merged, as a worker + an independent reviewer would. */
function mergeCard(h: Harness, taskId: string, role: RoleId): void {
  const task = h.hub.store.requireTask(taskId)
  const dev = newSession(h.hub, 'dev', role)
  h.hub.board.claimTask(dev.session_id, taskId)
  const file = task.scope.write[0]!.replace('**', 'index.ts').replace(/\/$/, '.ts')
  // Content must differ on every attempt, or a rework commit would be empty and the
  // merge would legitimately have nothing to apply.
  fileCounter += 1
  commitInWorktree(h, task, { [file]: `// ${taskId} rev ${fileCounter}\nexport const x = 1\n` })
  h.hub.board.submitTask(h.hub.identity.requireIdentity(dev.session_id), taskId, `did ${taskId}`)
  const sup = newSession(h.hub, 'sup', 'supervisor')
  h.hub.board.recordVerdict(h.hub.identity.requireIdentity(sup.session_id), taskId, 'approved', [], 'ok')
  h.hub.board.mergeTask(taskId, { auto: true })
}

// ---------------------------------------------------------------------------
// state machine
// ---------------------------------------------------------------------------

test('mission state machine: the spec edges exist, everything else is refused', () => {
  assert.ok(canMissionTransition('intake', 'planning'))
  assert.ok(canMissionTransition('planning', 'executing'))
  assert.ok(canMissionTransition('executing', 'integrating'))
  assert.ok(canMissionTransition('integrating', 'final_review'))
  assert.ok(canMissionTransition('final_review', 'completed'))
  assert.ok(canMissionTransition('final_review', 'rejected'))
  assert.ok(canMissionTransition('rejected', 'executing'))
  assert.ok(canMissionTransition('rejected', 'planning'))
  assert.ok(canMissionTransition('integrating', 'planning'), 'replan')
  // Illegal: no skipping, no resurrecting
  assert.equal(canMissionTransition('intake', 'executing'), false)
  assert.equal(canMissionTransition('planning', 'integrating'), false)
  assert.equal(canMissionTransition('completed', 'executing'), false)
  assert.equal(canMissionTransition('cancelled', 'planning'), false)
  for (const status of Object.keys(MISSION_TRANSITIONS) as MissionStatus[]) {
    assert.ok(Array.isArray(MISSION_TRANSITIONS[status]))
  }
  // applyMissionTransition records history and refuses illegal edges
  const card = {
    mission_id: 'M-000001',
    status: 'intake',
    updated_at: '2026-01-01T00:00:00.000Z',
    history: [],
  } as never
  applyMissionTransition(card, 'planning', { by: 'S-000001', note: 'go' })
  assert.equal((card as { status: string }).status, 'planning')
  assert.equal((card as { history: unknown[] }).history.length, 1)
  assert.throws(
    () => applyMissionTransition(card, 'completed', { by: 'S-000001' }),
    (e: { code?: string }) => e.code === 'MESH_TRANSITION_ILLEGAL',
  )
})

// ---------------------------------------------------------------------------
// creation / lead rights
// ---------------------------------------------------------------------------

test('mission: creation binds a lead, records the brief verbatim, and starts in intake', () => {
  const h = missionHarness('mission-create')
  try {
    const mission = h.hub.missions.createMission({
      title: '做一个带登录的博客',
      brief: '用户原话：做一个带登录的博客，别搞太复杂',
      acceptance: ['登录可用'],
      lead_agent: 'mesh-human',
    })
    assert.match(mission.mission_id, /^M-\d{6}$/)
    assert.equal(mission.status, 'intake')
    assert.equal(mission.lead_agent, 'mesh-human')
    assert.equal(mission.rounds, 0)
    assert.equal(mission.report, null)
    assert.deepEqual(mission.tasks, [])
    assert.deepEqual(mission.teammates, ['mesh-human'])
    assert.equal(mission.brief, '用户原话：做一个带登录的博客，别搞太复杂', 'brief must be verbatim')
    assert.equal(mission.history[0]!.to, 'intake')
    // persisted as its own file
    assert.ok(fs.existsSync(h.hub.paths.missionFile(mission.mission_id)))
  } finally {
    h.cleanup()
  }
})

test('mission: lead rights are scoped to one mission (is_lead + mission, then role)', () => {
  const h = missionHarness('mission-lead-rights')
  try {
    const m1 = createMission(h, 'mission one')
    const m2 = createMission(h, 'mission two')
    const lead1 = leadSession(h, m1)

    // The right session passes
    const identity = h.hub.identity.requireLead(lead1, m1)
    assert.equal(identity.session.is_lead, true)

    // Wrong mission: same session, different mission id
    assert.throws(
      () => h.hub.identity.requireLead(lead1, m2),
      (e: { code?: string }) => e.code === 'MESH_NOT_LEAD',
    )
    // Non-lead session
    const dev = newSession(h.hub, 'dev', 'backend_dev')
    assert.throws(
      () => h.hub.identity.requireLead(dev.session_id, m1),
      (e: { code?: string }) => e.code === 'MESH_NOT_LEAD',
    )
    // Lead of a *former* turn is no longer the lead once someone else took over
    const lead2 = leadSession(h, m1)
    assert.throws(
      () => h.hub.identity.requireLead(lead1, m1),
      (e: { code?: string }) => e.code === 'MESH_NOT_LEAD',
    )
    assert.equal(h.hub.identity.requireLead(lead2, m1).session.session_id, lead2)
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

test('mission: plan_mission writes all cards atomically and serializes unspecified dependencies', () => {
  const h = missionHarness('mission-plan')
  try {
    const missionId = createMission(h)
    const lead = leadSession(h, missionId)
    const result = h.hub.missions.planMission(lead, missionId, PLAN)

    assert.equal(result.created.length, 3)
    assert.equal(result.mission.status, 'planning')
    assert.deepEqual(result.mission.tasks, result.created.map((t) => t.task_id))
    assert.equal(result.mission.plan.length, 3)
    assert.equal(result.mission.plan[1]!.role, 'frontend_dev')
    // Cards are unpublished until dispatch (a human can look at the plan first)
    for (const task of result.created) assert.equal(task.status, 'draft')
    // Array order becomes a serial chain when depends_on is omitted
    assert.deepEqual(result.created[0]!.depends_on, [])
    assert.deepEqual(result.created[1]!.depends_on, [result.created[0]!.task_id])
    assert.deepEqual(result.created[2]!.depends_on, [result.created[1]!.task_id])
    // The mission's plan is the human-readable record
    assert.deepEqual(h.hub.store.requireMission(missionId).plan.map((p) => p.task_id), result.created.map((t) => t.task_id))
  } finally {
    h.cleanup()
  }
})

test('mission: plan_mission is atomic — one bad item leaves no cards behind', () => {
  const h = missionHarness('mission-plan-atomic')
  try {
    const missionId = createMission(h)
    const lead = leadSession(h, missionId)
    const bad = [
      PLAN[0]!,
      PLAN[1]!,
      // granularity violation: 8 acceptance criteria
      { ...PLAN[2]!, acceptance: ['1', '2', '3', '4', '5', '6', '7', '8'] },
    ]
    const before = h.hub.store.listTasks().length
    assert.throws(
      () => h.hub.missions.planMission(lead, missionId, bad as never),
      (e: { code?: string }) => e.code === 'MESH_GRANULARITY',
    )
    assert.equal(h.hub.store.listTasks().length, before, 'no half-written plan may survive')
    const mission = h.hub.store.requireMission(missionId)
    assert.equal(mission.status, 'intake', 'a failed plan must not move the mission forward')
    assert.deepEqual(mission.tasks, [])
  } finally {
    h.cleanup()
  }
})

test('mission: only the lead may plan or dispatch', () => {
  const h = missionHarness('mission-plan-perm')
  try {
    const missionId = createMission(h)
    const dev = newSession(h.hub, 'dev', 'backend_dev')
    assert.throws(
      () => h.hub.missions.planMission(dev.session_id, missionId, PLAN),
      (e: { code?: string }) => e.code === 'MESH_NOT_LEAD',
    )
    const lead = leadSession(h, missionId)
    h.hub.missions.planMission(lead, missionId, PLAN)
    assert.throws(
      () => h.hub.missions.dispatchMission(dev.session_id, missionId),
      (e: { code?: string }) => e.code === 'MESH_NOT_LEAD',
    )
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// dispatch + auto advance
// ---------------------------------------------------------------------------

test('mission: dispatch publishes what can run now, and dependencies stay waiting', () => {
  const h = missionHarness('mission-dispatch')
  try {
    const missionId = createMission(h)
    const { lead, tasks } = planAndDispatch(h, missionId)
    assert.equal(h.hub.store.requireMission(missionId).status, 'executing')
    // The plan is a serial chain (depends_on omitted → array order), so dispatching
    // makes card 1 runnable and leaves 2/3 waiting on their dependency.
    assert.equal(h.hub.store.requireTask(tasks[0]!).status, 'ready')
    assert.equal(h.hub.store.requireTask(tasks[1]!).status, 'draft')
    assert.match(String(h.hub.store.requireTask(tasks[1]!).blocked_reason), /waiting on/)
    // Nothing left to auto-advance yet
    assert.deepEqual(h.hub.missions.advanceMissions(), [])
    void lead
  } finally {
    h.cleanup()
  }
})

test('mission: all cards settled advances executing → integrating → final_review → completed', () => {
  const h = missionHarness('mission-advance')
  try {
    const missionId = createMission(h)
    const { lead, tasks } = planAndDispatch(h, missionId)
    mergeCard(h, tasks[0]!, 'backend_dev')
    mergeCard(h, tasks[1]!, 'frontend_dev')
    assert.equal(h.hub.store.requireMission(missionId).status, 'executing', 'not settled yet')

    mergeCard(h, tasks[2]!, 'executor')
    const advanced = h.hub.missions.advanceMissions()
    assert.deepEqual(
      advanced.map((a) => `${a.from}->${a.to}`),
      ['executing->integrating'],
    )
    // The lead session for the integrating phase is a *new* lead turn
    const lead2 = leadSession(h, missionId)
    const verdict = h.hub.missions.finalVerdict(lead2, missionId, true, '整体满足用户要求')
    assert.equal(verdict.mission.status, 'final_review')
    const report = h.hub.missions.writeReport(lead2, missionId, '# 交付报告\n\n三张卡都合并了。')
    assert.equal(report.mission.status, 'completed')
    assert.match(report.mission.report ?? '', /交付报告/)
    assert.ok(report.mission.report_at)
    assert.ok(fs.existsSync(path.resolve(h.dir, report.path)), 'report.md must be on disk')
    assert.deepEqual(h.hub.missions.advanceMissions(), [], 'completed missions do not advance')
    void lead
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// second acceptance: rejection + rework loop
// ---------------------------------------------------------------------------

test('mission: a rejected second acceptance sends the named card back and the rework re-merges', () => {
  const h = missionHarness('mission-reject')
  try {
    const missionId = createMission(h)
    const { tasks } = planAndDispatch(h, missionId)
    for (let i = 0; i < tasks.length; i++) {
      mergeCard(h, tasks[i]!, (['backend_dev', 'frontend_dev', 'executor'] as RoleId[])[i]!)
    }
    h.hub.missions.advanceMissions()
    const lead = leadSession(h, missionId)

    const verdict = h.hub.missions.finalVerdict(lead, missionId, false, '文章列表样式不对', [tasks[1]!])
    assert.equal(verdict.mission.status, 'rejected')
    assert.equal(verdict.mission.rounds, 1)
    assert.deepEqual(verdict.rejected_tasks, [tasks[1]!])
    assert.equal(h.hub.store.requireTask(tasks[1]!).status, 'rejected')

    // The rework loop: rejected → executing, and the card goes back on the board
    const advanced = h.hub.missions.advanceMissions()
    assert.deepEqual(advanced.map((a) => `${a.from}->${a.to}`), ['rejected->executing'])
    assert.equal(h.hub.store.requireTask(tasks[1]!).status, 'ready')
    assert.equal(h.hub.store.requireTask(tasks[1]!).claimed_by, null)

    // Rework and merge again — then the mission can settle a second time
    mergeCard(h, tasks[1]!, 'frontend_dev')
    const again = h.hub.missions.advanceMissions()
    assert.deepEqual(again.map((a) => `${a.from}->${a.to}`), ['executing->integrating'])
    const lead2 = leadSession(h, missionId)
    assert.equal(h.hub.missions.finalVerdict(lead2, missionId, true, '这版对了').mission.status, 'final_review')
    assert.equal(h.hub.missions.writeReport(lead2, missionId, '# 报告 v2').mission.status, 'completed')
  } finally {
    h.cleanup()
  }
})

test('mission: a targeted rework survives the scheduler requeueing the card first', () => {
  const h = missionHarness('mission-rework-vs-replan')
  try {
    const missionId = createMission(h)
    const { tasks } = planAndDispatch(h, missionId)
    for (let i = 0; i < tasks.length; i++) {
      mergeCard(h, tasks[i]!, (['backend_dev', 'frontend_dev', 'executor'] as RoleId[])[i]!)
    }
    h.hub.missions.advanceMissions()
    const lead = leadSession(h, missionId)

    const verdict = h.hub.missions.finalVerdict(lead, missionId, false, '测试没覆盖失败路径', [tasks[2]!])
    assert.deepEqual(verdict.mission.rejected_tasks, [tasks[2]!], 'the named card must be remembered')
    assert.equal(verdict.mission.status, 'rejected')

    // The scheduler's own retry loop (M2) may requeue rejected cards on the very next
    // tick — before the mission-level decision runs. That must not turn a targeted
    // rework into a full replan.
    h.hub.board.requeueRejectedTask(tasks[2]!, 'reviewer rejection retry')
    assert.equal(h.hub.store.requireTask(tasks[2]!).status, 'ready')

    const advanced = h.hub.missions.advanceMissions()
    assert.deepEqual(advanced.map((a) => `${a.from}->${a.to}`), ['rejected->executing'])
    assert.deepEqual(h.hub.store.requireMission(missionId).rejected_tasks, [], 'leaving rejected clears the list')
  } finally {
    h.cleanup()
  }
})

test('mission: rejecting without naming a card means the breakdown was wrong → planning', () => {
  const h = missionHarness('mission-replan')
  try {
    const missionId = createMission(h)
    const { tasks } = planAndDispatch(h, missionId)
    for (let i = 0; i < tasks.length; i++) {
      mergeCard(h, tasks[i]!, (['backend_dev', 'frontend_dev', 'executor'] as RoleId[])[i]!)
    }
    h.hub.missions.advanceMissions()
    const lead = leadSession(h, missionId)
    const verdict = h.hub.missions.finalVerdict(lead, missionId, false, '拆得不全，整件事重来')
    assert.equal(verdict.replan, true)
    const advanced = h.hub.missions.advanceMissions()
    assert.deepEqual(advanced.map((a) => `${a.from}->${a.to}`), ['rejected->planning'])
    // A replanned mission can accept more cards and move to planning again
    const lead2 = leadSession(h, missionId)
    const more = h.hub.missions.planMission(lead2, missionId, [
      { title: '补一张', role: 'backend_dev', scope: { write: ['src/more.ts'] }, acceptance: ['补上'] },
    ])
    assert.equal(more.mission.status, 'planning')
    assert.equal(more.mission.tasks.length, 4)
  } finally {
    h.cleanup()
  }
})

test('mission: rejection targets must be real, merged cards of this mission', () => {
  const h = missionHarness('mission-reject-targets')
  try {
    const missionId = createMission(h)
    const { tasks } = planAndDispatch(h, missionId)
    for (let i = 0; i < tasks.length; i++) {
      mergeCard(h, tasks[i]!, (['backend_dev', 'frontend_dev', 'executor'] as RoleId[])[i]!)
    }
    h.hub.missions.advanceMissions()
    const lead = leadSession(h, missionId)

    // A card that belongs to no mission
    const other = h.hub.board.createTask({ title: 'unrelated', role: 'backend_dev', scope: { write: ['src/o.ts'] }, acceptance: ['o'] })
    assert.throws(
      () => h.hub.missions.finalVerdict(lead, missionId, false, 'x', [other.task_id]),
      (e: { code?: string }) => e.code === 'MESH_MISSION_STATE',
    )
    // A card id that does not exist at all
    assert.throws(
      () => h.hub.missions.finalVerdict(lead, missionId, false, 'x', ['T-999999']),
      (e: { code?: string }) => e.code === 'MESH_UNKNOWN_ENTITY',
    )
    // Nothing was mutated by the failed calls
    const mission = h.hub.store.requireMission(missionId)
    assert.equal(mission.status, 'integrating')
    assert.equal(mission.rounds, 0)
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// C1 must survive the rework loop
// ---------------------------------------------------------------------------

test('mission: rework needs a fresh review — the old approval cannot authorise the new commit', () => {
  const h = missionHarness('mission-c1')
  try {
    const missionId = createMission(h)
    const { tasks } = planAndDispatch(h, missionId)
    const [first] = tasks as [string]
    mergeCard(h, first, 'backend_dev')
    const afterFirst = h.hub.store.requireTask(first)
    const firstCommit = afterFirst.submission!.commit

    // Send it back, rework it, resubmit with a *new* commit
    h.hub.board.rejectMergedTask(first, 'test', 'second acceptance rejected it')
    h.hub.board.requeueRejectedTask(first, 'rework')
    const dev = newSession(h.hub, 'dev', 'backend_dev')
    h.hub.board.claimTask(dev.session_id, first)
    const task = h.hub.store.requireTask(first)
    commitInWorktree(h, task, { [task.scope.write[0]!.replace('**', 'index.ts').replace(/\/$/, '.ts')]: '// fixed\n' })
    h.hub.board.submitTask(h.hub.identity.requireIdentity(dev.session_id), first, 'fixed after rejection')
    const newCommit = h.hub.store.requireTask(first).submission!.commit
    assert.notEqual(newCommit, firstCommit)

    // The old approval is for the old commit: merging now must be refused.
    assert.equal(h.hub.board.approvedReview(h.hub.store.requireTask(first)), null)
    assert.throws(
      () => h.hub.board.mergeTask(first, { auto: true }),
      (e: { code?: string }) => e.code === 'MESH_REVIEW_MISSING',
    )
    // With a fresh review it merges normally
    const sup = newSession(h.hub, 'sup', 'supervisor')
    h.hub.board.recordVerdict(h.hub.identity.requireIdentity(sup.session_id), first, 'approved', [], 'reviewed the fix')
    const merged = h.hub.board.mergeTask(first, { auto: true })
    assert.equal(merged.task.status, 'merged')
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// role boundaries (C4 的延伸)
// ---------------------------------------------------------------------------

test('mission: the lead cannot implement or hand in code', () => {
  const h = missionHarness('mission-lead-nocode')
  try {
    const missionId = createMission(h)
    const lead = leadSession(h, missionId)
    const identity = h.hub.identity.requireLead(lead, missionId)
    assert.equal(identity.role.can_write_code, false)
    assert.equal(identity.role.can_implement, false)
    assert.equal(identity.role.can_review, true)
    assert.equal(identity.role.can_merge, true)

    assert.throws(
      () => h.hub.board.putArtifact(identity, 'src/sneaky.ts', 'export const x = 1\n'),
      (e: MeshError | { code?: string }) => (e as { code?: string }).code === 'MESH_ARTIFACT_DENIED',
    )
    const { tasks } = planAndDispatch(h, missionId)
    assert.throws(
      () => h.hub.board.submitTask(identity, tasks[0]!, 'lead writes code'),
      (e: { code?: string }) => e.code === 'MESH_ROLE_FORBIDDEN',
    )
    // …but a report artifact is fine (that is the lead's own output channel)
    const ok = h.hub.board.putArtifact(identity, 'reports/summary.md', '# summary\n')
    assert.equal(ok.path, 'reports/summary.md')
  } finally {
    h.cleanup()
  }
})

test('mission: the report is required before completion, and only after approval', () => {
  const h = missionHarness('mission-report-gate')
  try {
    const missionId = createMission(h)
    const { tasks } = planAndDispatch(h, missionId)
    for (let i = 0; i < tasks.length; i++) {
      mergeCard(h, tasks[i]!, (['backend_dev', 'frontend_dev', 'executor'] as RoleId[])[i]!)
    }
    h.hub.missions.advanceMissions()
    h.hub.missions.advanceMissions()
    const lead = leadSession(h, missionId)
    // Still integrating/final_review-less: writing the report early is refused
    assert.throws(
      () => h.hub.missions.writeReport(lead, missionId, '# premature'),
      (e: { code?: string }) => e.code === 'MESH_MISSION_STATE',
    )
    h.hub.missions.finalVerdict(lead, missionId, true, 'ok')
    assert.throws(
      () => h.hub.missions.writeReport(lead, missionId, '   '),
      (e: { code?: string }) => e.code === 'MESH_SCHEMA_INVALID',
    )
    const done = h.hub.missions.writeReport(lead, missionId, '# final\n\n搞定了。')
    assert.equal(done.mission.status, 'completed')
  } finally {
    h.cleanup()
  }
})

test('mission: teammates are recorded in participation order', () => {
  const h = missionHarness('mission-teammates')
  try {
    const missionId = createMission(h)
    assert.deepEqual(h.hub.store.requireMission(missionId).teammates, ['mesh-human'])
    h.hub.missions.noteParticipant(missionId, 'dev')
    h.hub.missions.noteParticipant(missionId, 'sup')
    h.hub.missions.noteParticipant(missionId, 'dev') // duplicate ignored
    assert.deepEqual(h.hub.store.requireMission(missionId).teammates, ['mesh-human', 'dev', 'sup'])
  } finally {
    h.cleanup()
  }
})

test('mission: a task knows which mission owns it, and preferred_agent is honoured when eligible', () => {
  const h = missionHarness('mission-preferred')
  try {
    addAgent(h.hub, 'dev2', ['backend_dev'])
    const missionId = createMission(h)
    const lead = leadSession(h, missionId)
    const planned = h.hub.missions.planMission(lead, missionId, [
      { title: '指定给 dev2', role: 'backend_dev', scope: { write: ['src/p.ts'] }, acceptance: ['p'], agent: 'dev2' },
    ])
    const taskId = planned.created[0]!.task_id
    assert.equal(h.hub.store.requireTask(taskId).preferred_agent, 'dev2')
    assert.equal(h.hub.missions.missionOfTask(taskId)?.mission_id, missionId)
    assert.equal(h.hub.missions.missionOfTask('T-999999'), null)

    h.hub.missions.dispatchMission(lead, missionId)
    // The lead's choice wins over the cheaper-first default when the agent is eligible.
    const picked = new Scheduler(h.hub).pickAgent('backend_dev', h.hub.store.requireTask(taskId))
    assert.equal(picked?.agent_id, 'dev2')
  } finally {
    h.cleanup()
  }
})

test('mission: a mission can be nested but stops at the configured depth', () => {
  const h = missionHarness('mission-nesting')
  try {
    const root = createMission(h, 'root')
    const child = h.hub.missions.createMission({ title: 'child', brief: 'child', lead_agent: 'mesh-human', parent_mission: root })
    assert.equal(child.parent_mission, root)
    const grandchild = h.hub.missions.createMission({ title: 'gc', brief: 'gc', lead_agent: 'mesh-human', parent_mission: child.mission_id })
    assert.equal(grandchild.parent_mission, child.mission_id)
    // default mission_max_depth = 3 → depth 3 is refused
    assert.throws(
      () =>
        h.hub.missions.createMission({
          title: 'ggc',
          brief: 'ggc',
          lead_agent: 'mesh-human',
          parent_mission: grandchild.mission_id,
        }),
      (e: { code?: string }) => e.code === 'MESH_MISSION_STATE',
    )
  } finally {
    h.cleanup()
  }
})

test('mission: worktree path helper matches where the card actually lives', () => {
  const h = missionHarness('mission-worktree')
  try {
    const missionId = createMission(h)
    const { tasks } = planAndDispatch(h, missionId)
    const dev = newSession(h.hub, 'dev', 'backend_dev')
    h.hub.board.claimTask(dev.session_id, tasks[0]!)
    const task = h.hub.store.requireTask(tasks[0]!)
    assert.equal(worktreeOf(h, task), path.resolve(h.dir, task.worktree!))
  } finally {
    h.cleanup()
  }
})
