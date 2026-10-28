/**
 * MeshStore — the file-backed repository.
 *
 * Cards are individual JSON files (diffable, crash-safe, one writer per lock);
 * the message log, board events and audit trail are append-only JSONL. There is
 * no hidden in-memory authority: any process can be killed at any point and the
 * next one reads the same truth from disk.
 */

import path from 'node:path'
import fs from 'node:fs'
import { MeshPaths } from './paths.ts'
import { MeshError, MESH_ERRORS } from './errors.ts'
import { appendJsonl, ensureDir, exists, listFiles, nowIso, pad, readJson, readJsonIfExists, readJsonl, sha256, writeFileAtomic, writeJsonAtomic } from './fsx.ts'
import { withLock } from './lock.ts'
import { assertValid } from './schema.ts'
import type { AgentCard, Message, MeshState, ReviewRecord, SessionCard, TaskCard, ViolationRecord } from './types.ts'

export type IdKind = 'task' | 'message' | 'session' | 'review' | 'violation'

const ID_PREFIX: Record<IdKind, string> = {
  task: 'T',
  message: 'M',
  session: 'S',
  review: 'R',
  violation: 'V',
}

const ID_WIDTH: Record<IdKind, number> = { task: 6, message: 6, session: 6, review: 4, violation: 6 }

export class MeshStore {
  readonly paths: MeshPaths

  constructor(paths: MeshPaths) {
    this.paths = paths
  }

  // -- state ---------------------------------------------------------------

  getState(): MeshState {
    const state = readJsonIfExists<MeshState>(this.paths.stateFile)
    if (!state) {
      throw new MeshError(MESH_ERRORS.NOT_INITIALIZED, 'state.json missing; run `mesh init`', { root: this.paths.root })
    }
    return state
  }

  saveState(state: MeshState): void {
    writeJsonAtomic(this.paths.stateFile, state)
  }

  updateState(mutate: (s: MeshState) => void): MeshState {
    return withLock(this.paths.lockFile('state'), () => {
      const state = this.getState()
      mutate(state)
      this.saveState(state)
      return state
    }, { owner: 'state' })
  }

  /**
   * Allocate the next id of a kind. Serialised by the counter lock, so two
   * concurrent claims can never receive the same task/message/session id.
   */
  nextId(kind: IdKind): string {
    return withLock(
      this.paths.lockFile('counter'),
      () => {
        const state = this.getState()
        const counters = state.counters as Record<IdKind, number>
        const next = (counters[kind] ?? 0) + 1
        counters[kind] = next
        this.saveState(state)
        return `${ID_PREFIX[kind]}-${pad(next, ID_WIDTH[kind])}`
      },
      { owner: `counter:${kind}` },
    )
  }

  // -- tasks ---------------------------------------------------------------

  listTasks(): TaskCard[] {
    const out: TaskCard[] = []
    for (const file of listFiles(this.paths.tasksDir, '.json')) {
      const card = readJsonIfExists<TaskCard>(file)
      if (card) out.push(card)
    }
    // Sort by numeric id so boards read chronologically.
    out.sort((a, b) => a.task_id.localeCompare(b.task_id))
    return out
  }

  getTask(taskId: string): TaskCard | null {
    return readJsonIfExists<TaskCard>(this.paths.taskFile(taskId))
  }

  requireTask(taskId: string): TaskCard {
    const card = this.getTask(taskId)
    if (!card) throw new MeshError(MESH_ERRORS.UNKNOWN_ENTITY, `unknown task: ${taskId}`, { task_id: taskId })
    return card
  }

  saveTask(card: TaskCard): void {
    assertValid('task', card, card.task_id)
    card.updated_at = nowIso()
    writeJsonAtomic(this.paths.taskFile(card.task_id), card)
  }

  deleteTask(taskId: string): void {
    fs.rmSync(this.paths.taskFile(taskId), { force: true })
  }

  // -- agents --------------------------------------------------------------

  listAgents(): AgentCard[] {
    const out: AgentCard[] = []
    for (const file of listFiles(this.paths.agentsDir, '.json')) {
      const card = readJsonIfExists<AgentCard>(file)
      if (card) out.push(card)
    }
    out.sort((a, b) => a.agent_id.localeCompare(b.agent_id))
    return out
  }

  getAgent(agentId: string): AgentCard | null {
    return readJsonIfExists<AgentCard>(this.paths.agentFile(agentId))
  }

  requireAgent(agentId: string): AgentCard {
    const card = this.getAgent(agentId)
    if (!card) throw new MeshError(MESH_ERRORS.UNKNOWN_ENTITY, `unknown agent: ${agentId}`, { agent_id: agentId })
    return card
  }

  saveAgent(card: AgentCard): void {
    assertValid('agent', card, card.agent_id)
    writeJsonAtomic(this.paths.agentFile(card.agent_id), card)
  }

  removeAgent(agentId: string): void {
    fs.rmSync(this.paths.agentFile(agentId), { force: true })
  }

  // -- sessions ------------------------------------------------------------

  listSessions(): SessionCard[] {
    const out: SessionCard[] = []
    for (const file of listFiles(this.paths.sessionsDir, '.json')) {
      const card = readJsonIfExists<SessionCard>(file)
      if (card) out.push(card)
    }
    out.sort((a, b) => a.session_id.localeCompare(b.session_id))
    return out
  }

  getSession(sessionId: string): SessionCard | null {
    return readJsonIfExists<SessionCard>(this.paths.sessionFile(sessionId))
  }

  requireSession(sessionId: string): SessionCard {
    const card = this.getSession(sessionId)
    if (!card) {
      throw new MeshError(MESH_ERRORS.SESSION_UNKNOWN, `unknown session: ${sessionId}`, { session_id: sessionId })
    }
    return card
  }

  saveSession(card: SessionCard): void {
    assertValid('session', card, card.session_id)
    writeJsonAtomic(this.paths.sessionFile(card.session_id), card)
  }

  /** Sessions that could still act: registered, hello'd, not exited. */
  liveSessions(): SessionCard[] {
    return this.listSessions().filter((s) => s.status === 'active' || s.status === 'starting')
  }

  sessionsOfAgent(agentId: string): SessionCard[] {
    return this.listSessions().filter((s) => s.agent_id === agentId)
  }

  activeSessionsOfAgent(agentId: string): SessionCard[] {
    return this.liveSessions().filter((s) => s.agent_id === agentId)
  }

  sessionsOfTask(taskId: string): SessionCard[] {
    return this.listSessions().filter((s) => s.task === taskId)
  }

  // -- messages ------------------------------------------------------------

  appendMessage(msg: Message): void {
    assertValid('message', msg, msg.msg_id)
    appendJsonl(this.paths.messageLog, msg)
  }

  logMessages(): Message[] {
    return readJsonl<Message>(this.paths.messageLog)
  }

  /** Delivering to an inbox is idempotent: the filename is the msg_id. */
  deliver(agentId: string, msg: Message): void {
    const dir = this.paths.inboxDir(agentId)
    ensureDir(dir)
    writeJsonAtomic(this.paths.inboxFile(agentId, msg.msg_id), msg)
  }

  inbox(agentId: string, opts: { since?: string; unreadOnly?: boolean } = {}): Message[] {
    const dir = this.paths.inboxDir(agentId)
    const out: Message[] = []
    for (const file of listFiles(dir, '.json')) {
      const msg = readJsonIfExists<Message>(file)
      if (!msg) continue
      if (opts.unreadOnly && msg.read_at) continue
      if (opts.since && msg.created_at < opts.since) continue
      out.push(msg)
    }
    out.sort((a, b) => a.created_at.localeCompare(b.created_at))
    return out
  }

  markRead(agentId: string, msgId: string, sessionId: string): Message | null {
    const file = this.paths.inboxFile(agentId, msgId)
    const msg = readJsonIfExists<Message>(file)
    if (!msg) return null
    if (!msg.read_at) {
      msg.read_at = nowIso()
      msg.read_by = sessionId
      msg.status = 'read'
      writeJsonAtomic(file, msg)
    }
    return msg
  }

  moveToDeadLetter(agentId: string, msg: Message, reason: string): void {
    ensureDir(this.paths.deadLetterDir)
    const dead: Message & { dead_reason: string; dead_at: string } = {
      ...msg,
      status: 'dead',
      dead_reason: reason,
      dead_at: nowIso(),
    }
    writeJsonAtomic(path.join(this.paths.deadLetterDir, `${msg.msg_id}.json`), dead)
    fs.rmSync(this.paths.inboxFile(agentId, msg.msg_id), { force: true })
  }

  deadLetters(): Array<Message & { dead_reason?: string; dead_at?: string }> {
    const out: Array<Message & { dead_reason?: string; dead_at?: string }> = []
    for (const file of listFiles(this.paths.deadLetterDir, '.json')) {
      const msg = readJsonIfExists<Message & { dead_reason?: string; dead_at?: string }>(file)
      if (msg) out.push(msg)
    }
    out.sort((a, b) => String(a.dead_at).localeCompare(String(b.dead_at)))
    return out
  }

  // -- reviews -------------------------------------------------------------

  saveReview(rec: ReviewRecord): void {
    const dir = this.paths.reviewsDir(rec.task_id)
    ensureDir(dir)
    writeJsonAtomic(path.join(dir, `${rec.review_id}.json`), rec)
  }

  listReviews(taskId?: string): ReviewRecord[] {
    const dirs = taskId ? [this.paths.reviewsDir(taskId)] : listFiles(this.paths.auditDir, '') && this.reviewDirs()
    const out: ReviewRecord[] = []
    for (const dir of dirs) {
      for (const file of listFiles(dir, '.json')) {
        const rec = readJsonIfExists<ReviewRecord>(file)
        if (rec) out.push(rec)
      }
    }
    out.sort((a, b) => a.at.localeCompare(b.at))
    return out
  }

  private reviewDirs(): string[] {
    const base = path.join(this.paths.auditDir, 'reviews')
    if (!exists(base)) return []
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(base, d.name))
  }

  // -- audit ---------------------------------------------------------------

  recordViolation(v: ViolationRecord): void {
    appendJsonl(this.paths.violationsFile, v)
  }

  violations(): ViolationRecord[] {
    return readJsonl<ViolationRecord>(this.paths.violationsFile)
  }

  auditEvent(event: string, data: Record<string, unknown>): void {
    appendJsonl(this.paths.auditEvents, { at: nowIso(), event, ...data })
  }

  auditEvents(): Array<Record<string, unknown>> {
    return readJsonl<Record<string, unknown>>(this.paths.auditEvents)
  }

  appendMerge(record: Record<string, unknown>): void {
    appendJsonl(this.paths.mergesLog, { at: nowIso(), ...record })
  }

  merges(): Array<Record<string, unknown>> {
    return readJsonl<Record<string, unknown>>(this.paths.mergesLog)
  }

  boardEvent(event: Record<string, unknown>): void {
    appendJsonl(this.paths.boardEvents, { at: nowIso(), ...event })
  }

  // -- misc ----------------------------------------------------------------

  readArtifact(relpath: string): string | null {
    const file = this.paths.artifactFile(relpath)
    if (!exists(file)) return null
    return fs.readFileSync(file, 'utf8')
  }

  /** Channel C: store a non-code deliverable, content-addressed and indexed. */
  putArtifact(
    relpath: string,
    content: string,
    meta: { session_id: string; role: string; task_id: string | null },
  ): { path: string; sha256: string; bytes: number } {
    const file = this.paths.artifactFile(relpath)
    ensureDir(path.dirname(file))
    writeFileAtomic(file, content)
    const hash = sha256(content)
    const bytes = Buffer.byteLength(content, 'utf8')
    appendJsonl(this.paths.artifactIndex, {
      relpath,
      sha256: hash,
      bytes,
      created_at: nowIso(),
      session_id: meta.session_id,
      role: meta.role,
      task_id: meta.task_id,
    })
    return { path: relpath, sha256: hash, bytes }
  }

  artifactIndexEntries(): Array<Record<string, unknown>> {
    return readJsonl<Record<string, unknown>>(this.paths.artifactIndex)
  }

  listArtifacts(): string[] {
    return listFiles(this.paths.artifactsDir, '').filter((f) => !f.endsWith('index.jsonl')).map((f) => this.paths.rel(f))
  }
}
