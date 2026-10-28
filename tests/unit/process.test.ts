/**
 * Regressions for the two `runForeground` fixes (hub/scheduler/process.ts).
 *
 * Both bugs only show up with a real child process, so both tests spawn one:
 *
 *  1. stdin was an always-open pipe, so a one-shot CLI that reads stdin blocked until
 *     the turn timed out. Fix: `stdio[0] = plan.stdin ? 'pipe' : 'ignore'`.
 *  2. stdout was a pipe, so the child block-buffered and a timeout kill threw the
 *     output away (the log only had the 423-byte header). Fix: write straight into the
 *     log fd and read it back by offset afterwards.
 *
 * If either test starts hanging or its log comes back empty, the fix has regressed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runForeground } from '../../hub/scheduler/process.ts'
import { createHarness } from '../helpers.ts'
import type { SpawnPlan } from '../../hub/adapters/types.ts'

function planFor(nodeArgs: string[], cwd: string, extra: Partial<SpawnPlan> = {}): SpawnPlan {
  return {
    command: process.execPath,
    args: nodeArgs,
    cwd,
    env: { ...process.env } as Record<string, string>,
    artifacts: [],
    injection: 'test',
    ...extra,
  }
}

test('runForeground: a child that reads stdin does not hang when nothing is fed (stdin is ignored)', () => {
  const h = createHarness('fg-stdin')
  try {
    const logFile = path.join(h.dir, '.mesh', 'logs', 'fg-stdin.log')
    // This child reads fd 0 to EOF. With a pipe held open by the parent it would block
    // forever; with stdio[0]='ignore' it sees EOF immediately and exits.
    const started = Date.now()
    const result = runForeground(
      planFor(['-e', "const fs=require('fs');const d=fs.readFileSync(0);process.stdout.write('stdin-bytes:'+d.length+'\\n')"], h.dir),
      logFile,
      20_000,
    )
    const elapsed = Date.now() - started

    assert.equal(result.timedOut, false, 'the turn must not time out waiting on stdin')
    assert.equal(result.code, 0)
    assert.match(result.stdout, /stdin-bytes:0/)
    assert.ok(elapsed < 15_000, `should finish quickly, took ${elapsed}ms`)
  } finally {
    h.cleanup()
  }
})

test('runForeground: output produced before a timeout kill is still in the log', () => {
  const h = createHarness('fg-timeout')
  try {
    const logFile = path.join(h.dir, '.mesh', 'logs', 'fg-timeout.log')
    // Writes immediately (synchronously, so it cannot be sitting in a buffer), then
    // hangs forever. The turn is killed; the early line must survive.
    const result = runForeground(
      planFor(
        ['-e', "const fs=require('fs');fs.writeSync(1,'early-output\\n');setTimeout(()=>{},60000)"],
        h.dir,
      ),
      logFile,
      1_500,
    )

    assert.equal(result.timedOut, true, 'the turn must be reported as timed out')
    assert.match(result.stdout, /early-output/, 'the child output must be read back from the log fd')
    // …and it is really on disk, not just in the returned string
    const onDisk = fs.readFileSync(logFile, 'utf8')
    assert.match(onDisk, /early-output/)
    // The bug's signature was: log == header only. Anything the child produced is extra.
    assert.ok(
      onDisk.length > result.stdout.length,
      `log must contain the header plus the child output (log=${onDisk.length}B, output=${result.stdout.length}B)`,
    )
  } finally {
    h.cleanup()
  }
})

test('runForeground: stdin is still fed when the plan provides it', () => {
  const h = createHarness('fg-stdin-fed')
  try {
    const logFile = path.join(h.dir, '.mesh', 'logs', 'fg-stdin-fed.log')
    const result = runForeground(
      planFor(['-e', "const fs=require('fs');const d=fs.readFileSync(0,'utf8');process.stdout.write('got:'+d.trim()+'\\n')"], h.dir, {
        stdin: 'hello from mesh',
      }),
      logFile,
      20_000,
    )
    assert.equal(result.timedOut, false)
    assert.match(result.stdout, /got:hello from mesh/)
  } finally {
    h.cleanup()
  }
})
