/**
 * BUG HUNT H5 — an empty / comment-only cell must complete cleanly (no stuck
 * spinner). A user routinely runs a blank cell or a comment-only cell; if the
 * proxy execution never gets a clean done it would spin forever.
 *
 * Fixture: cell 0 is comment-only, cell 1 prints. We also INSERT an empty cell
 * in the Cell View and run it (getText() === "") to cover the truly-blank case.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const dec = new TextDecoder();
function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) for (const it of o.items)
    if (it.mime.includes("stdout") || it.mime === "text/plain" || it.mime.includes("error")) s += dec.decode(it.data);
  return s;
}
async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) { if (Date.now() > deadline) throw new Error(`timed out: ${label}`); await new Promise((r) => setTimeout(r, 50)); }
}
function ext(): vscode.Extension<unknown> {
  const e = vscode.extensions.all.find((x) =>
    (x.packageJSON?.contributes?.commands ?? []).some((c: { command?: string }) => c.command === "tithon.restartKernel"));
  if (!e) throw new Error("Tithon extension not found");
  return e;
}
async function runCell(uri: vscode.Uri, i: number): Promise<void> {
  const edr = vscode.window.activeNotebookEditor;
  if (edr) edr.selections = [new vscode.NotebookRange(i, i + 1)];
  await vscode.commands.executeCommand("notebook.cell.execute", { ranges: [new vscode.NotebookRange(i, i + 1)], document: uri });
}

describe("BUG H5: empty / comment-only cell completes cleanly", () => {
  it("a comment-only cell and a truly-empty cell both finish (no stuck spinner)", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 2, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    // (a) comment-only cell 0
    await runCell(uri, 0);
    await waitFor(() => nb.cellAt(0).executionSummary?.success !== undefined, 25000, "comment-only cell completes");
    const ok0 = nb.cellAt(0).executionSummary?.success;
    console.log(`[H5] comment-only cell success=${ok0}, output=${JSON.stringify(cellText(nb.cellAt(0)).trim())}`);
    assert.strictEqual(ok0, true, "comment-only cell should complete successfully (no stuck spinner)");

    // sanity: a normal cell still runs after it
    await runCell(uri, 1);
    await waitFor(() => cellText(nb.cellAt(1)).includes("AFTER_EMPTY"), 25000, "next cell runs");

    // (b) truly-empty cell added in the Cell View (getText() === "")
    const empty = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "", "python");
    const edit = new vscode.WorkspaceEdit();
    edit.set(uri, [vscode.NotebookEdit.insertCells(nb.cellCount, [empty])]);
    assert.ok(await vscode.workspace.applyEdit(edit), "empty cell inserted");
    await waitFor(() => nb.cellCount >= 3, 10000, "empty cell present");
    const emptyIdx = nb.cellCount - 1;
    await runCell(uri, emptyIdx);
    await waitFor(() => nb.cellAt(emptyIdx).executionSummary?.success !== undefined, 25000, "empty cell completes");
    const okE = nb.cellAt(emptyIdx).executionSummary?.success;
    console.log(`[H5] FINDING: empty cell success=${okE}, activeExecCells=${JSON.stringify(await vscode.commands.executeCommand("tithon._activeExecCells"))}`);
    assert.strictEqual(okE, true, "a truly-empty cell should complete successfully (no stuck spinner)");

    const active = (await vscode.commands.executeCommand("tithon._activeExecCells")) as number[];
    assert.ok(!active.includes(emptyIdx), "empty cell must not linger as a running execution");
  });
});
