/**
 * v19 — REAL VSCode: running cells in TWO different files must each work and stay
 * isolated (user feedback #1 "running a cell in another file breaks things" + #6
 * "surely not every file shares one kernel"). Each file is its own session =
 * its own kernel + journal. We run A, then B, then A again, and assert each
 * file shows ONLY its own output and B cannot see A's variable.
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
async function open(uri: vscode.Uri): Promise<vscode.NotebookDocument> {
  const nb = await vscode.workspace.openNotebookDocument(uri);
  await vscode.window.showNotebookDocument(nb);
  await waitFor(() => nb.cellCount >= 1, 15000, "cells");
  await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
  return nb;
}
async function runCell0(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [new vscode.NotebookRange(0, 1)], document: uri,
  });
}

describe("Tithon two files = two isolated kernels (v19)", () => {
  it("each file runs independently and B cannot see A's variable", async () => {
    const uriA = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    const uriB = vscode.Uri.file(process.env.TITHON_FIXTURE2!);
    await ext().activate();

    // A: define va and print it.
    const nbA = await open(uriA);
    await runCell0(uriA);
    await waitFor(() => cellText(nbA.cellAt(0)).includes("AAA"), 30000, "A first run");

    // B: a DIFFERENT file — must run fine and NOT see A's va (separate kernel).
    const nbB = await open(uriB);
    await runCell0(uriB);
    await waitFor(() => cellText(nbB.cellAt(0)).includes("BBB"), 30000, "B run");

    // A again, after touching B: still works, still shows A's own output.
    await vscode.window.showNotebookDocument(nbA);
    await runCell0(uriA);
    await waitFor(() => cellText(nbA.cellAt(0)).includes("AAA"), 30000, "A second run");

    const aTxt = cellText(nbA.cellAt(0));
    const bTxt = cellText(nbB.cellAt(0));
    assert.ok(aTxt.includes("AAA"), `A missing its output: ${JSON.stringify(aTxt)}`);
    assert.ok(!aTxt.includes("BBB"), `A leaked B's output: ${JSON.stringify(aTxt)}`);
    assert.ok(bTxt.includes("BBB False"), `B should run and NOT see A's va: ${JSON.stringify(bTxt)}`);
  });
});
