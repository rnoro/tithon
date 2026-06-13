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
  appendOutput(idx: number, _item: OutputItem): void {
    this.ops.push({ op: "appendOutput", idx });
  }
  updateDisplay(idx: number): void {
    this.ops.push({ op: "updateDisplay", idx });
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
});
