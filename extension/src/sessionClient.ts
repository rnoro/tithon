/**
 * SessionClient — the *subscribe* half of the daemon protocol (SPEC.md).
 *
 * `DaemonClient` only submits code; this client attaches with `last_seen_seq`,
 * consumes the snapshot + delta + live event stream, and maintains the current
 * folded output of every execution. That is the piece that makes a reconnect
 * (e.g. reopening the notebook over a VSCode tunnel) restore cell outputs:
 *
 *   attach(0) -> snapshot seeds each execution's folded outputs
 *             -> live `output` events keep in-flight executions current
 *   restoreInto(cells) -> attach those outputs to the document's cells by
 *                         cell_hash (SPEC.md, see cellAttach).
 *
 * Snapshot+delta equivalence (a since-0 attach and a since-N delta replay fold
 * to the same state) is what scripts/v7 checks against a real daemon.
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
import type { WidgetState } from "./richOutput";

/** Image bytes resolved from a `$tithon_artifact` reference. */
export interface ArtifactBytes {
  mime: string;
  bytes: Uint8Array;
}

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
  /** 0-based cell index — disambiguates identical-code cells (duplicate-cell bug). */
  index?: number;
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
  origin: { uri?: string | null; range?: LineRange | null; index?: number | null } | null;
  fold: ExecutionFold;
  /** Daemon-side wall-clock seconds (epoch); null until known. */
  startedAt: number | null;
  finishedAt: number | null;
}

interface SnapshotExecWire {
  exec_id: string;
  seq: number;
  code: string;
  status: string;
  execution_count: number | null;
  cell_hash: string | null;
  origin: { uri?: string | null; range?: LineRange | null; index?: number | null } | null;
  outputs: OutputItem[];
  started_at: number | null;
  finished_at: number | null;
}

export class SessionClient {
  private ws: WebSocket | null = null;
  private readonly execs = new Map<string, ExecState>();
  private order: string[] = [];
  private onChangeCb: (() => void) | null = null;
  private onEventCb: ((ev: LiveEvent) => void) | null = null;
  private kernelInfoData: { status?: string; pid?: number | null; python?: string | null } | null = null;
  private widgetState: WidgetState | null = null;
  /** id -> resolved bytes (null = fetched but not found). Dedupes refetches. */
  private readonly artifactCache = new Map<string, ArtifactBytes | null>();
  /** Highest seq the daemon told us about (snapshot.max_seq or last sync). */
  syncSeq = 0;

  /**
   * `session` is the file uri — one kernel + journal per file (like Jupyter).
   * Defaults to "default" (the CLI/REPL session) when omitted.
   */
  constructor(
    private readonly sockPath: string = defaultSocketPath(),
    private readonly session: string = "default",
  ) {}

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

  /** Kernel info from the snapshot (status/pid/python), or null pre-attach. */
  kernelInfo(): { status?: string; pid?: number | null; python?: string | null } | null {
    return this.kernelInfoData;
  }

  /** The widget state mirror from the snapshot (for the §3.3 text fallback). */
  widgets(): WidgetState | null {
    return this.widgetState;
  }

  /** Synchronous read of an already-fetched artifact (undefined = not fetched). */
  cachedArtifact(id: string): ArtifactBytes | null | undefined {
    return this.artifactCache.get(id);
  }

  /**
   * Fetch a rich-output artifact's bytes by id over the unix socket (cached).
   * Images live as files on the host (SPEC.md); the client pulls the
   * bytes on demand and renders them as an `image/*` output item. `get_artifact`
   * binds the session on its first message, so no attach is needed.
   */
  getArtifact(id: string): Promise<ArtifactBytes | null> {
    const cached = this.artifactCache.get(id);
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise((resolve) => {
      const ws = new WebSocket(unixWsUrl(this.sockPath));
      let settled = false;
      const done = (v: ArtifactBytes | null) => {
        if (settled) return;
        settled = true;
        this.artifactCache.set(id, v);
        try { ws.close(); } catch { /* already closing */ }
        resolve(v);
      };
      ws.once("open", () =>
        ws.send(JSON.stringify({ op: "get_artifact", artifact_id: id, session: this.session })));
      ws.on("message", (raw: WebSocket.RawData) => {
        let m: any;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.op === "artifact") {
          done(m.found && typeof m.data_b64 === "string"
            ? { mime: m.mime, bytes: new Uint8Array(Buffer.from(m.data_b64, "base64")) }
            : null);
        }
      });
      ws.once("error", () => done(null));
      ws.once("close", () => done(null));
    });
  }

  /** Prefetch many artifacts (e.g. all images in a snapshot) before rendering. */
  async prefetchArtifacts(ids: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(ids)].map((id) => this.getArtifact(id)));
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
        startedAt: null,
        finishedAt: null,
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
        ws.send(JSON.stringify({ op: "attach", last_seen_seq: lastSeenSeq, session: this.session }));
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

  private applySnapshot(snap: {
    max_seq?: number;
    executions?: SnapshotExecWire[];
    kernel?: { status?: string; pid?: number | null; python?: string | null };
    widgets?: WidgetState;
  }): void {
    this.syncSeq = snap.max_seq ?? this.syncSeq;
    if (snap.kernel) this.kernelInfoData = snap.kernel;
    if (snap.widgets) this.widgetState = snap.widgets;
    for (const e of snap.executions ?? []) {
      const st = this.ensureExec(e.exec_id, e.seq);
      st.seq = e.seq;
      st.code = e.code;
      st.status = e.status;
      st.cellHash = e.cell_hash ?? null;
      st.origin = e.origin ?? null;
      st.startedAt = e.started_at ?? null;
      st.finishedAt = e.finished_at ?? null;
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
        st.origin = ev.payload?.origin ?? st.origin;
        st.status = "queued";
        break;
      case "started":
        st.status = "running";
        if (typeof ev.payload?.ts === "number") st.startedAt = ev.payload.ts;
        break;
      case "done":
        st.status = ev.payload?.status === "ok" ? "done" : (ev.payload?.status ?? "done");
        if (typeof ev.payload?.ts === "number") st.finishedAt = ev.payload.ts;
        break;
      case "output":
        st.fold.apply(ev.payload?.msg_type, ev.payload?.content ?? {});
        break;
      case "widget":
        this.applyWidgetEvent(ev.payload);
        break;
      // "status" does not change cell outputs here.
    }
  }

  /**
   * Maintain the widget mirror live from comm events so a fresh run's widget can
   * render (and the §3.3 text fallback be reconstructed) without waiting for a
   * reconnect snapshot — the comm_open precedes the widget's display_data, so the
   * model is present by the time it's shown. Mirrors the daemon's WidgetMirror.
   */
  private applyWidgetEvent(payload: { msg_type?: string; comm_id?: string; data?: any } | undefined): void {
    const commId = payload?.comm_id;
    if (!commId) return;
    if (!this.widgetState) this.widgetState = { version_major: 2, version_minor: 0, state: {} };
    if (!this.widgetState.state) this.widgetState.state = {};
    const models = this.widgetState.state;
    const data = payload?.data ?? {};
    if (payload?.msg_type === "comm_open") {
      const s = (data.state ?? {}) as Record<string, unknown>;
      models[commId] = {
        model_name: s._model_name as string | undefined,
        model_module: s._model_module as string | undefined,
        model_module_version: s._model_module_version as string | undefined,
        state: { ...s },
        buffers: [],
      };
    } else if (payload?.msg_type === "comm_msg") {
      if (data.method !== "update" && data.method !== "echo_update") return;
      const entry = models[commId];
      if (!entry) return;
      entry.state = { ...(entry.state ?? {}), ...(data.state ?? {}) };
    } else if (payload?.msg_type === "comm_close") {
      delete models[commId];
    }
  }

  /** Folded outputs of one execution (current state). */
  outputsOf(execId: string): OutputItem[] {
    return this.execs.get(execId)?.fold.outputs() ?? [];
  }

  /**
   * Convert tracked executions into the attach model (cell_hash carries the key).
   * When `fileUri` is given, only executions that originated from that file are
   * returned — the daemon journal is global/persistent, so this keeps a prior
   * file's runs from bleeding into the notebook being restored (see ADR-019).
   */
  journalExecutions(fileUri?: string): JournalExecution[] {
    const out: JournalExecution[] = [];
    for (const st of this.executions()) {
      if (!st.cellHash) continue;
      if (fileUri !== undefined && st.origin?.uri !== fileUri) continue;
      out.push({
        execId: st.execId,
        cellHash: st.cellHash,
        range: st.origin?.range ?? { start: 0, end: 0 },
        index: st.origin?.index ?? null,
        outputs: st.fold.outputs(),
      });
    }
    return out;
  }

  /**
   * Attach restored outputs to the cells of a parsed percent document. This is
   * the end product a notebook controller renders: `Map<cellIndex, Attachment>`.
   * Pass `fileUri` to scope restore to this file's runs (recommended; ADR-019).
   * Mapping is by exact cell_hash — a cell edited since its run restores nothing.
   */
  restoreInto(cells: Cell[], fileUri?: string): Map<number, Attachment> {
    return attachOutputs(this.journalExecutions(fileUri), docCellsFromParsed(cells));
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
          ws.send(JSON.stringify({ op: "execute", code, origin, session: this.session }));
        } else if (m.op === "execute_ack") {
          ws.off("message", onMsg);
          ws.close();
          resolve(m.exec_id as string);
        }
      };
      ws.once("open", () =>
        ws.send(JSON.stringify({ op: "attach", last_seen_seq: -1, session: this.session })));
      ws.on("message", onMsg);
      ws.once("error", reject);
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
