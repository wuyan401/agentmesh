/**
 * Spawn-prompt composition.
 *
 * The prompt is the platform's *first* injection of identity; `hub.hello()` is
 * the second. It carries the role card, the task card, the protocol quick
 * reference, the sandbox path and exactly one instruction about what to do next.
 *
 * Nothing here restricts a tool (C4). The only verbs are "read", "work", "commit",
 * "submit", "escalate".
 */

import path from 'node:path'
import { PROTOCOL_QUICKREF } from '../core/protocol.ts'
import { renderRoleCard } from '../roles/cards.ts'
import { meshCliPath } from '../adapters/types.ts'
import type { AgentCard, RoleId, SessionCard, TaskCard } from '../core/types.ts'
import type { MeshPaths } from '../core/paths.ts'

export interface PromptInput {
  paths: MeshPaths
  session: SessionCard
  agent: AgentCard
  role: RoleId
  task: TaskCard | null
  worktree: string
  /** MCP tool prefix visible to the agent, or null on the file protocol. */
  toolPrefix: string | null
  contextPath: string | null
  /** Recent thread history for daemon roles (coordinator continuity). */
  threadDigest?: string
  /** Human's message for `mesh talk` turns. */
  userMessage?: string
  /** Role-specific brief appended before the "start now" section. */
  extraSection?: string
}

function taskBlock(task: TaskCard, worktree: string): string {
  const lines: string[] = []
  lines.push(`## 你的任务 ${task.task_id}：${task.title}`)
  lines.push('')
  lines.push(`- 任务分支：${task.branch}（base ${(task.base_commit ?? '').slice(0, 8)}）`)
  lines.push(`- 沙箱目录：${worktree}`)
  lines.push(`- 允许写入：${task.scope.write.join(', ')}`)
  if (task.scope.read.length > 0) lines.push(`- 建议先读：${task.scope.read.join(', ')}`)
  lines.push('')
  lines.push('### 验收标准（Supervisor 逐条裁决，这就是"完成"的定义）')
  task.acceptance.forEach((a, i) => lines.push(`${i + 1}. ${a}`))
  return lines.join('\n')
}

function toolHint(agent: AgentCard, toolPrefix: string | null, meshCmd: string, sessionId: string): string {
  const lines: string[] = []
  lines.push('## 怎么和平台说话')
  if (toolPrefix) {
    lines.push('')
    lines.push(`你的 Hub 工具已经通过 MCP 注入，工具名形如 \`${toolPrefix}hello\`、\`${toolPrefix}claim_task\`。`)
    lines.push('第一步永远是调用 hello —— 在你调用它之前，这个会话在平台里没有任何身份。')
  } else {
    lines.push('')
    lines.push('你走文件协议：用你的 shell 工具执行下面这些命令即可（会话 id 已注入环境变量）：')
    lines.push('')
    lines.push('```bash')
    lines.push(`${meshCmd} hello                          # 第一步：注册身份`)
    lines.push(`${meshCmd} claim <task_id>                # 领任务`)
    lines.push(`${meshCmd} messages                       # 读收件箱`)
    lines.push(`${meshCmd} submit <task_id> --summary "…" # 提交审查`)
    lines.push('```')
    lines.push('')
    lines.push(`当前会话 id：${sessionId}（已在 MESH_SESSION_ID 里，命令会自动读取）`)
    lines.push(`收件箱原始文件：${'{MESH_MESH_DIR}'}/messages/inbox/<你的 agent id>/`)
  }
  return lines.join('\n')
}

export function buildPrompt(input: PromptInput): string {
  const { paths, session, agent, role, task, worktree, toolPrefix, contextPath } = input
  const meshCmd = `"${process.execPath}" "${meshCliPath()}"`
  const lines: string[] = []

  lines.push(`# AgentMesh 平台会话 ${session.session_id}`)
  lines.push('')
  lines.push(`你是 ${agent.display_name} 拉起的一个 P-Session。平台给了你三样东西：一个沙箱、一个角色、一套协作工具。`)
  lines.push(`你自己的工具一件都没少——Bash、读写、搜索、子 Agent、联网，全都可用。`)
  lines.push('')
  lines.push(PROTOCOL_QUICKREF)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(renderRoleCard(role))
  lines.push('')
  if (task) {
    lines.push('---')
    lines.push('')
    lines.push(taskBlock(task, worktree))
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push(toolHint(agent, toolPrefix, meshCmd, session.session_id))
  lines.push('')
  if (contextPath) {
    lines.push(`完整上下文包：\`${contextPath}\`（先读它，里面有 scope 内文件的当前版本和上游产出）`)
    lines.push('')
  }
  if (input.threadDigest) {
    lines.push('## 最近的任务线消息')
    lines.push('')
    lines.push(input.threadDigest)
    lines.push('')
  }
  if (input.userMessage) {
    lines.push('## 用户刚说的话')
    lines.push('')
    lines.push(input.userMessage)
    lines.push('')
  }
  if (input.extraSection) {
    lines.push(input.extraSection)
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push(startNow(role, task, worktree, contextPath))
  return lines.join('\n')
}

/** The one instruction each role needs to begin — different for a reviewer than for a builder. */
function startNow(role: RoleId, task: TaskCard | null, worktree: string, contextPath: string | null): string {
  const lines: string[] = ['## 现在开始', '']
  const hello = '1. 先注册身份（hello）。在它之前你在平台里没有任何身份。'
  if (!task) {
    lines.push(hello)
    lines.push('2. 读收件箱与看板，处理属于你这个角色的事。')
    lines.push('3. 做完就结束这一轮。')
    return lines.join('\n')
  }
  switch (role) {
    case 'supervisor':
      lines.push(hello)
      lines.push(`2. \`request_review("${task.task_id}")\` 开启审查（已是 reviewing 就跳过）。`)
      lines.push(`3. 在沙箱里读改动、跑你需要的检查：${worktree}`)
      lines.push(`4. \`verdict("${task.task_id}", "approved"|"rejected", criteria[], notes)\` —— criteria 逐条对应 acceptance，每条带证据。`)
      lines.push('')
      lines.push('你是审查者，不是实现者：不要改代码，不要提交。发现问题就 rejected 并写清返工要求。')
      return lines.join('\n')
    case 'integrator':
      lines.push(hello)
      lines.push(`2. 确认 review 已通过，然后 \`merge("${task.task_id}")\`。`)
      lines.push('3. 合并终审由 Hub 的代码执行；越界就拒绝，不要在沙箱里手工改主分支。')
      return lines.join('\n')
    case 'coordinator':
      lines.push(hello)
      lines.push('2. 读收件箱 → 查看板 → 处理升级。')
      lines.push('3. 需求要落地就建任务卡（create_task），不要自己实现。')
      return lines.join('\n')
    default:
      lines.push(hello)
      lines.push(`2. \`claim_task("${task.task_id}")\` 领取任务（调度器已代领时这一步是幂等的）。`)
      lines.push(`3. 读上下文包 \`${contextPath ?? '(claim 返回的路径)'}\`，然后在这个目录里干活：${worktree}`)
      lines.push('4. 只改 scope.write 内的文件；需要改别的，用 escalate 说明，不要顺手做掉。')
      lines.push(`5. \`git add -A && git commit -m "..."\` 到 ${task.branch}，然后 \`submit\` 提交审查。`)
      lines.push('')
      lines.push('做完就结束这一轮，不要问"还需要我做什么"。平台会安排下一步。')
      return lines.join('\n')
  }
}

/** Compose the short thread digest a daemon role gets for continuity. */
export function buildThreadDigest(
  messages: Array<{ created_at: string; from: { agent: string; role: string }; type: string; body: string }>,
  limit = 12,
): string {
  if (messages.length === 0) return ''
  const recent = messages.slice(-limit)
  const lines: string[] = []
  for (const m of recent) {
    const body = m.body.length > 400 ? `${m.body.slice(0, 400)}…` : m.body
    lines.push(`- [${m.created_at.slice(11, 19)}] ${m.from.agent}(${m.from.role}) · ${m.type}：${body.replace(/\n/g, ' ')}`)
  }
  return lines.join('\n')
}
