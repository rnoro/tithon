"""A subscriber that attaches, reads the snapshot, then stops reading.

Used by v9: combined with SIGSTOP (freezing its event loop) this is a client
that never drains. The daemon must keep the kernel stream flowing for other
clients and stay responsive — and bound its own memory (the undelivered data
sits in the OS socket buffer, not daemon memory; the per-subscriber queue and
write buffer are capped, see daemon backpressure + test_backpressure.py).
"""
import asyncio
import json
import sys

from websockets.asyncio.client import unix_connect


async def main(sock_path: str, hold: float) -> None:
    async with unix_connect(sock_path, max_size=None) as ws:
        await ws.send(json.dumps({"op": "attach", "last_seen_seq": 0}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("op") == "sync":
                break
        print("stalled-client: attached; holding without reading", flush=True)
        try:
            await asyncio.sleep(hold)
        except Exception:
            pass
        print("stalled-client: released", flush=True)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], float(sys.argv[2])))
