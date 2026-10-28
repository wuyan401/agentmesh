/**
 * Git integration: the sandbox (worktrees) and the only output channel (merges).
 *
 * Two rules live here:
 *  - every task gets its own worktree + branch, so a Worker's cwd *is* its task;
 *  - merging into the main branch is a transaction: merge, verify every staged
 *    path against the task scope, then commit — or abort. There is no code path
 *    in AgentMesh that puts an out-of-scope file on the main branch.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { MeshError, MESH_ERRORS } from './errors.ts'
import { ensureDir, exists, normRel, toPosix } from './fsx.ts'
import type { MeshPaths } from './paths.ts'

export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

export interface GitOptions {
  cwd?: string
  allowFailure?: boolean
  input?: string
}

const PLATFORM_IDENTITY = [
  '-c',
  'user.name=AgentMesh',
  '-c',
  'user.email=mesh@agentmesh.local',
  '-c',
  'commit.gpgsign=false',
]

export class Git {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  static forPaths(paths: MeshPaths): Git {
    return new Git(paths.root)
  }

  run(args: string[], opts: GitOptions = {}): GitRunResult {
    const res = spawnSync('git', args, {
      cwd: opts.cwd ?? this.root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      input: opts.input,
    })
    if (res.error) {
      throw new MeshError(MESH_ERRORS.GIT_FAILED, `git ${args.join(' ')} failed to start: ${res.error.message}`, {
        args,
      })
    }
    const out: GitRunResult = { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
    if (out.code !== 0 && !opts.allowFailure) {
      throw new MeshError(MESH_ERRORS.GIT_FAILED, `git ${args.join(' ')} exited ${out.code}: ${out.stderr.trim()}`, {
        args,
        stdout: out.stdout,
        stderr: out.stderr,
      })
    }
    return out
  }

  // -- repository state ----------------------------------------------------

  isRepo(): boolean {
    return this.run(['rev-parse', '--is-inside-work-tree'], { allowFailure: true }).stdout.trim() === 'true'
  }

  /** Absolute path of the repository top level, or null. */
  toplevel(): string | null {
    const res = this.run(['rev-parse', '--show-toplevel'], { allowFailure: true })
    return res.code === 0 ? res.stdout.trim() : null
  }

  gitDir(): string {
    return this.run(['rev-parse', '--git-dir']).stdout.trim()
  }

  /** Resolve the repository's main branch: explicit `main`/`master`, else HEAD's branch. */
  detectMainBranch(): string {
    for (const candidate of ['main', 'master']) {
      if (this.refExists(`refs/heads/${candidate}`)) return candidate
    }
    const head = this.run(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true })
    const name = head.stdout.trim()
    return name && name !== 'HEAD' ? name : 'main'
  }

  refExists(ref: string): boolean {
    return this.run(['show-ref', '--verify', '--quiet', ref], { allowFailure: true }).code === 0
  }

  headSha(cwd?: string): string | null {
    const res = this.run(['rev-parse', 'HEAD'], { cwd, allowFailure: true })
    const sha = res.stdout.trim()
    return res.code === 0 && sha ? sha : null
  }

  branchExists(branch: string): boolean {
    return this.refExists(`refs/heads/${branch}`)
  }

  currentBranch(cwd?: string): string {
    return this.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, allowFailure: true }).stdout.trim()
  }

  /** Ensure there is at least one commit so worktrees and diffs have a base. */
  ensureBaseCommit(branch: string): string {
    const head = this.headSha()
    if (head) return head
    this.run(['checkout', '-B', branch], { allowFailure: true })
    this.run([...PLATFORM_IDENTITY, 'commit', '--allow-empty', '-m', 'mesh: initialize base commit'], {
      allowFailure: true,
    })
    return this.headSha() ?? ''
  }

  /** Git identity for platform-created commits, set repo-locally when absent. */
  ensureIdentity(): { name: string; email: string; created: boolean } {
    const name = this.run(['config', 'user.name'], { allowFailure: true }).stdout.trim()
    const email = this.run(['config', 'user.email'], { allowFailure: true }).stdout.trim()
    let created = false
    if (!name) {
      this.run(['config', 'user.name', 'AgentMesh Worker'], { allowFailure: true })
      created = true
    }
    if (!email) {
      this.run(['config', 'user.email', 'worker@agentmesh.local'], { allowFailure: true })
      created = true
    }
    return {
      name: name || 'AgentMesh Worker',
      email: email || 'worker@agentmesh.local',
      created,
    }
  }

  /** Ignore `.mesh/` without touching tracked files. */
  ignoreMeshDir(): void {
    const gitDir = path.isAbsolute(this.gitDir()) ? this.gitDir() : path.join(this.root, this.gitDir())
    const exclude = path.join(gitDir, 'info', 'exclude')
    ensureDir(path.dirname(exclude))
    const current = exists(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
    if (/^\.mesh\/?$/m.test(current)) return
    const addition = current.endsWith('\n') || current === '' ? '' : '\n'
    fs.appendFileSync(exclude, `${addition}.mesh/\n`)
  }

  // -- sandboxes -----------------------------------------------------------

  /**
   * Create (or re-attach) the sandbox for a task. Returns the absolute path.
   *
   * A sandbox is a *self-contained clone*, not a linked worktree. That is a hard
   * requirement: `git worktree` keeps the per-worktree metadata in
   * `<main>/.git/worktrees/<name>`, i.e. outside the sandbox root, so any agent
   * running under a workspace-scoped write sandbox (DeepSeek Harness, Claude Code,
   * Codex …) cannot lock the index and therefore cannot commit at all. A clone
   * carries its own `.git` inside the sandbox, so committing works under the
   * strictest sandbox a CLI offers — and isolation gets stronger, not weaker:
   * no shared index locks, no path from the sandbox into the main object store.
   *
   * `--shared` makes the clone borrow the source object database read-only and
   * create new objects locally, so creating a sandbox is milliseconds, not a copy.
   */
  /**
   * Classify a sandbox directory:
   *  - `absent` — nothing there, safe to create;
   *  - `clone`  — a usable self-contained clone;
   *  - `stale`  — something else (old linked worktree, half-written clone), replace it.
   */
  sandboxState(sandboxAbs: string): 'absent' | 'clone' | 'stale' {
    const dotGit = path.join(sandboxAbs, '.git')
    if (!exists(dotGit)) return exists(sandboxAbs) ? 'stale' : 'absent'
    try {
      if (!fs.statSync(dotGit).isDirectory()) return 'stale'
    } catch {
      return 'stale'
    }
    // A directory .git may still be a half-initialised clone.
    return exists(path.join(dotGit, 'HEAD')) ? 'clone' : 'stale'
  }

  ensureSandbox(sandboxAbs: string, branch: string, base: string): string {
    if (this.sandboxState(sandboxAbs) === 'clone') {
      // Re-attach: make sure it is on the task branch and has the identity.
      const current = this.currentBranch(sandboxAbs)
      if (current !== branch) this.run(['checkout', '--quiet', '-B', branch], { cwd: sandboxAbs, allowFailure: true })
      this.applyIdentity(sandboxAbs)
      return sandboxAbs
    }
    if (exists(sandboxAbs)) this.removeSandbox(sandboxAbs)
    if (exists(sandboxAbs)) fs.rmSync(sandboxAbs, { recursive: true, force: true })
    ensureDir(path.dirname(sandboxAbs))
    this.run(['clone', '--shared', '--no-checkout', '--quiet', this.root, sandboxAbs])
    // No remote: a sandbox must not have a push path back into the platform repo.
    this.run(['remote', 'remove', 'origin'], { cwd: sandboxAbs, allowFailure: true })
    this.run(['checkout', '--quiet', '-B', branch, base], { cwd: sandboxAbs })
    this.applyIdentity(sandboxAbs)
    return sandboxAbs
  }

  /** Give a sandbox the repo's identity so an agent's `git commit` just works. */
  private applyIdentity(sandboxAbs: string): void {
    const name = this.run(['config', 'user.name'], { allowFailure: true }).stdout.trim() || 'AgentMesh Worker'
    const email = this.run(['config', 'user.email'], { allowFailure: true }).stdout.trim() || 'worker@agentmesh.local'
    this.run(['config', 'user.name', name], { cwd: sandboxAbs, allowFailure: true })
    this.run(['config', 'user.email', email], { cwd: sandboxAbs, allowFailure: true })
  }

  removeSandbox(sandboxAbs: string): void {
    try {
      fs.rmSync(sandboxAbs, { recursive: true, force: true })
    } catch (e) {
      throw new MeshError(
        MESH_ERRORS.GIT_FAILED,
        `cannot remove sandbox ${sandboxAbs}: ${(e as Error).message}. A sandboxed agent may have left an ACL behind; delete it manually and re-dispatch.`,
        { sandbox: sandboxAbs },
      )
    }
  }

  /** HEAD of a sandbox's branch. */
  sandboxHead(sandboxAbs: string): string | null {
    return this.headSha(sandboxAbs)
  }

  /** Changed files measured *inside* the sandbox (the root repo may not have them yet). */
  sandboxChangedFiles(sandboxAbs: string, base: string, head: string): string[] {
    const res = this.run(['diff', '--name-only', '--no-renames', base, head], { cwd: sandboxAbs, allowFailure: true })
    if (res.code !== 0) return []
    return res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map(normRel)
      .sort()
  }

  /**
   * Copy a sandbox branch into the platform repo as `refs/mesh/<task>` so the
   * merge gate can diff and merge it. Force is safe: the ref is platform-owned.
   */
  fetchSandboxBranch(sandboxAbs: string, branch: string, taskId: string): string {
    const ref = `refs/mesh/${taskId}`
    this.run(['fetch', '--no-tags', '--quiet', '--force', sandboxAbs, `+refs/heads/${branch}:${ref}`])
    return ref
  }

  refExists2(ref: string): boolean {
    return this.run(['rev-parse', '--verify', '--quiet', ref], { allowFailure: true }).code === 0
  }

  listSandboxes(sandboxesDir: string): Array<{ dir: string; branch: string; head: string | null }> {
    if (!exists(sandboxesDir)) return []
    const out: Array<{ dir: string; branch: string; head: string | null }> = []
    for (const entry of fs.readdirSync(sandboxesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(sandboxesDir, entry.name)
      if (!exists(path.join(dir, '.git'))) continue
      const head = this.headSha(dir)
      const branch = this.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, allowFailure: true }).stdout.trim()
      out.push({ dir, branch, head })
    }
    return out
  }

  // -- diffs and commits ---------------------------------------------------

  /** Changed files between two revs, repo-relative posix paths, renamed paths resolved. */
  changedFiles(from: string, to: string): string[] {
    const res = this.run(['diff', '--name-only', '--no-renames', from, to], { allowFailure: true })
    if (res.code !== 0) return []
    return res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map(normRel)
      .sort()
  }

  /** Unified diff (truncated by callers) used as review evidence. */
  diff(from: string, to: string, paths?: string[]): string {
    const args = ['diff', '--no-renames', from, to]
    if (paths?.length) args.push('--', ...paths)
    return this.run(args, { allowFailure: true }).stdout
  }

  fileAt(rev: string, relpath: string): string | null {
    const res = this.run(['show', `${rev}:${relpath}`], { allowFailure: true })
    return res.code === 0 ? res.stdout : null
  }

  commitAll(cwd: string, message: string): string {
    this.run(['add', '-A'], { cwd })
    const staged = this.run(['diff', '--cached', '--name-only'], { cwd, allowFailure: true }).stdout.trim()
    if (!staged) return this.headSha(cwd) ?? ''
    this.run([...PLATFORM_IDENTITY, 'commit', '-m', message], { cwd })
    return this.headSha(cwd) ?? ''
  }

  statusPorcelain(cwd: string): string {
    return this.run(['status', '--porcelain'], { cwd, allowFailure: true }).stdout
  }

  isClean(cwd: string): boolean {
    return this.statusPorcelain(cwd).trim() === ''
  }

  /**
   * Commits reachable from a ref but not from `base`, newest first.
   *
   * `firstParent` is what drift detection needs: side-branch commits brought in by
   * a platform merge are legitimate, only the mainline history should be audited.
   */
  commitsSince(base: string | null, opts: { branch?: string; maxCount?: number; firstParent?: boolean } = {}): Array<{
    sha: string
    parents: string[]
    subject: string
    author: string
    date: string
  }> {
    const range = base ? `${base}..${opts.branch ?? 'HEAD'}` : (opts.branch ?? 'HEAD')
    const fmt = '--pretty=format:%H%x1f%P%x1f%s%x1f%an%x1f%cI'
    const args = ['log', fmt, `--max-count=${opts.maxCount ?? 200}`]
    if (opts.firstParent) args.push('--first-parent')
    args.push(range)
    const res = this.run(args, { allowFailure: true })
    if (res.code !== 0) return []
    return res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha = '', parents = '', subject = '', author = '', date = ''] = line.split('\x1f')
        return { sha, parents: parents.split(' ').filter(Boolean), subject, author, date }
      })
  }

  // -- merge transaction ---------------------------------------------------

  /**
   * Attempt a merge of `branch` into the main branch without committing.
   * Returns the list of staged paths. Throws on conflicts (after aborting).
   */
  beginMerge(mainBranch: string, branch: string): string[] {
    if (!this.isClean(this.root)) {
      throw new MeshError(MESH_ERRORS.GIT_FAILED, 'main working tree is not clean; refusing to merge', {
        status: this.statusPorcelain(this.root).slice(0, 2000),
      })
    }
    this.run(['checkout', mainBranch])
    const res = this.run(['merge', '--no-ff', '--no-commit', '--no-edit', branch], { allowFailure: true })
    if (res.code !== 0) {
      this.run(['merge', '--abort'], { allowFailure: true })
      throw new MeshError(MESH_ERRORS.GIT_FAILED, `merge conflict merging ${branch}: ${res.stderr.trim()}`, {
        branch,
        stderr: res.stderr,
      })
    }
    const staged = this.run(['diff', '--cached', '--name-only'], { allowFailure: true }).stdout
    return staged
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map(normRel)
      .sort()
  }

  /** Drop the given paths from an in-progress merge, restoring them to HEAD. */
  stripPaths(paths: string[]): void {
    if (paths.length === 0) return
    this.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths])
  }

  commitMerge(message: string): string {
    this.run([...PLATFORM_IDENTITY, 'commit', '--no-edit', '-m', message])
    return this.headSha() ?? ''
  }

  abortMerge(): void {
    this.run(['merge', '--abort'], { allowFailure: true })
    this.run(['reset', '--hard', 'HEAD'], { allowFailure: true })
  }
}
