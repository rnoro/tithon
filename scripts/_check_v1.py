"""v1 checker: reconstruct client-received text from 3 attach captures and
compare sequence integrity (MSG 0..59, no gap/dup) against the journal."""
import json
import re
import sqlite3
import sys

home = sys.argv[1]


def fail(msg: str) -> None:
    print(msg)
    sys.exit(1)


client_parts: list[str] = []
done_status = None
for i in (1, 2, 3):
    with open(f"{home}/attach{i}.ndjson") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            m = json.loads(line)
            op = m.get("op")
            if op == "snapshot":
                for ex in m.get("executions", []):
                    for o in ex.get("outputs", []):
                        if o.get("output_type") == "stream":
                            client_parts.append(o.get("text", ""))
            elif op == "event" and m.get("kind") == "output":
                p = m.get("payload", {})
                if p.get("msg_type") == "stream":
                    client_parts.append(p.get("content", {}).get("text", ""))
            elif op == "event" and m.get("kind") == "done":
                done_status = m.get("payload", {}).get("status")

client_text = "".join(client_parts)
nums = [int(x) for x in re.findall(r"MSG (\d+)", client_text)]
if nums != list(range(60)):
    missing = sorted(set(range(60)) - set(nums))
    dups = sorted({n for n in nums if nums.count(n) > 1})
    fail(f"client sequence broken: got {len(nums)} msgs, missing={missing[:5]}, dups={dups[:5]}")
if done_status != "ok":
    fail(f"done event missing or not ok: {done_status!r}")

db = sqlite3.connect(f"file:{home}/sessions/default/journal.db?mode=ro", uri=True)
rows = db.execute(
    "SELECT content_json FROM messages WHERE msg_type='stream' ORDER BY msg_seq"
).fetchall()
journal_text = "".join(json.loads(r[0]).get("text", "") for r in rows)
jnums = [int(x) for x in re.findall(r"MSG (\d+)", journal_text)]
if jnums != list(range(60)):
    fail(f"journal sequence broken: {len(jnums)} msgs")
if client_text != journal_text:
    fail("client-reconstructed text differs from journal text")

print(f"seq 0..59 intact across 3 attach/detach cycles ({len(rows)} journal stream msgs, client==journal)")
