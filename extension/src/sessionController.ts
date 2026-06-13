/**
 * Notebook output restore binding (VSCode integration — spike, not yet run in a
 * real VSCode host; see DECISIONS ADR-012 for the verification stance).
 *
 * This is the render half that the verified headless logic feeds: on
 * (re)connect it attaches a {@link SessionClient}, restores folded outputs with
 * {@link SessionClient.restoreInto}, and writes them into the notebook's cells
 * through the VSCode NotebookController execution API. The pure pieces it relies
 * on (subscribe + fold + cell_hash attach) are exercised end-to-end against a
 * real daemon by verify/v7; this file is the thin, API-only glue VSCode needs.
 */
import * as vscode from "vscode";
import { SessionClient } from "./sessionClient";
import { DaemonClient } from "./daemonClient";
import { parse } from "./serializer";
import type { OutputItem } from "./outputFold";
import { computeCellHash, docCellsFromParsed } from "./cellAttach";
import { LiveOutputSync, ThrottleScheduler, type CellSink } from "./liveSync";

const STDOUT_MIME = "application/vnd.code.notebook.stdout";
const STDERR_MIME = "application/vnd.code.notebook.stderr";

/** Convert one folded output item into a VSCode notebook output item. */
function toOutputItem(o: OutputItem): vscode.NotebookCellOutputItem {
  switch (o.output_type) {
    case "stream":
      return vscode.NotebookCellOutputItem.text(o.text, o.name === "stderr" ? STDERR_MIME : STDOUT_MIME);
    case "error":
      return vscode.NotebookCellOutputItem.error({
        name: o.ename ?? "Error",
        message: o.evalue ?? "",
        stack: (o.traceback ?? []).join("\n"),
      });
    case "display_data":
    case "execute_result": {
      // Pick a representative mime. Images were journaled as artifact refs
      // ($tithon_artifact) — the renderer entry resolves those; here we prefer
      // text/plain for the spike, falling back to JSON of the data bundle.
      const data = o.data ?? {};
      const text = data["text/plain"];
      if (typeof text === "string") {
        return vscode.NotebookCellOutputItem.text(text, "text/plain");
      }
      return vscode.NotebookCellOutputItem.json(data);
    }
  }
}

function toCellOutput(outputs: OutputItem[], stale: boolean): vscode.NotebookCellOutput {
  const out = new vscode.NotebookCellOutput(outputs.map(toOutputItem));
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
  private readonly execs = new Map<number, vscode.NotebookCellExecution>();
  private readonly streamOut = new Map<string, vscode.NotebookCellOutput>();

  constructor(
    private readonly controller: vscode.NotebookController,
    private readonly notebook: vscode.NotebookDocument,
  ) {}

  private cell(idx: number): vscode.NotebookCell | undefined {
    try {
      return this.notebook.cellAt(idx);
    } catch {
      return undefined;
    }
  }

  private ensureExec(idx: number): vscode.NotebookCellExecution | undefined {
    let e = this.execs.get(idx);
    if (!e) {
      const c = this.cell(idx);
      if (!c) return undefined;
      e = this.controller.createNotebookCellExecution(c);
      e.start(Date.now());
      void e.clearOutput();
      this.execs.set(idx, e);
    }
    return e;
  }

  private forgetStreams(idx: number): void {
    for (const k of [...this.streamOut.keys()]) {
      if (k.startsWith(`${idx}:`)) this.streamOut.delete(k);
    }
  }

  appendStream(idx: number, name: string, text: string): void {
    const e = this.ensureExec(idx);
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

  appendOutput(idx: number, item: OutputItem): void {
    const e = this.ensureExec(idx);
    if (!e) return;
    void e.appendOutput(new vscode.NotebookCellOutput([toOutputItem(item)]));
  }

  updateDisplay(idx: number, _displayId: string, item: OutputItem): void {
    this.appendOutput(idx, item); // spike: append (no in-place display update yet)
  }

  clear(idx: number): void {
    const e = this.ensureExec(idx);
    if (!e) return;
    void e.clearOutput();
    this.forgetStreams(idx);
  }

  status(idx: number, status: string): void {
    if (status === "running") {
      this.ensureExec(idx);
      return;
    }
    const e = this.execs.get(idx);
    if (e) {
      e.end(status === "done", Date.now());
      this.execs.delete(idx);
      this.forgetStreams(idx);
    }
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
  private readonly liveSessions = new Map<string, vscode.Disposable>();

  constructor(sockPath?: string) {
    this.controller = vscode.notebooks.createNotebookController("tithon", "tithon-py", "Tithon");
    this.controller.supportedLanguages = ["python"];
    this.controller.supportsExecutionOrder = false;
    this.daemon = new DaemonClient(sockPath);
    // Native cell play button: start live sync then submit each cell to the daemon.
    this.controller.executeHandler = (cells, nb) => void this._executeHandler(cells, nb);
  }

  private async _executeHandler(
    cells: vscode.NotebookCell[],
    notebook: vscode.NotebookDocument,
  ): Promise<void> {
    try {
      await this.ensureLive(notebook);
      // Submit with the cell's *line* range (matching the CodeLens path and the
      // doc-cell ranges restore uses), not a cell-index range — see ADR-019.
      const ranges = await this.cellLineRanges(notebook);
      for (const cell of cells) {
        const code = cell.document.getText();
        await this.daemon.execute(code, {
          uri: notebook.uri.toString(),
          range: ranges[cell.index] ?? { start: cell.index, end: cell.index },
          cell_hash: computeCellHash(code),
        });
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Tithon: ${String(err)}`);
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
    for (const s of this.liveSessions.values()) s.dispose();
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
    this.liveSessions.set(key, session);
  }

  /** Attach a session, restore folded outputs, and write them into the cells. */
  async restore(notebook: vscode.NotebookDocument): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(notebook.uri);
    const text = new TextDecoder().decode(bytes);
    const cells = parse(text).cells;

    const client = new SessionClient();
    await client.attach(0);
    try {
      const attachments = client.restoreInto(cells, notebook.uri.toString());
      for (const [cellIndex, att] of attachments) {
        let cell: vscode.NotebookCell;
        try {
          cell = notebook.cellAt(cellIndex);
        } catch {
          continue; // cell index out of range for the current document
        }
        const exec = this.controller.createNotebookCellExecution(cell);
        exec.start(Date.now());
        await exec.replaceOutput(toCellOutput(att.outputs as OutputItem[], att.stale));
        exec.end(!att.stale, Date.now());
      }
    } finally {
      client.close();
    }
  }

  /**
   * Start *live* sync: keep a session open and mirror the daemon's output stream
   * into the notebook's cells in real time, with bounded render cost (coalesced
   * by {@link LiveOutputSync}). Returns a Disposable that stops the session.
   */
  async startLive(notebook: vscode.NotebookDocument): Promise<vscode.Disposable> {
    const bytes = await vscode.workspace.fs.readFile(notebook.uri);
    const cells = parse(new TextDecoder().decode(bytes)).cells;

    const client = new SessionClient();
    await client.attach(0); // catch up on any prior state, then stream live
    const sink = new VSCodeCellSink(this.controller, notebook);
    const live = new LiveOutputSync(cells, sink, new ThrottleScheduler(50));
    live.seed(client.executions().map((e) => ({ execId: e.execId, cellHash: e.cellHash })));
    client.onEvent((ev) => live.onEvent(ev));
    return new vscode.Disposable(() => client.close());
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
  );
  return controller;
}
