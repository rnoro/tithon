#!/usr/bin/env bash
# v61 — a cloned repository restores its outputs (ADR-114), over a REAL daemon+kernel.
#
# The gap this closes: a percent-format .py carries no outputs, and the journal
# that does carry them is machine-local (binary SQLite+WAL, unshareable). So a
# colleague who cloned a finished training notebook saw an empty file — the one
# thing .ipynb does better. The daemon now projects each file's folds onto a
# text sidecar INSIDE the project (.tithon/cells/<rel>.json), with images left as
# real files in .tithon/outputs/ rather than embedded.
#
# Verified through an ACTUAL git commit + clone, not a directory copy: the point
# is that these files survive a repository round trip. The clone gets a DIFFERENT
# project path, so the daemon derives a different session dir and its journal is
# genuinely empty — everything asserted below came from the sidecar.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v61 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

"$PY" -c "import matplotlib, matplotlib_inline" 2>/dev/null \
  || fail "matplotlib/matplotlib_inline missing from daemon venv"
command -v git >/dev/null || fail "git not available"

setup_env v61
PROJ_A="$TITHON_HOME/projA"; PROJ_B="$TITHON_HOME/projB"
mkdir -p "$PROJ_A"
start_daemon || fail "daemon start failed"
echo "v61: daemon up (pid $(daemon_pid))"

SOCK="$TITHON_HOME/daemon.sock"
CODE='import matplotlib; matplotlib.use("module://matplotlib_inline.backend_inline"); import matplotlib.pyplot as plt; from IPython.display import display; fig,ax=plt.subplots(); ax.plot([1,2,3]); display(fig); print("TRAINED")'

# --- author runs the notebook ------------------------------------------------
timeout 150 "$PY" "$ROOT/scripts/_workdir_client.py" "$SOCK" "file://$PROJ_A/train.py" "$PROJ_A" "$CODE" \
  >"$TITHON_HOME/a.out" 2>&1 || fail "author run failed: $(tail -3 "$TITHON_HOME/a.out")"
grep -q "DONE ok" "$TITHON_HOME/a.out" || fail "author run did not finish ok"

SIDECAR="$PROJ_A/.tithon/cells/train.py.json"
[ -f "$SIDECAR" ] || fail "no sidecar published at $SIDECAR"
a_png=$(find "$PROJ_A/.tithon/outputs" -name '*.png' 2>/dev/null | wc -l | tr -d ' ')
[ "$a_png" -ge 1 ] || fail "author has no image in .tithon/outputs (got $a_png)"
# The sidecar must reference the image, never embed it: embedding is what makes
# an .ipynb balloon one base64 blob per frame.
grep -q '"\$tithon_artifact"' "$SIDECAR" || fail "sidecar carries no artifact reference"
grep -q 'iVBORw0KGgo' "$SIDECAR" && fail "sidecar embedded base64 PNG data"
grep -q 'TRAINED' "$SIDECAR" || fail "sidecar lost the stream output"
# A committed file must not carry the author's filesystem layout. It is also not
# merely cosmetic: the client scopes a restore to the file's own runs, so an
# execution still naming the author's absolute path is filtered out on the
# reader's machine and its outputs never reach the cells.
grep -q "$PROJ_A" "$SIDECAR" && fail "sidecar leaked the author's absolute path"
echo "v61: author sidecar $(wc -c <"$SIDECAR") bytes, $a_png png"

# --- share it through a real repository --------------------------------------
( cd "$PROJ_A" && git init -q . && git config user.email t@t && git config user.name t \
  && git add -A && git commit -qm "trained" ) || fail "git commit failed"
tracked=$(cd "$PROJ_A" && git ls-files .tithon | wc -l | tr -d ' ')
[ "$tracked" -ge 2 ] || fail "only $tracked .tithon file(s) tracked (sidecar+image expected)"
git clone -q "$PROJ_A" "$PROJ_B" || fail "git clone failed"
[ -f "$PROJ_B/.tithon/cells/train.py.json" ] || fail "sidecar did not survive the clone"
b_png=$(find "$PROJ_B/.tithon/outputs" -name '*.png' 2>/dev/null | wc -l | tr -d ' ')
[ "$b_png" -ge 1 ] || fail "image did not survive the clone (got $b_png)"
echo "v61: cloned ($tracked tracked .tithon files, $b_png png)"

# --- reader opens it: attach only, never executes ----------------------------
timeout 150 "$PY" "$ROOT/scripts/_clone_client.py" "$SOCK" "file://$PROJ_B/train.py" "$PROJ_B" \
  >"$TITHON_HOME/b.out" 2>&1 || fail "clone attach failed: $(tail -5 "$TITHON_HOME/b.out")"
cat "$TITHON_HOME/b.out"
kv() { grep "^$1=" "$TITHON_HOME/b.out" | head -1 | cut -d= -f2-; }

[ "$(kv EXECS)" = "1" ] || fail "clone restored $(kv EXECS) execution(s), expected 1"
[ "$(kv STATUSES)" = "done" ] || fail "restored status is '$(kv STATUSES)', expected done"
case "$(kv KINDS)" in
  *stream*display_data*) : ;;
  *) fail "restored output kinds are '$(kv KINDS)', expected stream + display_data" ;;
esac
[ "$(kv STREAM_TEXT)" = "TRAINED" ] || fail "stream text restored as '$(kv STREAM_TEXT)'"
# Rebound to the READER's file, so `restoreInto`'s per-file scoping keeps it.
[ "$(kv ORIGIN_URIS)" = "file://$PROJ_B/train.py" ] \
  || fail "restored origin is '$(kv ORIGIN_URIS)', expected the reader's own uri"
[ "$(kv ARTIFACT_FOUND)" = "True" ] || fail "cloned image not servable (found=$(kv ARTIFACT_FOUND))"
[ "$(kv ARTIFACT_B64_LEN)" -gt 100 ] || fail "cloned image served $(kv ARTIFACT_B64_LEN) b64 chars"

# The reader's daemon rebuilt folds and ran its startup artifact sweep against a
# journal that had just been seeded from the sidecar. Without fold hydration the
# refcount is zero and that sweep DELETES the cloned image — measured, this is
# the regression this line exists to catch.
b_png_after=$(find "$PROJ_B/.tithon/outputs" -name '*.png' 2>/dev/null | wc -l | tr -d ' ')
[ "$b_png_after" -ge 1 ] || fail "the clone-side startup sweep deleted the shared image"

# The reader's own journal lives in THEIR home, never in the shared repo — the
# hmac-carrying kernel.json likewise (ADR-044 unchanged by this feature).
proj_kernel=$(find "$PROJ_B" -name 'kernel.json' -o -name 'journal.db' 2>/dev/null | head -1)
[ -z "$proj_kernel" ] || fail "machine-local state leaked into the repo: $proj_kernel"
b_dir=$(find "$TITHON_HOME/sessions" -type d -name 'train.py' -path '*projB*' 2>/dev/null | head -1)
[ -f "$b_dir/journal.db" ] || fail "no reader-side journal under ~/.tithon"

echo "RESULT v61 PASS cloned repo restores 1 execution (stream 'TRAINED' + image served, $b_png_after png survived the sweep); no journal/kernel.json in the repo"
