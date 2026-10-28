/**
 * Adapter contract: one AgentCard + one Session -> one concrete process launch.
 *
 * The launch recipe is *environment and identity* only: cwd, env, prompt prefix,
 * and how the hub toolbelt is bolted on. It is deliberately incapable of
 * expressing "this agent may not use tool X" (C2/C4): there is no field for it.
 */

import type { AgentCard, RoleId, SessionCard, TaskCard } from '../core/types.ts'
import type { Hub } from '../core/hub.ts'

export interface SpawnContext {
  hub: Hub
  session: SessionCard
  agent: AgentCard
  role: RoleId
  task: TaskCard | null
  /** Absolute working directory for the child (= the task worktree, or project root). */
  worktree: string
  /** The composed prompt (role card + task + protocol). */
  prompt: string
  /** Per-session scratch directory for generated config files. */
  scratch: string
  /** Path of the context package, when one was generated. */
  contextPath: string | null
}

export interface SpawnPlan {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  stdin?: string
  /** Files written by the adapter, reported for diagnostics. */
  artifacts: string[]
  /** Human-readable description of how hub tools reach this agent. */
  injection: string
}

export interface Adapter {
  name: string
  build(ctx: SpawnContext): SpawnPlan
}

/**
 * Every child gets the platform env, a sane PATH (node must be reachable from its
 * own Bash tool), and nothing that could make it resume the *parent* session.
 */
export function buildChildEnv(ctx: SpawnContext): Record<string, string> {
  const env: Record<string, string> = {}
  const deny = new Set([
    // A spawned DSH must never inherit the identity of the session that spawned it.
    'DSH_SESSION_ID',
    'DSH_PROFILE',
    'DSH_PROFILE_DIR',
    'DSH_SHELL',
    'DSH_WEB_URL',
    'DSH_GOAL_ID',
    ...ctx.agent.strip_env,
  ])
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (deny.has(k)) continue
    if (k.startsWith('MESH_')) continue
    env[k] = v
  }
  const pathParts = (env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  const nodeExeDir = process.execPath.replace(/[\\/][^\\/]+$/, '')
  if (!pathParts.some((p) => p.toLowerCase() === nodeExeDir.toLowerCase())) pathParts.unshift(nodeExeDir)
  env['PATH'] = pathParts.join(process.platform === 'win32' ? ';' : ':')

  env['MESH_ROOT'] = ctx.hub.paths.root
  env['MESH_MESH_DIR'] = ctx.hub.paths.meshDir
  env['MESH_SESSION_ID'] = ctx.session.session_id
  env['MESH_AGENT_ID'] = ctx.agent.agent_id
  env['MESH_ROLE'] = ctx.session.role
  if (ctx.session.task) env['MESH_TASK_ID'] = ctx.session.task
  env['MESH_AGENTMESH_DIR'] = ADAPTER_PACKAGE_ROOT
  // Python-based agents (Hermes) block-buffer stdout when it is a file, which makes
  // a working session look hung in `.mesh/logs/`. Unbuffered output is the whole
  // point of a log file.
  env['PYTHONUNBUFFERED'] = '1'
  for (const [k, v] of Object.entries(ctx.agent.extra_env)) env[k] = v
  return env
}

/** Absolute path of the agentmesh package (holds cli/, hub/). */
export const ADAPTER_PACKAGE_ROOT = resolvePackageRoot()

function resolvePackageRoot(): string {
  // hub/adapters/index.ts -> hub/adapters -> hub -> package root
  const here = import.meta.dirname
  return here.replace(/[\\/]hub[\\/]adapters$/, '')
}

/** Absolute path of the `mesh` CLI entry point. */
export function meshCliPath(): string {
  return `${ADAPTER_PACKAGE_ROOT}/cli/mesh.ts`
}

/** Absolute path of the hub MCP server entry point. */
export function hubMcpServerPath(): string {
  return `${ADAPTER_PACKAGE_ROOT}/hub/mcp/server.ts`
}

/** Quote a value for a YAML/JSON config safely enough for generated overlays. */
export function quote(value: string): string {
  return JSON.stringify(value)
}
