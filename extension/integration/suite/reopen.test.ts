/**
 * v18 — REAL VSCode: a file must stay runnable after you CLOSE and REOPEN it
 * (user feedback #1: "after running once, closing and reopening the file makes
 * cell execution / output stop working"). Root cause: the live session was
 * keyed by uri and never disposed on close, so reopening reused a dead
 * (closed-document) session and silently dropped output. Fix: dispose live on
 * close, auto-start on open.
 *
 * The fixture increments a kernel-resident counter, so a SECOND run after reopen
 * prints "RUN 2" — proving the cell actually re-executed (not just restored old
 * output) and the per-file kernel persisted across the reopen.
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
async function runCell0(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [new vscode.NotebookRange(0, 1)], document: uri,
  });
}

describe("Tithon file stays runnable after close+reopen (v18)", () => {
  it("re-executes a cell after the notebook is closed and reopened", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    // First open + run -> RUN 1.
    let nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
    await runCell0(uri);
    await waitFor(() => cellText(nb.cellAt(0)).includes("RUN 1"), 30000, "first run");

    // Close everything; wait for the document to actually close (fires dispose).
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(
      () => !vscode.workspace.notebookDocuments.some((d) => d.uri.toString() === uri.toString()),
      8000, "notebook to close",
    ).catch(() => undefined); // some VSCode builds keep the doc cached; proceed either way

    // Reopen and run again. If the close/reopen path were broken, this run would
    // produce no output. The counter must advance to RUN 2 (kernel persisted).
    nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells after reopen");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
    await runCell0(uri);
    await waitFor(() => cellText(nb.cellAt(0)).includes("RUN 2"), 30000, "second run after reopen");

    assert.ok(cellText(nb.cellAt(0)).includes("RUN 2"), "cell did not re-execute after reopen");
  });
});
