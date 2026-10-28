/**
 * Filesystem primitives: atomic writes, JSONL journals, glob matching, hashing.
 *
 * "File is truth" (P4) only works if every write is crash-safe: we always write
 * a sibling temp file and rename it into place, so a killed process leaves the
 * previous version intact rather than a half-written card.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function nowIso(): string {
  return new Date().toISOString()
}

export function nowMs(): number {
  return Date.now()
}

/** Blocking sleep usable inside synchronous critical sections. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function exists(p: string): boolean {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Atomic write: temp file in the same directory, then rename over the target. */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  const dir = path.dirname(file)
  ensureDir(dir)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  fs.writeFileSync(tmp, data)
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (e) {
      lastErr = e
      // Windows: another process (or AV) may hold the target briefly.
      sleepSync(15 * (attempt + 1))
    }
  }
  try {
    fs.unlinkSync(tmp)
  } catch {
    /* ignore */
  }
  throw lastErr
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function readJson<T>(file: string, fallback?: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch (e) {
    if (fallback !== undefined) return fallback
    throw e
  }
}

export function readJsonIfExists<T>(file: string): T | null {
  if (!exists(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

export function readText(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

/** Append-only JSONL journal. Used for audit, events, merges and the message log. */
export function appendJsonl(file: string, value: unknown): void {
  ensureDir(path.dirname(file))
  const line = `${JSON.stringify(value)}\n`
  const fd = fs.openSync(file, 'a')
  try {
    fs.writeSync(fd, line)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function readJsonl<T>(file: string): T[] {
  if (!exists(file)) return []
  const out: T[] = []
  const text = fs.readFileSync(file, 'utf8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as T)
    } catch {
      // A torn final line after a hard kill is expected; skip it.
    }
  }
  return out
}

export function sha256(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

export function rmrf(target: string): void {
  fs.rmSync(target, { recursive: true, force: true })
}

export function listFiles(dir: string, suffix = ''): string[] {
  if (!isDir(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, suffix))
    else if (entry.name.endsWith(suffix)) out.push(full)
  }
  return out
}

// ---------------------------------------------------------------------------
// Path normalisation and glob matching
// ---------------------------------------------------------------------------

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Normalise a repository-relative path: posix separators, no leading ./ or /. */
export function normRel(p: string): string {
  let out = toPosix(p).trim()
  while (out.startsWith('./')) out = out.slice(2)
  out = out.replace(/^\/+/, '')
  const parts: string[] = []
  for (const seg of out.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts.join('/')
}

const GLOB_CACHE = new Map<string, RegExp>()

/**
 * Glob → RegExp. Supports `**` (any depth), `*` (within a segment), `?` (one
 * char). A trailing `/**` also matches the directory's own files.
 */
export function globToRegExp(pattern: string): RegExp {
  const cached = GLOB_CACHE.get(pattern)
  if (cached) return cached
  const normalized = normRel(pattern)
  let re = ''
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // `**` → match across segments
        i++
        if (normalized[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      re += '[^/]'
      continue
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const compiled = new RegExp(`^${re}$`)
  GLOB_CACHE.set(pattern, compiled)
  return compiled
}

export function matchGlob(pattern: string, relpath: string): boolean {
  return globToRegExp(pattern).test(normRel(relpath))
}

export function matchAnyGlob(globs: readonly string[], relpath: string): boolean {
  const target = normRel(relpath)
  for (const g of globs) {
    if (matchGlob(g, target)) return true
    // Convenience: a bare directory name matches everything under it.
    if (!g.includes('*') && (target === normRel(g) || target.startsWith(`${normRel(g)}/`))) return true
  }
  return false
}

/** Files that match no scope glob are out of scope. */
export function outOfScope(files: readonly string[], writeGlobs: readonly string[]): string[] {
  return files.map(normRel).filter((f) => !matchAnyGlob(writeGlobs, f)).sort()
}

export function shortHash(h: string, len = 8): string {
  return h.slice(0, len)
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}
