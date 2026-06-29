/**
 * v39 — REAL VSCode: the manual Cell View <-> Text toggle for a `.py`.
 * A `.py` opens as plain TEXT by default; the Tithon Cell View is opt-in (ADR-032;
 * the content-based auto-open heuristic was removed for being a fragile session-
 * state machine). Guards:
 *   (1) the opt-in `tithon.openAsCellView` opens a RUNNABLE Tithon notebook even
 *       for a markerless .py — proves vscode.openWith works with an EMPTY selector
 *       (was scripts/v25.sh / editordefault.test.ts);
 *   (2) "Open as Text" resolves with NO argument via the active notebook editor —
 *       the realistic toolbar path (was scripts/v36.sh / opentext.test.ts).
 */
import * as assert from "assert";
import * as vscode from "vscode";

const dec = new TextDecoder();
function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) for (const it of o.items)
    if (it.mime.includes("stdout") || it.mime === "text/plain") s += dec.decode(it.data);
  return s;
}

function ext(): vscode.Extension<unknown> {
  const e = vscode.extensions.all.find((x) =>
    (x.packageJSON?.contributes?.commands ?? []).some(
      (c: { command?: string }) => c.command === "tithon.startLive",
    ),
  );
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const textTabsFor = (uri: vscode.Uri): vscode.Tab[] =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());

const notebookTabsFor = (uri: vscode.Uri): vscode.Tab[] =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t) =>
        t.input instanceof vscode.TabInputNotebook &&
        t.input.notebookType === "tithon-py" &&
        t.input.uri.toString() === uri.toString(),
    );

const notebookFor = (uri: vscode.Uri): vscode.NotebookDocument | undefined =>
  vscode.workspace.notebookDocuments.find(
    (d) => d.uri.toString() === uri.toString() && d.notebookType === "tithon-py",
  );

describe("Tithon manual Cell View <-> Text toggle (v39)", () => {
  // (1) The opt-in Cell View opens and runs (merged from v25/editordefault).
  it("opt-in 'Open as Cell View' opens a runnable notebook (empty selector)", async () => {
    const plainUri = vscode.Uri.file(process.env.TITHON_HELPER!); // markerless script
    await ext().activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // A markerless .py opens as TEXT; opting in must open a real Tithon notebook.
    // The notebook type has an EMPTY selector, so this also proves
    // vscode.openWith(uri, "tithon-py") works with no filename selector.
    await vscode.commands.executeCommand("vscode.open", plainUri);
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === plainUri.toString(),
      15000, "markerless .py opened as text");
    assert.strictEqual(notebookTabsFor(plainUri).length, 0, "markerless .py must not auto-open as a notebook");

    await vscode.commands.executeCommand("tithon.openAsCellView", plainUri);
    await waitFor(() => !!notebookFor(plainUri), 15000, "Cell View opened on demand");
    const nb = notebookFor(plainUri)!;
    await waitFor(() => nb.cellCount >= 1, 15000, "notebook has cells");

    // And it's a real, runnable Tithon notebook.
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(0, 1)], document: plainUri,
    });
    await waitFor(() => cellText(nb.cellAt(0)).includes("just a script"), 30000,
      "cell ran in the opted-in Cell View");
  });

  // (2) "Open as Text" with NO argument resolves via the active notebook editor
  // (the realistic toolbar path).
  it("'Open as Text' resolves with no argument via the active editor", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!); // percent .py
    await ext().activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Open the Cell View explicitly (opt-in; .py is text by default — ADR-032).
    await vscode.commands.executeCommand("tithon.openAsCellView", uri);
    await waitFor(() => !!notebookFor(uri), 15000, "Cell View opened");
    const nb = notebookFor(uri)!;
    await waitFor(() => nb.cellCount >= 1, 15000, "notebook has cells");
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => vscode.window.activeNotebookEditor?.notebook.uri.toString() === uri.toString(),
      15000, "Cell View is the active editor");

    await vscode.commands.executeCommand("tithon.openAsText"); // no argument
    await waitFor(() => textTabsFor(uri).length > 0, 15000, "switched to a text editor (no-arg path)");
    await waitFor(() => notebookTabsFor(uri).length === 0, 15000, "Cell View tab closed (no-arg path)");
    assert.ok(textTabsFor(uri).length > 0, "no-arg Open as Text must produce a text editor");
    assert.strictEqual(notebookTabsFor(uri).length, 0, "no-arg Open as Text must close the Cell View");
  });
});
