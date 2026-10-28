/**
 * Register the scripted agents used by the M1/M2 acceptance walks.
 *
 * This is scaffolding for `docs/ACCEPTANCE-V2.md`, not platform code: it writes
 * ordinary AgentCards through the same validated `saveAgent` path `mesh init` uses.
 * Run inside an initialised project:
 *
 *   node tests/fixtures/register-scripted.ts .
 *
 * Four agents, chosen so the scoring rules are observable:
 *   scripted-01   good worker   (backend/frontend/executor)
 *   scripted-02   supervisor    (checks the submitted files)
 *   scripted-03   good worker   (identical to 01 — the scoring tie-break demo)
 *   scripted-bad  bad worker    (same capabilities, submits work that must be rejected)
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

function workerCard(agentId: string, display: string, extraEnv: Record<string, string> = {}): AgentCard {
  return { ...worker, agent_id: agentId, display_name: display, extra_env: extraEnv }
}

const workerB = workerCard('scripted-03', 'Scripted worker B (M2 scoring)')
const badWorker = workerCard('scripted-bad', 'Scripted bad worker (M2 reassignment)', { MESH_SCRIPTED_MODE: 'bad' })

hub.store.saveAgent(worker)
hub.store.saveAgent(supervisor)
hub.store.saveAgent(workerB)
hub.store.saveAgent(badWorker)
// Every agent gets a profile at init (§2.1); make sure the scripted ones have one too.
hub.profiles.backfill()
process.stdout.write(
  `registered ${[worker, supervisor, workerB, badWorker].map((a) => a.agent_id).join(', ')} in ${hub.paths.root}\n`,
)
