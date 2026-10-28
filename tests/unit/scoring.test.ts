import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Scheduler } from '../../hub/scheduler/scheduler.ts'
import { rankAgents, scoreAgent, specialtyMatch, LOAD_PENALTY_PER_SESSION, SCORE_WEIGHTS } from '../../hub/scheduler/scoring.ts'
import { ProfileService } from '../../hub/core/profiles.ts'
import { MeshError } from '../../hub/core/errors.ts'
import { addAgent, createHarness, createReadyTask, newSession } from '../helpers.ts'
import type { Harness } from '../helpers.ts'
import type { AgentProfile, PeerScore, RoleId, TaskCard } from '../../hub/core/types.ts'

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const NOOP = { command: process.execPath, args: ['-e', '0'] }

function harness(name: string): Harness {
  return createHarness(name)
}

/** A mission with a lead and one implementer, so both are `participants`. */
function missionWithParticipants(h: Harness): { missionId: string; lead: string; dev: string; taskId: string } {
  addAgent(h.hub, 'leadx', ['backend_dev', 'lead'] as RoleId[], NOOP)
  addAgent(h.hub, 'devx', ['backend_dev'] as RoleId[], NOOP)
  const mission = h.hub.missions.createMission({ title: '评分试验', brief: '评分试验', lead_agent: 'leadx' })
  const session = h.hub.missions.createLeadSession(mission.mission_id, { spawned_by: 'test' })
  h.hub.identity.hello(session.session_id)
  const planned = h.hub.missions.planMission(session.session_id, mission.mission_id, [
    { title: '实现接口', role: 'backend_dev' as RoleId, scope: { write: ['src/a.ts'] }, acceptance: ['能跑'] },
  ])
  const taskId = planned.created[0]!.task_id
  // Cards are draft until dispatch (§1.3); claim them once the mission is executing.
  h.hub.missions.dispatchMission(session.session_id, mission.mission_id)
  // Claiming is enough to make `devx` an implementer — no commit needed for scoring tests.
  const devSession = newSession(h.hub, 'devx', 'backend_dev')
  h.hub.board.claimTask(devSession.session_id, taskId)
  return { missionId: mission.mission_id, lead: session.session_id, dev: devSession.session_id, taskId }
}

function card(h: Harness, overrides: Partial<TaskCard> = {}): TaskCard {
  return { ...createReadyTask(h.hub, { title: 'TypeScript 架构重构', write: ['src/x.ts'] }), ...overrides }
}

function profileOf(h: Harness, agentId: string, patch: Partial<AgentProfile>): AgentProfile {
  return { ...h.hub.profiles.ensure(agentId), ...patch }
}

const SCORES_90: PeerScore = { quality: 90, cooperation: 85, evidence: 95, speed: 70 }

// ---------------------------------------------------------------------------
// §2.2 the formula
// ---------------------------------------------------------------------------

test('scoring: the score is exactly the §2.2 formula', () => {
  const h = harness('score-formula')
  try {
    addAgent(h.hub, 'a1', ['backend_dev'], { cost_tier: 2 })
    const task = card(h)
    const profile = profileOf(h, 'a1', {
      // one strength that matches the task title => specialtyMatch = 1
      strengths: ['TypeScript'],
      quality_score: 82,
      reliability: 88,
      cost_tier: 2,
    })
    const scored = scoreAgent({ agent: h.hub.store.requireAgent('a1'), profile, load: 0, task })

    const expected =
      SCORE_WEIGHTS.quality * (82 / 100) + // 0.451
      SCORE_WEIGHTS.cost * (1 - (2 - 1) / 2) + // 0.1
      SCORE_WEIGHTS.reliability * (88 / 100) + // 0.132
      SCORE_WEIGHTS.specialty * 1 // 0.1
    assert.equal(scored.score, Math.round(expected * 1e6) / 1e6)
    assert.equal(scored.score.toFixed(6), '0.783000')
    assert.equal(scored.parts.loadPenalty, 0)
  } finally {
    h.cleanup()
  }
})

test('scoring: an agent with no profile falls back to quality 60 / reliability 70', () => {
  const h = harness('score-defaults')
  try {
    addAgent(h.hub, 'bare', ['backend_dev'], { cost_tier: 2 })
    const task = card(h, { title: 'nothing-related' })
    const scored = scoreAgent({ agent: h.hub.store.requireAgent('bare'), profile: null, load: 0, task })
    const expected = 0.55 * 0.6 + 0.2 * 0.5 + 0.15 * 0.7
    assert.equal(scored.score.toFixed(6), expected.toFixed(6))
  } finally {
    h.cleanup()
  }
})

test('scoring: cost_tier is monotonic (cheap scores higher, everything else equal)', () => {
  const h = harness('score-cost')
  try {
    addAgent(h.hub, 'cheap', ['backend_dev'], { cost_tier: 1 })
    addAgent(h.hub, 'mid', ['backend_dev'], { cost_tier: 2 })
    addAgent(h.hub, 'pricey', ['backend_dev'], { cost_tier: 3 })
    const task = card(h, { title: 'unrelated' })
    const s = (id: string, tier: 1 | 2 | 3): number =>
      scoreAgent({ agent: h.hub.store.requireAgent(id), profile: profileOf(h, id, { cost_tier: tier }), load: 0, task }).score
    assert.ok(s('cheap', 1) > s('mid', 2))
    assert.ok(s('mid', 2) > s('pricey', 3))
    // the gap is exactly 0.2 * 0.5 per tier step
    assert.ok(Math.abs(s('cheap', 1) - s('mid', 2) - 0.1) < 1e-9)
  } finally {
    h.cleanup()
  }
})

test('scoring: load penalty is 0.05 per running session', () => {
  const h = harness('score-load')
  try {
    addAgent(h.hub, 'a1', ['backend_dev'])
    const task = card(h, { title: 'unrelated' })
    const base = scoreAgent({ agent: h.hub.store.requireAgent('a1'), profile: null, load: 0, task }).score
    const loaded = scoreAgent({ agent: h.hub.store.requireAgent('a1'), profile: null, load: 3, task })
    assert.equal(loaded.parts.loadPenalty, LOAD_PENALTY_PER_SESSION * 3)
    assert.ok(Math.abs(base - loaded.score - 0.15) < 1e-9)
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// specialtyMatch
// ---------------------------------------------------------------------------

test('scoring: specialtyMatch is lexical, bounded and deterministic', () => {
  const h = harness('score-specialty')
  try {
    addAgent(h.hub, 'a1', ['backend_dev'])
    const task = card(h, { title: 'TypeScript 架构重构', role: 'backend_dev' })
    const matched = profileOf(h, 'a1', { strengths: ['TypeScript 架构设计'], specialties: [] })
    const unrelated = profileOf(h, 'a1', { strengths: ['视觉设计'], specialties: ['动效'] })
    const half = profileOf(h, 'a1', { strengths: ['TypeScript', '视觉设计'], specialties: [] })
    const empty = profileOf(h, 'a1', { strengths: [], specialties: [] })

    assert.equal(specialtyMatch(task, matched), 1)
    assert.equal(specialtyMatch(task, unrelated), 0)
    assert.equal(specialtyMatch(task, half), 0.5)
    assert.equal(specialtyMatch(task, empty), 0)
    assert.equal(specialtyMatch(null, matched), 0)
    assert.equal(specialtyMatch(task, null), 0)
    // The role is part of the haystack: an English strength matches "backend_dev"
    const roleOnly = profileOf(h, 'a1', { strengths: ['backend'], specialties: [] })
    assert.equal(specialtyMatch(card(h, { title: '别的东西', role: 'backend_dev' }), roleOnly), 1)
    // 100 calls, one value
    const values = new Set(Array.from({ length: 100 }, () => specialtyMatch(task, half)))
    assert.deepEqual([...values], [0.5])
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// stable ordering (§2.2 "排序稳定")
// ---------------------------------------------------------------------------

test('scoring: equal scores break by agent_id, and never depend on insertion order', () => {
  const h = harness('score-tiebreak')
  try {
    // Same everything: cost 2, no profile (defaults), no load, unrelated task
    addAgent(h.hub, 'zulu', ['backend_dev'], { cost_tier: 2 })
    addAgent(h.hub, 'alpha', ['backend_dev'], { cost_tier: 2 })
    addAgent(h.hub, 'mike', ['backend_dev'], { cost_tier: 2 })
    const task = card(h, { title: 'unrelated' })
    const scheduler = new Scheduler(h.hub)

    const first = scheduler.pickAgent('backend_dev', task)
    assert.equal(first?.agent_id, 'alpha', 'ties go to the lexicographically smallest id')

    // Same answer 50 times in a row (no randomness, no map-order dependence)
    const ids = new Set(Array.from({ length: 50 }, () => scheduler.pickAgent('backend_dev', task)?.agent_id))
    assert.deepEqual([...ids], ['alpha'])

    // The ranking itself is a total order over the three
    const ranked = scheduler.rankCandidates('backend_dev', task)
    assert.deepEqual(ranked.map((r) => r.agent_id), ['alpha', 'mike', 'zulu'])
  } finally {
    h.cleanup()
  }
})

test('scoring: rankAgents is a stable total order (equal scores -> id asc)', () => {
  const tied = ['c', 'a', 'b'].map((id) => ({ agent_id: id, score: 0.5, parts: { quality: 0, cost: 0, reliability: 0, specialty: 0, loadPenalty: 0 } }))
  assert.deepEqual(rankAgents(tied).map((r) => r.agent_id), ['a', 'b', 'c'])
  const mixed = [
    { agent_id: 'x', score: 0.2, parts: { quality: 0, cost: 0, reliability: 0, specialty: 0, loadPenalty: 0 } },
    { agent_id: 'y', score: 0.9, parts: { quality: 0, cost: 0, reliability: 0, specialty: 0, loadPenalty: 0 } },
  ]
  assert.deepEqual(rankAgents(mixed).map((r) => r.agent_id), ['y', 'x'])
})

// ---------------------------------------------------------------------------
// §2.4 peer review boundaries
// ---------------------------------------------------------------------------

test('rate_peer: weighted moving average is exactly 0.7*old + 0.3*avg_peer', () => {
  const h = harness('rate-wma')
  try {
    const { missionId, lead, dev } = missionWithParticipants(h)
    // devx starts at the default 60
    assert.equal(h.hub.profiles.view('devx').quality_score, 60)

    const first = h.hub.profiles.ratePeer({ by_agent: 'leadx', agent_id: 'devx', mission_id: missionId, scores: SCORES_90 })
    // 0.7*60 + 0.3*90 = 69
    assert.equal(first.quality_before, 60)
    assert.equal(first.quality_after, 69)
    assert.equal(first.applied, true)

    // A second rater (the implementer is a participant, the lead is a participant)
    const second = h.hub.profiles.ratePeer({
      by_agent: 'devx',
      agent_id: 'leadx',
      mission_id: missionId,
      scores: { quality: 80, cooperation: 80, evidence: 80, speed: 80 },
    })
    assert.equal(second.quality_after, Math.round(0.7 * 60 + 0.3 * 80))

    // Same rater rates again with a lower score: it OVERWRITES, it does not add
    const third = h.hub.profiles.ratePeer({ by_agent: 'leadx', agent_id: 'devx', mission_id: missionId, scores: { ...SCORES_90, quality: 30 } })
    assert.equal(third.overwritten, true)
    assert.equal(third.profile.peer_reviews.length, 1, 'one review per (rater, target, mission)')
    // avg is now just the 30 → 0.7*69 + 0.3*30 = 57.3 → 57
    assert.equal(third.quality_after, Math.round(0.7 * 69 + 0.3 * 30))
    void lead
    void dev
  } finally {
    h.cleanup()
  }
})

test('rate_peer: every anti-abuse boundary is enforced', () => {
  const h = harness('rate-boundaries')
  try {
    const { missionId } = missionWithParticipants(h)
    addAgent(h.hub, 'outsider', ['backend_dev'], NOOP)

    // 1. cannot rate yourself
    assert.throws(
      () => h.hub.profiles.ratePeer({ by_agent: 'leadx', agent_id: 'leadx', mission_id: missionId, scores: SCORES_90 }),
      (e: { code?: string }) => e.code === 'MESH_RATE_DENIED',
    )
    // 2. an agent that never took part in this mission cannot rate
    assert.throws(
      () => h.hub.profiles.ratePeer({ by_agent: 'outsider', agent_id: 'devx', mission_id: missionId, scores: SCORES_90 }),
      (e: { code?: string }) => e.code === 'MESH_RATE_DENIED',
    )
    // 3. scores out of range are refused (each dimension)
    for (const bad of [-1, 101, Number.NaN] as number[]) {
      assert.throws(
        () => h.hub.profiles.ratePeer({ by_agent: 'leadx', agent_id: 'devx', mission_id: missionId, scores: { ...SCORES_90, quality: bad } }),
        (e: MeshError | { code?: string }) => (e as { code?: string }).code === 'MESH_RATE_DENIED',
        `quality=${bad} must be refused`,
      )
    }
    // 4. a missing dimension is refused (not silently 0)
    assert.throws(
      () =>
        h.hub.profiles.ratePeer({
          by_agent: 'leadx',
          agent_id: 'devx',
          mission_id: missionId,
          scores: { quality: 90 } as PeerScore,
        }),
      (e: { code?: string }) => e.code === 'MESH_RATE_DENIED',
    )
    // 5. unknown mission
    assert.throws(
      () => h.hub.profiles.ratePeer({ by_agent: 'leadx', agent_id: 'devx', mission_id: 'M-999999', scores: SCORES_90 }),
      (e: { code?: string }) => e.code === 'MESH_ENTITY_NOT_FOUND' || e.code === 'MESH_UNKNOWN_ENTITY',
    )
    // Nothing above mutated the profile
    assert.equal(h.hub.profiles.view('devx').peer_reviews.length, 0)
  } finally {
    h.cleanup()
  }
})

test('rate_peer: a manually locked profile records reviews but keeps its score', () => {
  const h = harness('rate-locked')
  try {
    const { missionId } = missionWithParticipants(h)
    h.hub.profiles.set('devx', 'quality_score', 95)
    assert.equal(h.hub.profiles.view('devx').manual_locked, true)

    const result = h.hub.profiles.ratePeer({ by_agent: 'leadx', agent_id: 'devx', mission_id: missionId, scores: SCORES_90 })
    assert.equal(result.applied, false)
    assert.equal(result.quality_after, 95, 'manual value must survive peer ratings')
    assert.equal(result.profile.peer_reviews.length, 1, 'the review is still recorded for humans')

    // Handing control back lets peers move it again
    h.hub.profiles.set('devx', 'manual_locked', 'false')
    const after = h.hub.profiles.ratePeer({ by_agent: 'leadx', agent_id: 'devx', mission_id: missionId, scores: SCORES_90 })
    assert.equal(after.applied, true)
    assert.equal(after.quality_after, Math.round(0.7 * 95 + 0.3 * 90))
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// manual editing affects the next dispatch (acceptance item)
// ---------------------------------------------------------------------------

test('profile set: a hand-edited quality_score changes who gets the next card', () => {
  const h = harness('profile-dispatch')
  try {
    addAgent(h.hub, 'alpha', ['backend_dev'], NOOP)
    addAgent(h.hub, 'beta', ['backend_dev'], NOOP)
    const task = card(h, { title: 'unrelated' })
    const scheduler = new Scheduler(h.hub)

    // Defaults are identical → ties resolve to 'alpha'
    assert.equal(scheduler.pickAgent('backend_dev', task)?.agent_id, 'alpha')

    // A human says beta is better → beta wins on the very next decision
    h.hub.profiles.set('beta', 'quality_score', '95')
    assert.equal(scheduler.pickAgent('backend_dev', task)?.agent_id, 'beta')

    // …and the hand edit is what did it: beta now outranks alpha on quality
    const ranked = scheduler.rankCandidates('backend_dev', task)
    assert.equal(ranked[0]!.agent_id, 'beta')
    assert.ok(ranked[0]!.score > ranked[1]!.score)

    // Editing alpha's reliability alone is not enough to flip it back
    h.hub.profiles.set('alpha', 'reliability', '100')
    assert.equal(scheduler.pickAgent('backend_dev', task)?.agent_id, 'beta', 'reliability weight is lower than quality')
  } finally {
    h.cleanup()
  }
})

test('profile set: cost_tier stays in sync with the AgentCard', () => {
  const h = harness('profile-cost-sync')
  try {
    addAgent(h.hub, 'a1', ['backend_dev'], { cost_tier: 2 })
    h.hub.profiles.set('a1', 'cost_tier', '3')
    assert.equal(h.hub.profiles.view('a1').cost_tier, 3)
    assert.equal(h.hub.store.requireAgent('a1').cost_tier, 3, 'the launch recipe must follow the profile')
    assert.throws(
      () => h.hub.profiles.set('a1', 'cost_tier', '9'),
      (e: { code?: string }) => e.code === 'MESH_SCHEMA_INVALID',
    )
  } finally {
    h.cleanup()
  }
})

test('profiles: every agent gets one on init, and the nine labels are fixed', () => {
  const h = harness('profile-backfill')
  try {
    addAgent(h.hub, 'a1', ['backend_dev'])
    addAgent(h.hub, 'a2', ['supervisor'])
    assert.equal(new ProfileService(h.hub.store).backfill(), 2)
    assert.deepEqual(
      h.hub.profiles.list().map((p) => p.agent_id),
      ['a1', 'a2'],
    )
    const labels = h.hub.profiles.dimensionValues('a1').map((d) => d.label)
    assert.deepEqual(labels, ['性格', '擅长', '弱势', '能力范围', '独特细节', '质量分', '花费', '可靠性', '速度'])
  } finally {
    h.cleanup()
  }
})
