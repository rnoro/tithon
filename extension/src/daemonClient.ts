/**
 * Minimal daemon client (spike level) — talks the daemon's WebSocket protocol
 * over its unix domain socket (design.md §3.1; the daemon binds a 0600 unix
 * socket, never TCP). Used by the CodeLens "Run Cell" wiring to submit code.
 */
import WebSocket from "ws";
import { homedir } from "os";
import { join } from "path";

export interface ExecOrigin {
  uri: string;
  range: { start: number; end: number };
  cell_hash: string;
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

  /** Submit code for execution; resolves with the assigned exec_id. */
  async execute(code: string, origin?: ExecOrigin): Promise<string> {
    const ws = await this.open();
    try {
      // attach live-only first so the daemon is ready to stream our events.
      ws.send(JSON.stringify({ op: "attach", last_seen_seq: -1 }));
      await this.waitFor(ws, (m) => m.op === "sync");
      ws.send(JSON.stringify({ op: "execute", code, origin }));
      const ack = await this.waitFor(ws, (m) => m.op === "execute_ack");
      return ack.exec_id as string;
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
