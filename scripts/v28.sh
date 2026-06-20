#!/usr/bin/env bash
# v28 — REAL VSCode rich outputs: matplotlib inline figures + tqdm render in
#       actual notebook cells, and the tqdm.notebook widget final-state text is
#       restored from the mirror. Proves the image bytes reach the cell as a real
#       PNG (image/png item, PNG magic) — not a "<Figure ...>" placeholder.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v28 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v28
FIX="$WORK/rich.py"
cat >"$FIX" <<'PY'
# %% mpl
%matplotlib inline
import matplotlib.pyplot as plt
plt.plot([0, 1, 2], [0, 1, 4])
plt.show()

# %% tqdm
from tqdm import tqdm
import sys
for i in tqdm(range(20), file=sys.stderr):
    pass

# %% nb
from tqdm.notebook import tqdm as tnb
for i in tnb(range(5)):
    pass
PY

# Start the daemon explicitly so its kernel runs under the venv that HAS
# matplotlib (the extension would otherwise auto-start under the chosen interp).
start_daemon || fail "daemon start failed"
echo "v28: daemon up (pid $(daemon_pid)); real VSCode will render matplotlib/tqdm (xvfb)"
export TITHON_FIXTURE="$FIX" TITHON_WORKSPACE="$WORK" TITHON_SUITE="richoutputs"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -40
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode rich-output test failed (rc=$rc)"
echo "RESULT v28 PASS real VSCode: matplotlib image/png + terminal tqdm 100% + tqdm.notebook widget text restored; $passed_line"
