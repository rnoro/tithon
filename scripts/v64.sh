#!/usr/bin/env bash
# v64 — REAL VSCode: the durable per-file "Always Open With…" choice.
#       Two mechanisms verified together (ADR-115): `priority: "option"` keeps an
#       UNASSOCIATED .py resolving to the text editor without Tithon writing any
#       Global setting, and `tithon.alwaysOpenWith` writes ONE Workspace-scoped
#       `workbench.editorAssociations` key per file. Asserts:
#       (1) activation writes no Global `*.py` key and does not touch the
#       workspace associations, (2) an unassociated .py opens as TEXT, (3) the
#       opt-in adds exactly its own key (a pre-seeded association survives) and
#       performs the ordered text -> Cell View switch, (4) the pinned file then
#       resolves STRAIGHT to tithon-py with zero file-scheme text documents for
#       it — the property an open-then-convert heuristic cannot have, (5) another
#       .py in the same workspace stays text, (6) a diff of two pinned files
#       stays a TEXT diff, (7) cancel changes nothing, (8) Text Editor is an
#       explicit durable choice that beats a broad Notebook association, (9) the
#       hidden legacy inverse remains callable, and (10) Explorer/editor/toolbar
#       expose one chooser without repeating the Tithon provider name.
. "$(dirname "$0")/lib.sh"
fail() { echo "RESULT v64 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

EXT="$ROOT/extension"
ensure_extension_build || fail "extension build failed"

setup_env v64
# The pinned file lives in a subdirectory so the association pattern exercises a
# real workspace-relative path, not a bare basename.
mkdir -p "$WORK/pkg"
FIX="$WORK/pkg/train.py"
cat >"$FIX" <<'PY'
# %% setup
epochs = 3

# %% train
for i in range(epochs):
    print(f"epoch {i}")
PY
# The diff counterpart, pinned too so neither side of the diff is unassociated.
cat >"$WORK/pkg/train_prev.py" <<'PY'
# %% setup
epochs = 2
PY
# Must keep opening as plain text: proves the per-file key does not leak.
PLAIN="$WORK/library.py"
cat >"$PLAIN" <<'PY'
def helper():
    return 42
PY
# A pre-existing association Tithon did not write. Every settings assertion in
# the suite checks this key is still there, byte for byte.
mkdir -p "$WORK/.vscode"
cat >"$WORK/.vscode/settings.json" <<'JSON'
{
  "workbench.editorAssociations": {
    "*.bin": "hexEditor"
  }
}
JSON

start_daemon || fail "daemon start failed"
echo "v64: daemon up (pid $(daemon_pid)); durable open-as-Notebook association test under xvfb"

export TITHON_FIXTURE="$FIX" TITHON_HELPER="$PLAIN" TITHON_WORKSPACE="$WORK" TITHON_SUITE="editorpin"
OUT="$(mktemp)"
(cd "$EXT" && xvfb-run -a node out-int/integration/runTest.js) >"$OUT" 2>&1
rc=$?
grep -vE "Gtk-WARNING|dbus|GPU|Failed to connect|libva|Fontconfig|MESA|gbm_|vulkan|DevTools|ContextResult" "$OUT" | tail -50
passed_line="$(grep -E '[0-9]+ passing' "$OUT" | tail -1 | sed 's/^[[:space:]]*//')"
[ -z "$passed_line" ] && { rm -f "$OUT"; fail "no mocha 'passing' line (suite did not run)"; }
rm -f "$OUT"

[ "$rc" -eq 0 ] || fail "VSCode editor-association test failed (rc=$rc)"

# The suite asserts the settings shape from inside VSCode; re-read the file the
# extension actually wrote, so a passing in-memory config cannot cover a write
# that never reached .vscode/settings.json.
"$PY" - "$WORK/.vscode/settings.json" <<'PYEOF' || fail "on-disk .vscode/settings.json is wrong"
import json, re, sys
raw = open(sys.argv[1]).read()
# VSCode writes JSONC; strip line comments before parsing.
doc = json.loads(re.sub(r"^\s*//.*$", "", raw, flags=re.M))
assoc = doc.get("workbench.editorAssociations", {})
assert assoc.get("*.bin") == "hexEditor", f"seeded association lost: {assoc}"
assert assoc.get("**/pkg/train.py") == "default", f"text choice missing on disk: {assoc}"
assert "**/pkg/train_prev.py" not in assoc, f"legacy unpin did not land on disk: {assoc}"
assert "*.py" not in assoc, f"a blanket *.py key was written: {assoc}"
# The diff companion (ADR-115) exists only above the engines.vscode floor, so its
# presence is optional — but it must never disagree with the association it guards.
diff = doc.get("workbench.diffEditorAssociations", {})
assert diff in ({}, {"**/pkg/train.py": "default"}), f"unexpected diff associations: {diff}"
print("v64: on-disk associations ok:", json.dumps(assoc, sort_keys=True), json.dumps(diff, sort_keys=True))
PYEOF

echo "RESULT v64 PASS real VSCode host: one Always Open With chooser on Explorer/editor/toolbar; Notebook and Text are durable per-file choices; cancel is inert; labels do not repeat Tithon; diff stays text; legacy commands remain callable; $passed_line"
