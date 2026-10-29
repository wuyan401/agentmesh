"""Stress test for the acceptance state file: proves the lock is load-bearing.

The bug this pins down (seen for real in M5): two processes wrote
`D:\\AI\\Hermes\\cache\\agentmesh-v2\\state.json` with read-modify-write and no
coordination, so the driver parking a milestone overwrote a verdict that had
landed milliseconds earlier. The signature had to be re-typed by hand.

Every case runs the *same* load as two different implementations:

  naive  — the old code path (read, mutate, os.replace), no lock
  locked — `state_store.update_state` / `commit_state` / `write_verdict`

so the test does not merely show "the new code passes": it shows the old code
fails the same measurement, which is what makes the lock evidence.

    python .tools/state-lock-test.py            # all cases, prints PASS/FAIL
    python .tools/state-lock-test.py --worker …  # internal: child process

Exit code 0 = every case behaved as specified.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import state_store  # noqa: E402

SANDBOX = os.path.join(HERE, "_state-lock-test")
FAILS: list[str] = []


def sandbox_file(name: str) -> str:
    os.makedirs(SANDBOX, exist_ok=True)
    return os.path.join(SANDBOX, name)


def reset(name: str) -> str:
    path = sandbox_file(name)
    for suffix in ("", ".lock", ".corrupt"):
        try:
            os.unlink(path + suffix)
        except FileNotFoundError:
            pass
    return path


def naive_update(path: str, fn) -> None:
    """The old, unlocked read-modify-write. Kept here on purpose: it is the control.

    Its crashes are part of the finding (Windows refuses the replace while another
    process is reading), so they are swallowed rather than printed: a writer that
    dies mid-update is a lost update, which is exactly what the check counts.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            state = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError, PermissionError):
        state = {}
    fn(state)
    tmp = f"{path}.{os.getpid()}.naive.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        time.sleep(0.0005)  # window between read and write, wide enough to lose updates
        os.replace(tmp, path)
    except (PermissionError, OSError):
        pass


def locked_update(path: str, fn) -> None:
    state_store.use_state_file(path)
    state_store.update_state(fn, default={})


def bump(state: dict, n: int = 1) -> None:
    state["counter"] = state.get("counter", 0) + n


def run_procs(args_list: list[list[str]]) -> list[int]:
    """Start one child per arg list. The state path goes in through the env, so a
    child can never touch the machine default by accident."""
    procs = []
    for args in args_list:
        path = args[args.index("--file") + 1]
        env = dict(os.environ, AGENTMESH_STATE_FILE=path)
        procs.append(subprocess.Popen([sys.executable, os.path.abspath(__file__)] + args, env=env))
    # Start them all BEFORE waiting: a sequential start would make the "naive"
    # control pass and the whole comparison meaningless.
    return [p.wait() for p in procs]


def case(target: int, label: str, mode: str, workers: int, per_worker: int) -> int:
    path = reset(f"counter-{mode}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"counter": 0}, fh)
    run_procs([["--worker", "inc", "--file", path, "--n", str(per_worker), "--mode", mode] for _ in range(workers)])
    with open(path, encoding="utf-8") as fh:
        got = json.load(fh).get("counter", 0)
    return got


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        FAILS.append(msg)


def fingerprint(path: str) -> str | None:
    import hashlib

    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except FileNotFoundError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker")
    ap.add_argument("--file")
    ap.add_argument("--n", type=int, default=1)
    ap.add_argument("--mode", default="locked")
    ap.add_argument("--role", default="")
    ap.add_argument("--window", type=float, default=0.25)
    args = ap.parse_args()

    # ---- child mode -------------------------------------------------------
    if args.worker == "inc":
        update = naive_update if args.mode == "naive" else locked_update
        for _ in range(args.n):
            update(args.file, bump)
        return 0

    if args.worker == "park":
        # The driver's real shape: READ, then work (gates take minutes), then WRITE.
        # The window between read and write is exactly where a verdict used to die.
        def park(state: dict) -> None:
            state["pending_review"] = {
                "milestone": "M5",
                "commit": "deadbeef",
                "at": time.strftime("%H:%M:%S"),
            }
            state["last_commit"] = "deadbeef"

        window = args.window
        if args.mode == "naive":
            with open(args.file, encoding="utf-8") as fh:
                state = json.load(fh)
            time.sleep(window)
            park(state)
            tmp = f"{args.file}.{os.getpid()}.park.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(state, fh)
            os.replace(tmp, args.file)
        else:
            state = state_store.load_state()
            time.sleep(window)
            park(state)
            state_store.commit_state(state)
        return 0

    if args.worker == "hold":
        # Acquire, then die hard: no release(), no cleanup. The OS must free the lock.
        state_store.use_state_file(args.file)
        lock = state_store.acquire()
        print(lock.token, flush=True)
        os._exit(0)

    if args.worker == "verdict":
        def write(path: str) -> None:
            if args.mode == "naive":
                def apply(state: dict) -> None:
                    state.setdefault("reviewed", {})["M5"] = {
                        "verdict": "approved",
                        "by": "weiyang",
                    }

                naive_update(path, apply)
            else:
                state_store.use_state_file(path)
                state_store.write_verdict("M5", {"verdict": "approved", "by": "weiyang"})

        time.sleep(0.10)  # land the verdict inside the driver's read->write window
        write(args.file)
        return 0

    # ---- parent mode ------------------------------------------------------
    # Guard against the accident that started all of this: a "sandbox" test that
    # silently wrote the real acceptance file through a default-argument path.
    real = state_store.DEFAULT_STATE_FILE
    before = fingerprint(real)
    print("state-lock stress test")
    print(f"sandbox: {SANDBOX}\n")

    # 1. lost-update control: the old code really does lose writes.
    for mode in ("naive", "locked"):
        workers, per_worker = 4, 40
        target = workers * per_worker
        got = case(target, mode, mode, workers, per_worker)
        if mode == "naive":
            print(f"[1a] old code path ({workers}x{per_worker} increments, no lock)")
            check(got < target, f"control: unlocked writers lose updates ({got}/{target} survived)")
        else:
            print(f"[1b] locked path ({workers}x{per_worker} increments)")
            check(got == target, f"no lost update under the lock ({got}/{target})")

    # 2. the actual incident: a verdict written while the driver parks.
    for mode in ("naive", "locked"):
        path = reset(f"verdict-{mode}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"milestone": "M5", "history": []}, fh)
        run_procs(
            [
                ["--worker", "park", "--file", path, "--mode", mode, "--window", "0.25"],
                ["--worker", "verdict", "--file", path, "--mode", mode],
            ]
        )
        with open(path, encoding="utf-8") as fh:
            final = json.load(fh)
        survived = (final.get("reviewed") or {}).get("M5", {}).get("verdict") == "approved"
        if mode == "naive":
            print("\n[2a] M5 incident replay, old code (verdict lands inside the read->write window)")
            check(not survived, "reproduces the incident: the unlocked driver eats a verdict written mid-window")
        else:
            print("[2b] M5 incident replay, locked")
            check(survived, "the verdict survives a park whose read started before it landed")

    # 3. commit_state must not resurrect a key the driver deleted on purpose.
    path = reset("merge.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"milestone": "M5", "pending_review": {"milestone": "M5"}, "history": []}, fh)
    state_store.use_state_file(path)
    local = {"milestone": "M6", "history": [], "done": False}
    local.pop("pending_review", None)
    state_store.commit_state(local, deleted=("pending_review",))
    with open(path, encoding="utf-8") as fh:
        on_disk = json.load(fh)
    print("\n[3] merge semantics")
    check("pending_review" not in on_disk, "a key named in deleted= stays deleted")
    check(on_disk.get("milestone") == "M6", "the driver value wins for keys it owns")

    # 4. crash recovery: a holder that dies must not wedge the file. The lock is a
    # kernel object, so killing the process without releasing is supposed to free it.
    path = reset("crash.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"counter": 0}, fh)
    state_store.use_state_file(path)
    holder = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "--worker", "hold", "--file", path],
        env=dict(os.environ, AGENTMESH_STATE_FILE=path),
        stdout=subprocess.DEVNULL,
    )
    holder.wait()
    started = time.time()
    ok = True
    try:
        state_store.update_state(bump, default={"counter": 0})
    except Exception as exc:  # noqa: BLE001 - the point is to report it
        ok = False
        print(f"        ({exc})")
    took = time.time() - started
    print("")
    print("[4] crash recovery")
    check(ok and took < 3, f"a lock held by a killed process is freed by the OS ({took:.2f}s)")

    # 4b. a lock *file* left behind by an older protocol must not block anything.
    path = reset("leftover.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"counter": 0}, fh)
    with open(path + ".lock", "w", encoding="utf-8") as fh:
        json.dump({"pid": 999999, "token": "dead-owner"}, fh)
    state_store.use_state_file(path)
    started = time.time()
    ok = True
    try:
        state_store.update_state(bump, default={"counter": 0})
    except Exception as exc:  # noqa: BLE001
        ok = False
        print(f"        ({exc})")
    took = time.time() - started
    print("")
    print("[4b] leftover lock file")
    check(ok and took < 1, f"a stale lock file from the old protocol is ignored ({took:.2f}s)")

    # 5. readers never see a torn document while writers write.
    path = reset("torn.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"counter": 0, "padding": "x" * 2000}, fh)
    state_store.use_state_file(path)
    stop = threading.Event()
    torn: list[str] = []

    def reader() -> None:
        while not stop.is_set():
            try:
                with open(path, encoding="utf-8") as fh:
                    json.load(fh)
            except json.JSONDecodeError as exc:
                torn.append(f"torn json: {exc}")
            except FileNotFoundError:
                torn.append("missing")
            except PermissionError:
                # Windows can refuse a read while the writer holds the replace open;
                # that is a scheduling detail, not a torn document, so just retry.
                pass

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    run_procs([["--worker", "inc", "--file", path, "--n", "40", "--mode", "locked"] for _ in range(3)])
    stop.set()
    thread.join()
    print("\n[5] atomic replace")
    check(not torn, f"120 locked writes, 0 torn reads ({len(torn)} bad)")

    after = fingerprint(real)
    print("")
    print("[6] blast radius")
    check(before == after, f"the real acceptance file is byte-identical after the run ({real})")

    print()
    if FAILS:
        print(f"RESULT: {len(FAILS)} check(s) failed")
        for f in FAILS:
            print(f"  - {f}")
        return 1
    print("RESULT: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
