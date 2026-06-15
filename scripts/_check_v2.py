"""v2 checker: snapshot < 2s, folded output is a single final progress line,
journal preserves >= 1000 raw stream messages."""
import json
import sqlite3
import sys

home, elapsed_ms = sys.argv[1], int(sys.argv[2])


def fail(msg: str) -> None:
    print(msg)
    sys.exit(1)


snapshot = None
with open(f"{home}/attach.ndjson") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        m = json.loads(line)
        if m.get("op") == "snapshot":
            snapshot = m

if snapshot is None:
    fail("no snapshot received")
if elapsed_ms >= 2000:
    fail(f"snapshot took {elapsed_ms}ms (>= 2000ms)")

execs = snapshot.get("executions", [])
if len(execs) != 1:
    fail(f"expected 1 execution in snapshot, got {len(execs)}")
streams = [o for o in execs[0]["outputs"] if o.get("output_type") == "stream"]
if len(streams) != 1:
    fail(f"expected 1 folded stream output, got {len(streams)}")
text = streams[0]["text"]
body = text.strip()
if "\n" in body:
    fail(f"folded output is not a single line: {len(body.splitlines())} lines")
if "50000/50000" not in body:
    fail(f"final progress line missing 50000/50000: {body[:80]!r}")

db = sqlite3.connect(f"file:{home}/sessions/default/journal.db?mode=ro", uri=True)
raw = db.execute("SELECT COUNT(*) FROM messages WHERE msg_type='stream'").fetchone()[0]
if raw < 1000:
    fail(f"journal has only {raw} raw stream messages (< 1000)")

print(f"snapshot {elapsed_ms}ms (<2000), folded to 1 line, {raw} raw stream msgs preserved")
