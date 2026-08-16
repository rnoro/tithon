/**
 * Notebook output restore binding (VSCode integration).
 *
 * This is the render half that the headless logic feeds: on
 * (re)connect it attaches a {@link SessionClient}, restores folded outputs with
 * {@link SessionClient.restoreInto}, and writes them into the notebook's cells
 * through the VSCode NotebookController execution API. The pure pieces it relies
 * on (subscribe + fold + cell_hash attach) live outside this file, which is the
 * thin, API-only glue VSCode needs.
 */
import * as vscode from "vscode";
import { SessionClient, type KernelSnapshot } from "./sessionClient";
import { DaemonClient, defaultSocketPath, type KernelInfo } from "./daemonClient";
import { ensureDaemon, waitForDaemonStop, listPythonEnvironments } from "./daemonProcess";
import { parse, type Cell } from "./serializer";
import type { OutputItem } from "./outputFold";
import { computeCellHash, docCellsFromParsed } from "./cellAttach";
import { LiveOutputSync, ThrottleScheduler, type CellSink } from "./liveSync";
import {
  imageOf,
  imageRefsOf,
  isOutputAreaView,
  widgetModelIdOf,
  widgetFallbackText,
  widgetPayload,
  isDisplayOnlyWidget,
  TITHON_WIDGET_MIME,
  decodeBufferEntries,
  mergeBufferEntries,
  type WidgetBufferEntry,
  type WidgetState,
} from "./richOutput";
import { formatTraceback } from "./tracebackFormatter";
import { confirmDestructive, notifyInfo, notifyWarn } from "./notify";

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

/**
 * Test-only view of what the live MODEL holds, so a suite can measure the skew
 * between the model and what the document actually shows. The widget path
 * (coalesced comm deltas postMessaged to the renderer) and the cell-output path
 * (chained VSCode edits) render the same instant of kernel time independently,
 * so a suite has to read both from one place to tell them apart.
 */
export interface LiveDiag {
  /** Highest journal seq this client has applied. */
  syncSeq: number;
  /** Sink ops accepted but not yet applied to the document. */
  backlog: number;
  execs: Array<{
    execId: string;
    cell: number | undefined;
    status: string;
    /** Tail of the fold's stdout text — what the cell WOULD show if current. */
    stream: string;
    images: number;
    /** Text rendering of each widget view from the LIVE mirror (tqdm's bar). */
    widgets: string[];
  }>;
}

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
      return [
        vscode.NotebookCellOutputItem.text(o.text, o.name === "stderr" ? STDERR_MIME : STDOUT_MIME),
      ];
    case "error":
      // Strip kernel-chosen background-color ANSI — it can clash
      // with the editor's own theme; foreground/weight is left to VSCode's own
      // ANSI renderer, which already reconciles those with the active theme.
      return [
        vscode.NotebookCellOutputItem.error({
          name: o.ename ?? "Error",
          message: o.evalue ?? "",
          stack: formatTraceback(o.traceback ?? []).join("\n"),
        }),
      ];
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
      if (typeof svg === "string")
        return [vscode.NotebookCellOutputItem.text(svg, "image/svg+xml")];
      // 3) ipywidget (tqdm.notebook etc.): render it for real via the Tithon widget
      //    renderer (html-manager) when the mirror state is known, carrying the
      //    state in the output so the renderer needs no round-trip; keep a text
      //    fallback alongside. Unknown model (fresh live run, state only in the
      //    snapshot) -> §3.3 text fallback, else the display's own text/plain.
      const modelId = widgetModelIdOf(o);
      if (modelId) {
        // Interactive controls (sliders, buttons, text boxes...) have no
        // client -> kernel comm back-channel — rendering them
        // via html-manager would produce a control that LOOKS functional but
        // silently drops every interaction. Render only display-only widgets
        // (and containers of them) interactively; anything else is the
        // honest text fallback, even though the mirror state IS known.
        const payload = isDisplayOnlyWidget(modelId, ctx?.widgets ?? null)
          ? widgetPayload(o, ctx?.widgets ?? null)
          : undefined;
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

/**
 * Which SLOT of a cell's output list an item occupies, for a repaint that
 * updates in place. Two items with the same key across two folds are the same
 * on-screen output (the stdout block, that widget's view, the plot) even when
 * their content differs; the checks follow {@link toOutputItems}' own priority
 * so a key can never describe an item as a widget that renders as an image.
 */
function slotKey(o: OutputItem): string {
  if (o.output_type === "stream") return `s:${o.name}`;
  if (o.output_type === "error") return "e";
  if (imageOf(o)) return "img";
  const w = widgetModelIdOf(o);
  if (w) return `w:${w}`;
  return `d:${(o as { display_id?: string }).display_id ?? ""}`;
}

/** Whether this item renders as a LIVE widget view (html-manager), not text. */
function isLiveWidget(o: OutputItem, ctx?: RenderCtx): boolean {
  if (o.output_type === "stream" || o.output_type === "error" || imageOf(o)) return false;
  const id = widgetModelIdOf(o);
  if (!id) return false;
  return isDisplayOnlyWidget(id, ctx?.widgets ?? null) && !!widgetPayload(o, ctx?.widgets ?? null);
}

/** Cheap identity of an item's rendered CONTENT — unchanged means nothing to write. */
function slotFingerprint(o: OutputItem): string {
  if (o.output_type === "stream") return o.text;
  if (o.output_type === "error") return `${o.ename} ${o.evalue} ${(o.traceback ?? []).join("\n")}`;
  // Images are `$tithon_artifact` references by then, so this stays small.
  return JSON.stringify(o.data ?? {});
}

/** One painted output: the slot it fills and what it currently shows. */
interface PaintedSlot {
  key: string;
  fingerprint: string;
  /** Rendered as a live widget view — kept current by the renderer's own
   *  update channel, so a repaint must NOT rewrite it (see `repaint`). */
  live: boolean;
  /** The folded item behind it, so a live widget's bootstrap snapshot can be
   *  re-materialized from the current mirror when the run ends. */
  item: OutputItem;
}

function toCellOutputs(
  outputs: OutputItem[],
  stale: boolean,
  ctx?: RenderCtx,
): vscode.NotebookCellOutput[] {
  // One NotebookCellOutput PER folded output item — a NotebookCellOutput is a
  // single output's mimebundle (VSCode renders only ONE of its items), so
  // flattening every item into one output collapses e.g. tqdm-widget + stdout +
  // matplotlib-image into a single mimebundle of which VSCode shows just one
  // ("only one output renders"). The widget's own two items (renderer payload +
  // text fallback) DO belong together — that grouping stays inside toOutputItems.
  // Matches the live appendOutput / seedCell path (one output per item).
  return outputs
    .filter((o) => !isOutputAreaView(o, ctx?.widgets ?? null))
    .map((o) => {
      const out = new vscode.NotebookCellOutput(toOutputItems(o, ctx));
      // Surface the §3.2 "stale" badge: the cell was edited since this run.
      if (stale) out.metadata = { tithonStale: true };
      return out;
    });
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
  private readonly execs = new Map<
    number,
    { exec: vscode.NotebookCellExecution; started: boolean }
  >();
  private readonly streamOut = new Map<string, vscode.NotebookCellOutput>();
  /**
   * Per display_id: the owning cell and every NotebookCellOutput created under
   * that id, so an `update_display_data` REPLACES them in place
   * (replaceOutputItems) instead of stacking a new output each frame.
   *
   * Keyed by display_id ALONE, unlike streamOut's `${idx}:`-prefixed key, and
   * deliberately NOT cleared when the creating execution ends: a display outlives
   * its cell's run, and `update_display` from ANOTHER cell must still find it
   * regardless.
   *
   * `outs` is a LIST because both folds update EVERY item carrying the id
   * (`folding.py` / `outputFold.ts`), so `display(x, display_id="d")` twice then
   * one update changes two outputs; a single tracked handle would leave the
   * second showing the old value live and the new one after a reconnect. An
   * EMPTY list with the key still present is the third state — id known, its
   * outputs destroyed (re-run / clear / repaint) — which is what lets a stale
   * update no-op instead of resurrecting output the daemon fold no longer holds.
   */
  private readonly displays = new Map<string, { idx: number; outs: vscode.NotebookCellOutput[] }>();
  // Per-cell promise chain: image appends fetch bytes asynchronously, so the
  // cell's done/end must queue behind them or VSCode rejects "execution ended".
  private readonly tail = new Map<number, Promise<void>>();
  /** Chained ops queued but not yet applied. The rendered cell is exactly this
   *  many operations behind the fold, so it is the skew a live viewer sees
   *  between the widget path (latest-wins postMessage) and cell output. */
  private queued = 0;
  /** Per cell: the repaint queued but not yet started, latest fold wins. */
  private readonly pendingRepaint = new Map<number, { items: OutputItem[] }>();
  /** Per cell: what the document currently shows, so a repaint can update only
   *  the slots that changed (see {@link repaintInPlace}). Dropped wherever the
   *  cell's outputs are destroyed, alongside the display handles. */
  private readonly painted = new Map<
    number,
    { outs: vscode.NotebookCellOutput[]; slots: PaintedSlot[] }
  >();
  // Set by endAll() (live sync torn down). A structural backstop: even if a
  // stray flush reaches the sink after teardown (e.g. a scheduler
  // that ignores cancel()), create() refuses to spin up a NEW proxy execution
  // that would never receive a matching `done` — a permanent spinner.
  private disposed = false;

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
    this.queued += 1;
    const next = (this.tail.get(idx) ?? Promise.resolve())
      .then(work)
      .catch(() => undefined)
      .then(() => {
        this.queued -= 1;
      });
    this.tail.set(idx, next);
  }

  /** Ops accepted but not yet applied to the document (see {@link queued}). */
  backlog(): number {
    return this.queued;
  }

  /**
   * Fold a new repaint into the one already queued for this cell, if any.
   * Returns true when it was absorbed (caller must not queue another).
   *
   * Safe because a repaint paints the WHOLE authoritative fold: the newer list is
   * a superset of what the queued one would have shown. See `repaint`.
   */
  private supersedeRepaint(idx: number, items: OutputItem[]): boolean {
    const pending = this.pendingRepaint.get(idx);
    if (pending) {
      pending.items = items;
      return true;
    }
    this.pendingRepaint.set(idx, { items });
    return false;
  }

  private slotOf(o: OutputItem): PaintedSlot {
    const ctx = this.ctx();
    const live = isLiveWidget(o, ctx);
    return {
      key: slotKey(o),
      // A live widget is fingerprinted by the SET of models it reaches, not by
      // their values: the renderer keeps the values current from the comm update
      // channel, but that channel carries only `comm_msg` — a container that
      // gains a CHILD references a model the renderer has never been given, and
      // can only get it by being rebuilt from a fresh payload.
      fingerprint: live
        ? Object.keys(widgetPayload(o, ctx.widgets)?.state.state ?? {})
            .sort()
            .join(",")
        : slotFingerprint(o),
      live,
      item: o,
    };
  }

  /**
   * Update an already-painted cell slot by slot instead of replacing its whole
   * output list. Returns false when the shape changed (an output appeared,
   * vanished or moved) and only a full `replaceOutput` can express it.
   *
   * Two things make this worth the bookkeeping on a live-plot cell, where the
   * fold repaints on EVERY frame:
   *  - a live widget view is left completely alone. Its output item is only the
   *    bootstrap snapshot; the renderer keeps the view current from the comm
   *    update channel. Rewriting it tears the view down and rebuilds it from
   *    scratch — measured at three full html-manager rebuilds per plot frame on
   *    the user's training loop, plus the mirror re-serialized into each one.
   *  - an unchanged image or stream block is not rewritten at all, so a frame
   *    costs one `replaceOutputItems` for the picture that actually changed.
   */
  private async repaintInPlace(
    idx: number,
    e: vscode.NotebookCellExecution,
    items: OutputItem[],
  ): Promise<boolean> {
    const prev = this.painted.get(idx);
    const cell = this.cell(idx);
    if (!prev || !cell) return false;
    // The cell must still hold exactly what we painted; anything else (a user
    // clear, another window, a seed) invalidates our handles.
    if (prev.outs.length !== items.length || cell.outputs.length !== prev.outs.length) return false;
    const slots = items.map((o) => this.slotOf(o));
    if (slots.some((s, i) => s.key !== prev.slots[i].key)) return false;
    try {
      for (let i = 0; i < items.length; i++) {
        const before = prev.slots[i];
        const now = slots[i];
        if (now.fingerprint === before.fingerprint && now.live === before.live) continue;
        await e.replaceOutputItems(toOutputItems(items[i], this.ctx()), prev.outs[i]);
      }
    } catch {
      // A handle VSCode no longer accepts (the cell was rewritten under us).
      // Fall back to the full replace rather than leaving the cell half-updated.
      this.painted.delete(idx);
      return false;
    }
    // Same handles, so the stream/display registrations stay valid: a stream
    // delta after this repaint continues the SAME block, and a cross-cell
    // update_display still finds the output it owns.
    this.painted.set(idx, { outs: prev.outs, slots });
    return true;
  }

  /**
   * Rewrite the cell's live widget outputs from the CURRENT mirror.
   *
   * `repaintInPlace` deliberately never touches them, so their item data still
   * holds the snapshot from whenever the view was created. That is invisible
   * while the renderer is being fed live updates, but the moment the run ends
   * those stop — and a view re-created later (the output scrolled out of view
   * and back) is built from the item data. Refreshing once at the end leaves the
   * bootstrap snapshot equal to the widget's final state.
   */
  private async refreshWidgetOutputs(idx: number, e: vscode.NotebookCellExecution): Promise<void> {
    const prev = this.painted.get(idx);
    if (!prev) return;
    const slots = prev.slots;
    for (let i = 0; i < slots.length; i++) {
      if (!slots[i].live || !slots[i].item) continue;
      try {
        await e.replaceOutputItems(toOutputItems(slots[i].item!, this.ctx()), prev.outs[i]);
      } catch {
        return; // handles no longer valid — the next repaint rebuilds them
      }
    }
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
  private create(
    idx: number,
  ): { exec: vscode.NotebookCellExecution; started: boolean } | undefined {
    if (this.disposed) return undefined;
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
      this.invalidateDisplays(idx); // that clearOutput destroyed this cell's outputs
      rec.started = true;
    }
    return rec.exec;
  }

  private forgetStreams(idx: number): void {
    for (const k of [...this.streamOut.keys()]) {
      if (k.startsWith(`${idx}:`)) this.streamOut.delete(k);
    }
  }

  /**
   * Mark this cell's tracked displays as destroyed — call wherever the cell's
   * outputs are actually wiped (a run's opening clearOutput, a clear, a repaint).
   * The entries are kept, not deleted: a later update for one of them must be
   * able to tell "never seen" (append it) from "seen, then cleared" (drop it, as
   * the daemon fold does), and only a surviving entry can say the latter.
   * Ending an execution is deliberately NOT one of these points — it leaves the
   * cell's outputs, and so its handles, perfectly valid.
   */
  private invalidateDisplays(idx: number): void {
    for (const e of this.displays.values()) {
      if (e.idx === idx) e.outs = [];
    }
    // The painted-slot map answers the same question for the WHOLE cell ("do the
    // handles I hold still describe what is on screen"), so it dies at exactly
    // the same four points; a repaint then rebuilds it with a full replace.
    this.painted.delete(idx);
  }

  /**
   * Remember the NotebookCellOutput a display_id-bearing output was rendered as,
   * so a later update_display_data can replace it in place rather than appending.
   *
   * A CREATE takes ownership of the id for this cell (matching the daemon's own
   * "most recent creator wins"); further creates in the same cell add a handle
   * rather than replacing, because an update reaches all of them.
   */
  private registerDisplay(idx: number, item: OutputItem, out: vscode.NotebookCellOutput): void {
    const did = (item as { display_id?: string }).display_id;
    if (typeof did !== "string") return;
    const e = this.displays.get(did);
    if (e && e.idx === idx) e.outs.push(out);
    else this.displays.set(did, { idx, outs: [out] });
  }

  /**
   * Re-point an EXISTING registration at freshly painted handles (repaint only).
   *
   * A repaint re-materializes what a cell's fold already holds — it is not a new
   * `display_data`, so it must never TRANSFER ownership. Repainting cell A, whose
   * fold still carries an id that cell C has since re-created, would otherwise
   * hand the id back to A and send C's next update at A's handles.
   */
  private refreshDisplay(idx: number, item: OutputItem, out: vscode.NotebookCellOutput): void {
    const did = (item as { display_id?: string }).display_id;
    if (typeof did !== "string") return;
    const e = this.displays.get(did);
    if (e && e.idx !== idx) return; // owned by another cell — leave it alone
    this.registerDisplay(idx, item, out);
  }

  appendStream(idx: number, name: string, text: string): void {
    const e = this.ensureStarted(idx);
    if (!e) return;
    const mime = name === "stderr" ? STDERR_MIME : STDOUT_MIME;
    const key = `${idx}:${name}`;
    // Queue on the cell's chain so a stream delta stays ordered relative to an
    // image append (which awaits a byte fetch on the same chain). Doing it
    // directly let a `print` jump ahead of a still-fetching figure, so e.g.
    // `display(fig); print("done")` rendered the print ABOVE the figure (a live
    // matplotlib loss-plot + log line — the ADR-038 scenario).
    this.chain(idx, async () => {
      const item = vscode.NotebookCellOutputItem.text(text, mime);
      const out = this.streamOut.get(key);
      if (!out) {
        const fresh = new vscode.NotebookCellOutput([item]);
        this.streamOut.set(key, fresh);
        await e.appendOutput(fresh); // append the delta only — never the whole buffer
      } else {
        await e.appendOutputItems(item, out);
      }
    });
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
    stale = false,
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
      if (isOutputAreaView(item, this.ctx()?.widgets ?? null)) continue;
      if (item.output_type === "stream") {
        const mime = item.name === "stderr" ? STDERR_MIME : STDOUT_MIME;
        const out = new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.text(item.text, mime),
        ]);
        // The cell was edited since this output was produced — flag it so the
        // §3.2 stale badge shows instead of passing old output off as fresh.
        if (stale) out.metadata = { tithonStale: true };
        this.streamOut.set(`${idx}:${item.name}`, out);
        void e.appendOutput(out);
      } else {
        // Image bytes were prefetched by startLive before seeding, so ctx() resolves.
        const out = new vscode.NotebookCellOutput(toOutputItems(item, this.ctx()));
        if (stale) out.metadata = { tithonStale: true };
        this.registerDisplay(idx, item, out); // a live update after reconnect replaces in place
        void e.appendOutput(out);
      }
    }
    if (state === "done" || state === "error" || orphaned) {
      // orphaned -> NEUTRAL success (it never formally completed); done/error ->
      // the real success flag. A STALE restore (the cell was edited since the run)
      // also ends NEUTRAL so a ✓ never implies the edited code was run. Either way
      // keep the REAL finish time so the cell shows its actual (frozen) duration.
      // For an orphan with no recorded finish (an old journal predating the
      // freeze), end at the start (0s) — never Date.now(), which would re-inflate
      // to wall-clock-since-then.
      const success = orphaned || stale ? undefined : state === "done";
      const fallback = orphaned ? (startMs ?? Date.now()) : Date.now();
      e.end(success, endMs ?? fallback);
      this.execs.delete(idx);
      this.forgetStreams(idx);
      // The display registrations above deliberately SURVIVE this end: a
      // reconnect is exactly when another cell's pending update_display_data for
      // one of them replays (see `updateDisplay`).
    }
    // a "running" cell stays started until its live `done` event arrives.
  }

  appendOutput(idx: number, item: OutputItem): void {
    const e = this.ensureStarted(idx);
    if (!e) return;
    const pending = imageRefsOf(item)
      .map((r) => r.artifact_id)
      .filter((id) => this.client.cachedArtifact(id) === undefined);
    // Always queue on the cell's chain (even when no image bytes need fetching),
    // so a discrete output stays ordered relative to BOTH a preceding figure
    // (which awaits) and a following `print`. A non-stream output also breaks the
    // active stdout/stderr block, so the next stream delta starts a fresh block
    // BELOW it — giving Jupyter-style interleaving (`print; display(fig); print`
    // renders as three blocks in order, not the two prints merged above the fig).
    if (isOutputAreaView(item, this.ctx()?.widgets ?? null)) return;
    this.chain(idx, async () => {
      if (pending.length) await this.client.prefetchArtifacts(pending);
      const out = new vscode.NotebookCellOutput(toOutputItems(item, this.ctx()));
      this.registerDisplay(idx, item, out);
      await e.appendOutput(out);
      this.forgetStreams(idx); // a later stream delta opens a new block after this output
    });
  }

  /**
   * In-place display update (update_display_data): replace the OUTPUT a prior
   * display_data created — keyed by display_id — instead of appending a new one,
   * so a live timer / re-displayed figure updates in place (no stacking).
   *
   * `idx` is the cell of the display's OWNER, which the daemon resolved
   * session-wide — so it need not be the cell that emitted the
   * update, and that cell's run may be long finished. Hence the two branches,
   * mirroring `clear()`'s split: a running cell edits through its live
   * execution; a finished one gets a MOMENTARY execution that starts, replaces
   * and ends immediately (VSCode exposes no output-only edit). Never
   * `ensureStarted()` on the finished branch — it would clear the whole cell and
   * leave a spinner no `done` will ever end.
   *
   * An update for a display this sink has no live handle for is DROPPED, in both
   * branches. Both folds no-op on an id no item carries, so appending one here
   * would show output live that a repaint or a reconnect immediately takes away.
   */
  updateDisplay(idx: number, displayId: string, item: OutputItem): void {
    if (this.disposed) return;
    const rec = this.execs.get(idx);
    const pending = imageRefsOf(item)
      .map((r) => r.artifact_id)
      .filter((id) => this.client.cachedArtifact(id) === undefined);
    // Resolve the handles INSIDE the chain, never at the call site: a create
    // (appendOutput) on the same display_id registers from its own chained
    // closure, and a repaint replaces every handle from its own — reading them
    // here would target output that no longer exists by the time we write.
    if (rec?.started) {
      const e = this.ensureStarted(idx)!;
      this.chain(idx, async () => {
        if (pending.length) await this.client.prefetchArtifacts(pending);
        for (const out of this.displays.get(displayId)?.outs ?? []) {
          await e.replaceOutputItems(toOutputItems(item, this.ctx()), out);
        }
      });
      return;
    }
    this.chain(idx, async () => {
      if (pending.length) await this.client.prefetchArtifacts(pending);
      // Re-checked inside the chain for the same reason as repaint(): `chain`
      // defers, so this can land after endAll()/dispose().
      if (this.disposed) return;
      const outs = this.displays.get(displayId)?.outs ?? [];
      const c = outs.length ? this.cell(idx) : undefined;
      if (!c) return; // nothing to edit — and a cell with no execution is never grown
      const exec = this.controller.createNotebookCellExecution(c);
      exec.start(Date.now());
      try {
        for (const out of outs) {
          await exec.replaceOutputItems(toOutputItems(item, this.ctx()), out);
        }
      } finally {
        exec.end(undefined, Date.now()); // in a `finally`: a throw must not strand it
      }
    });
  }

  /**
   * Replace the cell's outputs with an authoritative folded list. Used where an
   * incremental op cannot express the change — an `ipywidgets.Output`'s
   * `clear_output` removes only ITS outputs, so the cell is repainted from the
   * fold instead of blanked.
   *
   * Mirrors `clear()`'s two branches deliberately: never `ensureStarted()` on a
   * cell with no live execution, which would leave a spinner no `done` ever
   * ends.
   *
   * The paint itself takes the cheapest form that expresses the change:
   * {@link repaintInPlace} first, and a whole-list `replaceOutput` only when the
   * output list's SHAPE changed. That matters because the live-plot idiom
   * repaints on every frame — replacing the list each time re-creates every
   * output, including widget views the renderer was animating. The full-replace
   * path drops the previous NotebookCellOutput handles, so it rebuilds the
   * stream/display maps; the in-place path keeps both.
   */
  repaint(idx: number, items: OutputItem[]): void {
    if (this.disposed) return;
    const rec = this.execs.get(idx);
    const paint = async (e: vscode.NotebookCellExecution) => {
      // Popped when the paint STARTS, not when it was queued: a repaint arriving
      // from here on must queue behind this one, not mutate the list being painted.
      const latest = this.pendingRepaint.get(idx)?.items ?? items;
      this.pendingRepaint.delete(idx);
      await this.prefetch(latest); // image bytes, so ctx() resolves synchronously below
      // Filter FIRST, then map: toCellOutputs drops items it will not render, so
      // zipping the unfiltered list against its result shifts every index past
      // the first drop and registers the wrong handles — a later stream delta
      // then misses its block and opens a second one below the plot.
      const painted = latest.filter((o) => !isOutputAreaView(o, this.ctx()?.widgets ?? null));
      if (await this.repaintInPlace(idx, e, painted)) return;
      this.forgetStreams(idx);
      this.invalidateDisplays(idx); // replaceOutput below drops every existing handle
      const outs = toCellOutputs(painted, false, this.ctx());
      await e.replaceOutput(outs);
      this.painted.set(idx, { outs, slots: painted.map((o) => this.slotOf(o)) });
      painted.forEach((item, i) => {
        if (item.output_type === "stream") this.streamOut.set(`${idx}:${item.name}`, outs[i]);
        else this.refreshDisplay(idx, item, outs[i]);
      });
    };
    if (rec?.started) {
      if (this.supersedeRepaint(idx, items)) return;
      this.chain(idx, () => paint(rec.exec));
      return;
    }
    const c = this.cell(idx);
    if (!c) return;
    // Nothing to show and nothing showing: a momentary execution here would be
    // pure UI churn on a cell that is already correct (mirrors clear()'s own
    // outputs.length guard, which stops our own clear echoing back as a flash).
    // The tracked displays still have to be invalidated — the cell holding no
    // outputs is exactly what makes their handles dead — on the chain so it
    // lands after, not before, any op already queued for this cell.
    if (!items.length && c.outputs.length === 0) {
      this.chain(idx, async () => this.invalidateDisplays(idx));
      return;
    }
    if (this.supersedeRepaint(idx, items)) return;
    this.chain(idx, async () => {
      // Re-checked INSIDE the chain: `chain` defers, so a flush that passed the
      // guard above can still land after endAll()/dispose(). Opening a proxy
      // execution then would leave a spinner teardown can no longer end
      // at all. `end()` is in a `finally` for the same reason — a throw in
      // paint() must not strand a started execution the chain then swallows.
      if (this.disposed) {
        // Only paint() pops the queued entry, so drop it here or a repaint that
        // never runs would keep absorbing every later one for this cell.
        this.pendingRepaint.delete(idx);
        return;
      }
      const exec = this.controller.createNotebookCellExecution(c);
      exec.start(Date.now());
      try {
        await paint(exec);
      } finally {
        exec.end(undefined, Date.now());
      }
    });
  }

  clear(idx: number): void {
    const rec = this.execs.get(idx);
    if (rec?.started) {
      // A kernel-driven clear_output WHILE the cell is running: clear via the live
      // execution, keeping its spinner. Queue on the chain so it lands after any
      // in-flight append (e.g. a figure still fetching) rather than racing ahead.
      this.chain(idx, async () => {
        await rec.exec.clearOutput();
      });
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
    this.invalidateDisplays(idx);
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
      const endMs = tsMs ?? Date.now();
      this.chain(idx, async () => {
        try {
          if (!rec.started) {
            rec.exec.start(endMs);
            rec.started = true;
          }
          // Before the end, not after: an ended execution can no longer edit
          // output, and this is the last chance to leave every live widget's
          // bootstrap snapshot equal to its final state (see refreshWidgetOutputs).
          await this.refreshWidgetOutputs(idx, rec.exec);
          rec.exec.end(status === "done", endMs);
        } finally {
          // Forget the stream map ON THE CHAIN, not synchronously at the call
          // site: appendStream resolves it INSIDE its own chained closure, so a
          // wipe from the call site jumps the queue and the still-pending op no
          // longer finds its output block. `finally`, because an exec.end() throw
          // (VSCode rejects a disposed/ended execution) must not leak the map
          // into the next run, where appendOutputItems would then target a dead
          // NotebookCellOutput. Displays are NOT forgotten here — see
          // `displays`; the next run's opening clearOutput invalidates them.
          this.forgetStreams(idx);
        }
      });
    }
  }

  /**
   * The USER emptied this cell's outputs (native "Clear Outputs"), so its
   * tracked display handles are already dead — the fourth point where a cell's
   * outputs are destroyed, alongside the three inside this class.
   *
   * It cannot wait for the daemon's tombstone to echo back into `repaint`: in
   * that window a cross-cell update for a display this cell owns would call
   * `replaceOutputItems` on an erased handle — display handles deliberately
   * outlive their execution, which is what opens the window.
   */
  notifyUserCleared(idx: number): void {
    this.invalidateDisplays(idx);
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
    this.disposed = true;
    for (const [idx, rec] of this.execs) {
      if (!rec.started) rec.exec.start(Date.now());
      rec.exec.end(undefined, Date.now());
      this.forgetStreams(idx);
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
  /** `${uri}#${generation}` of every fresh-after-loss kernel already reported to
   *  the user, so the "state cleared" warning fires ONCE per lost kernel and not
   *  on every reconnect/reopen that re-reads the same snapshot flag. In-memory,
   *  so a full extension-host reload warns again — deliberate: a new window is a
   *  new reader who has not seen it. */
  private readonly lostStateWarned = new Set<string>();
  /** `${uri}#${seq}` of every out-of-band kernel death already reported, so the
   *  watchdog's event does not re-warn when a later reconnect replays it. */
  private readonly kernelDeathWarned = new Set<string>();
  private readonly liveSessions = new Map<
    string,
    {
      dispose: () => void;
      refresh: () => void;
      activeCells: () => number[];
      hasPendingFlush: () => boolean;
      diag: () => LiveDiag;
    }
  >();

  private readonly selectionSub: vscode.Disposable;
  /** Channel to the ipywidget notebook renderer (live updates + render outcome). */
  private readonly widgetMessaging: vscode.NotebookRendererMessaging;
  /** Render outcomes reported by the widget renderer (html|fallback) — for verify. */
  readonly widgetRenders: Array<{ model_id?: string; mode?: string }> = [];
  /** Count of live widget updates the renderer applied (live animation) — for verify. */
  widgetUpdatesApplied = 0;
  /** Test-only: the most recent reconnect seed mapping (per notebook uri). */
  readonly lastSeedTrace = new Map<
    string,
    Array<{
      execId: string;
      originIndex: number | null | undefined;
      cellHash: string | null;
      mappedCell: number | undefined;
      staleMap: boolean;
      status: string;
    }>
  >();
  // Coalesced live widget-state deltas pushed to the renderer (latest per comm id,
  // flushed ~50ms) so a 50k-update tqdm.notebook animates without flooding it.
  // Buffers merge BY PATH across the coalescing window (mergeBufferEntries), same
  // as sessionClient's own mirror — a window spanning several comm_msg frames must
  // not let an earlier frame's buffer silently drop just because a later frame in
  // the SAME window only touched JSON state.
  // Keyed by owner+comm_id (NOT bare comm_id): two DIFFERENT notebooks' kernels
  // are independent processes, so their ipywidgets comm_ids are independently
  // UUID-generated and collide only in theory — but keying on comm_id alone
  // would still let a same-window update from notebook B silently merge into
  // (and overwrite the `owner` of) notebook A's pending entry, defeating
  // disposeLive()'s purge for A.
  // `owner` is the notebook uri string that produced this comm's update — kept so
  // disposeLive() can purge only its own entries out of this GLOBAL (cross-notebook)
  // buffer before the shared 50ms timer flushes; see `invalidateWidgetUpdatesFor`.
  private readonly widgetUpdateBuf = new Map<
    string,
    { owner: string; commId: string; state: Record<string, unknown>; buffers: WidgetBufferEntry[] }
  >();

  // NUL-separated: neither a uri nor a comm_id can contain one, so this can't
  // collide the way a printable separator (or bare comm_id) theoretically could.
  private widgetBufKey(owner: string, commId: string): string {
    return `${owner}\u0000${commId}`;
  }
  private widgetFlushTimer: ReturnType<typeof setTimeout> | null = null;
  // Auto-reconnect bookkeeping (per notebook uri). When the daemon drops a live
  // client (backpressure / restart / crash — ADR-018), we re-attach and resync
  // from a fresh folded snapshot, with capped exponential backoff so a sustained
  // overload doesn't thrash. A pending timer is cleared on an explicit disposeLive.
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reconnectAttempts = new Map<string, number>();
  // One withProgress notification per notebook uri, spanning the WHOLE reconnect
  // cycle: a daemon restart can take up to ~15s, and a momentary status-bar
  // flash leaves the rest of that wait unexplained.
  private readonly reconnectProgress = new Map<
    string,
    {
      resolve: (outcome: "connected" | "cancelled") => void;
      report: (message: string) => void;
    }
  >();

  constructor(sockPath?: string) {
    this.sockPath = sockPath ?? defaultSocketPath();
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
    // Cell STOP button (and the toolbar Interrupt VSCode draws once this handler
    // exists): the cell runs on the daemon's kernel, not a VSCode-managed
    // execution, so there's no cancellation token to honor — wire
    // interruptHandler so ⏹ SIGINTs the kernel. The running cell raises
    // KeyboardInterrupt -> errors -> the live sink ends it; the kernel stays
    // alive so the cell can be re-run. Because this handler already gives the
    // toolbar its button, the extension must not contribute a second one
    // (`notebook/toolbar` in package.json) — see `interruptKernel`.
    this.controller.interruptHandler = (nb) => this.interruptKernel(nb);
    // Auto restore + live sync exactly when OUR kernel becomes the notebook's
    // selected kernel — this is the right moment (createNotebookCellExecution
    // requires the controller be selected, so starting on raw open races ahead
    // of selection and the restore silently fails). On reopen VSCode re-selects
    // the remembered kernel, so the user gets restore+live with NO command (#3/#4).
    this.selectionSub = this.controller.onDidChangeSelectedNotebooks((e) => {
      if (e.selected) {
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
      const session = notebook.uri.toString();
      const batch = cells.map((cell) => {
        const code = cell.document.getText();
        return {
          code,
          origin: {
            uri: session,
            range: ranges[cell.index] ?? { start: cell.index, end: cell.index },
            cell_hash: computeCellHash(code),
            index: cell.index, // authoritative cell identity (duplicate-code fix)
          },
        };
      });
      // Submit the whole action as ONE batch so a "Run All" stops at the first
      // error and skips the rest (native Jupyter; #4). stop_on_error only matters
      // for >1 cell — a single play has nothing to stop. allow_stdin=true since the
      // Cell View can present an input box for input()/getpass() (the bridge);
      // ensureLive above attached the subscriber that receives the prompt event.
      await this.daemon.executeBatch(batch, session, workdir, batch.length > 1, true);
    } catch (err) {
      vscode.window.showErrorMessage(`Tithon: ${String(err)}`);
    }
  }

  /** Coalesce a live comm-state delta for the widget renderer (latest per comm id). */
  private queueWidgetUpdate(
    owner: string,
    payload:
      | { msg_type?: string; comm_id?: string; data?: any; _buffers_b64?: string[] }
      | undefined,
  ): void {
    if (payload?.msg_type !== "comm_msg" || !payload.comm_id) return;
    const data = payload.data ?? {};
    if (data.method !== "update" && data.method !== "echo_update") return;
    const key = this.widgetBufKey(owner, payload.comm_id);
    const prior = this.widgetUpdateBuf.get(key);
    const state = { ...(prior?.state ?? {}), ...(data.state ?? {}) };
    const delta = decodeBufferEntries(data.buffer_paths, payload._buffers_b64);
    const buffers = delta.length
      ? mergeBufferEntries(prior?.buffers, delta)
      : (prior?.buffers ?? []);
    this.widgetUpdateBuf.set(key, { owner, commId: payload.comm_id, state, buffers });
    if (!this.widgetFlushTimer) {
      this.widgetFlushTimer = setTimeout(() => this.flushWidgetUpdates(), 50);
    }
  }

  /** Drop a disposed live session's own pending widget deltas out of the shared
   * buffer, so its already-scheduled flush can't `postMessage` a stale update
   * after detach/restart. The buffer and its timer are global across
   * notebooks, so `disposeLive` alone would leave them armed. */
  private invalidateWidgetUpdatesFor(owner: string): void {
    for (const [key, entry] of this.widgetUpdateBuf) {
      if (entry.owner === owner) this.widgetUpdateBuf.delete(key);
    }
  }

  /** Push the coalesced widget deltas to the renderer so live widgets animate. */
  private flushWidgetUpdates(): void {
    this.widgetFlushTimer = null;
    for (const { commId: comm_id, state, buffers } of this.widgetUpdateBuf.values()) {
      // Omit `buffers` entirely (not `[]`) when there's nothing to carry —
      // symmetric with the daemon's own wire choice (event_from_message omits
      // `_buffers_b64` when absent) and keeps the overwhelmingly common
      // JSON-only postMessage payload as small as it can be.
      const msg: {
        type: string;
        comm_id: string;
        state: Record<string, unknown>;
        buffers?: typeof buffers;
      } = { type: "tithon.widget-update", comm_id, state };
      if (buffers.length) msg.buffers = buffers;
      void this.widgetMessaging.postMessage(msg);
    }
    this.widgetUpdateBuf.clear();
  }

  /**
   * Tell the user when this kernel came up EMPTY after an involuntary death.
   *
   * `Kernel.ensure` never errors on an unresumable kernel — it re-attaches when
   * the pid is alive and otherwise spawns a fresh one, which is exactly what
   * makes reconnect-after-daemon-restart work. But a host reboot takes that same
   * silent path: the journal survives on disk, so reopening the file restores the
   * full output history and the session LOOKS intact — while every variable is
   * gone. Without a signal the user reasonably assumes `df` is still defined and
   * only finds out via a NameError several cells later. The daemon flags this
   * case — a fresh kernel under a journal that already held executions — and
   * excludes only an in-session `restart_kernel`, where the user just asked for
   * the empty namespace. A daemon-wide restart (an interpreter change) is NOT
   * excluded: the variables really are gone, so the signal is correct there; it
   * is the WORDING that must not claim to know which cause applied (see below).
   * Fires once per lost kernel.
   */
  private warnIfStateLost(uri: vscode.Uri, info: KernelSnapshot | null): void {
    if (!info?.lost_state) return;
    // Keyed on the daemon's durable generation, NOT the pid — a host reboot
    // restarts the pid space, so a genuinely new lost kernel can reuse an
    // earlier pid and a pid-keyed guard would swallow the warning. Falls back to
    // the pid only for a daemon too old to send a generation.
    const key = `${uri.toString()}#${info.generation ?? `pid:${info.pid ?? "?"}`}`;
    if (this.lostStateWarned.has(key)) return;
    this.lostStateWarned.add(key);
    const name = uri.path.split("/").pop() ?? uri.toString();
    // Deliberately does NOT name a cause. The daemon can tell that the kernel was
    // REPLACED, not why: a host reboot, an idle-GC reap, an OOM kill and an
    // interpreter change (restartDaemon kills every kernel) all arrive here
    // identically. Naming "host reboot" would misdescribe the interpreter change
    // the user just made — and a warning that tells the user something they know
    // to be wrong is a warning they learn to dismiss. State the consequence,
    // which is identical in every case, and let the cause list be illustrative.
    void vscode.window.showWarningMessage(
      `Tithon: ${name} is running on a new kernel, so its Python namespace is empty ` +
        `(the previous kernel was replaced — host reboot, idle-GC, or an interpreter change). ` +
        `Cell outputs were restored from the journal, but variables were not — ` +
        `re-run your setup cells before relying on them.`,
    );
  }

  /** Test affordance: which `${uri}#${generation}` lost-kernel warnings fired. */
  lostStateWarnings(): string[] {
    return [...this.lostStateWarned];
  }

  /**
   * The daemon's liveness watchdog saw this file's kernel die with NO cell
   * running — a host OOM-kill, an operator kill, a lost remote host. Nothing
   * else surfaces it: a death during execution errors the cell that was running,
   * but an idle death produced no output at all, so the user kept a healthy
   * looking kernel until their next Run and only then learned every variable was
   * gone.
   *
   * Driven by the client's SETTLED kernel view, never by the triggering message.
   * Two call sites reach it and only one of them has an event at all: live events
   * (onEvent is wired only AFTER attach resolves, so a reconnect's replayed
   * backlog never arrives here) and the post-attach check, which is what covers
   * reopening a file whose kernel died while nobody was connected. Reading the
   * settled status makes both correct, and keying on the daemon's durable
   * `generation` — the same key the lost-state warning uses — makes them agree, so
   * one death yields exactly one warning no matter which path observed it.
   *
   * Keyed on generation and NOT the pid for the ADR-075 reason: a rebooted host
   * restarts its pid space, so a later genuinely-dead kernel can reuse an earlier
   * pid and a pid-keyed guard would swallow the warning.
   */
  private warnKernelDied(uri: vscode.Uri, client: SessionClient): void {
    const info = client.kernelInfo();
    if (info?.status !== "dead") return; // alive, or already superseded by a restart
    const key = `${uri.toString()}#${info.generation ?? `pid:${info.pid ?? "?"}`}`;
    if (this.kernelDeathWarned.has(key)) return;
    this.kernelDeathWarned.add(key);
    const name = uri.path.split("/").pop() ?? uri.toString();
    void vscode.window.showErrorMessage(
      `Tithon: the kernel for ${name} died (it was not running a cell — an ` +
        `out-of-memory kill, an operator kill, or a lost host). Cell outputs are ` +
        `safe in the journal, but the Python namespace is gone. ` +
        `Restart the kernel to continue.`,
    );
  }

  /** Test affordance: which `${uri}#${generation}` kernel-death warnings fired. */
  kernelDeathWarnings(): string[] {
    return [...this.kernelDeathWarned];
  }

  /** Show the kernel's Python version on the selected controller label. */
  private applyKernelLabel(python: string | null): void {
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
    // Cancel pending auto-reconnects: this deliberate restart re-attaches below,
    // so a stale timer must not fire a redundant (or racing) reconnect.
    for (const t of this.reconnectTimers.values()) clearTimeout(t);
    this.reconnectTimers.clear();
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
      {
        label: "$(check) Use the Python extension's interpreter",
        description: "default",
        path: "",
      },
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
      chosen =
        (await vscode.window.showInputBox({
          prompt: "Absolute path to the Python interpreter (it must have `tithon` installed)",
          value: this.sockPath, // hint; user replaces
        })) ?? "";
      if (!chosen) return;
    }
    await vscode.workspace
      .getConfiguration("tithon")
      .update("pythonPath", chosen, vscode.ConfigurationTarget.Global);

    // The interpreter is daemon-wide, so applying it means restarting the daemon.
    // Always asks, even with confirmation off: the setting is chosen and the
    // question here is "apply it NOW?", not a guard on a destructive click.
    const answer = await vscode.window.showWarningMessage(
      "Changing the interpreter restarts the Tithon daemon — all running kernels and cells will stop. Restart now?",
      { modal: true },
      "Restart now",
      "Later",
    );
    if (answer === "Restart now") {
      await this.restartDaemon();
      notifyInfo("Tithon: daemon restarted with the selected interpreter");
    }
  }

  /**
   * Show the daemon's running kernels and terminate the one the user picks.
   * Driven by a command/toolbar button: list → pick → confirm → kill. The kernel
   * is killed host-side (freeing GPU memory) and its session dropped; reopening
   * the file later restores its output under a fresh kernel. Works for any
   * running kernel, including files this window doesn't have open.
   */
  async pickAndKillKernel(): Promise<void> {
    await ensureDaemon(this.sockPath);
    let kernels: KernelInfo[];
    try {
      kernels = await this.daemon.listKernels();
    } catch (err) {
      vscode.window.showErrorMessage(`Tithon: ${String(err)}`);
      return;
    }
    const running = kernels.filter((k) => k.kernel_pid != null);
    if (running.length === 0) {
      notifyWarn("Tithon: no running kernels.");
      return;
    }
    type Item = vscode.QuickPickItem & { session: string };
    const items: Item[] = running.map((k) => ({
      label: `$(circle-filled) ${kernelLabel(k.session)}`,
      description: `Python ${k.kernel_python ?? "?"} · pid ${k.kernel_pid}`,
      detail:
        `${k.executions} execution(s)` +
        (k.queue_len ? `, ${k.queue_len} queued` : "") +
        ` · ${k.kernel_status}` +
        // Lifetime hint: who is watching, or how long the kernel has sat idle —
        // the number the user needs to decide "safe to terminate?".
        ((k.clients ?? 0) > 0
          ? ` · ${k.clients} client(s) attached`
          : k.idle_seconds != null
            ? ` · idle ${fmtIdle(k.idle_seconds)}`
            : ""),
      session: k.session,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a running kernel to terminate",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!pick) return;
    const confirmed = await confirmDestructive({
      message: `Terminate the kernel for ${kernelLabel(pick.session)}?`,
      detail:
        "The Python process is killed and its host/GPU memory freed: every variable is lost and any running cell stops. Previous outputs stay restorable.",
      confirmLabel: "Terminate",
    });
    if (!confirmed) return;
    const ok = await this.daemon.killKernel(pick.session);
    // Tear down our live view for that file (if any) so the UI resets — the next
    // run/open spawns a fresh kernel.
    try {
      this.disposeLive(vscode.Uri.parse(pick.session));
    } catch {
      /* "default"/CLI session isn't a real uri — nothing to dispose */
    }
    if (ok) {
      notifyInfo(`Tithon: kernel terminated (${kernelLabel(pick.session)})`);
    } else {
      notifyWarn("Tithon: kernel was not running");
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
    if (this.widgetFlushTimer) clearTimeout(this.widgetFlushTimer);
    for (const t of this.reconnectTimers.values()) clearTimeout(t);
    this.reconnectTimers.clear();
    for (const key of [...this.reconnectProgress.keys()])
      this.finishReconnectProgress(key, "cancelled");
    this.wantLive.clear();
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
    this.wantLive.add(key); // record intent so an unexpected drop auto-reconnects
    if (this.liveSessions.has(key)) return;
    const session = await this.startLive(notebook);
    // A concurrent ensureLive (e.g. auto-open + executeHandler racing) may have
    // populated the map while we awaited startLive — keep the first, drop ours.
    // An explicit disposeLive (close/deselect) during the SAME await clears
    // wantLive — the user already left, so the freshly-started session must
    // be torn down here too, not resurrected.
    if (this.liveSessions.has(key) || !this.wantLive.has(key)) {
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
    // An explicit dispose (deselect / close / restart) is user intent to stop —
    // cancel any in-flight auto-reconnect so we don't resurrect the session.
    this.wantLive.delete(key);
    const t = this.reconnectTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.reconnectTimers.delete(key);
    }
    this.reconnectAttempts.delete(key);
    this.finishReconnectProgress(key, "cancelled"); // deliberate stop, not a fault
    this.invalidateWidgetUpdatesFor(key);
    this.closedRestoreOffered.delete(key); // reopening the file may offer again
    const s = this.liveSessions.get(key);
    if (s) {
      s.dispose();
      this.liveSessions.delete(key);
    }
  }

  /** Notebooks already told this session was closed. An auto-reconnect calls
   *  startLive again, and one prompt per open is enough. */
  private readonly closedRestoreOffered = new Set<string>();

  /**
   * Tell the user their closed session still holds output, and offer it back.
   *
   * A prompt rather than a silent restore: skipping the seed is the point, since
   * they ended the session on purpose. But saying nothing would read as "the
   * history is gone", which is the opposite of what happened and of what Tithon
   * promises.
   */
  private offerClosedSessionRestore(notebook: vscode.NotebookDocument, count: number): void {
    const key = notebook.uri.toString();
    if (this.closedRestoreOffered.has(key)) return;
    this.closedRestoreOffered.add(key);
    const restore = "Restore outputs";
    void vscode.window
      .showInformationMessage(
        `Kernel was closed for this file. ${count} previous execution` +
          `${count === 1 ? "" : "s"} kept, not restored.`,
        restore,
      )
      .then((choice) => {
        if (choice === restore) void this.restore(notebook);
      });
  }

  /** URIs the user wants kept live (set in ensureLive, cleared by disposeLive).
   *  The auto-reconnect proceeds only while the uri is here, so a deselect/close
   *  cancels it but a transient drop (even during a reconnect's own seed) does
   *  not — intent, not the momentary liveSessions entry, drives reconnection. */
  private readonly wantLive = new Set<string>();

  /**
   * Re-attach a live session the daemon dropped (backpressure / restart / crash),
   * resyncing from a fresh folded snapshot so the live view does not freeze
   * (ADR-018). Capped exponential backoff (1s,2s,4s…30s) avoids hammering a
   * still-down daemon or thrashing under a sustained high-output burst; a clean
   * reconnect resets the backoff (startLive clears reconnectAttempts). An explicit
   * disposeLive (deselect/close) clears wantLive and cancels the cycle.
   */
  private scheduleReconnect(notebook: vscode.NotebookDocument, reason: string): void {
    const key = notebook.uri.toString();
    if (!this.wantLive.has(key)) return; // user stopped wanting this live
    if (this.reconnectTimers.has(key)) return; // already scheduled
    const attempt = (this.reconnectAttempts.get(key) ?? 0) + 1;
    this.reconnectAttempts.set(key, attempt);
    const delay = Math.min(1000 * 2 ** (attempt - 1), 30000);
    console.log(
      `[tithon] live connection lost (${reason}); reconnecting in ${delay}ms (attempt ${attempt})`,
    );
    this.reportReconnectProgress(notebook, reason, attempt, delay);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(key);
      if (!this.wantLive.has(key)) return; // cancelled by disposeLive
      const nb = vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === key);
      if (!nb) return; // notebook closed (disposeLive will have cleared wantLive)
      // Tear down the dead session directly (NOT disposeLive — that would clear
      // wantLive), then re-attach fresh (startLive resyncs + resets the backoff).
      const dead = this.liveSessions.get(key);
      if (dead) {
        dead.dispose();
        this.liveSessions.delete(key);
      }
      this.ensureLive(nb).then(
        () => {
          // wantLive can have been cleared by a disposeLive that raced this
          // same ensureLive() call (see its own guard) — that dispose already
          // resolved the progress entry as "cancelled"; reporting "connected"
          // here too would show a stale "reconnected" toast after the user
          // already closed the notebook.
          if (this.wantLive.has(key)) this.finishReconnectProgress(key, "connected");
        },
        () => this.scheduleReconnect(nb, "retry"), // daemon still down: back off
      );
    }, delay);
    this.reconnectTimers.set(key, timer);
  }

  /** Show (or update) the reconnect progress notification for one notebook,
   *  covering the WHOLE cycle — first drop through eventual success or an
   *  explicit dispose — distinguishing a real fault (kept retrying) from a
   *  deliberate stop (`disposeLive` resolves it as "cancelled", not a failure). */
  private reportReconnectProgress(
    notebook: vscode.NotebookDocument,
    reason: string,
    attempt: number,
    delayMs: number,
  ): void {
    const key = notebook.uri.toString();
    const label = kernelLabel(key);
    const message =
      attempt === 1
        ? `connection lost (${reason}) — reconnecting…`
        : `reconnecting… (attempt ${attempt}, retry in ${Math.round(delayMs / 1000)}s)`;
    const existing = this.reconnectProgress.get(key);
    if (existing) {
      existing.report(message);
      return;
    }
    let pending = message;
    let liveReport: ((m: string) => void) | undefined;
    const entry = {
      resolve: undefined as unknown as (outcome: "connected" | "cancelled") => void,
      report: (m: string) => {
        pending = m;
        liveReport?.(m);
      },
    };
    const outcome = new Promise<"connected" | "cancelled">((resolve) => {
      entry.resolve = resolve;
    });
    this.reconnectProgress.set(key, entry);
    void vscode.window
      .withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Tithon: ${label}`,
          cancellable: false,
        },
        async (progress) => {
          liveReport = (m) => progress.report({ message: m });
          liveReport(pending);
          const result = await outcome;
          progress.report({ message: result === "connected" ? "reconnected" : "disconnected" });
          await new Promise((r) => setTimeout(r, result === "connected" ? 1000 : 700));
        },
      )
      .then(undefined, () => undefined); // never let a VSCode-side rejection go unhandled
  }

  /** Resolve and dismiss an open reconnect progress notification, if any. */
  private finishReconnectProgress(key: string, outcome: "connected" | "cancelled"): void {
    const entry = this.reconnectProgress.get(key);
    if (entry) {
      entry.resolve(outcome);
      this.reconnectProgress.delete(key);
    }
  }

  /** Restart a file's kernel (fresh namespace), then resync the live view. */
  async restartKernel(notebook: vscode.NotebookDocument): Promise<void> {
    await ensureDaemon(this.sockPath);
    this.disposeLive(notebook.uri);
    await this.daemon.restartKernel(notebook.uri.toString());
    await this.ensureLive(notebook); // re-attach: clears spinners, re-seeds state
  }

  /**
   * Interrupt a file's kernel — the ONE interrupt path. Every affordance routes
   * here: the cell ⏹ and `notebook.cell.cancelExecution` (through
   * `controller.interruptHandler`), the `tithon.interruptKernel` command, and
   * Escape at an input prompt. Keep it that way; a second entry point that
   * SIGINTs the same kernel is just a second button for one action.
   *
   * Reports its own outcome and never throws, so every caller behaves alike —
   * including `interruptHandler`, which VSCode gives nowhere to surface a
   * rejection — a failure there would otherwise be invisible to the user.
   */
  async interruptKernel(notebook: vscode.NotebookDocument): Promise<void> {
    try {
      await ensureDaemon(this.sockPath);
      const ok = await this.daemon.interrupt(notebook.uri.toString());
      if (ok) notifyInfo("Tithon: interrupt sent");
      else notifyWarn("Tithon: no running kernel to interrupt");
    } catch (err) {
      vscode.window.showErrorMessage(`Tithon interrupt: ${String(err)}`);
    }
  }

  /** Notebook uris with an input box currently open (one prompt at a time). */
  private readonly inputBoxOpen = new Set<string>();

  /**
   * Present a cell's input()/getpass() prompt as a VSCode input box and answer
   * the daemon with the result, so the blocked cell continues (the stdin bridge).
   * Cancelling (Escape) interrupts the kernel — aborting the waiting cell rather
   * than feeding it bogus input. One box per notebook at a time; a duplicate
   * prompt (e.g. a snapshot + a live event) is ignored while one is open.
   */
  private async promptForInput(
    notebook: vscode.NotebookDocument,
    client: SessionClient,
    pending: { prompt: string; password: boolean },
  ): Promise<void> {
    const key = notebook.uri.toString();
    if (this.inputBoxOpen.has(key)) return;
    this.inputBoxOpen.add(key);
    try {
      const value = await vscode.window.showInputBox({
        prompt: pending.prompt || "Input requested by the running cell",
        password: pending.password,
        ignoreFocusOut: true, // a blocked cell must not lose its prompt on focus change
      });
      if (value === undefined) {
        await this.interruptKernel(notebook);
      } else {
        client.sendInput(value);
      }
    } finally {
      this.inputBoxOpen.delete(key);
    }
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
      // Synchronously, before the round trip below: the cell is ALREADY empty,
      // so any display handle the sink still holds for it is dead now.
      sink.notifyUserCleared(idx);
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
      undefined,
      notebook.uri.toString(),
      workdirForUri(notebook.uri),
    );
    await client.attach(0);
    try {
      const attachments = client.restoreInto(cells, notebook.uri.toString());
      // Prefetch every image artifact before rendering so figures restore as
      // pictures, not "<Figure ...>" placeholders.
      const allOutputs = [...attachments.values()].flatMap((a) => a.outputs as OutputItem[]);
      await client.prefetchArtifacts(
        allOutputs.flatMap((o) => imageRefsOf(o).map((r) => r.artifact_id)),
      );
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
        await exec.replaceOutput(toCellOutputs(att.outputs as OutputItem[], att.stale, ctx));
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
  async startLive(notebook: vscode.NotebookDocument): Promise<{
    dispose: () => void;
    refresh: () => void;
    activeCells: () => number[];
    hasPendingFlush: () => boolean;
    diag: () => LiveDiag;
  }> {
    await ensureDaemon(this.sockPath); // auto-start the host daemon if needed
    const client = new SessionClient(
      undefined,
      notebook.uri.toString(),
      workdirForUri(notebook.uri),
    );
    await client.attach(0); // catch up on any prior state, then stream live
    // Register the reconnect handler with NO await between attach resolving and
    // here, so a drop during the seed/prefetch below cannot slip past an
    // unregistered callback. The daemon dropping us (backpressure / restart /
    // crash, ADR-018) would otherwise freeze the live view forever; reconnect +
    // resync from a fresh folded snapshot instead. A clean attach resets the
    // backoff so a later, independent drop reconnects promptly.
    client.onDisconnect((reason) => this.scheduleReconnect(notebook, reason));
    this.reconnectAttempts.delete(notebook.uri.toString());
    this.finishReconnectProgress(notebook.uri.toString(), "connected");
    // Surface the kernel's Python version on the controller (the picker/indicator
    // showed only "Tithon"; now "Tithon · Python 3.11.5").
    this.applyKernelLabel(client.kernelInfo()?.python ?? null);
    this.warnIfStateLost(notebook.uri, client.kernelInfo());
    // The kernel may have died out-of-band while nobody was connected: the live
    // event fired into the void and `onEvent` (wired below, after attach) never
    // replays the backlog, so the SNAPSHOT is the only thing carrying that death
    // to a client opening or reconnecting now.
    this.warnKernelDied(notebook.uri, client);
    const sink = new VSCodeCellSink(this.controller, notebook, client);
    const live = new LiveOutputSync(
      cellsFromNotebook(notebook), // in-memory, not disk (ADR-021)
      sink,
      new ThrottleScheduler(50),
      (execId) => client.outputsOf(execId),
    );
    const execs = client.executions();
    live.seed(
      execs.map((e) => ({ execId: e.execId, cellHash: e.cellHash, index: e.origin?.index })),
    );
    // Prefetch image bytes for the snapshot so seedCell renders matplotlib
    // figures synchronously below (and not as a "<Figure ...>" placeholder).
    // Events arriving during this await are captured by outputsOf() at seed time
    // and live events are wired only afterwards — no gap, no duplication FOR
    // EXECUTIONS ALREADY IN `execs` (that claim covers output bytes on a
    // known execution growing mid-prefetch, not a BRAND NEW execution).
    await sink.prefetch(execs.flatMap((e) => client.outputsOf(e.execId)));
    // A concurrent client (another window, or the CLI) can submit a NEW
    // execution on this SHARED session while the prefetch above was
    // awaiting: client.executions() already reflects it (SessionClient's own
    // message handling runs independently of whether onEvent is wired below),
    // but the `execs` snapshot taken before the await, and the seed/prefetch
    // already done, do not. Without this, that execution's live events would
    // arrive with nothing seeded to route them to and be silently dropped —
    // the cell never shows the run at all. One re-check
    // pass, not a loop-until-stable — narrows the window to "another
    // execution arrives during THIS second prefetch too", vanishingly
    // unlikely relative to the window this closes.
    const seenExecIds = new Set(execs.map((e) => e.execId));
    const lateExecs = client.executions().filter((e) => !seenExecIds.has(e.execId));
    if (lateExecs.length) {
      live.seed(
        lateExecs.map((e) => ({ execId: e.execId, cellHash: e.cellHash, index: e.origin?.index })),
      );
      await sink.prefetch(lateExecs.flatMap((e) => client.outputsOf(e.execId)));
      execs.push(...lateExecs);
    }
    // Mid-run reconnect: restore each mapped execution's OUTPUT *and* its
    // STATE+timing into the cell NOW, before wiring live events — a done cell
    // shows ✓ with its real duration, a running cell shows the spinner started at
    // the real time (so it keeps counting up) plus its prior output, and a queued
    // cell shows the pending clock (ADR-023/025). This runs synchronously after
    // attach() resolved, so no live event can slip in between capturing the
    // snapshot and wiring onEvent — no gap, no duplication.
    const toMs = (s: number | null) => (s != null ? s * 1000 : undefined);
    const trace: Array<{
      execId: string;
      originIndex: number | null | undefined;
      cellHash: string | null;
      mappedCell: number | undefined;
      staleMap: boolean;
      status: string;
    }> = [];
    for (const ex of execs)
      trace.push({
        execId: ex.execId,
        originIndex: ex.origin?.index,
        cellHash: ex.cellHash,
        mappedCell: live.cellOf(ex.execId),
        staleMap: live.staleOf(ex.execId),
        status: ex.status,
      });
    this.lastSeedTrace.set(notebook.uri.toString(), trace);
    // ...unless the user ENDED this session rather than losing it. Restoring is
    // what makes a crash, a reboot or a dropped tunnel invisible; replaying the
    // same outputs after a deliberate "Kill Kernel" instead contradicts what the
    // user just did, on this open and every open after it. The history is not
    // gone: `tithon.restoreOutputs` (and the prompt below) still seed it.
    // Only the SEED is skipped: live sync below still runs, so the next cell the
    // user executes streams into the notebook normally.
    const closed = client.isClosedByUser();
    if (closed && execs.length) this.offerClosedSessionRestore(notebook, execs.length);
    for (const ex of closed ? [] : execs) {
      const idx = live.cellOf(ex.execId);
      if (idx === undefined) continue;
      // "skipped": a Run-All cell that never ran (the run stopped on an earlier
      // error). Leave the cell blank — nothing to restore.
      if (ex.status === "skipped") continue;
      const state =
        ex.status === "done"
          ? "done"
          : ex.status === "error"
            ? "error"
            : ex.status === "queued"
              ? "queued"
              : // "orphaned": in-flight at a daemon/kernel restart, no `done` is coming —
                // render output without a perpetual spinner (the "26667s running" bug).
                ex.status === "orphaned"
                ? "orphaned"
                : "running";
      // staleOf: the cell was edited since this run (mapped by index, code gone) —
      // restore the old output flagged stale, ending neutral (ADR-047).
      sink.seedCell(
        idx,
        client.outputsOf(ex.execId),
        state,
        toMs(ex.startedAt),
        toMs(ex.finishedAt),
        live.staleOf(ex.execId),
      );
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
      // the model so e.g. a tqdm.notebook bar fills in real time). The daemon can
      // still deliver a few more events during ws.close()'s handshake window (data
      // already in flight when disposeLive() ran) — `invalidateWidgetUpdatesFor`
      // only purges what's ALREADY buffered at that instant, so a late arrival
      // must be rejected at the SOURCE too, not just cleaned up after queuing.
      // `disposeLive()` deletes from `liveSessions` synchronously as its last
      // step, so this reads the CURRENT state, not a snapshot from when onEvent
      // was registered. Owner-tagging the buffered entries alone is not
      // enough — that only cleans up what was already queued.
      if (ev.kind === "widget" && this.liveSessions.has(notebook.uri.toString())) {
        this.queueWidgetUpdate(notebook.uri.toString(), ev.payload);
      }
      // The daemon's watchdog observed this kernel die out-of-band (no cell was
      // running, so nothing else would ever tell the user).
      if (ev.kind === "kernel" && ev.payload?.status === "dead") {
        this.warnKernelDied(notebook.uri, client);
      }
      // A cell hit input()/getpass(): present an input box and answer the daemon
      // so the blocked cell continues (the stdin bridge).
      if (ev.kind === "input_request") {
        void this.promptForInput(notebook, client, {
          prompt: ev.payload?.prompt ?? "",
          password: !!ev.payload?.password,
        });
      }
    });
    // Mid-prompt reconnect: a cell was already blocked on input() at attach time,
    // so re-present the prompt from the snapshot (the live event won't replay).
    const pi = client.pendingInput();
    if (pi)
      void this.promptForInput(notebook, client, { prompt: pi.prompt, password: pi.password });
    return {
      dispose: () => {
        changeSub.dispose();
        // Cancel any in-flight ThrottleScheduler window BEFORE endAll() closes
        // the sink's open executions — else a pending flush firing after this
        // point could call sink.status("running") and recreate a proxy
        // execution with no `done` ever coming.
        live.dispose();
        client.close();
        sink.endAll(); // don't leave cells spinning after we detach
      },
      refresh,
      activeCells: () => sink.activeCells(),
      hasPendingFlush: () => live.hasPendingFlush(),
      diag: () => ({
        syncSeq: client.syncSeq,
        backlog: sink.backlog(),
        execs: client.executions().map((e) => {
          const items = client.outputsOf(e.execId);
          const widgets = client.widgets();
          return {
            execId: e.execId,
            cell: live.cellOf(e.execId),
            status: e.status,
            stream: items
              .filter((o) => o.output_type === "stream")
              .map((o) => (o as { text: string }).text)
              .join("")
              .slice(-200),
            images: items.filter((o) => imageRefsOf(o).length > 0).length,
            widgets: items
              .map((o) => widgetModelIdOf(o))
              .filter((id): id is string => !!id)
              .map((id) => widgetFallbackText(id, widgets) ?? `[${id}]`),
          };
        }),
      }),
    };
  }

  /** Cell indices with an open proxy execution for a notebook (regression e2e:
   *  a cleared cell must not linger here, which would be a stuck spinner). */
  activeExecCells(notebook: vscode.NotebookDocument): number[] {
    return this.liveSessions.get(notebook.uri.toString())?.activeCells() ?? [];
  }

  /** True while this notebook's LiveOutputSync has a flush scheduled but not
   *  yet fired — the precondition a teardown test needs, so it can wait for
   *  a real pending flush instead of inferring timing indirectly. */
  hasPendingFlush(notebook: vscode.NotebookDocument): boolean {
    return this.liveSessions.get(notebook.uri.toString())?.hasPendingFlush() ?? false;
  }

  /** Test-only: {@link LiveDiag} for a notebook, or null when it has no live
   *  session. Reads the model and the sink backlog at ONE instant, which is what
   *  makes the model-vs-document skew measurable at all. */
  liveDiag(notebook: vscode.NotebookDocument): LiveDiag | null {
    return this.liveSessions.get(notebook.uri.toString())?.diag() ?? null;
  }

  /** True while an auto-reconnect progress notification is open for this
   *  notebook — lets a test confirm the indicator actually
   *  appears during a real disconnect/reconnect cycle. */
  reconnectProgressActive(notebook: vscode.NotebookDocument): boolean {
    return this.reconnectProgress.has(notebook.uri.toString());
  }

  /** True while the shared widget-update coalescing timer is armed — the
   *  precondition the stale-update regression test needs before disposing,
   *  matching `hasPendingFlush`'s pattern (poll for the real precondition
   *  instead of inferring timing). Global, not per-notebook, like the buffer
   *  itself (`widgetUpdateBuf`). */
  hasPendingWidgetFlush(): boolean {
    return this.widgetFlushTimer !== null;
  }
}

/** A readable name for a session id (file uri) in the kernel picker. */
function kernelLabel(session: string): string {
  if (session === "default") return "CLI session";
  try {
    const uri = vscode.Uri.parse(session);
    return uri.path.split("/").pop() || session;
  } catch {
    return session;
  }
}

/** Compact idle duration for the kernel picker: 45s / 12m / 3.4h / 2.1d. */
function fmtIdle(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

/**
 * Register the controller + Tithon commands. Restore and live sync are NOT
 * user commands — they run automatically: selecting the kernel
 * (onDidChangeSelectedNotebooks) and executing a cell both call ensureLive,
 * which restores the folded snapshot and starts live mirroring with no manual
 * step. The former `tithon.startLive` palette command was wholly redundant with
 * that auto path and was removed.
 *
 * `tithon.restoreOutputs` is the exception: a session the user CLOSED is not
 * re-seeded on open, so for that case — and only that case — a re-seed is
 * something they have to be able to ask for. The test-only `tithon._restore`
 * handle stays separate so the restore-path suites keep forcing a re-seed
 * without depending on the user-facing command's wording.
 */
export function registerRestore(context: vscode.ExtensionContext): TithonNotebookController {
  const controller = new TithonNotebookController();
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand("tithon.selectInterpreter", async () => {
      try {
        await controller.selectInterpreter();
      } catch (err) {
        vscode.window.showErrorMessage(`Tithon interpreter: ${String(err)}`);
      }
    }),
    // Daemon-wide and therefore the broadest destructive action Tithon offers —
    // it stops EVERY file's kernel, not just the active notebook's, so it asks
    // first (see `confirmDestructive`).
    vscode.commands.registerCommand("tithon.restartDaemon", async () => {
      const ok = await confirmDestructive({
        message: "Restart the Tithon daemon?",
        detail:
          "Every running kernel is stopped — all variables in all files are lost and running cells are cancelled. Previous outputs stay restorable.",
        confirmLabel: "Restart daemon",
      });
      if (!ok) return;
      try {
        await controller.restartDaemon();
        notifyInfo("Tithon: daemon restarted");
      } catch (err) {
        vscode.window.showErrorMessage(`Tithon daemon restart: ${String(err)}`);
      }
    }),
    // List the daemon's running kernels and terminate the one the user picks
    // (frees host/GPU memory). No active notebook needed — works for any kernel.
    vscode.commands.registerCommand("tithon.killKernel", async () => {
      try {
        await controller.pickAndKillKernel();
      } catch (err) {
        vscode.window.showErrorMessage(`Tithon terminate kernel: ${String(err)}`);
      }
    }),
    // Bring back the output of a session the user closed. Every other restore
    // happens automatically on kernel selection; this one cannot, because
    // skipping it is exactly what "the user closed this session" means.
    vscode.commands.registerCommand("tithon.restoreOutputs", async () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      if (!nb) {
        notifyWarn("Tithon: open a notebook first.");
        return;
      }
      try {
        await controller.restore(nb);
      } catch (err) {
        vscode.window.showErrorMessage(`Tithon restore: ${String(err)}`);
      }
    }),
    // Test-only: force a one-shot restore (fresh attach -> re-seed the folded
    // snapshot into the cells). Production restores automatically on kernel
    // selection; the restore-path suites (widget / rich-output reconstruction)
    // use this to re-derive cell output from the snapshot AFTER a live run.
    vscode.commands.registerCommand("tithon._restore", async () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      if (nb) await controller.restore(nb);
    }),
    // Test-only: tear down live sync for the active notebook via the SAME
    // disposeLive() path a real close/deselect/restart takes, deterministically
    // (real close/deselect timing in a headless Extension Host is not
    // reliable enough to race against a 50ms flush window).
    vscode.commands.registerCommand("tithon._disposeLive", () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      if (nb) controller.disposeLive(nb.uri);
    }),
    // Test-only: whether the active notebook's live sync has a flush scheduled
    // but not yet fired — polled to deterministically catch the flush-after-
    // teardown window before disposing, instead of inferring timing from a
    // second client's event arrival.
    vscode.commands.registerCommand("tithon._hasPendingFlush", () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      return nb ? controller.hasPendingFlush(nb) : false;
    }),
    // Test-only: whether a reconnect progress notification is
    // currently open for the active notebook.
    vscode.commands.registerCommand("tithon._reconnectProgressActive", () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      return nb ? controller.reconnectProgressActive(nb) : false;
    }),
    // Test-only: lets the integration suite confirm the widget renderer painted
    // html (vs the text fallback) and applied live animation updates.
    vscode.commands.registerCommand("tithon._widgetRenderLog", () => controller.widgetRenders),
    vscode.commands.registerCommand(
      "tithon._widgetUpdateCount",
      () => controller.widgetUpdatesApplied,
    ),
    // Test-only: whether the shared widget-update coalescing timer is currently
    // armed — the stale-update regression test polls this to catch a
    // genuinely pending flush before disposing, same pattern as _hasPendingFlush.
    vscode.commands.registerCommand("tithon._hasPendingWidgetFlush", () =>
      controller.hasPendingWidgetFlush(),
    ),
    // Test-only: check-and-dispose in ONE command, so nothing can fire the
    // 50ms widget-flush timer in the gap between observing "pending" and
    // tearing down — a gap that exists only because two separate
    // test-runner<->extension-host IPC round trips (poll, then dispose) are
    // slow relative to a 50ms window, not because the real close/deselect
    // path is. Also returns the applied-update count AT the dispose instant
    // (not via a follow-up round trip) so the caller's baseline can't itself
    // race past legitimate updates that applied while polling.
    vscode.commands.registerCommand("tithon._disposeLiveIfPendingWidgetFlush", () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      if (!nb || !controller.hasPendingWidgetFlush()) return { disposed: false };
      controller.disposeLive(nb.uri);
      return { disposed: true, countAtDispose: controller.widgetUpdatesApplied };
    }),
    // Test-only: cell indices with an open proxy execution for the active notebook
    // (a cleared/orphaned cell lingering here is the stuck-spinner bug).
    vscode.commands.registerCommand("tithon._activeExecCells", () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      return nb ? controller.activeExecCells(nb) : [];
    }),
    // Test-only: the live model's current state (fold tail + widget mirror text +
    // sink backlog) for the active notebook, so a suite can measure how far the
    // rendered cell trails the model — the live-desync regression guard.
    vscode.commands.registerCommand("tithon._liveDiag", () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      return nb ? controller.liveDiag(nb) : null;
    }),
    // Test-only: the most recent reconnect seed mapping for the active notebook.
    vscode.commands.registerCommand("tithon._seedTrace", () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      return nb ? (controller.lastSeedTrace.get(nb.uri.toString()) ?? []) : [];
    }),
  );
  return controller;
}
