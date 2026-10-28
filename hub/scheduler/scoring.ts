/**
 * Agent scoring (V2 §2.2) — pure functions, no I/O.
 *
 *   score = 0.55 * quality/100
 *         + 0.20 * (1 - (cost_tier - 1) / 2)
 *         + 0.15 * reliability/100
 *         + 0.10 * specialtyMatch(task, profile)
 *         - loadPenalty                  // 已跑会话数 × 0.05
 *
 * Two properties this file must never lose:
 *  - **deterministic**: same inputs → same score, bit for bit;
 *  - **stably ordered**: equal scores break by `agent_id` ascending, so "who gets
 *    picked" never depends on list order, map iteration or timing.
 */

import { DEFAULT_PROFILE_SCORES } from '../core/types.ts'
import type { AgentCard, AgentProfile, TaskCard } from '../core/types.ts'

export const SCORE_WEIGHTS = {
  quality: 0.55,
  cost: 0.2,
  reliability: 0.15,
  specialty: 0.1,
} as const

/** 已跑一个会话的扣分 */
export const LOAD_PENALTY_PER_SESSION = 0.05

export interface ScoreParts {
  quality: number
  cost: number
  reliability: number
  specialty: number
  loadPenalty: number
}

export interface ScoredAgent {
  agent_id: string
  score: number
  parts: ScoreParts
}

export interface ScoreInput {
  agent: AgentCard
  profile: AgentProfile | null
  /** Live sessions owned by this agent right now. */
  load: number
  task: TaskCard | null
}

/** Cost term in [0,1]: tier 1 → 1.0, tier 2 → 0.5, tier 3 → 0.0. */
export function costTerm(costTier: 1 | 2 | 3): number {
  return 1 - (costTier - 1) / 2
}

/** Latin words (len ≥ 3) and CJK runs (len ≥ 2) inside a probe string. */
function probesOf(text: string): string[] {
  const out = new Set<string>()
  const lowered = text.toLowerCase()
  for (const word of lowered.split(/[^a-z0-9]+/)) {
    if (word.length >= 3) out.add(word)
  }
  for (const run of lowered.split(/[^\u4e00-\u9fff]+/)) {
    if (run.length >= 2) {
      out.add(run)
      // Chinese has no spaces: also index每个二字词, so "后端接口" matches "接口".
      for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2))
    }
  }
  return [...out]
}

/**
 * Lexical match between the task and the profile's `strengths` + `specialties`.
 *
 * Intentionally dumb and explainable: a strength counts as matched when any of its
 * probes appears in the task text (title + role). Score = matched entries / total
 * entries, so a profile with one very relevant strength is not punished for having
 * ten unrelated ones any harder than its average. No embeddings, no LLM — a lead
 * must be able to predict who gets picked.
 */
export function specialtyMatch(task: TaskCard | null, profile: AgentProfile | null): number {
  if (!task || !profile) return 0
  const entries = [...profile.strengths, ...profile.specialties].map((s) => s.trim()).filter(Boolean)
  if (entries.length === 0) return 0
  const haystack = `${task.title} ${task.role.replace(/_/g, ' ')}`.toLowerCase()
  let matched = 0
  for (const entry of entries) {
    const probes = probesOf(entry)
    if (probes.some((probe) => haystack.includes(probe))) matched++
  }
  return Math.min(1, matched / entries.length)
}

/** The whole formula for one candidate, with its parts exposed for `mesh` diagnostics. */
export function scoreAgent(input: ScoreInput): ScoredAgent {
  const { agent, profile, load, task } = input
  const quality = profile ? profile.quality_score : DEFAULT_PROFILE_SCORES.quality_score
  const reliability = profile ? profile.reliability : DEFAULT_PROFILE_SCORES.reliability
  const costTier = (profile ? profile.cost_tier : agent.cost_tier) as 1 | 2 | 3
  const specialty = specialtyMatch(task, profile)
  const parts: ScoreParts = {
    quality: SCORE_WEIGHTS.quality * (quality / 100),
    cost: SCORE_WEIGHTS.cost * costTerm(costTier),
    reliability: SCORE_WEIGHTS.reliability * (reliability / 100),
    specialty: SCORE_WEIGHTS.specialty * specialty,
    loadPenalty: LOAD_PENALTY_PER_SESSION * Math.max(0, load),
  }
  const score = parts.quality + parts.cost + parts.reliability + parts.specialty - parts.loadPenalty
  return { agent_id: agent.agent_id, score: round6(score), parts }
}

/** Deterministic ordering: score desc, then agent_id asc. */
export function rankAgents(scored: ScoredAgent[]): ScoredAgent[] {
  return [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.agent_id.localeCompare(b.agent_id)
  })
}

/** Kill float noise so equal inputs produce equal numbers, not 0.7499999999. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
