#!/usr/bin/env node
/**
 * Scripted worker — M1 acceptance scaffolding, NOT part of the platform.
 *
 * A real P-Session process (spawned by the scheduler, with MESH_SESSION_ID /
 * MESH_TASK_ID in its environment) that performs the same channel-B steps any agent
 * would: claim → write inside scope → commit → submit. It exists so the mission
 * kernel can be exercised end to end without waiting on an LLM.
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
  process.stdout.write(`[scripted-worker ${taskId}] ${msg}\n`)
}

if (!taskId) {
  log('no MESH_TASK_ID; nothing to do')
  process.exit(0)
}

// Every P-Session starts here. Without it the platform refuses every privileged call
// (this fixture learned it the hard way: claim/submit came back MESH_SESSION_HELLO_REQUIRED).
const hello = mesh(['hello'])
log(`hello → exit ${hello.code}`)
if (hello.code !== 0) {
  log(hello.out.slice(0, 300))
  process.exit(hello.code ?? 1)
}

const claim = mesh(['claim', taskId])
log(`claim → exit ${claim.code}${claim.code === 0 ? '' : `: ${claim.out.slice(0, 200)}`}`)
if (claim.code !== 0) process.exit(claim.code ?? 1)

const cardFile = path.join(meshDir, 'board', 'tasks', `${taskId}.json`)
const card = JSON.parse(fs.readFileSync(cardFile, 'utf8'))
const glob = card.scope.write[0]
const rel = glob.includes('**') ? glob.replace('**', 'index.ts') : glob.replace(/\/$/, '.ts')
const abs = path.join(process.cwd(), rel)
fs.mkdirSync(path.dirname(abs), { recursive: true })
// Unique per attempt: a rework must produce a new commit, otherwise submit/merge
// correctly reports "nothing changed".
const stamp = new Date().toISOString()
// MESH_SCRIPTED_MODE=bad makes this worker produce work the supervisor must reject —
// used by the §2.3 reassignment demo to generate real rejections.
const bad = process.env.MESH_SCRIPTED_MODE === 'bad'
const body = bad
  ? `// ${taskId}\nexport const nope = ${JSON.stringify(stamp)}\n`
  : `// ${taskId}\nexport const built = ${JSON.stringify(stamp)}\n`
fs.writeFileSync(abs, body)
log(`wrote ${rel}${bad ? ' (deliberately incomplete)' : ''}`)

spawnSync('git', ['add', '-A'], { cwd: process.cwd(), encoding: 'utf8' })
const commit = spawnSync('git', ['commit', '-m', `scripted: ${taskId} at ${stamp}`], {
  cwd: process.cwd(),
  encoding: 'utf8',
})
log(`git commit → exit ${commit.status}`)

const submit = mesh(['submit', taskId, '--summary', `scripted worker delivered ${rel} at ${stamp}`])
log(`submit → exit ${submit.code}`)
if (submit.code !== 0) log(submit.out.slice(0, 500))
