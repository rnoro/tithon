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
import { ArtifactCache } from "./artifactCache";

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

/** A pending input()/getpass() prompt the kernel is blocked on. */
export interface PendingInput {
  exec_id: string | null;
  prompt: string;
  password: boolean;
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
  private onDisconnectCb: ((reason: string) => void) | null = null;
  /** True once close() was called intentionally — suppresses the disconnect cb. */
  private closing = false;
  /** One-shot guard so an `overflow` op and the following socket close don't both
   *  fire the disconnect callback. */
  private disconnected = false;
  private kernelInfoData: { status?: string; pid?: number | null; python?: string | null } | null = null;
  private widgetState: WidgetState | null = null;
  /** A cell blocked on input()/getpass(), if any: {exec_id, prompt, password}.
   *  Seeded from the snapshot (reconnect re-prompts) and kept current by the
   *  tithon.input_request / input_resolved events. Null when nothing is waiting. */
  private pendingInputData: PendingInput | null = null;
  /** id -> resolved bytes (null = fetched but not found). Dedupes refetches and,
   *  being byte-budgeted LRU, bounds memory when a live plot yields a new image
   *  every step (each a distinct sha → otherwise cached forever). */
  private readonly artifactCache = new ArtifactCache<ArtifactBytes | null>(
    (v) => (v ? v.bytes.length : 0),
  );
  /** One reused connection for ALL artifact fetches (no socket-per-image churn,
   *  which melted the tunnel for a per-step matplotlib plot). Requests are
   *  multiplexed by req_id; opened lazily, reopened if it drops. */
  private artifactWs: WebSocket | null = null;
  private artifactWsReady: Promise<WebSocket> | null = null;
  private artifactReqSeq = 0;
  private readonly pendingArtifacts = new Map<
    number,
    { resolve: (v: ArtifactBytes | null) => void; reject: () => void }
  >();
  /** Highest seq the daemon told us about (snapshot.max_seq or last sync). */
  syncSeq = 0;

  /**
   * `session` is the file uri — one kernel + journal per file (like Jupyter).
   * Defaults to "default" (the CLI/REPL session) when omitted. `workdir` is the
   * file's project root (workspace folder fsPath); the daemon uses it, on first
   * creation of this session, to root the session's artifacts + kernel cwd at
   * the right project and to name the kernel/journal dir readably (ADR-044).
   */
  constructor(
    private readonly sockPath: string = defaultSocketPath(),
    private readonly session: string = "default",
    private readonly workdir?: string,
  ) {}

  onChange(cb: () => void): void {
    this.onChangeCb = cb;
  }

  /** Raw per-event hook (fires for every `event` op) — used by LiveOutputSync. */
  onEvent(cb: (ev: LiveEvent) => void): void {
    this.onEventCb = cb;
  }

  /**
   * Notified when the daemon connection is lost AFTER the initial sync — either
   * the daemon dropped us for backpressure (`op:"overflow"`, ADR-018) or the
   * socket closed unexpectedly (daemon restart/crash). The controller reconnects
   * and resyncs from a fresh folded snapshot (cheap; ADR-018's design intent).
   * Not fired for an intentional {@link close}. Fires at most once per client.
   */
  onDisconnect(cb: (reason: string) => void): void {
    this.onDisconnectCb = cb;
  }

  private fireDisconnect(reason: string): void {
    if (this.disconnected || this.closing) return;
    this.disconnected = true;
    this.onDisconnectCb?.(reason);
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
  /** Open (once) the reused artifact channel; reject all in-flight on drop. */
  private artifactChannel(): Promise<WebSocket> {
    if (this.artifactWs && this.artifactWs.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.artifactWs);
    }
    if (this.artifactWsReady) return this.artifactWsReady;
    this.artifactWsReady = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(unixWsUrl(this.sockPath));
      const drop = () => {
        if (this.artifactWs === ws) this.artifactWs = null;
        this.artifactWsReady = null;
        // Reject every outstanding fetch so it re-fetches on the next channel —
        // a transient drop must NOT be cached as "not found" (the image exists).
        const pending = [...this.pendingArtifacts.values()];
        this.pendingArtifacts.clear();
        for (const p of pending) p.reject();
      };
      ws.once("open", () => { this.artifactWs = ws; resolve(ws); });
      ws.on("message", (raw: WebSocket.RawData) => {
        let m: any;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.op !== "artifact") return;
        const p = this.pendingArtifacts.get(m.req_id);
        if (!p) return;
        this.pendingArtifacts.delete(m.req_id);
        p.resolve(m.found && typeof m.data_b64 === "string"
          ? { mime: m.mime, bytes: new Uint8Array(Buffer.from(m.data_b64, "base64")) }
          : null);
      });
      ws.once("error", (err) => { reject(err); drop(); });
      ws.once("close", drop);
    });
    return this.artifactWsReady;
  }

  getArtifact(id: string): Promise<ArtifactBytes | null> {
    const cached = this.artifactCache.get(id);
    if (cached !== undefined) return Promise.resolve(cached);
    return this.artifactChannel().then(
      (ws) => new Promise<ArtifactBytes | null>((resolve, reject) => {
        const reqId = ++this.artifactReqSeq;
        this.pendingArtifacts.set(reqId, { resolve, reject });
        ws.send(JSON.stringify(
          { op: "get_artifact", artifact_id: id, session: this.session, req_id: reqId }));
      }).then((v) => {
        // A daemon reply (bytes, or null = genuinely not found / GC'd) is cached.
        this.artifactCache.set(id, v);
        return v;
      }),
    ).catch(() => null); // channel open/drop failure: return null, do NOT cache (retry later)
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
        ws.send(JSON.stringify(
          { op: "attach", last_seen_seq: lastSeenSeq, session: this.session, workdir: this.workdir }));
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
        // Lost the connection after we were live (daemon restart/crash, or the
        // backpressure drop's close) — let the controller reconnect + resync.
        else this.fireDisconnect("close");
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
      case "overflow":
        // The daemon dropped us for backpressure (ADR-018) and is about to close;
        // surface it so the controller reconnects and resyncs (folded → cheap).
        this.fireDisconnect("overflow");
        break;
      // "sync" handled by the caller; status_reply/execute_ack ignored here.
    }
  }

  private applySnapshot(snap: {
    max_seq?: number;
    executions?: SnapshotExecWire[];
    kernel?: { status?: string; pid?: number | null; python?: string | null };
    widgets?: WidgetState;
    pending_input?: PendingInput | null;
  }): void {
    this.syncSeq = snap.max_seq ?? this.syncSeq;
    if (snap.kernel) this.kernelInfoData = snap.kernel;
    if (snap.widgets) this.widgetState = snap.widgets;
    // A reconnecting client re-presents a prompt the kernel is still blocked on.
    this.pendingInputData = snap.pending_input ?? null;
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
    // Stdin bridge: track the pending input()/getpass() prompt (these carry an
    // exec_id but need no ExecState — they gate a separate UI affordance).
    if (ev.kind === "input_request") {
      this.pendingInputData = {
        exec_id: ev.exec_id,
        prompt: ev.payload?.prompt ?? "",
        password: !!ev.payload?.password,
      };
      return;
    }
    if (ev.kind === "input_resolved") {
      this.pendingInputData = null;
      return;
    }
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
        ws.send(JSON.stringify(
          { op: "attach", last_seen_seq: -1, session: this.session, workdir: this.workdir })));
      ws.on("message", onMsg);
      ws.once("error", reject);
    });
  }

  /**
   * Permanently clear the folded outputs of the given executions on the daemon
   * (a user "Clear Outputs" / "Clear All"). Fire-and-forget over the live attach
   * socket (already bound to this session); the daemon's `cleared` reply is
   * ignored by {@link handle}. Without this the next attach re-seeds the cleared
   * output from the journal, undoing the user's clear. Pass no ids / empty to
   * no-op.
   */
  clearOutputs(execIds: string[]): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || execIds.length === 0) return;
    ws.send(JSON.stringify({ op: "clear_output", session: this.session, exec_ids: execIds }));
  }

  /** The unanswered input()/getpass() prompt the kernel is blocked on, or null. */
  pendingInput(): PendingInput | null {
    return this.pendingInputData;
  }

  /**
   * Answer a pending input()/getpass() prompt so the blocked cell continues.
   * Fire-and-forget over the live attach socket (already bound to this session);
   * the daemon's `input_ack` reply is ignored by {@link handle}. Clears the local
   * pending marker optimistically so a stale box doesn't re-fire.
   */
  sendInput(value: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    this.pendingInputData = null;
    ws.send(JSON.stringify({ op: "input_reply", session: this.session, value }));
  }

  close(): void {
    this.closing = true; // suppress the disconnect callback for an intentional close
    this.ws?.close();
    this.ws = null;
    this.artifactWs?.close();
    this.artifactWs = null;
    this.artifactWsReady = null;
    const pending = [...this.pendingArtifacts.values()];
    this.pendingArtifacts.clear();
    for (const p of pending) p.reject();
  }
}
