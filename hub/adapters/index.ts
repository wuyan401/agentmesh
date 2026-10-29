/** Adapter registry: kind -> launch recipe builder. */

import path from 'node:path'
import { dshAdapter, DSH_TOOL_PREFIX } from './dsh.ts'
import { hermesAdapter } from './hermes.ts'
import { cliGenericAdapter } from './cli-generic.ts'
import { meshCliPath } from './types.ts'
import type { Adapter, SpawnContext, SpawnPlan } from './types.ts'
import type { AgentCard } from '../core/types.ts'

export { ADAPTER_PACKAGE_ROOT, buildChildEnv, hubMcpServerPath, meshCliPath, workerNodeDir } from './types.ts'
export type { Adapter, SpawnContext, SpawnPlan } from './types.ts'

export function adapterFor(agent: AgentCard): Adapter {
  switch (agent.kind) {
    case 'dsh':
      return dshAdapter
    case 'hermes':
      return hermesAdapter
    case 'builtin':
      return cliGenericAdapter // never spawned; the scheduler handles builtin agents in-process
    default:
      return cliGenericAdapter
  }
}

/** The MCP tool prefix an agent actually sees, if it has MCP at all. */
export function toolPrefixFor(agent: AgentCard): string | null {
  if (agent.mcp_inject === 'file-protocol' || agent.mcp_inject === 'none') return null
  if (agent.transport === 'file') return null
  if (agent.kind === 'dsh' || agent.kind === 'claude-code') return DSH_TOOL_PREFIX
  // Other clients namespace MCP tools after the server name in their own way.
  return 'hub_'
}

export function buildSpawnPlan(ctx: SpawnContext): SpawnPlan {
  if (ctx.agent.kind === 'builtin') {
    throw new Error('builtin agents are not spawned as processes')
  }
  const plan = adapterFor(ctx.agent).build(ctx)
  if (!plan.command) throw new Error(`agent ${ctx.agent.agent_id} has no command`)
  return plan
}

/** Absolute path of the mesh CLI (used by file-protocol prompts). */
export function meshBin(): string {
  return meshCliPath()
}

/** A short, printable description of what a spawn will do. */
export function describePlan(plan: SpawnPlan): string {
  const rel = (p: string) => (path.isAbsolute(p) ? `${path.basename(path.dirname(p))}/${path.basename(p)}` : p)
  return `${rel(plan.command)} ${plan.args.map((a) => (a.length > 60 ? `${a.slice(0, 57)}…` : a)).join(' ')}`
}
