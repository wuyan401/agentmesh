/**
 * AgentMesh domain model.
 *
 * The ternary model (Agent / Role / Session) is the backbone of the whole
 * platform: a Role is a logical function, an Agent is a physical CLI entity, and
 * a Session binds one Agent to exactly one Role for the lifetime of one task.
 * Permissions always travel with the Session, never with the Agent (C6).
 *
 * Every structure here is file-backed JSON under `.mesh/`; see PROTOCOL.md.
 */

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** The ten constitutional roles. Roles are logic; any capable Agent may hold one. */
export const ROLE_IDS = [
  'coordinator',
  'planner',
  'architect',
  'researcher',
  'frontend_dev',
  'backend_dev',
  'executor',
  'supervisor',
  'integrator',
  'sentinel',
] as const

export type RoleId = (typeof ROLE_IDS)[number]

/** Roles whose Session is expected to answer one task and exit. */
export const WORKER_ROLES: readonly RoleId[] = [
  'planner',
  'architect',
  'researcher',
  'frontend_dev',
  'backend_dev',
  'executor',
]

/** Roles that are expected to live across many dispatches. */
export const DAEMON_ROLES: readonly RoleId[] = ['coordinator', 'supervisor', 'integrator', 'sentinel']

/** Roles allowed to write code into the repository. */
export const CODE_ROLES: readonly RoleId[] = ['frontend_dev', 'backend_dev', 'executor']

/**
 * Roles that may put new task cards on the board.
 *
 * This is a platform rule keyed by role, not a per-card toggle: "who may order work"
 * is exactly the kind of decision that should live in one auditable place. A worker
 * that could create its own cards would be able to route around the dependency graph.
 */
export const PLAN_ROLES: readonly RoleId[] = ['coordinator', 'planner', 'architect']

export function canPlan(role: RoleId): boolean {
  return PLAN_ROLES.includes(role)
}

// ---------------------------------------------------------------------------
// Task state machine
// ---------------------------------------------------------------------------

/**
 *   draft → ready → claimed → in_progress → submitted → reviewing → approved → merged
 *                     ↑                                              │
 *                     └──────────────── rejected ←──────────────────┘
 *   any → blocked (coordinator arbitration)
 */
export const TASK_STATUSES = [
  'draft',
  'ready',
  'claimed',
  'in_progress',
  'submitted',
  'reviewing',
  'approved',
  'merged',
  'rejected',
  'blocked',
  'cancelled',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Legal transitions. The only place task status may change (C5). */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ['ready', 'blocked', 'cancelled'],
  ready: ['claimed', 'blocked', 'cancelled'],
  claimed: ['in_progress', 'ready', 'blocked', 'cancelled'],
  in_progress: ['submitted', 'blocked', 'cancelled', 'ready'],
  submitted: ['reviewing', 'blocked', 'cancelled'],
  reviewing: ['approved', 'rejected', 'submitted', 'blocked', 'cancelled'],
  approved: ['merged', 'rejected', 'blocked', 'cancelled'],
  rejected: ['in_progress', 'ready', 'blocked', 'cancelled'],
  blocked: ['ready', 'in_progress', 'cancelled'],
  merged: [],
  cancelled: [],
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const MESSAGE_TYPES = [
  'task.assign',
  'task.feedback',
  'review.verdict',
  'question.ask',
  'question.answer',
  'escalation',
  'heartbeat',
  'board.update',
  'system.notice',
] as const

export type MessageType = (typeof MESSAGE_TYPES)[number]

export type MessageStatus = 'queued' | 'read' | 'dead'

// ---------------------------------------------------------------------------
// Roles cards
// ---------------------------------------------------------------------------

/** A role card is the single source of identity for a Session. */
export interface RoleCard {
  role: RoleId
  title: string
  /** What this role is for. One line each; rendered into the spawn prompt. */
  duty: string[]
  /** Hard behavioural constraints. Enforced in code where possible. */
  constraints: string[]
  /** May this role write into the repository (channel B)? */
  can_write_code: boolean
  /** May this role call hub.submit() as an implementer? */
  can_implement: boolean
  /** May this role issue review verdicts? */
  can_review: boolean
  /** May this role call hub.merge()? */
  can_merge: boolean
  /** Default lifecycle for Sessions of this role. */
  lifespan: 'ephemeral' | 'daemon'
  /**
   * Artifact path globs this role may write through hub.put_artifact()
   * (channel C, non-code deliverables). Anything else — and every code path —
   * is rejected by the Hub, not by the prompt.
   */
  output_globs: string[]
  /** The role-card body injected into the Session prompt. */
  prompt: string
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export type AgentKind =
  | 'dsh'
  | 'hermes'
  | 'claude-code'
  | 'codex'
  | 'opencode'
  | 'generic'
  | 'file-protocol'
  | 'builtin'

export type Transport = 'mcp' | 'file' | 'in-process'

/** How the adapter injects the hub toolbelt into a spawned Session. */
export type McpInject =
  | 'dsh-patch' // dsh --patch overlay adding @deepseek-ai/dsh-mcp-client
  | 'mcp-json' // CLAUDE-style --mcp-config / .mcp.json
  | 'config-file' // opencode-style config document
  | 'config-file-codex' // codex-style -c mcp_servers.* overrides
  | 'hermes-config' // hermes per-session MCP config
  | 'file-protocol' // no MCP: inbox watching (degraded, still on-protocol)
  | 'none'

/** One Agent = one physical CLI entity with a launch recipe. */
export interface AgentCard {
  agent_id: string
  display_name: string
  kind: AgentKind
  enabled: boolean
  /** Absolute or PATH-resolved executable. For `builtin`, the mesh binary. */
  command: string
  /** Base arguments prepended to every spawn. */
  args: string[]
  /** Roles this Agent is allowed to take (manual configuration at M0–M5). */
  capabilities: RoleId[]
  /** Maximum concurrent Sessions for this Agent. */
  concurrency: number
  /** 1 = cheap/fast, 3 = expensive/thorough. Used by load balancing. */
  cost_tier: 1 | 2 | 3
  transport: Transport
  mcp_inject: McpInject
  /** Extra env merged into the child process. */
  extra_env: Record<string, string>
  /** Env var names stripped from the inherited environment before spawn. */
  strip_env: string[]
  /** Substring appended to the prompt to hand the CLI a one-shot task. */
  prompt_mode: 'arg' | 'stdin' | 'file'
  /** Flag that introduces the prompt (`-q`, `-p`), or null for a positional prompt. */
  prompt_flag: string | null
  /** Extra CLI arguments for headless one-shot operation. */
  headless_args: string[]
  /** Per-spawn hard timeout. */
  ttl_seconds: number
  /** Optional notes shown by `mesh agents doctor`. */
  notes: string
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type SessionStatus = 'starting' | 'active' | 'exited' | 'expired' | 'killed' | 'failed'

export interface SessionCard {
  session_id: string
  agent_id: string
  role: RoleId
  task: string | null
  mode: 'platform'
  lifespan: 'ephemeral' | 'daemon'
  spawned_by: string
  sandbox: string | null
  status: SessionStatus
  pid: number | null
  created_at: string
  last_heartbeat_at: string
  ttl_seconds: number
  /** Set when the Session has called hub.hello(); before that it has no rights. */
  hello_at: string | null
  /** For resumable one-shot daemons (coordinator), the provider-side session id. */
  resume_token: string | null
  turns: number
  exit: { code: number | null; at: string; note?: string } | null
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export interface TaskScope {
  /** Globs, relative to the project root. Merged-diff must be a subset. */
  write: string[]
  /** Advisory: what this task may consult. Not a capability restriction (C4). */
  read: string[]
}

export interface TaskSubmission {
  commit: string
  branch: string
  summary: string
  submitted_at: string
  session_id: string
  /** Changed files computed at submit time, for the review and merge gate. */
  files: string[]
}

export type MergeMode = 'strict' | 'strip'

export interface TaskMerge {
  commit: string
  merge_commit: string
  merged_at: string
  session_id: string
  mode: MergeMode
  /** Files that were out of scope and dropped by an authorised strip merge. */
  stripped: string[]
  files: string[]
}

export interface TaskHistoryEntry {
  at: string
  from: TaskStatus | null
  to: TaskStatus
  by: string | null
  note?: string
}

export interface TaskCard {
  task_id: string
  title: string
  role: RoleId
  created_by: string | null
  created_at: string
  updated_at: string
  status: TaskStatus
  depends_on: string[]
  context_package: string | null
  context_level: 'minimal' | 'standard' | 'full' | null
  scope: TaskScope
  acceptance: string[]
  /** `multi-session` is rejected at creation time: granularity is a hard rule. */
  estimate: '1-session' | 'multi-session'
  base_commit: string | null
  branch: string
  worktree: string | null
  claimed_by: string | null
  implementer_agent: string | null
  submission: TaskSubmission | null
  reviews: string[]
  merge: TaskMerge | null
  blocked_reason: string | null
  parent: string | null
  tags: string[]
  history: TaskHistoryEntry[]
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface ReviewCriterionResult {
  criterion: string
  pass: boolean
  evidence: string
}

export interface ReviewRecord {
  review_id: string
  task_id: string
  reviewer_session: string
  reviewer_agent: string
  implementer_agent: string
  verdict: 'approved' | 'rejected'
  criteria: ReviewCriterionResult[]
  notes: string
  /** Whether the reviewer differs from the implementer (C7). Always true when written. */
  independent: boolean
  /** Optional: allow the integrator to strip out-of-scope files instead of rejecting. */
  allow_strip_merge: boolean
  at: string
  submission_commit: string
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface MessageEndpoint {
  role: RoleId
  thread: string
}

export interface MessageSender {
  agent: string
  session: string
  role: RoleId
}

export interface MessageAttachment {
  path: string
  sha256: string
  bytes: number
  inline: boolean
  text?: string
}

export interface Message {
  msg_id: string
  from: MessageSender
  to: MessageEndpoint
  type: MessageType
  body: string
  attachments: MessageAttachment[]
  thread: string
  ttl_seconds: number
  created_at: string
  expires_at: string
  /** Resolved recipient at delivery time; role threads re-resolve on each send. */
  resolved: { agent_id: string; session_id: string | null } | null
  read_at: string | null
  read_by: string | null
  status: MessageStatus
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type ViolationKind =
  | 'scope.out-of-write' // task branch touched a path outside scope.write
  | 'scope.merge-blocked' // merge gate refused a submission
  | 'drift.main-branch' // main received a commit the platform did not produce
  | 'role.artifact-denied' // put_artifact attempted outside the role's output_globs
  | 'role.code-attempt' // non-code role tried to hand in a code artifact
  | 'role.overreach' // e.g. implementer tried to review own task
  | 'protocol.unknown-session' // hello/claim from an unregistered session
  | 'protocol.unclaimed-work' // submit without a claim
  | 'liveness.stale-session' // no heartbeat past TTL
  | 'protocol.bus-bypass' // attempted direct peer addressing
  | 'granularity.oversized' // task creation rejected for granularity

export interface ViolationRecord {
  violation_id: string
  kind: ViolationKind
  at: string
  task_id: string | null
  session_id: string | null
  agent_id: string | null
  severity: 'info' | 'warn' | 'high'
  detail: string
  evidence: Record<string, unknown>
  /** detect-only: violations never change task state by themselves. */
  notified: boolean
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export interface MeshState {
  version: number
  project: string
  created_at: string
  main_branch: string
  /** Commit the mesh was initialised against. Anything older is pre-mesh history. */
  base_commit: string | null
  counters: { task: number; message: number; session: number; review: number; violation: number }
  flags: Record<string, boolean | string | number>
}

export interface ArtifactRecord {
  relpath: string
  sha256: string
  bytes: number
  created_at: string
  session_id: string
  role: RoleId
  task_id: string | null
}

/** A resolved identity, checked on every privileged Hub call. */
export interface Identity {
  session: SessionCard
  agent: AgentCard
  role: RoleCard
}
