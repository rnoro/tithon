/**
 * v21 — REAL VSCode: the user must be able to restart a tangled kernel from the
 * client (user feedback #5: "Jupyter lets you restart the kernel; Tithon has no
 * way"). After defining a variable and running, `tithon.restartKernel` must give
 * a fresh namespace: a follow-up cell sees the variable is GONE.
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
    (x.packageJSON?.contributes?.commands ?? []).some((c: { command?: string }) => c.command === "tithon.restartKernel"));
  if (!e) throw new Error("Tithon extension not found");
  return e;
}
async function runCell(uri: vscode.Uri, i: number): Promise<void> {
  // notebook.cell.execute follows the editor selection, so select cell i first.
  const ed = vscode.window.activeNotebookEditor;
  if (ed) ed.selections = [new vscode.NotebookRange(i, i + 1)];
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [new vscode.NotebookRange(i, i + 1)], document: uri,
  });
}

describe("Tithon restart kernel from the client (v21)", () => {
  it("restartKernel gives a fresh namespace (variable is gone)", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 2, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    // Cell 0 defines v and prints it.
    await runCell(uri, 0);
    await waitFor(() => cellText(nb.cellAt(0)).includes("SET 42"), 30000, "set v");

    // Restart the kernel from the client (the new command).
    await vscode.commands.executeCommand("tithon.restartKernel");

    // Cell 1 checks: after restart, v must be gone (fresh namespace).
    await runCell(uri, 1);
    await waitFor(() => cellText(nb.cellAt(1)).includes("CHECK False"), 30000, "v gone after restart");

    assert.ok(cellText(nb.cellAt(1)).includes("CHECK False"),
      `kernel namespace not reset after restart: ${JSON.stringify(cellText(nb.cellAt(1)))}`);
  });
});
