/**
 * BUG (GPU-host critical, ADR-058) — a cell that crashes the kernel mid-run
 * (here `os._exit`; on a GPU host a CUDA OOM-kill / segfault does the same) used
 * to spin FOREVER: the daemon blocked waiting for an execute_reply that never
 * came, so the cell never ended and the queue wedged. The daemon now detects the
 * dead kernel and errors the cell. This drives it in REAL VSCode and asserts the
 * cell ends with a KernelDied error (not a perpetual spinner).
 */
import * as assert from "assert";
import * as vscode from "vscode";

const dec = new TextDecoder();
function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs)
    for (const it of o.items)
      if (it.mime.includes("stdout") || it.mime === "text/plain" || it.mime.includes("error"))
        s += dec.decode(it.data);
  return s;
}
async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
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

describe("BUG: a kernel that dies mid-execution errors the cell (no perpetual spinner)", () => {
  it("os._exit in a cell ends it with a KernelDied error within seconds", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    const edr = await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    edr.selections = [new vscode.NotebookRange(0, 1)];
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(0, 1)],
      document: uri,
    });

    // The cell must reach a terminal state quickly — NOT spin forever.
    await waitFor(
      () => /KernelDied/.test(cellText(nb.cellAt(0))) || nb.cellAt(0).executionSummary?.success === false,
      30000,
      "cell 0 errors with KernelDied (not a perpetual spinner)",
    );
    await new Promise((r) => setTimeout(r, 500));

    const t0 = cellText(nb.cellAt(0));
    const success = nb.cellAt(0).executionSummary?.success;
    console.log(`[KERNELDEATH] cell0 text=${JSON.stringify(t0.trim().slice(0, 80))} success=${success}`);
    console.log(`[KERNELDEATH] FINDING: showsKernelDied=${/KernelDied/.test(t0)} success=${success} -> ${/KernelDied/.test(t0) && success !== true ? "FIXED (errored, no wedge)" : "BUG (wedged / wrong)"}`);

    assert.ok(/KernelDied/.test(t0), "cell should show a KernelDied error");
    assert.notStrictEqual(success, true, "a dead-kernel cell must not report success");
  });
});
