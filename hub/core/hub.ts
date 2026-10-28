/**
 * Hub wiring: one object that holds the deterministic core and can be opened
 * from a project root. Both front-ends (MCP server for agents, `mesh` CLI for
 * humans) construct a Hub and talk to the same objects.
 */

import path from 'node:path'
import { MeshError, MESH_ERRORS } from './errors.ts'
import { MeshPaths } from './paths.ts'
import { MeshStore } from './store.ts'
import { Git } from './git.ts'
import { IdentityService } from './identity.ts'
import { MessageBus } from './messages.ts'
import { Audit } from './audit.ts'
import { ContextBuilder } from './context.ts'
import { Board } from './board.ts'
import { loadConfig } from './config.ts'
import type { MeshConfig } from './config.ts'

export class Hub {
  readonly paths: MeshPaths
  readonly store: MeshStore
  readonly git: Git
  readonly identity: IdentityService
  readonly bus: MessageBus
  readonly audit: Audit
  readonly context: ContextBuilder
  readonly board: Board
  private readonly configCache: { value: MeshConfig | null }

  constructor(paths: MeshPaths) {
    this.paths = paths
    this.store = new MeshStore(paths)
    this.git = new Git(paths.root)
    this.identity = new IdentityService(this.store)
    this.audit = new Audit(this.store)
    this.bus = new MessageBus(this.store)
    this.context = new ContextBuilder(this.store)
    this.board = new Board({
      store: this.store,
      git: this.git,
      identity: this.identity,
      bus: this.bus,
      audit: this.audit,
      context: this.context,
    })
    this.configCache = { value: null }
  }

  static open(start: string = process.cwd()): Hub {
    const paths = MeshPaths.discover(start)
    return new Hub(paths)
  }

  static openOrThrow(root: string): Hub {
    const paths = new MeshPaths(root)
    if (!paths.isInitialized()) {
      throw new MeshError(MESH_ERRORS.NOT_INITIALIZED, `no .mesh/state.json under ${root}`, { root })
    }
    return new Hub(paths)
  }

  get config(): MeshConfig {
    if (!this.configCache.value) this.configCache.value = loadConfig(this.paths)
    return this.configCache.value
  }

  invalidateConfig(): void {
    this.configCache.value = null
  }

  /** Resolve a path argument safely inside the project (or the mesh dir). */
  resolveInside(relpath: string): string {
    const abs = path.resolve(this.paths.root, relpath)
    const rel = path.relative(this.paths.root, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new MeshError(MESH_ERRORS.SCOPE_VIOLATION, `path escapes the project: ${relpath}`, { path: relpath })
    }
    return abs
  }
}
