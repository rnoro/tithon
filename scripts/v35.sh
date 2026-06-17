#!/usr/bin/env bash
# v35 — per-session project-local artifacts + readable, project-qualified session
# dirs (ADR-044), over a REAL daemon+kernel.
#
# Bug: every session shared the daemon's SINGLE launch cwd, so a second project's
# images landed in the first project's .tithon/outputs (and kernel/journal dirs
# were opaque hashes). Fix: the client passes its project root (`workdir`) on
# attach; the daemon roots that session's artifacts + kernel cwd there, and names
# the kernel/journal dir readably under ~/.tithon/sessions/<project>-<hash>/<rel>.
# Two SEPARATE projects with a SAME-NAMED file must not collide, and kernel.json
# (which holds an hmac key) must stay in ~/.tithon, never in a repo.
. "$(dirname "$0")/lib.sh"

fail() { echo "RESULT v35 FAIL $1"; exit 1; }
trap cleanup_procs EXIT

"$PY" -c "import matplotlib, matplotlib_inline" 2>/dev/null \
  || fail "matplotlib/matplotlib_inline missing from daemon venv"

setup_env v35
PROJ_A="$TITHON_HOME/projA"; PROJ_B="$TITHON_HOME/projB"
mkdir -p "$PROJ_A" "$PROJ_B"
start_daemon || fail "daemon start failed"   # daemon cwd = $WORK (neither project)
echo "v35: daemon up (pid $(daemon_pid)); daemon cwd=$WORK"

SOCK="$TITHON_HOME/daemon.sock"
CODE='import matplotlib; matplotlib.use("module://matplotlib_inline.backend_inline"); import matplotlib.pyplot as plt; from IPython.display import display; fig,ax=plt.subplots(); ax.plot([1,2,3]); display(fig); print("OK")'

timeout 150 "$PY" "$ROOT/scripts/_workdir_client.py" "$SOCK" "file://$PROJ_A/train.py" "$PROJ_A" "$CODE" \
  >"$TITHON_HOME/a.out" 2>&1 || fail "session A failed: $(tail -3 "$TITHON_HOME/a.out")"
timeout 150 "$PY" "$ROOT/scripts/_workdir_client.py" "$SOCK" "file://$PROJ_B/train.py" "$PROJ_B" "$CODE" \
  >"$TITHON_HOME/b.out" 2>&1 || fail "session B failed: $(tail -3 "$TITHON_HOME/b.out")"
grep -q "DONE ok" "$TITHON_HOME/a.out" || fail "A did not finish ok: $(tail -3 "$TITHON_HOME/a.out")"
grep -q "DONE ok" "$TITHON_HOME/b.out" || fail "B did not finish ok: $(tail -3 "$TITHON_HOME/b.out")"

a_png=$(find "$PROJ_A/.tithon/outputs" -name '*.png' 2>/dev/null | wc -l | tr -d ' ')
b_png=$(find "$PROJ_B/.tithon/outputs" -name '*.png' 2>/dev/null | wc -l | tr -d ' ')
# cross-contamination: neither project's images may land in the daemon's cwd.
cwd_png=$(find "$WORK/.tithon/outputs" -name '*.png' 2>/dev/null | wc -l | tr -d ' ')
# readable, project-qualified, distinct session dirs (not an opaque flat hash).
a_dir=$(find "$TITHON_HOME/sessions" -type d -name 'train.py' -path '*projA*' 2>/dev/null | head -1)
b_dir=$(find "$TITHON_HOME/sessions" -type d -name 'train.py' -path '*projB*' 2>/dev/null | head -1)
proj_kernel=$(find "$PROJ_A" "$PROJ_B" -name 'kernel.json' 2>/dev/null | head -1)

echo "v35: projA png=$a_png  projB png=$b_png  daemon_cwd png=$cwd_png"
echo "v35: A session dir=$a_dir"
echo "v35: B session dir=$b_dir"

[ "$a_png" -ge 1 ] || fail "projA image not in its own .tithon/outputs (got $a_png)"
[ "$b_png" -ge 1 ] || fail "projB image not in its own .tithon/outputs (got $b_png)"
[ "$cwd_png" -eq 0 ] || fail "$cwd_png image(s) leaked into the daemon cwd (the multi-project bug)"
[ -n "$a_dir" ] || fail "no readable projA session dir under sessions/<project>/.../train.py"
[ -n "$b_dir" ] || fail "no readable projB session dir"
[ "$a_dir" != "$b_dir" ] || fail "same-named files in different projects collided to one dir"
[ -f "$a_dir/journal.db" ] && [ -f "$a_dir/kernel.json" ] || fail "A session dir missing kernel/journal in ~/.tithon"
[ -z "$proj_kernel" ] || fail "kernel.json leaked into a project repo: $proj_kernel"

echo "RESULT v35 PASS per-project artifacts (A=$a_png B=$b_png, 0 in daemon cwd) + readable distinct session dirs (projA/.../train.py != projB) + kernel.json stays in ~/.tithon"
