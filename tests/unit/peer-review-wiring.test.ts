/**
 * Peer review has to be *wired in*, not merely available.
 *
 * The platform already shipped a complete rate_peer tool — 0-100 validation,
 * one review per (rater, target, mission), weighted moving average, audit event —
 * that no agent ever called, because:
 *   1. no prompt mentioned it, so the capability was invisible,
 *   2. a planned card carried no parent link, so nothing could name the mission,
 *   3. the reviewer's session ends right after the verdict, so "rate later" is
 *      impossible in practice.
 * These tests pin the wiring so it cannot silently fall out again.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Scheduler } from '../../hub/scheduler/scheduler.ts'
import { addAgent, createHarness } from '../helpers.ts'
import type { Harness } from '../helpers.ts'
import type { RoleId } from '../../hub/core/types.ts'

function harness(name: string): Harness {
  const h = createHarness(name)
  addAgent(h.hub, 'dev', ['backend_dev', 'executor'])
  addAgent(h.hub, 'sup', ['supervisor'])
  addAgent(h.hub, 'mesh-human', ['planner', 'lead'], {
    kind: 'builtin',
    command: '',
    transport: 'in-process',
    mcp_inject: 'none',
  })
  return h
}

function missionWithPlan(h: Harness): { missionId: string; taskId: string } {
  const mission = h.hub.missions.createMission({
    title: '接线检查',
    brief: '接线检查（用户原话）',
    acceptance: ['能跑'],
    lead_agent: 'mesh-human',
  })
  const lead = h.hub.missions.createLeadSession(mission.mission_id, { spawned_by: 'test' })
  h.hub.identity.hello(lead.session_id)
  const planned = h.hub.missions.planMission(lead.session_id, mission.mission_id, [
    {
      title: '一个文件',
      role: 'backend_dev' as RoleId,
      scope: { write: ['src/a.ts'] },
      acceptance: ['文件存在'],
    },
  ])
  return { missionId: mission.mission_id, taskId: planned.created[0]!.task_id }
}

test('planMission links every card back to its mission', () => {
  const h = harness('wiring-parent')
  try {
    const { missionId, taskId } = missionWithPlan(h)
    const task = h.hub.store.requireTask(taskId)
    assert.equal(task.parent, missionId, 'a card must point at its mission, not only carry a tag')
  } finally {
    h.cleanup()
  }
})

test('the worker context tells the agent it may rate peers', () => {
  const h = harness('wiring-context')
  try {
    const { taskId } = missionWithPlan(h)
    const built = h.hub.context.build({ taskId })
    assert.match(built.markdown, /hub\.rate_peer/)
    assert.match(built.markdown, /mission_id/, 'the hint must show the argument shape, not just the name')
  } finally {
    h.cleanup()
  }
})

test('the reviewer is told to score the implementer before ruling', () => {
  const h = harness('wiring-review')
  try {
    const { missionId, taskId } = missionWithPlan(h)
    const task = h.hub.store.requireTask(taskId)
    task.implementer_agent = 'dev'
    const scheduler = new Scheduler(h.hub) as unknown as {
      reviewBrief(t: typeof task): string
    }
    const brief = scheduler.reviewBrief(task)
    assert.match(brief, /hub\.rate_peer/)
    assert.ok(brief.includes(missionId), 'the hint must name the mission shared with the implementer')
    assert.ok(brief.includes('dev'), 'the hint must name the implementer')
  } finally {
    h.cleanup()
  }
})

test('the lead is told to score participants before the final verdict', () => {
  const h = harness('wiring-lead')
  try {
    const { missionId } = missionWithPlan(h)
    const mission = h.hub.store.requireMission(missionId)
    const brief = h.hub.missions.leadBrief(mission, 'integrating')
    assert.match(brief, /hub\.rate_peer/)
    // Ordering matters: a lead that rules first and scores afterwards has every
    // reason to make the numbers agree with the verdict it already gave.
    const rateAt = brief.indexOf('hub.rate_peer')
    const verdictAt = brief.indexOf('final_verdict')
    assert.ok(rateAt >= 0, 'lead must be told about rate_peer')
    assert.ok(verdictAt >= 0, 'lead must still be told about final_verdict')
    assert.ok(rateAt < verdictAt, 'rate_peer must be listed before final_verdict')
  } finally {
    h.cleanup()
  }
})
