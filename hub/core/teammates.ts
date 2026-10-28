/**
 * "Who else is on this?" (V2 §3.1)
 *
 * One implementation, two consumers: the context package renders it as a table, and
 * `list_teammates` returns the same rows as JSON. If they were built separately they
 * would drift, and an agent would be told one thing while the tool said another.
 *
 * Everything here comes from data: `mission.teammates` fixes the order, `AgentProfile`
 * supplies the judgement columns, the task cards and reviews supply "who is doing what".
 * Nothing is hard-coded about any particular agent.
 */

import type { MeshStore } from './store.ts'
import type { AgentProfile, MissionCard, RoleId } from './types.ts'

export interface TeammateInfo {
  agent_id: string
  display_name: string
  /** "lead" / "实现 T-000010" / "审查 T-000010" / "参与" */
  role_in_mission: string
  is_lead: boolean
  personality: string
  strengths: string[]
  weaknesses: string[]
  quality_score: number
  cost_tier: 1 | 2 | 3
  reliability: number
  /** Cards this agent implemented in this mission, in board order. */
  task_ids: string[]
  /** Cards this agent reviewed in this mission. */
  reviewed: string[]
  enabled: boolean
  success_rate: number | null
}

/** Mission that owns a card, or null. Reverse lookup over the mission list. */
export function missionOfTask(store: MeshStore, taskId: string): MissionCard | null {
  for (const mission of store.listMissions()) {
    if (mission.tasks.includes(taskId)) return mission
  }
  return null
}

function successRate(profile: AgentProfile | null): number | null {
  if (!profile) return null
  const outcomes = profile.stats.approved + profile.stats.rejected
  return outcomes === 0 ? null : Math.round((profile.stats.approved / outcomes) * 100)
}

/**
 * The teammate rows for a mission, in participation order.
 *
 * Participation order is `mission.teammates` (whoever actually took part, in the
 * order they first did). The lead is forced to the front if it is somehow missing —
 * a context package that forgets the lead would be actively misleading.
 */
export function buildTeammates(store: MeshStore, missionId: string): TeammateInfo[] {
  const mission = store.getMission(missionId)
  if (!mission) return []

  // who implemented / reviewed what, from the real cards
  const implemented = new Map<string, string[]>()
  const reviewed = new Map<string, string[]>()
  for (const taskId of mission.tasks) {
    const task = store.getTask(taskId)
    if (!task) continue
    if (task.implementer_agent) {
      const list = implemented.get(task.implementer_agent) ?? []
      list.push(taskId)
      implemented.set(task.implementer_agent, list)
    }
    for (const review of store.listReviews(taskId)) {
      if (!review.reviewer_agent) continue
      const list = reviewed.get(review.reviewer_agent) ?? []
      if (!list.includes(taskId)) list.push(taskId)
      reviewed.set(review.reviewer_agent, list)
    }
  }

  // Order: whoever the mission recorded as having taken part, then anyone else the
  // cards prove took part. The second half matters because a worker can claim and
  // submit by itself (channel B) without the scheduler ever calling `noteParticipant`.
  const order: string[] = [...mission.teammates]
  const add = (agentId: string | null): void => {
    if (agentId && !order.includes(agentId)) order.push(agentId)
  }
  for (const taskId of mission.tasks) {
    const task = store.getTask(taskId)
    if (!task) continue
    add(task.implementer_agent)
    for (const review of store.listReviews(taskId)) add(review.reviewer_agent)
  }
  if (!order.includes(mission.lead_agent)) order.unshift(mission.lead_agent)

  const rows: TeammateInfo[] = []
  for (const agentId of order) {
    const agent = store.getAgent(agentId)
    const profile = store.getProfile(agentId)
    const isLead = agentId === mission.lead_agent
    const taskIds = implemented.get(agentId) ?? []
    const reviewIds = reviewed.get(agentId) ?? []
    let roleInMission = '参与'
    if (isLead) roleInMission = 'lead'
    else if (taskIds.length > 0) roleInMission = `实现 ${taskIds.join(', ')}`
    else if (reviewIds.length > 0) roleInMission = `审查 ${reviewIds.join(', ')}`

    rows.push({
      agent_id: agentId,
      display_name: agent?.display_name ?? agentId,
      role_in_mission: roleInMission,
      is_lead: isLead,
      personality: profile?.personality ?? '',
      strengths: profile?.strengths ?? [],
      weaknesses: profile?.weaknesses ?? [],
      quality_score: profile?.quality_score ?? 60,
      cost_tier: (profile?.cost_tier ?? agent?.cost_tier ?? 2) as 1 | 2 | 3,
      reliability: profile?.reliability ?? 70,
      task_ids: taskIds,
      reviewed: reviewIds,
      enabled: agent?.enabled ?? true,
      success_rate: successRate(profile),
    })
  }
  return rows
}

/** Keep a table cell readable without lying about it: an ellipsis, not a trim-and-hide. */
function cell(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '/').trim()
  if (!flat) return '—'
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
}

export interface TeammateSectionOptions {
  /** Mission, needed for the "本轮负责" column's lead prefix. */
  mission: MissionCard
  /** The agent reading the package — its own row is marked. */
  viewerAgent?: string | null
  /** Truncate cells harder in the compact form. */
  compact?: boolean
}

/** The markdown table from §3.1, generated from the rows above. */
export function renderTeammateTable(rows: TeammateInfo[], opts: TeammateSectionOptions): string {
  const lines: string[] = []
  lines.push('## 队友（本次协作，按参与顺序）')
  lines.push('')
  if (rows.length === 0) {
    lines.push('（这个 mission 还没有其他参与者）')
    return lines.join('\n')
  }
  const wide = opts.compact ? 8 : 18
  lines.push('| agent | 性格 | 擅长 | 弱势 | 质量分 | 花费 | 本轮负责 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const row of rows) {
    const marker = opts.viewerAgent && opts.viewerAgent === row.agent_id ? ' ← 你' : ''
    lines.push(
      `| ${row.agent_id}${marker} | ${cell(row.personality, wide)} | ${cell(row.strengths.join('、'), wide)} | ` +
        `${cell(row.weaknesses.join('、'), wide)} | ${row.quality_score} | ${row.cost_tier} | ` +
        `${cell(row.role_in_mission, opts.compact ? 12 : 30)} |`,
    )
  }
  lines.push('')
  lines.push(
    `> 不了解队友时，用 \`hub.list_teammates("${opts.mission.mission_id}")\` 查全量；不要猜。`,
  )
  return lines.join('\n')
}
