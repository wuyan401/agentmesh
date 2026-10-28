/**
 * Read-only observability server (`mesh serve`).
 *
 * A JSON API plus static assets. Deliberately read-only: the platform's write
 * surface stays in the CLI and in the agent toolbelt, so nobody can change
 * platform state from a browser tab and dodge the audit trail. What this gives you
 * is the thing a team actually needs — the ability to *see* the board, the
 * sessions, the message bus and the audit log at a glance.
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { URL } from 'node:url'
import { scopeCheck } from '../core/mergeGate.ts'
import { PROTOCOL_QUICKREF } from '../core/protocol.ts'
import { loadConfig } from '../core/config.ts'
import { isProcessAlive } from '../core/lock.ts'
import type { Hub } from '../core/hub.ts'
import type { TaskCard } from '../core/types.ts'

export interface ServerOptions {
  hub: Hub
  port: number
  host: string
  /** Directory holding index.html/app.js/styles.css. */
  staticDir?: string
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

function taskView(hub: Hub, task: TaskCard) {
  const reviews = hub.store.listReviews(task.task_id)
  const sessions = hub.store.sessionsOfTask(task.task_id).slice(-4)
  let scope: ReturnType<typeof scopeCheck> | null = null
  try {
    if (task.base_commit && task.branch && hub.git.branchExists(task.branch)) scope = scopeCheck(hub.git, task)
  } catch {
    scope = null
  }
  return {
    ...task,
    history: task.history.slice(-12),
    review_records: reviews,
    sessions: sessions.map((s) => ({ session_id: s.session_id, agent_id: s.agent_id, role: s.role, status: s.status })),
    scope_check: scope
      ? { ok: scope.ok, out_of_scope: scope.out_of_scope, files: scope.files, checked: true }
      : { ok: true, out_of_scope: [], files: [], checked: false },
  }
}

export function startServer(opts: ServerOptions): Promise<{ server: http.Server; url: string }> {
  const { hub, port, host } = opts
  const staticDir = opts.staticDir ?? path.resolve(import.meta.dirname, '..', '..', 'web')

  const sendJson = (res: http.ServerResponse, status: number, value: unknown): void => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
    res.end(body)
  }

  const sendText = (res: http.ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8'): void => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(text)
  }

  const route = (url: URL, res: http.ServerResponse): void => {
    const p = url.pathname
    const q = url.searchParams

    if (p === '/api/overview') {
      const state = hub.store.getState()
      const summary = hub.board.summary()
      const sessions = hub.store.liveSessions()
      return sendJson(res, 200, {
        project: state.project,
        root: hub.paths.root,
        mesh_dir: hub.paths.meshDir,
        main_branch: state.main_branch,
        base_commit: state.base_commit,
        created_at: state.created_at,
        counts: summary.counts,
        total: summary.total,
        config: loadConfig(hub.paths),
        live_sessions: sessions.map((s) => ({
          session_id: s.session_id,
          agent_id: s.agent_id,
          role: s.role,
          task: s.task,
          status: s.status,
          pid: s.pid,
          alive: s.pid ? isProcessAlive(s.pid) : false,
          heartbeat: s.last_heartbeat_at,
          lifespan: s.lifespan,
          sandbox: s.sandbox,
        })),
        agents: hub.store.listAgents().map((a) => ({
          agent_id: a.agent_id,
          display_name: a.display_name,
          kind: a.kind,
          enabled: a.enabled,
          capabilities: a.capabilities,
          concurrency: a.concurrency,
          transport: a.transport,
          mcp_inject: a.mcp_inject,
          notes: a.notes,
        })),
        counts_by_role: hub.store.listTasks().reduce<Record<string, number>>((acc, t) => {
          acc[t.role] = (acc[t.role] ?? 0) + 1
          return acc
        }, {}),
        violations: hub.store.violations().length,
        merges: hub.store.merges().length,
        recent_violations: hub.store.violations().slice(-8),
        recent_merges: hub.store.merges().slice(-8),
      })
    }

    if (p === '/api/tasks') {
      const status = q.get('status')
      const tasks = hub.store.listTasks().filter((t) => !status || t.status === status)
      return sendJson(res, 200, { tasks: tasks.map((t) => taskView(hub, t)) })
    }

    if (p.startsWith('/api/tasks/')) {
      const id = p.slice('/api/tasks/'.length)
      const task = hub.store.getTask(id)
      if (!task) return sendJson(res, 404, { error: 'unknown task', task_id: id })
      return sendJson(res, 200, taskView(hub, task))
    }

    if (p === '/api/sessions') {
      const all = hub.store.listSessions()
      return sendJson(res, 200, {
        sessions: all
          .slice()
          .reverse()
          .map((s) => ({ ...s, alive: s.pid ? isProcessAlive(s.pid) : false, log: hub.paths.sessionLog(s.session_id) })),
      })
    }

    if (p.startsWith('/api/sessions/') && p.endsWith('/log')) {
      const id = p.slice('/api/sessions/'.length, -'/log'.length)
      const file = hub.paths.sessionLog(id)
      const lines = Number(q.get('lines') ?? 200)
      try {
        const text = fs.readFileSync(file, 'utf8')
        return sendJson(res, 200, { session_id: id, log: text.split('\n').slice(-lines).join('\n') })
      } catch {
        return sendJson(res, 404, { error: 'no log for session', session_id: id })
      }
    }

    if (p === '/api/audit') {
      return sendJson(res, 200, {
        violations: hub.store.violations().slice(-200),
        merges: hub.store.merges().slice(-200),
        reviews: hub.store.listReviews().slice(-100),
        events: hub.store.auditEvents().slice(-150),
        digest: safeRead(hub.paths.digestFile),
      })
    }

    if (p === '/api/messages') {
      const thread = q.get('thread')
      const log = hub.store.logMessages()
      const filtered = thread ? log.filter((m) => m.thread === thread || m.thread === '*') : log
      return sendJson(res, 200, { messages: filtered.slice(-300), dead: hub.store.deadLetters().slice(-50) })
    }

    if (p === '/api/artifacts') {
      const artifacts = hub.store.artifactIndexEntries()
      return sendJson(res, 200, {
        artifacts: artifacts.slice(-200),
        files: hub.store.listArtifacts(),
      })
    }

    if (p === '/api/decisions' || p === '/api/protocol' || p === '/api/context') {
      const file =
        p === '/api/decisions'
          ? hub.paths.decisionsFile
          : p === '/api/protocol'
            ? hub.paths.protocolSnapshot
            : null
      if (p === '/api/context') {
        const id = q.get('task') ?? ''
        const ctx = id ? safeRead(hub.paths.contextFile(id)) : null
        return sendJson(res, 200, { task: id, context: ctx })
      }
      return sendJson(res, 200, { path: file, markdown: file ? safeRead(file) : PROTOCOL_QUICKREF })
    }

    if (p === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      const tick = (): void => {
        const summary = hub.board.summary()
        const live = hub.store.liveSessions().length
        res.write(`data: ${JSON.stringify({ at: new Date().toISOString(), counts: summary.counts, live })}\n\n`)
      }
      tick()
      const timer = setInterval(tick, 3000)
      res.on('close', () => clearInterval(timer))
      return
    }

    // -- static ------------------------------------------------------------
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '')
    const file = path.resolve(staticDir, rel)
    if (!file.startsWith(path.resolve(staticDir))) {
      return sendText(res, 403, 'forbidden')
    }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file).toLowerCase()
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
      return void fs.createReadStream(file).pipe(res)
    }
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found', path: p })
    return sendText(res, 404, 'dashboard assets missing: expected web/index.html next to the package', 'text/plain; charset=utf-8')
  }

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`)
      route(url, res)
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message })
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      resolve({ server, url: `http://${host}:${port}` })
    })
  })
}

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
