import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { addAgent, commitInWorktree, createHarness, createReadyTask, newSession, worktreeOf } from '../helpers.ts'

function runClaimWorker(root: string, sessionId: string, taskId: string): Promise<{ ok: boolean; code?: string; pid?: number }> {
  return new Promise((resolve) => {
    const worker = path.resolve(import.meta.dirname, '../helpers/claim-worker.ts')
    const child = spawn(process.execPath, [worker, root, sessionId, taskId], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (out += String(d)))
    child.on('close', () => {
      const line = out.split('\n').find((l) => l.trim().startsWith('{'))
      try {
        resolve(JSON.parse(line ?? '{}') as { ok: boolean; code?: string; pid?: number })
      } catch {
        resolve({ ok: false, code: 'PARSE' })
      }
    })
    child.on('error', () => resolve({ ok: false, code: 'SPAWN' }))
  })
}

test('claim: a second session cannot take a claimed task', () => {
  const h = createHarness('claim-single')
  try {
    addAgent(h.hub, 'dev-a', ['backend_dev'])
    addAgent(h.hub, 'dev-b', ['backend_dev'])
    const task = createReadyTask(h.hub)

    const a = newSession(h.hub, 'dev-a', 'backend_dev')
    const b = newSession(h.hub, 'dev-b', 'backend_dev')
    const claimed = h.hub.board.claimTask(a.session_id, task.task_id)
    assert.equal(claimed.task.status, 'claimed')
    assert.equal(claimed.task.claimed_by, a.session_id)

    assert.throws(
      () => h.hub.board.claimTask(b.session_id, task.task_id),
      (e: { code?: string }) => e.code === 'MESH_CLAIM_CONFLICT',
    )
    // Same session re-claiming is idempotent, not an error: agents retry.
    const again = h.hub.board.claimTask(a.session_id, task.task_id)
    assert.equal(again.task.claimed_by, a.session_id)
  } finally {
    h.cleanup()
  }
})

test('claim: 6 concurrent processes produce exactly one winner (file lock, cross-process)', async () => {
  const h = createHarness('claim-race')
  try {
    const task = createReadyTask(h.hub, { title: 'race target' })
    const sessions: string[] = []
    for (let i = 0; i < 6; i++) {
      const agentId = `racer-${i}`
      addAgent(h.hub, agentId, ['backend_dev'])
      sessions.push(newSession(h.hub, agentId, 'backend_dev').session_id)
    }
    const results = await Promise.all(sessions.map((sid) => runClaimWorker(h.dir, sid, task.task_id)))
    const winners = results.filter((r) => r.ok)
    assert.equal(winners.length, 1, `expected exactly one winner, got ${JSON.stringify(results)}`)
    const losers = results.filter((r) => !r.ok)
    assert.equal(losers.length, 5)
    for (const l of losers) {
      // Losing cleanly (CLAIM_CONFLICT) is the normal path. Under heavy parallel load a
      // loser can also give up waiting for the lock — still "not the winner", and the
      // invariant below is what actually matters.
      assert.ok(
        l.code === 'MESH_CLAIM_CONFLICT' || l.code === 'MESH_LOCK_TIMEOUT',
        `unexpected loser outcome: ${JSON.stringify(l)}`,
      )
    }

    const fresh = h.hub.store.requireTask(task.task_id)
    assert.equal(fresh.status, 'claimed')
    assert.equal(fresh.history.filter((x) => x.to === 'claimed').length, 1)
  } finally {
    h.cleanup()
  }
})

test('claim: a task cannot be claimed before its dependency merged', () => {
  const h = createHarness('claim-dep')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'])
    const dep = createReadyTask(h.hub, { title: 'dep', write: ['src/a.ts'] })
    const task = h.hub.board.createTask({
      title: 'dependent',
      role: 'backend_dev',
      scope: { write: ['src/b.ts'], read: [] },
      acceptance: ['done'],
      depends_on: [dep.task_id],
    })
    assert.equal(task.status, 'draft', 'a task with unmet dependencies must stay a draft')

    const s = newSession(h.hub, 'dev', 'backend_dev')
    assert.throws(
      () => h.hub.board.claimTask(s.session_id, task.task_id),
      (e: { code?: string }) => e.code === 'MESH_TRANSITION_ILLEGAL',
    )
  } finally {
    h.cleanup()
  }
})

test('claim: unregistered sessions have no rights at all', () => {
  const h = createHarness('claim-nosession')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'])
    const task = createReadyTask(h.hub)
    assert.throws(
      () => h.hub.board.claimTask('S-999999', task.task_id),
      (e: { code?: string }) => e.code === 'MESH_SESSION_UNKNOWN',
    )
    // A session that exists but never called hello() is equally powerless.
    const s = h.hub.identity.createSession({ agent_id: 'dev', role: 'backend_dev', spawned_by: 'test' })
    assert.throws(
      () => h.hub.board.claimTask(s.session_id, task.task_id),
      (e: { code?: string }) => e.code === 'MESH_SESSION_HELLO_REQUIRED',
    )
  } finally {
    h.cleanup()
  }
})

test('claim: crash recovery — a stale lock from a dead process is reclaimed', () => {
  const h = createHarness('claim-stale')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'])
    const task = createReadyTask(h.hub)
    const lockFile = h.hub.paths.lockFile(`task-${task.task_id}`)
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999, at: new Date().toISOString(), owner: 'dead', token: 'x' }))

    const s = newSession(h.hub, 'dev', 'backend_dev')
    const claimed = h.hub.board.claimTask(s.session_id, task.task_id)
    assert.equal(claimed.task.status, 'claimed', 'a lock owned by a dead pid must be reclaimed, not block forever')
  } finally {
    h.cleanup()
  }
})

test('claim: task branch and worktree are created on claim, and commits land there', () => {
  const h = createHarness('claim-worktree')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'])
    const task = createReadyTask(h.hub, { write: ['src/thing.ts'] })
    const s = newSession(h.hub, 'dev', 'backend_dev')
    h.hub.board.claimTask(s.session_id, task.task_id)

    const wt = worktreeOf(h, h.hub.store.requireTask(task.task_id))
    assert.ok(fs.existsSync(path.join(wt, '.git')), 'sandbox must be a self-contained repo (its own .git inside)')
    assert.equal(h.git.currentBranch(wt), task.branch, 'the sandbox must be on the task branch')

    commitInWorktree(h, task, { 'src/thing.ts': 'export const x = 1\n' })
    const head = h.git.headSha(wt)
    assert.ok(head)
    assert.deepEqual(h.git.sandboxChangedFiles(wt, task.base_commit!, head!), ['src/thing.ts'])
  } finally {
    h.cleanup()
  }
})
