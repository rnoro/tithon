/**
 * v14 — REAL VSCode: a cell ADDED after live sync started still streams output
 * live, with no manual restore (ADR-022). This is the user's report on 0.0.3:
 * the first cell showed output, but a newly-added cell showed nothing until
 * a manual restore was run — because the live index was built once at
 * live-sync start and didn't include the new cell.
 *
 * Flow: run cell 0 (starts live), then insert a new cell and run it, and assert
 * the new cell shows its output WITHOUT any manual restore step.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const dec = new TextDecoder();

function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) {
    for (const item of o.items) {
      if (item.mime.includes("stdout") || item.mime === "text/plain") s += dec.decode(item.data);
    }
  }
  return s;
}

async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function findTithonExtension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.all.find((e) =>
    (e.packageJSON?.contributes?.commands ?? []).some(
      (c: { command?: string }) => c.command === "tithon.restartKernel",
    ),
  );
  if (!ext) throw new Error("Tithon extension not found");
  return ext;
}

async function runCell(uri: vscode.Uri, index: number): Promise<void> {
  // Select the cell first; notebook.cell.execute runs the editor's selection,
  // and the bare `ranges` arg is unreliable for a non-active cell.
  const ed = vscode.window.visibleNotebookEditors.find(
    (e) => e.notebook.uri.toString() === uri.toString(),
  );
  if (ed) ed.selections = [new vscode.NotebookRange(index, index + 1)];
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [new vscode.NotebookRange(index, index + 1)],
    document: uri,
  });
}

describe("Tithon streams output for a cell added after live started (v14)", () => {
  it("a newly-added cell shows live output with no manual restore", async () => {
    const fixture = process.env.TITHON_FIXTURE!;
    const uri = vscode.Uri.file(fixture);
    const ext = findTithonExtension();
    await ext.activate();

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext.id });

    // Run the first cell — this starts live sync (index has only cell 0).
    await runCell(uri, 0);
    await waitFor(() => cellText(nb.cellAt(0)).includes("CELL0"), 30000, "cell 0 output");

    // Now ADD a new cell after live sync is already running.
    const added = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      'print("ADDED")',
      "python",
    );
    const edit = new vscode.WorkspaceEdit();
    edit.set(uri, [vscode.NotebookEdit.insertCells(nb.cellCount, [added])]);
    assert.ok(await vscode.workspace.applyEdit(edit), "cell inserted");
    await waitFor(() => nb.cellCount >= 2, 10000, "second cell present");
    const newIdx = nb.cellCount - 1;

    // Run the new cell — must show output live, WITHOUT any restore command.
    await runCell(uri, newIdx);
    await waitFor(() => cellText(nb.cellAt(newIdx)).includes("ADDED"), 30000, "added cell output");

    const out = cellText(nb.cellAt(newIdx));
    assert.ok(out.includes("ADDED"), `added cell should show output, got ${JSON.stringify(out)}`);
  });
});
