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
import { type WebSocket as WS } from "ws";
import { SessionClient } from "../src/sessionClient";
import { fakeDaemon, fakeDaemonRaw, settle } from "./fakeDaemon";

/** A daemon that, on attach, replies with an `error` op and closes (a
 *  session-start failure — e.g. the kernel exited on startup, ADR-059/060). */
async function fakeErrorDaemon(
  message: string,
): Promise<{ sock: string; close: () => Promise<void> }> {
  return fakeDaemonRaw((ws) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.op === "attach") {
        ws.send(JSON.stringify({ op: "error", message }));
        ws.close();
      }
    });
  });
}

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

  it("attach rejects with the daemon's message on an error op (ADR-060)", async () => {
    const d = await fakeErrorDaemon("kernel process exited during startup — is ipykernel installed?");
    const c = new SessionClient(d.sock, "s");
    let msg = "";
    await c.attach(0).catch((e: Error) => { msg = e.message; });
    expect(msg).toContain("ipykernel");
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
