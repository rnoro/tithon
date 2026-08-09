/**
 * BUG (cell-merge corruption on save) — a percent `.py` whose first cell is a
 * MARKER-LESS module header ("import os" before the first `# %%`). If the user
 * inserts a cell ABOVE it (or reorders it down) and saves, the header cell —
 * which the serializer still emitted WITHOUT a `# %%` marker because its stored
 * metadata says hasMarker=false — merged into the cell above on reparse, so the
 * file silently lost a cell boundary (two cells became one).
 *
 * Fix (ADR-055 follow-up): resolveCell promotes a marker-less cell to `# %%`
 * whenever it is not the first cell. This drives a real insert + save and reads
 * the bytes back to assert all three cells survive.
 */
import * as assert from "assert";
import * as vscode from "vscode";
import { readFileSync } from "fs";
import { parse } from "../../src/serializer";

async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function ext(): vscode.Extension<unknown> {
  const e = vscode.extensions.all.find((x) =>
    (x.packageJSON?.contributes?.commands ?? []).some(
      (c: { command?: string }) => c.command === "tithon.restartKernel",
    ),
  );
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

describe("BUG: inserting a cell above a marker-less header must not merge cells", () => {
  it("inserts a cell at index 0, saves, and all cells survive on disk", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 2, 15000, "cells");
    assert.strictEqual(nb.cellCount, 2, "fixture parses to a header cell + one marker cell");
    assert.ok(nb.cellAt(0).document.getText().includes("import os"), "cell 0 is the module header");

    // Insert a new code cell at the very top.
    const newCell = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      'INSERTED = 1',
      "python",
    );
    const we = new vscode.WorkspaceEdit();
    we.set(nb.uri, [vscode.NotebookEdit.insertCells(0, [newCell])]);
    assert.ok(await vscode.workspace.applyEdit(we), "insert applied");
    await waitFor(() => nb.cellCount === 3, 5000, "3 cells after insert");

    await vscode.workspace.save(nb.uri);
    const onDisk = readFileSync(uri.fsPath).toString("latin1");
    const reparsed = parse(onDisk).cells;
    console.log(`[INSERTHEADER] disk=${JSON.stringify(onDisk)}`);
    console.log(`[INSERTHEADER] FINDING: cellsOnDisk=${reparsed.length} (want 3) -> ${reparsed.length === 3 ? "FIXED (no merge)" : "BUG (cells merged)"}`);

    assert.strictEqual(reparsed.length, 3, "all three cells must survive (no merge)");
    assert.ok(onDisk.includes("INSERTED = 1"), "inserted cell present");
    assert.ok(onDisk.includes("import os"), "header content preserved");
    assert.ok(onDisk.includes("print(os.getcwd())"), "tail cell preserved");
  });
});
