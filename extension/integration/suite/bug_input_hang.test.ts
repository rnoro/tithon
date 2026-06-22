/**
 * REGRESSION (was BUG H3) — a cell calling input() (or getpass/breakpoint/pdb)
 * must NOT deadlock the session.
 *
 * The daemon submits kc.execute(code, allow_stdin=False) (ADR-048), so the kernel
 * cannot issue an input_request that nobody answers. input() raises
 * StdinNotImplementedError immediately: the cell ERRORS fast and a later cell runs
 * normally — the session is never wedged and no interrupt is needed.
 *
 * Pre-fix (allow_stdin defaulted True) this hung forever: no input box, an endless
 * spinner, every queued cell blocked, only an interrupt escaping.
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
async function selectCell(i: number): Promise<void> {
  const edr = vscode.window.activeNotebookEditor;
  if (edr) edr.selections = [new vscode.NotebookRange(i, i + 1)];
}
async function runCell(uri: vscode.Uri, i: number): Promise<void> {
  await selectCell(i);
  await vscode.commands.executeCommand("notebook.cell.execute", { ranges: [new vscode.NotebookRange(i, i + 1)], document: uri });
}

describe("REGRESSION H3: input() errors fast and does not wedge the session", () => {
  it("input() ends with an error quickly, and a later cell still runs (no interrupt)", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 2, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    // (a) The input() cell completes (does NOT hang) and is an ERROR.
    await runCell(uri, 0);
    await waitFor(() => nb.cellAt(0).executionSummary?.success !== undefined, 15000, "input() cell completes fast");
    const cell0 = cellText(nb.cellAt(0));
    console.log(`[H3] input() cell success=${nb.cellAt(0).executionSummary?.success} output=${JSON.stringify(cell0.trim().slice(0, 120))}`);
    assert.strictEqual(nb.cellAt(0).executionSummary?.success, false, "input() cell should ERROR (allow_stdin=False), not hang");
    assert.ok(/StdinNotImplementedError|stdin/i.test(cell0), "the error should explain stdin is unavailable");

    // (b) A later cell runs normally — the session was never wedged.
    await runCell(uri, 1);
    await waitFor(() => cellText(nb.cellAt(1)).includes("AFTER_INPUT"), 20000, "later cell runs");
    console.log(`[H3] FINDING: later cell ran with no interrupt = ${cellText(nb.cellAt(1)).includes("AFTER_INPUT")}`);
    assert.ok(cellText(nb.cellAt(1)).includes("AFTER_INPUT"), "a later cell must run after input() errored");
  });
});
