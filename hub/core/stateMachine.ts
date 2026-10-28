/**
 * The task state machine (C5: the Hub is deterministic code).
 *
 * Nothing else in AgentMesh may assign `task.status`. Every change goes through
 * `applyTransition`, which validates the edge, stamps history and refuses the
 * rest. That is what makes "task complete" a platform verdict rather than an
 * agent's opinion.
 */

import { MeshError, MESH_ERRORS } from './errors.ts'
import { nowIso } from './fsx.ts'
import { TASK_TRANSITIONS } from './types.ts'
import type { MissionCard, MissionHistoryEntry, MissionStatus, TaskCard, TaskStatus } from './types.ts'

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (TASK_TRANSITIONS[from] ?? []).includes(to)
}

export class IllegalTransition extends MeshError {
  constructor(taskId: string, from: TaskStatus, to: TaskStatus) {
    super(MESH_ERRORS.TRANSITION_ILLEGAL, `illegal task transition ${from} → ${to} for ${taskId}`, {
      task_id: taskId,
      from,
      to,
      allowed: TASK_TRANSITIONS[from] ?? [],
    })
    this.name = 'IllegalTransition'
  }
}

export interface TransitionContext {
  by: string | null
  note?: string
}

/** Mutates the card in place and returns it. */
export function applyTransition(card: TaskCard, to: TaskStatus, ctx: TransitionContext): TaskCard {
  const from = card.status
  if (from === to) return card
  if (!canTransition(from, to)) throw new IllegalTransition(card.task_id, from, to)
  card.status = to
  card.updated_at = nowIso()
  const entry: { at: string; from: TaskStatus | null; to: TaskStatus; by: string | null; note?: string } = {
    at: card.updated_at,
    from,
    to,
    by: ctx.by,
  }
  if (ctx.note) entry.note = ctx.note
  card.history.push(entry)
  if (to === 'blocked' && ctx.note) card.blocked_reason = ctx.note
  if (to !== 'blocked' && to !== 'rejected') card.blocked_reason = null
  return card
}

export function setStatus(card: TaskCard, to: TaskStatus, ctx: TransitionContext): TaskCard {
  return applyTransition(card, to, ctx)
}

/** Statuses from which a task may still be worked on. */
export const OPEN_STATUSES: readonly TaskStatus[] = [
  'draft',
  'ready',
  'claimed',
  'in_progress',
  'submitted',
  'reviewing',
  'approved',
  'rejected',
  'blocked',
]

export function isOpen(card: TaskCard): boolean {
  return OPEN_STATUSES.includes(card.status)
}

/** Statuses a dependency must reach before a task becomes ready. */
export const SATISFIED_STATUSES: readonly TaskStatus[] = ['merged']

// ---------------------------------------------------------------------------
// Mission state machine (V2)
// ---------------------------------------------------------------------------

/**
 * The mission whitelist. Kept next to the task one on purpose: both are "the only
 * place a status may change", and reading them side by side is how you check that
 * V2 only added edges.
 *
 * Note on `rejected`: the spec's diagram draws the rework loop as
 * `final_review → integrating`. We keep rejection as a *first-class, observable*
 * status instead — `final_review → rejected → executing → integrating` — so a human
 * can see that the second acceptance failed, and so the rework loop is auditable.
 * Recorded in docs/DECISIONS-V2.md.
 */
export const MISSION_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = {
  intake: ['planning', 'blocked', 'cancelled'],
  planning: ['executing', 'blocked', 'cancelled'],
  executing: ['integrating', 'blocked', 'cancelled'],
  integrating: ['final_review', 'planning', 'blocked', 'cancelled'],
  final_review: ['completed', 'rejected', 'planning', 'blocked', 'cancelled'],
  rejected: ['executing', 'planning', 'blocked', 'cancelled'],
  blocked: ['planning', 'executing', 'integrating', 'final_review', 'cancelled'],
  completed: [],
  cancelled: [],
}

export function canMissionTransition(from: MissionStatus, to: MissionStatus): boolean {
  return (MISSION_TRANSITIONS[from] ?? []).includes(to)
}

export class IllegalMissionTransition extends MeshError {
  constructor(missionId: string, from: MissionStatus, to: MissionStatus) {
    super(MESH_ERRORS.TRANSITION_ILLEGAL, `illegal mission transition ${from} → ${to} for ${missionId}`, {
      mission_id: missionId,
      from,
      to,
      allowed: MISSION_TRANSITIONS[from] ?? [],
    })
    this.name = 'IllegalMissionTransition'
  }
}

/** Mutates the mission card in place and returns it. */
export function applyMissionTransition(
  card: MissionCard,
  to: MissionStatus,
  ctx: { by: string | null; note?: string },
): MissionCard {
  const from = card.status
  if (from === to) return card
  if (!canMissionTransition(from, to)) throw new IllegalMissionTransition(card.mission_id, from, to)
  card.status = to
  card.updated_at = nowIso()
  const entry: MissionHistoryEntry = { at: card.updated_at, from, to, by: ctx.by }
  if (ctx.note) entry.note = ctx.note
  card.history.push(entry)
  return card
}

/** Statuses in which a mission still expects work. */
export const MISSION_OPEN_STATUSES: readonly MissionStatus[] = [
  'intake',
  'planning',
  'executing',
  'integrating',
  'final_review',
  'rejected',
  'blocked',
]
