/**
 * Hermes adapter — the file-protocol reference implementation.
 *
 * Hermes is a capable CLI agent with a full toolset, and it is exactly the case
 * the plan calls out: "no MCP, degraded but on-protocol". It gets the same role
 * card, the same sandbox and the same output gate; the only difference is that it
 * talks to the hub by running `mesh` from its own shell instead of calling MCP
 * tools. Nothing about that weakens the responsibility layer (C2 holds: it can do
 * everything a direct session can, plus the platform).
 */

import path from 'node:path'
import { buildChildEnv } from './types.ts'
import type { Adapter, SpawnContext, SpawnPlan } from './types.ts'

export const hermesAdapter: Adapter = {
  name: 'hermes',
  build(ctx: SpawnContext): SpawnPlan {
    const args = [...ctx.agent.args, ...ctx.agent.headless_args]
    if (ctx.agent.prompt_flag) args.push(ctx.agent.prompt_flag, ctx.prompt)
    else args.push(ctx.prompt)

    const plan: SpawnPlan = {
      command: ctx.agent.command,
      args,
      cwd: ctx.worktree,
      env: buildChildEnv(ctx),
      artifacts: [],
      injection: 'file protocol: `mesh` CLI + inbox files (no MCP)',
    }
    if (ctx.agent.prompt_mode === 'stdin') plan.stdin = ctx.prompt
    return plan
  },
}

/** Where a file-protocol agent should look for its inbox. */
export function hermesInboxHint(ctx: SpawnContext): string {
  return path.join(ctx.hub.paths.meshDir, 'messages', 'inbox', ctx.agent.agent_id)
}
