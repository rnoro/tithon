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
import { parse } from "./serializer";
import type { OutputItem } from "./outputFold";

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
 * Owns a NotebookController for the Tithon Cell View and restores cell outputs
 * from the daemon on demand. Outputs are written via cell executions
 * (`replaceOutput`) — the stable VSCode mechanism for setting cell output.
 */
export class TithonNotebookController {
  private readonly controller: vscode.NotebookController;

  constructor() {
    this.controller = vscode.notebooks.createNotebookController("tithon", "tithon-py", "Tithon");
    this.controller.supportedLanguages = ["python"];
    this.controller.supportsExecutionOrder = false;
    // Cell execution itself is submitted to the daemon via the CodeLens path;
    // this controller exists so we can attach restored outputs to cells.
    this.controller.executeHandler = () => undefined;
  }

  dispose(): void {
    this.controller.dispose();
  }

  /** Attach a session, restore folded outputs, and write them into the cells. */
  async restore(notebook: vscode.NotebookDocument): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(notebook.uri);
    const text = new TextDecoder().decode(bytes);
    const cells = parse(text).cells;

    const client = new SessionClient();
    await client.attach(0);
    try {
      const attachments = client.restoreInto(cells);
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
}

/** Register the controller + "restore outputs" command for the Cell View. */
export function registerRestore(context: vscode.ExtensionContext): void {
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
  );
}
