/**
 * Auto-start the host daemon (design: "pip install tithon" then just use it).
 *
 * When the extension needs the daemon but its unix socket isn't accepting
 * connections, spawn the daemon DETACHED on the host (so it outlives the
 * extension host and survives reconnects) and wait for the socket. In a VSCode
 * tunnel / remote session the extension host runs on the GPU host, so this spawn
 * lands on the right machine.
 *
 * The extension host's PATH is often minimal (a remote/tunnel server doesn't
 * source your shell profile), so `tithon` may not be found. We therefore try a
 * list of launch commands — the configured one, then `python3 -m tithon` /
 * `python -m tithon` — and fail fast on a command that dies (e.g. not found),
 * surfacing the captured startup log so the failure is diagnosable instead of a
 * silent 20s timeout. Opt out with `tithon.autoStartDaemon: false`; force a
 * specific launcher with `tithon.daemonCommand` (e.g. an absolute path).
 *
 * Kept separate from daemonClient/sessionClient so those stay free of the
 * `vscode` and `child_process` deps (they're imported by plain-node seeders/tests).
 */
import { spawn } from "child_process";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

function canConnect(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(sockPath);
    const done = (ok: boolean) => {
      s.removeAllListeners();
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One start attempt at a time per extension host — concurrent ensureDaemon
// callers (auto-live + executeHandler) share the same in-flight start.
let inFlight: Promise<void> | null = null;

/**
 * Resolve the Python interpreter the SAME way Jupyter-in-VSCode does: ask the
 * Python extension for the selected interpreter (or honor an explicit setting),
 * so `<python> -m tithon` runs the daemon WITHOUT needing the venv activated or
 * `tithon` on PATH. Returns an absolute interpreter path, or undefined.
 */
async function resolvePython(cfg: vscode.WorkspaceConfiguration): Promise<string | undefined> {
  const explicit = (cfg.get<string>("pythonPath", "") || "").trim();
  if (explicit) return explicit;
  try {
    const ext = vscode.extensions.getExtension("ms-python.python");
    if (ext) {
      if (!ext.isActive) await ext.activate();
      const api = ext.exports as any;
      const envPath = api?.environments?.getActiveEnvironmentPath?.();
      if (envPath?.path) {
        try {
          const resolved = await api.environments.resolveEnvironment(envPath);
          const exe = resolved?.executable?.uri?.fsPath ?? resolved?.path;
          if (exe) return exe;
        } catch { /* fall through to the raw path */ }
        return envPath.path;
      }
      const det = api?.settings?.getExecutionDetails?.();
      if (det?.execCommand?.length) return det.execCommand.join(" ");
    }
  } catch { /* Python extension absent or API shape changed */ }
  const def = (vscode.workspace.getConfiguration("python").get<string>("defaultInterpreterPath", "") || "").trim();
  if (def && def !== "python") return def;
  return undefined;
}

/**
 * Launch commands to try, in order:
 *   1. the selected interpreter as `<python> -m tithon` (venv-independent — the
 *      Jupyter-style path), then
 *   2. an explicit `tithon.daemonCommand` (if the user set one), then
 *   3. bare `tithon` / `python3 -m tithon` / `python -m tithon` fallbacks.
 */
async function candidates(cfg: vscode.WorkspaceConfiguration): Promise<string[]> {
  const py = await resolvePython(cfg);
  const configured = (cfg.get<string>("daemonCommand", "tithon") || "tithon").trim();
  const list: string[] = [];
  if (py) list.push(`"${py}" -m tithon`);
  if (configured && configured !== "tithon") list.push(configured);
  list.push("tithon", "python3 -m tithon", "python -m tithon");
  return [...new Set(list)]; // dedupe, keep order
}

export async function ensureDaemon(sockPath: string): Promise<void> {
  if (await canConnect(sockPath)) return;
  const cfg = vscode.workspace.getConfiguration("tithon");
  if (!cfg.get<boolean>("autoStartDaemon", true)) {
    throw new Error(`Tithon daemon is not running at ${sockPath} (tithon.autoStartDaemon is off).`);
  }
  if (!inFlight) inFlight = startAny(sockPath, cfg).finally(() => { inFlight = null; });
  await inFlight;
}

async function startAny(sockPath: string, cfg: vscode.WorkspaceConfiguration): Promise<void> {
  const home = path.dirname(sockPath);
  fs.mkdirSync(home, { recursive: true });
  const logPath = path.join(home, "daemon.autostart.log");
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const tried: string[] = [];

  for (const cmd of await candidates(cfg)) {
    tried.push(cmd);
    if (await tryStart(`${cmd} daemon`, sockPath, logPath, cwd)) return;
    if (await canConnect(sockPath)) return; // a racing/previous start won
  }
  const tail = readTail(logPath);
  throw new Error(
    `Could not start the Tithon daemon. Tried: ${tried.join(", ")}.\n` +
    `Set "tithon.daemonCommand" to your tithon path (e.g. /path/to/venv/bin/tithon ` +
    `or "<python> -m tithon").` + (tail ? `\nLast daemon output:\n${tail}` : ""),
  );
}

/** Spawn one launcher detached; resolve true once the socket is up, false if the
 *  process dies first (e.g. command not found) or it doesn't bind in time. */
function tryStart(cmdline: string, sockPath: string, logPath: string, cwd?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let out: number;
    try {
      out = fs.openSync(logPath, "a");
    } catch {
      out = 1;
    }
    const child = spawn(cmdline, {
      cwd,
      shell: true,        // resolve `tithon` / `python` via PATH, allow `-m` forms
      detached: true,     // outlive this extension host (survives reconnects)
      stdio: ["ignore", out, out],
      env: process.env,
    });
    child.unref();
    const dead = { yes: false };
    child.once("error", () => { dead.yes = true; });
    child.once("exit", () => { dead.yes = true; }); // shell exits 127 if not found

    const deadline = Date.now() + 8000;
    (async () => {
      while (Date.now() < deadline) {
        if (await canConnect(sockPath)) return resolve(true);
        if (dead.yes) return resolve(false); // this launcher failed — try the next
        await sleep(200);
      }
      resolve(false);
    })();
  });
}

function readTail(logPath: string, lines = 12): string {
  try {
    const text = fs.readFileSync(logPath, "utf8").trimEnd();
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}
