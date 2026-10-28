import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globToRegExp, matchAnyGlob, normRel, outOfScope } from '../../hub/core/fsx.ts'
import { validateAgentCard, validateTaskCard, validateMessage } from '../../hub/core/schema.ts'
import { PROTOCOL_QUICKREF } from '../../hub/core/protocol.ts'
import fs from 'node:fs'
import path from 'node:path'

test('glob: ** matches any depth, * stays inside one segment', () => {
  assert.ok(globToRegExp('web/src/pages/**').test('web/src/pages/login/index.tsx'))
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'))
  assert.ok(globToRegExp('src/*.ts').test('src/a.ts'))
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'))
  assert.ok(globToRegExp('**/*.md').test('docs/a.md'))
})

test('glob: a bare directory name covers its subtree', () => {
  assert.ok(matchAnyGlob(['src/components'], 'src/components/button/index.tsx'))
  assert.ok(matchAnyGlob(['src/components'], 'src/components'))
  assert.ok(!matchAnyGlob(['src/components'], 'src/components2/x.ts'))
})

test('scope diff: exactly the out-of-scope set is returned', () => {
  const files = ['web/src/pages/login/index.tsx', 'web/src/pages/dashboard/index.tsx', 'web/src/api/auth.ts']
  const oos = outOfScope(files, ['web/src/pages/login/**'])
  assert.deepEqual(oos, ['web/src/api/auth.ts', 'web/src/pages/dashboard/index.tsx'])
})

test('normRel: normalises separators and collapses .. without escaping', () => {
  assert.equal(normRel('./a/b/../c'), 'a/c')
  assert.equal(normRel('a\\b\\c'), 'a/b/c')
  assert.equal(normRel('/a/b'), 'a/b')
})

test('schema: a task card with an empty scope.write is rejected', () => {
  const card = {
    task_id: 'T-000001',
    title: 'x',
    role: 'backend_dev',
    created_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'ready',
    depends_on: [],
    context_package: null,
    context_level: null,
    scope: { write: [], read: [] },
    acceptance: ['a'],
    estimate: '1-session',
    base_commit: null,
    branch: 'mesh/T-000001',
    worktree: null,
    claimed_by: null,
    implementer_agent: null,
    submission: null,
    reviews: [],
    merge: null,
    blocked_reason: null,
    parent: null,
    tags: [],
    history: [],
  }
  const errors = validateTaskCard(card as never)
  assert.ok(errors.some((e) => e.includes('scope.write')))
})

test('schema: role cards may not carry a tool policy (C4)', () => {
  const errors = validateAgentCard({
    agent_id: 'X',
    display_name: 'x',
    kind: 'generic',
    enabled: true,
    command: 'node',
    args: [],
    capabilities: [],
    concurrency: 0,
    cost_tier: 9,
    transport: 'mcp',
    mcp_inject: 'none',
    extra_env: {},
    strip_env: [],
    prompt_mode: 'arg',
    prompt_flag: null,
    headless_args: [],
    ttl_seconds: 1,
    notes: '',
  } as never)
  assert.ok(errors.length > 0)
})

test('schema: message must be addressed to a role, not an agent', () => {
  const errors = validateMessage({
    msg_id: 'M-000001',
    from: { agent: 'a', session: 'S-000001', role: 'coordinator' },
    to: { role: 'claude-code-01' as never, thread: '*' },
    type: 'board.update',
    body: 'hi',
    attachments: [],
    thread: '*',
    ttl_seconds: 60,
    created_at: new Date().toISOString(),
    expires_at: new Date().toISOString(),
    resolved: null,
    read_at: null,
    read_by: null,
    status: 'queued',
  })
  assert.ok(errors.some((e) => e.includes('to must be')))
})

test('docs: PROTOCOL.md embeds the exact quick reference the hub injects', () => {
  const doc = fs.readFileSync(path.resolve(import.meta.dirname, '../../PROTOCOL.md'), 'utf8')
  assert.ok(doc.includes(PROTOCOL_QUICKREF), 'PROTOCOL.md and hub/core/protocol.ts have drifted apart')
})
