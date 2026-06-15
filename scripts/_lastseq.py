"""Print the max event seq seen in an attach NDJSON capture (fallback: argv[2])."""
import json
import sys

path, last = sys.argv[1], int(sys.argv[2])
with open(path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            m = json.loads(line)
        except json.JSONDecodeError:
            continue
        for key in ("seq", "max_seq"):
            v = m.get(key)
            if isinstance(v, int) and v > last:
                last = v
print(last)
