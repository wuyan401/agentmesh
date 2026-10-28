import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { addAgent, createHarness, createReadyTask, newSession } from '../helpers.ts'

test('bus: a message to a vacant role waits, then reaches whoever takes the role', () => {
  const h = createHarness('bus-queue')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'])
    addAgent(h.hub, 'coord', ['coordinator'])
    const task = createReadyTask(h.hub)
    const dev = newSession(h.hub, 'dev', 'backend_dev')
    const devIdentity = h.hub.identity.requireIdentity(dev.session_id)

    const msg = h.hub.bus.send(devIdentity, {
      to: { role: 'coordinator', thread: task.task_id },
      type: 'question.ask',
      body: 'do we need auth here?',
    })
    assert.equal(msg.resolved, null, 'nobody holds coordinator yet, so nothing is delivered')

    const coord = newSession(h.hub, 'coord', 'coordinator')
    const flushed = h.hub.bus.flushPendingFor(coord)
    assert.equal(flushed, 1)
    const inbox = h.hub.store.inbox('coord', { unreadOnly: true })
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0]!.body, 'do we need auth here?')
    assert.equal(inbox[0]!.resolved?.session_id, coord.session_id)
  } finally {
    h.cleanup()
  }
})

test('bus: C8 — messages cannot be addressed to an agent id', () => {
  const h = createHarness('bus-bypass')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'])
    const dev = newSession(h.hub, 'dev', 'backend_dev')
    assert.throws(
      () =>
        h.hub.bus.send(h.hub.identity.requireIdentity(dev.session_id), {
          to: { role: 'dev' as never, thread: '*' },
          type: 'board.update',
          body: 'psst',
        }),
      (e: { code?: string }) => e.code === 'MESH_BUS_BYPASS',
    )
  } finally {
    h.cleanup()
  }
})

test('bus: unread messages expire into the dead-letter queue, never silently dropped', () => {
  const h = createHarness('bus-ttl')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'])
    addAgent(h.hub, 'sup', ['supervisor'])
    const dev = newSession(h.hub, 'dev', 'backend_dev')
    const sup = newSession(h.hub, 'sup', 'supervisor')
    const msg = h.hub.bus.send(h.hub.identity.requireIdentity(dev.session_id), {
      to: { role: 'supervisor', thread: '*' },
      type: 'task.assign',
      body: 'review please',
      ttl_seconds: 1,
    })
    assert.equal(msg.resolved?.session_id, sup.session_id)

    const sweep = h.hub.bus.sweep(Date.now() + 5000)
    assert.equal(sweep.dead, 1)
    const dead = h.hub.store.deadLetters()
    assert.equal(dead.length, 1)
    assert.equal(dead[0]!.msg_id, msg.msg_id)
    assert.match(String(dead[0]!.dead_reason), /ttl/)
    assert.equal(h.hub.store.inbox('sup', { unreadOnly: true }).length, 0)
  } finally {
    h.cleanup()
  }
})

test('bus: reading is idempotent per consumer (msg_id de-duplication)', () => {
  const h = createHarness('bus-idem')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'])
    addAgent(h.hub, 'sup', ['supervisor'])
    const dev = newSession(h.hub, 'dev', 'backend_dev')
    const sup = newSession(h.hub, 'sup', 'supervisor')
    h.hub.bus.send(h.hub.identity.requireIdentity(dev.session_id), {
      to: { role: 'supervisor', thread: '*' },
      type: 'task.assign',
      body: 'one',
    })
    const first = h.hub.bus.read('sup', sup.session_id, { unreadOnly: true })
    assert.equal(first.length, 1)
    const second = h.hub.bus.read('sup', sup.session_id, { unreadOnly: true })
    assert.equal(second.length, 0, 'already-read messages must not be redelivered')
    // But history is still readable.
    const all = h.hub.store.inbox('sup', { unreadOnly: false })
    assert.equal(all.length, 1)
  } finally {
    h.cleanup()
  }
})

test('bus: small attachments are inlined, large ones are referenced by sha256', () => {
  const h = createHarness('bus-attach')
  try {
    addAgent(h.hub, 'dev', ['backend_dev'])
    addAgent(h.hub, 'sup', ['supervisor'])
    const dev = newSession(h.hub, 'dev', 'backend_dev')
    newSession(h.hub, 'sup', 'supervisor')
    const smallPath = `${h.dir}/small.txt`
    const bigPath = `${h.dir}/big.txt`
    fs.writeFileSync(smallPath, 'tiny')
    fs.writeFileSync(bigPath, 'x'.repeat(40 * 1024))
    const msg = h.hub.bus.send(h.hub.identity.requireIdentity(dev.session_id), {
      to: { role: 'supervisor', thread: '*' },
      type: 'board.update',
      body: 'files attached',
      attachments: [{ abs_path: smallPath }, { abs_path: bigPath, inline: false }],
    })
    assert.equal(msg.attachments.length, 2)
    assert.equal(msg.attachments[0]!.inline, true)
    assert.equal(msg.attachments[0]!.text, 'tiny')
    assert.equal(msg.attachments[1]!.inline, false)
    assert.equal(msg.attachments[1]!.sha256.length, 64)
    assert.equal(msg.attachments[1]!.text, undefined)
  } finally {
    h.cleanup()
  }
})
