/**
 * SessionClient disconnect surfacing (ADR-018 client half — see ADR-057).
 *
 * The daemon drops a slow/over-budget live client by sending `{op:"overflow"}`
 * and closing the socket; it can also close unexpectedly (daemon restart/crash).
 * The client must surface BOTH as a single onDisconnect so the controller can
 * reconnect and resync — previously they were ignored and the live view froze.
 *
 * A tiny unix-socket `ws` server stands in for the daemon (deterministic, no
 * real kernel needed): it answers an attach with snapshot+sync, then triggers
 * the drop on demand.
 */
import { describe, it, expect } from "vitest";
import { WebSocketServer, type WebSocket as WS } from "ws";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { SessionClient } from "../src/sessionClient";

function tmpSock(): string {
  return path.join(os.tmpdir(), `tithon-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

async function fakeDaemon(
  onAttach: (ws: WS) => void,
): Promise<{ sock: string; close: () => Promise<void> }> {
  const sock = tmpSock();
  try { fs.unlinkSync(sock); } catch { /* fresh */ }
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.op === "attach") {
        ws.send(JSON.stringify({ op: "snapshot", max_seq: 0, executions: [] }));
        ws.send(JSON.stringify({ op: "sync", seq: 0 }));
        onAttach(ws);
      }
    });
  });
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

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe("SessionClient — disconnect surfacing for reconnect", () => {
  it("fires onDisconnect('overflow') when the daemon sends an overflow op", async () => {
    const d = await fakeDaemon((ws) => {
      setTimeout(() => {
        ws.send(JSON.stringify({ op: "overflow" }));
        ws.close();
      }, 20);
    });
    const c = new SessionClient(d.sock, "s");
    let reason: string | null = null;
    let count = 0;
    c.onDisconnect((r) => {
      reason = r;
      count += 1;
    });
    await c.attach(0);
    await settle();
    expect(reason).toBe("overflow");
    expect(count).toBe(1); // overflow + following close fire it at most once
    c.close();
    await d.close();
  });

  it("fires onDisconnect('close') on an unexpected socket close after sync", async () => {
    const d = await fakeDaemon((ws) => {
      setTimeout(() => ws.close(), 20); // no overflow, just drop
    });
    const c = new SessionClient(d.sock, "s");
    let reason: string | null = null;
    c.onDisconnect((r) => {
      reason = r;
    });
    await c.attach(0);
    await settle();
    expect(reason).toBe("close");
    c.close();
    await d.close();
  });

  it("does NOT fire onDisconnect for an intentional close()", async () => {
    const d = await fakeDaemon(() => {
      /* stay connected */
    });
    const c = new SessionClient(d.sock, "s");
    let fired = false;
    c.onDisconnect(() => {
      fired = true;
    });
    await c.attach(0);
    c.close(); // user/controller teardown — must be silent
    await settle(100);
    expect(fired).toBe(false);
    await d.close();
  });
});
