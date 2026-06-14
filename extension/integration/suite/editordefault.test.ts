/**
 * v25 — REAL VSCode: .py opens as a TEXT editor by default (no more forced
 * notebook), and "Open as Cell View" opt-in still opens the Tithon notebook and
 * runs. (user feedback: don't always render .py as a notebook.) The notebook
 * type now has an EMPTY selector, so this also proves vscode.openWith(uri,
 * "tithon-py") works without a filename selector.
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
async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) { if (Date.now() > deadline) throw new Error(`timed out: ${label}`); await new Promise((r) => setTimeout(r, 50)); }
}
function ext(): vscode.Extension<unknown> {
  const e = vscode.extensions.all.find((x) =>
    (x.packageJSON?.contributes?.commands ?? []).some((c: { command?: string }) => c.command === "tithon.startLive"));
  if (!e) throw new Error("Tithon extension not found");
  return e;
}
const isNotebookOpen = (uri: vscode.Uri) =>
  vscode.workspace.notebookDocuments.some((d) => d.uri.toString() === uri.toString() && d.notebookType === "tithon-py");

describe("Tithon .py is text by default, Cell View is opt-in (v25)", () => {
  it("opens .py as text, then Open as Cell View opens a runnable notebook", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    // Open the file the way a user does — default editor must be TEXT, not notebook.
    await vscode.commands.executeCommand("vscode.open", uri);
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15000, ".py opened in a text editor");
    assert.ok(!isNotebookOpen(uri), ".py must NOT auto-open as a Tithon notebook");

    // Opt in to the Cell View (empty selector -> proves openWith still works).
    await vscode.commands.executeCommand("tithon.openAsCellView", uri);
    await waitFor(() => isNotebookOpen(uri), 15000, "Cell View opened on demand");
    const nb = vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === uri.toString())!;
    await waitFor(() => nb.cellCount >= 1, 15000, "notebook cells");

    // And it's a real, runnable Tithon notebook.
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(0, 1)], document: uri,
    });
    await waitFor(() => cellText(nb.cellAt(0)).includes("HELLO_CELLVIEW"), 30000, "cell ran in the opted-in Cell View");
  });
});
