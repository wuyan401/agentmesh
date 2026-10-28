#!/usr/bin/env node
/**
 * Scripted supervisor — M1 acceptance scaffolding, NOT part of the platform.
 *
 * A real P-Session process that reviews the submission by *checking it*: every file
 * the author claims must exist in the sandbox and carry the task id. It then issues a
 * verdict with per-criterion evidence, exactly like an LLM supervisor would.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const pkgRoot = process.env.MESH_AGENTMESH_DIR
const cli = path.join(pkgRoot, 'cli', 'mesh.ts')
const meshDir = process.env.MESH_MESH_DIR
const taskId = process.env.MESH_TASK_ID

function mesh(args) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() }
}

function log(msg) {
  process.stdout.write(`[scripted-supervisor ${taskId}] ${msg}\n`)
}

if (!taskId) {
  log('no MESH_TASK_ID; nothing to do')
  process.exit(0)
}

const hello = mesh(['hello'])
log(`hello → exit ${hello.code}`)
if (hello.code !== 0) {
  log(hello.out.slice(0, 300))
  process.exit(hello.code ?? 1)
}

const open = mesh(['review', taskId])
log(`request review → exit ${open.code}`)

const card = JSON.parse(fs.readFileSync(path.join(meshDir, 'board', 'tasks', `${taskId}.json`), 'utf8'))
const files = (card.submission && card.submission.files) || []

const checks = files.map((rel) => {
  const abs = path.join(process.cwd(), rel)
  if (!fs.existsSync(abs)) return { rel, ok: false, why: 'missing in sandbox' }
  const body = fs.readFileSync(abs, 'utf8')
  if (!body.includes(taskId)) return { rel, ok: false, why: 'file does not carry the task id' }
  if (!/export const built/.test(body)) return { rel, ok: false, why: 'file does not export `built`' }
  return { rel, ok: true, why: 'exists, tagged with task id, exports built' }
})

const pass = checks.length > 0 && checks.every((c) => c.ok)
const result = mesh([
  'verdict',
  taskId,
  pass ? '--approve' : '--reject',
  '--notes',
  pass
    ? `scripted supervisor: ${checks.length} file(s) verified against the acceptance criteria`
    : `scripted supervisor: ${checks.filter((c) => !c.ok).map((c) => `${c.rel} (${c.why})`).join('; ') || 'no submitted files'}`,
])
log(`verdict ${pass ? 'approved' : 'rejected'} → exit ${result.code}`)
if (result.code !== 0) log(result.out.slice(0, 500))
