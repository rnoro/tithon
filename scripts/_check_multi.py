"""v50 assertions: two clients on the SAME session see the SAME event stream.

Reads the NDJSON transcripts produced by `_multi_client.py` (plus the NDJSON of a
later `tithon attach --since K`) and checks the multi-client half of the
snapshot+delta contract:

  A. every client's own stream is strictly seq-ordered and duplicate-free;
  B. in the window both clients were attached for, their event lists are
     BYTE-IDENTICAL — same seqs, same kinds, same payloads, same order;
  C. a cell submitted by client A is delivered to client B and vice versa;
  D. a client that leaves does not take the stream with it (the survivor keeps
     receiving) and does not receive what happened after it left;
  E. delta replay from seq K equals what a live client received after K.

Prints `v50: ...` progress lines; exits 1 with `RESULT v50 FAIL ...` on the
first failed assertion.
"""

import argparse
import json
import sys


def die(msg: str) -> None:
    print(f"RESULT v50 FAIL {msg}")
    sys.exit(1)


def load(path: str) -> list[dict]:
    frames = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                frames.append(json.loads(line))
            except json.JSONDecodeError:
                die(f"{path}: unparsable NDJSON line {line[:120]!r}")
    return frames


def events(frames: list[dict]) -> list[dict]:
    return [m for m in frames if m.get("op") == "event"]


def sync_seq(frames: list[dict], who: str) -> int:
    for m in frames:
        if m.get("op") == "sync":
            return int(m["seq"])
    die(f"{who} never received a `sync` frame — it was not attached")
    raise AssertionError  # unreachable


def text_of(ev: dict) -> str:
    """Concatenated text of a stream/error event (marker search)."""
    if ev.get("kind") != "output":
        return ""
    p = ev.get("payload", {})
    c = p.get("content", {}) or {}
    if p.get("msg_type") == "stream":
        return c.get("text", "") or ""
    if p.get("msg_type") == "error":
        return "\n".join(c.get("traceback", []) or [])
    return ""


def has_marker(evs: list[dict], marker: str) -> bool:
    return any(marker in text_of(e) for e in evs)


COMM_TYPES = ("comm_open", "comm_msg", "comm_close")


def comm_events(evs: list[dict]) -> list[dict]:
    """Every frame carrying a Jupyter comm message, in EITHER wire shape.

    Matching on `payload.msg_type` rather than on `kind` is deliberate: the whole
    point of the check below is that the two shapes must not both exist, so the
    finder must be able to see the wrong one.
    """
    return [e for e in evs if (e.get("payload") or {}).get("msg_type") in COMM_TYPES]


def comm_state(evs: list[dict], comm_id: str | None = None) -> dict:
    """Fold the comm frames the way a client's widget mirror would."""
    models: dict[str, dict] = {}
    for e in comm_events(evs):
        p = e["payload"]
        cid, data = p.get("comm_id"), (p.get("data") or {})
        if p["msg_type"] == "comm_open":
            models[cid] = dict(data.get("state") or {})
        elif p["msg_type"] == "comm_msg" and data.get("method") in ("update", "echo_update"):
            models.setdefault(cid, {}).update(data.get("state") or {})
        elif p["msg_type"] == "comm_close":
            models.pop(cid, None)
    return models if comm_id is None else models.get(comm_id, {})


def check_comm_shape(evs: list[dict], who: str) -> int:
    """Comm frames must reach every client as `kind: "widget"`.

    `event_from_message`'s docstring states the contract — "live broadcast ==
    replay" — and comm is the one message class that used to be hand-built at the
    broadcast site, so replay rebuilt it through the generic branch and produced
    `kind: "output"` instead. A client dispatches `applyWidgetEvent` only from
    `case "widget"`, so the wrong kind means the widget mirror silently stops
    advancing.
    """
    comm = comm_events(evs)
    if not comm:
        die(
            f"{who}: no comm/widget events at all — the widget fixture did not run "
            f"(ipywidgets missing, or the cell failed), so nothing here was verified"
        )
    for e in comm:
        if e.get("kind") != "widget":
            die(
                f"{who}: comm frame seq {e.get('seq')} arrived as kind={e.get('kind')!r}, "
                f"expected 'widget' — live broadcast and replay disagree on the wire "
                f"shape, and a client only mirrors widgets from kind=='widget': "
                f"{json.dumps(e)[:220]}"
            )
    return len(comm)


def check_monotonic(evs: list[dict], who: str) -> None:
    seen = set()
    prev = 0
    for e in evs:
        s = e.get("seq")
        if not isinstance(s, int):
            die(f"{who}: event without an integer seq: {json.dumps(e)[:160]}")
        if s in seen:
            die(f"{who}: seq {s} delivered TWICE")
        if s < prev:
            die(f"{who}: seq went backwards ({prev} -> {s}) — delivery is not ordered")
        seen.add(s)
        prev = s


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", required=True)
    ap.add_argument("--b", required=True)
    ap.add_argument("--replay", required=True)
    ap.add_argument("--since", type=int, required=True)
    ap.add_argument("--marker-a", required=True)
    ap.add_argument("--marker-b", required=True)
    ap.add_argument("--marker-late", required=True)
    ap.add_argument(
        "--widget-value",
        type=int,
        required=True,
        help="value the late cell sets on the widget; must survive replay",
    )
    args = ap.parse_args()

    fa, fb, fr = load(args.a), load(args.b), load(args.replay)
    ea, eb, er = events(fa), events(fb), events(fr)
    if not ea:
        die("client A recorded no events at all")
    if not eb:
        die("client B recorded no events at all")

    # -- A. per-client ordering ------------------------------------------------
    check_monotonic(ea, "client A")
    check_monotonic(eb, "client B")

    ca, cb = sync_seq(fa, "client A"), sync_seq(fb, "client B")
    cut = max(ca, cb)
    end = ea[-1]["seq"]  # A stopped on its last `done`
    if end <= cut:
        die(f"client A received nothing after the attach cutoff (sync={ca}/{cb}, last={end})")

    # -- B. identical streams in the shared window -----------------------------
    wa = [e for e in ea if e["seq"] > cut]
    wb = [e for e in eb if cut < e["seq"] <= end]
    if len(wa) != len(wb):
        sa = [e["seq"] for e in wa]
        sb = [e["seq"] for e in wb]
        die(
            f"clients disagree on the event set in ({cut},{end}]: "
            f"A has {len(wa)} {sa}, B has {len(wb)} {sb}; "
            f"A-only={sorted(set(sa) - set(sb))} B-only={sorted(set(sb) - set(sa))}"
        )
    for x, y in zip(wa, wb, strict=True):
        if x != y:
            die(
                f"clients disagree on event seq {x.get('seq')}/{y.get('seq')}: "
                f"A={json.dumps(x)[:200]} B={json.dumps(y)[:200]}"
            )
    print(
        f"v50: clients agree on {len(wa)} events in seq ({cut},{end}] "
        f"(identical seq/kind/payload/order)"
    )

    # -- C. cross-client delivery ---------------------------------------------
    # Each marker is printed by a cell submitted over the OTHER client's socket
    # for at least one of the two, so this is the fan-out assertion.
    for who, evs in (("A", wa), ("B", wb)):
        for marker in (args.marker_a, args.marker_b):
            if not has_marker(evs, marker):
                die(
                    f"client {who} never received {marker} — "
                    f"a run submitted on one connection did not reach the other client"
                )
    # ...and they are two DISTINCT executions, not one echoed twice.
    ids = {
        e["exec_id"] for e in wa if has_marker([e], args.marker_a) or has_marker([e], args.marker_b)
    }
    if len(ids) != 2:
        die(f"expected the two markers to belong to 2 distinct executions, got {sorted(ids)}")
    print(
        f"v50: both clients received both submissions ({args.marker_a}, {args.marker_b}) "
        f"across executions {sorted(ids)}"
    )

    # ...including the widget's comm traffic, in the one wire shape a client mirrors.
    n_comm = check_comm_shape(wa, "client A (shared window)")
    check_comm_shape(wb, "client B (shared window)")
    print(f"v50: {n_comm} comm frame(s) reached BOTH clients as kind='widget'")

    # -- D. departure isolation ------------------------------------------------
    if has_marker(ea, args.marker_late):
        die(f"client A received {args.marker_late}, which ran after it disconnected")
    if not has_marker(eb, args.marker_late):
        die(
            f"the surviving client B never received {args.marker_late} — "
            f"a client disconnecting broke the remaining client's stream"
        )
    print(f"v50: after A disconnected, B still received {args.marker_late}")

    # -- E. delta replay == live stream ---------------------------------------
    if not er:
        die(f"the replay attach (--since {args.since}) returned no events")
    check_monotonic(er, "replay client")
    bend = eb[-1]["seq"]
    rb = [e for e in eb if e["seq"] > args.since]
    rr = [e for e in er if args.since < e["seq"] <= bend]
    if not rb:
        die(f"nothing to compare: client B saw no event after seq {args.since}")
    # Checked before the generic frame diff so the comm divergence is reported as
    # itself rather than as "these two frames differ somewhere".
    n = check_comm_shape(rr, f"replay from seq {args.since}")
    check_comm_shape(rb, "client B (replay window, live)")
    # The replay window must carry BOTH comm shapes — an open (the second widget
    # the late cell creates) and a state-changing update — or a fix that only
    # handled one of them would pass.
    kinds = {(e["payload"] or {}).get("msg_type") for e in comm_events(rr)}
    for want in ("comm_open", "comm_msg"):
        if want not in kinds:
            die(
                f"replay from seq {args.since} carries no {want} (saw {sorted(kinds)}) — "
                f"the widget fixture did not put both comm shapes after K"
            )
    # ...and the replayed frames must fold to the same widget state a live client
    # folded, not merely be structurally equal.
    live_models, replay_models = comm_state(rb), comm_state(rr)
    if live_models != replay_models:
        die(
            f"widget state folded from the replay differs from the live fold: "
            f"live={json.dumps(live_models)[:200]} replay={json.dumps(replay_models)[:200]}"
        )
    if not any(m.get("value") == args.widget_value for m in replay_models.values()):
        die(
            f"no replayed widget reached value {args.widget_value}; folded state was "
            f"{json.dumps(replay_models)[:200]}"
        )
    print(
        f"v50: replayed comm folds to the same widget state as live "
        f"({len(replay_models)} model(s), value {args.widget_value} present)"
    )
    if len(rb) != len(rr):
        die(
            f"replay from seq {args.since} disagrees with the live stream: "
            f"live {len(rb)} events {[e['seq'] for e in rb]}, "
            f"replay {len(rr)} events {[e['seq'] for e in rr]}"
        )
    for x, y in zip(rb, rr, strict=True):
        if x != y:
            die(
                f"replay differs from live at seq {x.get('seq')}: "
                f"live={json.dumps(x)[:200]} replay={json.dumps(y)[:200]}"
            )
    print(
        f"v50: delta replay from seq {args.since} reproduces the live stream "
        f"exactly ({len(rr)} events)"
    )

    # The replay window contains the post-disconnect widget update, so it pins the
    # shape a RESUMING client is handed — the path where the live frame is rebuilt
    # from the journal rather than broadcast directly.
    print(f"v50: {n} comm frame(s) survive delta replay as kind='widget'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
