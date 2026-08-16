/**
 * Widget comm events must reach the mirror on EVERY path (ADR-083).
 *
 * Two defects this pins, both silent — the widget simply stopped advancing and
 * nothing reported an error:
 *
 *  1. `exec_id: null`. The daemon derives a comm's exec_id from `_msgid_to_exec`,
 *     which the completion barrier pops when the cell finishes (ADR-079). So a
 *     widget updated from a background thread or a timer AFTER its cell completed
 *     is broadcast with `exec_id: null` — reproduced against a real daemon: a
 *     `threading.Thread` bumping an `IntProgress` 1.5 s after the cell's `done`
 *     arrives as `seq=16 exec_id=None kind=widget`. `applyEvent` dropped every
 *     such event on its `if (!ev.exec_id) return;` guard, which sat above the
 *     widget case. Widget state is session-global; it needs no execution row.
 *
 *  2. Resume-delta shape. Comm rows replayed from the journal used to arrive as
 *     `kind: "output"` because `_handle_comm` hand-built its live frame instead of
 *     going through `event_from_message`. The daemon-side fix is asserted end to
 *     end by scripts/v50.sh; here we pin the client half — only `kind: "widget"`
 *     advances the mirror, so the wrong kind is a no-op, which is exactly why the
 *     failure was invisible.
 *
 * Uses the fake unix-socket daemon: a real kernel cannot be made to emit a
 * null-exec_id comm on demand, and the point is the client's dispatch, not the
 * kernel's timing.
 */
import { describe, expect, it } from "vitest";
import { SessionClient } from "../src/sessionClient";
import { fakeDaemon, settle } from "./fakeDaemon";

const COMM = "c-1";

function commOpen(seq: number, execId: string | null) {
  return {
    op: "event",
    seq,
    exec_id: execId,
    kind: "widget",
    payload: {
      msg_type: "comm_open",
      comm_id: COMM,
      data: {
        state: {
          _model_name: "IntProgressModel",
          _model_module: "@jupyter-widgets/controls",
          _model_module_version: "2.0.0",
          value: 1,
          max: 10,
        },
        buffer_paths: [],
      },
    },
  };
}

function commUpdate(seq: number, execId: string | null, value: number) {
  return {
    op: "event",
    seq,
    exec_id: execId,
    kind: "widget",
    payload: {
      msg_type: "comm_msg",
      comm_id: COMM,
      data: { method: "update", state: { value }, buffer_paths: [] },
    },
  };
}

async function drive(frames: unknown[]): Promise<SessionClient> {
  const d = await fakeDaemon((ws) => {
    for (const f of frames) ws.send(JSON.stringify(f));
  });
  const c = new SessionClient(d.sock, "s");
  await c.attach(0);
  await settle(120);
  // The client keeps its own copy of the mirror; closing here would not undo it.
  c.close();
  await d.close();
  return c;
}

function widgetValue(c: SessionClient): unknown {
  return (c.widgets()?.state?.[COMM]?.state as Record<string, unknown> | undefined)?.value;
}

describe("SessionClient — widget comm events reach the mirror", () => {
  it("applies a widget event that carries an exec_id", async () => {
    const c = await drive([commOpen(1, "e1"), commUpdate(2, "e1", 7)]);
    expect(c.widgets()?.state?.[COMM], "the model was created").toBeTruthy();
    expect(widgetValue(c)).toBe(7);
  });

  it("applies a widget event with exec_id: null (background-thread update)", async () => {
    // The regression: the open carries an exec_id (it happened during the cell),
    // the update does not (the thread fired after the barrier popped the mapping).
    const c = await drive([commOpen(1, "e1"), commUpdate(2, null, 8)]);
    expect(c.widgets()?.state?.[COMM], "the model survived").toBeTruthy();
    expect(widgetValue(c), "a post-completion widget update is not dropped").toBe(8);
  });

  it("applies a widget event whose open ALSO has no exec_id", async () => {
    const c = await drive([commOpen(1, null), commUpdate(2, null, 4)]);
    expect(
      c.widgets()?.state?.[COMM],
      "the model was created without an execution row",
    ).toBeTruthy();
    expect(widgetValue(c)).toBe(4);
  });

  it("does NOT mirror a comm delivered under the pre-ADR-083 replay shape", async () => {
    // kind:"output" with a comm msg_type is what delta replay used to hand a
    // resuming client. It must be a no-op here — this is the assertion that
    // explains WHY the daemon-side divergence was invisible, and it fails loudly
    // if someone ever teaches the client to accept both shapes instead of fixing
    // the wire (which would leave the CLI and any third client broken).
    const c = await drive([
      commOpen(1, "e1"),
      {
        op: "event",
        seq: 2,
        exec_id: "e1",
        kind: "output",
        payload: {
          msg_type: "comm_msg",
          content: {
            comm_id: COMM,
            data: { method: "update", state: { value: 9 }, buffer_paths: [] },
          },
        },
      },
    ]);
    expect(widgetValue(c), "the wrong wire shape does not advance the mirror").toBe(1);
  });
});
