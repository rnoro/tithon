# Common helpers for Phase 0 verify scripts. Source from vN.sh.
# shellcheck shell=bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.venv"
PY="$VENV/bin/python"
TITHON="$VENV/bin/tithon"

# Linux uses Xvfb; macOS has a native window server. Do not substitute one
# host's process/display assumptions for the other's verification environment.
TITHON_TEST_HOST="$(uname -s)"
if [ "$TITHON_TEST_HOST" = Darwin ]; then
  for bin in /opt/homebrew/opt/coreutils/libexec/gnubin /usr/local/opt/coreutils/libexec/gnubin; do
    [ -d "$bin" ] && PATH="$bin:$PATH" && export PATH && break
  done
fi

if ! command -v timeout >/dev/null 2>&1; then
  echo "Verification requires timeout; on macOS install coreutils with brew install coreutils." >&2
  exit 1
fi

run_vscode() {
  case "$TITHON_TEST_HOST" in
    Linux) command xvfb-run -a "$@" ;;
    Darwin) "$@" ;;
    *) echo "Unsupported verification host: $TITHON_TEST_HOST" >&2; return 1 ;;
  esac
}

installed_extension() { # $1 = publisher.name; select a host-compatible installation.
  "$PY" - "$1" <<'PY_EXTENSION'
import json
import os
import platform
import re
import sys
from pathlib import Path

home = Path.home()
roots = [home / ".vscode-server/extensions", home / ".vscode/extensions"]
if sys.platform == "darwin":
    roots.reverse()
if os.environ.get("TITHON_LSP_EXT_ROOT"):
    roots = [Path(os.environ["TITHON_LSP_EXT_ROOT"])]
arch = {"aarch64": "arm64", "x86_64": "x64"}.get(platform.machine(), platform.machine())
target = f"{sys.platform}-{arch}"
for root in roots:
    candidates = []
    for directory in root.glob(f"{sys.argv[1]}-*"):
        try:
            manifest = json.loads((directory / "package.json").read_text())
        except (OSError, ValueError):
            continue
        installed_target = manifest.get("__metadata", {}).get("targetPlatform")
        if not installed_target or installed_target == "undefined":
            suffix = re.search(r"-(linux|alpine|darwin|win32)-(x64|arm64|armhf)$", directory.name)
            installed_target = f"{suffix[1]}-{suffix[2]}" if suffix else "universal"
        if installed_target not in (target, "universal", "undefined"):
            continue
        version = tuple(int(n) for n in re.findall(r"\d+", manifest.get("version", "0")))
        candidates.append((version, directory))
    if candidates:
        print(max(candidates, key=lambda item: item[0])[1])
        break
PY_EXTENSION
}

setup_env() { # $1 = test name; fresh isolated TITHON_HOME + workdir
  TITHON_HOME="$(mktemp -d "/tmp/tithon-$1.XXXXXX")"
  export TITHON_HOME
  WORK="$TITHON_HOME/work"
  mkdir -p "$WORK"
}

start_daemon() {
  (cd "$WORK" && nohup "$TITHON" daemon >"$TITHON_HOME/daemon.stdout.log" 2>&1 &)
  for _ in $(seq 1 150); do
    if timeout 5 "$TITHON" status >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  echo "daemon failed to start; logs:" >&2
  tail -20 "$TITHON_HOME/daemon.stdout.log" "$TITHON_HOME/daemon.log" 2>/dev/null >&2 || true
  return 1
}

daemon_pid() { cat "$TITHON_HOME/daemon.pid" 2>/dev/null || true; }

kernel_pids() { # EVERY session's kernel pid, one per line
  # Not just `default`: opening a notebook creates a per-FILE session under a
  # hashed name, so the real-VSCode tests never touch `default` at all. Sweeping
  # only that one left a detached kernel per test alive — a full `make vscode`
  # leaked ~34, and enough of those racing a fresh kernel spawn is what flakes
  # the isolated tests.
  find "${TITHON_HOME:-/nonexistent}/sessions" -name kernel.pid -exec cat {} + 2>/dev/null || true
}

status_field() { # $1 = json field name; from the DEFAULT session's status.
  # Kernel fields (kernel_pid/kernel_status/kernel_reattached/widget_models) are
  # now per-session (per-file kernels); the global `status` only lists sessions.
  # Querying a session lazily creates/re-attaches it — which is exactly how a
  # restarted daemon re-attaches to its detached kernel (v4).
  timeout 10 "$TITHON" status --session default \
    | "$PY" -c "import json,sys; print(json.load(sys.stdin)[sys.argv[1]])" "$1"
}

kernel_dead() { # $1 = pid; true if gone, zombie, or no longer an ipykernel.
  if [ "$TITHON_TEST_HOST" = Linux ]; then
    [ -r "/proc/$1/cmdline" ] || return 0
    local cmd
    cmd="$(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null)"
    case "$cmd" in *ipykernel_launcher*) return 1 ;; *) return 0 ;; esac
  fi
  "$PY" - "$1" <<'PY_CHECK'
import sys
import psutil
try:
    process = psutil.Process(int(sys.argv[1]))
    alive = process.status() != psutil.STATUS_ZOMBIE and "ipykernel_launcher" in " ".join(process.cmdline())
except psutil.NoSuchProcess:
    alive = False
except psutil.AccessDenied:
    alive = True
sys.exit(1 if alive else 0)
PY_CHECK
}

cleanup_procs() {
  local dp kp
  dp="$(daemon_pid)"
  [ -n "$dp" ] && kill "$dp" 2>/dev/null
  sleep 0.3
  # `kernel_dead` before each kill: these pids come off disk and a finished test's
  # kernel may already be reaped, so the number could belong to something else by
  # now. The sweep is confined to this test's own TITHON_HOME, so a developer's
  # real ~/.tithon kernels are out of reach by construction.
  while read -r kp; do
    [ -n "$kp" ] || continue
    kernel_dead "$kp" || kill -9 "$kp" 2>/dev/null
  done <<KPIDS
$(kernel_pids)
KPIDS
  [ -n "$dp" ] && kill -9 "$dp" 2>/dev/null
  return 0
}

ensure_extension_build() { # build the VSCode extension (dist/) + integration sources (out-int/)
  # Locate node/npx (nvm), verify the electron prerequisites, then build.
  # A BUNDLED run sets TITHON_SKIP_BUILD=1 (run_verify.sh builds ONCE before a
  # vscode bundle) so the 26 real-VSCode scripts don't each re-run `tsc` twice;
  # a standalone `bash vNN.sh` leaves it unset and builds itself. Returns
  # nonzero on a missing tool / build failure — the caller maps it to its RESULT.
  local ext="$ROOT/extension"
  if ! command -v npx >/dev/null 2>&1; then
    for d in "$HOME/.nvm/versions/node"/*/bin; do
      [ -x "$d/npx" ] && PATH="$d:$PATH" && export PATH && break
    done
  fi
  command -v npx >/dev/null 2>&1 || { echo "npx not found on PATH" >&2; return 1; }
  command -v node >/dev/null 2>&1 || { echo "node not found on PATH" >&2; return 1; }
  if [ "$TITHON_TEST_HOST" = Linux ]; then
    command -v xvfb-run >/dev/null 2>&1 || { echo "xvfb-run not found (install xvfb)" >&2; return 1; }
  fi
  [ -d "$ext/node_modules" ] || { (cd "$ext" && npm install >/tmp/tithon-ext-npm.log 2>&1) || { echo "npm install failed" >&2; return 1; }; }
  [ -n "${TITHON_SKIP_BUILD:-}" ] && return 0   # already built once by the bundle runner
  (cd "$ext" && npx tsc -p ./) || { echo "extension build (dist) failed" >&2; return 1; }
  (cd "$ext" && npx tsc -p tsconfig.integration.json) || { echo "integration build (out-int) failed" >&2; return 1; }
  # The `notebookRenderer` contribution loads dist/widgetRenderer.js, which ONLY
  # esbuild emits — tsc emits dist/widgetRendererEntry.js, which nothing loads.
  # Skipping this leaves the widget suites asserting against whatever bundle was
  # last built by hand, so a renderer fix can read as verified while the host
  # never loaded it. Renderer only: the full bundle would replace the
  # dist/extension.js tsc just emitted, which is what the verify path runs.
  (cd "$ext" && node esbuild.mjs renderer) || { echo "renderer bundle failed" >&2; return 1; }
  return 0
}
