/**
 * Sentinel — the audit sentry (§10.2).
 *
 * It detects and reports; it never blocks, never rolls back, never changes a task
 * status. That restraint is the point: the platform's authority lives in the merge
 * gate, and an auditor that could also punish would be a second, unreviewable
 * source of power.
 */

import fs from 'node:fs'
import path from 'node:path'
import { nowIso, readJsonIfExists, writeJsonAtomic } from '../core/fsx.ts'
import { scopeCheck, ensureMeshRef } from '../core/mergeGate.ts'
import { outOfScope } from '../core/fsx.ts'
import type { Hub } from '../core/hub.ts'
import type { ViolationKind } from '../core/types.ts'

export interface Finding {
  kind: ViolationKind
  severity: 'info' | 'warn' | 'high'
  task_id: string | null
  session_id: string | null
  agent_id: string | null
  detail: string
  evidence: Record<string, unknown>
  signature: string
}

export interface ScanReport {
  at: string
  findings: Finding[]
  new_findings: Finding[]
  checked: { tasks: number; sessions: number; main_commits: number; reviews: number }
  digest_path: string
  artifact_path: string | null
}

interface SentinelState {
  seen: string[]
  last_scan: string | null
}

export class Sentinel {
  readonly hub: Hub

  constructor(hub: Hub) {
    this.hub = hub
  }

  private stateFile(): string {
    return this.hub.paths.resolve('audit', 'sentinel-state.json')
  }

  private loadState(): SentinelState {
    return readJsonIfExists<SentinelState>(this.stateFile()) ?? { seen: [], last_scan: null }
  }

  private saveState(state: SentinelState): void {
    // Keep the signature list bounded; the audit log itself is the permanent record.
    if (state.seen.length > 4000) state.seen = state.seen.slice(-2000)
    writeJsonAtomic(this.stateFile(), state)
  }

  scan(opts: { record?: boolean; notify?: boolean; writeArtifact?: boolean } = {}): ScanReport {
    const findings: Finding[] = []
    const tasks = this.hub.store.listTasks()
    const sessions = this.hub.store.listSessions()
    const reviews = this.hub.store.listReviews()

    // 1. task branches writing outside their scope (mid-flight detection)
    let checkedTasks = 0
    for (const task of tasks) {
      if (!['claimed', 'in_progress', 'submitted', 'reviewing', 'approved'].includes(task.status)) continue
      if (!task.base_commit) continue
      if (!this.hub.git.branchExists(task.branch)) continue
      checkedTasks++
      let check
      try {
        const ref = ensureMeshRef(this.hub.git, this.hub.paths, task)
        check = scopeCheck(this.hub.git, task, { rev: ref })
      } catch {
        continue
      }
      if (!check.ok) {
        findings.push({
          kind: 'scope.out-of-write',
          severity: 'high',
          task_id: task.task_id,
          session_id: task.claimed_by,
          agent_id: task.implementer_agent,
          detail: `${task.task_id} (${task.status}) touches ${check.out_of_scope.length} path(s) outside its scope`,
          evidence: { out_of_scope: check.out_of_scope, files: check.files, branch: task.branch },
          signature: `scope:${task.task_id}:${check.out_of_scope.join(',')}`,
        })
      }
    }

    // 2. main branch drift: commits the platform did not produce.
    //    First-parent only: commits that came in *through* a platform merge are
    //    legitimate branch work, not drift.
    const state = this.hub.store.getState()
    const merges = this.hub.store.merges()
    const platformCommits = new Set<string>(merges.map((m) => String(m['merge_commit'])))
    const mainCommits = this.hub.git.commitsSince(state.base_commit, {
      branch: state.main_branch,
      maxCount: 500,
      firstParent: true,
    })
    for (const commit of mainCommits) {
      const isPlatformMerge =
        platformCommits.has(commit.sha) || (commit.parents.length > 1 && commit.subject.startsWith('mesh('))
      if (isPlatformMerge) continue
      findings.push({
        kind: 'drift.main-branch',
        severity: 'high',
        task_id: null,
        session_id: null,
        agent_id: null,
        detail: `main branch has a commit the platform did not produce: ${commit.sha.slice(0, 8)} "${commit.subject}"`,
        evidence: { sha: commit.sha, subject: commit.subject, author: commit.author, date: commit.date },
        signature: `drift:${commit.sha}`,
      })
    }

    // 3. liveness: an active Session that stopped heartbeating
    let checkedSessions = 0
    for (const session of sessions) {
      if (session.status !== 'active' && session.status !== 'starting') continue
      // A Session with no process (CLI attribution, builtin daemon) cannot
      // heartbeat and is not a liveness risk; flagging it is pure noise.
      if (session.pid === null) continue
      checkedSessions++
      const idleMs = Date.now() - Date.parse(session.last_heartbeat_at)
      if (idleMs > this.hub.config.stale_session_seconds * 1000) {
        findings.push({
          kind: 'liveness.stale-session',
          severity: 'info',
          task_id: session.task,
          session_id: session.session_id,
          agent_id: session.agent_id,
          detail: `session ${session.session_id} (${session.role}) silent for ${Math.round(idleMs / 60000)}min`,
          evidence: { last_heartbeat_at: session.last_heartbeat_at, status: session.status },
          signature: `stale:${session.session_id}:${Math.floor(idleMs / 600000)}`,
        })
      }
    }

    // 4. reviews that should have been impossible (C7 defence in depth)
    for (const review of reviews) {
      if (review.reviewer_agent && review.implementer_agent && review.reviewer_agent === review.implementer_agent) {
        findings.push({
          kind: 'role.overreach',
          severity: 'high',
          task_id: review.task_id,
          session_id: review.reviewer_session,
          agent_id: review.reviewer_agent,
          detail: `${review.review_id} was written by the implementer of ${review.task_id} (C7 breach)`,
          evidence: { review_id: review.review_id },
          signature: `selfreview:${review.review_id}`,
        })
      }
    }

    const previous = this.loadState()
    const seen = new Set(previous.seen)
    const fresh = findings.filter((f) => !seen.has(f.signature))

    if (opts.record !== false) {
      for (const f of fresh) {
        this.hub.audit.violation({
          kind: f.kind,
          severity: f.severity,
          task_id: f.task_id,
          session_id: f.session_id,
          agent_id: f.agent_id,
          detail: f.detail,
          evidence: f.evidence,
        })
      }
      for (const f of findings) seen.add(f.signature)
      this.saveState({ seen: [...seen], last_scan: nowIso() })
    }

    const digest = this.hub.audit.writeDigest()

    let artifactPath: string | null = null
    // Only a *new* finding deserves a new artifact. A standing condition that has
    // already been reported lives in violations.log; re-writing it every tick would
    // bury the artifact space in duplicates.
    if (opts.writeArtifact !== false && fresh.length > 0) {
      artifactPath = this.writeReport(findings, fresh)
    }

    if (opts.notify !== false && fresh.length > 0) {
      const sentinelSession = this.ensureSentinelSession()
      if (sentinelSession) {
        try {
          const identity = this.hub.identity.requireIdentity(sentinelSession.session_id)
          this.hub.bus.notifyCoordinator(
            identity,
            'escalation',
            `Sentinel 扫描发现 ${fresh.length} 条新问题：\n${fresh
              .slice(0, 8)
              .map((f) => `- ${f.kind}: ${f.detail}`)
              .join('\n')}`,
          )
        } catch {
          /* coordinator may not exist yet */
        }
      }
    }

    return {
      at: nowIso(),
      findings,
      new_findings: fresh,
      checked: { tasks: checkedTasks, sessions: checkedSessions, main_commits: mainCommits.length, reviews: reviews.length },
      digest_path: this.hub.paths.rel(this.hub.paths.digestFile),
      artifact_path: artifactPath,
    }
  }

  private ensureSentinelSession(): { session_id: string } | null {
    const existing = this.hub.store.liveSessions().find((s) => s.agent_id === 'mesh-hub' && s.role === 'sentinel')
    if (existing) return { session_id: existing.session_id }
    const agent = this.hub.store.getAgent('mesh-hub')
    if (!agent || !agent.capabilities.includes('sentinel')) return null
    const session = this.hub.identity.createSession({
      agent_id: 'mesh-hub',
      role: 'sentinel',
      spawned_by: 'hub.sentinel',
      lifespan: 'daemon',
      ttl_seconds: 86_400,
    })
    this.hub.identity.hello(session.session_id)
    return { session_id: session.session_id }
  }

  private writeReport(findings: Finding[], fresh: Finding[]): string {
    const dir = this.hub.paths.artifactsDir
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true })
    const rel = `audit/sentinel-${nowIso().replace(/[:.]/g, '-')}.md`
    const lines: string[] = []
    lines.push('# Sentinel 扫描报告')
    lines.push('')
    lines.push(`时间：${nowIso()}`)
    lines.push(`发现：${findings.length} 条（本次新增 ${fresh.length} 条）`)
    lines.push('')
    lines.push('> detect-only：本报告不改变任何任务状态，也不回滚任何提交。')
    lines.push('')
    lines.push('| 类型 | 严重度 | 任务 | 说明 |')
    lines.push('|---|---|---|---|')
    for (const f of findings) {
      lines.push(`| ${f.kind} | ${f.severity} | ${f.task_id ?? '-'} | ${f.detail.replace(/\|/g, '\\|')} |`)
    }
    lines.push('')
    const body = lines.join('\n')
    fs.writeFileSync(path.join(dir, rel), body)
    return rel
  }

  /** Scan a single task branch and report, without recording (used by `mesh audit scope`). */
  inspectTask(taskId: string): ReturnType<typeof scopeCheck> {
    const task = this.hub.store.requireTask(taskId)
    const ref = ensureMeshRef(this.hub.git, this.hub.paths, task)
    return scopeCheck(this.hub.git, task, { rev: ref })
  }

  /** Files on a task branch that fall outside its scope. */
  outOfScopeFiles(taskId: string): string[] {
    const task = this.hub.store.requireTask(taskId)
    if (!task.base_commit) return []
    const ref = ensureMeshRef(this.hub.git, this.hub.paths, task)
    return outOfScope(this.hub.git.changedFiles(task.base_commit, ref), task.scope.write)
  }
}
