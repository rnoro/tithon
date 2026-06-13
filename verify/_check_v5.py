"""v5 checker: a fresh attach snapshot must hold the completed tqdm widget.

Reads the NDJSON event stream of `tithon attach --since 0 --once` on stdin,
finds the full snapshot, and asserts the Widget State Mirror contains a
FloatProgress whose value equals its max equals the requested total. Prints a
one-line summary and exits non-zero on any failure.
"""
import json
import sys

TOTAL = int(sys.argv[1]) if len(sys.argv) > 1 else 50000


def main() -> int:
    snap = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("op") == "snapshot":
            snap = msg
    if snap is None:
        print("v5check: no snapshot received", file=sys.stderr)
        return 1

    widgets = snap.get("widgets") or {}
    state = widgets.get("state") or {}
    if not state:
        print("v5check: snapshot has no widget models", file=sys.stderr)
        return 1

    progress = [
        (mid, e) for mid, e in state.items() if e.get("model_name") == "FloatProgressModel"
    ]
    if not progress:
        print(f"v5check: no FloatProgressModel among {len(state)} models", file=sys.stderr)
        return 1

    mid, entry = progress[0]
    s = entry.get("state") or {}
    value, mx = s.get("value"), s.get("max")
    if value != mx:
        print(f"v5check: FloatProgress value({value}) != max({mx})", file=sys.stderr)
        return 1
    if value != TOTAL:
        print(f"v5check: FloatProgress value({value}) != total({TOTAL})", file=sys.stderr)
        return 1

    print(
        f"v5check OK: {len(state)} widget models; FloatProgress final value=={value}==max==total"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
