"""A recording subscriber for v50 (multi-client on the SAME file/session).

Attaches to one daemon session over the unix socket, records EVERY frame it
receives as NDJSON, and optionally submits its own cells once a shell-provided
"go" file appears. Several instances run concurrently against the same session
so v50 can assert that every attached client sees the identical event stream and
that a run submitted by one client reaches the others.

Exit codes: 0 ok · 3 timeout waiting for the exit condition · 4 daemon error ·
5 the daemon dropped us as a slow client (overflow) · 6 connection closed early.
"""

import argparse
import asyncio
import json
import os
import sys
import time

from websockets.asyncio.client import unix_connect


def _parse() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--sock", required=True)
    p.add_argument("--session", required=True)
    p.add_argument("--out", required=True, help="NDJSON transcript of every frame received")
    p.add_argument("--name", default="client")
    p.add_argument("--last-seen", type=int, default=0)
    p.add_argument("--ready", help="file to create once `sync` has arrived")
    p.add_argument("--go", help="wait for this file before submitting --exec cells")
    p.add_argument(
        "--exec",
        dest="cells",
        action="append",
        default=[],
        help="code to submit on this connection (repeatable)",
    )
    p.add_argument(
        "--until-done",
        type=int,
        default=0,
        help="exit after this many `done` events have been received",
    )
    p.add_argument("--timeout", type=float, default=120.0)
    return p.parse_args()


async def _submitter(ws, a: argparse.Namespace, deadline: float) -> None:
    """Wait for the shell's barrier file, then submit this client's cells.

    Runs as its own task so the read loop keeps draining while we wait — a
    client that stops reading is a *backpressure* test (v9), not this one.
    """
    if a.go:
        while not os.path.exists(a.go):
            if time.monotonic() > deadline:
                return
            await asyncio.sleep(0.02)
    for code in a.cells:
        await ws.send(json.dumps({"op": "execute", "code": code, "session": a.session}))


async def main() -> int:
    a = _parse()
    deadline = time.monotonic() + a.timeout
    out = open(a.out, "w", buffering=1)
    dones = 0
    synced = False
    sub: asyncio.Task | None = None

    def note(msg: str) -> None:
        print(f"{a.name}: {msg}", flush=True)

    async with unix_connect(a.sock, max_size=None) as ws:
        await ws.send(
            json.dumps({"op": "attach", "last_seen_seq": a.last_seen, "session": a.session})
        )
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                note(f"TIMEOUT (synced={synced} dones={dones}/{a.until_done})")
                return 3
            try:
                raw = await asyncio.wait_for(ws.recv(), remaining)
            except (asyncio.TimeoutError, TimeoutError):
                note(f"TIMEOUT (synced={synced} dones={dones}/{a.until_done})")
                return 3
            except Exception as e:  # connection closed by the daemon
                note(f"connection closed early: {e!r}")
                return 6
            text = raw if isinstance(raw, str) else raw.decode()
            out.write(text + "\n")
            m = json.loads(text)
            op = m.get("op")
            if op == "error":
                note(f"daemon error: {m.get('message')}")
                return 4
            if op == "overflow":
                note("dropped by the daemon as a slow client")
                return 5
            if op == "sync":
                synced = True
                note(f"attached, sync seq={m.get('seq')}")
                if a.ready:
                    # create-then-rename so the shell barrier never observes a
                    # half-written marker
                    tmp = a.ready + ".tmp"
                    with open(tmp, "w") as f:
                        f.write(str(m.get("seq")))
                    os.replace(tmp, a.ready)
                if sub is None:
                    sub = asyncio.create_task(_submitter(ws, a, deadline))
                continue
            if op == "event" and m.get("kind") == "done":
                dones += 1
                note(f"done {dones}/{a.until_done} exec_id={m.get('exec_id')} seq={m.get('seq')}")
                if dones >= a.until_done:
                    if sub is not None:
                        sub.cancel()
                    out.flush()
                    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
