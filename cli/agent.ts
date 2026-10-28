/**
 * Agent-facing commands: the file-protocol mirror of `hub.*`.
 *
 * These are what a spawned agent calls from its shell when MCP is unavailable (or
 * when the CLI is simply the easier interface). Same HubApi, same permission
 * checks, same refusals — the transport differs, the platform does not.
 */

import fs from 'node:fs'
import path from 'node:path'
import { HubApi } from '../hub/core/api.ts'
import { MeshError, MESH_ERRORS } from '../hub/core/errors.ts'
import { isRoleId } from '../hub/roles/cards.ts'
import type { Hub } from '../hub/core/hub.ts'
import type { ApiResult } from '../hub/core/api.ts'
import { bool, num, printJson, relativeTime, sessionIdFrom, statusBadge, str, style, table } from './common.ts'
import type { ParsedArgs } from './common.ts'

export const AGENT_COMMANDS = [
  'hello',
  'whoami',
  'heartbeat',
  'claim',
  'context',
  'progress',
  'ask',
  'escalate',
  'submit',
  'messages',
  'wait',
  'send',
  'put',
  'get',
  'artifacts',
  'getfile',
  'board',
  'decision',
] as const

function unwrap(result: ApiResult): unknown {
  if (!result.ok) {
    const e = result.error!
    throw new MeshError(e.code as never, e.message, e.detail)
  }
  return result.data
}

function requirePositional(parsed: ParsedArgs, index: number, name: string): string {
  const value = parsed.positionals[index]
  if (!value) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `missing argument: ${name}`, { argument: name })
  return value
}

export async function runAgentCommand(parsed: ParsedArgs, hub: Hub): Promise<number> {
  const api = new HubApi(hub)
  const json = bool(parsed, 'json')

  switch (parsed.command) {
    case 'hello': {
      const session = sessionIdFrom(parsed)
      const data = unwrap(api.hello(session)) as { role_card: string; session: string; role: string; task: string | null; flushed_messages: number }
      if (json) {
        printJson(data)
        return 0
      }
      process.stdout.write(`${data.role_card}\n`)
      if (data.flushed_messages > 0) {
        process.stdout.write(`\n${style.cyan(`↳ 有 ${data.flushed_messages} 条排队消息已投递到收件箱`)}\n`)
      }
      return 0
    }
    case 'whoami': {
      const data = unwrap(api.whoami(sessionIdFrom(parsed))) as Record<string, unknown>
      if (json) {
        printJson(data)
        return 0
      }
      process.stdout.write(
        [
          `${style.bold('session')}  ${data['session']}`,
          `${style.bold('agent')}    ${data['agent']}`,
          `${style.bold('role')}     ${data['role']}`,
          `${style.bold('task')}     ${data['task'] ?? '-'}`,
          `${style.bold('sandbox')}  ${data['sandbox'] ?? '-'}`,
          `${style.bold('deadline')} ${data['deadline']}`,
          '',
        ].join('\n'),
      )
      return 0
    }
    case 'heartbeat': {
      unwrap(api.heartbeat(sessionIdFrom(parsed)))
      process.stdout.write(`${style.green('✔')} lease extended\n`)
      return 0
    }
    case 'claim': {
      const taskId = requirePositional(parsed, 0, 'task_id')
      const level = str(parsed, 'level') as never
      const data = unwrap(api.claim_task(sessionIdFrom(parsed), taskId, level ? { contextLevel: level } : {})) as Record<string, unknown>
      if (json) {
        printJson(data)
        return 0
      }
      process.stdout.write(
        [
          `${style.green('✔')} 已领取 ${data['task_id']}`,
          `  branch    ${data['branch']}`,
          `  worktree  ${data['worktree']}`,
          `  context   ${data['context_package']}`,
          '',
          `${style.dim(String(data['reminder']))}`,
          '',
        ].join('\n'),
      )
      return 0
    }
    case 'context': {
      const taskId = requirePositional(parsed, 0, 'task_id')
      const level = (str(parsed, 'level') ?? 'standard') as never
      const data = unwrap(api.get_context(sessionIdFrom(parsed), taskId, level)) as { path: string; markdown: string }
      if (bool(parsed, 'print')) process.stdout.write(data.markdown)
      else process.stdout.write(`${style.green('✔')} ${data.path}\n`)
      return 0
    }
    case 'progress': {
      const taskId = requirePositional(parsed, 0, 'task_id')
      const pct = num(parsed, 'pct') ?? 50
      unwrap(api.report_progress(sessionIdFrom(parsed), taskId, pct, str(parsed, 'blockers')))
      process.stdout.write(`${style.green('✔')} ${taskId} ${pct}%\n`)
      return 0
    }
    case 'ask': {
      const taskId = requirePositional(parsed, 0, 'task_id')
      const question = parsed.positionals.slice(1).join(' ') || str(parsed, 'q')
      if (!question) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'missing question text')
      const data = unwrap(api.request_clarification(sessionIdFrom(parsed), taskId, question)) as Record<string, unknown>
      process.stdout.write(`${style.green('✔')} 已提问 ${String(data['msg_id'])}\n`)
      return 0
    }
    case 'escalate': {
      const reason = parsed.positionals.join(' ') || str(parsed, 'reason')
      if (!reason) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'missing escalation reason')
      const data = unwrap(
        api.escalate(sessionIdFrom(parsed), reason, str(parsed, 'task'), { block: bool(parsed, 'block') }),
      ) as Record<string, unknown>
      process.stdout.write(
        `${style.yellow('▲')} 已升级 ${String(data['msg_id'])}${data['task_blocked'] ? '（任务已 blocked，等仲裁）' : '（仅上报，继续干活）'}\n`,
      )
      return 0
    }
    case 'submit': {
      const taskId = requirePositional(parsed, 0, 'task_id')
      const summary = str(parsed, 'summary') ?? parsed.positionals.slice(1).join(' ')
      if (!summary) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'missing --summary')
      const data = unwrap(api.submit(sessionIdFrom(parsed), taskId, summary)) as Record<string, unknown>
      if (json) {
        printJson(data)
        return 0
      }
      process.stdout.write(`${style.green('✔')} ${taskId} 已提交（${String(data['commit']).slice(0, 8)}）\n`)
      process.stdout.write(`  files  ${(data['files'] as string[]).join(', ')}\n`)
      process.stdout.write(`  scope  ${data['scope_clean'] ? style.green('clean') : style.red(`越界: ${(data['out_of_scope'] as string[]).join(', ')}`)}\n`)
      for (const w of (data['warnings'] as string[]) ?? []) process.stdout.write(`  ${style.yellow('!')} ${w}\n`)
      process.stdout.write(`\n${style.dim(String(data['next']))}\n`)
      return 0
    }
    case 'messages': {
      const data = unwrap(api.read_messages(sessionIdFrom(parsed), str(parsed, 'since'))) as {
        count: number
        messages: Array<Record<string, unknown>>
      }
      if (json) {
        printJson(data)
        return 0
      }
      if (data.count === 0) {
        process.stdout.write(`${style.dim('收件箱是空的')}\n`)
        return 0
      }
      for (const m of data.messages) {
        process.stdout.write(`${style.magenta(String(m['type']))} ${style.dim(`${String(m['from'])} · ${String(m['thread'])} · ${relativeTime(String(m['created_at']))}`)}\n`)
        process.stdout.write(`${String(m['body'])}\n`)
        const attachments = m['attachments'] as Array<Record<string, unknown>>
        for (const a of attachments) process.stdout.write(`  ${style.dim(`📎 ${String(a['path'])} (${String(a['bytes'])}B)`)}\n`)
        process.stdout.write('\n')
      }
      return 0
    }
    case 'wait': {
      const timeout = num(parsed, 'timeout') ?? 20_000
      const data = unwrap(await api.wait_messages(sessionIdFrom(parsed), timeout, str(parsed, 'since'))) as {
        count: number
        messages: Array<Record<string, unknown>>
      }
      if (json) {
        printJson(data)
        return 0
      }
      if (data.count === 0) {
        process.stdout.write(`${style.dim('（超时，没有新消息）')}\n`)
        return 0
      }
      for (const m of data.messages) {
        process.stdout.write(`${style.magenta(String(m['type']))} ${style.dim(String(m['from']))}\n${String(m['body'])}\n\n`)
      }
      return 0
    }
    case 'send': {
      const to = str(parsed, 'to')
      if (!to) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'missing --to role:thread (e.g. coordinator:* )')
      const [role, thread = '*'] = to.split(':')
      if (!role || !isRoleId(role)) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, `unknown role in --to: ${String(role)}`)
      const type = str(parsed, 'type') ?? 'board.update'
      const body = str(parsed, 'body') ?? parsed.positionals.join(' ')
      if (!body) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'missing message body')
      const data = unwrap(api.send(sessionIdFrom(parsed), { role, thread }, type as never, body, num(parsed, 'ttl'))) as Record<string, unknown>
      process.stdout.write(`${style.green('✔')} ${String(data['msg_id'])} → ${role}:${thread}\n`)
      return 0
    }
    case 'put': {
      const relpath = requirePositional(parsed, 0, 'path')
      const file = str(parsed, 'file')
      const content = file ? fs.readFileSync(path.resolve(file), 'utf8') : str(parsed, 'content')
      if (content === undefined) throw new MeshError(MESH_ERRORS.SCHEMA_INVALID, 'missing --file or --content')
      const data = unwrap(api.put_artifact(sessionIdFrom(parsed), relpath, content, str(parsed, 'task'))) as Record<string, unknown>
      process.stdout.write(`${style.green('✔')} ${String(data['path'])} (${String(data['bytes'])}B, sha ${String(data['sha256']).slice(0, 8)})\n`)
      return 0
    }
    case 'get': {
      const relpath = requirePositional(parsed, 0, 'path')
      const data = unwrap(api.get_artifact(sessionIdFrom(parsed), relpath)) as { content: string }
      process.stdout.write(data.content)
      return 0
    }
    case 'decision': {
      // `mesh decision "…"` appends to the platform decision log; with no text it
      // prints the log, which is the first thing a coordinator turn wants to read.
      const text = parsed.positionals.join(' ') || str(parsed, 'text')
      if (!text) {
        const data = unwrap(api.get_decisions(sessionIdFrom(parsed))) as { markdown: string }
        process.stdout.write(data.markdown || `${style.dim('（决策日志还是空的）')}\n`)
        return 0
      }
      const data = unwrap(api.append_decision(sessionIdFrom(parsed), text, str(parsed, 'title'))) as Record<string, unknown>
      process.stdout.write(`${style.green('✔')} 已记入 ${String(data['path'])}（${String(data['bytes'])}B）\n`)
      return 0
    }
    case 'artifacts': {
      const data = unwrap(api.list_artifacts(sessionIdFrom(parsed))) as { artifacts: string[] }
      if (json) {
        printJson(data)
        return 0
      }
      for (const a of data.artifacts) process.stdout.write(`${a}\n`)
      if (data.artifacts.length === 0) process.stdout.write(`${style.dim('（还没有工件）')}\n`)
      return 0
    }
    case 'getfile': {
      const relpath = requirePositional(parsed, 0, 'path')
      const data = unwrap(api.get_file(sessionIdFrom(parsed), relpath)) as { content: string }
      process.stdout.write(data.content)
      return 0
    }
    default:
      throw new MeshError(MESH_ERRORS.INTERNAL, `unhandled agent command: ${parsed.command}`)
  }
}

/** `mesh board` exists in both worlds; agents get the role-filtered view. */
export async function runAgentBoard(parsed: ParsedArgs, hub: Hub): Promise<void> {
  const api = new HubApi(hub)
  const data = unwrap(
    api.get_board(sessionIdFrom(parsed), {
      status: str(parsed, 'status') as never,
      role: str(parsed, 'role') as never,
    }),
  ) as { tasks: Array<Record<string, unknown>>; counts: Record<string, number> }
  const rows = data.tasks.map((t) => [
    String(t['task_id']),
    statusBadge(String(t['status'])),
    String(t['role']),
    String(t['title']).slice(0, 48),
    t['claimed_by'] ? String(t['claimed_by']) : style.dim('-'),
  ])
  process.stdout.write(`${table(['任务', '状态', '角色', '标题', '会话'], rows)}\n`)
}
