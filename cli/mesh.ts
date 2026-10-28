#!/usr/bin/env node
/**
 * `mesh` — the AgentMesh command line.
 *
 * Two audiences, one binary:
 *  - humans get the operator console (`init/status/up/board/talk/...`);
 *  - agents get the file-protocol mirror of `hub.*` (`hello/claim/submit/...`),
 *    auto-detecting their session from `MESH_SESSION_ID`.
 */

import { parseArgs, reportError, requireHub, style, tryHub } from './common.ts'
import type { ParsedArgs } from './common.ts'
import path from 'node:path'
import { Hub } from '../hub/core/hub.ts'
import { MeshPaths } from '../hub/core/paths.ts'
import { AGENT_COMMANDS, runAgentBoard, runAgentCommand } from './agent.ts'
import {
  cmdAgents,
  cmdArtifacts,
  cmdAssign,
  cmdAudit,
  cmdBlock,
  cmdBoard,
  cmdConfig,
  cmdCoordinator,
  cmdDecisions,
  cmdDoctor,
  cmdDown,
  cmdInit,
  cmdMerge,
  cmdNew,
  cmdReview,
  cmdRoles,
  cmdSentinel,
  cmdServe,
  cmdSessions,
  cmdStatus,
  cmdTask,
  cmdTalk,
  cmdUnblock,
  cmdUp,
  cmdVerdict,
  cmdVerifyAgent,
} from './human.ts'
import { MeshError, MESH_ERRORS } from '../hub/core/errors.ts'
import {
  cmdCreateMission,
  cmdDispatchMission,
  cmdFinalVerdict,
  cmdGetMission,
  cmdMission,
  cmdMissionLead,
  cmdMissions,
  cmdPlanMission,
  cmdWriteReport,
} from './mission.ts'
import { cmdProfile, cmdRatePeer } from './profile.ts'
import { cmdTeammates } from './human.ts'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const VERSION = (require_('../package.json') as { version: string }).version

const HELP = `${style.bold('AgentMesh')} ${style.dim(`v${VERSION}`)} — 让异构 CLI Agent 像团队一样协作

${style.bold('评分（V2）')}
  mesh profile list                      每个 agent 的九个维度一览（手编过的标"手编"）
  mesh profile show <agent>              完整 profile：九个维度 + 互评 + 战绩
  mesh profile get <agent> [field]       读一个字段（可脚本化）
  mesh profile set <agent> <field> <value>
                                         手编一个字段；手编后 manual_locked=true，
                                         互评不再覆盖质量分，且**下一次派发**按新分数排序
                                         fields: personality | strengths | weaknesses |
                                         capability_notes | specialties | quality_score |
                                         cost_tier | reliability | speed_notes | manual_locked
  mesh rate-peer <agent> --mission M-1 --quality 90 --cooperation 85 --evidence 95 --speed 70
                                         互评（必须同一 mission 参与过，不能评自己，一人一次）
  mesh teammates [M-000001]              这个 mission 的参与者表（与注入给 agent 的同一张表）

${style.bold('Mission（V2）')}
  mesh mission "你想做什么" [--lead id] [--accept "…"] [--dry-plan] [--timeout 900]
                                         开一个 mission，选 lead 并让它拆解
                                         --timeout 单位是**秒**（也接受 500ms / 5m）
  mesh missions [--status completed]      mission 列表
  mesh mission <M-000001>                 mission 详情：计划、卡状态、审查、报告
  mesh mission report <M-000001>          打印最终报告
  mesh mission lead <M-000001>            为内置 lead（人类）开一个 lead 会话

${style.bold('Mission 的 lead 动作')}（都需要 --session 或 MESH_SESSION_ID，且必须是在任 lead）
  mesh plan-mission <M-000001> --file plan.json
  mesh dispatch-mission <M-000001>
  mesh final-verdict <M-000001> --approve|--reject --notes "…" [--reject-task T-000012]
  mesh write-report <M-000001> --file report.md
  mesh create-mission "标题" [--brief "…"] [--lead me]   对话入口（agent 自己开 mission）
  mesh get-mission <M-000001>

${style.bold('人类命令')}
  mesh init [--dir .] [--no-detect]      初始化协作空间（幂等）
  mesh status                            平台总览：看板、会话、Agent、配置
  mesh up [--once] [--interval ms]       调度循环：派活、审查、合并、回收
  mesh down                              停止所有活跃会话
  mesh talk "你想做什么"                  与 Coordinator 对话（一句话拉起一个团队）
  mesh coordinator                       只跑一个 coordinator 回合：处理升级、解阻塞
  mesh block <T-000001> --reason "…"     标记阻塞（人工仲裁）
  mesh unblock <T-000001>                解除阻塞
  mesh board [--status ready]            看板
  mesh task <T-000001>                   任务卡详情（含 scope 预检）
  mesh new "标题" --role r --write g --accept "条目"
                                         建任务卡（有 MESH_SESSION_ID 时以该会话身份下单）
  mesh assign <T-000001> [--agent id] [--wait [--timeout 900]]
                                         手动派发（同样走 Session 创建流程）
                                         --timeout 单位是**秒**（也接受 500ms / 5m）
  mesh agents [list|doctor|detect|add|enable|disable]
  mesh agents verify [agent_id]          实跑一次会话，验证"原生工具 + hub 工具"都在（超集性）
  mesh sessions [ps|logs <id>|kill <id>] 会话
  mesh audit [digest|violations|merges|reviews|scope <id>|events]
  mesh sentinel [--quiet]                审计扫描（detect-only）
  mesh review <T-000001>                 Supervisor 开启审查
  mesh verdict <T-000001> --approve|--reject --notes "…" [--allow-strip]
                                         人工裁决（记录为 mesh-human）
  mesh merge <T-000001> [--allow-strip]  人工合并（仍走 scope 终审）
  mesh roles [role]                      角色卡一览
  mesh config [set k v]                  配置
  mesh doctor                            环境体检
  mesh serve [--port 8787]               打开看板网页

${style.bold('Agent 命令（文件协议）')}  会话从 --session 或 MESH_SESSION_ID 读取
  mesh hello                             注册身份，拿角色卡
  mesh whoami / heartbeat                我是谁 / 续租
  mesh claim <T-000001>                  领任务，拿上下文包
  mesh context <T-000001> [--print]      重新生成上下文包
  mesh progress <T-000001> --pct 60      进度上报
  mesh ask <T-000001> "问题"              向 Coordinator 提问
  mesh escalate "原因" [--task id]        升级／越界上报
  mesh submit <T-000001> --summary "…"   提交审查
  mesh messages / wait [--timeout 30]    收件箱 / 长轮询（秒；也可写 500ms / 5m）
  mesh send --to coordinator:* --type board.update --body "…"
  mesh put <path> --file F | --content "…"   非代码工件入库
  mesh get <path> / artifacts            读工件 / 列工件
  mesh getfile <path>                    读工作区任意文件

${style.dim('更多：mesh help / mesh version')}`

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv)
  const command = parsed.command || 'help'

  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  // -- commands that do not need an existing .mesh -------------------------
  if (command === 'init') return cmdInit(parsed)
  if (command === 'roles') return cmdRoles(parsed)
  if (command === 'doctor') return cmdDoctor(parsed)

  // `--dir <project>` works for every command, so you never have to cd.
  const dirFlag = parsed.flags.get('dir')
  const hub = typeof dirFlag === 'string' ? (MeshPaths.tryDiscover(path.resolve(dirFlag)) ? Hub.openOrThrow(dirFlag) : null) : tryHub()
  if (!hub) {
    throw new MeshError(MESH_ERRORS.NOT_INITIALIZED, 'no .mesh/ found here; run `mesh init` first', {
      cwd: process.cwd(),
      hint: 'or point at an initialised project with `--dir <path>`',
    })
  }

  // -- agent surface -------------------------------------------------------
  if ((AGENT_COMMANDS as readonly string[]).includes(command)) {
    const hasSession = Boolean(process.env['MESH_SESSION_ID'] || parsed.flags.has('session'))
    if (command === 'artifacts' && !hasSession) return cmdArtifacts(parsed, hub)
    if (command === 'decision' && !hasSession) return cmdDecisions(parsed, hub)
    if (command === 'board' && parsed.flags.get('global') === true) return cmdBoard(parsed, hub)
    if (command === 'board' && !hasSession) {
      return cmdBoard(parsed, hub)
    }
    if (command === 'board') {
      await runAgentBoard(parsed, hub)
      return 0
    }
    return runAgentCommand(parsed, hub)
  }

  // -- profiles / peer review (V2 §2) --------------------------------------
  switch (command) {
    case 'profile':
      return cmdProfile(parsed, hub)
    case 'rate-peer':
      return cmdRatePeer(parsed, hub)
    case 'teammates':
      return cmdTeammates(parsed, hub)
    default:
      break
  }

  // -- missions (V2) -------------------------------------------------------
  // Lead-side commands are the CLI mirror of the mission tools: they need a session,
  // and they check `is_lead + mission` in the hub, not here.
  switch (command) {
    case 'missions':
      return cmdMissions(parsed, hub)
    case 'mission':
      return cmdMission(parsed, hub)
    case 'mission-lead':
      return cmdMissionLead(parsed, hub)
    case 'create-mission':
      return cmdCreateMission(parsed, hub)
    case 'get-mission':
      return cmdGetMission(parsed, hub)
    case 'plan-mission':
      return cmdPlanMission(parsed, hub)
    case 'dispatch-mission':
      return cmdDispatchMission(parsed, hub)
    case 'final-verdict':
      return cmdFinalVerdict(parsed, hub)
    case 'write-report':
      return cmdWriteReport(parsed, hub)
    default:
      break
  }

  // -- human surface -------------------------------------------------------
  switch (command) {
    case 'status':
      return cmdStatus(parsed, hub)
    case 'up':
      return cmdUp(parsed, hub)
    case 'down':
      return cmdDown(parsed, hub)
    case 'talk':
      return cmdTalk(parsed, hub)
    case 'coordinator':
      return cmdCoordinator(parsed, hub)
    case 'block':
      return cmdBlock(parsed, hub)
    case 'unblock':
      return cmdUnblock(parsed, hub)
    case 'task':
      return cmdTask(parsed, hub)
    case 'new':
      return cmdNew(parsed, hub)
    case 'assign':
      return cmdAssign(parsed, hub)
    case 'agents':
      if (parsed.positionals[0] === 'verify') return cmdVerifyAgent(parsed, hub)
      return cmdAgents(parsed, hub)
    case 'sessions':
      return cmdSessions(parsed, hub)
    case 'audit':
      return cmdAudit(parsed, hub)
    case 'sentinel':
      return cmdSentinel(parsed, hub)
    case 'review':
      return cmdReview(parsed, hub)
    case 'verdict':
      return cmdVerdict(parsed, hub)
    case 'merge':
      return cmdMerge(parsed, hub)
    case 'config':
      return cmdConfig(parsed, hub)
    case 'serve':
      return cmdServe(parsed, hub)
    default:
      process.stderr.write(`${style.red('✖')} unknown command: ${command}\n\n${HELP}\n`)
      return 2
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((e) => {
    process.exitCode = reportError(e)
  })

export type { ParsedArgs }
