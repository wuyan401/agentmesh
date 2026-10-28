/**
 * Generic adapter for one-shot CLI agents (Claude Code, Codex, OpenCode, any
 * future CLI).
 *
 * The CLI-specific parts live in the AgentCard (`prompt_flag`, `headless_args`,
 * `mcp_inject`); this module only knows the three shapes of MCP configuration
 * those CLIs use. Recipes for CLIs that are not installed here are marked
 * "unverified" by `mesh agents doctor` — the card is portable, the verification
 * is per machine.
 */

import fs from 'node:fs'
import path from 'node:path'
import { buildChildEnv, hubMcpServerPath } from './types.ts'
import type { Adapter, SpawnContext, SpawnPlan } from './types.ts'

interface StdioServerConfig {
  command: string
  args: string[]
  env: Record<string, string>
}

function stdioConfig(ctx: SpawnContext): StdioServerConfig {
  return {
    command: process.execPath,
    args: [hubMcpServerPath(), '--root', ctx.hub.paths.root, '--session', ctx.session.session_id],
    env: {
      MESH_ROOT: ctx.hub.paths.root,
      MESH_SESSION_ID: ctx.session.session_id,
      MESH_AGENT_ID: ctx.agent.agent_id,
    },
  }
}

/** Claude Code style: `--mcp-config <file>` + `-p <prompt>`. */
function mcpJsonOverlay(ctx: SpawnContext): { args: string[]; artifacts: string[] } {
  const file = path.join(ctx.scratch, 'mcp.json')
  fs.mkdirSync(ctx.scratch, { recursive: true })
  const body = {
    mcpServers: {
      hub: {
        type: 'stdio',
        ...stdioConfig(ctx),
      },
    },
  }
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`)
  return { args: ['--mcp-config', file], artifacts: [file] }
}

/** OpenCode style: a config document pointed at by an env var. */
function configFileOverlay(ctx: SpawnContext): { env: Record<string, string>; artifacts: string[] } {
  const file = path.join(ctx.scratch, 'opencode.json')
  fs.mkdirSync(ctx.scratch, { recursive: true })
  const cfg = stdioConfig(ctx)
  const body = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      hub: { type: 'local', command: [cfg.command, ...cfg.args], enabled: true, environment: cfg.env },
    },
  }
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`)
  return { env: { OPENCODE_CONFIG: file }, artifacts: [file] }
}

/** Codex style: TOML-ish MCP table injected through `-c` overrides. */
function codexOverlay(ctx: SpawnContext): { args: string[] } {
  const cfg = stdioConfig(ctx)
  const args: string[] = []
  args.push('-c', `mcp_servers.hub.command=${JSON.stringify(cfg.command)}`)
  args.push('-c', `mcp_servers.hub.args=${JSON.stringify(cfg.args)}`)
  return { args }
}

export const cliGenericAdapter: Adapter = {
  name: 'cli-generic',
  build(ctx: SpawnContext): SpawnPlan {
    const env = buildChildEnv(ctx)
    const artifacts: string[] = []
    const extraArgs: string[] = []
    let injection = 'prompt only (no hub tools injected)'

    switch (ctx.agent.mcp_inject) {
      case 'mcp-json': {
        const overlay = mcpJsonOverlay(ctx)
        extraArgs.push(...overlay.args)
        artifacts.push(...overlay.artifacts)
        injection = `MCP config file ${path.basename(overlay.artifacts[0] ?? '')} (channel: mcp)`
        break
      }
      case 'config-file': {
        const overlay = configFileOverlay(ctx)
        Object.assign(env, overlay.env)
        artifacts.push(...overlay.artifacts)
        injection = 'config document via OPENCODE_CONFIG (channel: mcp)'
        break
      }
      case 'config-file-codex': {
        extraArgs.push(...codexOverlay(ctx).args)
        injection = '-c mcp_servers.hub.* overrides (channel: mcp)'
        break
      }
      case 'file-protocol': {
        injection = 'file protocol: `mesh` CLI (channel: file)'
        break
      }
      default:
        break
    }

    const args = [...ctx.agent.args, ...extraArgs, ...ctx.agent.headless_args]
    if (ctx.agent.prompt_flag) args.push(ctx.agent.prompt_flag, ctx.prompt)
    else args.push(ctx.prompt)

    const plan: SpawnPlan = {
      command: ctx.agent.command,
      args,
      cwd: ctx.worktree,
      env,
      artifacts,
      injection,
    }
    if (ctx.agent.prompt_mode === 'stdin') plan.stdin = ctx.prompt
    return plan
  },
}
