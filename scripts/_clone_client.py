"""Attach to a file session WITHOUT executing and report what was restored (v61).

Stands in for a reader who just cloned the repository and opened the notebook:
their daemon has never run this file, so everything the snapshot carries came
from the shared sidecar. Fetches the first image artifact too, since a cloned
plot is only actually restored if its bytes can still be served.

Prints one ``KEY=VALUE`` line per fact so the shell script can assert on them.
"""

import asyncio
import json
import sys

from websockets.asyncio.client import unix_connect


async def main(sock_path: str, session: str, workdir: str) -> None:
    async with unix_connect(sock_path, max_size=None) as ws:
        # last_seen_seq=0 is the "give me the full snapshot" attach the extension
        # uses on open; a negative value is a live-only attach and sends none.
        await ws.send(
            json.dumps({"op": "attach", "last_seen_seq": 0, "session": session, "workdir": workdir})
        )
        snap = None
        while True:
            m = json.loads(await ws.recv())
            if m.get("op") == "snapshot":
                snap = m
            elif m.get("op") == "sync":
                break
        if snap is None:
            print("EXECS=0")
            return

        execs = snap.get("executions", [])
        print(f"EXECS={len(execs)}")
        print(f"CLOSED_BY_USER={snap.get('closed_by_user')}")
        print(f"STATUSES={','.join(e.get('status', '?') for e in execs)}")
        print(f"ORIGIN_URIS={','.join(str((e.get('origin') or {}).get('uri')) for e in execs)}")
        print(f"CODE_SEEN={'|'.join(e.get('code', '') for e in execs)}")
        kinds, art_ids = [], []
        for e in execs:
            for out in e.get("outputs") or []:
                kinds.append(out.get("output_type", "?"))
                for value in (out.get("data") or {}).values():
                    ref = value.get("$tithon_artifact") if isinstance(value, dict) else None
                    if isinstance(ref, dict):
                        art_ids.append(ref["artifact_id"])
                        print(f"ARTIFACT_REL={ref.get('rel_path')}")
        print(f"KINDS={','.join(kinds)}")
        # Text output must survive verbatim, not just structurally.
        texts = [
            o.get("text", "")
            for e in execs
            for o in (e.get("outputs") or [])
            if o.get("output_type") == "stream"
        ]
        print(f"STREAM_TEXT={''.join(texts).strip()}")

        for aid in art_ids[:1]:
            await ws.send(
                json.dumps({"op": "get_artifact", "artifact_id": aid, "session": session})
            )
            while True:
                m = json.loads(await ws.recv())
                if m.get("op") == "artifact":
                    print(f"ARTIFACT_FOUND={m.get('found')}")
                    data = m.get("data_b64") or ""
                    print(f"ARTIFACT_B64_LEN={len(data)}")
                    break


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3]))
