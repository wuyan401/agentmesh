/**
 * M4 — collaboration history.
 *
 * The acceptance is about files a human will actually read, so the tests read the
 * files: HISTORY.md must have exactly one row per mission (not one per close call),
 * timeline.md's order must match the audit ledger it came from, and tasks.json must
 * carry the reviews in full rather than a summary.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { addAgent, commitInWorktree, createHarness, newSession } from '../helpers.ts'
import type { Harness } from '../helpers.ts'
import type { RoleId } from '../../hub/core/types.ts'

function harness(name: string): Harness {
  return createHarness(name)
}

/** A mission with one card taken all the way to merged, and a report. */
function completedMission(h: Harness, opts: { withReport?: boolean } = {}): { missionId: string; taskId: string } {
  addAgent(h.hub, 'leadx', ['backend_dev', 'lead'] as RoleId[])
  addAgent(h.hub, 'devx', ['backend_dev'] as RoleId[])
  addAgent(h.hub, 'supx', ['supervisor'] as RoleId[])
  const mission = h.hub.missions.createMission({ title: '做一个带登录的博客', brief: '用户原话', lead_agent: 'leadx' })
  const lead = h.hub.missions.createLeadSession(mission.mission_id, { spawned_by: 'test' })
  h.hub.identity.hello(lead.session_id)
  const planned = h.hub.missions.planMission(lead.session_id, mission.mission_id, [
    { title: '实现登录接口', role: 'backend_dev', scope: { write: ['src/auth.ts'] }, acceptance: ['返回 200'] },
  ])
  h.hub.missions.dispatchMission(lead.session_id, mission.mission_id)
  const taskId = planned.created[0]!.task_id

  const dev = newSession(h.hub, 'devx', 'backend_dev')
  h.hub.board.claimTask(dev.session_id, taskId)
  commitInWorktree(h, h.hub.store.requireTask(taskId), { 'src/auth.ts': 'export const ok = 1\n' })
  h.hub.board.submitTask(h.hub.identity.requireIdentity(dev.session_id), taskId, 'auth done')
  const sup = newSession(h.hub, 'supx', 'supervisor')
  h.hub.board.recordVerdict(h.hub.identity.requireIdentity(sup.session_id), taskId, 'approved', [
    { criterion: '返回 200', pass: true, evidence: 'src/auth.ts 里有 200 分支' },
  ], '看起来对')
  h.hub.board.mergeTask(taskId, { auto: true })

  if (opts.withReport !== false) {
    h.hub.missions.advanceMissions()
    const lead2 = h.hub.missions.createLeadSession(mission.mission_id, { spawned_by: 'test' })
    h.hub.identity.hello(lead2.session_id)
    h.hub.missions.finalVerdict(lead2.session_id, mission.mission_id, true, '可以交付')
    h.hub.missions.writeReport(lead2.session_id, mission.mission_id, '# 交付报告\n\n登录接口已完成。')
  }
  return { missionId: mission.mission_id, taskId }
}

function read(h: Harness, rel: string): string {
  return fs.readFileSync(path.resolve(h.dir, rel), 'utf8')
}

// ---------------------------------------------------------------------------
// the bundle
// ---------------------------------------------------------------------------

test('history: write_report freezes report/timeline/tasks/context into the mission dir', () => {
  const h = harness('hist-close')
  try {
    const { missionId, taskId } = completedMission(h)
    const dir = path.resolve(h.dir, '.mesh', 'missions', missionId)
    for (const file of ['report.md', 'timeline.md', 'tasks.json', `context/${taskId}.md`]) {
      assert.ok(fs.existsSync(path.join(dir, file)), `${file} must exist under the mission dir`)
    }
    const report = read(h, `.mesh/missions/${missionId}/report.md`)
    assert.match(report, /交付报告/, 'report.md must carry the lead report, not be empty')
  } finally {
    h.cleanup()
  }
})

test('history: tasks.json holds the terminal cards with every review in full', () => {
  const h = harness('hist-tasks')
  try {
    const { missionId, taskId } = completedMission(h)
    const snapshot = JSON.parse(read(h, `.mesh/missions/${missionId}/tasks.json`)) as {
      mission_id: string
      tasks: Array<{
        task_id: string
        status: string
        merge: { merge_commit: string } | null
        reviews_full: Array<{ verdict: string; criteria: Array<{ criterion: string; pass: boolean; evidence: string }> }>
      }>
    }
    assert.equal(snapshot.mission_id, missionId)
    const card = snapshot.tasks.find((t) => t.task_id === taskId)!
    assert.equal(card.status, 'merged')
    assert.ok(card.merge?.merge_commit, 'the merge commit must be in the snapshot')
    assert.equal(card.reviews_full.length, 1)
    assert.equal(card.reviews_full[0]!.verdict, 'approved')
    // the point of "含 reviews 全文": the evidence for each criterion survives
    assert.equal(card.reviews_full[0]!.criteria.length, 1)
    assert.equal(card.reviews_full[0]!.criteria[0]!.pass, true)
    assert.match(card.reviews_full[0]!.criteria[0]!.evidence, /200/)
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

test('history: timeline.md is ordered like the audit ledger it came from', () => {
  const h = harness('hist-timeline')
  try {
    const { missionId, taskId } = completedMission(h)
    const audit = h.hub.store.auditEvents()
    const relevant = audit.filter((e) => {
      if (e['mission_id'] === missionId) return true
      const t = e['task_id']
      return typeof t === 'string' && (t === taskId)
    })
    const expected = relevant.map((e) => String(e['at']))
    const timeline = h.hub.history.timelineEvents(h.hub.store.requireMission(missionId))
    // The timeline merges the audit and board ledgers, so compare each source against
    // its own ledger, and require the merged list to be in ascending time order.
    const fromAudit = timeline.filter((e) => e.source === 'audit').map((e) => e.at)
    assert.deepEqual(fromAudit, expected, 'audit-sourced rows must keep ledger order')
    const times = timeline.map((e) => Date.parse(e.at))
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i]! >= times[i - 1]!, `timeline must be ascending at index ${i}`)
    }
    assert.ok(
      timeline.some((e) => e.source === 'board'),
      'board-sourced rows (claim/submit/merge) must be present',
    )

    const markdown = read(h, `.mesh/missions/${missionId}/timeline.md`)
    // each audit event of this mission appears in the rendered table
    for (const at of expected) {
      assert.ok(markdown.includes(at.slice(11, 19)), `timeline.md must show ${at.slice(11, 19)}`)
    }
    for (const needle of ['创建 mission', '拆卡', '派活', '合并', '完成']) {
      assert.ok(markdown.includes(needle), `timeline.md must mention ${needle}`)
    }
  } finally {
    h.cleanup()
  }
})

test('history: the timeline covers the whole life of a card, not just the merge', () => {
  const h = harness('hist-timeline-card')
  try {
    const { missionId } = completedMission(h)
    const events = h.hub.history.timelineEvents(h.hub.store.requireMission(missionId))
    const kinds = new Set(events.map((e) => e.kind))
    for (const kind of ['mission.created', 'mission.planned', 'mission.dispatched', 'mission.completed']) {
      assert.ok(kinds.has(kind), `timeline must include ${kind}`)
    }
    // the card-level events come from the same ledger
    assert.ok(
      events.some((e) => e.task_id !== null),
      'at least one task-scoped event must be present',
    )
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// HISTORY.md
// ---------------------------------------------------------------------------

test('history: HISTORY.md has exactly one row per mission, no matter how often it is written', () => {
  const h = harness('hist-index')
  try {
    const { missionId } = completedMission(h)
    const index = () => read(h, '.mesh/HISTORY.md')
    // Count rows by mission id, not by the "#" column: the bundle's own tasks.json sits
    // in a subdirectory of .mesh/missions/ and must never be mistaken for a mission card.
    const rows = (text: string): string[] => text.split('\n').filter((line) => line.includes(`| ${missionId} |`))

    assert.equal(rows(index()).length, 1)
    assert.equal(h.hub.store.listMissions().length, 1, 'the bundle must not look like a second mission')
    // closing again must not append a second line
    h.hub.history.close(missionId)
    h.hub.history.close(missionId)
    assert.equal(rows(index()).length, 1, 'the index is rebuilt, never appended')

    const text = index()
    for (const column of ['Mission', '标题', 'Lead', '卡', '轮次', '耗时', '状态', '报告']) {
      assert.ok(text.includes(column), `HISTORY.md must have a ${column} column`)
    }
    assert.ok(text.includes('做一个带登录的博客'))
    assert.ok(text.includes('mesh-human') || text.includes('leadx'))
    assert.ok(text.includes('1/1'), 'merged/total must be visible')
    assert.ok(text.includes(`missions/${missionId}/report.md`), 'the report must be linked')
  } finally {
    h.cleanup()
  }
})

test('history: a second mission adds exactly one more row', () => {
  const h = harness('hist-index-two')
  try {
    const first = completedMission(h)
    const second = h.hub.missions.createMission({ title: '第二个 mission', brief: 'b', lead_agent: 'leadx' })
    h.hub.history.close(second.mission_id)
    const text = read(h, '.mesh/HISTORY.md')
    assert.equal(text.split('\n').filter((l) => l.startsWith('| 1 |')).length, 1)
    assert.equal(text.split('\n').filter((l) => l.startsWith('| 2 |')).length, 1)
    assert.ok(text.includes(first.missionId))
    assert.ok(text.includes(second.mission_id))
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

test('history: export copies the whole bundle elsewhere', () => {
  const h = harness('hist-export')
  try {
    const { missionId } = completedMission(h)
    const out = path.join(h.dir, 'exported')
    const result = h.hub.history.export(missionId, out)
    assert.ok(result.files.includes('report.md'))
    assert.ok(result.files.includes('timeline.md'))
    assert.ok(result.files.includes('tasks.json'))
    assert.ok(result.files.some((f) => f.startsWith('context/')))
    assert.ok(fs.existsSync(path.join(out, 'report.md')))
  } finally {
    h.cleanup()
  }
})

test('history: an event written to both ledgers appears once (mission-level rejection)', () => {
  const h = harness('hist-dedupe')
  try {
    const { missionId, taskId } = completedMission(h)
    // A mission-level rejection writes task.rejected_after_merge to BOTH ledgers, with
    // timestamps a millisecond apart. The timeline must show it once.
    h.hub.board.rejectMergedTask(taskId, 'test', '二次验收打回')
    h.hub.store.auditEvent('task.rejected_after_merge', { task_id: taskId, by: 'test', note: '二次验收打回' })
    const events = h.hub.history.timelineEvents(h.hub.store.requireMission(missionId))
    const rejections = events.filter((e) => e.kind === 'task.rejected_after_merge')
    assert.equal(rejections.length, 1, `expected one rejection row, got ${rejections.length}`)
  } finally {
    h.cleanup()
  }
})

test('history: closing a mission with no cards still writes a readable bundle', () => {
  const h = harness('hist-empty')
  try {
    addAgent(h.hub, 'leadx', ['backend_dev', 'lead'] as RoleId[])
    const mission = h.hub.missions.createMission({ title: '空 mission', brief: 'b', lead_agent: 'leadx' })
    const bundle = h.hub.history.close(mission.mission_id)
    assert.ok(bundle.files.includes('timeline.md'))
    assert.ok(bundle.files.includes('tasks.json'))
    const snapshot = JSON.parse(read(h, `.mesh/missions/${mission.mission_id}/tasks.json`)) as { tasks: unknown[] }
    assert.deepEqual(snapshot.tasks, [])
    const timeline = read(h, `.mesh/missions/${mission.mission_id}/timeline.md`)
    assert.match(timeline, /创建 mission/)
  } finally {
    h.cleanup()
  }
})
