/**
 * Live cell-output synchronization with bounded render cost (design.md §3.1/§3.3
 * live path). Turns the daemon's per-event stream into a *coalesced* sequence of
 * sink operations so a 50k-iteration loop does not melt the renderer:
 *
 *  - throttle/coalesce: events accumulate; a flush (driven by an injected
 *    Scheduler) emits the conflated result once per window, not once per event;
 *  - run-merge: consecutive same-stream deltas in a window collapse to ONE
 *    append (tqdm's 1000 updates -> 1 append), while interleaving order with
 *    discrete outputs (execute_result/error) is preserved;
 *  - delta-append: stream output is appended (the new bytes only), never the
 *    whole growing buffer — `\r` collapsing is left to the stream renderer;
 *  - dirty-set: only cells that changed are touched;
 *  - memoized cell hashing: cell_hash -> cell index is computed once, not per
 *    event (the expensive sha256 pass runs only when the document changes).
 *
 * It is renderer-agnostic: the {@link CellSink} is implemented by the VSCode
 * controller in production and by an in-memory model in tests, so the coalescing
 * guarantees are unit-verifiable without a DOM.
 */
import type { Cell } from "./serializer";
import { computeCellHash, docCellsFromParsed, type DocCell } from "./cellAttach";
import type { OutputItem } from "./outputFold";
import type { LiveEvent } from "./sessionClient";

/** Where coalesced output operations are delivered (VSCode or a test model). */
export interface CellSink {
  /** Append a raw stream delta (may contain `\r`) to the cell's stdout/stderr. */
  appendStream(cellIndex: number, name: string, text: string): void;
  /** Append a discrete output (execute_result / display_data / error). */
  appendOutput(cellIndex: number, item: OutputItem): void;
  /** Update a previously displayed item in place (update_display_data). */
  updateDisplay(cellIndex: number, displayId: string, item: OutputItem): void;
  /** Clear all outputs of the cell. */
  clear(cellIndex: number): void;
  /** Optional: cell execution lifecycle (running/done) for UI affordances. */
  status?(cellIndex: number, status: string): void;
}

/** Drives flushing; injected so production throttles and tests step manually. */
export interface Scheduler {
  /** Request a flush. Implementations coalesce multiple requests into one run. */
  schedule(flush: () => void): void;
}

/** Trailing-edge throttle: at most one flush per `delayMs` window. */
export class ThrottleScheduler implements Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly delayMs = 50) {}
  schedule(flush: () => void): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      flush();
    }, this.delayMs);
  }
}

type PendingOp =
  | { t: "stream"; name: string; text: string }
  | { t: "output"; item: OutputItem }
  | { t: "display"; displayId: string; item: OutputItem }
  | { t: "clear" }
  | { t: "status"; status: string };

export interface LiveStats {
  events: number;
  flushes: number;
  sinkCalls: number;
}

export class LiveOutputSync {
  private readonly hashIndex = new Map<string, number>();
  private readonly execToCell = new Map<string, number>();
  private readonly pending = new Map<number, PendingOp[]>();
  private readonly pendingClear = new Set<string>(); // execIds with deferred clear
  private readonly dirty = new Set<number>();
  private flushScheduled = false;
  readonly stats: LiveStats = { events: 0, flushes: 0, sinkCalls: 0 };

  constructor(
    cells: Cell[],
    private readonly sink: CellSink,
    private readonly scheduler: Scheduler,
  ) {
    this.refreshCells(cells);
  }

  /**
   * Rebuild the cell_hash -> cell-index map from the current document cells.
   * The index is otherwise computed once at construction; call this when cells
   * are ADDED or EDITED after live sync started, so a newly-added cell's
   * execution still maps (otherwise its output is dropped — ADR-022). Cheap: one
   * sha256 pass over the cells, not per event.
   */
  refreshCells(cells: Cell[]): void {
    this.hashIndex.clear();
    const docCells: DocCell[] = docCellsFromParsed(cells);
    for (const dc of docCells) {
      if (!this.hashIndex.has(dc.cellHash)) this.hashIndex.set(dc.cellHash, dc.index);
    }
  }

  /** Seed exec->cell mappings from a snapshot (executions already carry cell_hash). */
  seed(execs: Array<{ execId: string; cellHash: string | null }>): void {
    for (const e of execs) {
      if (!e.cellHash) continue;
      const idx = this.hashIndex.get(e.cellHash);
      if (idx !== undefined) this.execToCell.set(e.execId, idx);
    }
  }

  /** Cell index an execution maps to (after {@link seed}), or undefined. */
  cellOf(execId: string): number | undefined {
    return this.execToCell.get(execId);
  }

  /** Feed one wire event. Cheap: folds into pending ops + schedules a flush. */
  onEvent(ev: LiveEvent): void {
    this.stats.events += 1;
    const execId = ev.exec_id;
    if (!execId) return;

    if (ev.kind === "queued") {
      // Learn this execution's cell from its code (hash matches the doc cell).
      const code = ev.payload?.code;
      if (typeof code === "string") {
        const idx = this.hashIndex.get(computeCellHash(code));
        if (idx !== undefined) this.execToCell.set(execId, idx);
      }
      return;
    }

    const idx = this.execToCell.get(execId);
    if (idx === undefined) return; // execution not mapped to a present cell

    if (ev.kind === "started") {
      this.queue(idx, { t: "status", status: "running" });
    } else if (ev.kind === "done") {
      this.queue(idx, { t: "status", status: ev.payload?.status ?? "done" });
    } else if (ev.kind === "output") {
      this.handleOutput(execId, idx, ev.payload?.msg_type, ev.payload?.content ?? {});
    }
    this.scheduleFlush();
  }

  private handleOutput(execId: string, idx: number, msgType: string, content: any): void {
    if (msgType === "clear_output") {
      if (content?.wait) this.pendingClear.add(execId);
      else {
        this.dropPending(idx);
        this.queue(idx, { t: "clear" });
      }
      return;
    }
    if (msgType === "update_display_data") {
      const did = content?.transient?.display_id;
      if (did != null) {
        this.queue(idx, { t: "display", displayId: did, item: toDisplay(content) });
      }
      return;
    }
    if (!["stream", "display_data", "execute_result", "error"].includes(msgType)) return;

    // A deferred clear fires when the next real output arrives.
    if (this.pendingClear.delete(execId)) {
      this.dropPending(idx);
      this.queue(idx, { t: "clear" });
    }

    if (msgType === "stream") {
      this.queueStream(idx, content?.name ?? "stdout", content?.text ?? "");
    } else if (msgType === "execute_result") {
      this.queue(idx, { t: "output", item: toExecResult(content) });
    } else if (msgType === "display_data") {
      this.queue(idx, { t: "output", item: toDisplay(content) });
    } else if (msgType === "error") {
      this.queue(idx, { t: "output", item: toError(content) });
    }
  }

  /** Run-merge: fold consecutive same-name stream deltas into one append op. */
  private queueStream(idx: number, name: string, text: string): void {
    if (!text) return;
    const ops = this.pending.get(idx);
    const last = ops && ops.length ? ops[ops.length - 1] : undefined;
    if (last && last.t === "stream" && last.name === name) {
      last.text += text;
    } else {
      this.queue(idx, { t: "stream", name, text });
    }
  }

  private queue(idx: number, op: PendingOp): void {
    let ops = this.pending.get(idx);
    if (!ops) {
      ops = [];
      this.pending.set(idx, ops);
    }
    ops.push(op);
    this.dirty.add(idx);
  }

  private dropPending(idx: number): void {
    this.pending.set(idx, []);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.scheduler.schedule(() => this.flush());
  }

  /** Emit the coalesced ops for every dirty cell, in order. */
  flush(): void {
    this.flushScheduled = false;
    if (this.dirty.size === 0) return;
    this.stats.flushes += 1;
    for (const idx of this.dirty) {
      const ops = this.pending.get(idx) ?? [];
      for (const op of ops) {
        this.stats.sinkCalls += 1;
        switch (op.t) {
          case "stream":
            this.sink.appendStream(idx, op.name, op.text);
            break;
          case "output":
            this.sink.appendOutput(idx, op.item);
            break;
          case "display":
            this.sink.updateDisplay(idx, op.displayId, op.item);
            break;
          case "clear":
            this.sink.clear(idx);
            break;
          case "status":
            this.sink.status?.(idx, op.status);
            break;
        }
      }
      this.pending.delete(idx);
    }
    this.dirty.clear();
  }
}

function toExecResult(content: any): OutputItem {
  return {
    output_type: "execute_result",
    data: content?.data ?? {},
    metadata: content?.metadata ?? {},
    execution_count: content?.execution_count ?? null,
  };
}

function toDisplay(content: any): OutputItem {
  const item: any = {
    output_type: "display_data",
    data: content?.data ?? {},
    metadata: content?.metadata ?? {},
  };
  const did = content?.transient?.display_id;
  if (did != null) item.display_id = did;
  return item;
}

function toError(content: any): OutputItem {
  return {
    output_type: "error",
    ename: content?.ename,
    evalue: content?.evalue,
    traceback: content?.traceback ?? [],
  };
}
