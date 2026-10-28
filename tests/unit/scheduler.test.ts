import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Scheduler } from '../../hub/scheduler/scheduler.ts'
import { initMesh } from '../../hub/core/init.ts'
import { Git } from '../../hub/core/git.ts'
import { MeshPaths } from '../../hub/core/paths.ts'
import { addAgent, createHarness, createReadyTask, newSession, openHub } from '../helpers.ts'

/** A real process that exits immediately: enough to exercise the spawn path. */
const NOOP_AGENT = {
  command: process.execPath,
  args: ['-e', '0'],
}

test('scheduler: a ready task is dispatched to a capable agent and bound to a Session', async () => {
  const h = createHarness('sched-dispatch')
  try {
    addAgent(h.hub, 'worker', ['backend_dev'], NOOP_AGENT)
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    const scheduler = new Scheduler(h.hub)
    const report = await scheduler.tick()

    assert.equal(report.dispatched.length, 1)
    const record = report.dispatched[0]!
    assert.equal(record.task_id, task.task_id)
    assert.equal(record.agent_id, 'worker')
    assert.ok(record.pid, 'the session must have a pid')
    assert.match(record.injection, /file protocol|mcp|prompt/i)

    const bound = h.hub.store.requireTask(task.task_id)
    assert.equal(bound.status, 'claimed')
    assert.equal(bound.claimed_by, record.session_id)
    assert.equal(bound.implementer_agent, 'worker')

    // 沙箱是自包含的 clone，且带任务分支
    const sandbox = path.resolve(h.dir, bound.worktree!)
    assert.ok(fs.existsSync(path.join(sandbox, '.git')))
    assert.equal(h.git.currentBranch(sandbox), task.branch)

    // prompt 落到会话目录，带着角色卡与 scope
    const promptFile = path.join(h.hub.paths.sessionScratch(record.session_id), 'prompt.md')
    const prompt = fs.readFileSync(promptFile, 'utf8')
    assert.match(prompt, /Backend Dev/)
    assert.match(prompt, /src\/a\.ts/)
    assert.match(prompt, /本任务完成以 Supervisor 通过为准/)
    // 上下文包给的是绝对路径（agent 的 cwd 在沙箱里）
    assert.match(prompt, /\.mesh[\\/]context[\\/]T-\d{6}\.md/)
  } finally {
    h.cleanup()
  }
})

test('scheduler: concurrency limits are respected per agent', async () => {
  const h = createHarness('sched-conc')
  try {
    addAgent(h.hub, 'worker', ['backend_dev'], { ...NOOP_AGENT, concurrency: 1 })
    const t1 = createReadyTask(h.hub, { write: ['src/a.ts'] })
    const t2 = createReadyTask(h.hub, { write: ['src/b.ts'] })
    const report = await new Scheduler(h.hub).tick()
    assert.equal(report.dispatched.length, 1, 'only one spawn fits in concurrency=1')
    assert.ok(report.skipped.some((s) => s.reason.includes('concurrency') || s.reason.includes('eligible')))
    const statuses = [h.hub.store.requireTask(t1.task_id).status, h.hub.store.requireTask(t2.task_id).status]
    assert.deepEqual(statuses.sort(), ['claimed', 'ready'])
  } finally {
    h.cleanup()
  }
})

test('scheduler: an expired lease releases the task back to ready and records it', () => {
  const h = createHarness('sched-ttl')
  try {
    addAgent(h.hub, 'worker', ['backend_dev'], { ...NOOP_AGENT, ttl_seconds: 10 })
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    const session = h.hub.identity.createSession({
      agent_id: 'worker',
      role: 'backend_dev',
      task: task.task_id,
      spawned_by: 'test',
      lifespan: 'ephemeral',
      ttl_seconds: 10,
    })
    h.hub.board.preclaimTask(session.session_id, task.task_id)
    // Rewind the lease so the session is already expired.
    const stale = h.hub.store.requireSession(session.session_id)
    stale.created_at = new Date(Date.now() - 60_000).toISOString()
    stale.last_heartbeat_at = stale.created_at
    h.hub.store.saveSession(stale)

    // recover() deliberately does not re-dispatch: it isolates the release behaviour.
    const report = new Scheduler(h.hub).recover()
    assert.ok(report.expired.includes(session.session_id))
    assert.equal(report.released.length, 1)
    const released = h.hub.store.requireTask(task.task_id)
    assert.equal(released.status, 'ready', 'a dead worker must not keep the card forever')
    assert.equal(released.claimed_by, null)
    assert.ok(h.hub.store.violations().some((v) => v.kind === 'liveness.stale-session'))
  } finally {
    h.cleanup()
  }
})

test('scheduler: a task released too many times is blocked for coordinator arbitration', () => {
  const h = createHarness('sched-retry')
  try {
    addAgent(h.hub, 'worker', ['backend_dev'], { ...NOOP_AGENT, ttl_seconds: 10 })
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    const scheduler = new Scheduler(h.hub)
    for (let i = 0; i < 4; i++) {
      const session = h.hub.identity.createSession({
        agent_id: 'worker',
        role: 'backend_dev',
        task: task.task_id,
        spawned_by: 'test',
        lifespan: 'ephemeral',
        ttl_seconds: 10,
      })
      h.hub.board.preclaimTask(session.session_id, task.task_id)
      const stale = h.hub.store.requireSession(session.session_id)
      stale.created_at = new Date(Date.now() - 60_000).toISOString()
      stale.last_heartbeat_at = stale.created_at
      h.hub.store.saveSession(stale)
      scheduler.recover()
    }
    const final = h.hub.store.requireTask(task.task_id)
    assert.equal(final.status, 'blocked')
    assert.match(String(final.blocked_reason), /released/i)
    const releases = h.hub.store.auditEvents().filter((e) => e['event'] === 'task.released')
    assert.equal(releases.length, 3, 'three attempts, then the platform stops retrying')
  } finally {
    h.cleanup()
  }
})

test('scheduler: auto-review picks a reviewer that is not the implementer (T8)', async () => {
  const h = createHarness('sched-review')
  try {
    addAgent(h.hub, 'worker', ['backend_dev', 'supervisor'], NOOP_AGENT)
    addAgent(h.hub, 'other', ['supervisor'], NOOP_AGENT)
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    const dev = newSession(h.hub, 'worker', 'backend_dev')
    h.hub.board.claimTask(dev.session_id, task.task_id)
    const sandbox = path.resolve(h.dir, h.hub.store.requireTask(task.task_id).worktree!)
    fs.mkdirSync(path.join(sandbox, 'src'), { recursive: true })
    fs.writeFileSync(path.join(sandbox, 'src', 'a.ts'), 'export const a = 1\n')
    new Git(h.dir).run(['add', '-A'], { cwd: sandbox })
    new Git(h.dir).run(['commit', '-m', 'a'], { cwd: sandbox })
    h.hub.board.submitTask(h.hub.identity.requireIdentity(dev.session_id), task.task_id, 'a')

    const report = await new Scheduler(h.hub).tick()
    assert.equal(report.reviews.length, 1)
    assert.equal(report.reviews[0]!.agent_id, 'other', 'the implementer must never review itself')
  } finally {
    h.cleanup()
  }
})

test('scheduler: auto-integration merges an approved task without an LLM', async () => {
  const h = createHarness('sched-integrate')
  try {
    addAgent(h.hub, 'worker', ['backend_dev'], NOOP_AGENT)
    addAgent(h.hub, 'reviewer', ['supervisor'], NOOP_AGENT)
    // The builtin integrator is what initMesh registers in a real project.
    addAgent(h.hub, 'mesh-hub', ['integrator', 'sentinel'], {
      kind: 'builtin',
      command: '',
      transport: 'in-process',
      mcp_inject: 'none',
    })
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    const dev = newSession(h.hub, 'worker', 'backend_dev')
    h.hub.board.claimTask(dev.session_id, task.task_id)
    const sandbox = path.resolve(h.dir, h.hub.store.requireTask(task.task_id).worktree!)
    fs.mkdirSync(path.join(sandbox, 'src'), { recursive: true })
    fs.writeFileSync(path.join(sandbox, 'src', 'a.ts'), 'export const a = 1\n')
    new Git(h.dir).run(['add', '-A'], { cwd: sandbox })
    new Git(h.dir).run(['commit', '-m', 'a'], { cwd: sandbox })
    h.hub.board.submitTask(h.hub.identity.requireIdentity(dev.session_id), task.task_id, 'a')

    const reviewer = newSession(h.hub, 'reviewer', 'supervisor')
    h.hub.board.recordVerdict(h.hub.identity.requireIdentity(reviewer.session_id), task.task_id, 'approved', [], 'ok')

    const report = await new Scheduler(h.hub).tick()
    assert.equal(report.merged.length, 1)
    assert.equal(h.hub.store.requireTask(task.task_id).status, 'merged')
    const merges = h.hub.store.merges()
    assert.equal(merges.length, 1)
    // A deterministic integrator Session is on the record (not a phantom actor).
    assert.equal(h.hub.store.requireTask(task.task_id).merge?.session_id.startsWith('S-'), true)
  } finally {
    h.cleanup()
  }
})

test('scheduler: a waiting task builds on today main, not on the tree it was written on', async () => {
  const h = createHarness('sched-rebase')
  try {
    addAgent(h.hub, 'worker', ['backend_dev'], NOOP_AGENT)
    addAgent(h.hub, 'other', ['backend_dev', 'supervisor'], NOOP_AGENT)
    // Card created now...
    const dep = createReadyTask(h.hub, { title: 'dep', write: ['src/dep.ts'] })
    const task = h.hub.board.createTask({
      title: 'dependent',
      role: 'backend_dev',
      scope: { write: ['src/late.ts'] },
      acceptance: ['late'],
      depends_on: [dep.task_id],
    })
    const staleBase = task.base_commit
    assert.ok(staleBase)

    // ...then main advances before the dependent task is ever dispatched.
    const dev = newSession(h.hub, 'worker', 'backend_dev')
    h.hub.board.claimTask(dev.session_id, dep.task_id)
    const depSandbox = path.resolve(h.dir, h.hub.store.requireTask(dep.task_id).worktree!)
    fs.mkdirSync(path.join(depSandbox, 'src'), { recursive: true })
    fs.writeFileSync(path.join(depSandbox, 'src', 'dep.ts'), 'export const dep = 1\n')
    new Git(h.dir).run(['add', '-A'], { cwd: depSandbox })
    new Git(h.dir).run(['commit', '-m', 'dep'], { cwd: depSandbox })
    h.hub.board.submitTask(h.hub.identity.requireIdentity(dev.session_id), dep.task_id, 'dep')
    const reviewer = newSession(h.hub, 'other', 'supervisor')
    h.hub.board.recordVerdict(h.hub.identity.requireIdentity(reviewer.session_id), dep.task_id, 'approved', [], 'ok')
    h.hub.board.mergeTask(dep.task_id, { auto: true })
    const newMain = h.git.headSha()
    assert.notEqual(newMain, staleBase)

    // Now the dependent becomes ready and is dispatched.
    const report = await new Scheduler(h.hub).tick()
    assert.equal(report.dispatched.length, 1)
    const bound = h.hub.store.requireTask(task.task_id)
    assert.equal(bound.base_commit, newMain, 'the sandbox must start from the current main')
    const sandbox = path.resolve(h.dir, bound.worktree!)
    assert.ok(fs.existsSync(path.join(sandbox, 'src', 'dep.ts')), 'the worker must see its dependency work')
  } finally {
    h.cleanup()
  }
})

test('init: re-running init repairs without destroying the board', () => {
  const h = createHarness('init-idem')
  try {
    addAgent(h.hub, 'worker', ['backend_dev'], NOOP_AGENT)
    const task = createReadyTask(h.hub, { title: 'keep me', write: ['src/a.ts'] })
    const before = h.hub.store.listAgents().length

    const again = initMesh({ root: h.dir, projectName: 'renamed', detect: false })
    assert.equal(again.created, false)
    const hub = openHub(h.dir)
    assert.equal(hub.store.getState().project, 'init-idem', 'the project name must not be overwritten')
    assert.equal(hub.store.listAgents().length, before, 'detect:false must not touch the agent registry')
    assert.ok(hub.store.getTask(task.task_id), 'the board must survive an init re-run')
    assert.ok(fs.existsSync(hub.paths.decisionsFile))
    assert.ok(fs.existsSync(hub.paths.protocolSnapshot))
    assert.ok(fs.existsSync(new MeshPaths(h.dir).roleFile('coordinator')))
  } finally {
    h.cleanup()
  }
})
