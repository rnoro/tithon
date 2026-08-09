/**
 * A unix-socket stand-in for the daemon, for SessionClient unit tests.
 *
 * Deterministic: no kernel, no journal, no timing. The test owns exactly what
 * frames the "daemon" sends, which is what makes it usable for wire-shape
 * assertions (an event with `exec_id: null`, a malformed payload, a drop) that a
 * real kernel cannot be made to produce on demand.
 *
 * Extracted from reconnectClient.test.ts when widgetEvents.test.ts needed the
 * same harness (ADR-083).
 */
import { WebSocketServer, type WebSocket as WS } from "ws";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

export interface FakeDaemon {
  sock: string;
  close: () => Promise<void>;
}

export function tmpSock(): string {
  return path.join(os.tmpdir(), `tithon-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

/** Bare unix-socket ws server; `onConnection` gets full control of each socket. */
export async function fakeDaemonRaw(onConnection: (ws: WS) => void): Promise<FakeDaemon> {
  const sock = tmpSock();
  try { fs.unlinkSync(sock); } catch { /* fresh */ }
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", onConnection);
  await new Promise<void>((res) => server.listen(sock, res));
  return {
    sock,
    close: () =>
      new Promise<void>((res) => {
        wss.close();
        server.close(() => {
          try { fs.unlinkSync(sock); } catch { /* gone */ }
          res();
        });
      }),
  };
}

/** A daemon that answers attach with snapshot+sync, then runs `onAttach`. */
export async function fakeDaemon(onAttach: (ws: WS) => void): Promise<FakeDaemon> {
  return fakeDaemonRaw((ws) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.op === "attach") {
        ws.send(JSON.stringify({ op: "snapshot", max_seq: 0, executions: [] }));
        ws.send(JSON.stringify({ op: "sync", seq: 0 }));
        onAttach(ws);
      }
    });
  });
}

export const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));
