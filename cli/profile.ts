/**
 * `mesh profile …` — the human's hands on the judgement layer (V2 §2.1).
 *
 * Nine dimensions, exact labels from the spec. Everything here is a *manual* edit:
 * it sets `manual_locked`, which is what stops peer ratings from overwriting the
 * quality score afterwards.
 */

import { MeshError, MESH_ERRORS } from '../hub/core/errors.ts'
import { PROFILE_DIMENSIONS } from '../hub/core/profiles.ts'
import type { ProfileField } from '../hub/core/profiles.ts'
import type { Hub } from '../hub/core/hub.ts'
import {
  bool,
  num,
  printJson,
  sessionIdFrom,
  statusBadge,
  str,
  style,
  table,
} from './common.ts'
import type { ParsedArgs } from './common.ts'

function short(text: string, width = 22): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat || '—'
}

/** `mesh profile` with no args == `mesh profile list`. */
export function cmdProfile(parsed: ParsedArgs, hub: Hub): number {
  const sub = parsed.positionals[0] ?? 'list'
  switch (sub) {
    case 'list':
      return profileList(parsed, hub)
    case 'show':
      return profileShow(parsed, hub)
    case 'get':
      return profileGet(parsed, hub)
    case 'set':
      return profileSet(parsed, hub)
    case 'backfill':
      return profileBackfill(parsed, hub)
    default:
      throw new MeshError(
        MESH_ERRORS.SCHEMA_INVALID,
        `unknown profile subcommand: ${sub} (list | show <agent> | get <agent> <field> | set <agent> <field> <value> | backfill)`,
      )
  }
}

function profileList(parsed: ParsedArgs, hub: Hub): number {
  const profiles = hub.profiles.list()
  if (bool(parsed, 'json')) {
    printJson(profiles)
    return 0
  }
  const rows = profiles.map((p) => {
    const agent = hub.store.requireAgent(p.agent_id)
    const rate = hub.profiles.successRate(p.agent_id)
    return [
      p.agent_id,
      agent.enabled ? statusBadge('ready') : style.dim('off'),
      p.manual_locked ? style.yellow('手编') : style.dim('互评'),
      String(p.quality_score),
      String(p.cost_tier),
      String(p.reliability),
      rate === null ? '—' : `${rate}%`,
      short(p.strengths.join('、')),
    ]
  })
  process.stdout.write(
    `${table(['Agent', '状态', '来源', '质量分', '花费', '可靠性', '成功率', '擅长'], rows)}\n`,
  )
  process.stdout.write(
    `${style.dim(`共 ${profiles.length} 份 profile · 手编过的不会被互评覆盖 · mesh profile show <agent> 看九个维度`)}\n`,
  )
  return 0
}

function profileShow(parsed: ParsedArgs, hub: Hub): number {
  const agentId = parsed.positionals[1]
  if (!agentId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh profile show <agent_id>')
  const agent = hub.store.requireAgent(agentId)
  const profile = hub.profiles.view(agentId)
  if (bool(parsed, 'json')) {
    printJson({ ...profile, dimensions: hub.profiles.dimensionValues(agentId) })
    return 0
  }
  process.stdout.write(`${style.bold(agentId)}  ${agent.display_name}  ${style.dim(agent.kind)}\n\n`)
  // The nine dimension labels are fixed by the spec — do not rename them.
  for (const { label, value } of hub.profiles.dimensionValues(agentId)) {
    process.stdout.write(`  ${style.dim(label.padEnd(4, '　'))}  ${value || style.dim('—')}\n`)
  }
  const rate = hub.profiles.successRate(agentId)
  process.stdout.write(
    `\n  ${style.dim('战绩')}  任务 ${profile.stats.tasks} · 通过 ${profile.stats.approved} ·` +
      ` 打回 ${profile.stats.rejected} · mission ${profile.stats.missions} · 轮次 ${profile.stats.rounds}` +
      `${rate === null ? '' : ` · 成功率 ${rate}%`}\n`,
  )
  process.stdout.write(
    `  ${style.dim('锁定')}  ${profile.manual_locked ? style.yellow('人工手编（互评不覆盖质量分）') : '否（接受互评）'}\n`,
  )
  if (profile.peer_reviews.length > 0) {
    process.stdout.write(`\n  ${style.bold('互评')}\n`)
    for (const r of profile.peer_reviews.slice(-6)) {
      const s = r.scores
      process.stdout.write(
        `    ${r.at.slice(0, 10)} ${r.by_agent.padEnd(12)} ${r.mission_id}  ` +
          `质量 ${s.quality} / 配合 ${s.cooperation} / 证据 ${s.evidence} / 速度 ${s.speed}\n`,
      )
      if (r.comment) process.stdout.write(`      ${style.dim(r.comment)}\n`)
    }
  } else {
    process.stdout.write(`\n  ${style.dim('还没有互评。同一 mission 里一起干过活的 agent 可以 rate_peer。')}\n`)
  }
  return 0
}

function profileGet(parsed: ParsedArgs, hub: Hub): number {
  const agentId = parsed.positionals[1]
  const field = parsed.positionals[2] as ProfileField | undefined
  if (!agentId) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'usage: mesh profile get <agent_id> [field]')
  const profile = hub.profiles.view(agentId)
  if (!field) {
    printJson(profile)
    return 0
  }
  const known = [...PROFILE_DIMENSIONS.map((d) => d.key), 'manual_locked', 'stats', 'peer_reviews']
  if (!known.includes(field)) {
    throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `unknown field: ${field}`, { allowed: known })
  }
  const value = profile[field as keyof typeof profile]
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
  return 0
}

function profileSet(parsed: ParsedArgs, hub: Hub): number {
  const agentId = parsed.positionals[1]
  const field = parsed.positionals[2] as ProfileField | undefined
  const value = parsed.positionals.slice(3).join(' ')
  if (!agentId || !field) {
    throw new MeshError(
      MESH_ERRORS.SCHEMA_INVALID,
      'usage: mesh profile set <agent_id> <field> <value>\n' +
        `fields: ${[...PROFILE_DIMENSIONS.map((d) => d.key), 'manual_locked'].join(' | ')}`,
    )
  }
  if (!value) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `missing value for ${field}`)
  const profile = hub.profiles.set(agentId, field, value, 'mesh-human')
  const shown = profile[field as keyof typeof profile]
  process.stdout.write(
    `${style.green('✔')} ${agentId}.${field} = ${typeof shown === 'string' ? shown : JSON.stringify(shown)}\n`,
  )
  process.stdout.write(
    `  ${style.dim(`manual_locked=${profile.manual_locked} · 下一次派发按新分数排序（mesh profile show ${agentId}）`)}\n`,
  )
  return 0
}

function profileBackfill(parsed: ParsedArgs, hub: Hub): number {
  const created = hub.profiles.backfill()
  process.stdout.write(`${style.green('✔')} 补齐 ${created} 份 profile（已有 ${hub.store.listProfiles().length} 份）\n`)
  void parsed
  return 0
}

/**
 * `mesh rate-peer` — the CLI mirror of the `rate_peer` tool.
 *
 * The rater is the session, never a flag: attribution is the whole point of a review.
 */
export function cmdRatePeer(parsed: ParsedArgs, hub: Hub): number {
  const target = parsed.positionals[0]
  const missionId = str(parsed, 'mission')
  if (!target || !missionId) {
    throw new MeshError(
      MESH_ERRORS.SCHEMA_INVALID,
      'usage: mesh rate-peer <agent_id> --mission <M-000001> --quality 90 --cooperation 85 --evidence 95 --speed 70 [--comment "…"]',
    )
  }
  const scores = {
    quality: num(parsed, 'quality') ?? -1,
    cooperation: num(parsed, 'cooperation') ?? -1,
    evidence: num(parsed, 'evidence') ?? -1,
    speed: num(parsed, 'speed') ?? -1,
  }
  const missing = Object.entries(scores).filter(([, v]) => v < 0).map(([k]) => `--${k}`)
  if (missing.length > 0) {
    throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `missing scores: ${missing.join(', ')} (each 0-100)`)
  }
  const session = sessionIdFrom(parsed)
  const identity = hub.identity.requireIdentity(session)
  const result = hub.profiles.ratePeer({
    by_agent: identity.agent.agent_id,
    agent_id: target,
    mission_id: missionId,
    task_id: str(parsed, 'task') ?? null,
    scores,
    comment: str(parsed, 'comment') ?? '',
  })
  process.stdout.write(
    `${style.green('✔')} ${identity.agent.agent_id} 评了 ${target}（${missionId}）` +
      `${result.overwritten ? style.dim(' · 覆盖上一版') : ''}\n`,
  )
  process.stdout.write(
    `  quality ${result.quality_before} → ${result.quality_after}${result.applied ? '' : style.dim('（人工锁定，分数未改）')}\n`,
  )
  return 0
}
