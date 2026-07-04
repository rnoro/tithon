/**
 * Minimal daemon client (spike level) — talks the daemon's WebSocket protocol
 * over its unix domain socket (SPEC.md; the daemon binds a 0600 unix
 * socket, never TCP). Used by the CodeLens "Run Cell" wiring to submit code.
 */
import WebSocket from "ws";
import { homedir } from "os";
import { join } from "path";

export interface ExecOrigin {
  uri: string;
  range: { start: number; end: number };
  cell_hash: string;
  /** 0-based cell index in the file — disambiguates two cells with identical
   *  code (the duplicate-cell bug), which share a cell_hash. */
  index?: number;
}

/** One live kernel as reported by the daemon's global status (`sessions[]`). */
export interface KernelInfo {
  /** The session id = the file uri (or "default" for the CLI session). */
  session: string;
  kernel_pid: number | null;
  kernel_status: string;
  kernel_python: string | null;
  kernel_reattached: boolean;
  queue_len: number;
  executions: number;
  widget_models: number;
  /** Attached clients (live subscribers); absent on daemons predating idle-GC. */
  clients?: number;
  /** Seconds since this kernel last did anything (the idle-GC clock). */
  idle_seconds?: number;
}

/** The session id is the file uri: one kernel + journal per file (like Jupyter). */
function sessionOf(origin?: ExecOrigin): string {
  return origin?.uri ?? "default";
}

export function defaultSocketPath(): string {
  const home = process.env.TITHON_HOME ?? join(homedir(), ".tithon");
  return join(home, "daemon.sock");
}

/** `ws+unix://<socket>:<path>` is how `ws` dials a unix-domain WebSocket. */
function unixWsUrl(sockPath: string): string {
  return `ws+unix://${sockPath}:/`;
}

export class DaemonClient {
  constructor(private readonly sockPath: string = defaultSocketPath()) {}

  private open(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(unixWsUrl(this.sockPath));
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  /** Submit code for execution; resolves with the assigned exec_id. The session
   *  (per-file kernel) is the origin's file uri. `workdir` is the file's project
   *  root — on first creation the daemon roots this session's artifacts/kernel
   *  cwd there and names its dir readably (ADR-044). */
  async execute(
    code: string, origin?: ExecOrigin, workdir?: string, allowStdin = false,
  ): Promise<string> {
    const session = sessionOf(origin);
    const ws = await this.open();
    try {
      // attach live-only first so the daemon is ready to stream our events.
      ws.send(JSON.stringify({ op: "attach", last_seen_seq: -1, session, workdir }));
      await this.waitFor(ws, (m) => m.op === "sync");
      ws.send(JSON.stringify(
        { op: "execute", code, origin, session, workdir, allow_stdin: allowStdin }));
      const ack = await this.waitFor(ws, (m) => m.op === "execute_ack");
      return ack.exec_id as string;
    } finally {
      ws.close();
    }
  }

  /**
   * Submit a batch of cells as ONE action (a "Run All" / multi-cell run). With
   * `stopOnError` (the default) the daemon stops at the first cell that raises and
   * skips the rest — native Jupyter semantics — and, because the daemon owns the
   * batch, this holds even if the client disconnects mid-run. Resolves with the
   * assigned exec_ids (submission order).
   */
  async executeBatch(
    cells: { code: string; origin?: ExecOrigin }[],
    session: string,
    workdir?: string,
    stopOnError = true,
    allowStdin = false,
  ): Promise<string[]> {
    const ws = await this.open();
    try {
      ws.send(JSON.stringify({ op: "attach", last_seen_seq: -1, session, workdir }));
      await this.waitFor(ws, (m) => m.op === "sync");
      ws.send(JSON.stringify({
        op: "execute_batch", cells, stop_on_error: stopOnError, session, workdir,
        allow_stdin: allowStdin,
      }));
      const ack = await this.waitFor(ws, (m) => m.op === "execute_ack");
      return (ack.exec_ids ?? []) as string[];
    } finally {
      ws.close();
    }
  }

  /** Restart a file's kernel (fresh namespace). `session` is the file uri. */
  async restartKernel(session: string): Promise<void> {
    const ws = await this.open();
    try {
      ws.send(JSON.stringify({ op: "restart_kernel", session }));
      await this.waitFor(ws, (m) => m.op === "kernel_restarted");
    } finally {
      ws.close();
    }
  }

  /** List the daemon's running kernels (one per file session) — the picker's
   *  source for "which kernel to terminate". */
  async listKernels(): Promise<KernelInfo[]> {
    const reply = await this.status();
    return (reply.sessions ?? []) as KernelInfo[];
  }

  /** Terminate a file's kernel and drop its session (frees host/GPU memory).
   *  `session` is the file uri. Resolves true if a live kernel was killed,
   *  false if no such session was running. */
  async killKernel(session: string): Promise<boolean> {
    const ws = await this.open();
    try {
      ws.send(JSON.stringify({ op: "kill_kernel", target: session }));
      const m = await this.waitFor(ws, (m) => m.op === "kernel_killed");
      return !!m.ok;
    } finally {
      ws.close();
    }
  }

  /** Interrupt the running cell of a file's kernel. `session` is the file uri. */
  async interrupt(session: string): Promise<void> {
    const ws = await this.open();
    try {
      ws.send(JSON.stringify({ op: "interrupt", session }));
      await this.waitFor(ws, (m) => m.op === "interrupted");
    } finally {
      ws.close();
    }
  }

  /** Stop the whole daemon. `killKernels` also terminates kernels (fresh start,
   *  e.g. an interpreter switch); otherwise kernels stay detached for re-attach.
   *  No-op if the daemon isn't running. */
  async shutdown(killKernels = false): Promise<void> {
    let ws: WebSocket;
    try {
      ws = await this.open();
    } catch {
      return; // not running
    }
    try {
      ws.send(JSON.stringify({ op: "shutdown", kill_kernels: killKernels }));
      await this.waitFor(ws, (m) => m.op === "shutting_down").catch(() => undefined);
    } finally {
      ws.close();
    }
  }

  async status(): Promise<any> {
    const ws = await this.open();
    try {
      ws.send(JSON.stringify({ op: "status" }));
      return await this.waitFor(ws, (m) => m.op === "status_reply");
    } finally {
      ws.close();
    }
  }

  private waitFor(ws: WebSocket, pred: (m: any) => boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const onMsg = (raw: WebSocket.RawData) => {
        let m: any;
        try {
          m = JSON.parse(raw.toString());
        } catch {
          return;
        }
        // Session start failed (e.g. kernel exited on startup — ADR-059/060):
        // reject with the daemon's actionable reason, not a generic close error.
        if (m.op === "error") {
          ws.off("message", onMsg);
          reject(new Error(m.message || "daemon error"));
          return;
        }
        if (pred(m)) {
          ws.off("message", onMsg);
          resolve(m);
        }
      };
      ws.on("message", onMsg);
      ws.once("error", reject);
      ws.once("close", () => reject(new Error("daemon closed connection")));
    });
  }
}
