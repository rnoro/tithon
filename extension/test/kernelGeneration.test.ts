/**
 * `SessionClient.kernelInfo().generation` must track a restart, not just the
 * generation attach() saw (RISKS #7 finding 3, Codex ④ review of the
 * exec_id-centric-adapter proposal).
 *
 * The daemon opens a generation with the lifecycle event's OWN journal seq
 * (`Session.kernel_generation = journal.max_seq()` right after journaling
 * `restarted`/`replaced`) and that exact number is the event's top-level
 * `seq` on the wire. Before this fix, `applyEvent`'s `restarted`/`replaced`
 * branch updated status/pid but never `generation`, so a client that stayed
 * attached across ANOTHER client's restart kept reporting the generation it
 * last attached at — `warnKernelDied()` (sessionController.ts) de-dups the
 * lost-kernel warning strictly by this number, so a SECOND death after that
 * restart would misread as a duplicate of the first and never warn.
 */
import { describe, it, expect } from "vitest";
import { SessionClient } from "../src/sessionClient";
import { fakeDaemon, settle } from "./fakeDaemon";

async function drive(frames: unknown[]): Promise<SessionClient> {
  const d = await fakeDaemon((ws) => {
    for (const f of frames) ws.send(JSON.stringify(f));
  });
  const c = new SessionClient(d.sock, "s");
  await c.attach(0);
  await settle(120);
  c.close();
  await d.close();
  return c;
}

describe("SessionClient — kernel_generation stays current across a restart", () => {
  it("a restarted event updates generation to its own seq", async () => {
    const c = await drive([
      { op: "event", seq: 7, exec_id: null, kind: "kernel",
        payload: { status: "restarted", pid: 4242, deliberate: true } },
    ]);
    expect(c.kernelInfo()?.generation).toBe(7);
    expect(c.kernelInfo()?.pid).toBe(4242);
  });

  it("a replaced event (host reboot) also updates generation", async () => {
    const c = await drive([
      { op: "event", seq: 3, exec_id: null, kind: "kernel",
        payload: { status: "replaced", pid: 111 } },
    ]);
    expect(c.kernelInfo()?.generation).toBe(3);
  });

  it("a later restart (from another client) advances generation past a stale one", async () => {
    // Simulates: this client attached earlier at generation 5, then observed
    // a death, then ANOTHER client restarted the kernel to generation 12 —
    // this client must pick up 12, not stay pinned at 5.
    const c = await drive([
      { op: "event", seq: 5, exec_id: null, kind: "kernel",
        payload: { status: "restarted", pid: 100, deliberate: true } },
      { op: "event", seq: 9, exec_id: null, kind: "kernel",
        payload: { status: "dead" } },
      { op: "event", seq: 12, exec_id: null, kind: "kernel",
        payload: { status: "restarted", pid: 200, deliberate: true } },
    ]);
    expect(c.kernelInfo()?.generation).toBe(12);
    expect(c.kernelInfo()?.pid).toBe(200);
  });

  it("a dead event alone does not touch generation", async () => {
    const c = await drive([
      { op: "event", seq: 5, exec_id: null, kind: "kernel",
        payload: { status: "restarted", pid: 100, deliberate: true } },
      { op: "event", seq: 9, exec_id: null, kind: "kernel",
        payload: { status: "dead" } },
    ]);
    expect(c.kernelInfo()?.generation).toBe(5);
    expect(c.kernelInfo()?.status).toBe("dead");
  });
});
