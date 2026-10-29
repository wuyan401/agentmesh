/**
 * Adapter contract: one AgentCard + one Session -> one concrete process launch.
 *
 * The launch recipe is *environment and identity* only: cwd, env, prompt prefix,
 * and how the hub toolbelt is bolted on. It is deliberately incapable of
 * expressing "this agent may not use tool X" (C2/C4): there is no field for it.
 */

import fs from 'node:fs'
import path from 'node:path'
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
  const sep = process.platform === 'win32' ? ';' : ':'
  const pathParts = (env['PATH'] ?? '').split(sep).filter(Boolean)
  // The worker gets a node it is allowed to execute first, then the hub's own node
  // as a fallback. See workerNodeDir() for why the order is not the other way round.
  const head = [workerNodeDir(), path.dirname(process.execPath)]
  const seen = new Set(head.map((p) => p.toLowerCase()))
  const rest = pathParts.filter((p) => !seen.has(p.toLowerCase()))
  env['PATH'] = [...head, ...rest].join(sep)

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

/**
 * Where the worker-facing copy of node lives.
 *
 * DSH sandboxes a worker process at Low integrity; the node Hermes itself runs on is
 * Medium, so the worker cannot execute it and any `node` call dies with WinError 5
 * (that is why workers used to "self-verify statically" and never ran a test).
 * The fix is a *separate* copy tagged Low — flipping the shared one to Low breaks
 * every node process on the machine (EPERM on `.mesh-human.json.tmp`), so never do that.
 *
 * Resolution order: `MESH_WORKER_NODE_DIR` if it holds a node binary, then the
 * machine's prepared copy, then the hub's own node directory (non-Windows or a
 * machine that has not prepared a copy).
 */
export function workerNodeDir(): string {
  const bin = process.platform === 'win32' ? 'node.exe' : 'node'
  const override = process.env['MESH_WORKER_NODE_DIR']
  if (override && fs.existsSync(path.join(override, bin))) return override
  const prepared = process.platform === 'win32' ? 'D:\\AI\\workspace\\.tools\\node' : ''
  if (prepared && fs.existsSync(path.join(prepared, bin))) return prepared
  return path.dirname(process.execPath)
}

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
