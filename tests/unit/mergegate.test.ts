import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { addAgent, commitInWorktree, createHarness, createReadyTask, newSession } from '../helpers.ts'
import { scopeCheck, ensureMeshRef } from '../../hub/core/mergeGate.ts'

function setupApprovedTask(opts: {
  write: string[]
  files: Record<string, string>
  acceptStrip?: boolean
}) {
  const h = createHarness('gate')
  addAgent(h.hub, 'dev', ['backend_dev'])
  addAgent(h.hub, 'rev', ['supervisor'])
  addAgent(h.hub, 'int', ['integrator'])
  const task = createReadyTask(h.hub, { write: opts.write, acceptance: ['in scope work done'] })
  const dev = newSession(h.hub, 'dev', 'backend_dev')
  h.hub.board.claimTask(dev.session_id, task.task_id)
  commitInWorktree(h, task, opts.files)
  h.hub.board.submitTask(h.hub.identity.requireIdentity(dev.session_id), task.task_id, 'work')

  const rev = newSession(h.hub, 'rev', 'supervisor')
  h.hub.board.recordVerdict(
    h.hub.identity.requireIdentity(rev.session_id),
    task.task_id,
    'approved',
    [{ criterion: 'in scope work done', pass: true, evidence: 'diff reviewed' }],
    'approved',
    { allowStripMerge: opts.acceptStrip === true },
  )
  const intSession = newSession(h.hub, 'int', 'integrator')
  return { h, task, intIdentity: h.hub.identity.requireIdentity(intSession.session_id) }
}

test('T3: an out-of-scope file is refused at the merge gate, whole submission rejected', () => {
  const { h, task, intIdentity } = setupApprovedTask({
    write: ['src/login/**'],
    files: {
      'src/login/index.ts': 'export const login = 1\n',
      'src/dashboard/index.ts': 'export const dashboard = 1\n', // the agent "helpfully" also refactored this
    },
  })
  try {
    const preMergeHead = h.git.headSha()
    const check = scopeCheck(h.git, h.hub.store.requireTask(task.task_id))
    assert.deepEqual(check.out_of_scope, ['src/dashboard/index.ts'])
    assert.equal(check.ok, false)

    assert.throws(
      () => h.hub.board.mergeTask(task.task_id, { identity: intIdentity }),
      (e: { code?: string; detail?: Record<string, unknown> }) => {
        assert.equal(e.code, 'MESH_SCOPE_VIOLATION')
        assert.deepEqual((e.detail as { out_of_scope: string[] }).out_of_scope, ['src/dashboard/index.ts'])
        return true
      },
    )

    // 主分支零越界：头和内容都没动
    assert.equal(h.git.headSha(), preMergeHead)
    assert.ok(!fs.existsSync(path.join(h.dir, 'src/dashboard/index.ts')))
    assert.ok(!fs.existsSync(path.join(h.dir, 'src/login/index.ts')), 'nothing from a refused submission may land')

    // 整单打回 + 审计留痕 + 证据文件
    const after = h.hub.store.requireTask(task.task_id)
    assert.equal(after.status, 'rejected')
    const violations = h.hub.store.violations().filter((v) => v.kind === 'scope.merge-blocked')
    assert.equal(violations.length, 1)
    const evidenceFile = String((violations[0]!.evidence as Record<string, unknown>)['evidence_file'])
    assert.ok(fs.existsSync(path.resolve(h.dir, evidenceFile)))
    assert.match(fs.readFileSync(path.resolve(h.dir, evidenceFile), 'utf8'), /src\/dashboard\/index\.ts/)

    // 实现者收到打回反馈
    const inbox = h.hub.store.inbox('dev', { unreadOnly: true })
    assert.ok(inbox.some((m) => m.type === 'task.feedback' && m.body.includes('越界')))
  } finally {
    h.cleanup()
  }
})

test('T3: strip mode merges only in-scope files and records what it dropped', () => {
  const { h, task, intIdentity } = setupApprovedTask({
    write: ['src/login/**'],
    files: {
      'src/login/index.ts': 'export const login = 1\n',
      'src/dashboard/index.ts': 'export const dashboard = 1\n',
    },
    acceptStrip: true,
  })
  try {
    const merged = h.hub.board.mergeTask(task.task_id, { identity: intIdentity })
    assert.equal(merged.task.status, 'merged')
    assert.equal(merged.mode, 'strip')
    assert.deepEqual(merged.stripped, ['src/dashboard/index.ts'])
    assert.deepEqual(merged.files, ['src/login/index.ts'])

    // 主分支只拿到 scope 内的文件
    assert.ok(fs.existsSync(path.join(h.dir, 'src/login/index.ts')))
    assert.ok(!fs.existsSync(path.join(h.dir, 'src/dashboard/index.ts')))

    // 剥离的内容没有消失：任务分支上还留着，审计里有记录
    const ref = ensureMeshRef(h.git, h.hub.paths, task)
    const branchFiles = h.git.changedFiles(task.base_commit!, ref)
    assert.deepEqual(branchFiles, ['src/dashboard/index.ts', 'src/login/index.ts'])
    const merges = h.hub.store.merges()
    assert.deepEqual((merges[0] as Record<string, unknown>)['stripped'], ['src/dashboard/index.ts'])
  } finally {
    h.cleanup()
  }
})

test('T3: a clean submission merges without stripping and leaves main consistent', () => {
  const { h, task, intIdentity } = setupApprovedTask({
    write: ['src/login/**'],
    files: { 'src/login/index.ts': 'export const login = 1\n', 'src/login/form.tsx': 'export const Form = 1\n' },
  })
  try {
    const merged = h.hub.board.mergeTask(task.task_id, { identity: intIdentity })
    assert.equal(merged.mode, 'strict')
    assert.equal(merged.stripped.length, 0)
    assert.deepEqual(merged.files, ['src/login/form.tsx', 'src/login/index.ts'])
    assert.equal(h.git.currentBranch(), h.hub.store.getState().main_branch)
    assert.equal(h.git.statusPorcelain(h.dir).trim(), '')
  } finally {
    h.cleanup()
  }
})

test('merge gate: the integrator must not be the implementer', () => {
  const h = createHarness('gate-sod')
  try {
    addAgent(h.hub, 'solo', ['backend_dev', 'supervisor', 'integrator'])
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    const dev = newSession(h.hub, 'solo', 'backend_dev')
    h.hub.board.claimTask(dev.session_id, task.task_id)
    commitInWorktree(h, task, { 'src/a.ts': 'export const a = 1\n' })
    h.hub.board.submitTask(h.hub.identity.requireIdentity(dev.session_id), task.task_id, 'a')
    // A different agent must review and integrate.
    addAgent(h.hub, 'other-rev', ['supervisor'])
    addAgent(h.hub, 'other-int', ['integrator'])
    const rev = newSession(h.hub, 'other-rev', 'supervisor')
    h.hub.board.recordVerdict(h.hub.identity.requireIdentity(rev.session_id), task.task_id, 'approved', [], 'ok')
    const intSession = newSession(h.hub, 'solo', 'integrator')
    assert.throws(
      () => h.hub.board.mergeTask(task.task_id, { identity: h.hub.identity.requireIdentity(intSession.session_id) }),
      (e: { code?: string }) => e.code === 'MESH_SOD_VIOLATION',
    )
  } finally {
    h.cleanup()
  }
})
