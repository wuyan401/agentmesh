/**
 * M3 — the context package must tell an agent where it is and who it is working with.
 *
 * These tests are about the *text that is actually injected*, so they build the real
 * package through ContextBuilder and look for the sections in it. The three levels are
 * asserted to differ in the way §3 specifies, and the teammate table is asserted to be
 * data (profiles + cards), not prose.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HubApi } from '../../hub/core/api.ts'
import { buildTeammates } from '../../hub/core/teammates.ts'
import { addAgent, commitInWorktree, createHarness, newSession } from '../helpers.ts'
import type { Harness } from '../helpers.ts'
import type { ContextLevel } from '../../hub/core/context.ts'
import type { RoleId } from '../../hub/core/types.ts'

function harness(name: string): Harness {
  return createHarness(name)
}

/** A mission with a lead, two implementers and one reviewer — enough for a real table. */
function missionWithCrew(h: Harness): {
  missionId: string
  leadSession: string
  tasks: string[]
  sessions: { dev: string; sup: string; other: string }
} {
  addAgent(h.hub, 'leadx', ['backend_dev', 'lead'] as RoleId[])
  addAgent(h.hub, 'devx', ['backend_dev'] as RoleId[])
  addAgent(h.hub, 'other', ['frontend_dev'] as RoleId[])
  addAgent(h.hub, 'supx', ['supervisor'] as RoleId[])
  // Give the table something to say.
  h.hub.profiles.set('leadx', 'personality', '沉稳工程化')
  h.hub.profiles.set('leadx', 'strengths', '架构,契约')
  h.hub.profiles.set('devx', 'personality', '严谨啰嗦')
  h.hub.profiles.set('devx', 'weaknesses', '启动慢')
  h.hub.profiles.set('supx', 'personality', '挑剔')

  const mission = h.hub.missions.createMission({ title: '做一个带登录的博客', brief: '用户原话', lead_agent: 'leadx' })
  const leadSession = h.hub.missions.createLeadSession(mission.mission_id, { spawned_by: 'test' })
  h.hub.identity.hello(leadSession.session_id)
  const planned = h.hub.missions.planMission(leadSession.session_id, mission.mission_id, [
    {
      title: '实现登录接口',
      role: 'backend_dev',
      scope: { write: ['src/auth.ts'] },
      acceptance: ['返回 200'],
      depends_on: [],
    },
    {
      title: '实现登录页',
      role: 'frontend_dev',
      scope: { write: ['src/login.ts'] },
      acceptance: ['表单可用'],
      depends_on: [],
    },
  ])
  h.hub.missions.dispatchMission(leadSession.session_id, mission.mission_id)
  const [t1, t2] = planned.created.map((t) => t.task_id) as [string, string]

  // t1: devx implements, supx reviews and approves, then it merges so t2 unlocks
  const dev = newSession(h.hub, 'devx', 'backend_dev')
  h.hub.board.claimTask(dev.session_id, t1)
  commitInWorktree(h, h.hub.store.requireTask(t1), { 'src/auth.ts': 'export const ok = 1\n' })
  h.hub.board.submitTask(h.hub.identity.requireIdentity(dev.session_id), t1, 'auth done')
  const sup = newSession(h.hub, 'supx', 'supervisor')
  h.hub.board.recordVerdict(h.hub.identity.requireIdentity(sup.session_id), t1, 'approved', [], 'looks fine')
  h.hub.board.mergeTask(t1, { auto: true })

  // t2: a different agent takes the second card (serialized behind t1)
  const other = newSession(h.hub, 'other', 'frontend_dev')
  h.hub.board.claimTask(other.session_id, t2)

  return {
    missionId: mission.mission_id,
    leadSession: leadSession.session_id,
    tasks: [t1, t2],
    sessions: { dev: dev.session_id, sup: sup.session_id, other: other.session_id },
  }
}

function packageFor(h: Harness, taskId: string, level: ContextLevel, sessionId?: string): string {
  return h.hub.context.build({ taskId, level, sessionId: sessionId ?? null }).markdown
}

// ---------------------------------------------------------------------------
// the three levels
// ---------------------------------------------------------------------------

test('context: minimal has the compact "你在哪" and no teammate table', () => {
  const h = harness('ctx-minimal')
  try {
    const { tasks } = missionWithCrew(h)
    const md = packageFor(h, tasks[0]!, 'minimal')
    assert.match(md, /## 你在哪（紧凑）/)
    assert.doesNotMatch(md, /## 队友/)
    assert.doesNotMatch(md, /\| agent \| 性格 \|/)
    // still says where you are, which card is yours, and what done means
    assert.match(md, /M-000001/)
    assert.match(md, /leadx/)
    assert.match(md, new RegExp(tasks[0]!))
    assert.match(md, /完成定义/)
    // §3.2 is not part of minimal
    assert.doesNotMatch(md, /## 这个平台怎么用/)
  } finally {
    h.cleanup()
  }
})

test('context: standard has both sections, the full table and the platform how-to', () => {
  const h = harness('ctx-standard')
  try {
    const { tasks } = missionWithCrew(h)
    const md = packageFor(h, tasks[0]!, 'standard')
    assert.match(md, /## 你在哪\n/)
    assert.match(md, /你是第 1\/2 个执行者/)
    assert.match(md, /Lead：leadx/)
    assert.match(md, /## 队友（本次协作，按参与顺序）/)
    assert.match(md, /\| agent \| 性格 \| 擅长 \| 弱势 \| 质量分 \| 花费 \| 本轮负责 \|/)
    assert.match(md, /## 这个平台怎么用（速查）/)
    // the table's content comes from the profiles, not from a template
    assert.match(md, /沉稳工程化/)
    assert.match(md, /严谨啰嗦/)
    assert.match(md, /启动慢/)
  } finally {
    h.cleanup()
  }
})

test('context: full is a superset of standard', () => {
  const h = harness('ctx-full')
  try {
    const { tasks } = missionWithCrew(h)
    const standard = packageFor(h, tasks[0]!, 'standard')
    const full = packageFor(h, tasks[0]!, 'full')
    for (const marker of ['## 你在哪', '## 队友', '## 这个平台怎么用', '完成定义']) {
      assert.ok(standard.includes(marker), `standard should contain ${marker}`)
      assert.ok(full.includes(marker), `full should contain ${marker}`)
    }
    assert.match(full, /## 项目结构/)
    assert.ok(full.length > standard.length)
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// "you are here" specifics
// ---------------------------------------------------------------------------

test('context: the package names your own card and role, at every level', () => {
  const h = harness('ctx-own-card')
  try {
    const { tasks } = missionWithCrew(h)
    for (const level of ['minimal', 'standard', 'full'] as ContextLevel[]) {
      const md = packageFor(h, tasks[1]!, level)
      assert.match(md, new RegExp(`你这一环：${tasks[1]}`), `${level} must name this card`)
      assert.match(md, /角色 frontend_dev/, `${level} must state the role`)
    }
    // position is 2/2 for the second card
    assert.match(packageFor(h, tasks[1]!, 'standard'), /你是第 2\/2 个执行者/)
  } finally {
    h.cleanup()
  }
})

test('context: a card outside any mission degrades to the compact form', () => {
  const h = harness('ctx-no-mission')
  try {
    addAgent(h.hub, 'devx', ['backend_dev'] as RoleId[])
    const task = h.hub.board.createTask({
      title: '独立的小活',
      role: 'backend_dev',
      scope: { write: ['src/x.ts'] },
      acceptance: ['能用'],
    })
    const md = packageFor(h, task.task_id, 'standard')
    assert.match(md, /## 你在哪（紧凑）/)
    assert.match(md, /不属于任何 mission/)
    assert.doesNotMatch(md, /## 队友/)
    // §3.2 still applies: it is platform info, not mission info
    assert.match(md, /## 这个平台怎么用/)
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// the table follows the mission
// ---------------------------------------------------------------------------

test('context: the teammate table changes with the mission (different crew, different rows)', () => {
  const h = harness('ctx-per-mission')
  try {
    const a = missionWithCrew(h)
    // A second mission with a completely different crew
    addAgent(h.hub, 'solo', ['executor', 'lead'] as RoleId[])
    h.hub.profiles.set('solo', 'personality', '独来独往')
    const m2 = h.hub.missions.createMission({ title: '另一个 mission', brief: 'b', lead_agent: 'solo' })
    const lead2 = h.hub.missions.createLeadSession(m2.mission_id, { spawned_by: 'test' })
    h.hub.identity.hello(lead2.session_id)
    const planned2 = h.hub.missions.planMission(lead2.session_id, m2.mission_id, [
      { title: '单干', role: 'executor', scope: { write: ['src/y.ts'] }, acceptance: ['ok'] },
    ])
    h.hub.missions.dispatchMission(lead2.session_id, m2.mission_id)

    const mdA = packageFor(h, a.tasks[0]!, 'standard')
    const mdB = packageFor(h, planned2.created[0]!.task_id, 'standard')

    assert.match(mdA, /devx/)
    assert.match(mdA, /supx/)
    assert.doesNotMatch(mdB, /devx/)
    assert.doesNotMatch(mdB, /supx/)
    assert.match(mdB, /solo/)

    // and the structured rows agree with the rendered table
    const rowsA = buildTeammates(h.hub.store, a.missionId)
    const rowsB = buildTeammates(h.hub.store, m2.mission_id)
    assert.notDeepEqual(
      rowsA.map((r) => r.agent_id),
      rowsB.map((r) => r.agent_id),
    )
    for (const row of rowsA) assert.ok(mdA.includes(row.agent_id), `table must include ${row.agent_id}`)
  } finally {
    h.cleanup()
  }
})

test('context: the viewer row is marked, and the lead is flagged', () => {
  const h = harness('ctx-viewer')
  try {
    const { tasks, sessions } = missionWithCrew(h)
    const md = packageFor(h, tasks[0]!, 'standard', sessions.dev)
    assert.match(md, /\| devx ← 你 \|/)
    const rows = buildTeammates(h.hub.store, 'M-000001')
    assert.equal(rows[0]!.agent_id, 'leadx', 'lead comes first')
    assert.equal(rows[0]!.is_lead, true)
    assert.equal(rows[0]!.role_in_mission, 'lead')
    const dev = rows.find((r) => r.agent_id === 'devx')!
    assert.equal(dev.role_in_mission, `实现 ${tasks[0]}`)
    const sup = rows.find((r) => r.agent_id === 'supx')!
    assert.equal(sup.role_in_mission, `审查 ${tasks[0]}`)
  } finally {
    h.cleanup()
  }
})

test('context: table columns follow profile edits immediately', () => {
  const h = harness('ctx-profile-sync')
  try {
    const { tasks } = missionWithCrew(h)
    const before = packageFor(h, tasks[0]!, 'standard')
    assert.match(before, /沉稳工程化/)

    h.hub.profiles.set('leadx', 'personality', '改过的性格')
    h.hub.profiles.set('leadx', 'quality_score', '97')
    const after = packageFor(h, tasks[0]!, 'standard')
    assert.match(after, /改过的性格/)
    assert.doesNotMatch(after, /沉稳工程化/)
    assert.match(after, /97/)

    // cost_tier is synced to the card by `set`, and the table shows it
    h.hub.profiles.set('leadx', 'cost_tier', '3')
    assert.match(packageFor(h, tasks[0]!, 'standard'), /\| 3 \| lead \|/)
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// list_teammates (the tool)
// ---------------------------------------------------------------------------

test('list_teammates: returns the same crew as the injected table', () => {
  const h = harness('ctx-tool')
  try {
    const { tasks, leadSession } = missionWithCrew(h)
    const api = new HubApi(h.hub)
    const result = api.list_teammates(leadSession, 'M-000001') as {
      ok: boolean
      data: { mission_id: string; lead_agent: string; teammates: Array<Record<string, unknown>> }
    }
    assert.equal(result.ok, true)
    assert.equal(result.data.mission_id, 'M-000001')
    assert.equal(result.data.lead_agent, 'leadx')
    const ids = result.data.teammates.map((t) => t['agent_id'])
    assert.deepEqual(ids.slice(0, 4), ['leadx', 'devx', 'supx', 'other'])
    const dev = result.data.teammates.find((t) => t['agent_id'] === 'devx')!
    assert.equal(dev['quality_score'], 60)
    assert.equal(dev['role_in_mission'], `实现 ${tasks[0]}`)
    // every row appears in the package the agent is given
    const md = packageFor(h, tasks[0]!, 'standard')
    for (const row of result.data.teammates) assert.ok(md.includes(String(row['agent_id'])))
  } finally {
    h.cleanup()
  }
})

test('list_teammates: a session bound to no mission must name one', () => {
  const h = harness('ctx-tool-nomission')
  try {
    addAgent(h.hub, 'devx', ['backend_dev'] as RoleId[])
    const session = newSession(h.hub, 'devx', 'backend_dev')
    const api = new HubApi(h.hub)
    assert.throws(
      () => api.list_teammates(session.session_id),
      (e: { code?: string }) => e.code === 'MESH_SCHEMA_INVALID',
    )
  } finally {
    h.cleanup()
  }
})
