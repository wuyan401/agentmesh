/**
 * Context package generation (§7.4): default minimal, self-expandable.
 *
 * The Hub hands a Worker exactly what it needs for one task — the task card, its
 * own role card, the current state of the paths in scope, digests of the work it
 * depends on, and the protocol. It deliberately does *not* hand over the global
 * plan or the whole repository structure. That is a default, not a prohibition:
 * an agent may explore the repo with its own tools whenever it needs to (C4).
 * The thing that stops over-reach is the verdict, not information starvation.
 */

import fs from 'node:fs'
import path from 'node:path'
import { matchAnyGlob, normRel } from './fsx.ts'
import { PROTOCOL_QUICKREF } from './protocol.ts'
import { renderRoleCard } from '../roles/cards.ts'
import { buildTeammates, missionOfTask, renderTeammateTable } from './teammates.ts'
import type { MeshStore } from './store.ts'
import type { RoleId, TaskCard } from './types.ts'

export type ContextLevel = 'minimal' | 'standard' | 'full'

export interface ContextInput {
  taskId: string
  level?: ContextLevel
  sessionId?: string | null
}

const MAX_SCOPE_FILE_BYTES = 12 * 1024
const MAX_SCOPE_FILES = 24

export class ContextBuilder {
  readonly store: MeshStore

  constructor(store: MeshStore) {
    this.store = store
  }

  /** The world an agent wakes up in. Absolute paths matter: the agent's cwd is the sandbox. */
  renderIdentityBlock(task: TaskCard, role: RoleId, sessionId: string | null): string {
    const worktreeAbs = task.worktree ? path.resolve(this.store.paths.root, task.worktree) : this.store.paths.root
    const lines: string[] = []
    lines.push('## 你现在的世界')
    lines.push('')
    lines.push(`- 任务：${task.task_id} ${task.title}`)
    lines.push(`- 角色：${role}`)
    if (sessionId) lines.push(`- 会话：${sessionId}（调用 hub.hello() 换取你的正式身份）`)
    lines.push(`- 工作目录（你的沙箱）：${worktreeAbs}`)
    lines.push(`- 任务分支：${task.branch}${task.base_commit ? `（base ${task.base_commit.slice(0, 8)}）` : ''}`)
    lines.push('- 你的工具：全部原生工具，平台不做任何限制。')
    lines.push('- 交付路径：commit 到本分支 → hub.submit(task_id, summary) → 审查 → 合并终审。')
    lines.push('')
    lines.push(`允许写入（scope.write）：${task.scope.write.join(', ')}`)
    if (task.scope.read.length > 0) lines.push(`建议参考（scope.read）：${task.scope.read.join(', ')}`)
    lines.push('')
    lines.push('> scope 之外的改动不会进入主分支。这是代码保证，不是提醒。')
    return lines.join('\n')
  }

  renderTaskCard(task: TaskCard): string {
    const lines: string[] = []
    lines.push(`## 任务卡 ${task.task_id}`)
    lines.push('')
    lines.push(`**${task.title}**`)
    lines.push('')
    lines.push(`- 角色：${task.role}`)
    lines.push(`- 状态：${task.status}`)
    lines.push(`- 依赖：${task.depends_on.length > 0 ? task.depends_on.join(', ') : '（无）'}`)
    lines.push(`- 预估：${task.estimate}`)
    if (task.parent) lines.push(`- 父任务：${task.parent}`)
    if (task.tags.length > 0) lines.push(`- 标签：${task.tags.join(', ')}`)
    lines.push('')
    lines.push('### 验收标准（Supervisor 裁决的唯一依据）')
    lines.push('')
    task.acceptance.forEach((a, i) => lines.push(`${i + 1}. ${a}`))
    lines.push('')
    lines.push('### scope')
    lines.push('')
    lines.push('```')
    lines.push('write:')
    for (const w of task.scope.write) lines.push(`  - ${w}`)
    lines.push('read:')
    for (const r of task.scope.read) lines.push(`  - ${r}`)
    lines.push('```')
    return lines.join('\n')
  }

  private currentScopeSnapshot(task: TaskCard): string {
    const worktree = task.worktree ? path.resolve(this.store.paths.root, task.worktree) : this.store.paths.root
    const lines: string[] = []
    lines.push('## scope 内文件的当前版本')
    lines.push('')
    let included = 0
    for (const glob of task.scope.write) {
      const candidates = this.listMatching(worktree, glob)
      if (candidates.length === 0) {
        lines.push(`- \`${glob}\` — 尚不存在（你要创建它）`)
        continue
      }
      for (const rel of candidates.slice(0, MAX_SCOPE_FILES - included)) {
        const abs = path.join(worktree, rel.split('/').join(path.sep))
        let content = ''
        try {
          const stat = fs.statSync(abs)
          if (stat.size > MAX_SCOPE_FILE_BYTES) {
            lines.push(`- \`${rel}\` — ${stat.size} bytes（过大，未内联；自行读取）`)
            continue
          }
          content = fs.readFileSync(abs, 'utf8')
        } catch {
          continue
        }
        included++
        lines.push(`### ${rel}`)
        lines.push('')
        lines.push('```')
        lines.push(content.replace(/```/g, '``\u200b`'))
        lines.push('```')
        lines.push('')
      }
      if (included >= MAX_SCOPE_FILES) {
        lines.push(`- （已达内联上限 ${MAX_SCOPE_FILES} 个文件，其余自行读取）`)
        break
      }
    }
    return lines.join('\n')
  }

  /** Cheap directory walk that honours the glob's static prefix. */
  private listMatching(base: string, glob: string): string[] {
    const prefix = glob.split('*')[0] ?? ''
    const searchBase = prefix.includes('/') ? path.join(base, prefix.slice(0, prefix.lastIndexOf('/') + 1)) : base
    const out: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 8 || out.length > 200) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.mesh') continue
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(abs, depth + 1)
        else {
          const rel = normRel(path.relative(base, abs))
          if (matchAnyGlob([glob], rel)) out.push(rel)
        }
      }
    }
    walk(searchBase, 0)
    return out.sort()
  }

  private dependencyDigests(task: TaskCard): string {
    const lines: string[] = []
    if (task.depends_on.length === 0) return ''
    lines.push('## 上游任务的产出')
    lines.push('')
    for (const depId of task.depends_on) {
      const dep = this.store.getTask(depId)
      if (!dep) {
        lines.push(`- ${depId}：未知任务`)
        continue
      }
      lines.push(`### ${depId} ${dep.title}（${dep.status}）`)
      if (dep.submission) {
        lines.push('')
        lines.push(`提交摘要：${dep.submission.summary}`)
        lines.push('')
        lines.push(`改动文件：${dep.submission.files.slice(0, 40).join(', ')}`)
      } else {
        lines.push('')
        lines.push('（尚未提交）')
      }
      lines.push('')
    }
    return lines.join('\n')
  }

  private projectTree(): string {
    const lines: string[] = ['## 项目结构（顶层为主）', '', '```']
    const walk = (dir: string, prefix: string, depth: number): void => {
      if (depth > 3) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      const filtered = entries
        .filter((e) => !['node_modules', '.git', '.mesh', 'dist', 'build', 'coverage'].includes(e.name))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .slice(0, 40)
      for (const entry of filtered) {
        lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`)
        if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}  `, depth + 1)
      }
    }
    walk(this.store.paths.root, '', 0)
    lines.push('```')
    return lines.join('\n')
  }

  /**
   * §3.1 — where you are, and who else is here.
   *
   * `minimal` carries only the compact form of "你在哪"; `standard`/`full` get the
   * full block plus the teammate table. A card with no mission degrades to the
   * compact form on every level: inventing a mission for it would be a lie.
   */
  renderMissionSection(task: TaskCard, sessionId: string | null, level: ContextLevel): string {
    const mission = missionOfTask(this.store, task.task_id)
    const session = sessionId ? this.store.getSession(sessionId) : null
    const viewer = session?.agent_id ?? task.implementer_agent ?? null
    const role = session?.role ?? task.role
    const lines: string[] = []

    const completion = '你 submit → 一个独立审查者通过 → 平台 scope 终审合并'

    if (!mission || level === 'minimal') {
      lines.push('## 你在哪（紧凑）')
      lines.push('')
      if (mission) {
        const index = mission.tasks.indexOf(task.task_id) + 1
        lines.push(
          `- Mission：${mission.mission_id}「${mission.title}」，你是第 ${index}/${mission.tasks.length} 个执行者；lead 是 ${mission.lead_agent}`,
        )
      } else {
        lines.push('- 本卡不属于任何 mission（独立任务卡），没有 lead，也没有队友表')
      }
      lines.push(`- 你这一环：${task.task_id}「${task.title}」，角色 ${role}`)
      lines.push(`- 完成定义：${completion}`)
      return lines.join('\n')
    }

    const index = mission.tasks.indexOf(task.task_id) + 1
    lines.push('## 你在哪')
    lines.push('')
    lines.push(`- Mission：${mission.mission_id}「${mission.title}」（你是第 ${index}/${mission.tasks.length} 个执行者）`)
    lines.push(`- Lead：${mission.lead_agent} —— 它拆的任务，最后由它整合、二次验收并给用户报告`)
    lines.push(`- 你这一环：${task.task_id}「${task.title}」，角色 ${role}`)
    lines.push(`- 完成定义：${completion}`)
    if (mission.acceptance.length > 0) {
      lines.push(`- Mission 级验收（决定整体算不算完成）：${mission.acceptance.map((a, i) => `${i + 1}) ${a}`).join(' ')}`)
    }

    const rows = buildTeammates(this.store, mission.mission_id)
    lines.push('')
    lines.push(renderTeammateTable(rows, { mission, viewerAgent: viewer }))
    return lines.join('\n')
  }

  /** §3.2 — the platform how-to, short enough to actually be read. */
  renderPlatformSection(role: RoleId): string {
    const lines: string[] = []
    lines.push('## 这个平台怎么用（速查）')
    lines.push('')
    lines.push('- 你现在在一个 P-Session：cwd 是任务沙箱，身份是 S-xxxxxx，角色是 ' + role + '。')
    lines.push('- 领活 `hub.claim_task(task_id)`；交付 `git commit` + `hub.submit(task_id, summary)`。')
    lines.push('- 只写 scope.write 内的路径；越界会在合并终审被整单打回。')
    lines.push('- 有疑问 `hub.request_clarification`；要越界 `hub.escalate`（不中断你）。')
    lines.push('- 不知道队友是谁：`hub.list_teammates(mission_id)`，不要猜。')
    lines.push(
      '- 交付或审查结束后给同 mission 的队友打分：`hub.rate_peer(agent_id, mission_id, { quality, cooperation, evidence, speed })`——每项 0-100，一人一 mission 一次（重评覆盖）。同 mission 指的是你参与过的那个，别评没合作过的人。',
    )
    lines.push('- 你是 lead 时额外可用：`plan_mission` / `dispatch_mission` / `final_verdict` / `write_report`。')
    return lines.join('\n')
  }

  build(input: ContextInput): { markdown: string; level: ContextLevel; path: string } {
    const task = this.store.requireTask(input.taskId)
    const level: ContextLevel = input.level ?? 'standard'
    const parts: string[] = []

    parts.push(`# 上下文包 ${task.task_id} · ${task.title}`)
    parts.push('')
    parts.push(`生成时间：${new Date().toISOString()}`)
    parts.push(`会话：${input.sessionId ?? '（尚未绑定）'}`)
    parts.push('')
    // §3.1 goes high on purpose: an agent that only reads the first screen must still
    // learn where it is and who it is working with.
    parts.push(this.renderMissionSection(task, input.sessionId ?? null, level))
    parts.push('')
    parts.push('---')
    parts.push('')
    parts.push(PROTOCOL_QUICKREF)
    parts.push('')
    parts.push('---')
    parts.push('')
    parts.push(this.renderIdentityBlock(task, task.role, input.sessionId ?? null))
    parts.push('')
    parts.push('---')
    parts.push('')
    parts.push(renderRoleCard(task.role))

    if (level === 'standard' || level === 'full') {
      parts.push('')
      parts.push('---')
      parts.push('')
      parts.push(this.renderPlatformSection(task.role))
    }

    parts.push('')
    parts.push('---')
    parts.push('')
    parts.push(this.renderTaskCard(task))

    if (level === 'standard' || level === 'full') {
      const deps = this.dependencyDigests(task)
      if (deps) {
        parts.push('')
        parts.push('---')
        parts.push('')
        parts.push(deps)
      }
      parts.push('')
      parts.push('---')
      parts.push('')
      parts.push(this.currentScopeSnapshot(task))
    }

    if (level === 'full') {
      parts.push('')
      parts.push('---')
      parts.push('')
      parts.push(this.projectTree())
      const artifacts = this.store.listArtifacts().slice(0, 30)
      if (artifacts.length > 0) {
        parts.push('')
        parts.push('## 已入库工件（hub.get_artifact 可取）')
        parts.push('')
        for (const a of artifacts) parts.push(`- \`${a}\``)
      }
    }

    const markdown = `${parts.join('\n')}\n`
    const file = this.store.paths.contextFile(task.task_id)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, markdown)
    return { markdown, level, path: this.store.paths.rel(file) }
  }
}
