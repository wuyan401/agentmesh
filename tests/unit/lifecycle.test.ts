import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { addAgent, commitInWorktree, createHarness, createReadyTask, newSession, worktreeOf } from '../helpers.ts'

test('lifecycle: claim → work → submit → independent review → merge', () => {
  const h = createHarness('lifecycle')
  try {
    addAgent(h.hub, 'dev-1', ['backend_dev'])
    addAgent(h.hub, 'rev-1', ['supervisor'])
    addAgent(h.hub, 'int-1', ['integrator'])
    const task = createReadyTask(h.hub, { write: ['src/thing.ts'], acceptance: ['file exists', 'exports x'] })

    const dev = newSession(h.hub, 'dev-1', 'backend_dev')
    h.hub.board.claimTask(dev.session_id, task.task_id)
    commitInWorktree(h, task, { 'src/thing.ts': 'export const x = 1\n' }, 'feat: add thing')
    const devIdentity = h.hub.identity.requireIdentity(dev.session_id)
    const submitted = h.hub.board.submitTask(devIdentity, task.task_id, 'adds src/thing.ts exporting x')
    assert.equal(submitted.task.status, 'submitted')
    assert.equal(submitted.task.submission?.files.length, 1)
    assert.equal(submitted.scope.ok, true)
    assert.equal(submitted.warnings.length, 0)

    const rev = newSession(h.hub, 'rev-1', 'supervisor')
    h.hub.board.requestReview(rev.session_id, task.task_id)
    const revIdentity = h.hub.identity.requireIdentity(rev.session_id)
    const verdict = h.hub.board.recordVerdict(revIdentity, task.task_id, 'approved', [
      { criterion: 'file exists', pass: true, evidence: 'src/thing.ts present in diff' },
      { criterion: 'exports x', pass: true, evidence: 'grep export const x' },
    ], 'looks correct')
    assert.equal(verdict.task.status, 'approved')
    assert.equal(verdict.review.independent, true)

    const intSession = newSession(h.hub, 'int-1', 'integrator')
    const intIdentity = h.hub.identity.requireIdentity(intSession.session_id)
    const merged = h.hub.board.mergeTask(task.task_id, { identity: intIdentity })
    assert.equal(merged.task.status, 'merged')
    assert.equal(merged.mode, 'strict')
    assert.deepEqual(merged.files, ['src/thing.ts'])

    // The file must now be on the main branch, and the platform must have recorded the merge.
    assert.ok(fs.existsSync(path.join(h.dir, 'src', 'thing.ts')))
    const merges = h.hub.store.merges()
    assert.equal(merges.length, 1)
    assert.equal((merges[0] as Record<string, unknown>)['mode'], 'strict')
    const digest = h.hub.audit.writeDigest()
    assert.match(digest, /Merges/)
  } finally {
    h.cleanup()
  }
})

test('lifecycle: C7 — an agent may not review its own implementation', () => {
  const h = createHarness('c7')
  try {
    // One agent holding both roles (allowed by the ternary model): SoD is what stops it.
    addAgent(h.hub, 'solo', ['backend_dev', 'supervisor'])
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    const dev = newSession(h.hub, 'solo', 'backend_dev')
    h.hub.board.claimTask(dev.session_id, task.task_id)
    commitInWorktree(h, task, { 'src/a.ts': 'export const a = 1\n' })
    h.hub.board.submitTask(h.hub.identity.requireIdentity(dev.session_id), task.task_id, 'a')

    const sup = newSession(h.hub, 'solo', 'supervisor')
    assert.throws(
      () => h.hub.board.requestReview(sup.session_id, task.task_id),
      (e: { code?: string }) => e.code === 'MESH_REVIEW_NOT_INDEPENDENT',
    )
    assert.throws(
      () =>
        h.hub.board.recordVerdict(h.hub.identity.requireIdentity(sup.session_id), task.task_id, 'approved', [], 'ok'),
      (e: { code?: string }) => e.code === 'MESH_REVIEW_NOT_INDEPENDENT',
    )
  } finally {
    h.cleanup()
  }
})

test('lifecycle: C1 — a task cannot be merged without an approved review', () => {
  const h = createHarness('c1')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'])
    addAgent(h.hub, 'int', ['integrator'])
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    const dev = newSession(h.hub, 'dev', 'backend_dev')
    h.hub.board.claimTask(dev.session_id, task.task_id)
    commitInWorktree(h, task, { 'src/a.ts': 'export const a = 1\n' })
    h.hub.board.submitTask(h.hub.identity.requireIdentity(dev.session_id), task.task_id, 'a')

    const intSession = newSession(h.hub, 'int', 'integrator')
    assert.throws(
      () => h.hub.board.mergeTask(task.task_id, { identity: h.hub.identity.requireIdentity(intSession.session_id) }),
      (e: { code?: string }) => e.code === 'MESH_REVIEW_MISSING' || e.code === 'MESH_TRANSITION_ILLEGAL',
    )
    // Auto-integration is not a bypass: it also requires the approved review.
    assert.throws(
      () => h.hub.board.mergeTask(task.task_id, { auto: true }),
      (e: { code?: string }) => e.code === 'MESH_REVIEW_MISSING',
    )
  } finally {
    h.cleanup()
  }
})

test('lifecycle: rejection sends the task back for rework and it can be resubmitted', () => {
  const h = createHarness('rework')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'])
    addAgent(h.hub, 'rev', ['supervisor'])
    const task = createReadyTask(h.hub, { write: ['src/a.ts'], acceptance: ['has a test'] })
    const dev = newSession(h.hub, 'dev', 'backend_dev')
    h.hub.board.claimTask(dev.session_id, task.task_id)
    commitInWorktree(h, task, { 'src/a.ts': 'export const a = 1\n' })
    h.hub.board.submitTask(h.hub.identity.requireIdentity(dev.session_id), task.task_id, 'a without test')

    const rev = newSession(h.hub, 'rev', 'supervisor')
    const rejected = h.hub.board.recordVerdict(
      h.hub.identity.requireIdentity(rev.session_id),
      task.task_id,
      'rejected',
      [{ criterion: 'has a test', pass: false, evidence: 'no test file in diff' }],
      'add a test',
    )
    assert.equal(rejected.task.status, 'rejected')

    // Rework by the same implementer, then resubmit from the rejected state.
    commitInWorktree(h, task, { 'src/a.test.ts': 'test("a", () => {})\n' })
    const resub = h.hub.board.submitTask(h.hub.identity.requireIdentity(dev.session_id), task.task_id, 'added test')
    assert.equal(resub.task.status, 'submitted')
    assert.equal(resub.task.submission?.files.length, 2)
  } finally {
    h.cleanup()
  }
})

test('lifecycle: granularity rule refuses oversized tasks', () => {
  const h = createHarness('granularity')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'])
    assert.throws(
      () =>
        h.hub.board.createTask({
          title: 'too big',
          role: 'backend_dev',
          scope: { write: ['src/**'] },
          acceptance: ['1', '2', '3', '4', '5', '6', '7', '8'],
        }),
      (e: { code?: string }) => e.code === 'MESH_GRANULARITY',
    )
    assert.throws(
      () =>
        h.hub.board.createTask({
          title: 'too long',
          role: 'backend_dev',
          scope: { write: ['src/**'] },
          acceptance: ['one'],
          estimate: 'multi-session',
        }),
      (e: { code?: string }) => e.code === 'MESH_GRANULARITY',
    )
    const violations = h.hub.store.violations().filter((v) => v.kind === 'granularity.oversized')
    assert.equal(violations.length, 2)
  } finally {
    h.cleanup()
  }
})

test('lifecycle: only planning roles may put work on the board', () => {
  const h = createHarness('canplan')
  try {
    addAgent(h.hub, 'worker', ['backend_dev'])
    addAgent(h.hub, 'coord', ['coordinator'])
    const worker = newSession(h.hub, 'worker', 'backend_dev')
    assert.throws(
      () =>
        h.hub.board.createTask(
          {
            title: 'worker tries to order work',
            role: 'backend_dev',
            scope: { write: ['src/x.ts'] },
            acceptance: ['x'],
          },
          h.hub.identity.requireIdentity(worker.session_id),
        ),
      (e: { code?: string }) => e.code === 'MESH_ROLE_FORBIDDEN',
    )
    const coord = newSession(h.hub, 'coord', 'coordinator')
    const task = h.hub.board.createTask(
      { title: 'coordinator orders work', role: 'backend_dev', scope: { write: ['src/y.ts'] }, acceptance: ['y'] },
      h.hub.identity.requireIdentity(coord.session_id),
    )
    assert.equal(task.status, 'ready')
    assert.equal(task.created_by, coord.session_id)
  } finally {
    h.cleanup()
  }
})

test('lifecycle: context package carries the role card, the scope and the fixed clauses', () => {
  const h = createHarness('context')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'])
    const task = createReadyTask(h.hub, { write: ['src/thing.ts'], acceptance: ['exists'] })
    const dev = newSession(h.hub, 'dev', 'backend_dev')
    const claim = h.hub.board.claimTask(dev.session_id, task.task_id)
    const md = fs.readFileSync(path.resolve(h.dir, claim.contextPath), 'utf8')
    assert.match(md, /Backend Dev/)
    assert.match(md, /src\/thing\.ts/)
    assert.match(md, /本任务完成以 Supervisor 通过为准/)
    assert.match(md, /不得沿用、暗示或援引其他任何会话/)
    assert.match(md, /你现在的世界/)
    // The default package must not hand over the global plan (L2 is a default, not a wall).
    assert.ok(!md.includes('全部任务列表'))
  } finally {
    h.cleanup()
  }
})
