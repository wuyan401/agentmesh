/**
 * Agent profiles (V2 §2): the judgement layer, separate from the launch recipe.
 *
 * An AgentCard answers "how do I start this CLI"; an AgentProfile answers "what is
 * this agent like, what is it good at, and how has it actually done". The profile is
 * what `pickAgent` ranks on, and what peers edit with `rate_peer`.
 *
 * Every rule in §2.4 is enforced here, in code — a score is data, not an opinion.
 */

import { MeshError, MESH_ERRORS } from './errors.ts'
import { nowIso } from './fsx.ts'
import { DEFAULT_PROFILE_SCORES } from './types.ts'
import { PEER_SCORE_KEYS } from './types.ts'
import type { MeshStore } from './store.ts'
import type { AgentCard, AgentProfile, PeerReview, PeerScore, ProfileStats } from './types.ts'

/** The nine dimensions, with the exact labels the spec fixes for the table header. */
export const PROFILE_DIMENSIONS = [
  { key: 'personality', label: '性格' },
  { key: 'strengths', label: '擅长' },
  { key: 'weaknesses', label: '弱势' },
  { key: 'capability_notes', label: '能力范围' },
  { key: 'specialties', label: '独特细节' },
  { key: 'quality_score', label: '质量分' },
  { key: 'cost_tier', label: '花费' },
  { key: 'reliability', label: '可靠性' },
  { key: 'speed_notes', label: '速度' },
] as const

export type ProfileField = (typeof PROFILE_DIMENSIONS)[number]['key'] | 'manual_locked'

const WMA_OLD_WEIGHT = 0.7
const WMA_PEER_WEIGHT = 0.3

function emptyStats(): ProfileStats {
  return { missions: 0, tasks: 0, approved: 0, rejected: 0, rounds: 0 }
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

export interface RatePeerInput {
  by_agent: string
  agent_id: string
  mission_id: string
  task_id?: string | null
  scores: Partial<PeerScore>
  comment?: string
}

export interface RatePeerResult {
  profile: AgentProfile
  review: PeerReview
  quality_before: number
  quality_after: number
  overwritten: boolean
  applied: boolean
}

export class ProfileService {
  readonly store: MeshStore

  constructor(store: MeshStore) {
    this.store = store
  }

  /** Seed a profile from the agent card; defaults come from §2.2. */
  defaultsFor(agent: AgentCard): AgentProfile {
    return {
      agent_id: agent.agent_id,
      personality: '',
      strengths: [],
      weaknesses: [],
      capability_notes: agent.notes,
      specialties: [],
      quality_score: DEFAULT_PROFILE_SCORES.quality_score,
      cost_tier: agent.cost_tier,
      reliability: DEFAULT_PROFILE_SCORES.reliability,
      speed_notes: '',
      manual_locked: false,
      peer_reviews: [],
      stats: emptyStats(),
      updated_at: nowIso(),
    }
  }

  /** Load, or create-and-persist on first touch ("每个 agent 接入后都有一份标注"). */
  ensure(agentId: string): AgentProfile {
    const existing = this.store.getProfile(agentId)
    if (existing) return existing
    const agent = this.store.requireAgent(agentId)
    const profile = this.defaultsFor(agent)
    this.store.saveProfile(profile)
    return profile
  }

  /** Read-only view: falls back to defaults without writing anything. */
  view(agentId: string): AgentProfile {
    const existing = this.store.getProfile(agentId)
    if (existing) return existing
    return this.defaultsFor(this.store.requireAgent(agentId))
  }

  list(): AgentProfile[] {
    return this.store.listAgents().map((agent) => this.view(agent.agent_id))
  }

  // -- manual editing ------------------------------------------------------

  /**
   * Human edit. Any edit marks the profile `manual_locked`, which is what stops peer
   * reviews from overwriting the quality score later (spec §2.1/§2.2). A human can
   * hand control back with `set(..., 'manual_locked', false)`.
   */
  set(agentId: string, field: ProfileField, raw: string | number | string[] | boolean, by = 'mesh-human'): AgentProfile {
    const profile = this.ensure(agentId)
    switch (field) {
      case 'personality':
      case 'capability_notes':
      case 'speed_notes':
        profile[field] = String(raw)
        break
      case 'strengths':
      case 'weaknesses':
      case 'specialties': {
        const list = Array.isArray(raw)
          ? raw
          : String(raw)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
        profile[field] = list
        break
      }
      case 'quality_score':
      case 'reliability': {
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `${field} must be 0-100, got ${String(raw)}`, { field })
        }
        profile[field] = Math.round(n)
        break
      }
      case 'cost_tier': {
        const n = Number(raw)
        if (![1, 2, 3].includes(n)) {
          throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `cost_tier must be 1|2|3, got ${String(raw)}`, { field })
        }
        profile.cost_tier = n as 1 | 2 | 3
        // Spec §2.1: keep the profile and the launch recipe in sync.
        const agent = this.store.requireAgent(agentId)
        if (agent.cost_tier !== profile.cost_tier) {
          agent.cost_tier = profile.cost_tier
          this.store.saveAgent(agent)
        }
        break
      }
      case 'manual_locked':
        profile.manual_locked = raw === true || raw === 'true' || raw === 1 || raw === '1'
        break
      default:
        throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `unknown profile field: ${String(field)}`, {
          field,
          allowed: [...PROFILE_DIMENSIONS.map((d) => d.key), 'manual_locked'],
        })
    }
    if (field !== 'manual_locked') profile.manual_locked = true
    this.store.saveProfile(profile)
    this.store.auditEvent('profile.set', { agent_id: agentId, field, by, manual_locked: profile.manual_locked })
    return profile
  }

  // -- peer review (§2.4) --------------------------------------------------

  /** Agents that actually took part in a mission: implementers, reviewers, the lead. */
  participantsOf(missionId: string): Set<string> {
    const mission = this.store.getMission(missionId)
    const out = new Set<string>()
    if (!mission) return out
    out.add(mission.lead_agent)
    for (const taskId of mission.tasks) {
      const task = this.store.getTask(taskId)
      if (!task) continue
      if (task.implementer_agent) out.add(task.implementer_agent)
      for (const review of this.store.listReviews(taskId)) {
        if (review.reviewer_agent) out.add(review.reviewer_agent)
      }
    }
    return out
  }

  /**
   * Peer review with the anti-abuse boundaries from §2.4:
   *  - only agents that took part in the same mission may review;
   *  - nobody reviews themselves;
   *  - one review per (by_agent, agent_id, mission_id), overwriting in place;
   *  - every score 0-100, out of range refused;
   *  - quality_score moves by a weighted moving average, and only once at least one
   *    peer review exists (and never when a human locked the profile).
   */
  ratePeer(input: RatePeerInput): RatePeerResult {
    const { by_agent, agent_id, mission_id } = input
    if (!by_agent || !agent_id || !mission_id) {
      throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'rate_peer needs by_agent, agent_id and mission_id')
    }
    this.store.requireAgent(by_agent)
    const target = this.store.requireAgent(agent_id)
    if (by_agent === agent_id) {
      throw new MeshError(MESH_ERRORS.RATE_DENIED, 'an agent cannot rate itself', { agent_id })
    }
    this.store.requireMission(mission_id)
    const participants = this.participantsOf(mission_id)
    if (!participants.has(by_agent) || !participants.has(agent_id)) {
      throw new MeshError(
        MESH_ERRORS.RATE_DENIED,
        'both agents must have taken part in this mission (a task or a review record)',
        { by_agent, agent_id, mission_id, participants: [...participants].sort() },
      )
    }
    const scores = {} as PeerScore
    for (const key of PEER_SCORE_KEYS) {
      const value = input.scores[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new MeshError(MESH_ERRORS.RATE_DENIED, `scores.${key} must be 0-100, got ${String(value)}`, {
          field: key,
          value: value ?? null,
        })
      }
      scores[key] = Math.round(value)
    }

    const profile = this.ensure(agent_id)
    const qualityBefore = profile.quality_score
    const review: PeerReview = {
      by_agent,
      mission_id,
      task_id: input.task_id ?? null,
      scores,
      comment: String(input.comment ?? '').slice(0, 2000),
      at: nowIso(),
    }
    const index = profile.peer_reviews.findIndex(
      (r) => r.by_agent === by_agent && r.mission_id === mission_id,
    )
    const overwritten = index >= 0
    if (overwritten) profile.peer_reviews[index] = review
    else profile.peer_reviews.push(review)

    const applied = !profile.manual_locked && profile.peer_reviews.length >= 1
    if (applied) {
      const avgPeer = profile.peer_reviews.reduce((sum, r) => sum + r.scores.quality, 0) / profile.peer_reviews.length
      profile.quality_score = clampScore(WMA_OLD_WEIGHT * profile.quality_score + WMA_PEER_WEIGHT * avgPeer)
    }
    this.store.saveProfile(profile)
    this.store.auditEvent('profile.rate_peer', {
      agent_id,
      by_agent,
      mission_id,
      task_id: review.task_id,
      scores,
      quality_before: qualityBefore,
      quality_after: profile.quality_score,
      applied,
      overwritten,
    })
    return {
      profile,
      review,
      quality_before: qualityBefore,
      quality_after: profile.quality_score,
      overwritten,
      applied,
    }
  }

  // -- automatic stats (§2.1 "reliability: 成功率，自动统计") ---------------

  /** Never throws: a stats bookkeeping failure must not break a verdict. */
  private mutateStats(agentId: string, mutate: (p: AgentProfile) => void): void {
    try {
      const profile = this.ensure(agentId)
      mutate(profile)
      const outcomes = profile.stats.approved + profile.stats.rejected
      if (outcomes > 0) profile.reliability = clampScore((profile.stats.approved / outcomes) * 100)
      this.store.saveProfile(profile)
    } catch (e) {
      process.stderr.write(`[mesh] profile stats update failed for ${agentId}: ${(e as Error).message}\n`)
    }
  }

  noteTask(agentId: string): void {
    this.mutateStats(agentId, (p) => {
      p.stats.tasks += 1
    })
  }

  noteMission(agentId: string): void {
    this.mutateStats(agentId, (p) => {
      p.stats.missions += 1
    })
  }

  noteOutcome(agentId: string, outcome: 'approved' | 'rejected'): void {
    this.mutateStats(agentId, (p) => {
      if (outcome === 'approved') p.stats.approved += 1
      else {
        p.stats.rejected += 1
        p.stats.rounds += 1
      }
    })
  }

  /** Mission-level rework counts against the agent whose card was sent back. */
  noteRound(agentId: string): void {
    this.mutateStats(agentId, (p) => {
      p.stats.rounds += 1
    })
  }

  // -- display -------------------------------------------------------------

  /** One row of the nine dimensions, for `mesh profile list` / `show`. */
  dimensionValues(agentId: string): Array<{ key: string; label: string; value: string }> {
    const profile = this.view(agentId)
    return PROFILE_DIMENSIONS.map(({ key, label }) => {
      const raw = profile[key]
      const value = Array.isArray(raw) ? raw.join('、') : String(raw)
      return { key, label, value }
    })
  }

  /** Success rate as a percentage, or null when the agent has no verdicts yet. */
  successRate(agentId: string): number | null {
    const { approved, rejected } = this.view(agentId).stats
    const outcomes = approved + rejected
    return outcomes === 0 ? null : Math.round((approved / outcomes) * 100)
  }

  /** Ensure every registered agent has a profile file (called from `mesh init`). */
  backfill(): number {
    let created = 0
    for (const agent of this.store.listAgents()) {
      if (this.store.getProfile(agent.agent_id)) continue
      this.store.saveProfile(this.defaultsFor(agent))
      created++
    }
    return created
  }
}
