/**
 * Observability server (`mesh serve`).
 *
 * A JSON API plus static assets. Almost entirely read-only on purpose: the platform's
 * write surface lives in the CLI and in the agent toolbelt, so nobody can change
 * platform state from a browser tab and dodge the audit trail. What this gives you is
 * the thing a team actually needs — the ability to *see* the board, the sessions, the
 * message bus and the audit log at a glance.
 *
 * One deliberate exception (V2 §5): `POST /api/missions`. Publishing a mission is the
 * same first-class action as `mesh mission`, attributed the same way (a mesh-human
 * session, `source: platform`); the endpoint creates the mission and its lead session
 * and returns immediately, leaving the planning turn to the daemon.
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { URL } from 'node:url'
import { scopeCheck } from '../core/mergeGate.ts'
import { PROTOCOL_QUICKREF } from '../core/protocol.ts'
import { loadConfig } from '../core/config.ts'
import { isProcessAlive } from '../core/lock.ts'
import { MeshError, MESH_ERRORS } from '../core/errors.ts'
import { humanIdentity } from '../../cli/human.ts'
import { Scheduler } from '../scheduler/scheduler.ts'
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
    sessions: sessions.map((s) => ({
      // Same shape as /api/sessions. This endpoint used to send a stripped
      // {session_id, agent_id, role, status}, so the detail views — which share one
      // renderer with the sessions page — printed "no heartbeat / no task" wherever the
      // extra fields were missing.
      session_id: s.session_id,
      agent_id: s.agent_id,
      role: s.role,
      task: s.task,
      status: s.status,
      lifespan: s.lifespan,
      spawned_by: s.spawned_by,
      pid: s.pid,
      created_at: s.created_at,
      last_heartbeat_at: s.last_heartbeat_at,
      is_lead: s.is_lead,
      mission: s.mission,
      turns: s.turns,
      exit: s.exit,
    })),
    scope_check: scope
      ? { ok: scope.ok, out_of_scope: scope.out_of_scope, files: scope.files, checked: true }
      : { ok: true, out_of_scope: [], files: [], checked: false },
  }
}

const MISSION_BODY_LIMIT = 64 * 1024

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MISSION_BODY_LIMIT) {
        reject(new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'request body too large', { limit_bytes: MISSION_BODY_LIMIT }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'body must be valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

interface WebMissionInput {
  title: string
  brief: string
  acceptance: string[]
  lead_agent: string | null
}

/**
 * Validate the publish payload.
 *
 * Deliberately mirrors `mesh mission "…"` rather than inventing a second vocabulary:
 * title is the positional there, brief falls back to it, acceptance repeats.
 */
function normalizeMissionBody(body: unknown): WebMissionInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'body must be a JSON object', {
      hint: 'POST {"title": "…", "brief": "…", "acceptance": ["…"], "lead_agent": "dsh-01"}',
    })
  }
  const b = body as Record<string, unknown>
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (!title) {
    throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'title is required', {
      field: 'title',
      hint: '给任务起个名字：{"title": "做什么"}',
    })
  }
  const briefRaw = typeof b.brief === 'string' ? b.brief.trim() : ''
  const brief = briefRaw || title

  let acceptance: string[] = []
  if (Array.isArray(b.acceptance)) {
    acceptance = b.acceptance.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
  } else if (typeof b.acceptance === 'string') {
    acceptance = b.acceptance.split('\n').map((x) => x.trim()).filter(Boolean)
  }

  const leadRaw = typeof b.lead_agent === 'string' ? b.lead_agent.trim() : ''
  return { title, brief, acceptance, lead_agent: leadRaw || null }
}

/**
 * `POST /api/missions` — publish a mission from the dashboard.
 *
 * Same three steps as the CLI entry (`createAndStart`): act as the human operator,
 * create the mission with `source: platform`, then open a real lead session when the
 * lead is an agent. The planning turn itself is *not* awaited here — that is the
 * CLI's synchronous driver and would time an HTTP request out; `mesh up` advances it.
 */
async function publishMission(hub: Hub, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const sendJson = (status: number, value: unknown): void => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
    res.end(JSON.stringify(value))
  }
  try {
    const input = normalizeMissionBody(await readJsonBody(req))
    const { identity, session_id } = humanIdentity(hub, 'planner')
    const mission = hub.missions.createMission(
      {
        title: input.title,
        brief: input.brief,
        acceptance: input.acceptance,
        lead_agent: input.lead_agent,
        source: 'platform',
      },
      identity,
    )
    const leadAgent = hub.store.requireAgent(mission.lead_agent)
    let leadSessionId: string | null = null
    let leadTurn = 'not_applicable'
    // A builtin lead (the human / the kernel) is not spawned: there is no process to start.
    if (leadAgent.kind !== 'builtin') {
      const session = hub.missions.createLeadSession(mission.mission_id, { spawned_by: 'web.mission' })
      leadSessionId = session.session_id
      // Spawn the planning turn on *this* session, not "some session later".
      //
      // The daemon's dispatchLeadTurns() always makes a fresh session for a mission
      // that still needs a lead, so leaving it to the daemon would hand the mission a
      // different session id than the one we just returned to the browser — the UI
      // would then point at a session that never runs. spawnLeadTurn() only launches
      // the process (it does not wait for the turn), which is exactly the CLI's
      // behaviour without the blocking wait. If it fails, the mission stays `intake`
      // and the daemon retries on its own.
      try {
        new Scheduler(hub).spawnLeadTurn(mission, 'planning', session)
        leadTurn = 'spawned'
      } catch (e) {
        leadTurn = `deferred: ${e instanceof MeshError ? String(e.code) : (e as Error).message}`
      }
    }
    sendJson(201, {
      mission_id: mission.mission_id,
      lead_session_id: leadSessionId,
      lead_turn: leadTurn,
      status: mission.status,
      lead_agent: mission.lead_agent,
      source: mission.source,
      created_by: session_id,
    })
  } catch (e) {
    if (e instanceof MeshError) {
      const code = String(e.code)
      const badInput = code === MESH_ERRORS.SCHEMA_INVALID || code === MESH_ERRORS.CAPABILITY_MISSING || code === MESH_ERRORS.ROLE_FORBIDDEN
      sendJson(badInput ? 400 : 500, {
        error: badInput ? 'invalid_mission' : 'mission_failed',
        code,
        message: e.message,
        ...e.detail,
      })
      return
    }
    sendJson(500, { error: 'mission_failed', message: (e as Error).message })
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
        agents: hub.store.listAgents().map((a) => {
          // The profile is what the platform actually scores on: nine dimensions, the
          // manual lock, and the peer reviews other agents wrote. All of it already
          // exists on disk — the dashboard just never surfaced it.
          let profile: unknown = null
          try {
            profile = hub.profiles.view(a.agent_id)
          } catch {
            profile = null
          }
          return {
            agent_id: a.agent_id,
            display_name: a.display_name,
            kind: a.kind,
            enabled: a.enabled,
            capabilities: a.capabilities,
            concurrency: a.concurrency,
            transport: a.transport,
            mcp_inject: a.mcp_inject,
            notes: a.notes,
            profile,
            dimensions: (() => {
              try {
                return hub.profiles.dimensionValues(a.agent_id)
              } catch {
                return []
              }
            })(),
            success_rate: (() => {
              try {
                return hub.profiles.successRate(a.agent_id)
              } catch {
                return null
              }
            })(),
          }
        }),
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

    // -- missions (V2 §4.3) ------------------------------------------------
    if (p === '/api/missions') {
      return sendJson(res, 200, {
        missions: hub.missions.listSummaries(),
        history: hub.paths.rel(hub.paths.historyFile),
        history_exists: fs.existsSync(hub.paths.historyFile),
      })
    }

    if (p.startsWith('/api/missions/')) {
      const id = decodeURIComponent(p.slice('/api/missions/'.length))
      const mission = hub.store.getMission(id)
      if (!mission) return sendJson(res, 404, { error: 'no such mission', mission_id: id })
      return sendJson(res, 200, hub.missions.detail(id))
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
      if (url.pathname === '/api/missions' && req.method === 'POST') {
        void publishMission(hub, req, res)
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, {
          error: 'method_not_allowed',
          method: req.method,
          hint: '观察台只读，唯一的写入口是 POST /api/missions',
        })
        return
      }
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
