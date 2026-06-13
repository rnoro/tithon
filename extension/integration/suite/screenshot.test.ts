/**
 * Manual/demo suite (TITHON_SUITE=screenshot): opens a multi-cell notebook in a
 * real VSCode host, runs every cell via the native execute command (the same
 * path the play button uses), waits until each cell shows output, then holds the
 * window open so an external screenshot can capture the RENDERED output — proof
 * that the pixels appear, not just that cell.outputs is populated.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const dec = new TextDecoder();

function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) for (const it of o.items) {
    if (it.mime.includes("stdout") || it.mime === "text/plain" || it.mime.includes("error")) s += dec.decode(it.data);
  }
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
    (x.packageJSON?.contributes?.commands ?? []).some((c: { command?: string }) => c.command === "tithon.startLive"));
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

describe("Tithon screenshot demo", () => {
  it("runs all cells and holds the window open for a screenshot", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 3, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    await vscode.commands.executeCommand("notebook.execute"); // Run All
    await waitFor(() => {
      let n = 0;
      for (let i = 0; i < nb.cellCount; i++) if (cellText(nb.cellAt(i)).length > 0) n++;
      return n >= nb.cellCount;
    }, 30000, "all cells have output");

    for (let i = 0; i < nb.cellCount; i++) {
      console.log(`[shot] cell #${i} -> ${JSON.stringify(cellText(nb.cellAt(i)))}`);
    }
    assert.ok(cellText(nb.cellAt(0)).length > 0);

    // Hold the window open so the external screenshot can capture rendered output.
    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  });
});
