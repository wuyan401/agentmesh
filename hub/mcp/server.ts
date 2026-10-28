#!/usr/bin/env node
/**
 * AgentMesh MCP server (`+hub` injection).
 *
 * Speaks MCP over stdio: newline-delimited JSON-RPC 2.0, no framing, stdout is
 * protocol only and every diagnostic goes to stderr. Written against the wire
 * format directly so the platform has no runtime dependency it could fail to
 * install — the hub must boot on any machine that has Node.
 *
 * The server is spawned *per P-Session*, injected through the agent's own MCP
 * configuration. It learns who it is serving from `MESH_SESSION_ID`, so a session
 * that is not registered cannot do anything with it.
 */

import readline from 'node:readline'
import path from 'node:path'
import { Hub } from '../core/hub.ts'
import { HubApi, toErrorResult } from '../core/api.ts'
import { MeshError, MESH_ERRORS } from '../core/errors.ts'
import { isRoleId } from '../roles/cards.ts'
import type { ApiResult } from '../core/api.ts'

const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2026-07-14']
const DEFAULT_PROTOCOL = '2025-06-18'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (api: HubApi, sessionId: string, args: Record<string, unknown>) => ApiResult | Promise<ApiResult>
}

const str = (description: string) => ({ type: 'string', description })
const num = (description: string) => ({ type: 'number', description })
const bool = (description: string) => ({ type: 'boolean', description })
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

function arg(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `missing required string argument: ${key}`, { argument: key })
  }
  return v
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

const TOOLS: ToolDef[] = [
  {
    name: 'hello',
    description:
      'Register this session with the hub and receive your role card. Call this first: before hello() a session holds no rights at all.',
    inputSchema: obj({ session_id: str('optional; defaults to MESH_SESSION_ID from the environment') }),
    handler: (api, session, args) => api.hello(optStr(args, 'session_id') ?? session),
  },
  {
    name: 'whoami',
    description: 'Return the identity this session is bound to (role, task, sandbox, deadline).',
    inputSchema: obj({}),
    handler: (api, session) => api.whoami(session),
  },
  {
    name: 'heartbeat',
    description: 'Extend this session lease. Long-running work should call it periodically.',
    inputSchema: obj({}),
    handler: (api, session) => api.heartbeat(session),
  },
  {
    name: 'get_board',
    description:
      'Task board snapshot. Workers see tasks on their own role thread; coordinators/supervisors/integrators see everything.',
    inputSchema: obj({
      status: str('filter by status, e.g. "ready" or a comma list'),
      role: str('filter by role'),
    }),
    handler: (api, session, args) => {
      const statusRaw = optStr(args, 'status')
      const roleRaw = optStr(args, 'role')
      const filter: { status?: string | string[]; role?: string } = {}
      if (statusRaw) filter.status = statusRaw.includes(',') ? statusRaw.split(',').map((s) => s.trim()) : statusRaw
      if (roleRaw) {
        if (!isRoleId(roleRaw)) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `unknown role: ${roleRaw}`)
        filter.role = roleRaw
      }
      return api.get_board(session, filter as never)
    },
  },
  {
    name: 'get_task',
    description: 'Full task card: scope, acceptance criteria, submission, reviews and history.',
    inputSchema: obj({ task_id: str('task id, e.g. T-000042') }, ['task_id']),
    handler: (api, session, args) => api.get_task(session, arg(args, 'task_id')),
  },
  {
    name: 'claim_task',
    description:
      'Atomically claim a ready task and receive the path of its context package. Fails if someone else already holds it.',
    inputSchema: obj({
      task_id: str('task id'),
      context_level: str('minimal | standard | full (default standard)'),
    }, ['task_id']),
    handler: (api, session, args) =>
      api.claim_task(session, arg(args, 'task_id'), {
        contextLevel: (optStr(args, 'context_level') as never) ?? 'standard',
      }),
  },
  {
    name: 'get_context',
    description: 'Regenerate this task\'s context package at a chosen level (minimal/standard/full).',
    inputSchema: obj({ task_id: str('task id'), level: str('minimal | standard | full') }, ['task_id']),
    handler: (api, session, args) =>
      api.get_context(session, arg(args, 'task_id'), (optStr(args, 'level') as never) ?? 'standard'),
  },
  {
    name: 'report_progress',
    description: 'Report progress percentage and optional blockers to the coordinator.',
    inputSchema: obj({ task_id: str('task id'), pct: num('0-100'), blockers: str('optional blocker text') }, ['task_id', 'pct']),
    handler: (api, session, args) =>
      api.report_progress(session, arg(args, 'task_id'), Number(args['pct'] ?? 0), optStr(args, 'blockers')),
  },
  {
    name: 'request_clarification',
    description:
      'Ask the coordinator a question about a task. Ask instead of guessing — but keep working on what does not block.',
    inputSchema: obj({ task_id: str('task id'), question: str('the question') }, ['task_id', 'question']),
    handler: (api, session, args) => api.request_clarification(session, arg(args, 'task_id'), arg(args, 'question')),
  },
  {
    name: 'escalate',
    description:
      'Report an out-of-scope need or a blocker to the coordinator. This is a report, not a stop: keep working inside your scope. Set block=true only when you truly cannot continue.',
    inputSchema: obj({
      reason: str('what is needed and why'),
      task_id: str('optional task id'),
      block: bool('mark the task blocked and stop working (default false)'),
    }, ['reason']),
    handler: (api, session, args) =>
      api.escalate(session, arg(args, 'reason'), optStr(args, 'task_id'), { block: args['block'] === true }),
  },
  {
    name: 'submit',
    description:
      'Submit your committed work for review. Your task branch must be committed and clean. An approved review is required before anything merges.',
    inputSchema: obj({ task_id: str('task id'), summary: str('what changed and how it satisfies acceptance') }, ['task_id', 'summary']),
    handler: (api, session, args) => api.submit(session, arg(args, 'task_id'), arg(args, 'summary')),
  },
  {
    name: 'request_review',
    description: 'Supervisor only: open the review for a submitted task (submitted → reviewing).',
    inputSchema: obj({ task_id: str('task id') }, ['task_id']),
    handler: (api, session, args) => api.request_review(session, arg(args, 'task_id')),
  },
  {
    name: 'verdict',
    description:
      'Supervisor only: approve or reject a submission with one criterion result per acceptance item. You may not review your own implementation (C7).',
    inputSchema: obj({
      task_id: str('task id'),
      verdict: str('approved | rejected'),
      criteria: { type: 'array', items: { type: 'object' }, description: '[{criterion, pass, evidence}]' },
      notes: str('free-form reviewer notes'),
      allow_strip_merge: bool('allow the integrator to drop out-of-scope files instead of rejecting outright'),
    }, ['task_id', 'verdict', 'notes']),
    handler: (api, session, args) => {
      const v = arg(args, 'verdict')
      if (v !== 'approved' && v !== 'rejected') {
        throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'verdict must be "approved" or "rejected"', { verdict: v })
      }
      const criteria = Array.isArray(args['criteria']) ? (args['criteria'] as never[]) : []
      return api.verdict(session, arg(args, 'task_id'), v, criteria, arg(args, 'notes'), {
        allow_strip_merge: args['allow_strip_merge'] === true,
      })
    },
  },
  {
    name: 'merge',
    description:
      'Integrator only: merge an approved task through the scope gate. The gate refuses the whole submission if it touches paths outside scope.write.',
    inputSchema: obj({ task_id: str('task id'), allow_strip: bool('drop out-of-scope files and merge the rest') }, ['task_id']),
    handler: (api, session, args) =>
      api.merge(session, arg(args, 'task_id'), { allow_strip: args['allow_strip'] === true }),
  },
  {
    name: 'create_task',
    description:
      'Planning roles only (coordinator/planner/architect): put a new task card on the board. Keep it small enough for one agent in one session — at most 7 acceptance criteria, and every criterion must be checkable.',
    inputSchema: obj({
      title: str('what to build, in one line'),
      role: str('which role should do it (backend_dev, frontend_dev, ...)'),
      write: { type: 'array', items: { type: 'string' }, description: 'glob paths this task may write (scope.write) — never empty' },
      read: { type: 'array', items: { type: 'string' }, description: 'advisory paths worth reading first' },
      acceptance: { type: 'array', items: { type: 'string' }, description: 'verifiable acceptance criteria (max 7)' },
      depends_on: { type: 'array', items: { type: 'string' }, description: 'task ids that must merge first' },
      tags: { type: 'array', items: { type: 'string' } },
    }, ['title', 'role', 'write', 'acceptance']),
    handler: (api, session, args) => {
      const role = arg(args, 'role')
      if (!isRoleId(role)) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `unknown role: ${role}`, { role })
      const write = Array.isArray(args['write']) ? (args['write'] as string[]) : []
      const acceptance = Array.isArray(args['acceptance']) ? (args['acceptance'] as string[]) : []
      return api.create_task(session, {
        title: arg(args, 'title'),
        role,
        write,
        read: Array.isArray(args['read']) ? (args['read'] as string[]) : [],
        acceptance,
        depends_on: Array.isArray(args['depends_on']) ? (args['depends_on'] as string[]) : [],
        tags: Array.isArray(args['tags']) ? (args['tags'] as string[]) : [],
      })
    },
  },
  {
    name: 'append_decision',
    description:
      'Planning roles only: append a decision to the platform decision log (.mesh/decisions.md). Use this for "why the board looks like this" — arbitration outcomes, scope rulings, deferred work — so the next session inherits the reasoning.',
    inputSchema: obj({
      text: str('the decision, with its reasoning and the evidence you relied on'),
      title: str('optional short heading'),
    }, ['text']),
    handler: (api, session, args) => api.append_decision(session, arg(args, 'text'), optStr(args, 'title')),
  },
  {
    name: 'get_decisions',
    description: 'Read the platform decision log (.mesh/decisions.md).',
    inputSchema: obj({}),
    handler: (api, session) => api.get_decisions(session),
  },
  {
    name: 'publish_task',
    description: 'Planning roles only: move a draft task to ready once its dependencies are merged.',
    inputSchema: obj({ task_id: str('task id') }, ['task_id']),
    handler: (api, session, args) => api.publish_task(session, arg(args, 'task_id')),
  },
  {
    name: 'start_mission',
    description:
      'Start a mission where YOU are the lead, and be done with your turn: the platform spawns your lead session, which splits the work, dispatches it, integrates and writes the report. Use this only when the user explicitly asked for the AgentMesh / multi-agent flow — not because a task looks big.',
    inputSchema: obj({
      title: str('one-line title'),
      brief: str("the user's words, verbatim"),
      acceptance: { type: 'array', items: { type: 'string' }, description: 'mission-level acceptance criteria (optional)' },
    }, ['title', 'brief']),
    handler: (api, session, args) =>
      api.start_mission(
        session,
        arg(args, 'title'),
        arg(args, 'brief'),
        Array.isArray(args['acceptance']) ? (args['acceptance'] as string[]) : [],
      ),
  },
  {
    name: 'create_mission',
    description:
      'Create a mission (one thing the user asked for) and pick its lead. Whoever receives the job leads it. Only planning roles, the mission lead (nested missions) or the human operator may call this.',
    inputSchema: obj({
      title: str('one-line title'),
      brief: str("the user's words, verbatim — the platform never rewrites them"),
      acceptance: { type: 'array', items: { type: 'string' }, description: 'mission-level acceptance criteria (optional)' },
      lead_agent: str('agent id to lead it; omit to let the platform pick'),
      parent_mission: str('parent mission id when this is a nested sub-mission'),
    }, ['title', 'brief']),
    handler: (api, session, args) =>
      api.create_mission(session, {
        title: arg(args, 'title'),
        brief: arg(args, 'brief'),
        acceptance: Array.isArray(args['acceptance']) ? (args['acceptance'] as string[]) : [],
        lead_agent: optStr(args, 'lead_agent') ?? null,
        parent_mission: optStr(args, 'parent_mission') ?? null,
      }),
  },
  {
    name: 'get_mission',
    description: 'Read a mission: status, plan, per-task progress with reviewer/merge, and whether the lead is live.',
    inputSchema: obj({ mission_id: str('mission id, e.g. M-000001') }, ['mission_id']),
    handler: (api, session, args) => api.get_mission(session, arg(args, 'mission_id')),
  },
  {
    name: 'plan_mission',
    description:
      'Lead only: split the mission into task cards in one atomic call. Each item: {title, role, scope:{write,read}, acceptance, depends_on?, agent?, why?}. Omitting depends_on serializes the items in array order. At most 7 acceptance criteria per card.',
    inputSchema: obj({
      mission_id: str('mission id'),
      tasks: { type: 'array', items: { type: 'object' }, description: 'the breakdown' },
    }, ['mission_id', 'tasks']),
    handler: (api, session, args) => api.plan_mission(session, arg(args, 'mission_id'), args['tasks']),
  },
  {
    name: 'dispatch_mission',
    description: 'Lead only: hand the plan to the scheduler (planning → executing). Cards become claimable here.',
    inputSchema: obj({ mission_id: str('mission id') }, ['mission_id']),
    handler: (api, session, args) => api.dispatch_mission(session, arg(args, 'mission_id')),
  },
  {
    name: 'final_verdict',
    description:
      'Lead only: the second acceptance for the whole mission. approved=false sends the named cards back to work (rejects=[] means the breakdown itself was wrong and the mission returns to planning).',
    inputSchema: obj({
      mission_id: str('mission id'),
      approved: bool('true = the work meets the mission, continue to the report'),
      notes: str('why — this is what the humans read'),
      rejects: { type: 'array', items: { type: 'string' }, description: 'task ids to send back (omit to replan)' },
    }, ['mission_id', 'approved', 'notes']),
    handler: (api, session, args) =>
      api.final_verdict(
        session,
        arg(args, 'mission_id'),
        args['approved'] === true,
        arg(args, 'notes'),
        Array.isArray(args['rejects']) ? (args['rejects'] as string[]) : undefined,
      ),
  },
  {
    name: 'write_report',
    description:
      'Lead only: write the final report for the user (markdown). Requires an approved second acceptance; writing it completes the mission.',
    inputSchema: obj({ mission_id: str('mission id'), markdown: str('the report') }, ['mission_id', 'markdown']),
    handler: (api, session, args) => api.write_report(session, arg(args, 'mission_id'), arg(args, 'markdown')),
  },
  {
    name: 'get_profile',
    description:
      'Read an agent profile: the nine dimensions (personality/strengths/weaknesses/capability_notes/specialties/quality_score/cost_tier/reliability/speed_notes) plus peer reviews and success stats.',
    inputSchema: obj({ agent_id: str('agent id') }, ['agent_id']),
    handler: (api, session, args) => api.get_profile(session, arg(args, 'agent_id')),
  },
  {
    name: 'rate_peer',
    description:
      'Rate a teammate you actually worked with on this mission, 0-100 on four dimensions. Boundaries are enforced in code: same mission only, never yourself, one review per (you, target, mission) — re-rating overwrites. quality_score moves by a weighted moving average unless a human locked the profile.',
    inputSchema: obj({
      agent_id: str('who you are rating'),
      mission_id: str('the mission you both took part in'),
      quality: num('0-100'),
      cooperation: num('0-100'),
      evidence: num('0-100'),
      speed: num('0-100'),
      comment: str('optional: what you actually observed'),
      task_id: str('optional related task'),
    }, ['agent_id', 'mission_id', 'quality', 'cooperation', 'evidence', 'speed']),
    handler: (api, session, args) => {
      const scores = {
        quality: Number(args['quality']),
        cooperation: Number(args['cooperation']),
        evidence: Number(args['evidence']),
        speed: Number(args['speed']),
      }
      return api.rate_peer(
        session,
        arg(args, 'agent_id'),
        arg(args, 'mission_id'),
        scores,
        optStr(args, 'comment'),
        optStr(args, 'task_id'),
      )
    },
  },
  {
    name: 'list_teammates',
    description:
      'Who else took part in this mission: agent, personality, strengths, weaknesses, quality score, cost, and what each one owns in this round. Omit mission_id to use the mission this session belongs to.',
    inputSchema: obj({ mission_id: str('mission id, e.g. M-000001 (optional when the session is bound to one)') }),
    handler: (api, session, args) => api.list_teammates(session, optStr(args, 'mission_id') ?? null),
  },
  {
    name: 'send',
    description:
      'Send a message to a role thread. Addressing is by role (never by agent id): the hub resolves the current holder and queues the message if the role is vacant.',
    inputSchema: obj({
      to_role: str('recipient role, e.g. coordinator'),
      thread: str('task id or *'),
      type: str('task.assign | task.feedback | review.verdict | question.ask | question.answer | escalation | heartbeat | board.update | system.notice'),
      body: str('message body'),
      ttl_seconds: num('optional time to live, default 1800'),
    }, ['to_role', 'type', 'body']),
    handler: (api, session, args) => {
      const role = arg(args, 'to_role')
      if (!isRoleId(role)) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `unknown role: ${role}`, { role })
      return api.send(
        session,
        { role, thread: optStr(args, 'thread') ?? '*'},
        arg(args, 'type') as never,
        arg(args, 'body'),
        typeof args['ttl_seconds'] === 'number' ? (args['ttl_seconds'] as number) : undefined,
      )
    },
  },
  {
    name: 'read_messages',
    description: 'Read your inbox (marks messages read).',
    inputSchema: obj({ since: str('optional ISO timestamp') }),
    handler: (api, session, args) => api.read_messages(session, optStr(args, 'since')),
  },
  {
    name: 'wait_messages',
    description: 'Long-poll your inbox for up to timeout_ms. The real-time channel for daemon roles.',
    inputSchema: obj({ timeout_ms: num('max wait, default 20000, cap 45000'), since: str('optional ISO timestamp') }),
    handler: (api, session, args) =>
      api.wait_messages(
        session,
        typeof args['timeout_ms'] === 'number' ? (args['timeout_ms'] as number) : 20_000,
        optStr(args, 'since'),
      ),
  },
  {
    name: 'put_artifact',
    description:
      'Store a NON-CODE deliverable (plan, spec, research digest, review notes, decisions). Code goes on the task branch instead. Paths outside your role output_globs are refused in code.',
    inputSchema: obj({
      path: str('artifact path, e.g. specs/auth.md'),
      content: str('full file content'),
      task_id: str('optional related task'),
    }, ['path', 'content']),
    handler: (api, session, args) => api.put_artifact(session, arg(args, 'path'), arg(args, 'content'), optStr(args, 'task_id')),
  },
  {
    name: 'get_artifact',
    description: 'Read a previously stored artifact.',
    inputSchema: obj({ path: str('artifact path') }, ['path']),
    handler: (api, session, args) => api.get_artifact(session, arg(args, 'path')),
  },
  {
    name: 'list_artifacts',
    description: 'List stored artifacts.',
    inputSchema: obj({}),
    handler: (api, session) => api.list_artifacts(session),
  },
  {
    name: 'get_file',
    description: 'Read any file in the project workspace (read is never restricted; C4).',
    inputSchema: obj({ path: str('project-relative path') }, ['path']),
    handler: (api, session, args) => api.get_file(session, arg(args, 'path')),
  },
]

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]))

const INSTRUCTIONS = [
  'AgentMesh hub. You are a platform Session: call `hello` first to receive your role card.',
  'The platform never restricts your tools — it constrains what you are responsible for.',
  'Deliver code only by committing on your task branch and calling `submit`.',
  'Anything outside your task scope.write will be refused at merge time, so escalate instead of overreaching.',
  'Planning roles (coordinator/planner/architect) create work with `create_task`; everyone else executes.',
].join(' ')

class McpHubServer {
  private sessionId: string
  private root: string | null
  private apiCache: HubApi | null = null
  private shuttingDown = false

  constructor(opts: { root?: string | null; sessionId?: string | null }) {
    this.root = opts.root ?? null
    this.sessionId = opts.sessionId ?? ''
  }

  private api(): HubApi {
    if (this.apiCache) return this.apiCache
    const root = this.root ?? process.cwd()
    this.apiCache = new HubApi(Hub.open(root))
    return this.apiCache
  }

  private resolveSession(args: Record<string, unknown>): string {
    const fromArgs = typeof args['session_id'] === 'string' ? (args['session_id'] as string) : ''
    const session = fromArgs || this.sessionId || process.env.MESH_SESSION_ID || ''
    if (!session) {
      throw new MeshError(
        MESH_ERRORS.SESSION_HELLO_REQUIRED,
        'no session id: pass session_id or set MESH_SESSION_ID (the spawn recipe does this for you)',
        { hint: 'run `mesh hello` from a spawned session, or ask the scheduler to spawn you' },
      )
    }
    return session
  }

  async handle(msg: JsonRpcRequest): Promise<void> {
    const { id, method, params } = msg
    const isNotification = id === undefined || id === null

    if (method === 'initialize') {
      const asked = typeof params?.['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : ''
      this.send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agentmesh-hub', version: '1.0.0' },
          instructions: INSTRUCTIONS,
        },
      })
      return
    }

    if (isNotification) {
      // notifications/initialized, notifications/cancelled, ...: nothing to do.
      return
    }

    try {
      switch (method) {
        case 'ping':
          this.send({ jsonrpc: '2.0', id, result: {} })
          return
        case 'tools/list':
          this.send({
            jsonrpc: '2.0',
            id,
            result: {
              tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
            },
          })
          return
        case 'resources/list':
          this.send({ jsonrpc: '2.0', id, result: { resources: [] } })
          return
        case 'resources/templates/list':
          this.send({ jsonrpc: '2.0', id, result: { resourceTemplates: [] } })
          return
        case 'prompts/list':
          this.send({ jsonrpc: '2.0', id, result: { prompts: [] } })
          return
        case 'tools/call':
          await this.callTool(id, params ?? {})
          return
        default:
          this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: detail } })
    }
  }

  private async callTool(id: unknown, params: Record<string, unknown>): Promise<void> {
    const name = typeof params['name'] === 'string' ? (params['name'] as string) : ''
    const tool = TOOL_MAP.get(name)
    if (!tool) {
      this.send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } })
      return
    }
    const args = (params['arguments'] as Record<string, unknown>) ?? {}
    try {
      const session = this.resolveSession(args)
      const result = await tool.handler(this.api(), session, args)
      this.send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2) }],
          isError: false,
        },
      })
    } catch (e) {
      const err = toErrorResult(e)
      this.send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ error: err.error }, null, 2) }],
          isError: true,
        },
      })
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.shuttingDown) return
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  }

  async serve(): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
    for await (const line of rl) {
      const text = line.trim()
      if (!text) continue
      let msg: JsonRpcRequest
      try {
        msg = JSON.parse(text) as JsonRpcRequest
      } catch {
        continue // malformed frame: ignore, the client will retry or time out
      }
      await this.handle(msg)
    }
    this.shuttingDown = true
  }
}

function parseArgs(argv: string[]): { root: string | null; sessionId: string | null; listTools: boolean } {
  let root: string | null = null
  let sessionId: string | null = null
  let listTools = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') root = argv[++i] ? path.resolve(argv[i]!) : null
    else if (a === '--session') sessionId = argv[++i] ?? null
    else if (a === '--list-tools') listTools = true
  }
  return { root, sessionId, listTools }
}

const cliArgs = parseArgs(process.argv.slice(2))
if (cliArgs.listTools) {
  process.stdout.write(
    `${JSON.stringify(
      TOOLS.map((t) => ({ name: t.name, description: t.description })),
      null,
      2,
    )}\n`,
  )
  process.exit(0)
} else {
  const server = new McpHubServer({
    root: cliArgs.root ?? process.env.MESH_ROOT ?? null,
    sessionId: cliArgs.sessionId,
  })
  await server.serve()
}
