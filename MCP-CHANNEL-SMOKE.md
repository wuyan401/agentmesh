# MCP Channel Smoke Test

This file is a minimal, self-contained smoke test for the AgentMesh **MCP delivery
channel**. Its only job is to prove that a P-Session can complete the full delivery
path end to end:

```
claim_task  ->  write in scope  ->  git commit on mesh/T-000005  ->  hub.submit
```

If this file reached the repository and a reviewer could read it, then the channel is
wired correctly: the hub tools were injected over MCP (via the `dsh-patch` injection
path), the executor session had a valid identity, and `submit` resolved without the
`ENOENT` failure that previously blocked the hand-off.

MCP-CHANNEL-OK

## What this verifies

| Step | Expected outcome |
| --- | --- |
| `hello()` | Session bound to an agent id and role |
| `claim_task` | Task claimed, branch and context package assigned |
| Scope write | Only `MCP-CHANNEL-SMOKE.md` is touched |
| `git commit` | Commit lands on `mesh/T-000005`, worktree clean |
| `hub.submit` | Submission accepted, review opened |

## Scope

The task card for this smoke test allows writes to exactly one path:

```
write:
  - MCP-CHANNEL-SMOKE.md
```

No other file in this repository was created, modified, or deleted as part of this
task. Anything outside that single path would be rejected by the platform's scope gate
at merge time, so it was not attempted.

## Reading the result

The marker line above is the pass signal. An automated check can look for it with:

```sh
grep -x 'MCP-CHANNEL-OK' MCP-CHANNEL-SMOKE.md
```

A match means the file was written in scope and travelled through the channel intact.
An absent marker means the delivery path is broken and the smoke test has failed.
