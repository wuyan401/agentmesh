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

/**
 * Prefix for workers on the file channel. Kept short: it is prepended to every
 * prompt, and the worker still gets the full protocol quickref from the context
 * package. What it must not have to guess is *how* to call the hub.
 */
const FILE_PROTOCOL_PREFIX = `【通道：file-protocol — 你没有 MCP 的 hub.* 工具】
用 shell 里的 \`mesh\` 命令完成协作，会话 ID 已在环境变量 MESH_SESSION_ID 里：
  mesh hello                 # 第一步，必须先做
  mesh task <T-id>           # 读任务卡
  mesh claim <T-id>          # 领任务
  mesh progress <T-id> --pct 50
  mesh submit <T-id> --summary "做了什么、怎么验证的"
不要跳过 mesh hello —— 没 hello 的会话没有权限，submit 会被拒绝。`

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

/**
 * OpenCode style: a V2 config document pointed at by `OPENCODE_CONFIG`.
 *
 * V2 nests servers under `mcp.servers` and uses `disabled` (there is no
 * `enabled` field). The env var is only read by a private server, so the launch
 * recipe for OpenCode must pass `--standalone`; otherwise the shared desktop
 * service keeps its own config and the hub tools never appear.
 */
function configFileOverlay(ctx: SpawnContext): { env: Record<string, string>; artifacts: string[] } {
  const file = path.join(ctx.scratch, 'opencode.json')
  fs.mkdirSync(ctx.scratch, { recursive: true })
  const cfg = stdioConfig(ctx)
  const body = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      servers: {
        hub: {
          type: 'local',
          command: [cfg.command, ...cfg.args],
          environment: cfg.env,
          // Keep hub tools as native tools instead of hiding them behind
          // OpenCode's Code Mode wrapper: the platform prompt names hub.hello(),
          // and a worker should not need a second indirection to find it.
          codemode: false,
        },
      },
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

    const args = [...ctx.agent.args]
    if (ctx.agent.subcommand) args.push(ctx.agent.subcommand)
    args.push(...extraArgs, ...ctx.agent.headless_args)
    // File-protocol workers have no hub MCP tools: name the CLI they must use,
    // and name it before anything else in the prompt, or a capable agent burns a
    // whole turn discovering that hub.hello() does not exist.
    const prompt = ctx.agent.mcp_inject === 'file-protocol'
      ? `${FILE_PROTOCOL_PREFIX}\n\n${ctx.prompt}`
      : ctx.prompt
    if (ctx.agent.prompt_flag) args.push(ctx.agent.prompt_flag, prompt)
    else args.push(prompt)

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
