"""Run one cell in a file-uri session with an explicit project workdir (v35).

Drives the protocol the extension uses: attach (carrying `workdir` = the file's
project root) + execute with an origin, then wait for the done event. Prints
``DONE <status>``.
"""
import asyncio
import json
import sys

from websockets.asyncio.client import unix_connect


async def main(sock_path: str, session: str, workdir: str, code: str) -> None:
    async with unix_connect(sock_path, max_size=None) as ws:
        await ws.send(json.dumps(
            {"op": "attach", "last_seen_seq": -1, "session": session, "workdir": workdir}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("op") == "sync":
                break
        await ws.send(json.dumps({
            "op": "execute", "code": code, "session": session, "workdir": workdir,
            "origin": {"uri": session, "index": 0, "range": {"start": 0, "end": 0}},
        }))
        exec_id = None
        while True:
            m = json.loads(await ws.recv())
            if m.get("op") == "execute_ack":
                exec_id = m["exec_id"]
            elif (m.get("op") == "event" and m.get("kind") == "done"
                  and m.get("exec_id") == exec_id):
                print(f"DONE {m.get('payload', {}).get('status')}", flush=True)
                return


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]))
