/**
 * v13 — REAL VSCode robustness: output maps to cells even when the on-disk .py
 * differs from the open notebook (ADR-021). This is the user's actual failure:
 * an older glue-bug file on disk parses to the wrong cells, so live-sync (which
 * used to re-parse the disk file) mapped the run to nothing and showed no output.
 *
 * Here we force a disk/notebook mismatch: the file on disk says DISKVERSION, but
 * we edit the cell in memory to print EDITED (notebook now dirty, disk stale),
 * then run it via the native play button. The cell must show EDITED — proving
 * the live index is built from the in-memory cell text the daemon actually runs,
 * not from the stale disk file.
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

describe("Tithon maps output despite a stale/mismatched disk file (v13)", () => {
  it("shows output for a cell edited in memory but not saved to disk", async () => {
    const fixture = process.env.TITHON_FIXTURE!;
    const uri = vscode.Uri.file(fixture);
    const ext = findTithonExtension();
    await ext.activate();

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext.id });

    // Edit the cell in memory only — disk still says DISKVERSION.
    const cellDoc = nb.cellAt(0).document;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      cellDoc.uri,
      new vscode.Range(0, 0, cellDoc.lineCount, 0),
      'print("EDITED")',
    );
    assert.ok(await vscode.workspace.applyEdit(edit), "in-memory edit applied");
    assert.ok(nb.isDirty, "notebook is dirty (disk is now stale)");
    assert.strictEqual(nb.cellAt(0).document.getText(), 'print("EDITED")');

    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(0, 1)],
      document: uri,
    });

    await waitFor(() => cellText(nb.cellAt(0)).includes("EDITED"), 30000, "EDITED output in cell");
    const out = cellText(nb.cellAt(0));
    assert.ok(out.includes("EDITED"), `cell should show EDITED, got ${JSON.stringify(out)}`);
    assert.ok(!out.includes("DISKVERSION"), "must not run the stale disk content");
  });
});
