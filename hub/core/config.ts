/**
 * Mesh configuration (`.mesh/config.json`) — the knobs a human owns.
 *
 * Deliberately small: policy that belongs to the platform is code (C5), and
 * anything an agent could benefit from flipping must not be writable by agents.
 */

import path from 'node:path'
import { readJsonIfExists, writeJsonAtomic, exists } from './fsx.ts'
import type { MeshPaths } from './paths.ts'
import type { ContextLevel } from './context.ts'

export interface MeshConfig {
  version: number
  /** Agent used when a human `mesh talk`s without one running. */
  coordinator_agent: string | null
  /** Run the merge step automatically once a task is approved. */
  auto_integrate: boolean
  /** Spawn a supervisor automatically when something is submitted. */
  auto_review: boolean
  /** Cap on concurrently running P-Sessions across the whole board. */
  max_concurrent_sessions: number
  /** Dispatch loop period for `mesh up`. */
  dispatch_interval_ms: number
  /** Default context package level. */
  context_level: ContextLevel
  /** Kill a Worker that has not heartbeated within this many seconds. */
  stale_session_seconds: number
  /** Ask the supervisor to run project commands (tests/build) during review. */
  review_runs_checks: boolean
}

export const DEFAULT_CONFIG: MeshConfig = {
  version: 1,
  coordinator_agent: null,
  auto_integrate: true,
  auto_review: true,
  max_concurrent_sessions: 4,
  dispatch_interval_ms: 3000,
  context_level: 'standard',
  stale_session_seconds: 1800,
  review_runs_checks: true,
}

export function configFile(paths: MeshPaths): string {
  return path.join(paths.meshDir, 'config.json')
}

export function loadConfig(paths: MeshPaths): MeshConfig {
  const raw = readJsonIfExists<Partial<MeshConfig>>(configFile(paths))
  return { ...DEFAULT_CONFIG, ...(raw ?? {}) }
}

export function saveConfig(paths: MeshPaths, config: MeshConfig): void {
  writeJsonAtomic(configFile(paths), config)
}

export function patchConfig(paths: MeshPaths, patch: Partial<MeshConfig>): MeshConfig {
  const current = loadConfig(paths)
  const next = { ...current, ...patch, version: current.version }
  saveConfig(paths, next)
  return next
}

export function configExists(paths: MeshPaths): boolean {
  return exists(configFile(paths))
}
