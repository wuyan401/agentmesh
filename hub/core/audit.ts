/**
 * Audit trail: violations (detect-only), merge records, and the human digest.
 *
 * The Sentinel's contract is deliberately narrow — record and report, never
 * block and never roll back (§10.2). This module is where that contract is
 * implemented, so no caller can accidentally make an audit entry *do* something.
 */

import fs from 'node:fs'
import path from 'node:path'
import { nowIso, ensureDir, writeFileAtomic, pad } from './fsx.ts'
import type { MeshStore } from './store.ts'
import type { MeshPaths } from './paths.ts'
import type { ViolationKind, ViolationRecord } from './types.ts'

export interface ViolationInput {
  kind: ViolationKind
  severity?: ViolationRecord['severity']
  task_id?: string | null
  session_id?: string | null
  agent_id?: string | null
  detail: string
  evidence?: Record<string, unknown>
}

const SEVERITY_BY_KIND: Record<ViolationKind, ViolationRecord['severity']> = {
  'scope.out-of-write': 'high',
  'scope.merge-blocked': 'high',
  'drift.main-branch': 'high',
  'role.artifact-denied': 'warn',
  'role.code-attempt': 'high',
  'role.overreach': 'high',
  'protocol.unknown-session': 'warn',
  'protocol.unclaimed-work': 'warn',
  'protocol.bus-bypass': 'high',
  'liveness.stale-session': 'info',
  'granularity.oversized': 'info',
}

export class Audit {
  readonly store: MeshStore
  readonly paths: MeshPaths

  constructor(store: MeshStore) {
    this.store = store
    this.paths = store.paths
  }

  /**
   * Record a violation. Never throws on the call path: an audit failure must not
   * turn a detection into an outage, but it is reported on stderr.
   */
  violation(input: ViolationInput): ViolationRecord {
    let id = 'V-000000'
    try {
      id = this.store.nextId('violation')
    } catch {
      /* counter lock unavailable: still record with a timestamp id */
      id = `V-${Date.now()}`
    }
    const record: ViolationRecord = {
      violation_id: id,
      kind: input.kind,
      at: nowIso(),
      task_id: input.task_id ?? null,
      session_id: input.session_id ?? null,
      agent_id: input.agent_id ?? null,
      severity: input.severity ?? SEVERITY_BY_KIND[input.kind] ?? 'warn',
      detail: input.detail,
      evidence: input.evidence ?? {},
      notified: false,
    }
    try {
      this.store.recordViolation(record)
      this.store.auditEvent('violation', record as unknown as Record<string, unknown>)
    } catch (e) {
      process.stderr.write(`[mesh] failed to record violation: ${(e as Error).message}\n`)
    }
    return record
  }

  violations(): ViolationRecord[] {
    return this.store.violations()
  }

  /** Append a human-readable digest of current platform health. */
  writeDigest(): string {
    const violations = this.violations()
    const merges = this.store.merges()
    const tasks = this.store.listTasks()
    const sessions = this.store.listSessions()
    const lines: string[] = []
    lines.push('# AgentMesh audit digest')
    lines.push('')
    lines.push(`generated: ${nowIso()}`)
    lines.push('')
    lines.push('## Board')
    const byStatus = new Map<string, number>()
    for (const t of tasks) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1)
    lines.push('')
    lines.push('| status | count |')
    lines.push('|---|---|')
    for (const [status, count] of [...byStatus.entries()].sort()) lines.push(`| ${status} | ${count} |`)
    lines.push('')
    lines.push('## Sessions')
    lines.push('')
    lines.push(`total ${sessions.length}, live ${this.store.liveSessions().length}`)
    lines.push('')
    lines.push('## Merges (platform-produced commits on main)')
    lines.push('')
    if (merges.length === 0) lines.push('_none yet_')
    else {
      lines.push('| at | task | commit | mode | stripped |')
      lines.push('|---|---|---|---|---|')
      for (const m of merges.slice(-50)) {
        const stripped = Array.isArray(m.stripped) && m.stripped.length > 0 ? m.stripped.length : 0
        lines.push(
          `| ${String(m.at)} | ${String(m.task_id)} | ${String(m.merge_commit).slice(0, 8)} | ${String(m.mode)} | ${stripped} |`,
        )
      }
    }
    lines.push('')
    lines.push('## Violations (detect-only)')
    lines.push('')
    if (violations.length === 0) lines.push('_clean_')
    else {
      lines.push('| at | kind | severity | task | detail |')
      lines.push('|---|---|---|---|---|')
      for (const v of violations.slice(-100)) {
        lines.push(
          `| ${v.at} | ${v.kind} | ${v.severity} | ${v.task_id ?? '-'} | ${v.detail.replace(/\|/g, '\\|').slice(0, 160)} |`,
        )
      }
    }
    lines.push('')
    const text = `${lines.join('\n')}\n`
    ensureDir(this.paths.auditDir)
    writeFileAtomic(this.paths.digestFile, text)
    return text
  }

  /** Reserve a review id. Reviews are first-class audit artifacts. */
  nextReviewId(): string {
    return this.store.nextId('review')
  }

  /** Write a raw evidence file next to the audit log. */
  writeEvidence(name: string, content: string): string {
    const dir = path.join(this.paths.auditDir, 'evidence')
    ensureDir(dir)
    const file = path.join(dir, `${pad(Date.now(), 14)}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
    fs.writeFileSync(file, content)
    return file
  }
}
