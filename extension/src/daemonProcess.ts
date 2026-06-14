/**
 * Auto-start the host daemon (design: "pip install tithon" then just use it).
 *
 * When the extension needs the daemon but its unix socket isn't accepting
 * connections, spawn `tithon daemon` DETACHED on the host (so it outlives the
 * extension host and survives reconnects) and wait for the socket. In a VSCode
 * tunnel / remote session the extension host runs on the GPU host, so this spawn
 * lands on the right machine. Opt out with `tithon.autoStartDaemon: false`.
 *
 * Kept separate from daemonClient/sessionClient so those stay free of the
 * `vscode` and `child_process` deps (they're imported by plain-node seeders/tests).
 */
import { spawn } from "child_process";
import * as net from "net";
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

// One spawn at a time per extension host — concurrent ensureDaemon callers
// (auto-live + executeHandler) share the same in-flight start.
let inFlight: Promise<void> | null = null;

/**
 * Ensure the daemon is reachable at `sockPath`, spawning it if needed.
 * Resolves once the socket accepts connections (or immediately if it already
 * does). Throws if auto-start is disabled and the daemon is down, or if the
 * spawned daemon never came up.
 */
export async function ensureDaemon(sockPath: string): Promise<void> {
  if (await canConnect(sockPath)) return;
  const cfg = vscode.workspace.getConfiguration("tithon");
  if (!cfg.get<boolean>("autoStartDaemon", true)) {
    throw new Error(`daemon not running at ${sockPath} (tithon.autoStartDaemon is off)`);
  }
  if (!inFlight) inFlight = doSpawn(sockPath, cfg).finally(() => { inFlight = null; });
  await inFlight;
}

async function doSpawn(sockPath: string, cfg: vscode.WorkspaceConfiguration): Promise<void> {
  const cmd = cfg.get<string>("daemonCommand", "tithon");
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; // kernels run here
  // shell:true so a bare `tithon` resolves via PATH; detached+unref so the
  // daemon (and its detached kernels) outlive this extension host.
  const child = spawn(`${cmd} daemon`, {
    cwd,
    shell: true,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  // Object box (not a bare let) so TS doesn't narrow the callback-set value away.
  const err: { msg: string | null } = { msg: null };
  child.once("error", (e) => { err.msg = (e as Error).message; });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (err.msg) throw new Error(`failed to launch '${cmd} daemon': ${err.msg}`);
    if (await canConnect(sockPath)) return;
    await sleep(250);
  }
  throw new Error(`daemon did not come up within 20s (command: '${cmd} daemon')`);
}
