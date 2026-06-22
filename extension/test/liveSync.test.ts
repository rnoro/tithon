import { describe, it, expect } from "vitest";
import { parse, cellSource } from "../src/serializer";
import { computeCellHash } from "../src/cellAttach";
import { ExecutionFold, type OutputItem } from "../src/outputFold";
import { LiveOutputSync, type CellSink, type Scheduler } from "../src/liveSync";
import type { LiveEvent } from "../src/sessionClient";

const DOC = ["# %% a", "a = 1", "# %% b", "b = 2", ""].join("\n");
const cells = parse(DOC).cells;
const src = (i: number) => cellSource(cells[i]);

/** Scheduler that runs flushes only when the test calls tick(). */
class ManualScheduler implements Scheduler {
  private pending: (() => void) | null = null;
  schedule(flush: () => void): void {
    this.pending = flush;
  }
  tick(): void {
    const f = this.pending;
    this.pending = null;
    f?.();
  }
}

class TestSink implements CellSink {
  ops: Array<{ op: string; idx: number; name?: string; text?: string; status?: string }> = [];
  private rawStdout = new Map<number, string>();
  appendStream(idx: number, name: string, text: string): void {
    this.ops.push({ op: "appendStream", idx, name, text });
    if (name === "stdout") this.rawStdout.set(idx, (this.rawStdout.get(idx) ?? "") + text);
  }
  appendOutput(idx: number, item: OutputItem): void {
    this.ops.push({ op: "appendOutput", idx, text: textOf(item) });
  }
  updateDisplay(idx: number, displayId?: string, item?: OutputItem): void {
    this.ops.push({ op: "updateDisplay", idx, name: displayId, text: textOf(item) });
  }
  clear(idx: number): void {
    this.ops.push({ op: "clear", idx });
    this.rawStdout.set(idx, "");
  }
  status(idx: number, status: string): void {
    this.ops.push({ op: "status", idx, status });
  }
  /** Visible stdout text of a cell = fold of the raw appended deltas (\r applied). */
  visibleStdout(idx: number): string {
    const f = new ExecutionFold();
    f.apply("stream", { name: "stdout", text: this.rawStdout.get(idx) ?? "" });
    const o = f.outputs()[0] as Extract<OutputItem, { output_type: "stream" }> | undefined;
    return o?.text ?? "";
  }
}

/** text/plain of a display/result item (for asserting in-place update content). */
function textOf(item?: OutputItem): string | undefined {
  if (item && (item.output_type === "display_data" || item.output_type === "execute_result")) {
    const t = item.data?.["text/plain"];
    return typeof t === "string" ? t : undefined;
  }
  return undefined;
}

function queued(execId: string, code: string): LiveEvent {
  return { seq: 1, exec_id: execId, kind: "queued", payload: { code } };
}
function stream(execId: string, text: string, name = "stdout"): LiveEvent {
  return { seq: 2, exec_id: execId, kind: "output", payload: { msg_type: "stream", content: { name, text } } };
}
function output(execId: string, msg_type: string, content: any): LiveEvent {
  return { seq: 2, exec_id: execId, kind: "output", payload: { msg_type, content } };
}

describe("LiveOutputSync — coalescing & correctness", () => {
  it("coalesces a 10k-event stream burst into ONE flush and ONE append", () => {
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(cells, sink, sched);

    live.onEvent(queued("e1", src(0)));
    let expected = "";
    for (let i = 0; i < 10000; i++) {
      live.onEvent(stream("e1", `${i}\n`));
      expected += `${i}\n`;
    }
    // nothing rendered until the scheduler fires
    expect(sink.ops.length).toBe(0);
    expect(live.stats.events).toBe(10001);

    sched.tick();
    expect(live.stats.flushes).toBe(1);
    expect(live.stats.sinkCalls).toBe(1); // 10k stream events -> 1 append
    expect(sink.ops.filter((o) => o.op === "appendStream").length).toBe(1);
    expect(sink.visibleStdout(0)).toBe(expected);
  });

  it("bounds sink calls to the number of flush windows, not events", () => {
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(cells, sink, sched);
    live.onEvent(queued("e1", src(0)));

    for (let w = 0; w < 10; w++) {
      for (let i = 0; i < 1000; i++) live.onEvent(stream("e1", "x\n"));
      sched.tick();
    }
    expect(live.stats.events).toBe(10001);
    expect(live.stats.flushes).toBe(10);
    // one merged append per window (10), not 10000
    expect(sink.ops.filter((o) => o.op === "appendStream").length).toBe(10);
  });

  it("preserves interleaving order of stream and discrete outputs", () => {
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(cells, sink, sched);
    live.onEvent(queued("e1", src(0)));

    live.onEvent(stream("e1", "A"));
    live.onEvent(output("e1", "execute_result", { data: { "text/plain": "R" }, execution_count: 1 }));
    live.onEvent(stream("e1", "B"));
    sched.tick();

    const kinds = sink.ops.filter((o) => o.idx === 0).map((o) => o.op);
    expect(kinds).toEqual(["appendStream", "appendOutput", "appendStream"]);
  });

  it("passes raw \\r through so the renderer collapses tqdm to its final line", () => {
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(cells, sink, sched);
    live.onEvent(queued("e1", src(0)));

    for (const p of ["10%\r", "50%\r", "100%"]) live.onEvent(stream("e1", p));
    sched.tick();

    expect(sink.ops.filter((o) => o.op === "appendStream").length).toBe(1);
    expect(sink.visibleStdout(0)).toBe("100%");
  });

  it("handles deferred clear_output(wait): clears then shows the new output", () => {
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(cells, sink, sched);
    live.onEvent(queued("e1", src(0)));

    live.onEvent(stream("e1", "old\n"));
    sched.tick();
    expect(sink.visibleStdout(0)).toBe("old\n");

    live.onEvent(output("e1", "clear_output", { wait: true }));
    live.onEvent(stream("e1", "new"));
    sched.tick();

    const window2 = sink.ops.slice(1).filter((o) => o.idx === 0).map((o) => o.op);
    expect(window2).toEqual(["clear", "appendStream"]);
    expect(sink.visibleStdout(0)).toBe("new");
  });

  it("ignores events for executions not mapped to a present cell", () => {
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(cells, sink, sched);
    live.onEvent(stream("ghost", "noone\n")); // no queued/seed for "ghost"
    sched.tick();
    expect(sink.ops.length).toBe(0);
  });

  it("maps executions seeded from a snapshot (cell_hash) to the right cell", () => {
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(cells, sink, sched);
    live.seed([{ execId: "e9", cellHash: computeCellHash(src(1)) }]);
    live.onEvent(stream("e9", "hello"));
    sched.tick();
    expect(sink.ops).toEqual([{ op: "appendStream", idx: 1, name: "stdout", text: "hello" }]);
  });

  it("follows content to its moved cell on reconnect after a top insert — ADR-047 (#2)", () => {
    // FIRST/SECOND ran at idx 0/1; a cell was inserted on top, so the document is
    // now INSERTED(0) FIRST(1) SECOND(2). Seeding by the old indices must follow
    // the cell_hash to the shifted cells, not misattribute by one.
    const ran = parse(["# %% a", "a = 1", "# %% b", "b = 2", ""].join("\n")).cells;
    const after = parse(["# %% i", "ins = 0", "# %% a", "a = 1", "# %% b", "b = 2", ""].join("\n")).cells;
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(after, sink, sched);
    live.seed([
      { execId: "e1", cellHash: computeCellHash(cellSource(ran[0])), index: 0 },
      { execId: "e2", cellHash: computeCellHash(cellSource(ran[1])), index: 1 },
    ]);
    expect(live.cellOf("e1")).toBe(1); // FIRST moved to cell 1
    expect(live.cellOf("e2")).toBe(2); // SECOND moved to cell 2
    expect(live.staleOf("e1")).toBe(false);
  });

  it("maps an edited-in-place cell by index and marks it stale — ADR-047 (#3)", () => {
    // The cell ran as code A, then was edited (hash differs) and the old code is
    // nowhere else: map back to the same index, flagged stale.
    const after = parse(["# %% a", "edited = 1", ""].join("\n")).cells;
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(after, sink, sched);
    live.seed([{ execId: "e1", cellHash: computeCellHash("ran = 0\n"), index: 0 }]);
    expect(live.cellOf("e1")).toBe(0);
    expect(live.staleOf("e1")).toBe(true);
  });

  it("normalizes a done(status:ok) event to 'done' so the cell shows ✓ not ✗", () => {
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(cells, sink, sched);
    live.onEvent(queued("e1", src(0)));
    // daemon reports success as status "ok".
    live.onEvent({ seq: 3, exec_id: "e1", kind: "done", payload: { status: "ok" } });
    sched.tick();
    const st = sink.ops.filter((o) => o.op === "status").map((o) => o.status);
    expect(st).toContain("done");
    expect(st).not.toContain("ok"); // must not leak the raw kernel status

    // an error result maps to "error".
    const sink2 = new TestSink();
    const live2 = new LiveOutputSync(cells, sink2, sched);
    live2.onEvent(queued("e2", src(1)));
    live2.onEvent({ seq: 3, exec_id: "e2", kind: "done", payload: { status: "error" } });
    sched.tick();
    expect(sink2.ops.filter((o) => o.op === "status").map((o) => o.status)).toContain("error");
  });

  it("emits no status op for a 'skipped' cell — Run-All stop-on-error (ADR-051)", () => {
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(cells, sink, sched);
    live.onEvent(queued("e1", src(0)));
    // The daemon skipped this cell after an earlier error in the same Run-All.
    live.onEvent({ seq: 3, exec_id: "e1", kind: "done", payload: { status: "skipped" } });
    sched.tick();
    // No status op -> the cell is left blank (a ✓/✗ would imply it ran).
    expect(sink.ops.filter((o) => o.op === "status").length).toBe(0);
    expect(sink.ops.length).toBe(0);
  });

  it("routes duplicate-code cells by recorded index, not hash — ADR-026 (#2 repro)", () => {
    // Two cells with IDENTICAL code. The second cell's output must NOT collapse
    // onto the first; the queued event's origin.index disambiguates them.
    const dupDoc = ["# %% a", "print(1)", "# %% b", "print(1)", ""].join("\n");
    const dupCells = parse(dupDoc).cells;
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(dupCells, sink, sched);

    const qIdx = (execId: string, code: string, index: number): LiveEvent => ({
      seq: 1, exec_id: execId, kind: "queued", payload: { code, origin: { index } },
    });
    live.onEvent(qIdx("e0", cellSource(dupCells[0]), 0));
    live.onEvent(qIdx("e1", cellSource(dupCells[1]), 1));
    live.onEvent(stream("e0", "first\n"));
    live.onEvent(stream("e1", "second\n"));
    sched.tick();

    expect(sink.visibleStdout(0)).toBe("first\n");
    expect(sink.visibleStdout(1)).toBe("second\n"); // not collapsed onto cell 0
  });
});

describe("LiveOutputSync — refreshCells (ADR-022: cell added after live started)", () => {
  it("drops a not-yet-indexed cell's output, then maps it after refreshCells", () => {
    const sched = new ManualScheduler();
    const sink = new TestSink();
    // Live sync starts when only cell "a" exists.
    const initial = parse(["# %% a", "a = 1", ""].join("\n")).cells;
    const live = new LiveOutputSync(initial, sink, sched);

    const full = parse(DOC).cells; // a, b
    const bSrc = cellSource(full[1]);

    // Cell "b" is added and run, but the index predates it -> output dropped.
    live.onEvent(queued("e2", bSrc));
    live.onEvent(stream("e2", "B\n"));
    sched.tick();
    expect(sink.ops.length).toBe(0);

    // Refresh from the current 2-cell document; a re-run now maps to cell 1.
    live.refreshCells(full);
    live.onEvent(queued("e2b", bSrc));
    live.onEvent(stream("e2b", "B\n"));
    sched.tick();
    expect(sink.visibleStdout(1)).toBe("B\n");
  });
});

describe("LiveOutputSync — update_display_data in-place (Fix E coalescing)", () => {
  const disp = (execId: string, v: string): LiveEvent =>
    output(execId, "display_data", { data: { "text/plain": v }, transient: { display_id: "d" } });
  const upd = (execId: string, v: string): LiveEvent =>
    output(execId, "update_display_data", { data: { "text/plain": v }, transient: { display_id: "d" } });

  it("routes update_display_data to updateDisplay, never appendOutput (no stacking)", () => {
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(cells, sink, sched);
    live.onEvent(queued("e1", src(0)));
    live.onEvent(upd("e1", "x"));
    sched.tick();
    expect(sink.ops.filter((o) => o.op === "updateDisplay").length).toBe(1);
    expect(sink.ops.filter((o) => o.op === "appendOutput").length).toBe(0);
  });

  it("bounds 1000 updates in one window to a SINGLE in-place updateDisplay (latest content)", () => {
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(cells, sink, sched);
    live.onEvent(queued("e1", src(0)));

    live.onEvent(disp("e1", "v0"));
    sched.tick(); // window 1: the create -> one appendOutput
    expect(sink.ops.filter((o) => o.op === "appendOutput").length).toBe(1);

    for (let i = 1; i <= 1000; i++) live.onEvent(upd("e1", `v${i}`));
    sched.tick(); // window 2: 1000 updates -> ONE updateDisplay

    const upds = sink.ops.filter((o) => o.op === "updateDisplay");
    expect(upds.length).toBe(1);
    expect(upds[0].name).toBe("d"); // display_id routed through
    expect(upds[0].text).toBe("v1000"); // only the latest content survives
  });

  it("folds a create + its updates in ONE window into a single appendOutput", () => {
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(cells, sink, sched);
    live.onEvent(queued("e1", src(0)));

    live.onEvent(disp("e1", "v0"));
    for (let i = 1; i <= 1000; i++) live.onEvent(upd("e1", `v${i}`));
    sched.tick();

    expect(sink.ops.filter((o) => o.op === "appendOutput").length).toBe(1);
    expect(sink.ops.filter((o) => o.op === "updateDisplay").length).toBe(0);
    expect(sink.ops.find((o) => o.op === "appendOutput")?.text).toBe("v1000"); // latest folded in
  });

  it("does not merge an update across a clear", () => {
    const sched = new ManualScheduler();
    const sink = new TestSink();
    const live = new LiveOutputSync(cells, sink, sched);
    live.onEvent(queued("e1", src(0)));

    live.onEvent(upd("e1", "a"));
    live.onEvent(output("e1", "clear_output", {})); // immediate clear drops pending
    live.onEvent(upd("e1", "b"));
    sched.tick();

    const ops = sink.ops.filter((o) => o.idx === 0).map((o) => o.op);
    expect(ops).toEqual(["clear", "updateDisplay"]);
    expect(sink.ops.find((o) => o.op === "updateDisplay")?.text).toBe("b");
  });
});
