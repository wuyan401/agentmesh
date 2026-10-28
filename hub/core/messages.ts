/**
 * The message bus (C8: every cross-agent message goes through the Hub).
 *
 * Addressing is by *role thread*, never by agent: `to: {role, thread}`. The Hub
 * resolves the current holder of that role and delivers into their inbox. When
 * nobody holds the role yet the message waits in a role queue and is flushed to
 * whoever takes the role next — that is what makes "roles change hands without
 * losing context" true in practice.
 *
 * Delivery is dual-channel: a JSON file in `.mesh/messages/inbox/<agent>/` for
 * agents on the file protocol, plus a long-poll (`hub.wait_messages`) for live
 * MCP sessions. Either channel alone is enough to make progress (T5).
 */

import path from 'node:path'
import fs from 'node:fs'
import { MeshError, MESH_ERRORS } from './errors.ts'
import { ensureDir, exists, listFiles, nowIso, readJsonIfExists, sha256, writeJsonAtomic } from './fsx.ts'
import { validateMessage } from './schema.ts'
import type { Identity } from './identity.ts'
import type { MeshStore } from './store.ts'
import type { Message, MessageAttachment, MessageEndpoint, MessageType, RoleId, SessionCard } from './types.ts'
import { ROLE_IDS } from './types.ts'

const INLINE_LIMIT = 32 * 1024
export const DEFAULT_TTL_SECONDS = 30 * 60

export interface SendInput {
  to: MessageEndpoint
  type: MessageType
  body: string
  ttl_seconds?: number
  attachments?: Array<{ abs_path: string; inline?: boolean }>
}

export class MessageBus {
  readonly store: MeshStore

  constructor(store: MeshStore) {
    this.store = store
  }

  /** Role queues hold messages addressed to a role that has no live holder. */
  private pendingDir(role: RoleId): string {
    return this.store.paths.resolve('messages', 'pending', role)
  }

  buildAttachments(files: Array<{ abs_path: string; inline?: boolean }> = []): MessageAttachment[] {
    return files.map((f) => {
      const abs = path.resolve(f.abs_path)
      const data = fs.readFileSync(abs)
      const inline = f.inline ?? data.byteLength < INLINE_LIMIT
      const rel = this.store.paths.rel(abs)
      const att: MessageAttachment = {
        path: rel,
        sha256: sha256(data),
        bytes: data.byteLength,
        inline,
      }
      if (inline && data.byteLength < INLINE_LIMIT) att.text = data.toString('utf8')
      return att
    })
  }

  /**
   * Send a message. The sender identity is verified (never a claimed string), the
   * recipient must be a role+thread (never an agent id: C8).
   */
  send(from: Identity, input: SendInput): Message {
    if (!ROLE_IDS.includes(input.to.role)) {
      throw new MeshError(MESH_ERRORS.BUS_BYPASS, `messages must be addressed to a role thread, not "${String(input.to.role)}"`, {
        hint: 'point-to-point addressing is forbidden (C8); use to: {role, thread}',
      })
    }
    const ttl = input.ttl_seconds ?? DEFAULT_TTL_SECONDS
    const now = Date.now()
    const msgId = this.store.nextId('message')
    const msg: Message = {
      msg_id: msgId,
      from: { agent: from.agent.agent_id, session: from.session.session_id, role: from.session.role },
      to: { role: input.to.role, thread: input.to.thread || '*'},
      type: input.type,
      body: input.body,
      attachments: this.buildAttachments(input.attachments),
      thread: input.to.thread || '*',
      ttl_seconds: ttl,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttl * 1000).toISOString(),
      resolved: null,
      read_at: null,
      read_by: null,
      status: 'queued',
    }
    const errors = validateMessage(msg)
    if (errors.length > 0) {
      throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `invalid message: ${errors.join('; ')}`, { errors })
    }
    const holder = this.resolve(input.to.role, msg.thread)
    if (holder) msg.resolved = { agent_id: holder.agent_id, session_id: holder.session_id }
    this.store.appendMessage(msg)
    this.store.auditEvent('message.sent', {
      msg_id: msg.msg_id,
      from: msg.from.agent,
      to_role: msg.to.role,
      thread: msg.thread,
      type: msg.type,
      resolved: msg.resolved,
    })
    if (holder) {
      this.store.deliver(holder.agent_id, msg)
    } else {
      // Nobody holds the role yet: queue it for the next holder.
      const dir = this.pendingDir(input.to.role)
      ensureDir(dir)
      writeJsonAtomic(path.join(dir, `${msg.msg_id}.json`), msg)
    }
    return msg
  }

  /** Current holder of a role thread. Supervisor/integrator may hold for many tasks. */
  resolve(role: RoleId, thread: string): SessionCard | null {
    const live = this.store.liveSessions().filter((s) => s.role === role)
    if (live.length === 0) return null
    const exact = live.filter((s) => s.task === thread)
    if (exact.length > 0) return exact.sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
    const anyTask = live.filter((s) => s.task === null)
    if (anyTask.length > 0) return anyTask.sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
    return thread === '*' ? (live.sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null) : null
  }

  /** Flush queued role messages to a Session that just took the role. */
  flushPendingFor(session: SessionCard): number {
    const dir = this.pendingDir(session.role)
    if (!exists(dir)) return 0
    let delivered = 0
    for (const file of listFiles(dir, '.json')) {
      const msg = readJsonIfExists<Message>(file)
      if (!msg) continue
      // A task-less holder of a daemon role serves every thread (mirrors resolve()).
      const threadOk = msg.thread === '*' || msg.thread === session.task || session.task === null
      if (!threadOk) continue
      msg.resolved = { agent_id: session.agent_id, session_id: session.session_id }
      this.store.deliver(session.agent_id, msg)
      fs.rmSync(file, { force: true })
      delivered++
    }
    return delivered
  }

  read(agentId: string, sessionId: string, opts: { since?: string; unreadOnly?: boolean; markRead?: boolean } = {}): Message[] {
    const msgs = this.store.inbox(agentId, { since: opts.since, unreadOnly: opts.unreadOnly ?? true })
    if (opts.markRead !== false) {
      for (const m of msgs) {
        const updated = this.store.markRead(agentId, m.msg_id, sessionId)
        if (updated) {
          m.read_at = updated.read_at
          m.status = 'read'
        }
      }
    }
    return msgs
  }

  /**
   * Long-poll for live daemon sessions. MCP tool calls time out around 60s, so
   * the cap keeps the channel usable; agents loop as needed.
   */
  async wait(agentId: string, sessionId: string, timeoutMs = 20_000, since?: string): Promise<Message[]> {
    const deadline = Date.now() + Math.min(timeoutMs, 45_000)
    for (;;) {
      const pending = this.store.inbox(agentId, { unreadOnly: true, since })
      if (pending.length > 0) return this.read(agentId, sessionId, { since })
      if (Date.now() >= deadline) return []
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  /** Expire unanswered messages into the dead-letter queue. Never drops silently. */
  sweep(now: number = Date.now()): { dead: number } {
    let dead = 0
    for (const agent of this.store.listAgents()) {
      for (const msg of this.store.inbox(agent.agent_id, { unreadOnly: true })) {
        if (Date.parse(msg.expires_at) < now) {
          this.store.moveToDeadLetter(agent.agent_id, msg, 'ttl expired before delivery/read')
          this.store.auditEvent('message.dead', {
            msg_id: msg.msg_id,
            agent_id: agent.agent_id,
            to_role: msg.to.role,
            thread: msg.thread,
          })
          dead++
        }
      }
    }
    // Pending role queues expire too — otherwise a dead role accumulates forever.
    const pendingRoot = this.store.paths.resolve('messages', 'pending')
    for (const file of listFiles(pendingRoot, '.json')) {
      const msg = readJsonIfExists<Message>(file)
      if (!msg) continue
      if (Date.parse(msg.expires_at) < now) {
        fs.rmSync(file, { force: true })
        this.store.auditEvent('message.dead', { msg_id: msg.msg_id, to_role: msg.to.role, thread: msg.thread, queued: true })
        dead++
      }
    }
    return { dead }
  }

  /** Convenience: notify whichever coordinator is on duty. */
  notifyCoordinator(from: Identity, type: MessageType, body: string, thread = '*'): Message | null {
    try {
      return this.send(from, { to: { role: 'coordinator', thread }, type, body })
    } catch {
      return null
    }
  }

  threadHistory(thread: string): Message[] {
    return this.store.logMessages().filter((m) => m.thread === thread)
  }
}
