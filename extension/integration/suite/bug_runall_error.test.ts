/**
 * REGRESSION (was BUG H1) — "Run All" STOPS at the first cell that raises.
 *
 * Like native Jupyter/VSCode, a middle cell raising must skip the later cells.
 * The controller submits the whole action as ONE batch with stop_on_error, and
 * the daemon worker, on the first error, marks the rest "skipped" (blank, never
 * run) — and because the daemon owns the batch this holds even if the client
 * disconnects mid-run (ADR-051).
 *
 * This RUNS ALL three cells (cell 1 raises) and asserts cell 2 did NOT run.
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

describe("REGRESSION H1: Run All stops at the first cell error", () => {
  it("a middle cell raising skips the later cells (native Run All semantics)", async () => {
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

    // Wait until cell 1 (the raising cell) has errored, then give the worker
    // ample time to (incorrectly) run cell 2 if stop-on-error were broken.
    await waitFor(() => /BOOM/.test(cellText(nb.cellAt(1))), 30000, "cell 1 error");
    await new Promise((r) => setTimeout(r, 4000));

    const t0 = cellText(nb.cellAt(0));
    const t1 = cellText(nb.cellAt(1));
    const t2 = cellText(nb.cellAt(2));
    console.log(`[H1] cell0=${JSON.stringify(t0.trim())} cell1=${JSON.stringify(t1.trim().slice(0, 40))} cell2=${JSON.stringify(t2.trim())} cell2Summary=${nb.cellAt(2).executionSummary?.success}`);

    assert.ok(t0.includes("A_OK"), "cell 0 should have run");
    assert.ok(/BOOM/.test(t1), "cell 1 should have errored");
    const cell2Ran = t2.includes("C_RAN");
    console.log(`[H1] FINDING: after the error in cell 1, cell 2 ${cell2Ran ? "DID run (REGRESSION — stop-on-error broken)" : "did NOT run (native Run All; skipped)"}`);
    // Stop-on-error: cell 2 must be skipped — no output and no completed execution.
    assert.strictEqual(cell2Ran, false, "later cells must be SKIPPED after an error (native Run All)");
    assert.strictEqual(nb.cellAt(2).executionSummary?.success, undefined, "skipped cell must not show a completed run");
  });
});
