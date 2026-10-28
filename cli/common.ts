/**
 * Shared CLI plumbing: argument parsing, output style, error rendering.
 *
 * No dependency, no colour library: ANSI is written directly and disabled when the
 * stream is not a TTY, so `mesh board | grep` stays usable.
 */

import type { Hub } from '../hub/core/hub.ts'
import { MeshPaths } from '../hub/core/paths.ts'
import { MeshError, MESH_ERRORS } from '../hub/core/errors.ts'
import { Hub as HubClass } from '../hub/core/hub.ts'

export interface ParsedArgs {
  command: string
  positionals: string[]
  /** Last value wins — for scalar flags. */
  flags: Map<string, string | boolean>
  /** Every occurrence, in order — for repeatable flags. */
  multi: Map<string, string[]>
}

/** Minimal argv parser: `--flag`, `--key value`, `--key=value`, `-k`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : ''
  const positionals: string[] = []
  const flags = new Map<string, string | boolean>()
  const multi = new Map<string, string[]>()
  const record = (key: string, value: string | boolean): void => {
    flags.set(key, value)
    const list = multi.get(key) ?? []
    list.push(typeof value === 'string' ? value : 'true')
    multi.set(key, list)
  }
  const rest = command ? argv.slice(1) : argv
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      if (eq > 0) {
        record(token.slice(2, eq), token.slice(eq + 1))
        continue
      }
      const key = token.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        record(key, next)
        i++
      } else {
        record(key, true)
      }
    } else if (token.startsWith('-') && token.length === 2) {
      const key = token.slice(1)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        record(key, next)
        i++
      } else {
        record(key, true)
      }
    } else {
      positionals.push(token)
    }
  }
  return { command, positionals, flags, multi }
}

export function str(parsed: ParsedArgs, key: string): string | undefined {
  const v = parsed.flags.get(key)
  return typeof v === 'string' ? v : undefined
}

export function bool(parsed: ParsedArgs, key: string): boolean {
  const v = parsed.flags.get(key)
  return v === true || v === 'true' || v === '1' || v === 'yes'
}

export function num(parsed: ParsedArgs, key: string): number | undefined {
  const v = parsed.flags.get(key)
  if (typeof v !== 'string') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Repeatable flag: `--write a --write b`.
 *
 * Deliberately does NOT split on commas: acceptance criteria and glob patterns
 * legitimately contain commas (`{url,title}`), and silently cutting a value in
 * half produces task cards that nobody can satisfy.
 */
export function list(parsed: ParsedArgs, key: string): string[] {
  return (parsed.multi.get(key) ?? []).map((v) => v.trim()).filter(Boolean)
}

export const useColor = (): boolean => Boolean(process.stdout.isTTY) && process.env['NO_COLOR'] !== '1'

export function paint(code: string, text: string): string {
  return useColor() ? `\u001b[${code}m${text}\u001b[0m` : text
}

export const style = {
  dim: (t: string) => paint('2', t),
  bold: (t: string) => paint('1', t),
  cyan: (t: string) => paint('36', t),
  green: (t: string) => paint('32', t),
  yellow: (t: string) => paint('33', t),
  red: (t: string) => paint('31', t),
  magenta: (t: string) => paint('35', t),
  blue: (t: string) => paint('34', t),
}

/** Status badge, consistent everywhere. */
export function statusBadge(status: string): string {
  const map: Record<string, string> = {
    draft: style.dim('draft'),
    ready: style.cyan('ready'),
    claimed: style.yellow('claimed'),
    in_progress: style.yellow('in_progress'),
    submitted: style.magenta('submitted'),
    reviewing: style.magenta('reviewing'),
    approved: style.green('approved'),
    rejected: style.red('rejected'),
    merged: style.green('merged'),
    blocked: style.red('blocked'),
    cancelled: style.dim('cancelled'),
    active: style.green('active'),
    starting: style.cyan('starting'),
    exited: style.dim('exited'),
    expired: style.dim('expired'),
    killed: style.dim('killed'),
    failed: style.red('failed'),
  }
  return map[status] ?? status
}

/** Render an aligned table. Column widths are computed from the content. */
export function table(headers: string[], rows: string[][], opts: { maxWidth?: number } = {}): string {
  if (rows.length === 0) return style.dim('（空）')
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const lines: string[] = []
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length))
  lines.push(headers.map((h, i) => style.bold(pad(h, widths[i]!))).join('  '))
  lines.push(widths.map((w) => style.dim('─'.repeat(w))).join('  '))
  for (const row of rows) lines.push(row.map((c, i) => pad(c ?? '', widths[i]!)).join('  '))
  return lines.join('\n')
}

export interface CliContext {
  hub: Hub
  cwd: string
  json: boolean
}

export function requireHub(cwd: string = process.cwd()): HubClass {
  return HubClass.open(cwd)
}

export function tryHub(cwd: string = process.cwd()): HubClass | null {
  const paths = MeshPaths.tryDiscover(cwd)
  return paths ? new HubClass(paths) : null
}

/** Print an error the way a human expects, and return the exit code. */
export function reportError(e: unknown): number {
  if (e instanceof MeshError) {
    process.stderr.write(`${style.red('✖')} ${e.message}\n`)
    process.stderr.write(`${style.dim(`  code: ${e.code}`)}\n`)
    const detail = e.detail
    if (detail && Object.keys(detail).length > 0) {
      const text = JSON.stringify(detail, null, 2)
      if (text.length < 3000) process.stderr.write(`${style.dim(text.split('\n').map((l) => `  ${l}`).join('\n'))}\n`)
    }
    return e.code === MESH_ERRORS.SCOPE_VIOLATION || e.code === MESH_ERRORS.REVIEW_NOT_INDEPENDENT ? 3 : 1
  }
  const err = e as Error
  process.stderr.write(`${style.red('✖')} ${err?.message ?? String(e)}\n`)
  if (process.env['MESH_DEBUG'] === '1' && err?.stack) process.stderr.write(`${style.dim(err.stack)}\n`)
  return 1
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** Resolve the acting session id: explicit flag, else the spawn env. */
export function sessionIdFrom(parsed: ParsedArgs): string {
  const explicit = str(parsed, 'session') ?? str(parsed, 's')
  const env = process.env['MESH_SESSION_ID']
  const session = explicit ?? env
  if (!session) {
    throw new MeshError(
      MESH_ERRORS.SESSION_HELLO_REQUIRED,
      'no session id: pass --session S-000123 or set MESH_SESSION_ID (the scheduler does this for spawned sessions)',
      { hint: 'humans normally use the management commands (board/assign/agents); agents use the session-scoped ones' },
    )
  }
  return session
}

export function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}
