"""Locked access to the V2 acceptance state file.

Two independent processes write `state.json`: the auto-advance driver (parks
milestones, records retries) and the acceptance session (writes `reviewed`
verdicts). Both used to do read-modify-write with no coordination, so the driver
parking a milestone could overwrite a verdict that landed a few milliseconds
earlier — that is how the M5 signature was lost and had to be re-typed by hand.

This module is the single protocol for that file:

  * the lock is an OS-level byte-range lock on `state.json.lock`
    (`msvcrt.locking` on Windows, `flock` elsewhere), acquired non-blocking in a
    retry loop;
  * the lock file is *permanent*: it is never unlinked. Deleting it was the source
    of a second bug — a waiter reading the body raced the holder's unlink, and on
    Windows the delete could block or fail, wedging every later writer;
  * because the lock lives in the kernel, a crashed holder releases it
    automatically. There is no stale-lock reclamation to get wrong;
  * the read happens *inside* the lock, so no writer can act on a stale copy;
  * the state file itself is replaced atomically (tmp + os.replace), so a lock-free
    reader never sees half a JSON document;
  * `commit_state()` merges instead of overwriting: keys the caller did not touch
    stay as they are on disk, `reviewed` is union-merged, and keys the caller
    deliberately deleted are named in `deleted=`.

Path resolution is *dynamic*: `AGENTMESH_STATE_FILE` is read on every call, never
captured in a default argument. An earlier version defaulted `path=STATE_FILE`,
which meant a caller that pointed the module at a sandbox still wrote the real
file — the very test meant to prove safety damaged the file it was protecting.

Usage:
    from state_store import update_state, write_verdict

    update_state(lambda s: s.__setitem__("retries", s.get("retries", 0) + 1))
    write_verdict("M5", {"verdict": "approved", "by": "weiyang", "note": "..."})
"""

from __future__ import annotations

import json
import os
import secrets
import time

DEFAULT_STATE_FILE = r"<HERMES_HOME>\cache\agentmesh-v2\state.json"

LOCK_TIMEOUT_S = 15.0
POLL_S = 0.002
MAX_POLL_S = 0.05

_override: str | None = None


def state_file() -> str:
    """Where the acceptance state lives. Env / override win over the machine default."""
    return _override or os.environ.get("AGENTMESH_STATE_FILE") or DEFAULT_STATE_FILE


def lock_file() -> str:
    return state_file() + ".lock"


def use_state_file(path: str | None) -> None:
    """Point this module at another file (tests, one-off replays)."""
    global _override
    _override = path


class StateLockTimeout(RuntimeError):
    pass


def _os_lock(fd: int) -> None:
    """Take the exclusive lock, or raise OSError immediately if it is held."""
    if os.name == "nt":
        import msvcrt

        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _os_unlock(fd: int) -> None:
    if os.name == "nt":
        import msvcrt

        try:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
    else:
        import fcntl

        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass


class _Lock:
    def __init__(self, fd: int, path: str, token: str) -> None:
        self.fd = fd
        self.path = path
        self.token = token

    def release(self) -> None:
        try:
            os.lseek(self.fd, 0, os.SEEK_SET)
            os.ftruncate(self.fd, 0)
            os.write(self.fd, b'{"released": true}')
        except OSError:
            pass
        _os_unlock(self.fd)
        try:
            os.close(self.fd)
        except OSError:
            pass


def acquire(timeout_s: float = LOCK_TIMEOUT_S) -> _Lock:
    path = lock_file()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    token = f"{os.getpid()}-{secrets.token_hex(6)}"
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    started = time.time()
    attempt = 0
    while True:
        try:
            _os_lock(fd)
            break
        except OSError:
            if time.time() - started > timeout_s:
                holder = "<unreadable>"
                try:
                    holder = open(path, encoding="utf-8").read(200)
                except OSError:
                    pass
                os.close(fd)
                raise StateLockTimeout(
                    f"lock timeout on {os.path.basename(path)} held by {holder!r}"
                )
            attempt += 1
            time.sleep(min(POLL_S + attempt * 0.002, MAX_POLL_S))
    # We are the only holder: publishing the owner's identity is now race-free.
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        os.ftruncate(fd, 0)
        os.write(
            fd,
            json.dumps(
                {"pid": os.getpid(), "token": token, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
            ).encode("utf-8"),
        )
    except OSError:
        pass
    return _Lock(fd, path, token)


def _load_unlocked(path: str) -> dict:
    last: OSError | None = None
    for attempt in range(6):
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except FileNotFoundError:
            return {}
        except PermissionError as exc:
            # Windows: a reader can collide with the writer's replace for a few
            # milliseconds. Retry briefly instead of reporting the state as empty.
            last = exc
            time.sleep(0.005 * (attempt + 1))
        except json.JSONDecodeError:
            # A torn file should be impossible (we replace atomically), but losing
            # the whole state silently would be worse: park a copy and start empty.
            try:
                os.replace(path, path + ".corrupt")
            except OSError:
                pass
            return {}
    raise last if last else OSError(f"cannot read {path}")


def _save_unlocked(state: dict, path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    # Windows refuses to replace a file that any other handle has open (a reader
    # that is not taking the lock, an editor, an antivirus scan). Retry briefly:
    # the holder is almost always a few milliseconds long.
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 19:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            time.sleep(0.01)


def read_state() -> dict:
    """Lock-free read: the writer replaces the file atomically."""
    return _load_unlocked(state_file())


def update_state(mutator, *, default: dict | None = None) -> dict:
    """Read-modify-write under the lock. `mutator(state)` may mutate in place."""
    path = state_file()
    lock = acquire()
    try:
        state = _load_unlocked(path)
        if not state and default:
            state = dict(default)
        out = mutator(state)
        _save_unlocked(state, path)
        return state if out is None else out
    finally:
        lock.release()


def commit_state(local: dict, *, deleted: tuple[str, ...] = ()) -> dict:
    """Write a driver-side dict without clobbering what another writer added.

    `local` is authoritative for every key it contains; keys present on disk but
    absent from `local` survive unless named in `deleted`; `reviewed` is
    union-merged so a verdict that landed while this process was thinking is kept.
    """
    path = state_file()
    lock = acquire()
    try:
        on_disk = _load_unlocked(path)
        merged = dict(on_disk)
        for key, value in local.items():
            if key == "reviewed":
                union = dict(on_disk.get("reviewed") or {})
                union.update(value or {})
                merged["reviewed"] = union
            else:
                merged[key] = value
        for key in deleted:
            merged.pop(key, None)
        _save_unlocked(merged, path)
        local.update({k: v for k, v in merged.items() if k not in local})
        return merged
    finally:
        lock.release()


def write_verdict(milestone: str, verdict: dict) -> dict:
    """Record one acceptance verdict. The only write path a reviewer needs."""

    def apply(state: dict) -> None:
        reviewed = state.setdefault("reviewed", {})
        reviewed[milestone] = verdict

    return update_state(apply)


def load_state(default: dict | None = None) -> dict:
    """Backwards-compatible alias: old code calls `load_state()`."""
    state = read_state()
    if not state and default is not None:
        return dict(default)
    return state
