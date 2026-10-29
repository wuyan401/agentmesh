/**
 * The stdio MCP server spawned by a DSH patch inherits *only* the variables the
 * patch lists — no PATH. `hub.submit` shells out to git, so the resolver has to
 * work without PATH; otherwise every MCP-channel submit dies with
 * `spawnSync git ENOENT` while the worker itself looks perfectly healthy.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'
import { resolveGitBinary } from '../../hub/core/git.ts'

test('git: resolveGitBinary returns a binary that actually runs', () => {
  const binary = resolveGitBinary()
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true })
  assert.equal(probe.error, undefined, `failed to start ${binary}: ${probe.error?.message}`)
  assert.equal(probe.status, 0, `${binary} --version exited ${probe.status}`)
  assert.match(probe.stdout ?? '', /git version/)
})

test('git: on Windows an absolute install exists as a PATH-free fallback', () => {
  if (process.platform !== 'win32') return
  const candidates = [
    'D:\\AI\\Hermes\\tools\\git-2.53.0+3-win32-x64\\cmd\\git.exe',
    'C:\\Program Files\\Git\\cmd\\git.exe',
  ]
  assert.ok(
    candidates.some((p) => fs.existsSync(p)),
    'no absolute git fallback found; an MCP-channel submit would break without PATH',
  )
})
