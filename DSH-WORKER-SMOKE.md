# DSH Worker Smoke Test

Smoke test record for task **T-000003 — 验证 DSH worker 能启动并执行命令**.

## Result

DSH-WORKER-OK

## What was verified

An AgentMesh P-Session (DSH worker) was launched into an isolated git worktree and
was able to run real shell commands and produce a committed artifact.

| Check | Evidence |
| --- | --- |
| Worker started with an identity | `hub.hello()` returned session `S-000010`, agent `dsh-01`, role `executor` |
| Worker got a sandbox | worktree `<PROJECT>\.mesh\worktrees\T-000003` |
| Shell commands execute | `git branch --show-current` → `mesh/T-000003`; `git log --oneline -3` returned commits |
| Toolchain is usable | `node --version` → `v26.7.0` |
| Worker owns a real process env | `$env:USERNAME` → `HP` |
| Deliverable channel works | this file, committed on `mesh/T-000003` and submitted via `hub.submit` |

## Reproduce

```powershell
cd .mesh/worktrees/T-000003
git branch --show-current   # mesh/T-000003
node --version              # v26.7.0
Test-Path DSH-WORKER-SMOKE.md
Select-String -Path DSH-WORKER-SMOKE.md -Pattern '^DSH-WORKER-OK$'  # must match
```

## Notes

- Task branch: `mesh/T-000003` (base `d0b81cce`).
- Scope of this task: this file only.
