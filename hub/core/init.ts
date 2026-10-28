/**
 * `mesh init` — lay down a collaboration space in a project.
 *
 * Idempotent: re-running repairs missing pieces without touching board data. The
 * decisions log is written first and only once, because §18 says the trade-offs
 * recorded there are not to be re-litigated.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Git } from './git.ts'
import { MeshPaths } from './paths.ts'
import { MeshStore } from './store.ts'
import { nowIso, writeFileAtomic, writeJsonAtomic } from './fsx.ts'
import { DEFAULT_CONFIG, configFile, loadConfig, saveConfig } from './config.ts'
import { ROLE_CARDS, renderRoleCard } from '../roles/cards.ts'
import { PROTOCOL_QUICKREF } from './protocol.ts'
import { detectAgents, defaultDetectContext } from '../adapters/detect.ts'
import type { AgentCard, MeshState } from './types.ts'
import type { DetectedAgent } from '../adapters/detect.ts'

export interface InitOptions {
  root: string
  projectName?: string
  /** Register only agents that exist on this machine (default true). */
  detect?: boolean
  /** Make an initial empty commit when the repo has none (default true). */
  ensureCommit?: boolean
  probeRoots?: string[]
}

export interface InitResult {
  paths: MeshPaths
  created: boolean
  project: string
  mainBranch: string
  baseCommit: string | null
  agents: Array<{ agent_id: string; available: boolean; source: string }>
  notes: string[]
}

const DECISIONS_BODY = `# AgentMesh 决策日志

> 本文件是平台的"判例"。**已记录的取舍不得重新诉讼**（计划书 §18）。
> 新决策只能追加，不能改写历史条目。变更宪法条款（C1–C8）必须升级用户裁决。

## §18 关键取舍（计划书原样录入）

| 取舍 | 决定 | 理由 |
|---|---|---|
| 工具白名单 vs 全开放 | 全开放（C4） | 白名单制造绕开动机（子集悖论）；威胁源是越界写入而非工具使用；终审兜底 |
| 信息硬隔离 vs 默认最小 | 默认最小 + 可自主扩展 | 与工具开放逻辑上不可兼得；员工能看全公司代码 ≠ 会去干全公司的活 |
| 事前禁足 vs 事后裁决 | 事后裁决（合并终审） | 全工具下事前禁足不可实现；"写了不算数"比"不许写"更可靠 |
| agent=role vs 三元分离 | 三元 | 一 Agent 多角色是现实需求；权限随 Session 走保证安全 |
| 寻址到 Agent vs 角色线程 | 角色线程 | 角色换人不丢上下文，投递自动解析 |
| 强沙箱默认 vs 可选 | 可选档位 | 默认信任模型 = 环境默认 + 裁决兜底，同时覆盖合规频谱 |

## 实现层决策（v1 落地时补充，同样不再重新诉讼）

| 决策 | 内容 | 理由 |
|---|---|---|
| 存储格式 | 卡片用 JSON（非 YAML），CLI 渲染 YAML 风格视图 | 零依赖解析、严格校验、可 diff、崩溃安全；JSON 与计划书里的 YAML 示例语义等价 |
| 运行时依赖 | 运行时零第三方依赖（Node 内置 MCP stdio 实现） | 平台要在任意机器可靠启动；MCP 协议层只有帧格式与若干 method，手写更可控 |
| 内置 Agent | \`mesh-hub\` 作为 builtin Agent 承担 integrator / sentinel 角色 | 三元模型里 Agent 是物理实体；确定性内核本身就是实体。避免整条流水线因缺人而卡死，且合并仍走同一套终审代码 |
| 自动集成 | \`auto_integrate\` 默认开（可关） | 合并是确定性动作，不需要 LLM 参与；开启后 approved → merged 不需等待人工 |
| 自动审查 | \`auto_review\` 默认开 | submitted 后自动拉起独立 Supervisor；C7 由调度器与 hub.verdict 双重校验 |
| .mesh 忽略方式 | 写入 \`.git/info/exclude\`，不改 .gitignore | 不修改被跟踪文件，避免把平台元数据混进用户提交 |
| 上下文包 | 三档（minimal/standard/full），默认 standard | minimal 缺 scope 文件现状会诱发瞎猜，standard 是"够用且省 token"的平衡点 |
| 会话续跑 | 长驻角色按"回合"拉起，不依赖 provider 会话续跑 | coordinator 的连续性由平台自己的 message log 提供（可审计），不依赖 CLI 内部 session |

## 未决与红线

- \`capabilities\` 目前人工配置；自动探测是 M5 之后的研究项。
- 双模边界（C3）：平台不得以任何方式干预 D-Session，包括"善意的"自动注入。
- 任何一条宪法的改动都必须先升级用户，不得自行解释放宽。
`

function initialAgents(
  opts: InitOptions,
  paths: MeshPaths,
  notes: string[],
): { agents: AgentCard[]; detected: DetectedAgent[] } {
  if (opts.detect === false) {
    notes.push('agent auto-detection disabled; register agents manually with `mesh agents register`')
    return { agents: [], detected: [] }
  }
  const detected = detectAgents(defaultDetectContext(opts.probeRoots ?? [paths.root]))
  const agents: AgentCard[] = []
  for (const d of detected) {
    if (!d.available && d.card.kind !== 'builtin') {
      // Keep an unavailable recipe on disk but disabled, so the board explains why.
      agents.push(d.card)
      notes.push(`agent ${d.card.agent_id}: not available (${d.source}) — registered disabled`)
      continue
    }
    agents.push(d.card)
    if (d.available) notes.push(`agent ${d.card.agent_id}: ok (${d.source}${d.version ? `, ${d.version}` : ''})`)
  }
  return { agents, detected }
}

export function initMesh(opts: InitOptions): InitResult {
  const paths = new MeshPaths(opts.root)
  paths.assertProjectDir()
  const notes: string[] = []
  const created = !paths.isInitialized()

  const git = new Git(paths.root)
  if (!git.isRepo()) {
    git.run(['init', '-b', 'main'], { allowFailure: true })
    notes.push('initialised a new git repository')
  }
  const mainBranch = git.detectMainBranch()

  paths.ensureLayout()

  // -- state ---------------------------------------------------------------
  let state: MeshState
  if (created) {
    if (opts.ensureCommit !== false) git.ensureBaseCommit(mainBranch)
    const identity = git.ensureIdentity()
    if (identity.created) notes.push(`set repo-local git identity ${identity.name} <${identity.email}>`)
    state = {
      version: 1,
      project: opts.projectName ?? path.basename(paths.root),
      created_at: nowIso(),
      main_branch: mainBranch,
      base_commit: git.headSha(),
      counters: { task: 0, message: 0, session: 0, review: 0, violation: 0 },
      flags: { initialized: true },
    }
    writeJsonAtomic(paths.stateFile, state)
  } else {
    state = new MeshStore(paths).getState()
    notes.push('existing .mesh/ found; repaired missing files only')
  }

  // -- git hygiene ---------------------------------------------------------
  git.ignoreMeshDir()

  // -- role cards ----------------------------------------------------------
  for (const card of ROLE_CARDS.values()) {
    const file = paths.roleFile(card.role)
    const body = `---\nrole: ${card.role}\ntitle: ${card.title}\nlifespan: ${card.lifespan}\ncan_write_code: ${card.can_write_code}\ncan_implement: ${card.can_implement}\ncan_review: ${card.can_review}\ncan_merge: ${card.can_merge}\noutput_globs: [${card.output_globs.map((g) => `"${g}"`).join(', ')}]\n---\n\n${renderRoleCard(card.role)}\n`
    writeFileAtomic(file, body)
  }

  // -- config --------------------------------------------------------------
  if (!fs.existsSync(configFile(paths))) {
    const detected = initialAgents(opts, paths, notes)
    const coordinator = detected.agents.find((a) => a.enabled && a.capabilities.includes('coordinator'))
    saveConfig(paths, { ...DEFAULT_CONFIG, coordinator_agent: coordinator?.agent_id ?? null })
    writeFileAtomic(
      paths.resolve('agents', 'AGENTS.md'),
      [
        '# 本机 Agent 注册表',
        '',
        '本目录下的 *.json 是 AgentCard（物理实体 + 启动配方）。',
        '角色由 Session 绑定，Agent 只是「谁来做」的容器。',
        '',
        '用 `mesh agents list` 看，`mesh agents doctor` 体检。',
        '',
      ].join('\n'),
    )
  } else {
    loadConfig(paths)
  }

  const detected = initialAgents(opts, paths, [])
  for (const card of detected.agents) {
    writeJsonAtomic(paths.agentFile(card.agent_id), card)
  }
  const available = detected.agents.filter((a) => a.enabled).map((a) => ({
    agent_id: a.agent_id,
    available: true,
    source: a.agent_id,
  }))
  if (detected.agents.some((a) => !a.enabled)) {
    notes.push(`disabled agents: ${detected.agents.filter((a) => !a.enabled).map((a) => a.agent_id).join(', ')}`)
  }

  // -- protocol snapshot + decisions ---------------------------------------
  writeFileAtomic(
    paths.protocolSnapshot,
    `# AgentMesh 协议（快照）\n\n${PROTOCOL_QUICKREF}\n\n完整协议见仓库根目录 PROTOCOL.md。\n`,
  )
  if (!fs.existsSync(paths.decisionsFile)) {
    writeFileAtomic(paths.decisionsFile, DECISIONS_BODY)
  }

  // -- audit ---------------------------------------------------------------
  const store = new MeshStore(paths)
  store.auditEvent('mesh.init', {
    root: paths.root,
    created,
    main_branch: mainBranch,
    base_commit: state.base_commit,
    agents: detected.agents.map((a) => ({ id: a.agent_id, enabled: a.enabled })),
  })

  // -- fix coordinator if unset -------------------------------------------
  const config = loadConfig(paths)
  if (!config.coordinator_agent) {
    const coordinator = detected.agents.find((a) => a.enabled && a.capabilities.includes('coordinator'))
    if (coordinator) saveConfig(paths, { ...config, coordinator_agent: coordinator.agent_id })
  }

  return {
    paths,
    created,
    project: state.project,
    mainBranch,
    baseCommit: state.base_commit,
    agents: available,
    notes,
  }
}

/** Human-readable report for `mesh init`. */
export function renderInitReport(result: InitResult): string {
  const lines: string[] = []
  lines.push(result.created ? '✔ AgentMesh 初始化完成' : '✔ AgentMesh 已存在，已校验并修复')
  lines.push('')
  lines.push(`  项目      ${result.project}`)
  lines.push(`  目录      ${result.paths.meshDir}`)
  lines.push(`  主分支    ${result.mainBranch} @ ${(result.baseCommit ?? '').slice(0, 8)}`)
  lines.push('')
  lines.push('  已注册 Agent:')
  for (const a of result.agents) lines.push(`    · ${a.agent_id}`)
  if (result.notes.length > 0) {
    lines.push('')
    lines.push('  说明:')
    for (const n of result.notes) lines.push(`    - ${n}`)
  }
  lines.push('')
  lines.push('  下一步:  mesh agents doctor  ·  mesh status  ·  mesh up')
  return lines.join('\n')
}
