/**
 * BUG HUNT H1 — "Run All" semantics on an error.
 *
 * In Jupyter/VSCode-native notebooks, "Run All" STOPS at the first cell that
 * raises (later cells are skipped). Tithon's daemon serializes every submitted
 * cell through a FIFO exec worker that has no cross-cell "stop on error" notion,
 * and the controller's executeHandler submits ALL cells in one loop. So a middle
 * cell raising should NOT prevent later cells from running.
 *
 * This test RUNS ALL three cells (cell 1 raises) and reports whether cell 2 ran.
 * A divergence from native Run All is the finding.
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
    (x.packageJSON?.contributes?.commands ?? []).some((c: { command?: string }) => c.command === "tithon.startLive"));
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

describe("BUG H1: Run All does not stop on a cell error", () => {
  it("a middle cell raising still lets later cells run (divergence from native Run All)", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    const edr = await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 3, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    // RUN ALL. Select every cell then trigger the notebook-level execute so the
    // controller's executeHandler receives all three cells at once (the real
    // "Run All" path).
    edr.selections = [new vscode.NotebookRange(0, nb.cellCount)];
    await vscode.commands.executeCommand("notebook.execute");

    // Wait until cell 1 (the raising cell) has errored.
    await waitFor(() => /BOOM/.test(cellText(nb.cellAt(1))), 30000, "cell 1 error");
    // Give the worker time to (not) run cell 2.
    await waitFor(() => cellText(nb.cellAt(2)).includes("C_RAN"), 30000,
      "cell 2 to run after the error (this is the divergence we expect)").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1500));

    const t0 = cellText(nb.cellAt(0));
    const t1 = cellText(nb.cellAt(1));
    const t2 = cellText(nb.cellAt(2));
    console.log(`[H1] cell0=${JSON.stringify(t0.trim())} cell1=${JSON.stringify(t1.trim().slice(0, 40))} cell2=${JSON.stringify(t2.trim())}`);

    assert.ok(t0.includes("A_OK"), "cell 0 should have run");
    assert.ok(/BOOM/.test(t1), "cell 1 should have errored");
    const cell2Ran = t2.includes("C_RAN");
    console.log(`[H1] FINDING: after the error in cell 1, cell 2 ${cell2Ran ? "DID run (diverges from native Run All — later cells are NOT skipped)" : "did NOT run (matches native Run All)"}`);
    // The point of the test is to surface the behavior; assert the observed
    // (divergent) reality so a future change here is caught.
    assert.strictEqual(cell2Ran, true, "expected Tithon to keep running later cells after an error");
  });
});
