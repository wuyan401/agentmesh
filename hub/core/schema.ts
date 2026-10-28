/**
 * Runtime schema validation for the five card types (M0 deliverable).
 *
 * The Hub never trusts a card it did not validate: agents can hand it JSON over
 * MCP, the CLI can write a file directly, and a human can edit one by hand. The
 * validators below are the single gate in front of all of that.
 *
 * Declarative JSON-Schema copies live in `schemas/` for editors and external
 * tooling; these functions are what actually enforces.
 */

import { MESH_ERRORS, MeshError } from './errors.ts'
import { ROLE_IDS, TASK_STATUSES, MESSAGE_TYPES } from './types.ts'
import type { AgentCard, Message, RoleCard, SessionCard, TaskCard } from './types.ts'
import { normRel } from './fsx.ts'

export type SchemaKind = 'role' | 'agent' | 'session' | 'task' | 'message'

export class ValidationError extends MeshError {
  readonly errors: string[]
  constructor(kind: SchemaKind, errors: string[], id?: string) {
    super(MESH_ERRORS.SCHEMA_INVALID, `${kind} card is invalid${id ? ` (${id})` : ''}: ${errors.join('; ')}`, {
      kind,
      id: id ?? null,
      errors,
    })
    this.name = 'ValidationError'
    this.errors = errors
  }
}

const ID_PATTERNS = {
  agent: /^[a-z0-9][a-z0-9._-]{1,63}$/,
  session: /^S-\d{6}$/,
  task: /^T-\d{6}$/,
  message: /^M-\d{6}$/,
  review: /^R-\d{4,6}$/,
  violation: /^V-\d{6}$/,
}

function isStr(v: unknown): v is string {
  return typeof v === 'string'
}

function strArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isStr)
}

function nonEmptyStrArray(v: unknown): v is string[] {
  return strArray(v) && v.length > 0 && v.every((s) => s.trim().length > 0)
}

function isIso(v: unknown): boolean {
  return isStr(v) && !Number.isNaN(Date.parse(v))
}

export function validateRoleCard(card: RoleCard): string[] {
  const e: string[] = []
  if (!ROLE_IDS.includes(card.role)) e.push(`role must be one of ${ROLE_IDS.join('|')}`)
  if (!isStr(card.title) || !card.title.trim()) e.push('title is required')
  if (!nonEmptyStrArray(card.duty)) e.push('duty must be a non-empty string array')
  if (!strArray(card.constraints)) e.push('constraints must be a string array')
  if (typeof card.can_write_code !== 'boolean') e.push('can_write_code must be boolean')
  if (typeof card.can_implement !== 'boolean') e.push('can_implement must be boolean')
  if (typeof card.can_review !== 'boolean') e.push('can_review must be boolean')
  if (typeof card.can_merge !== 'boolean') e.push('can_merge must be boolean')
  if (card.lifespan !== 'ephemeral' && card.lifespan !== 'daemon') e.push('lifespan must be ephemeral|daemon')
  if (!strArray(card.output_globs)) e.push('output_globs must be a string array')
  if (!isStr(card.prompt) || card.prompt.length < 20) e.push('prompt is required')
  // C4 invariant: role cards never carry a tool policy.
  if ('tools' in (card as unknown as Record<string, unknown>) || 'tool_policy' in (card as unknown as Record<string, unknown>)) {
    e.push('role cards must not carry tool restrictions (C4)')
  }
  return e
}

export function validateAgentCard(card: AgentCard): string[] {
  const e: string[] = []
  if (!isStr(card.agent_id) || !ID_PATTERNS.agent.test(card.agent_id)) e.push('agent_id must match [a-z0-9][a-z0-9._-]{1,63}')
  if (!isStr(card.display_name) || !card.display_name.trim()) e.push('display_name is required')
  const kinds = ['dsh', 'hermes', 'claude-code', 'codex', 'opencode', 'generic', 'file-protocol', 'builtin']
  if (!kinds.includes(card.kind)) e.push(`kind must be one of ${kinds.join('|')}`)
  if (typeof card.enabled !== 'boolean') e.push('enabled must be boolean')
  // Builtin agents are the deterministic core: they have no process to launch.
  if (card.kind !== 'builtin' && (!isStr(card.command) || !card.command.trim())) e.push('command is required')
  if (!strArray(card.args)) e.push('args must be a string array')
  if (!Array.isArray(card.capabilities) || card.capabilities.length === 0) e.push('capabilities must list at least one role')
  else {
    for (const r of card.capabilities) {
      if (!ROLE_IDS.includes(r)) e.push(`unknown capability role: ${String(r)}`)
    }
  }
  if (!Number.isInteger(card.concurrency) || card.concurrency < 1) e.push('concurrency must be an integer >= 1')
  if (![1, 2, 3].includes(card.cost_tier)) e.push('cost_tier must be 1|2|3')
  if (!['mcp', 'file', 'in-process'].includes(card.transport)) e.push('transport must be mcp|file|in-process')
  const injections = ['dsh-patch', 'mcp-json', 'config-file', 'config-file-codex', 'hermes-config', 'file-protocol', 'none']
  if (!injections.includes(card.mcp_inject)) e.push(`mcp_inject must be one of ${injections.join('|')}`)
  if (!card.extra_env || typeof card.extra_env !== 'object') e.push('extra_env must be an object')
  if (!strArray(card.strip_env)) e.push('strip_env must be a string array')
  if (!['arg', 'stdin', 'file'].includes(card.prompt_mode)) e.push('prompt_mode must be arg|stdin|file')
  if (card.prompt_flag !== null && !isStr(card.prompt_flag)) e.push('prompt_flag must be null or string')
  if (!strArray(card.headless_args)) e.push('headless_args must be a string array')
  if (!Number.isInteger(card.ttl_seconds) || card.ttl_seconds < 10) e.push('ttl_seconds must be an integer >= 10')
  if (!isStr(card.notes)) e.push('notes must be a string')
  return e
}

export function validateSessionCard(card: SessionCard): string[] {
  const e: string[] = []
  if (!isStr(card.session_id) || !ID_PATTERNS.session.test(card.session_id)) e.push('session_id must look like S-000123')
  if (!isStr(card.agent_id) || !ID_PATTERNS.agent.test(card.agent_id)) e.push('agent_id is invalid')
  if (!ROLE_IDS.includes(card.role)) e.push('role is invalid')
  if (card.task !== null && (!isStr(card.task) || !ID_PATTERNS.task.test(card.task))) e.push('task must be null or T-000123')
  if (card.mode !== 'platform') e.push('mode must be platform (D-Sessions are never registered)')
  if (card.lifespan !== 'ephemeral' && card.lifespan !== 'daemon') e.push('lifespan must be ephemeral|daemon')
  if (!isStr(card.spawned_by)) e.push('spawned_by is required')
  if (card.sandbox !== null && !isStr(card.sandbox)) e.push('sandbox must be null or a path')
  const statuses = ['starting', 'active', 'exited', 'expired', 'killed', 'failed']
  if (!statuses.includes(card.status)) e.push(`status must be one of ${statuses.join('|')}`)
  if (card.pid !== null && !Number.isInteger(card.pid)) e.push('pid must be null or integer')
  if (!isIso(card.created_at)) e.push('created_at must be an ISO timestamp')
  if (!isIso(card.last_heartbeat_at)) e.push('last_heartbeat_at must be an ISO timestamp')
  if (!Number.isInteger(card.ttl_seconds) || card.ttl_seconds < 10) e.push('ttl_seconds must be an integer >= 10')
  if (card.hello_at !== null && !isIso(card.hello_at)) e.push('hello_at must be null or ISO timestamp')
  if (!Number.isInteger(card.turns) || card.turns < 0) e.push('turns must be a non-negative integer')
  return e
}

export function validateTaskCard(card: TaskCard): string[] {
  const e: string[] = []
  if (!isStr(card.task_id) || !ID_PATTERNS.task.test(card.task_id)) e.push('task_id must look like T-000042')
  if (!isStr(card.title) || !card.title.trim()) e.push('title is required')
  if (!ROLE_IDS.includes(card.role)) e.push('role is invalid')
  if (!TASK_STATUSES.includes(card.status)) e.push(`status must be one of ${TASK_STATUSES.join('|')}`)
  if (!strArray(card.depends_on)) e.push('depends_on must be a string array')
  if (!card.scope || !Array.isArray(card.scope.write) || !Array.isArray(card.scope.read)) {
    e.push('scope must have write[] and read[]')
  } else {
    if (card.scope.write.length === 0) e.push('scope.write must not be empty')
    for (const g of [...card.scope.write, ...card.scope.read]) {
      if (!isStr(g) || normRel(g) === '') e.push(`invalid scope glob: ${String(g)}`)
    }
  }
  if (!nonEmptyStrArray(card.acceptance)) e.push('acceptance must be a non-empty string array')
  if (card.estimate !== '1-session' && card.estimate !== 'multi-session') e.push('estimate must be 1-session|multi-session')
  if (!isStr(card.branch) || !card.branch.trim()) e.push('branch is required')
  if (card.base_commit !== null && !isStr(card.base_commit)) e.push('base_commit must be null or string')
  if (card.submission !== null && typeof card.submission !== 'object') e.push('submission must be null or object')
  if (!strArray(card.reviews)) e.push('reviews must be a string array')
  if (!Array.isArray(card.history)) e.push('history must be an array')
  else {
    for (const h of card.history) {
      if (!h || typeof h !== 'object') e.push('history entries must be objects')
      else if (!TASK_STATUSES.includes(h.to)) e.push(`history.to must be a task status, got ${String(h.to)}`)
    }
  }
  if (!strArray(card.tags)) e.push('tags must be a string array')
  return e
}

export function validateMessage(msg: Message): string[] {
  const e: string[] = []
  if (!isStr(msg.msg_id) || !ID_PATTERNS.message.test(msg.msg_id)) e.push('msg_id must look like M-000135')
  if (!msg.from || !isStr(msg.from.agent) || !isStr(msg.from.session) || !ROLE_IDS.includes(msg.from.role)) {
    e.push('from must be {agent, session, role}')
  }
  if (!msg.to || !ROLE_IDS.includes(msg.to.role) || !isStr(msg.to.thread)) e.push('to must be {role, thread}')
  if (!MESSAGE_TYPES.includes(msg.type)) e.push(`type must be one of ${MESSAGE_TYPES.join('|')}`)
  if (!isStr(msg.body) || !msg.body.trim()) e.push('body is required')
  if (!Array.isArray(msg.attachments)) e.push('attachments must be an array')
  if (!isStr(msg.thread)) e.push('thread is required')
  if (!Number.isInteger(msg.ttl_seconds) || msg.ttl_seconds <= 0) e.push('ttl_seconds must be a positive integer')
  if (!isIso(msg.created_at)) e.push('created_at must be an ISO timestamp')
  if (!isIso(msg.expires_at)) e.push('expires_at must be an ISO timestamp')
  if (!['queued', 'read', 'dead'].includes(msg.status)) e.push('status must be queued|read|dead')
  if (msg.resolved !== null && (typeof msg.resolved !== 'object' || !isStr(msg.resolved.agent_id))) {
    e.push('resolved must be null or {agent_id, session_id}')
  }
  return e
}

export function assertValid<T>(kind: SchemaKind, value: T, id?: string): T {
  const errors = validators[kind](value as never) as string[]
  if (errors.length > 0) throw new ValidationError(kind, errors, id)
  return value
}

const validators: Record<SchemaKind, (v: unknown) => string[]> = {
  role: (v) => validateRoleCard(v as RoleCard),
  agent: (v) => validateAgentCard(v as AgentCard),
  session: (v) => validateSessionCard(v as SessionCard),
  task: (v) => validateTaskCard(v as TaskCard),
  message: (v) => validateMessage(v as Message),
}

export const ID_PATTERN = ID_PATTERNS
