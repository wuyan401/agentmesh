/**
 * Process spawning for P-Sessions.
 *
 * Children are detached, with stdout/stderr redirected straight into
 * `.mesh/logs/<session>.log` file descriptors (not pipes), so a child keeps
 * running — and keeps logging — even if the `mesh` process that spawned it exits
 * immediately. That is what makes `mesh assign` work without a daemon.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { ensureDir, nowIso } from '../core/fsx.ts'
import type { SpawnPlan } from '../adapters/types.ts'

export interface SpawnedProcess {
  pid: number | null
  logFile: string
  startedAt: string
  note: string
}

export function spawnSessionProcess(plan: SpawnPlan, logFile: string): SpawnedProcess {
  ensureDir(path.dirname(logFile))
  const header = [
    '',
    '='.repeat(78),
    `AgentMesh spawn @ ${nowIso()}`,
    `cwd: ${plan.cwd}`,
    `cmd: ${plan.command} ${plan.args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`,
    `injection: ${plan.injection}`,
    '='.repeat(78),
    '',
  ].join('\n')
  fs.appendFileSync(logFile, header)

  const outFd = fs.openSync(logFile, 'a')
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      windowsHide: true,
      detached: true,
      stdio: [plan.stdin ? 'pipe' : 'ignore', outFd, outFd],
    })
  } finally {
    fs.closeSync(outFd)
  }

  if (plan.stdin && child.stdin) {
    child.stdin.write(plan.stdin)
    child.stdin.end()
  }
  child.on('error', (e) => {
    fs.appendFileSync(logFile, `\n[mesh] spawn error: ${e.message}\n`)
  })
  child.unref()
  return {
    pid: child.pid ?? null,
    logFile,
    startedAt: nowIso(),
    note: plan.injection,
  }
}

export function killProcess(pid: number | null, force = true): boolean {
  if (!pid) return false
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
    return true
  } catch {
    return false
  }
}

export function tailLog(logFile: string, lines = 20): string {
  try {
    const text = fs.readFileSync(logFile, 'utf8')
    return text.split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

export interface ForegroundResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  logFile: string
}

/**
 * Run a one-shot turn in the foreground and wait for it. Used for `mesh talk` and
 * `mesh assign --wait`, where a human is watching and wants the answer now.
 */
export function runForeground(plan: SpawnPlan, logFile: string, timeoutMs = 600_000): ForegroundResult {
  ensureDir(path.dirname(logFile))
  const header = [
    '',
    '='.repeat(78),
    `AgentMesh foreground turn @ ${nowIso()}`,
    `cwd: ${plan.cwd}`,
    `injection: ${plan.injection}`,
    '='.repeat(78),
    '',
  ].join('\n')
  fs.appendFileSync(logFile, header)
  const startOffset = fs.statSync(logFile).size
  const outFd = fs.openSync(logFile, 'a')
  let res: ReturnType<typeof spawnSync>
  try {
    res = spawnSync(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      input: plan.stdin,
      // Redirect straight into the log fd, exactly like the async spawn path.
      // Two reasons, both learned the hard way:
      //  - stdin must be 'ignore' when nothing is fed, or a one-shot CLI
      //    (dsh headless) blocks forever waiting on a non-tty pipe;
      //  - stdout must be a file, not a pipe, or the child block-buffers and
      //    every line is lost when the turn is killed on timeout.
      stdio: [plan.stdin ? 'pipe' : 'ignore', outFd, outFd],
    })
  } finally {
    fs.closeSync(outFd)
  }
  const stdout = fs.readFileSync(logFile).subarray(startOffset).toString('utf8')
  const stderr = res.error ? String(res.error.message ?? res.error) : ''
  if (stderr) fs.appendFileSync(logFile, `\n[stderr]\n${stderr}\n`)
  return {
    code: res.status,
    stdout,
    stderr,
    timedOut: Boolean(res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'),
    logFile,
  }
}
