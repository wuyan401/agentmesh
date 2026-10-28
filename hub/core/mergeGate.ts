/**
 * The merge gate (§10.3) — the last line of defence, and the reason tool freedom
 * is safe. Everything an agent can technically do ends here, at the one place
 * that decides whether bytes are allowed onto the main branch.
 *
 * Algorithm:
 *   1. `git diff base..task-branch --name-only` → the change list
 *   2. change list − TaskCard.scope.write        → the out-of-scope set
 *   3. empty → merge; non-empty → refuse the whole submission with diff evidence
 *      (a Supervisor may authorise "strip the out-of-scope files and merge", in
 *      which case the stripped paths are recorded in the audit trail instead of
 *      disappearing)
 *
 * The merge itself is a transaction: merge --no-commit, verify every staged path,
 * then commit — or abort. A final verification against the committed result
 * covers the (unlikely) case that git staged something the precheck missed.
 */

import path from 'node:path'
import { MeshError, MESH_ERRORS } from './errors.ts'
import { exists, normRel, outOfScope } from './fsx.ts'
import type { Git } from './git.ts'
import type { MeshPaths } from './paths.ts'
import type { MergeMode, TaskCard } from './types.ts'

export interface ScopeCheck {
  task_id: string
  branch: string
  base: string
  files: string[]
  out_of_scope: string[]
  scope_write: string[]
  ok: boolean
}

/**
 * Make a task's committed work visible to the platform repo as `refs/mesh/<task>`.
 *
 * The sandbox is a separate clone (see `Git.ensureSandbox`), so its commits are
 * not in the platform repo until fetched. Fetching by path is read-only from the
 * sandbox's point of view and needs no remote configured.
 */
export function ensureMeshRef(git: Git, paths: MeshPaths, task: TaskCard): string {
  const ref = `refs/mesh/${task.task_id}`
  const sandbox = task.worktree ? path.resolve(paths.root, task.worktree) : paths.worktree(task.task_id)
  if (exists(sandbox)) {
    const sourceBranch = task.submission?.branch ?? task.branch
    const hasBranch = git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${sourceBranch}`], {
      cwd: sandbox,
      allowFailure: true,
    }).code === 0
    if (hasBranch) {
      git.fetchSandboxBranch(sandbox, sourceBranch, task.task_id)
      return ref
    }
    const sha = git.sandboxHead(sandbox)
    if (sha) {
      git.run(['fetch', '--no-tags', '--quiet', '--force', sandbox, `+${sha}:${ref}`])
      return ref
    }
  }
  if (git.refExists2(ref)) return ref
  throw new MeshError(MESH_ERRORS.GIT_FAILED, `no sandbox and no fetched ref for ${task.task_id}`, {
    task_id: task.task_id,
    sandbox,
  })
}

export class ScopeViolation extends MeshError {
  readonly out_of_scope: string[]
  readonly files: string[]
  constructor(taskId: string, outOfScopePaths: string[], files: string[], evidence: string) {
    super(
      MESH_ERRORS.SCOPE_VIOLATION,
      `${taskId} touches ${outOfScopePaths.length} path(s) outside scope.write: ${outOfScopePaths.slice(0, 8).join(', ')}`,
      { task_id: taskId, out_of_scope: outOfScopePaths, changed: files, evidence },
    )
    this.name = 'ScopeViolation'
    this.out_of_scope = outOfScopePaths
    this.files = files
  }
}

/** Step 1+2 of the algorithm, with no side effects. `rev` is normally `refs/mesh/<task>`. */
export function scopeCheck(git: Git, task: TaskCard, opts: { rev?: string } = {}): ScopeCheck {
  const base = task.base_commit ?? task.submission?.commit ?? ''
  const branch = opts.rev ?? task.branch
  const files = base ? git.changedFiles(base, branch) : git.changedFiles(`${branch}^`, branch)
  const oos = outOfScope(files, task.scope.write)
  return {
    task_id: task.task_id,
    branch,
    base,
    files,
    out_of_scope: oos,
    scope_write: [...task.scope.write],
    ok: oos.length === 0,
  }
}

/** Render a compact, reviewable evidence block for a refusal. */
export function scopeEvidence(git: Git, check: ScopeCheck, rev?: string): string {
  const lines: string[] = []
  lines.push(`# scope 终审证据 ${check.task_id}`)
  lines.push('')
  lines.push(`base: ${check.base}`)
  lines.push(`branch: ${rev ?? check.branch}`)
  lines.push('')
  lines.push('## 改动清单')
  for (const f of check.files) lines.push(`- ${f}${outOfScope([f], check.scope_write).length > 0 ? '   ← 越界' : ''}`)
  lines.push('')
  lines.push('## 越界文件')
  for (const f of check.out_of_scope) lines.push(`- ${f}`)
  lines.push('')
  lines.push('## 越界 diff（截断 200 行）')
  const diff = git.diff(check.base, check.branch, check.out_of_scope)
  lines.push('```diff')
  lines.push(diff.split('\n').slice(0, 200).join('\n'))
  lines.push('```')
  return lines.join('\n')
}

export interface MergeTransactionResult {
  merge_commit: string
  pre_merge_head: string
  files: string[]
  stripped: string[]
  mode: MergeMode
  check: ScopeCheck
}

export class MergeRefused extends MeshError {
  readonly check: ScopeCheck
  readonly evidence: string
  constructor(taskId: string, check: ScopeCheck, evidence: string) {
    super(MESH_ERRORS.SCOPE_VIOLATION, `merge refused for ${taskId}: out-of-scope changes`, {
      task_id: taskId,
      out_of_scope: check.out_of_scope,
    })
    this.name = 'MergeRefused'
    this.check = check
    this.evidence = evidence
  }
}

/**
 * Perform the merge transaction. Throws `MergeRefused` when out-of-scope files are
 * present and stripping was not authorised; throws on conflicts (already aborted).
 * On success the main branch has exactly one new merge commit and nothing
 * outside `scope.write` changed.
 */
export function mergeWithScopeGate(
  git: Git,
  task: TaskCard,
  opts: { mainBranch: string; allowStrip?: boolean; ref?: string },
): MergeTransactionResult {
  const rev = opts.ref ?? task.branch
  const check = scopeCheck(git, task, { rev })
  const allowStrip = opts.allowStrip === true
  if (!check.ok && !allowStrip) {
    throw new MergeRefused(task.task_id, check, scopeEvidence(git, check, rev))
  }
  const preMergeHead = git.headSha() ?? ''
  if (!preMergeHead) {
    throw new MeshError(MESH_ERRORS.GIT_FAILED, 'main branch has no commits to merge into', { task: task.task_id })
  }

  // -- begin ---------------------------------------------------------------
  const staged = git.beginMerge(opts.mainBranch, rev)
  let mode: MergeMode = 'strict'
  let stripped: string[] = []
  let effective = staged

  const strippedCandidates = outOfScope(staged, task.scope.write)
  if (strippedCandidates.length > 0) {
    if (!allowStrip) {
      git.abortMerge()
      throw new MergeRefused(
        task.task_id,
        { ...check, out_of_scope: strippedCandidates, ok: false },
        scopeEvidence(git, check, rev),
      )
    }
    mode = 'strip'
    stripped = strippedCandidates
    git.stripPaths(strippedCandidates)
    effective = staged.filter((f) => !stripped.includes(f))
  }

  if (effective.length === 0) {
    git.abortMerge()
    throw new MeshError(MESH_ERRORS.GIT_FAILED, `merge of ${rev} produced no in-scope changes`, {
      task: task.task_id,
      stripped,
    })
  }

  // -- commit --------------------------------------------------------------
  const summary = task.submission?.summary ?? task.title
  const message = [
    `mesh(${task.task_id}): ${task.title}`,
    '',
    summary,
    '',
    `role: ${task.role}`,
    `branch: ${task.branch}`,
    `review: ${task.reviews.length > 0 ? task.reviews[task.reviews.length - 1] : 'n/a'}`,
    mode === 'strip' ? `stripped: ${stripped.join(', ')}` : 'scope: clean',
  ].join('\n')
  const mergeCommit = git.commitMerge(message)

  // -- verify the committed result ----------------------------------------
  const postFiles = git.changedFiles(preMergeHead, mergeCommit)
  const postViolations = outOfScope(postFiles, task.scope.write)
  if (postViolations.length > 0) {
    // The guarantee would be broken; undo our own commit and fail loudly.
    git.run(['reset', '--hard', preMergeHead], { allowFailure: true })
    throw new MeshError(
      MESH_ERRORS.SCOPE_VIOLATION,
      `post-merge verification found ${postViolations.length} out-of-scope path(s); merge rolled back`,
      { task: task.task_id, out_of_scope: postViolations, merge_commit: mergeCommit, rolled_back_to: preMergeHead },
    )
  }

  return {
    merge_commit: mergeCommit,
    pre_merge_head: preMergeHead,
    files: postFiles.map(normRel),
    stripped,
    mode,
    check,
  }
}
