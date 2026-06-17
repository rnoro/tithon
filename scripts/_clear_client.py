"""Drive the daemon's clear_output op for v34.

Attach, collect every execution that currently has folded output, send a
clear_output for them, then open a FRESH connection and re-attach — a resync must
NOT restore the cleared output (that was the bug). Prints BEFORE/CLEARED/AFTER.
"""
import asyncio
import json
import sys

from websockets.asyncio.client import unix_connect


async def _snapshot(ws) -> dict:
    await ws.send(json.dumps({"op": "attach", "last_seen_seq": 0, "session": "default"}))
    snap: dict = {}
    while True:
        m = json.loads(await ws.recv())
        if m.get("op") == "snapshot":
            snap = m
        if m.get("op") == "sync":
            return snap


def _count_outputs(snap: dict) -> int:
    return sum(len(e.get("outputs") or []) for e in snap.get("executions", []))


async def main(sock_path: str) -> None:
    async with unix_connect(sock_path, max_size=None) as ws:
        snap = await _snapshot(ws)
        with_output = [e["exec_id"] for e in snap.get("executions", []) if e.get("outputs")]
        print(f"BEFORE outputs={_count_outputs(snap)} execs_with_output={len(with_output)}",
              flush=True)
        await ws.send(json.dumps(
            {"op": "clear_output", "session": "default", "exec_ids": with_output}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("op") == "cleared":
                print(f"CLEARED {m.get('count')}", flush=True)
                break

    # A brand-new connection: the cleared output must stay cleared on resync.
    async with unix_connect(sock_path, max_size=None) as ws:
        snap = await _snapshot(ws)
        print(f"AFTER outputs={_count_outputs(snap)}", flush=True)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
