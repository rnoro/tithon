/**
 * Live cell-output synchronization with bounded render cost (SPEC.md
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
  /**
   * Optional: cell execution lifecycle for UI affordances (spinner/clock/check
   * and timing). `status` is "queued" | "running" | "done" | "error"; `tsMs` is
   * the daemon-side wall-clock (ms) of the transition, so a reconnecting client
   * shows the real elapsed/duration, not time since reconnect.
   */
  status?(cellIndex: number, status: string, tsMs?: number): void;
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
  | { t: "status"; status: string; tsMs?: number };

export interface LiveStats {
  events: number;
  flushes: number;
  sinkCalls: number;
}

export class LiveOutputSync {
  private readonly hashIndex = new Map<string, number>();
  private readonly indexHash = new Map<number, string>();
  private readonly cellIndices = new Set<number>();
  private readonly execToCell = new Map<string, number>();
  // execId -> the cell's code was EDITED since this run (mapped by index because
  // the old code is gone): its restored output is stale (ADR-047).
  private readonly execStale = new Map<string, boolean>();
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
    this.indexHash.clear();
    this.cellIndices.clear();
    const docCells: DocCell[] = docCellsFromParsed(cells);
    for (const dc of docCells) {
      this.cellIndices.add(dc.index);
      this.indexHash.set(dc.index, dc.cellHash);
      if (!this.hashIndex.has(dc.cellHash)) this.hashIndex.set(dc.cellHash, dc.index);
    }
  }

  /**
   * Resolve an execution's cell in three tiers (ADR-047, refines ADR-019/026):
   *   1. STRONG — the cell at `index` still has this code (hash matches): the
   *      authoritative key, and it tells identical-code cells apart (ADR-026).
   *   2. MOVED — the index'd cell's code differs but the exact code lives in
   *      another cell now (a cell was inserted/removed above, shifting indices):
   *      follow the content, not the stale index.
   *   3. STALE — the index'd cell was edited and the old code is nowhere else:
   *      attach to that same cell but flag it stale (the §3.2 stale badge).
   * Returns undefined when there is no index match and no hash match.
   */
  private resolveCell(
    index: number | null | undefined,
    cellHash: string | null | undefined,
  ): { index: number; stale: boolean } | undefined {
    const hasIndex = index != null && this.cellIndices.has(index);
    if (hasIndex && cellHash && this.indexHash.get(index!) === cellHash) {
      return { index: index!, stale: false }; // 1) strong
    }
    const moved = cellHash ? this.hashIndex.get(cellHash) : undefined;
    if (moved !== undefined) return { index: moved, stale: false }; // 2) moved
    if (hasIndex) return { index: index!, stale: true }; // 3) stale edit-in-place
    return undefined;
  }

  /** Seed exec->cell mappings from a snapshot (executions carry index + cell_hash). */
  seed(execs: Array<{ execId: string; cellHash: string | null; index?: number | null }>): void {
    for (const e of execs) {
      const r = this.resolveCell(e.index, e.cellHash);
      if (r !== undefined) {
        this.execToCell.set(e.execId, r.index);
        this.execStale.set(e.execId, r.stale);
      }
    }
  }

  /** Cell index an execution maps to (after {@link seed}), or undefined. */
  cellOf(execId: string): number | undefined {
    return this.execToCell.get(execId);
  }

  /** True when an execution's mapped cell was edited since it ran (ADR-047). */
  staleOf(execId: string): boolean {
    return this.execStale.get(execId) ?? false;
  }

  /** Feed one wire event. Cheap: folds into pending ops + schedules a flush. */
  onEvent(ev: LiveEvent): void {
    this.stats.events += 1;
    const execId = ev.exec_id;
    if (!execId) return;

    if (ev.kind === "queued") {
      // Learn this execution's cell: prefer the recorded cell index (handles two
      // cells with identical code — duplicate-cell bug ADR-026), else hash the code.
      const code = ev.payload?.code;
      const hash = typeof code === "string" ? computeCellHash(code) : null;
      const r = this.resolveCell(ev.payload?.origin?.index, hash);
      if (r !== undefined) {
        this.execToCell.set(execId, r.index);
        this.execStale.set(execId, r.stale);
      }
      // Reconnect restores the queued (pending) state via seedCell; for a fresh
      // live run the cell flips to "started" almost immediately, so we keep
      // queued map-only here (no extra sink op, preserves coalescing bounds).
      return;
    }

    const idx = this.execToCell.get(execId);
    if (idx === undefined) return; // execution not mapped to a present cell

    const tsMs = typeof ev.payload?.ts === "number" ? ev.payload.ts * 1000 : undefined;
    if (ev.kind === "started") {
      this.queue(idx, { t: "status", status: "running", tsMs });
    } else if (ev.kind === "done") {
      // The daemon reports kernel status "ok" on success; normalize to the
      // sink's vocabulary ("done"/"error") so a successful cell shows ✓, not ✗.
      const ok = (ev.payload?.status ?? "ok") === "ok";
      this.queue(idx, { t: "status", status: ok ? "done" : "error", tsMs });
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
      if (did != null) this.queueDisplay(idx, did, toDisplay(content));
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

  /**
   * Coalesce update_display_data within a flush window (mirrors queueStream's
   * run-merge): keep only the LATEST content per display_id, so a live-updating
   * display (e.g. update_display in a tight loop) costs ONE in-place sink call
   * per window, not one per event. If the display_data that CREATED this id is
   * still pending in the same window, fold the update into it (one appendOutput
   * carrying the latest content). A pending clear resets the merge horizon.
   */
  private queueDisplay(idx: number, displayId: string, item: OutputItem): void {
    const ops = this.pending.get(idx);
    if (ops) {
      for (let i = ops.length - 1; i >= 0; i--) {
        const op = ops[i];
        if (op.t === "clear") break; // don't merge across a clear
        if (op.t === "display" && op.displayId === displayId) {
          op.item = item; // supersede the earlier update with the latest
          return;
        }
        if (
          op.t === "output" &&
          op.item.output_type === "display_data" &&
          op.item.display_id === displayId &&
          (item.output_type === "display_data" || item.output_type === "execute_result")
        ) {
          op.item.data = item.data; // fold into the pending create
          op.item.metadata = item.metadata;
          return;
        }
      }
    }
    this.queue(idx, { t: "display", displayId, item });
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
            this.sink.status?.(idx, op.status, op.tsMs);
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
