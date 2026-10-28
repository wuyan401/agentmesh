/**
 * Agent discovery: find the CLI agents this machine actually has, and produce
 * launch recipes for them.
 *
 * Detection is manual-config-first (the plan defers capability auto-detection to
 * post-M5). This module only answers "which binaries exist and how does this
 * version of each CLI take a one-shot prompt" — `capabilities` stay a human
 * decision, written into the agent card at registration time.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { AgentCard, RoleId } from '../core/types.ts'

export interface DetectContext {
  /** Node executable used to run JS-entry CLIs. */
  nodeExe: string
  /** Extra hints from the environment (MESH_DSH_BIN, MESH_HERMES_BIN, ...). */
  env: NodeJS.ProcessEnv
  /** Candidate roots to probe for locally-installed CLIs. */
  probeRoots: string[]
}

export interface DetectedAgent {
  card: AgentCard
  available: boolean
  source: string
  version: string | null
}

function which(cmd: string): string | null {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true })
  if (res.status !== 0) return null
  const first = (res.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0]
  return first ?? null
}

function tryVersion(cmd: string, args: string[] = ['--version']): string | null {
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    const text = `${res.stdout ?? ''}${res.stderr ?? ''}`.split('\n').map((l) => l.trim()).filter(Boolean)[0]
    return text ? text.slice(0, 120) : null
  } catch {
    return null
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Find a DSH CLI entry point (`apps/cli/lib/bin.js`). */
export function findDshBin(ctx: DetectContext): string | null {
  const fromEnv = ctx.env.MESH_DSH_BIN
  if (fromEnv && fileExists(fromEnv)) return fromEnv
  const candidates: string[] = []
  for (const root of ctx.probeRoots) {
    candidates.push(path.join(root, 'apps', 'cli', 'lib', 'bin.js'))
    candidates.push(path.join(root, 'DSH', 'apps', 'cli', 'lib', 'bin.js'))
  }
  candidates.push('D:/AI/DSH/apps/cli/lib/bin.js')
  for (const c of candidates) {
    if (fileExists(c)) return path.resolve(c)
  }
  const onPath = which('dsh')
  if (onPath) {
    // A published CLI is its own executable; signal that with the bare name.
    return onPath
  }
  return null
}

function findHermes(ctx: DetectContext): string | null {
  const fromEnv = ctx.env.MESH_HERMES_BIN
  if (fromEnv && fileExists(fromEnv)) return fromEnv
  const direct = which('hermes')
  if (direct) return direct
  for (const root of ctx.probeRoots) {
    const installs = path.join(root, 'Hermes', 'installs')
    if (!fs.existsSync(installs)) continue
    try {
      for (const id of fs.readdirSync(installs)) {
        const envs = path.join(installs, id, 'environments')
        if (!fs.existsSync(envs)) continue
        for (const envId of fs.readdirSync(envs)) {
          const exe = path.join(envs, envId, 'venv', 'Scripts', 'hermes.exe')
          if (fileExists(exe)) return exe
        }
      }
    } catch {
      /* unreadable install dir */
    }
  }
  return null
}

const ALL_ROLES: RoleId[] = [
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
  'lead',
]

function dshCard(command: string, bin: string, displayName: string, capabilities: RoleId[]): AgentCard {
  return {
    agent_id: 'dsh-01',
    display_name: displayName,
    kind: 'dsh',
    enabled: true,
    // `dsh` published binary takes the profile itself; a checkout entry needs node.
    command: bin.endsWith('bin.js') ? command : bin,
    args: bin.endsWith('bin.js') ? [bin, '--profile', 'headless'] : ['--profile', 'headless'],
    capabilities,
    concurrency: 2,
    cost_tier: 2,
    transport: 'mcp',
    mcp_inject: 'dsh-patch',
    extra_env: {},
    strip_env: ['DSH_SESSION_ID', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SHELL', 'DSH_WEB_URL', 'DSH_GOAL_ID'],
    prompt_mode: 'arg',
    prompt_flag: null,
    headless_args: [],
    ttl_seconds: 1800,
    notes: 'DeepSeek Harness headless profile; hub tools injected as an MCP server via --patch',
  }
}

function hermesCard(command: string): AgentCard {
  return {
    agent_id: 'hermes-01',
    display_name: 'Hermes Agent',
    kind: 'hermes',
    enabled: true,
    command,
    args: [],
    capabilities: ['planner', 'researcher', 'frontend_dev', 'backend_dev', 'executor', 'supervisor', 'sentinel', 'lead'],
    // One at a time: Hermes shares a profile with whatever else is installed on the
    // machine, and parallel one-shot runs contend on it.
    concurrency: 1,
    // Hermes is thorough but slow (~50s warm-up per turn): reserve it for depth,
    // and let the scheduler prefer a cheaper agent when one is free.
    cost_tier: 3,
    transport: 'file',
    mcp_inject: 'file-protocol',
    extra_env: {},
    strip_env: ['HERMES_SESSION_ID'],
    // Hermes: `hermes chat -q "<prompt>" --oneshot -Q` answers once and exits.
    prompt_mode: 'arg',
    prompt_flag: '-q',
    headless_args: ['chat', '--oneshot', '-Q', '--format', 'text'],
    ttl_seconds: 1800,
    notes: 'file-protocol channel: uses the `mesh` CLI from Bash; no MCP needed',
  }
}

/**
 * Probe the machine and return one card per agent family. Unavailable families
 * are returned disabled with a note, so `mesh agents doctor` can explain what is
 * missing instead of the board silently having no workers.
 */
export function detectAgents(ctx: DetectContext): DetectedAgent[] {
  const out: DetectedAgent[] = []

  const dshBin = findDshBin(ctx)
  if (dshBin) {
    out.push({
      card: dshCard(ctx.nodeExe, dshBin, 'DeepSeek Harness', ALL_ROLES),
      available: true,
      source: dshBin,
      version: null,
    })
  } else {
    out.push({
      card: { ...dshCard(ctx.nodeExe, 'dsh', 'DeepSeek Harness', ALL_ROLES), enabled: false },
      available: false,
      source: 'not found',
      version: null,
    })
  }

  const hermesBin = findHermes(ctx)
  if (hermesBin) {
    out.push({
      card: hermesCard(hermesBin),
      available: true,
      source: hermesBin,
      version: tryVersion(hermesBin, ['--version']),
    })
  } else {
    out.push({
      card: { ...hermesCard('hermes'), enabled: false },
      available: false,
      source: 'not found',
      version: null,
    })
  }

  // Uninstalled families still get a card template so registration is one command.
  const optional: Array<{ id: string; cmd: string; display: string; kind: AgentCard['kind']; roles: RoleId[]; inject: AgentCard['mcp_inject'] }> = [
    { id: 'claude-code-01', cmd: 'claude', display: 'Claude Code', kind: 'claude-code', roles: ['frontend_dev', 'backend_dev', 'supervisor', 'planner', 'architect', 'lead'], inject: 'mcp-json' },
    { id: 'codex-01', cmd: 'codex', display: 'Codex', kind: 'codex', roles: ['frontend_dev', 'backend_dev', 'executor', 'supervisor', 'lead'], inject: 'config-file-codex' },
    { id: 'opencode-01', cmd: 'opencode', display: 'OpenCode', kind: 'opencode', roles: ['frontend_dev', 'backend_dev', 'executor', 'lead'], inject: 'config-file' },
  ]
  for (const opt of optional) {
    const found = which(opt.cmd)
    out.push({
      card: {
        agent_id: opt.id,
        display_name: opt.display,
        kind: opt.kind,
        enabled: Boolean(found),
        command: found ?? opt.cmd,
        args: [],
        capabilities: opt.roles,
        concurrency: 2,
        cost_tier: 2,
        transport: 'mcp',
        mcp_inject: opt.inject,
        extra_env: {},
        strip_env: [],
        prompt_mode: 'arg',
        prompt_flag: opt.kind === 'opencode' ? 'run' : '-p',
        headless_args: [],
        ttl_seconds: 1800,
        notes: found ? 'detected on PATH' : 'not installed on this machine; recipe kept for portability',
      },
      available: Boolean(found),
      source: found ?? 'not found',
      version: found ? tryVersion(found) : null,
    })
  }

  // The deterministic platform agent: it holds integration and audit duties, so a
  // board never deadlocks when no LLM agent is available for those roles.
  out.push({
    card: {
      agent_id: 'mesh-hub',
      display_name: 'AgentMesh Hub (builtin)',
      kind: 'builtin',
      enabled: true,
      command: '',
      args: [],
      capabilities: ['integrator', 'sentinel'],
      concurrency: 64,
      cost_tier: 1,
      transport: 'in-process',
      mcp_inject: 'none',
      extra_env: {},
      strip_env: [],
      prompt_mode: 'arg',
      prompt_flag: null,
      headless_args: [],
      ttl_seconds: 3600,
      notes: 'deterministic core acting as integrator/sentinel; no LLM, no process',
    },
    available: true,
    source: 'builtin',
    version: null,
  })

  return out
}

export function defaultDetectContext(probeRoots: string[] = []): DetectContext {
  const roots = [...probeRoots, 'D:\\AI', path.parse(process.cwd()).root]
  return { nodeExe: process.execPath, env: process.env, probeRoots: roots }
}
