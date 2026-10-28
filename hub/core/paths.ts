/**
 * Canonical layout of the collaboration space (`.mesh/`).
 *
 * Every path the platform touches is derived here, so a project can be moved or
 * copied without rewriting cards. `.mesh/` is the platform's disk surface: the
 * only place the Hub writes, and the only place that is purely "platform".
 */

import fs from 'node:fs'
import path from 'node:path'
import { MESH_ERRORS, MeshError } from './errors.ts'
import { isDir, toPosix } from './fsx.ts'

export class MeshPaths {
  readonly root: string
  readonly meshDir: string

  constructor(root: string) {
    this.root = path.resolve(root)
    this.meshDir = path.join(this.root, '.mesh')
  }

  /** Walk up from `start` looking for an initialised mesh. */
  static discover(start: string = process.cwd()): MeshPaths {
    let dir = path.resolve(start)
    for (;;) {
      const candidate = new MeshPaths(dir)
      if (candidate.isInitialized()) return candidate
      const parent = path.dirname(dir)
      if (parent === dir) {
        throw new MeshError(MESH_ERRORS.NOT_INITIALIZED, 'no .mesh/ found in this directory or any parent; run `mesh init`', {
          start,
        })
      }
      dir = parent
    }
  }

  static tryDiscover(start: string = process.cwd()): MeshPaths | null {
    try {
      return MeshPaths.discover(start)
    } catch {
      return null
    }
  }

  isInitialized(): boolean {
    return fs.existsSync(path.join(this.meshDir, 'state.json'))
  }

  resolve(...segs: string[]): string {
    return path.join(this.meshDir, ...segs)
  }

  /** Repository-relative posix path for a file, for display and scope checks. */
  rel(abs: string): string {
    return toPosix(path.relative(this.root, abs))
  }

  // -- state ---------------------------------------------------------------
  get stateFile(): string {
    return this.resolve('state.json')
  }
  get decisionsFile(): string {
    return this.resolve('decisions.md')
  }
  get protocolSnapshot(): string {
    return this.resolve('PROTOCOL.snapshot.md')
  }

  // -- roles / agents / sessions ------------------------------------------
  get rolesDir(): string {
    return this.resolve('roles')
  }
  roleFile(role: string): string {
    return this.resolve('roles', `${role}.md`)
  }
  get agentsDir(): string {
    return this.resolve('agents')
  }
  agentFile(agentId: string): string {
    return this.resolve('agents', `${agentId}.json`)
  }
  get sessionsDir(): string {
    return this.resolve('sessions')
  }
  sessionFile(sessionId: string): string {
    return this.resolve('sessions', `${sessionId}.json`)
  }
  /** Per-session spawn scratch: generated patch files, prompts, stdout logs. */
  sessionScratch(sessionId: string): string {
    return this.resolve('sessions', sessionId)
  }
  get logsDir(): string {
    return this.resolve('logs')
  }
  sessionLog(sessionId: string): string {
    return this.resolve('logs', `${sessionId}.log`)
  }

  // -- missions (V2) -------------------------------------------------------
  get missionsDir(): string {
    return this.resolve('missions')
  }
  missionFile(missionId: string): string {
    return this.resolve('missions', `${missionId}.json`)
  }
  /** Per-mission bundle: report.md now, timeline/tasks/context in M4. */
  missionDir(missionId: string): string {
    return this.resolve('missions', missionId)
  }

  // -- board ---------------------------------------------------------------
  get tasksDir(): string {
    return this.resolve('board', 'tasks')
  }
  taskFile(taskId: string): string {
    return this.resolve('board', 'tasks', `${taskId}.json`)
  }
  get boardEvents(): string {
    return this.resolve('board', 'events.jsonl')
  }

  // -- messages ------------------------------------------------------------
  get messagesDir(): string {
    return this.resolve('messages')
  }
  get messageLog(): string {
    return this.resolve('messages', 'log.jsonl')
  }
  inboxDir(agentId: string): string {
    return this.resolve('messages', 'inbox', agentId)
  }
  inboxFile(agentId: string, msgId: string): string {
    return this.resolve('messages', 'inbox', agentId, `${msgId}.json`)
  }
  get deadLetterDir(): string {
    return this.resolve('messages', 'deadletter')
  }

  // -- context / artifacts -------------------------------------------------
  get contextDir(): string {
    return this.resolve('context')
  }
  contextFile(taskId: string): string {
    return this.resolve('context', `${taskId}.md`)
  }
  get artifactsDir(): string {
    return this.resolve('artifacts')
  }
  artifactFile(relpath: string): string {
    return path.join(this.artifactsDir, relpath.split('/').join(path.sep))
  }
  get artifactIndex(): string {
    return this.resolve('artifacts', 'index.jsonl')
  }

  // -- audit ---------------------------------------------------------------
  get auditDir(): string {
    return this.resolve('audit')
  }
  get violationsFile(): string {
    return this.resolve('audit', 'violations.log')
  }
  get auditEvents(): string {
    return this.resolve('audit', 'events.jsonl')
  }
  get mergesLog(): string {
    return this.resolve('audit', 'merges.jsonl')
  }
  get digestFile(): string {
    return this.resolve('audit', 'digest.md')
  }
  reviewsDir(taskId: string): string {
    return this.resolve('audit', 'reviews', taskId)
  }

  // -- sandboxes / locks ---------------------------------------------------
  get worktreesDir(): string {
    return this.resolve('worktrees')
  }
  worktree(taskId: string): string {
    return this.resolve('worktrees', taskId)
  }
  get locksDir(): string {
    return this.resolve('locks')
  }
  lockFile(name: string): string {
    return this.resolve('locks', `${name}.lock`)
  }

  /** Relative posix form of the worktree, as recorded on the TaskCard. */
  worktreeRel(taskId: string): string {
    return this.rel(this.worktree(taskId))
  }

  ensureLayout(): void {
    const dirs = [
      this.meshDir,
      this.rolesDir,
      this.agentsDir,
      this.sessionsDir,
      this.tasksDir,
      this.missionsDir,
      this.messagesDir,
      path.join(this.messagesDir, 'inbox'),
      this.deadLetterDir,
      this.contextDir,
      this.artifactsDir,
      this.auditDir,
      this.worktreesDir,
      this.locksDir,
      this.logsDir,
    ]
    for (const d of dirs) fs.mkdirSync(d, { recursive: true })
  }

  /** True when `abs` is inside the mesh directory (the Hub's own surface). */
  owns(abs: string): boolean {
    const rel = path.relative(this.meshDir, path.resolve(abs))
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  assertProjectDir(): void {
    if (!isDir(this.root)) {
      throw new MeshError(MESH_ERRORS.NOT_INITIALIZED, `project directory does not exist: ${this.root}`)
    }
  }
}
