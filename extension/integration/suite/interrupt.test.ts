/**
 * v24 — REAL VSCode: the cell STOP button interrupts a running cell, and the
 * kernel survives so the cell can be RE-RUN (user report: "the interrupt button
 * doesn't work"). The cell runs on the daemon's kernel (not a VSCode-managed
 * execution), so we wire NotebookController.interruptHandler -> SIGINT.
 *
 * The fixture increments a kernel-resident counter and prints "RUN n", then runs
 * a long loop. Interrupt -> KeyboardInterrupt ends the cell (success=false) and
 * the loop stops; re-run prints "RUN 2", proving the kernel stayed alive and
 * re-execution works.
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
function maxTick(t: string): number {
  const ns = [...t.matchAll(/tick (\d+)/g)].map((m) => Number(m[1]));
  return ns.length ? Math.max(...ns) : -1;
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
async function selectCell(i: number): Promise<void> {
  const edr = vscode.window.activeNotebookEditor;
  if (edr) edr.selections = [new vscode.NotebookRange(i, i + 1)];
}
async function runCell(uri: vscode.Uri, i: number): Promise<void> {
  await selectCell(i);
  await vscode.commands.executeCommand("notebook.cell.execute", { ranges: [new vscode.NotebookRange(i, i + 1)], document: uri });
}

describe("Tithon cell interrupt + re-run (v24)", () => {
  it("the stop button interrupts the cell and the kernel survives for re-run", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    // Run the long loop; wait until it's clearly running.
    await runCell(uri, 0);
    await waitFor(() => cellText(nb.cellAt(0)).includes("RUN 1") && maxTick(cellText(nb.cellAt(0))) >= 3, 30000, "loop running");

    // Press the STOP button (routes to interruptHandler when set).
    await selectCell(0);
    await vscode.commands.executeCommand("notebook.cell.cancelExecution", { ranges: [new vscode.NotebookRange(0, 1)], document: uri });

    // The cell must END (interrupted = not success) — before the fix the button
    // did nothing and the loop ran to completion.
    await waitFor(() => nb.cellAt(0).executionSummary?.success === false, 20000, "cell interrupted (success=false)");

    // And the loop must actually have STOPPED (tick count stops growing).
    const stoppedAt = maxTick(cellText(nb.cellAt(0)));
    await new Promise((r) => setTimeout(r, 3000));
    const after = maxTick(cellText(nb.cellAt(0)));
    assert.ok(after - stoppedAt <= 1, `loop kept running after interrupt: ${stoppedAt} -> ${after}`);
    console.log(`[v24] interrupted at tick ${stoppedAt}; loop stopped (now ${after})`);

    // RE-RUN: the kernel must still be alive, so the counter advances to RUN 2.
    await runCell(uri, 0);
    await waitFor(() => cellText(nb.cellAt(0)).includes("RUN 2"), 20000, "re-run after interrupt (RUN 2)");
    console.log("[v24] re-ran after interrupt; kernel alive (RUN 2)");

    // Clean up: interrupt the re-running loop so teardown doesn't hang.
    await selectCell(0);
    await vscode.commands.executeCommand("notebook.cell.cancelExecution", { ranges: [new vscode.NotebookRange(0, 1)], document: uri });
  });
});
