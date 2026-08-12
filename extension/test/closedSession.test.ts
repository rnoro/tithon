/**
 * `closed_by_user` on the wire (client half).
 *
 * The daemon distinguishes a session the user ENDED from one that was merely
 * lost, because only the second justifies silently re-seeding a file's cells on
 * open. The client carries that bit from the attach snapshot so the controller
 * can skip the seed and offer the history back instead of replaying it unasked.
 */
import { describe, it, expect } from "vitest";
import { type WebSocket as WS } from "ws";
import { SessionClient } from "../src/sessionClient";
import { fakeDaemonRaw } from "./fakeDaemon";

const EXEC = {
  exec_id: "e1",
  seq: 1,
  code: "print(1)",
  status: "done",
  outputs: [{ output_type: "stream", name: "stdout", text: "1\n" }],
};

/** A daemon whose attach snapshot carries the given `closed_by_user` value. */
async function daemonWithSnapshot(snapshot: Record<string, unknown>) {
  return fakeDaemonRaw((ws: WS) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.op === "attach") {
        ws.send(JSON.stringify({ op: "snapshot", max_seq: 1, executions: [EXEC], ...snapshot }));
        ws.send(JSON.stringify({ op: "sync", seq: 1 }));
      }
    });
  });
}

describe("SessionClient — closed_by_user", () => {
  it("reports a session the user closed", async () => {
    const d = await daemonWithSnapshot({ closed_by_user: true });
    const c = new SessionClient(d.sock, "s");
    await c.attach(0);

    expect(c.isClosedByUser()).toBe(true);
    // The history is withheld from the SEED, not deleted — a restore on request
    // still has something to restore.
    expect(c.executions().map((e) => e.execId)).toEqual(["e1"]);
    expect(c.outputsOf("e1")).toHaveLength(1);

    c.close();
    await d.close();
  });

  it("defaults to armed when the daemon does not say", async () => {
    // An older daemon omits the field entirely; restoring on open is the
    // behaviour every other path depends on, so absence must not read as closed.
    const d = await daemonWithSnapshot({});
    const c = new SessionClient(d.sock, "s");
    await c.attach(0);

    expect(c.isClosedByUser()).toBe(false);

    c.close();
    await d.close();
  });

  it("is re-read on every snapshot, not latched", async () => {
    // Running a cell re-arms restore daemon-side; a reconnect after that must
    // not keep reporting the session as closed.
    let closed = true;
    const d = await fakeDaemonRaw((ws: WS) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.op === "attach") {
          ws.send(JSON.stringify({
            op: "snapshot", max_seq: 1, executions: [EXEC], closed_by_user: closed,
          }));
          ws.send(JSON.stringify({ op: "sync", seq: 1 }));
        }
      });
    });

    const first = new SessionClient(d.sock, "s");
    await first.attach(0);
    expect(first.isClosedByUser()).toBe(true);
    first.close();

    closed = false;
    const second = new SessionClient(d.sock, "s");
    await second.attach(0);
    expect(second.isClosedByUser()).toBe(false);
    second.close();

    await d.close();
  });
});
