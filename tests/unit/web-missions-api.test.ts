import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from '../../hub/web/server.ts'
import { addAgent, createHarness } from '../helpers.ts'
import type { Harness } from '../helpers.ts'
import type { Server } from 'node:http'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Running {
  h: Harness
  url: string
  server: Server
  close: () => Promise<void>
}

/**
 * A dashboard on an ephemeral port, backed by a throwaway hub.
 *
 * `dsh` can lead, `dev` cannot — that pair is what makes the capability check
 * meaningful rather than an accident of which agents happen to be registered.
 */
async function startDashboard(name: string): Promise<Running> {
  const h = createHarness(name)
  // The lead agent must be spawnable (the endpoint launches its planning turn), so give
  // it a command that exits immediately instead of the default bare `node`.
  addAgent(h.hub, 'dsh', ['backend_dev', 'lead'], { command: process.execPath, args: ['-e', 'process.exit(0)'] })
  addAgent(h.hub, 'dev', ['backend_dev', 'executor'])
  addAgent(h.hub, 'mesh-human', ['planner', 'lead'], {
    kind: 'builtin',
    command: '',
    transport: 'in-process',
    mcp_inject: 'none',
  })
  const { server } = await startServer({ hub: h.hub, port: 0, host: '127.0.0.1' })
  // port 0 means "any free port"; the URL has to come from the bound socket, not the request.
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind a TCP port')
  const url = `http://127.0.0.1:${address.port}`
  return {
    h,
    url,
    server,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      h.cleanup()
    },
  }
}

async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('web: POST /api/missions rejects a payload with no title (400, says which field)', async () => {
  const r = await startDashboard('web-no-title')
  try {
    const missing = await post(`${r.url}/api/missions`, { brief: '只说描述不给标题' })
    assert.equal(missing.status, 400)
    assert.equal(missing.json.error, 'invalid_mission')
    assert.equal(missing.json.code, 'MESH_SCHEMA_INVALID')
    assert.equal(missing.json.field, 'title')

    const blank = await post(`${r.url}/api/missions`, { title: '   ', brief: '空白标题' })
    assert.equal(blank.status, 400)

    const notJson = await post(`${r.url}/api/missions`, 'not json at all')
    assert.equal(notJson.status, 400)
    assert.equal(notJson.json.code, 'MESH_SCHEMA_INVALID')
  } finally {
    await r.close()
  }
})

test('web: POST /api/missions creates the mission and its lead session, source=platform', async () => {
  const r = await startDashboard('web-create')
  try {
    const res = await post(`${r.url}/api/missions`, {
      title: '给观察台加发布入口',
      brief: '用户原话：从前端也能发任务',
      acceptance: ['页面能发', 'session 里能看到'],
      lead_agent: 'dsh',
    })
    assert.equal(res.status, 201)
    const missionId = String(res.json.mission_id)
    assert.match(missionId, /^M-\d{6}$/)
    assert.equal(res.json.lead_agent, 'dsh')
    assert.equal(res.json.source, 'platform')
    assert.match(String(res.json.lead_session_id), /^S-\d{6}$/)

    // the mission really exists, with the acceptance list the caller sent
    const mission = r.h.hub.store.requireMission(missionId)
    assert.equal(mission.lead_agent, 'dsh')
    assert.equal(mission.source, 'platform')
    assert.deepEqual(mission.acceptance, ['页面能发', 'session 里能看到'])

    // and the lead session is a real session card owned by that agent — not a record
    const session = r.h.hub.store.requireSession(String(res.json.lead_session_id))
    assert.equal(session.agent_id, 'dsh')
    assert.equal(session.spawned_by, 'web.mission')
    assert.equal(session.task, null)

    // the mission points at the very session we returned (not a second one made later)
    assert.equal(r.h.hub.store.requireMission(missionId).lead_session, String(res.json.lead_session_id))

    // the planning turn was launched on it; a failure here is reported, not hidden
    assert.match(String(res.json.lead_turn), /^(spawned|deferred)/)

    // it shows up where the human would look for it
    const list = (await fetch(`${r.url}/api/sessions`).then((x) => x.json())) as {
      sessions: Array<{ session_id: string }>
    }
    const ids = list.sessions.map((s: { session_id: string }) => s.session_id)
    assert.ok(ids.includes(String(res.json.lead_session_id)), 'lead session missing from /api/sessions')
  } finally {
    await r.close()
  }
})

test('web: POST /api/missions refuses a lead without the lead capability (400, names the agent)', async () => {
  const r = await startDashboard('web-bad-lead')
  try {
    const res = await post(`${r.url}/api/missions`, { title: '让不能当 lead 的 agent 当 lead', lead_agent: 'dev' })
    assert.equal(res.status, 400)
    assert.equal(res.json.code, 'MESH_CAPABILITY_MISSING')
    assert.equal(res.json.agent_id, 'dev')

    // nothing may be left behind by a rejected publish
    assert.equal(r.h.hub.store.listMissions().length, 0)
  } finally {
    await r.close()
  }
})

test('web: POST /api/missions keeps a builtin lead session-less (HTTP stays read-mostly)', async () => {
  const r = await startDashboard('web-builtin-lead')
  try {
    const res = await post(`${r.url}/api/missions`, { title: '我自己当 lead', lead_agent: 'mesh-human' })
    assert.equal(res.status, 201)
    assert.equal(res.json.lead_session_id, null)
    assert.equal(res.json.lead_agent, 'mesh-human')
  } finally {
    await r.close()
  }
})
