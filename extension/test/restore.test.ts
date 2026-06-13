/**
 * v7 — output restore over a *real* daemon (no mocks).
 *
 * Drives the actual daemon over its unix socket: submits real cells to a real
 * kernel, lets them run, then *reconnects* with a fresh SessionClient and proves
 * the cell outputs come back and attach to the right document cells by cell_hash
 * — i.e. the "reopen the notebook over a tunnel and your outputs are still here"
 * path. Also checks client/daemon fold equivalence (a client that folded the
 * live raw stream agrees with one seeded from the daemon's folded snapshot).
 *
 * Skips unless a daemon socket is present (so plain `npm test` stays hermetic);
 * verify/v7.sh starts the daemon and sets TITHON_HOME before running this file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "fs";
import { parse, cellSource } from "../src/serializer";
import { SessionClient, defaultSocketPath } from "../src/sessionClient";
import { computeCellHash, type LineRange } from "../src/cellAttach";

const SOCK = defaultSocketPath();
const live = existsSync(SOCK);

// Percent doc: each code cell's body is exactly what we submit to the kernel,
// so daemon cell_hash = sha256(code) == extension computeCellHash(cellSource).
const DOC = [
  "# %% loop",
  "for i in range(3):",
  "    print(i)",
  "# %% value",
  "41 + 1",
  "# %% boom",
  'raise ValueError("kaboom")',
  "",
].join("\n");

function terminal(status: string): boolean {
  return status === "done" || status === "error" || status === "orphaned";
}

async function waitFor(pred: () => boolean, ms = 30000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!live)("output restore over a real daemon (v7)", () => {
  const cells = parse(DOC).cells;
  const codeCells = cells.filter((c) => c.kind === "code");
  let live1: SessionClient; // attached from the start; folds the live raw stream
  const execIds: string[] = [];

  beforeAll(async () => {
    live1 = new SessionClient(SOCK);
    await live1.attach(0); // empty journal at this point

    // Submit each cell's verbatim source, in order, with a cell origin.
    let lineBase = 0;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const span = (cell.hasMarker ? 1 : 0) + cell.body.length;
      if (cell.kind === "code") {
        const src = cellSource(cell);
        const range: LineRange = { start: lineBase, end: lineBase + span - 1 };
        const id = await live1.execute(src, {
          uri: "file:///w/restore.py",
          range,
          cell_hash: computeCellHash(src),
        });
        execIds.push(id);
      }
      lineBase += span;
    }

    // Wait until every submitted execution has reached a terminal state.
    await waitFor(() => {
      const byId = new Map(live1.executions().map((e) => [e.execId, e]));
      return execIds.every((id) => byId.has(id) && terminal(byId.get(id)!.status));
    });
  }, 60000);

  afterAll(() => {
    live1?.close();
  });

  it("a fresh reconnect restores outputs and attaches them to the right cells", async () => {
    // The reconnect: a brand-new client that never saw the live run.
    const reconnect = new SessionClient(SOCK);
    await reconnect.attach(0);
    try {
      expect(reconnect.executions().length).toBe(codeCells.length);

      const att = reconnect.restoreInto(cells);
      const idx = (k: string) => cells.indexOf(cells.find((c) => c.body.some((l) => l.text.includes(k)))!);

      const loopCell = idx("print(i)");
      const valueCell = idx("41 + 1");
      const boomCell = idx("kaboom");

      // loop cell: folded stdout stream "0\n1\n2\n"
      const loop = att.get(loopCell)!;
      expect(loop).toBeTruthy();
      expect(loop.stale).toBe(false);
      expect(loop.outputs).toEqual([{ output_type: "stream", name: "stdout", text: "0\n1\n2\n" }]);

      // value cell: execute_result text/plain "42"
      const value = att.get(valueCell)!;
      expect(value.stale).toBe(false);
      const vr = value.outputs[0] as any;
      expect(vr.output_type).toBe("execute_result");
      expect(vr.data["text/plain"]).toBe("42");

      // boom cell: error output, ename ValueError
      const boom = att.get(boomCell)!;
      expect(boom.stale).toBe(false);
      const er = boom.outputs[0] as any;
      expect(er.output_type).toBe("error");
      expect(er.ename).toBe("ValueError");
    } finally {
      reconnect.close();
    }
  });

  it("client live-fold equals daemon snapshot fold (snapshot+delta equivalence)", async () => {
    const reconnect = new SessionClient(SOCK);
    await reconnect.attach(0);
    try {
      for (const id of execIds) {
        // live1 folded the raw event stream; reconnect seeded from the daemon's
        // already-folded snapshot. They must agree byte-for-byte.
        expect(reconnect.outputsOf(id)).toEqual(live1.outputsOf(id));
      }
    } finally {
      reconnect.close();
    }
  });
});
