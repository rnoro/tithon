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
   *  (per-file kernel) is the origin's file uri. */
  async execute(code: string, origin?: ExecOrigin): Promise<string> {
    const session = sessionOf(origin);
    const ws = await this.open();
    try {
      // attach live-only first so the daemon is ready to stream our events.
      ws.send(JSON.stringify({ op: "attach", last_seen_seq: -1, session }));
      await this.waitFor(ws, (m) => m.op === "sync");
      ws.send(JSON.stringify({ op: "execute", code, origin, session }));
      const ack = await this.waitFor(ws, (m) => m.op === "execute_ack");
      return ack.exec_id as string;
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
