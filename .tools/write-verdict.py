"""Write one acceptance verdict into the shared state file — the only safe way.

The old one-off scripts did `json.load` → mutate → `json.dump` with no lock, so a
verdict written while the auto-advance driver was parking a milestone could be
overwritten milliseconds later. This goes through `.tools/state_store.py`, which
takes the lock, reads inside it, and merges instead of overwriting.

    python .tools/write-verdict.py M2 --verdict approved --note "tsc 0 · 97/97"
    python .tools/write-verdict.py M5 --verdict rejected --note-file verdict.md
    python .tools/write-verdict.py --show          # print what is recorded now

`--by` defaults to `weiyang` (the human owner of the acceptance gate); an agent
writing a verdict must say so explicitly, because the report distinguishes them.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from state_store import commit_state, read_state, write_verdict  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("milestone", nargs="?", help="M1..Mn")
    ap.add_argument("--verdict", choices=["approved", "rejected"])
    ap.add_argument("--by", default="weiyang")
    ap.add_argument("--note", default="")
    ap.add_argument("--note-file", default="")
    ap.add_argument("--show", action="store_true")
    ap.add_argument("--key", action="append", default=[], help="extra k=v recorded with the verdict")
    args = ap.parse_args()

    if args.show:
        state = read_state()
        out = {
            "milestone": state.get("milestone"),
            "done": state.get("done"),
            "retries": state.get("retries"),
            "pending_review": state.get("pending_review"),
            "reviewed": {k: v.get("verdict") for k, v in (state.get("reviewed") or {}).items()},
            "history": [h.get("milestone") for h in state.get("history") or []],
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    if not args.milestone or not args.verdict:
        ap.error("milestone and --verdict are required (or use --show)")

    note = args.note
    if args.note_file:
        with open(args.note_file, encoding="utf-8") as fh:
            note = fh.read().strip()

    verdict = {
        "verdict": args.verdict,
        "by": args.by,
        "note": note,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    for pair in args.key:
        k, _, v = pair.partition("=")
        if not k:
            ap.error(f"--key expects k=v, got {pair!r}")
        verdict[k] = v

    write_verdict(args.milestone, verdict)
    # `milestone` / `pending_review` belong to the driver: a reviewer records the
    # verdict and nothing else, so the two writers never fight over the same key.
    state = read_state()
    print(
        f"{args.milestone} {args.verdict} recorded by {args.by}; "
        f"mission milestone={state.get('milestone')} done={state.get('done')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
