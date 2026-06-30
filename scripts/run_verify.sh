#!/usr/bin/env bash
# Topic-based verification bundles. Run a focused bundle while developing that
# area, or a meta-bundle (fast / vscode / all). Each run builds the VSCode
# extension AT MOST ONCE (shared across every real-VSCode test in the bundle)
# and prints a per-test RESULT table + summary.
#
# Usage: run_verify.sh <bundle>
#   Topic bundles (a test lives in exactly one):
#     core         v1 v2 v3 v4            journal / fold / artifact / daemon-crash survival   (hermetic)
#     serializer   v6                     percent <-> notebook round-trip                      (hermetic)
#     backpressure v9                     slow-client host protection                          (hermetic)
#     widgets      v5 v29 v30             ipywidget mirror + html-manager render + live anim
#     restore      v7 v8 v15 v16 v22 v38  reconnect: output + cell-state restore, orphan
#     livesync     v10 v11 v12 v13 v14 v33 v37   live streaming into cells (native run, edits, display)
#     kernels      v17 v18 v19 v20 v21 v23 v24 v26 v40   per-file kernels + lifecycle (restart/interrupt/terminate/autostart)
#     richoutputs  v27 v28 v31 v34 v35    matplotlib/tqdm images, live-plot GC, durable clear, storage
#     notebook     v32 v39 v41 v42 v43 v44  text <-> Notebook, ruff/ty + Pylance LSP   (v25/v36 merged into v39)
#   Meta bundles:
#     fast    every hermetic test (no VSCode/network/xvfb) — the quick gate
#     vscode  every real-VSCode test (network + xvfb; builds the extension once)
#     all     fast + vscode
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- topic bundles -----------------------------------------------------------
core_s="v1 v2 v3 v4"
serializer_s="v6"
backpressure_s="v9"
widgets_s="v5 v29 v30"
restore_s="v7 v8 v15 v16 v22 v38"
livesync_s="v10 v11 v12 v13 v14 v33 v37"
kernels_s="v17 v18 v19 v20 v21 v23 v24 v26 v40"
richoutputs_s="v27 v28 v31 v34 v35"
notebook_s="v32 v39 v41 v42 v43 v44"

# --- meta bundles ------------------------------------------------------------
fast_s="v1 v2 v3 v4 v5 v6 v7 v9 v17 v27 v31 v34 v35 v40"   # every hermetic test
vscode_s="v8 v10 v11 v12 v13 v14 v15 v16 v18 v19 v20 v21 v22 v23 v24 v26 v28 v29 v30 v32 v33 v37 v38 v39 v41 v42 v43 v44"

bundle="${1:-fast}"
case "$bundle" in
  core)         scripts="$core_s" ;;
  serializer)   scripts="$serializer_s" ;;
  backpressure) scripts="$backpressure_s" ;;
  widgets)      scripts="$widgets_s" ;;
  restore)      scripts="$restore_s" ;;
  livesync)     scripts="$livesync_s" ;;
  kernels)      scripts="$kernels_s" ;;
  richoutputs)  scripts="$richoutputs_s" ;;
  notebook)     scripts="$notebook_s" ;;
  fast)         scripts="$fast_s" ;;
  vscode)       scripts="$vscode_s" ;;
  all)          scripts="$fast_s $vscode_s" ;;
  *) echo "usage: $0 core|serializer|backpressure|widgets|restore|livesync|kernels|richoutputs|notebook|fast|vscode|all" >&2; exit 2 ;;
esac
label="$(echo "$bundle" | tr '[:lower:]' '[:upper:]')"

# --- shared one-time extension build -----------------------------------------
# Any bundle that includes a real-VSCode test builds the extension ONCE here;
# the per-test scripts see TITHON_SKIP_BUILD=1 and reuse it (was: each of the 26
# scripts ran `tsc` twice -> 52 redundant builds per full vscode run).
ELECTRON=" v8 v10 v11 v12 v13 v14 v15 v16 v18 v19 v20 v21 v22 v23 v24 v26 v28 v29 v30 v32 v33 v37 v38 v39 v41 v42 v43 v44 "
need_build=0
for s in $scripts; do case "$ELECTRON" in *" $s "*) need_build=1 ;; esac; done
if [ "$need_build" -eq 1 ]; then
  echo "===== shared extension build (once for the whole $label bundle) ====="
  # shellcheck source=scripts/lib.sh
  . "$ROOT/scripts/lib.sh"
  ensure_extension_build || { echo "shared extension build failed; aborting $label" >&2; exit 1; }
  export TITHON_SKIP_BUILD=1
fi

declare -a results=()
pass=0
total=0
for s in $scripts; do
  echo "===== $s ====="
  out="$(mktemp)"
  timeout 600 bash "$ROOT/scripts/$s.sh" 2>&1 | tee "$out"
  line="$(grep -E "^RESULT $s " "$out" | tail -1)"
  rm -f "$out"
  [ -z "$line" ] && line="RESULT $s FAIL (no RESULT line — crashed or timed out)"
  results+=("$line")
  total=$((total + 1))
  case "$line" in "RESULT $s PASS"*) pass=$((pass + 1));; esac
done

echo
echo "==== $label RESULTS ===="
printf '%-4s | %-4s | %s\n' "test" "res" "detail"
printf -- '-----+------+------------------------------------------------------------\n'
for line in "${results[@]}"; do
  t="$(echo "$line" | awk '{print $2}')"
  r="$(echo "$line" | awk '{print $3}')"
  d="$(echo "$line" | cut -d' ' -f4-)"
  printf '%-4s | %-4s | %s\n' "$t" "$r" "$d"
done
echo "$label SUMMARY: $pass/$total PASS"
[ "$pass" -eq "$total" ]
