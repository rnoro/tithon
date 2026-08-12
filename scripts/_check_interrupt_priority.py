"""v60 assertions: the stop button outranks everything else the daemon is doing.

`SessionManager._get_session()` holds `_sessions_lock` across `Session.start()`,
and `Session.start()` waits out a real kernel spawn (`_wait_kernel_ready`, plus
`STDIN_SETTLE_S`). Any op that binds a session before it runs therefore inherits
that wait — and `asyncio.Lock` is FIFO-fair, so an op that queues behind N
in-flight creations waits for ALL of them. An interrupt that arrives while the
user is opening other files would land seconds after the cell it meant to stop.

So the daemon answers `interrupt` ABOVE the session bind. Two properties follow,
and this script measures both against a real daemon:

  A. CONTENDED — with N kernel spawns deliberately in flight, an interrupt for an
     already-running session is answered in a small fraction of the time those
     spawns take, and the signal really was delivered (`ok: true`).
  B. NO CREATION — an interrupt naming a session that does not exist answers
     `ok: false` without creating it. A session that has never run has no cell to
     stop; spawning a kernel to signal it would BE the delay property A forbids.

The pass threshold for A is derived from this host's own measured spawn time
rather than a fixed number of milliseconds, so a slow machine does not turn the
property into a stopwatch race. Before the ordering fix this test does not merely
run slow: the interrupt is answered only once every spawn has finished, so its
latency lands ABOVE the contention window, not below a fraction of it.

Prints `v60: ...` progress lines; exits 1 with `RESULT v60 FAIL ...` on the first
failed assertion.
"""

import argparse
import asyncio
import json
import sys
import time

from websockets.asyncio.client import unix_connect

#: The interrupt must be answered within this fraction of the contention window.
#: Generous on purpose — the property is "does not wait for the spawns", and a
#: reply that takes even a third of the window has plainly waited for some.
LATENCY_BUDGET = 0.25
#: Give the creation connections this long to reach `_get_session()` and take the
#: lock before the interrupt is sent, so the interrupt is genuinely contending.
SETTLE_S = 0.4


def die(msg: str) -> None:
    print(f"RESULT v60 FAIL {msg}")
    sys.exit(1)


async def request(sock: str, msg: dict, reply_op: str, timeout: float) -> dict:
    """Send one op on its OWN connection and return the awaited reply."""
    async with unix_connect(sock, max_size=None) as ws:
        await ws.send(json.dumps(msg))
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                die(f"no {reply_op} reply within {timeout}s")
            raw = await asyncio.wait_for(ws.recv(), timeout=left)
            m = json.loads(raw)
            if m.get("op") == "error":
                die(f"daemon error awaiting {reply_op}: {m.get('message')}")
            if m.get("op") == reply_op:
                return m


async def create_session(sock: str, session: str, workdir: str) -> None:
    """Force a real kernel spawn: `status` on an unknown session creates it."""
    await request(sock, {"op": "status", "session": session, "workdir": workdir},
                  "status_reply", timeout=180)


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sock", required=True)
    ap.add_argument("--session", required=True, help="the session with a cell running")
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--spawns", type=int, default=4, help="concurrent kernel spawns")
    args = ap.parse_args()

    # B) An interrupt for a never-seen session must not bring one into existence.
    ghost = "file:///proj/v60-never-opened.py"
    reply = await request(args.sock, {"op": "interrupt", "session": ghost},
                          "interrupted", timeout=30)
    if reply.get("ok"):
        die(f"interrupt on a non-existent session reported ok=true ({reply})")
    live = await request(args.sock, {"op": "status"}, "status_reply", timeout=30)
    if any(s.get("session") == ghost for s in live.get("sessions", [])):
        die("interrupt CREATED a session (and spawned a kernel) for an unknown file")
    print(f"v60: interrupt on an unknown session: ok=false, no session created")

    # A) Now contend: N kernel spawns in flight, then interrupt the running one.
    t0 = time.monotonic()
    creations = [
        asyncio.create_task(
            create_session(args.sock, f"file:///proj/v60-load-{i}.py", args.workdir))
        for i in range(args.spawns)
    ]
    await asyncio.sleep(SETTLE_S)
    if all(c.done() for c in creations):
        die(f"the {args.spawns} kernel spawns finished within {SETTLE_S}s — "
            "no contention window, the measurement below would be meaningless")

    t_int = time.monotonic()
    reply = await request(args.sock, {"op": "interrupt", "session": args.session},
                          "interrupted", timeout=180)
    interrupt_s = time.monotonic() - t_int
    if not reply.get("ok"):
        die(f"interrupt on the running session reported ok=false ({reply})")

    await asyncio.gather(*creations)
    contention_s = time.monotonic() - t0
    budget = contention_s * LATENCY_BUDGET
    print(f"v60: {args.spawns} kernel spawns took {contention_s:.2f}s; "
          f"interrupt answered in {interrupt_s * 1000:.0f}ms (budget {budget:.2f}s)")
    if interrupt_s > budget:
        die(f"interrupt waited {interrupt_s:.2f}s while {args.spawns} sessions were "
            f"starting ({contention_s:.2f}s) — it is queued behind them, not prioritized")
    print(json.dumps({"interrupt_s": interrupt_s, "contention_s": contention_s}))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
