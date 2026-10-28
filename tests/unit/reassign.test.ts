import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Scheduler } from '../../hub/scheduler/scheduler.ts'
import { addAgent, commitInWorktree, createHarness, createReadyTask, newSession } from '../helpers.ts'
import type { Harness } from '../helpers.ts'
import type { RoleId } from '../../hub/core/types.ts'

const NOOP = { command: process.execPath, args: ['-e', '0'] }

function harness(name: string): Harness {
  return createHarness(name)
}

/**
 * One full work round on a card: claim → commit → submit → verdict.
 * Returns after the verdict; the caller decides what happens next.
 */
function round(h: Harness, taskId: string, agentId: string, role: RoleId, verdict: 'approved' | 'rejected', note = ''): void {
  const dev = newSession(h.hub, agentId, role)
  h.hub.board.claimTask(dev.session_id, taskId)
  const task = h.hub.store.requireTask(taskId)
  const file = task.scope.write[0]!.replace('**', 'index.ts').replace(/\/$/, '.ts')
  commitInWorktree(h, task, { [file]: `// ${taskId} by ${agentId} at ${new Date().toISOString()}\n` })
  h.hub.board.submitTask(h.hub.identity.requireIdentity(dev.session_id), taskId, `did ${taskId}`)
  const sup = newSession(h.hub, 'sup', 'supervisor')
  h.hub.board.recordVerdict(h.hub.identity.requireIdentity(sup.session_id), taskId, verdict, [], note || verdict)
}

// ---------------------------------------------------------------------------
// §2.3 counters on the card
// ---------------------------------------------------------------------------

test('reassign: every rejected verdict increments rejection_count and remembers who', () => {
  const h = harness('reassign-count')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'], NOOP)
    addAgent(h.hub, 'sup', ['supervisor'], NOOP)
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })

    assert.equal(task.rejection_count, 0)
    assert.deepEqual(task.rejected_by, [])

    round(h, task.task_id, 'dev', 'backend_dev', 'rejected', 'first miss')
    let card = h.hub.store.requireTask(task.task_id)
    assert.equal(card.rejection_count, 1)
    assert.deepEqual(card.rejected_by, ['dev'])

    round(h, task.task_id, 'dev', 'backend_dev', 'rejected', 'second miss')
    card = h.hub.store.requireTask(task.task_id)
    assert.equal(card.rejection_count, 2)
    assert.deepEqual(card.rejected_by, ['dev'], 'the same agent is not listed twice')

    round(h, task.task_id, 'dev', 'backend_dev', 'approved', 'finally')
    card = h.hub.store.requireTask(task.task_id)
    assert.equal(card.rejection_count, 2, 'an approval does not reset history')
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// §2.3 the decision
// ---------------------------------------------------------------------------

test('reassign: below the threshold the same agent is still allowed', () => {
  const h = harness('reassign-below')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'], NOOP)
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    // one rejection: 1 < 2 (default reassign_after_rejections)
    h.hub.store.saveTask({ ...task, rejection_count: 1, implementer_agent: 'dev', rejected_by: ['dev'] })
    const decision = new Scheduler(h.hub).selectAgent('backend_dev', h.hub.store.requireTask(task.task_id))
    assert.equal(decision.agent?.agent_id, 'dev')
    assert.deepEqual(decision.excluded, [])
    assert.equal(decision.blocked, null)
  } finally {
    h.cleanup()
  }
})

test('reassign: at the threshold the previous implementer is excluded and the best remaining wins', () => {
  const h = harness('reassign-threshold')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'], NOOP)
    addAgent(h.hub, 'better', ['backend_dev'], NOOP)
    addAgent(h.hub, 'worse', ['backend_dev'], NOOP)
    h.hub.profiles.set('better', 'quality_score', '90')
    h.hub.profiles.set('worse', 'quality_score', '70')

    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    // Model the state after two rejections of 'dev'
    h.hub.store.saveTask({ ...task, rejection_count: 2, implementer_agent: 'dev', rejected_by: ['dev'] })

    const scheduler = new Scheduler(h.hub)
    const decision = scheduler.selectAgent('backend_dev', h.hub.store.requireTask(task.task_id))
    assert.deepEqual(decision.excluded, ['dev'])
    assert.equal(decision.agent?.agent_id, 'better', 'highest score among the remaining candidates')
    assert.ok(!decision.scored.some((s) => s.agent_id === 'dev'), 'the rejectee is not even scored')
    assert.equal(decision.blocked, null)
  } finally {
    h.cleanup()
  }
})

test('reassign: every historical implementer is excluded, not just the last one', () => {
  const h = harness('reassign-history')
  try {
    addAgent(h.hub, 'dev1', ['backend_dev'], NOOP)
    addAgent(h.hub, 'dev2', ['backend_dev'], NOOP)
    addAgent(h.hub, 'fresh', ['backend_dev'], NOOP)
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    h.hub.store.saveTask({
      ...task,
      rejection_count: 2,
      implementer_agent: 'dev2',
      rejected_by: ['dev1', 'dev2'],
    })
    const decision = new Scheduler(h.hub).selectAgent('backend_dev', h.hub.store.requireTask(task.task_id))
    assert.deepEqual(decision.excluded, ['dev1', 'dev2'])
    assert.equal(decision.agent?.agent_id, 'fresh')
  } finally {
    h.cleanup()
  }
})

test('reassign: no candidate left means blocked with the spec reason — never the same agent', () => {
  const h = harness('reassign-blocked')
  try {
    addAgent(h.hub, 'only', ['backend_dev'], NOOP)
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    h.hub.store.saveTask({ ...task, rejection_count: 2, implementer_agent: 'only', rejected_by: ['only'] })

    const decision = new Scheduler(h.hub).selectAgent('backend_dev', h.hub.store.requireTask(task.task_id))
    assert.equal(decision.agent, null)
    assert.equal(decision.blocked, '需要更强或更多的 agent')
    assert.deepEqual(decision.excluded, ['only'])
  } finally {
    h.cleanup()
  }
})

test('reassign: the lead cannot smuggle the rejectee back in through preferred_agent', () => {
  const h = harness('reassign-preferred')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'], NOOP)
    addAgent(h.hub, 'other', ['backend_dev'], NOOP)
    h.hub.profiles.set('dev', 'quality_score', '99') // still the best agent…
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    h.hub.store.saveTask({
      ...task,
      rejection_count: 2,
      implementer_agent: 'dev',
      rejected_by: ['dev'],
      preferred_agent: 'dev', // …and the lead explicitly asks for it
    })
    const decision = new Scheduler(h.hub).selectAgent('backend_dev', h.hub.store.requireTask(task.task_id))
    assert.equal(decision.agent?.agent_id, 'other', 'preferred_agent never overrides the exclusion list')
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// §2.3 through the scheduler
// ---------------------------------------------------------------------------

test('reassign: the scheduler requeues a twice-rejected card and dispatches it to somebody else', async () => {
  const h = harness('reassign-scheduler')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'], NOOP)
    addAgent(h.hub, 'sup', ['supervisor'], NOOP)
    addAgent(h.hub, 'other', ['backend_dev'], NOOP)
    h.hub.profiles.set('other', 'quality_score', '80')

    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    round(h, task.task_id, 'dev', 'backend_dev', 'rejected', 'miss one')
    round(h, task.task_id, 'dev', 'backend_dev', 'rejected', 'miss two')
    assert.equal(h.hub.store.requireTask(task.task_id).status, 'rejected')

    const scheduler = new Scheduler(h.hub)
    const report = await scheduler.tick()
    // The card went back to the board and was picked up by the other agent
    const dispatched = report.dispatched.find((d) => d.task_id === task.task_id)
    assert.ok(dispatched, `expected a dispatch, got ${JSON.stringify(report.skipped)}`)
    assert.equal(dispatched!.agent_id, 'other')
    const card = h.hub.store.requireTask(task.task_id)
    assert.equal(card.implementer_agent, 'other')
    assert.equal(card.status, 'claimed')
  } finally {
    h.cleanup()
  }
})

test('reassign: with nobody left the scheduler blocks the card and says why', async () => {
  const h = harness('reassign-scheduler-blocked')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'], NOOP)
    addAgent(h.hub, 'sup', ['supervisor'], NOOP)
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    round(h, task.task_id, 'dev', 'backend_dev', 'rejected', 'miss one')
    round(h, task.task_id, 'dev', 'backend_dev', 'rejected', 'miss two')

    const report = await new Scheduler(h.hub).tick()
    assert.equal(report.blocked.length, 1)
    assert.equal(report.blocked[0]!.reason, '需要更强或更多的 agent')
    const card = h.hub.store.requireTask(task.task_id)
    assert.equal(card.status, 'blocked')
    assert.equal(card.blocked_reason, '需要更强或更多的 agent')
    assert.equal(report.dispatched.length, 0, 'it must not fall back to the same person')
  } finally {
    h.cleanup()
  }
})
