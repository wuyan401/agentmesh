/**
 * Test harness: a throwaway git project with an initialised mesh.
 *
 * Deliberately hermetic — agent auto-detection is off, so tests never depend on
 * which CLIs this machine happens to have installed.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hub } from '../hub/core/hub.ts'
import { MeshPaths } from '../hub/core/paths.ts'
import { initMesh } from '../hub/core/init.ts'
import { Git } from '../hub/core/git.ts'
import type { AgentCard, RoleId, SessionCard, TaskCard } from '../hub/core/types.ts'

export interface Harness {
  dir: string
  hub: Hub
  git: Git
  cleanup: () => void
}

let counter = 0

export function createHarness(name = 'mesh-test'): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-${process.pid}-${counter++}-`))
  const git = new Git(dir)
  git.run(['init', '-b', 'main'])
  git.run(['config', 'user.name', 'Test'])
  git.run(['config', 'user.email', 'test@example.com'])
  fs.writeFileSync(path.join(dir, 'README.md'), '# test project\n')
  git.run(['add', '-A'])
  git.run(['commit', '-m', 'init'])
  const result = initMesh({ root: dir, projectName: name, detect: false })
  const hub = new Hub(result.paths)
  return {
    dir,
    hub,
    git,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* windows file locks: best effort */
      }
    },
  }
}

export function addAgent(
  hub: Hub,
  agentId: string,
  capabilities: RoleId[],
  overrides: Partial<AgentCard> = {},
): AgentCard {
  const card: AgentCard = {
    agent_id: agentId,
    display_name: agentId,
    kind: 'generic',
    enabled: true,
    command: 'node',
    args: [],
    capabilities,
    concurrency: 4,
    cost_tier: 2,
    transport: 'file',
    mcp_inject: 'file-protocol',
    extra_env: {},
    strip_env: [],
    prompt_mode: 'arg',
    prompt_flag: null,
    headless_args: [],
    ttl_seconds: 600,
    notes: 'test agent',
    ...overrides,
  }
  hub.store.saveAgent(card)
  return card
}

/** Create a Session and mark it hello'd (what a real worker does on start-up). */
export function newSession(
  hub: Hub,
  agentId: string,
  role: RoleId,
  opts: { task?: string | null; lifespan?: 'ephemeral' | 'daemon'; sandbox?: string | null } = {},
): SessionCard {
  const created = hub.identity.createSession({
    agent_id: agentId,
    role,
    task: opts.task ?? null,
    spawned_by: 'test',
    lifespan: opts.lifespan,
    sandbox: opts.sandbox ?? null,
    ttl_seconds: 600,
  })
  hub.identity.hello(created.session_id)
  return hub.store.requireSession(created.session_id)
}

export function createReadyTask(
  hub: Hub,
  input: {
    title?: string
    role?: RoleId
    write?: string[]
    acceptance?: string[]
    depends_on?: string[]
  } = {},
): TaskCard {
  return hub.board.createTask({
    title: input.title ?? 'implement a thing',
    role: input.role ?? 'backend_dev',
    scope: { write: input.write ?? ['src/thing.ts'], read: ['README.md'] },
    acceptance: input.acceptance ?? ['it exists', 'it works'],
    depends_on: input.depends_on ?? [],
  })
}

/** Write a file inside the task worktree and commit it on the task branch. */
export function commitInWorktree(harness: Harness, task: TaskCard, files: Record<string, string>, message = 'work'): string {
  const worktree = path.resolve(harness.dir, task.worktree ?? path.join('.mesh', 'worktrees', task.task_id))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(worktree, rel.split('/').join(path.sep))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return harness.git.commitAll(worktree, message)
}

export function worktreeOf(harness: Harness, task: TaskCard): string {
  return path.resolve(harness.dir, task.worktree ?? path.join('.mesh', 'worktrees', task.task_id))
}

export function readJsonFile<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

export function meshDir(harness: Harness): string {
  return path.join(harness.dir, '.mesh')
}

export function openHub(dir: string): Hub {
  return new Hub(MeshPaths.discover(dir))
}
