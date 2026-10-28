import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { dshAdapter, dshPatchYaml } from '../../hub/adapters/dsh.ts'
import { hermesAdapter } from '../../hub/adapters/hermes.ts'
import { cliGenericAdapter } from '../../hub/adapters/cli-generic.ts'
import { buildChildEnv, toolPrefixFor, adapterFor } from '../../hub/adapters/index.ts'
import { buildPrompt } from '../../hub/scheduler/prompt.ts'
import { createHarness, addAgent, createReadyTask, newSession } from '../helpers.ts'
import type { SpawnContext } from '../../hub/adapters/types.ts'

function ctxFor(harness: ReturnType<typeof createHarness>, agentId: string): SpawnContext {
  const agent = harness.hub.store.requireAgent(agentId)
  const session = newSession(harness.hub, agentId, 'backend_dev')
  const task = createReadyTask(harness.hub, { write: ['src/a.ts'] })
  const worktree = path.join(harness.dir, 'sandbox')
  fs.mkdirSync(worktree, { recursive: true })
  const prompt = 'prompt body'
  return {
    hub: harness.hub,
    session,
    agent,
    role: 'backend_dev',
    task,
    worktree,
    prompt,
    scratch: path.join(harness.hub.paths.sessionScratch(session.session_id)),
    contextPath: null,
  }
}

test('adapter dsh: hub is injected as an MCP server via a per-session --patch overlay', () => {
  const h = createHarness('adapter-dsh')
  try {
    addAgent(h.hub, 'dsh-01', ['backend_dev'], {
      kind: 'dsh',
      command: process.execPath,
      args: ['--profile', 'headless'],
      transport: 'mcp',
      mcp_inject: 'dsh-patch',
    })
    const ctx = ctxFor(h, 'dsh-01')
    const plan = dshAdapter.build(ctx)
    assert.equal(plan.command, process.execPath)
    assert.ok(plan.args.includes('--patch'))
    const patchFile = plan.args[plan.args.indexOf('--patch') + 1]!
    const yaml = fs.readFileSync(patchFile, 'utf8')
    assert.match(yaml, /serverName: hub/)
    assert.match(yaml, /@deepseek-ai\/dsh-mcp-client/)
    assert.match(yaml, new RegExp(ctx.session.session_id))
    assert.match(yaml, /failOnStartupError: true/)
    // C2/C4: nothing in the launch recipe may restrict tools.
    for (const forbidden of ['allowedTools', 'disallowedTools', 'tool_policy', 'tools_deny', 'deny:']) {
      assert.ok(!yaml.includes(forbidden), `launch recipe must not contain ${forbidden}`)
    }
    assert.equal(toolPrefixFor(ctx.agent), 'mcp__hub__')
  } finally {
    h.cleanup()
  }
})

test('adapter dsh: the spawned child never inherits the spawning session identity', () => {
  const h = createHarness('adapter-env')
  const saved = { ...process.env }
  try {
    addAgent(h.hub, 'dsh-01', ['backend_dev'], { kind: 'dsh', command: process.execPath })
    const ctx = ctxFor(h, 'dsh-01')
    process.env['DSH_SESSION_ID'] = 'session-that-must-not-leak'
    process.env['DSH_PROFILE'] = 'desktop'
    process.env['MESH_SESSION_ID'] = 'stale-value'
    const env = buildChildEnv(ctx)
    assert.equal(env['DSH_SESSION_ID'], undefined, 'a child must not think it is the parent session')
    assert.equal(env['DSH_PROFILE'], undefined)
    assert.equal(env['MESH_SESSION_ID'], ctx.session.session_id)
    assert.equal(env['MESH_ROOT'], h.hub.paths.root)
    assert.equal(env['MESH_AGENT_ID'], 'dsh-01')
    assert.ok(env['PATH']?.includes(process.execPath.replace(/[\\/][^\\/]+$/, '')))
    assert.ok(env['DSH_HOME'], 'credentials home must survive')
  } finally {
    process.env = saved
    h.cleanup()
  }
})

test('adapter hermes: file protocol, no MCP, prompt passed through -q', () => {
  const h = createHarness('adapter-hermes')
  try {
    addAgent(h.hub, 'hermes-01', ['backend_dev'], {
      kind: 'hermes',
      command: 'hermes.exe',
      args: [],
      headless_args: ['chat', '--oneshot', '-Q', '--format', 'text'],
      prompt_flag: '-q',
      transport: 'file',
      mcp_inject: 'file-protocol',
    })
    const ctx = ctxFor(h, 'hermes-01')
    const plan = hermesAdapter.build(ctx)
    assert.equal(plan.args[0], 'chat')
    assert.ok(plan.args.includes('-q'))
    assert.equal(plan.args[plan.args.indexOf('-q') + 1], 'prompt body')
    assert.equal(plan.injection.includes('file protocol'), true)
    assert.equal(toolPrefixFor(ctx.agent), null, 'file protocol agents have no MCP tool prefix')
    assert.equal(plan.artifacts.length, 0)
  } finally {
    h.cleanup()
  }
})

test('adapter cli-generic: writes an MCP config file for claude-code style clients', () => {
  const h = createHarness('adapter-claude')
  try {
    addAgent(h.hub, 'claude-code-01', ['backend_dev'], {
      kind: 'claude-code',
      command: 'claude',
      mcp_inject: 'mcp-json',
      prompt_flag: '-p',
    })
    const ctx = ctxFor(h, 'claude-code-01')
    const plan = cliGenericAdapter.build(ctx)
    assert.equal(plan.args[0], '--mcp-config')
    const cfgFile = plan.args[1]!
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as {
      mcpServers: { hub: { command: string; args: string[]; env: Record<string, string> } }
    }
    assert.ok(cfg.mcpServers.hub)
    assert.match(cfg.mcpServers.hub.args.join(' '), /hub[\\/]mcp[\\/]server\.ts/)
    assert.equal(cfg.mcpServers.hub.env['MESH_SESSION_ID'], ctx.session.session_id)
    assert.ok(plan.args.includes('-p'))
    assert.equal(adapterFor(ctx.agent).name, 'cli-generic')
  } finally {
    h.cleanup()
  }
})

test('prompt: changes per role — a supervisor is not told to commit and submit', () => {
  const h = createHarness('prompt-roles')
  try {
    addAgent(h.hub, 'worker', ['backend_dev', 'supervisor', 'integrator'], { kind: 'generic', command: 'node' })
    const task = createReadyTask(h.hub, { write: ['src/a.ts'], acceptance: ['it exists'] })

    const workerSession = newSession(h.hub, 'worker', 'backend_dev')
    const workerPrompt = buildPrompt({
      paths: h.hub.paths,
      session: workerSession,
      agent: h.hub.store.requireAgent('worker'),
      role: 'backend_dev',
      task,
      worktree: 'W',
      toolPrefix: 'hub_',
      contextPath: 'C',
    })
    assert.match(workerPrompt, /git add -A && git commit/)
    assert.match(workerPrompt, /submit/)

    const supervisorSession = newSession(h.hub, 'worker', 'supervisor')
    const supervisorPrompt = buildPrompt({
      paths: h.hub.paths,
      session: supervisorSession,
      agent: h.hub.store.requireAgent('worker'),
      role: 'supervisor',
      task,
      worktree: 'W',
      toolPrefix: 'hub_',
      contextPath: 'C',
    })
    assert.match(supervisorPrompt, /verdict/)
    assert.ok(!supervisorPrompt.includes('git add -A && git commit'), 'a reviewer must not be told to implement')
    assert.match(supervisorPrompt, /不要改代码/)

    const integratorSession = newSession(h.hub, 'worker', 'integrator')
    const integratorPrompt = buildPrompt({
      paths: h.hub.paths,
      session: integratorSession,
      agent: h.hub.store.requireAgent('worker'),
      role: 'integrator',
      task,
      worktree: 'W',
      toolPrefix: 'hub_',
      contextPath: 'C',
    })
    assert.match(integratorPrompt, /merge\("T-\d{6}"\)/)
    assert.ok(!integratorPrompt.includes('git add -A && git commit'))
  } finally {
    h.cleanup()
  }
})

test('prompt: every role card states it in the second person without leaking another role', () => {
  const h = createHarness('prompt-isolation')
  try {
    addAgent(h.hub, 'worker', ['backend_dev', 'supervisor'], { kind: 'generic', command: 'node' })
    const task = createReadyTask(h.hub, { write: ['src/a.ts'] })
    const session = newSession(h.hub, 'worker', 'backend_dev')
    const prompt = buildPrompt({
      paths: h.hub.paths,
      session,
      agent: h.hub.store.requireAgent('worker'),
      role: 'backend_dev',
      task,
      worktree: 'W',
      toolPrefix: 'hub_',
      contextPath: 'C',
    })
    assert.match(prompt, /本会话中你仅是/)
    assert.match(prompt, /不得沿用、暗示或援引其他任何会话/)
    assert.ok(!prompt.includes('Supervisor 监督者'), 'the worker prompt must not carry another role card')
  } finally {
    h.cleanup()
  }
})
