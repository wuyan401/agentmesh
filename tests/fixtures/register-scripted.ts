/**
 * Register the two scripted agents used by the M1 acceptance walk.
 *
 * This is scaffolding for `docs/ACCEPTANCE-V2.md`, not platform code: it writes two
 * ordinary AgentCards through the same validated `saveAgent` path `mesh init` uses.
 * Run inside an initialised project:
 *
 *   node tests/fixtures/register-scripted.ts .
 */

import path from 'node:path'
import { Hub } from '../../hub/core/hub.ts'
import { MeshPaths } from '../../hub/core/paths.ts'
import type { AgentCard } from '../../hub/core/types.ts'

const root = path.resolve(process.argv[2] ?? process.cwd())
const hub = new Hub(MeshPaths.discover(root))
const fixturesDir = import.meta.dirname

const worker: AgentCard = {
  agent_id: 'scripted-01',
  display_name: 'Scripted worker (M1 acceptance)',
  kind: 'generic',
  enabled: true,
  command: process.execPath,
  args: [path.join(fixturesDir, 'scripted-worker.mjs')],
  capabilities: ['backend_dev', 'frontend_dev', 'executor'],
  concurrency: 4,
  cost_tier: 1,
  transport: 'file',
  mcp_inject: 'file-protocol',
  extra_env: {},
  strip_env: [],
  prompt_mode: 'arg',
  prompt_flag: null,
  headless_args: [],
  ttl_seconds: 300,
  notes: 'M1 scaffolding: claim → write → commit → submit, no LLM',
}

const supervisor: AgentCard = {
  agent_id: 'scripted-02',
  display_name: 'Scripted supervisor (M1 acceptance)',
  kind: 'generic',
  enabled: true,
  command: process.execPath,
  args: [path.join(fixturesDir, 'scripted-supervisor.mjs')],
  capabilities: ['supervisor'],
  concurrency: 4,
  cost_tier: 1,
  transport: 'file',
  mcp_inject: 'file-protocol',
  extra_env: {},
  strip_env: [],
  prompt_mode: 'arg',
  prompt_flag: null,
  headless_args: [],
  ttl_seconds: 300,
  notes: 'M1 scaffolding: checks the submitted files, then verdicts',
}

hub.store.saveAgent(worker)
hub.store.saveAgent(supervisor)
process.stdout.write(`registered ${worker.agent_id} and ${supervisor.agent_id} in ${hub.paths.root}\n`)
