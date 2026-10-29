# Peer Review Wiring Smoke Test

This file is a verification artifact for **互评接线 / peer review wiring** in AgentMesh.
Its only job is to prove that the review chain — not just the delivery channel — is
wired end to end: an executor produces a scoped commit, an *independent* reviewer
reads it and renders a verdict, and the platform then runs the scope gate at merge
time. If this file reached the repository and a reviewer could read it, the peer
review loop closed.

## Result

PEER-OK

## What this verifies

The chain under test, in order:

```
worker 提交 (write in scope -> git commit on mesh/T-000006 -> hub.submit)
        |
        v
reviewer 审查 (独立审查者开启 review, 校验验收标准并给出 verdict)
        |
        v
合并终审 (hub.merge 事务内逐路径校验 scope, 通过则落主分支)
```

| Step | Expected outcome |
| --- | --- |
| Worker submit | Commit lands on `mesh/T-000006`, worktree clean, `hub.submit` accepted, task moves `submitted → reviewing` |
| Reviewer scope | Review is opened by a session that is **not** the executor (`MESH_REVIEW_NOT_INDEPENDENT` guards self-review) |
| Reviewer verdict | The reviewer checks the acceptance criteria against the actual commit diff, not against the executor's summary |
| Merge final check | `hub.merge` re-validates every staged path; an out-of-scope path aborts the transaction and raises `MESH_SCOPE_VIOLATION` |
| Peer rating | `hub.rate_peer` lets participants rate each other once per mission, so the review is recorded rather than implied |

The point of the smoke test is the independence, not the content: any agent can write
a file, but only a correctly wired platform can hand that file to a *different* agent
for judgement and then merge it under a scope gate.

## Scope

The task card for this smoke test allows writes to exactly one path:

```
write:
  - PEER-SMOKE.md
```

No other file in this repository was created, modified, or deleted as part of this
task. Anything outside that single path would be caught by the scope gate at merge
time, so it was not attempted — the smoke test must not pollute the very thing it is
supposed to prove.

## Reading the result

The marker line above is the pass signal. An automated check can look for it with:

```sh
grep -x 'PEER-OK' PEER-SMOKE.md
```

A match means the file was written in scope, travelled through the submit/review path
intact, and survived the merge gate. An absent marker means either the delivery path or
the review wiring is broken and the smoke test has failed.

## Notes

- Task: **T-000006** under mission `M-000002`.
- Task branch: `mesh/T-000006` (base `f547b629`).
- Scope of this task: this file only.
