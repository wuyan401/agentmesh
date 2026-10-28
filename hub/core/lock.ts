/**
 * Cross-process file locks.
 *
 * The only writer-serialisation primitive in AgentMesh: a `wx`-created lock file
 * holding the owner's pid. Every mutation of a card or counter happens while
 * holding the matching lock, which is what makes `claim_task` atomic under
 * concurrent agents (M1 acceptance) and makes crash recovery safe: a stale lock
 * is detected by age and reclaimed with an audit note.
 */

import fs from 'node:fs'
import path from 'node:path'
import { MeshError, MESH_ERRORS } from './errors.ts'
import { ensureDir, exists, nowIso, sleepSync } from './fsx.ts'

export interface LockOptions {
  /** Give up after this long. */
  timeoutMs?: number
  /** A lock older than this is considered abandoned. */
  staleMs?: number
  /** Label recorded in the lock file, for diagnostics. */
  owner?: string
}

interface LockBody {
  pid: number
  at: string
  owner: string
  token: string
}

export class FileLock {
  readonly file: string
  readonly token: string
  private released = false

  private constructor(file: string, token: string) {
    this.file = file
    this.token = token
  }

  static acquire(file: string, opts: LockOptions = {}): FileLock {
    const timeoutMs = opts.timeoutMs ?? 15_000
    const staleMs = opts.staleMs ?? 60_000
    const token = `${process.pid}-${Math.random().toString(36).slice(2)}`
    ensureDir(path.dirname(file))
    const started = Date.now()
    let attempt = 0
    for (;;) {
      try {
        const fd = fs.openSync(file, 'wx')
        const body: LockBody = { pid: process.pid, at: nowIso(), owner: opts.owner ?? '', token }
        fs.writeSync(fd, JSON.stringify(body))
        fs.closeSync(fd)
        return new FileLock(file, token)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw e
        if (FileLock.reclaimIfStale(file, staleMs)) continue
        if (Date.now() - started > timeoutMs) {
          throw new MeshError(MESH_ERRORS.LOCK_TIMEOUT, `lock timeout on ${path.basename(file)}`, {
            file,
            waitedMs: Date.now() - started,
          })
        }
        attempt++
        sleepSync(Math.min(5 + attempt * 2, 50))
      }
    }
  }

  /** Remove the lock if its owner is gone or it has outlived `staleMs`. */
  static reclaimIfStale(file: string, staleMs: number): boolean {
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      return true // vanished: retry immediately
    }
    const age = Date.now() - stat.mtimeMs
    let body: LockBody | null = null
    try {
      body = JSON.parse(fs.readFileSync(file, 'utf8')) as LockBody
    } catch {
      body = null
    }
    const ownerDead = body ? !isProcessAlive(body.pid) : false
    if (age > staleMs || ownerDead) {
      try {
        fs.unlinkSync(file)
        return true
      } catch {
        return false
      }
    }
    return false
  }

  release(): void {
    if (this.released) return
    this.released = true
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const body = JSON.parse(raw) as LockBody
      if (body.token !== this.token) return // someone else owns it now
    } catch {
      return
    }
    try {
      fs.unlinkSync(this.file)
    } catch {
      /* already gone */
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // EPERM means the process exists but belongs to another user.
    return code === 'EPERM'
  }
}

/** Run `fn` while holding `file`. Always releases, including on throw. */
export function withLock<T>(file: string, fn: () => T, opts: LockOptions = {}): T {
  const lock = FileLock.acquire(file, opts)
  try {
    return fn()
  } finally {
    lock.release()
  }
}

export function lockExists(file: string): boolean {
  return exists(file)
}
