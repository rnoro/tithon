/**
 * SessionClient — the *subscribe* half of the daemon protocol (design.md §3.1).
 *
 * `DaemonClient` only submits code; this client attaches with `last_seen_seq`,
 * consumes the snapshot + delta + live event stream, and maintains the current
 * folded output of every execution. That is the piece that makes a reconnect
 * (e.g. reopening the notebook over a VSCode tunnel) restore cell outputs:
 *
 *   attach(0) -> snapshot seeds each execution's folded outputs
 *             -> live `output` events keep in-flight executions current
 *   restoreInto(cells) -> attach those outputs to the document's cells by
 *                         cell_hash (design.md §3.2, see cellAttach).
 *
 * Snapshot+delta equivalence (a since-0 attach and a since-N delta replay fold
 * to the same state) is what verify/v7 checks against a real daemon.
 */
import WebSocket from "ws";
import { homedir } from "os";
import { join } from "path";
import { ExecutionFold, type OutputItem } from "./outputFold";
import {
  attachOutputs,
  docCellsFromParsed,
  type Attachment,
  type JournalExecution,
  type LineRange,
} from "./cellAttach";
import type { Cell } from "./serializer";

export function defaultSocketPath(): string {
  const home = process.env.TITHON_HOME ?? join(homedir(), ".tithon");
  return join(home, "daemon.sock");
}

function unixWsUrl(sockPath: string): string {
  return `ws+unix://${sockPath}:/`;
}

export interface ExecOrigin {
  uri: string;
  range: LineRange;
  cell_hash: string;
}

/** A wire `event` op as delivered to {@link SessionClient.onEvent}. */
export interface LiveEvent {
  seq: number;
  exec_id: string | null;
  kind: string;
  payload: any;
}

/** Live state the client tracks per execution. */
export interface ExecState {
  execId: string;
  seq: number;
  code: string;
  status: string;
  cellHash: string | null;
  origin: { uri?: string | null; range?: LineRange | null } | null;
  fold: ExecutionFold;
}

interface SnapshotExecWire {
  exec_id: string;
  seq: number;
  code: string;
  status: string;
  execution_count: number | null;
  cell_hash: string | null;
  origin: { uri?: string | null; range?: LineRange | null } | null;
  outputs: OutputItem[];
}

export class SessionClient {
  private ws: WebSocket | null = null;
  private readonly execs = new Map<string, ExecState>();
  private order: string[] = [];
  private onChangeCb: (() => void) | null = null;
  private onEventCb: ((ev: LiveEvent) => void) | null = null;
  /** Highest seq the daemon told us about (snapshot.max_seq or last sync). */
  syncSeq = 0;

  constructor(private readonly sockPath: string = defaultSocketPath()) {}

  onChange(cb: () => void): void {
    this.onChangeCb = cb;
  }

  /** Raw per-event hook (fires for every `event` op) — used by LiveOutputSync. */
  onEvent(cb: (ev: LiveEvent) => void): void {
    this.onEventCb = cb;
  }

  /** Executions in submission order. */
  executions(): ExecState[] {
    return this.order.map((id) => this.execs.get(id)!).filter(Boolean);
  }

  private ensureExec(execId: string, seq: number): ExecState {
    let st = this.execs.get(execId);
    if (!st) {
      st = {
        execId,
        seq,
        code: "",
        status: "unknown",
        cellHash: null,
        origin: null,
        fold: new ExecutionFold(),
      };
      this.execs.set(execId, st);
      this.order.push(execId);
    }
    return st;
  }

  /**
   * Attach and read the backlog (snapshot or delta) up to the `sync` marker,
   * then keep folding live events until {@link close}. Resolves once the
   * initial backlog has been applied (state is ready for {@link restoreInto}).
   */
  attach(lastSeenSeq = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(unixWsUrl(this.sockPath));
      this.ws = ws;
      let synced = false;
      ws.once("open", () => {
        ws.send(JSON.stringify({ op: "attach", last_seen_seq: lastSeenSeq }));
      });
      ws.on("message", (raw: WebSocket.RawData) => {
        let m: any;
        try {
          m = JSON.parse(raw.toString());
        } catch {
          return;
        }
        try {
          this.handle(m);
        } catch (err) {
          if (!synced) reject(err);
          return;
        }
        if (m.op === "sync") {
          this.syncSeq = m.seq ?? this.syncSeq;
          if (!synced) {
            synced = true;
            resolve();
          }
        }
        this.onChangeCb?.();
      });
      ws.once("error", (err) => {
        if (!synced) reject(err);
      });
      ws.once("close", () => {
        if (!synced) reject(new Error("daemon closed connection before sync"));
      });
    });
  }

  private handle(m: any): void {
    switch (m.op) {
      case "snapshot":
        this.applySnapshot(m);
        break;
      case "event":
        this.applyEvent(m);
        this.onEventCb?.(m as LiveEvent);
        break;
      // "sync" handled by the caller; status_reply/execute_ack ignored here.
    }
  }

  private applySnapshot(snap: { max_seq?: number; executions?: SnapshotExecWire[] }): void {
    this.syncSeq = snap.max_seq ?? this.syncSeq;
    for (const e of snap.executions ?? []) {
      const st = this.ensureExec(e.exec_id, e.seq);
      st.seq = e.seq;
      st.code = e.code;
      st.status = e.status;
      st.cellHash = e.cell_hash ?? null;
      st.origin = e.origin ?? null;
      // Seed the fold from the daemon's already-folded outputs so a still
      // running execution keeps folding correctly as live events arrive.
      st.fold = new ExecutionFold();
      st.fold.seed(e.outputs ?? []);
    }
  }

  private applyEvent(ev: { seq: number; exec_id: string | null; kind: string; payload: any }): void {
    if (!ev.exec_id) return;
    const st = this.ensureExec(ev.exec_id, ev.seq);
    st.seq = Math.max(st.seq, ev.seq ?? st.seq);
    switch (ev.kind) {
      case "queued":
        st.code = ev.payload?.code ?? st.code;
        st.status = "queued";
        break;
      case "started":
        st.status = "running";
        break;
      case "done":
        st.status = ev.payload?.status === "ok" ? "done" : (ev.payload?.status ?? "done");
        break;
      case "output":
        st.fold.apply(ev.payload?.msg_type, ev.payload?.content ?? {});
        break;
      // "status" / "widget" do not change cell outputs here.
    }
  }

  /** Folded outputs of one execution (current state). */
  outputsOf(execId: string): OutputItem[] {
    return this.execs.get(execId)?.fold.outputs() ?? [];
  }

  /** Convert tracked executions into the attach model (cell_hash carries the key). */
  journalExecutions(): JournalExecution[] {
    const out: JournalExecution[] = [];
    for (const st of this.executions()) {
      if (!st.cellHash) continue;
      out.push({
        execId: st.execId,
        cellHash: st.cellHash,
        range: st.origin?.range ?? { start: 0, end: 0 },
        outputs: st.fold.outputs(),
      });
    }
    return out;
  }

  /**
   * Attach restored outputs to the cells of a parsed percent document. This is
   * the end product a notebook controller renders: `Map<cellIndex, Attachment>`
   * with folded outputs and a `stale` flag when the cell was edited since the run.
   */
  restoreInto(cells: Cell[]): Map<number, Attachment> {
    return attachOutputs(this.journalExecutions(), docCellsFromParsed(cells));
  }

  /** Submit code (live-only sub first, like DaemonClient). Returns exec_id. */
  execute(code: string, origin?: ExecOrigin): Promise<string> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(unixWsUrl(this.sockPath));
      const onMsg = (raw: WebSocket.RawData) => {
        let m: any;
        try {
          m = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (m.op === "sync") {
          ws.send(JSON.stringify({ op: "execute", code, origin }));
        } else if (m.op === "execute_ack") {
          ws.off("message", onMsg);
          ws.close();
          resolve(m.exec_id as string);
        }
      };
      ws.once("open", () => ws.send(JSON.stringify({ op: "attach", last_seen_seq: -1 })));
      ws.on("message", onMsg);
      ws.once("error", reject);
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
