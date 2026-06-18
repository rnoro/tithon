/**
 * Notebook output restore binding (VSCode integration — spike, not yet run in a
 * real VSCode host; see DECISIONS ADR-012 for the verification stance).
 *
 * This is the render half that the verified headless logic feeds: on
 * (re)connect it attaches a {@link SessionClient}, restores folded outputs with
 * {@link SessionClient.restoreInto}, and writes them into the notebook's cells
 * through the VSCode NotebookController execution API. The pure pieces it relies
 * on (subscribe + fold + cell_hash attach) are exercised end-to-end against a
 * real daemon by scripts/v7; this file is the thin, API-only glue VSCode needs.
 */
import * as vscode from "vscode";
import { SessionClient } from "./sessionClient";
import { DaemonClient, defaultSocketPath } from "./daemonClient";
import { ensureDaemon, waitForDaemonStop, listPythonEnvironments } from "./daemonProcess";
import { parse, type Cell } from "./serializer";
import type { OutputItem } from "./outputFold";
import { computeCellHash, docCellsFromParsed } from "./cellAttach";
import { LiveOutputSync, ThrottleScheduler, type CellSink } from "./liveSync";
import {
  imageOf,
  imageRefsOf,
  widgetModelIdOf,
  widgetFallbackText,
  widgetPayload,
  TITHON_WIDGET_MIME,
  type WidgetState,
} from "./richOutput";

/**
 * Build serializer Cells from the IN-MEMORY notebook (the authoritative cell
 * state), hashing the exact text each cell submits. The daemon journals
 * cell_hash = sha256(submitted code) = sha256(cell.document.getText()); building
 * the live/restore index from the open notebook — rather than re-parsing the
 * on-disk .py — makes output→cell mapping robust against unsaved edits or a
 * corrupted/stale file on disk (e.g. an older glue-bug file). See ADR-021.
 * One verbatim body line means cellSource(cell) === getText() exactly, so the
 * computed hash matches the daemon's. Markup cells are kept so indices align
 * with notebook.cellAt(i).
 */
function cellsFromNotebook(notebook: vscode.NotebookDocument): Cell[] {
  return notebook.getCells().map((c) => ({
    kind: c.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code",
    hasMarker: true,
    markerLine: { text: "# %%", terminator: "\n" },
    body: [{ text: c.document.getText(), terminator: "" }],
  }));
}

/**
 * The project root for a file (its workspace folder fsPath), passed to the daemon
 * so the file's session roots its artifacts + kernel cwd at the right project and
 * names its kernel/journal dir readably (ADR-044). Undefined for a file outside
 * any workspace folder (single-file open) — the daemon then falls back to a
 * hashed dir + its own cwd.
 */
export function workdirForUri(uri: vscode.Uri): string | undefined {
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
}

const STDOUT_MIME = "application/vnd.code.notebook.stdout";
const STDERR_MIME = "application/vnd.code.notebook.stderr";

/** Render context: prefetched image bytes + the widget mirror (both sync). */
interface RenderCtx {
  /** Bytes of a prefetched image artifact, or undefined if not (yet) fetched. */
  image(artifactId: string): Uint8Array | undefined;
  widgets: WidgetState | null;
}

/**
 * Convert one folded output item into VSCode notebook output item(s). Usually a
 * single item; a widget yields two (the live renderer payload + a text fallback
 * so a missing renderer / copy-paste still shows the value).
 */
function toOutputItems(o: OutputItem, ctx?: RenderCtx): vscode.NotebookCellOutputItem[] {
  switch (o.output_type) {
    case "stream":
      return [vscode.NotebookCellOutputItem.text(o.text, o.name === "stderr" ? STDERR_MIME : STDOUT_MIME)];
    case "error":
      return [vscode.NotebookCellOutputItem.error({
        name: o.ename ?? "Error",
        message: o.evalue ?? "",
        stack: (o.traceback ?? []).join("\n"),
      })];
    case "display_data":
    case "execute_result": {
      const data = o.data ?? {};
      // 1) Image (matplotlib inline): show the actual picture, not its "<Figure
      //    ...>" text repr. PNG/JPEG were journaled as $tithon_artifact refs
      //    whose bytes are prefetched into ctx; fall through to text if not ready.
      const img = imageOf(o);
      if (img?.ref) {
        const bytes = ctx?.image(img.ref.artifact_id);
        if (bytes) return [new vscode.NotebookCellOutputItem(bytes, img.mime)];
      } else if (img?.base64) {
        return [new vscode.NotebookCellOutputItem(Buffer.from(img.base64, "base64"), img.mime)];
      }
      // 2) Vector image (text-based) — VSCode renders it natively.
      const svg = data["image/svg+xml"];
      if (typeof svg === "string") return [vscode.NotebookCellOutputItem.text(svg, "image/svg+xml")];
      // 3) ipywidget (tqdm.notebook etc.): render it for real via the Tithon widget
      //    renderer (html-manager) when the mirror state is known, carrying the
      //    state in the output so the renderer needs no round-trip; keep a text
      //    fallback alongside. Unknown model (fresh live run, state only in the
      //    snapshot) -> §3.3 text fallback, else the display's own text/plain.
      const modelId = widgetModelIdOf(o);
      if (modelId) {
        const payload = widgetPayload(o, ctx?.widgets ?? null);
        if (payload) {
          const items = [vscode.NotebookCellOutputItem.json(payload, TITHON_WIDGET_MIME)];
          const fb = widgetFallbackText(modelId, ctx?.widgets ?? null);
          if (fb) items.push(vscode.NotebookCellOutputItem.text(fb, "text/plain"));
          return items;
        }
        const text = widgetFallbackText(modelId, ctx?.widgets ?? null);
        if (text) return [vscode.NotebookCellOutputItem.text(text, "text/plain")];
      }
      // 4) HTML repr (pandas DataFrame etc.).
      const html = data["text/html"];
      if (typeof html === "string") return [vscode.NotebookCellOutputItem.text(html, "text/html")];
      // 5) Plain text, else the raw data bundle.
      const text = data["text/plain"];
      if (typeof text === "string") return [vscode.NotebookCellOutputItem.text(text, "text/plain")];
      return [vscode.NotebookCellOutputItem.json(data)];
    }
  }
}

function toCellOutput(outputs: OutputItem[], stale: boolean, ctx?: RenderCtx): vscode.NotebookCellOutput {
  const out = new vscode.NotebookCellOutput(outputs.flatMap((o) => toOutputItems(o, ctx)));
  // Surface the §3.2 "stale" badge: the cell was edited since this run.
  if (stale) out.metadata = { tithonStale: true };
  return out;
}

/**
 * Live sink: turns coalesced {@link LiveOutputSync} ops into VSCode cell output
 * via proxy cell executions (the cell runs on the daemon; we mirror its state).
 * Stream deltas are appended (not resent) so a long loop stays cheap; `\r`
 * collapsing is left to the stdout renderer.
 */
class VSCodeCellSink implements CellSink {
  // Per cell: the proxy execution and whether we've called start() on it yet.
  // A created-but-not-started execution renders as PENDING (the queued clock);
  // start() switches it to RUNNING (spinner); end() to done (✓) / error (✗).
  private readonly execs = new Map<number, { exec: vscode.NotebookCellExecution; started: boolean }>();
  private readonly streamOut = new Map<string, vscode.NotebookCellOutput>();
  // Per cell+display_id: the NotebookCellOutput a display_data created, so a later
  // update_display_data REPLACES it in place (replaceOutputItems) instead of
  // stacking a new output each frame. Keyed `${idx}:${displayId}`, mirroring streamOut.
  private readonly displayOut = new Map<string, vscode.NotebookCellOutput>();
  // Per-cell promise chain: image appends fetch bytes asynchronously, so the
  // cell's done/end must queue behind them or VSCode rejects "execution ended".
  private readonly tail = new Map<number, Promise<void>>();

  constructor(
    private readonly controller: vscode.NotebookController,
    private readonly notebook: vscode.NotebookDocument,
    private readonly client: SessionClient,
  ) {}

  /** Render context: prefetched image bytes (sync) + the widget mirror. */
  private ctx(): RenderCtx {
    return {
      image: (id) => this.client.cachedArtifact(id)?.bytes,
      widgets: this.client.widgets(),
    };
  }

  /** Serialize async work per cell so image appends and the final end stay ordered. */
  private chain(idx: number, work: () => Promise<void>): void {
    const next = (this.tail.get(idx) ?? Promise.resolve()).then(work).catch(() => undefined);
    this.tail.set(idx, next);
  }

  /** Prefetch every image artifact referenced by these outputs before rendering. */
  async prefetch(items: OutputItem[]): Promise<void> {
    const ids = items.flatMap((o) => imageRefsOf(o).map((r) => r.artifact_id));
    if (ids.length) await this.client.prefetchArtifacts(ids);
  }

  private cell(idx: number): vscode.NotebookCell | undefined {
    try {
      return this.notebook.cellAt(idx);
    } catch {
      return undefined;
    }
  }

  /** Create the proxy execution in PENDING state (clock), if not present. No
   *  output ops here — VSCode rejects clearOutput/appendOutput before start(). */
  private create(idx: number): { exec: vscode.NotebookCellExecution; started: boolean } | undefined {
    let rec = this.execs.get(idx);
    if (!rec) {
      const c = this.cell(idx);
      if (!c) return undefined;
      rec = { exec: this.controller.createNotebookCellExecution(c), started: false };
      this.execs.set(idx, rec);
    }
    return rec;
  }

  /** Ensure the execution exists AND is started (RUNNING). `startMs` sets the
   *  real wall-clock start so timing reflects the daemon, not the reconnect.
   *  clearOutput runs only once, right after start() (it is invalid before). */
  private ensureStarted(idx: number, startMs?: number): vscode.NotebookCellExecution | undefined {
    const rec = this.create(idx);
    if (!rec) return undefined;
    if (!rec.started) {
      rec.exec.start(startMs ?? Date.now());
      void rec.exec.clearOutput();
      rec.started = true;
    }
    return rec.exec;
  }

  private forgetStreams(idx: number): void {
    for (const k of [...this.streamOut.keys()]) {
      if (k.startsWith(`${idx}:`)) this.streamOut.delete(k);
    }
  }

  /** Forget a cell's display_id→output map (on clear/end): a finished execution
   *  can't be replaced into, and a fresh run re-registers its own displays. */
  private forgetDisplays(idx: number): void {
    for (const k of [...this.displayOut.keys()]) {
      if (k.startsWith(`${idx}:`)) this.displayOut.delete(k);
    }
  }

  /** Remember the NotebookCellOutput for a display_id-bearing output so a later
   *  update_display_data can replace it in place rather than appending. */
  private registerDisplay(idx: number, item: OutputItem, out: vscode.NotebookCellOutput): void {
    const did = (item as { display_id?: string }).display_id;
    if (typeof did === "string") this.displayOut.set(`${idx}:${did}`, out);
  }

  appendStream(idx: number, name: string, text: string): void {
    const e = this.ensureStarted(idx);
    if (!e) return;
    const mime = name === "stderr" ? STDERR_MIME : STDOUT_MIME;
    const item = vscode.NotebookCellOutputItem.text(text, mime);
    const key = `${idx}:${name}`;
    const out = this.streamOut.get(key);
    if (!out) {
      const fresh = new vscode.NotebookCellOutput([item]);
      this.streamOut.set(key, fresh);
      void e.appendOutput(fresh); // append the delta only — never the whole buffer
    } else {
      void e.appendOutputItems(item, out);
    }
  }

  /**
   * Seed a cell from the snapshot captured at attach time (mid-run reconnect),
   * restoring both its OUTPUT and its execution STATE/timing (SPEC.md;
   * ADR-023/025):
   *  - "queued" -> pending clock, no output;
   *  - "running" -> spinner started at the real `startMs`, prior output rendered,
   *    stream blocks registered so live deltas continue the SAME block;
   *  - "done"/"error" -> rendered + ended with the real start/finish times so the
   *    cell shows the actual duration.
   */
  seedCell(
    idx: number,
    items: OutputItem[],
    state: "queued" | "running" | "done" | "error" | "orphaned",
    startMs?: number,
    endMs?: number,
  ): void {
    if (state === "queued") {
      this.create(idx); // pending clock, no output
      return;
    }
    // An "orphaned" execution was in-flight when the daemon/kernel restarted, so
    // it will NEVER receive a `done` event. Render its captured output as a
    // finished, NEUTRAL cell (no ✓/✗) and DO NOT leave a live spinner — but keep
    // its REAL elapsed run time: the daemon froze finished_at at the exec's last
    // journaled activity, so the cell shows e.g. "12.4s" frozen, not a spinner
    // ticking from the ancient start ("26667s", the bug the user first saw).
    const orphaned = state === "orphaned";
    const e = this.ensureStarted(idx, startMs);
    if (!e) return;
    for (const item of items) {
      if (item.output_type === "stream") {
        const mime = item.name === "stderr" ? STDERR_MIME : STDOUT_MIME;
        const out = new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.text(item.text, mime),
        ]);
        this.streamOut.set(`${idx}:${item.name}`, out);
        void e.appendOutput(out);
      } else {
        // Image bytes were prefetched by startLive before seeding, so ctx() resolves.
        const out = new vscode.NotebookCellOutput(toOutputItems(item, this.ctx()));
        this.registerDisplay(idx, item, out); // a live update after reconnect replaces in place
        void e.appendOutput(out);
      }
    }
    if (state === "done" || state === "error" || orphaned) {
      // orphaned -> NEUTRAL success (it never formally completed); done/error ->
      // the real success flag. Either way keep the REAL finish time so the cell
      // shows its actual (frozen) duration. For an orphan with no recorded finish
      // (an old journal predating the freeze), end at the start (0s) — never
      // Date.now(), which would re-inflate to wall-clock-since-then.
      const success = orphaned ? undefined : state === "done";
      const fallback = orphaned ? (startMs ?? Date.now()) : Date.now();
      e.end(success, endMs ?? fallback);
      this.execs.delete(idx);
      this.forgetStreams(idx);
      this.forgetDisplays(idx);
    }
    // a "running" cell stays started until its live `done` event arrives.
  }

  appendOutput(idx: number, item: OutputItem): void {
    const e = this.ensureStarted(idx);
    if (!e) return;
    const pending = imageRefsOf(item)
      .map((r) => r.artifact_id)
      .filter((id) => this.client.cachedArtifact(id) === undefined);
    if (pending.length) {
      // A live matplotlib figure: fetch its bytes, then append — queued on the
      // cell's chain so the trailing `done` end() waits for the image to land.
      this.chain(idx, async () => {
        await this.client.prefetchArtifacts(pending);
        const out = new vscode.NotebookCellOutput(toOutputItems(item, this.ctx()));
        this.registerDisplay(idx, item, out);
        await e.appendOutput(out);
      });
    } else {
      const out = new vscode.NotebookCellOutput(toOutputItems(item, this.ctx()));
      this.registerDisplay(idx, item, out);
      void e.appendOutput(out);
    }
  }

  /**
   * In-place display update (update_display_data): replace the OUTPUT a prior
   * display_data created — keyed by display_id — instead of appending a new one,
   * so a live timer / re-displayed figure updates in place (no stacking). Falls
   * back to append (and registers) when the display isn't tracked yet (an update
   * before its create, or a display from another cell/run). Serialized on the
   * cell's chain so it lands after any in-flight append of the SAME display
   * (registration order) and before the trailing done end().
   */
  updateDisplay(idx: number, displayId: string, item: OutputItem): void {
    const e = this.ensureStarted(idx);
    if (!e) return;
    const existing = this.displayOut.get(`${idx}:${displayId}`);
    if (!existing) {
      this.appendOutput(idx, item);
      return;
    }
    const pending = imageRefsOf(item)
      .map((r) => r.artifact_id)
      .filter((id) => this.client.cachedArtifact(id) === undefined);
    this.chain(idx, async () => {
      if (pending.length) await this.client.prefetchArtifacts(pending);
      await e.replaceOutputItems(toOutputItems(item, this.ctx()), existing);
    });
  }

  clear(idx: number): void {
    const rec = this.execs.get(idx);
    if (rec?.started) {
      // A kernel-driven clear_output WHILE the cell is running: clear via the live
      // execution, keeping its spinner.
      void rec.exec.clearOutput();
    } else {
      // No live execution for this cell — e.g. the daemon echoing back a user's
      // own "Clear Outputs" (a tombstone broadcast), or another window's clear.
      // Do NOT ensureStarted() here: that leaves a phantom execution whose spinner
      // never ends (no matching `done` event), the "clearing a cell leaves it
      // stuck running" bug. Guard on outputs.length so our OWN clear (which already
      // emptied the cell before the echo round-trips back) does nothing — no flash,
      // no edit→change feedback loop. Only when output actually survives (another
      // window cleared it) do we clear, via a momentary execution that ends
      // IMMEDIATELY (VSCode exposes no output-only edit, so this is the only path).
      const c = this.cell(idx);
      if (c && c.outputs.length > 0) {
        const exec = this.controller.createNotebookCellExecution(c);
        exec.start(Date.now());
        void exec.clearOutput();
        exec.end(undefined, Date.now());
      }
    }
    this.forgetStreams(idx);
    this.forgetDisplays(idx);
  }

  status(idx: number, status: string, tsMs?: number): void {
    if (status === "queued") {
      this.create(idx); // pending clock
      return;
    }
    if (status === "running") {
      this.ensureStarted(idx, tsMs);
      return;
    }
    // done / error: must be started before it can be ended. Queue the end on the
    // cell's chain so any in-flight image append (fetched async) lands first.
    const rec = this.execs.get(idx);
    if (rec) {
      this.execs.delete(idx);
      this.forgetStreams(idx);
      this.forgetDisplays(idx);
      const endMs = tsMs ?? Date.now();
      this.chain(idx, async () => {
        if (!rec.started) {
          rec.exec.start(endMs);
          rec.started = true;
        }
        rec.exec.end(status === "done", endMs);
      });
    }
  }

  /** True while a proxy execution is open for this cell — i.e. the sink itself
   *  is driving its output (so an outputs->empty change is OUR clearOutput, not
   *  a user clear). Used to tell user clears apart from sink-driven ones. */
  isExecuting(idx: number): boolean {
    return this.execs.has(idx);
  }

  /** Cell indices with an OPEN proxy execution (spinner/clock). A cell that is
   *  not running should not appear here; if it lingers, a `done`/`end` was missed
   *  (the stuck-spinner signature). Exposed for the regression e2e. */
  activeCells(): number[] {
    return [...this.execs.keys()];
  }

  /** End any still-open proxy executions (called when live sync stops) so cells
   *  don't keep a spinner/clock forever after we detach. */
  endAll(): void {
    for (const [idx, rec] of this.execs) {
      if (!rec.started) rec.exec.start(Date.now());
      rec.exec.end(undefined, Date.now());
      this.forgetStreams(idx);
      this.forgetDisplays(idx);
    }
    this.execs.clear();
  }
}

/**
 * Owns a NotebookController for the Tithon Cell View and restores cell outputs
 * from the daemon on demand. Outputs are written via cell executions
 * (`replaceOutput`) — the stable VSCode mechanism for setting cell output.
 */
export class TithonNotebookController {
  private readonly controller: vscode.NotebookController;
  private readonly daemon: DaemonClient;
  private readonly sockPath: string;
  private labelledPython = false; // set the "Python x.y" label only once
  private readonly liveSessions = new Map<
    string,
    { dispose: () => void; refresh: () => void; activeCells: () => number[] }
  >();

  private readonly selectionSub: vscode.Disposable;
  /** Clickable status-bar indicator showing/selecting the kernel's Python. */
  readonly pyStatus: vscode.StatusBarItem;
  /** Channel to the ipywidget notebook renderer (live updates + render outcome). */
  private readonly widgetMessaging: vscode.NotebookRendererMessaging;
  /** Render outcomes reported by the widget renderer (html|fallback) — for verify. */
  readonly widgetRenders: Array<{ model_id?: string; mode?: string }> = [];
  /** Count of live widget updates the renderer applied (live animation) — for verify. */
  widgetUpdatesApplied = 0;
  // Coalesced live widget-state deltas pushed to the renderer (latest per comm id,
  // flushed ~50ms) so a 50k-update tqdm.notebook animates without flooding it.
  private readonly widgetUpdateBuf = new Map<string, Record<string, unknown>>();
  private widgetFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(sockPath?: string) {
    this.sockPath = sockPath ?? defaultSocketPath();
    this.pyStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.pyStatus.command = "tithon.selectInterpreter";
    this.pyStatus.text = "$(snake) Tithon";
    this.pyStatus.tooltip = "Tithon: select Python interpreter";
    // Renderer channel: the widget renderer reports whether it painted html vs the
    // text fallback (surfaced for verification), and we push live comm deltas to it.
    this.widgetMessaging = vscode.notebooks.createRendererMessaging("tithon-widget");
    this.widgetMessaging.onDidReceiveMessage((e) => {
      const m = e.message as { type?: string; model_id?: string; mode?: string; comm_id?: string };
      if (m?.type === "tithon.widget-rendered") {
        this.widgetRenders.push({ model_id: m.model_id, mode: m.mode });
        console.log(`[tithon] widget rendered: ${m.mode} (${m.model_id})`);
      } else if (m?.type === "tithon.widget-updated") {
        this.widgetUpdatesApplied += 1;
        if (this.widgetUpdatesApplied <= 3 || this.widgetUpdatesApplied % 10 === 0) {
          console.log(`[tithon] widget updated x${this.widgetUpdatesApplied} (${m.comm_id})`);
        }
      }
    });
    this.controller = vscode.notebooks.createNotebookController("tithon", "tithon-py", "Tithon");
    this.controller.supportedLanguages = ["python"];
    this.controller.supportsExecutionOrder = false;
    this.daemon = new DaemonClient(sockPath);
    // Native cell play button: start live sync then submit each cell to the daemon.
    this.controller.executeHandler = (cells, nb) => void this._executeHandler(cells, nb);
    // Cell STOP button (and Interrupt): the cell runs on the daemon's kernel, not
    // a VSCode-managed execution, so there's no cancellation token to honor —
    // wire interruptHandler so the ⏹ button SIGINTs the kernel. The running cell
    // raises KeyboardInterrupt -> errors -> the live sink ends it; the kernel
    // stays alive so the cell can be re-run.
    this.controller.interruptHandler = (nb) => this.interruptKernel(nb);
    // Auto restore + live sync exactly when OUR kernel becomes the notebook's
    // selected kernel — this is the right moment (createNotebookCellExecution
    // requires the controller be selected, so starting on raw open races ahead
    // of selection and the restore silently fails). On reopen VSCode re-selects
    // the remembered kernel, so the user gets restore+live with NO command (#3/#4).
    this.selectionSub = this.controller.onDidChangeSelectedNotebooks((e) => {
      if (e.selected) {
        this.pyStatus.show();
        void this.ensureLive(e.notebook).catch(() => undefined);
      } else {
        this.disposeLive(e.notebook.uri);
      }
    });
  }

  private async _executeHandler(
    cells: vscode.NotebookCell[],
    notebook: vscode.NotebookDocument,
  ): Promise<void> {
    try {
      await ensureDaemon(this.sockPath); // auto-start the host daemon if needed
      await this.ensureLive(notebook);
      // Cells may have been added/edited since live sync started; refresh the
      // index so this run's cell maps (ADR-022).
      this.refreshLive(notebook);
      // Submit with the cell's *line* range (matching the CodeLens path and the
      // doc-cell ranges restore uses), not a cell-index range — see ADR-019.
      const ranges = await this.cellLineRanges(notebook);
      const workdir = workdirForUri(notebook.uri);
      for (const cell of cells) {
        const code = cell.document.getText();
        await this.daemon.execute(code, {
          uri: notebook.uri.toString(),
          range: ranges[cell.index] ?? { start: cell.index, end: cell.index },
          cell_hash: computeCellHash(code),
          index: cell.index, // authoritative cell identity (duplicate-code fix)
        }, workdir);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Tithon: ${String(err)}`);
    }
  }

  /** Coalesce a live comm-state delta for the widget renderer (latest per comm id). */
  private queueWidgetUpdate(payload: { msg_type?: string; comm_id?: string; data?: any } | undefined): void {
    if (payload?.msg_type !== "comm_msg" || !payload.comm_id) return;
    const data = payload.data ?? {};
    if (data.method !== "update" && data.method !== "echo_update") return;
    const merged = { ...(this.widgetUpdateBuf.get(payload.comm_id) ?? {}), ...(data.state ?? {}) };
    this.widgetUpdateBuf.set(payload.comm_id, merged);
    if (!this.widgetFlushTimer) {
      this.widgetFlushTimer = setTimeout(() => this.flushWidgetUpdates(), 50);
    }
  }

  /** Push the coalesced widget deltas to the renderer so live widgets animate. */
  private flushWidgetUpdates(): void {
    this.widgetFlushTimer = null;
    for (const [comm_id, state] of this.widgetUpdateBuf) {
      void this.widgetMessaging.postMessage({ type: "tithon.widget-update", comm_id, state });
    }
    this.widgetUpdateBuf.clear();
  }

  /** Show the kernel's Python version on the controller label + status bar. */
  private applyKernelLabel(python: string | null): void {
    if (python) {
      this.pyStatus.text = `$(snake) Tithon: Python ${python}`;
      this.pyStatus.tooltip = `Tithon kernel: Python ${python} — click to change interpreter`;
    }
    if (!python || this.labelledPython) return;
    this.controller.label = `Tithon · Python ${python}`;
    this.controller.description = `Python ${python}`;
    this.labelledPython = true;
  }

  /**
   * Restart the WHOLE daemon (all kernels) — used after changing the interpreter,
   * since every kernel runs under the daemon's Python. Tears down live sessions,
   * shuts the daemon down, relaunches it (with the current tithon.pythonPath),
   * and re-attaches live for any open Tithon notebooks.
   */
  async restartDaemon(): Promise<void> {
    for (const s of this.liveSessions.values()) s.dispose();
    this.liveSessions.clear();
    this.labelledPython = false;
    await this.daemon.shutdown(true); // kill kernels so new daemon spawns fresh under the new interpreter
    await waitForDaemonStop(this.sockPath);
    await ensureDaemon(this.sockPath); // relaunches with the (possibly new) interpreter
    for (const nb of vscode.workspace.notebookDocuments) {
      if (nb.notebookType === "tithon-py") await this.ensureLive(nb).catch(() => undefined);
    }
  }

  /** Pick a Python interpreter (sets tithon.pythonPath); restart the daemon to
   *  apply it (the interpreter is daemon-wide). */
  async selectInterpreter(): Promise<void> {
    const envs = await listPythonEnvironments();
    type Item = vscode.QuickPickItem & { path: string };
    const items: Item[] = [
      { label: "$(check) Use the Python extension's interpreter", description: "default", path: "" },
      ...envs.map((e) => ({
        label: `$(snake) Python ${e.version ?? "?"}`,
        description: e.label ? `${e.label} — ${e.path}` : e.path,
        path: e.path,
      })),
      { label: "$(edit) Enter interpreter path…", path: "__manual__" },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Select the Python interpreter for the Tithon daemon/kernels",
    });
    if (!pick) return;
    let chosen = pick.path;
    if (chosen === "__manual__") {
      chosen = (await vscode.window.showInputBox({
        prompt: "Absolute path to the Python interpreter (it must have `tithon` installed)",
        value: this.sockPath, // hint; user replaces
      })) ?? "";
      if (!chosen) return;
    }
    await vscode.workspace.getConfiguration("tithon")
      .update("pythonPath", chosen, vscode.ConfigurationTarget.Global);

    // The interpreter is daemon-wide, so applying it means restarting the daemon.
    const answer = await vscode.window.showWarningMessage(
      "Changing the interpreter restarts the Tithon daemon — all running kernels and cells will stop. Restart now?",
      { modal: true },
      "Restart now",
      "Later",
    );
    if (answer === "Restart now") {
      await this.restartDaemon();
      vscode.window.setStatusBarMessage("Tithon: daemon restarted with the selected interpreter", 4000);
    }
  }

  /** Line range of each cell (by index) in the on-disk percent file. */
  private async cellLineRanges(
    notebook: vscode.NotebookDocument,
  ): Promise<Array<{ start: number; end: number }>> {
    try {
      const bytes = await vscode.workspace.fs.readFile(notebook.uri);
      const cells = parse(new TextDecoder().decode(bytes)).cells;
      return docCellsFromParsed(cells).map((dc) => dc.range);
    } catch {
      return [];
    }
  }

  dispose(): void {
    this.selectionSub.dispose();
    this.pyStatus.dispose();
    if (this.widgetFlushTimer) clearTimeout(this.widgetFlushTimer);
    for (const s of this.liveSessions.values()) s.dispose();
    this.liveSessions.clear();
    this.controller.dispose();
  }

  /**
   * Ensure live output sync is running for this notebook. Idempotent: if sync
   * is already active for the notebook URI, this is a no-op.
   */
  async ensureLive(notebook: vscode.NotebookDocument): Promise<void> {
    const key = notebook.uri.toString();
    if (this.liveSessions.has(key)) return;
    const session = await this.startLive(notebook);
    // A concurrent ensureLive (e.g. auto-open + executeHandler racing) may have
    // populated the map while we awaited startLive — keep the first, drop ours.
    if (this.liveSessions.has(key)) {
      session.dispose();
      return;
    }
    this.liveSessions.set(key, session);
  }

  /**
   * Stop and forget live sync for a closed notebook. WITHOUT this, reopening the
   * same file found a stale (closed-document) session and silently dropped its
   * output — the "after closing+reopening, cells stop working" bug.
   */
  disposeLive(uri: vscode.Uri): void {
    const key = uri.toString();
    const s = this.liveSessions.get(key);
    if (s) {
      s.dispose();
      this.liveSessions.delete(key);
    }
  }

  /** Restart a file's kernel (fresh namespace), then resync the live view. */
  async restartKernel(notebook: vscode.NotebookDocument): Promise<void> {
    await ensureDaemon(this.sockPath);
    this.disposeLive(notebook.uri);
    await this.daemon.restartKernel(notebook.uri.toString());
    await this.ensureLive(notebook); // re-attach: clears spinners, re-seeds state
  }

  /** Interrupt the running cell of a file's kernel. */
  async interruptKernel(notebook: vscode.NotebookDocument): Promise<void> {
    await ensureDaemon(this.sockPath);
    await this.daemon.interrupt(notebook.uri.toString());
  }

  /**
   * Refresh the live cell-hash index for a notebook from its current cells
   * (no-op if live sync isn't running). Call right before submitting so cells
   * added/edited since live sync started still map their output (ADR-022).
   */
  refreshLive(notebook: vscode.NotebookDocument): void {
    this.liveSessions.get(notebook.uri.toString())?.refresh();
  }

  /**
   * Make a user's native "Clear Outputs" / "Clear All Outputs" durable. VSCode
   * clears the cell visually, but the output lives in the daemon journal, so the
   * next snapshot/delta resync would restore it — undoing the user's clear. For
   * each cell whose outputs went to empty while the sink is NOT executing it
   * (a sink-driven clear during a run is ours, not the user's), map it to its
   * journal executions and tell the daemon to clear them. ALL executions mapped
   * to the cell are cleared so an older run of a re-run cell cannot reappear.
   */
  private propagateUserClears(
    e: vscode.NotebookDocumentChangeEvent,
    sink: VSCodeCellSink,
    live: LiveOutputSync,
    client: SessionClient,
  ): void {
    const execIds: string[] = [];
    for (const ch of e.cellChanges) {
      if (!ch.outputs || ch.outputs.length !== 0) continue; // only outputs -> empty
      const idx = ch.cell.index;
      if (sink.isExecuting(idx)) continue; // our own clearOutput during a run
      for (const ex of client.executions()) {
        if (live.cellOf(ex.execId) === idx) execIds.push(ex.execId);
      }
    }
    if (execIds.length) client.clearOutputs(execIds);
  }

  /** Attach a session, restore folded outputs, and write them into the cells. */
  async restore(notebook: vscode.NotebookDocument): Promise<void> {
    const cells = cellsFromNotebook(notebook); // in-memory, not disk (ADR-021)

    await ensureDaemon(this.sockPath);
    const client = new SessionClient(
      undefined, notebook.uri.toString(), workdirForUri(notebook.uri));
    await client.attach(0);
    try {
      const attachments = client.restoreInto(cells, notebook.uri.toString());
      // Prefetch every image artifact before rendering so figures restore as
      // pictures, not "<Figure ...>" placeholders.
      const allOutputs = [...attachments.values()].flatMap((a) => a.outputs as OutputItem[]);
      await client.prefetchArtifacts(allOutputs.flatMap((o) => imageRefsOf(o).map((r) => r.artifact_id)));
      const ctx: RenderCtx = {
        image: (id) => client.cachedArtifact(id)?.bytes,
        widgets: client.widgets(),
      };
      for (const [cellIndex, att] of attachments) {
        let cell: vscode.NotebookCell;
        try {
          cell = notebook.cellAt(cellIndex);
        } catch {
          continue; // cell index out of range for the current document
        }
        const exec = this.controller.createNotebookCellExecution(cell);
        exec.start(Date.now());
        await exec.replaceOutput(toCellOutput(att.outputs as OutputItem[], att.stale, ctx));
        exec.end(!att.stale, Date.now());
      }
    } finally {
      client.close();
    }
  }

  /**
   * Start *live* sync: keep a session open and mirror the daemon's output stream
   * into the notebook's cells in real time, with bounded render cost (coalesced
   * by {@link LiveOutputSync}). Returns a handle with `dispose` (stops the
   * session) and `refresh` (rebuilds the cell-hash index from current cells).
   */
  async startLive(
    notebook: vscode.NotebookDocument,
  ): Promise<{ dispose: () => void; refresh: () => void; activeCells: () => number[] }> {
    await ensureDaemon(this.sockPath); // auto-start the host daemon if needed
    const client = new SessionClient(
      undefined, notebook.uri.toString(), workdirForUri(notebook.uri));
    await client.attach(0); // catch up on any prior state, then stream live
    // Surface the kernel's Python version on the controller (the picker/indicator
    // showed only "Tithon"; now "Tithon · Python 3.11.5").
    this.applyKernelLabel(client.kernelInfo()?.python ?? null);
    const sink = new VSCodeCellSink(this.controller, notebook, client);
    const live = new LiveOutputSync(
      cellsFromNotebook(notebook), // in-memory, not disk (ADR-021)
      sink,
      new ThrottleScheduler(50),
    );
    const execs = client.executions();
    live.seed(execs.map((e) => ({ execId: e.execId, cellHash: e.cellHash, index: e.origin?.index })));
    // Prefetch image bytes for the snapshot so seedCell renders matplotlib
    // figures synchronously below (and not as a "<Figure ...>" placeholder).
    // Events arriving during this await are captured by outputsOf() at seed time
    // and live events are wired only afterwards — no gap, no duplication.
    await sink.prefetch(execs.flatMap((e) => client.outputsOf(e.execId)));
    // Mid-run reconnect: restore each mapped execution's OUTPUT *and* its
    // STATE+timing into the cell NOW, before wiring live events — a done cell
    // shows ✓ with its real duration, a running cell shows the spinner started at
    // the real time (so it keeps counting up) plus its prior output, and a queued
    // cell shows the pending clock (ADR-023/025). This runs synchronously after
    // attach() resolved, so no live event can slip in between capturing the
    // snapshot and wiring onEvent — no gap, no duplication.
    const toMs = (s: number | null) => (s != null ? s * 1000 : undefined);
    for (const ex of execs) {
      const idx = live.cellOf(ex.execId);
      if (idx === undefined) continue;
      const state =
        ex.status === "done" ? "done"
        : ex.status === "error" ? "error"
        : ex.status === "queued" ? "queued"
        // "orphaned": in-flight at a daemon/kernel restart, no `done` is coming —
        // render output without a perpetual spinner (the "26667s running" bug).
        : ex.status === "orphaned" ? "orphaned"
        : "running";
      sink.seedCell(idx, client.outputsOf(ex.execId), state, toMs(ex.startedAt), toMs(ex.finishedAt));
    }
    const refresh = () => live.refreshCells(cellsFromNotebook(notebook));
    // Keep the index current as cells are added/edited after live started
    // (ADR-022) — otherwise a new cell's execution maps to nothing.
    const changeSub = vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.notebook.uri.toString() !== notebook.uri.toString()) return;
      refresh();
      this.propagateUserClears(e, sink, live, client);
    });
    client.onEvent((ev) => {
      live.onEvent(ev);
      // Comm deltas drive live widget animation: forward state patches to the
      // renderer (the display_data already rendered the widget; this just updates
      // the model so e.g. a tqdm.notebook bar fills in real time).
      if (ev.kind === "widget") this.queueWidgetUpdate(ev.payload);
    });
    return {
      dispose: () => {
        changeSub.dispose();
        client.close();
        sink.endAll(); // don't leave cells spinning after we detach
      },
      refresh,
      activeCells: () => sink.activeCells(),
    };
  }

  /** Cell indices with an open proxy execution for a notebook (regression e2e:
   *  a cleared cell must not linger here, which would be a stuck spinner). */
  activeExecCells(notebook: vscode.NotebookDocument): number[] {
    return this.liveSessions.get(notebook.uri.toString())?.activeCells() ?? [];
  }
}

/** Register the controller + restore/live commands for the Cell View. */
export function registerRestore(context: vscode.ExtensionContext): TithonNotebookController {
  const controller = new TithonNotebookController();
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand("tithon.restoreOutputs", async () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      if (!nb) {
        vscode.window.showInformationMessage("Tithon: no active notebook to restore");
        return;
      }
      try {
        await controller.restore(nb);
        vscode.window.setStatusBarMessage("Tithon: outputs restored from daemon", 3000);
      } catch (err) {
        vscode.window.showErrorMessage(`Tithon restore: ${String(err)}`);
      }
    }),
    vscode.commands.registerCommand("tithon.startLive", async () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      if (!nb) {
        vscode.window.showInformationMessage("Tithon: no active notebook for live sync");
        return;
      }
      try {
        await controller.ensureLive(nb);
        vscode.window.setStatusBarMessage("Tithon: live output sync started", 3000);
      } catch (err) {
        vscode.window.showErrorMessage(`Tithon live: ${String(err)}`);
      }
    }),
    vscode.commands.registerCommand("tithon.selectInterpreter", async () => {
      try {
        await controller.selectInterpreter();
      } catch (err) {
        vscode.window.showErrorMessage(`Tithon interpreter: ${String(err)}`);
      }
    }),
    vscode.commands.registerCommand("tithon.restartDaemon", async () => {
      try {
        await controller.restartDaemon();
        vscode.window.setStatusBarMessage("Tithon: daemon restarted", 3000);
      } catch (err) {
        vscode.window.showErrorMessage(`Tithon daemon restart: ${String(err)}`);
      }
    }),
    // Test-only: lets the integration suite confirm the widget renderer painted
    // html (vs the text fallback) and applied live animation updates.
    vscode.commands.registerCommand("tithon._widgetRenderLog", () => controller.widgetRenders),
    vscode.commands.registerCommand("tithon._widgetUpdateCount", () => controller.widgetUpdatesApplied),
    // Test-only: cell indices with an open proxy execution for the active notebook
    // (a cleared/orphaned cell lingering here is the stuck-spinner bug).
    vscode.commands.registerCommand("tithon._activeExecCells", () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      return nb ? controller.activeExecCells(nb) : [];
    }),
  );
  return controller;
}
