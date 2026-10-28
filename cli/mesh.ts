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
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const VERSION = (require_('../package.json') as { version: string }).version

const HELP = `${style.bold('AgentMesh')} ${style.dim(`v${VERSION}`)} — 让异构 CLI Agent 像团队一样协作

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
  mesh assign <T-000001> [--agent id] [--wait]
                                         手动派发（同样走 Session 创建流程）
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
  mesh messages / wait [--timeout ms]    收件箱 / 长轮询
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
