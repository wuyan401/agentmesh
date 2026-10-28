/**
 * Child-process claimant used by the concurrency test. It exists as its own file
 * because atomicity has to be proven *across processes*, which is what the file
 * lock protects; two claims in one process would only prove JS is single-threaded.
 */
import { Hub } from '../../hub/core/hub.ts'

const [root, sessionId, taskId] = process.argv.slice(2)
if (!root || !sessionId || !taskId) {
  console.log(JSON.stringify({ ok: false, code: 'BAD_ARGS' }))
  process.exit(0)
}
try {
  const hub = Hub.openOrThrow(root)
  const result = hub.board.claimTask(sessionId, taskId)
  console.log(JSON.stringify({ ok: true, task: result.task.task_id, status: result.task.status, pid: process.pid }))
} catch (e) {
  const err = e as { code?: string; message?: string }
  console.log(JSON.stringify({ ok: false, code: err.code ?? 'ERR', message: err.message ?? String(e), pid: process.pid }))
}
