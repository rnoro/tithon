"""v3 checker: real PNG file in .tithon/outputs/, journal references it
(artifacts table + message content), fresh attach delivers the reference."""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

home, work = sys.argv[1], Path(sys.argv[2])

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def fail(msg: str) -> None:
    print(msg)
    sys.exit(1)


pngs = sorted((work / ".tithon" / "outputs").glob("*.png"))
if not pngs:
    fail("no png files under .tithon/outputs/")
valid = {}
for p in pngs:
    raw = p.read_bytes()
    if not raw.startswith(PNG_MAGIC):
        fail(f"{p.name}: invalid PNG magic")
    valid[hashlib.sha256(raw).hexdigest()] = p

db = sqlite3.connect(f"file:{home}/sessions/default/journal.db?mode=ro", uri=True)
arts = db.execute("SELECT sha256, mime, rel_path, bytes_len FROM artifacts").fetchall()
if not arts:
    fail("artifacts table empty")
art = None
for sha, mime, rel_path, bytes_len in arts:
    if mime == "image/png" and sha in valid:
        if (work / rel_path).resolve() != valid[sha].resolve():
            fail(f"artifact rel_path {rel_path} does not match file {valid[sha]}")
        art = (sha, rel_path, bytes_len)
if art is None:
    fail("no artifact row matches an on-disk png (sha256)")
sha, rel_path, bytes_len = art
if bytes_len != (work / rel_path).stat().st_size:
    fail("artifact bytes_len mismatch")

refs = db.execute(
    "SELECT COUNT(*) FROM messages WHERE content_json LIKE ?", (f"%{rel_path}%",)
).fetchone()[0]
if refs < 1:
    fail("no journal message references the artifact rel_path")
b64 = db.execute(
    "SELECT COUNT(*) FROM messages WHERE LENGTH(content_json) > 20000"
).fetchone()[0]
if b64 > 0:
    fail("journal contains suspiciously large message content (base64 embedded?)")

attached = False
with open(f"{home}/attach.ndjson") as f:
    for line in f:
        line = line.strip()
        if line and rel_path in line:
            m = json.loads(line)
            if m.get("op") == "snapshot":
                attached = True
if not attached:
    fail("fresh attach snapshot does not carry the artifact reference")

print(f"valid PNG {rel_path} ({bytes_len}B), journal references it, attach delivers ref")
