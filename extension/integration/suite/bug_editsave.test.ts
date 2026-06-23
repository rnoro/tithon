/**
 * BUG (data loss on save) — editing an EXISTING cell in the Cell View and saving
 * silently wrote the OLD cell content to disk. Cause: serializeNotebook returned
 * the persistent `tithonCell` metadata VERBATIM whenever it existed, ignoring the
 * cell's current (edited) text — and VSCode never updates that metadata on a text
 * edit. So the edit lived only in the editor; the .py on disk reverted on reopen.
 * (ADR-020 backlog item.)
 *
 * This drives a real save: open a 2-cell .py as a tithon-py notebook, edit cell 0,
 * save, and read the bytes back from disk — the edit must be there and the old
 * content gone. A control case saves WITHOUT editing and asserts a byte-exact
 * round-trip (the fix must not regress the v6 0-byte-diff guarantee for unedited
 * files via a false "edited" detection).
 */
import * as assert from "assert";
import * as vscode from "vscode";
import { readFileSync } from "fs";

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
      (c: { command?: string }) => c.command === "tithon.startLive",
    ),
  );
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

const dec = new TextDecoder();

describe("BUG: edited existing cell must persist on save (not revert to old content)", () => {
  it("control — saving an UNEDITED notebook round-trips byte-exactly", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    const original = readFileSync(uri.fsPath).toString("latin1");
    await ext().activate();

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 2, 15000, "cells");

    await vscode.workspace.save(nb.uri);
    const after = readFileSync(uri.fsPath).toString("latin1");
    console.log(`[EDITSAVE] control: bytesBefore=${original.length} bytesAfter=${after.length} exact=${after === original}`);
    assert.strictEqual(after, original, "an unedited save must be byte-exact (no spurious rewrite)");
  });

  it("edits cell 0 and saves — disk reflects the edit, not the stale old content", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 2, 15000, "cells");
    assert.ok(
      nb.cellAt(0).document.getText().includes("old"),
      "fixture cell 0 should start with the old content",
    );

    // The user edits cell 0's text in the Cell View.
    const cellDoc = nb.cellAt(0).document;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      cellDoc.uri,
      new vscode.Range(0, 0, cellDoc.lineCount, 0),
      'print("EDITED_CONTENT")',
    );
    assert.ok(await vscode.workspace.applyEdit(edit), "edit applied");
    assert.strictEqual(nb.cellAt(0).document.getText(), 'print("EDITED_CONTENT")');

    await vscode.workspace.save(nb.uri);
    const onDisk = readFileSync(uri.fsPath).toString("latin1");
    console.log(`[EDITSAVE] after edit+save, disk=${JSON.stringify(onDisk)}`);

    const hasEdit = onDisk.includes("EDITED_CONTENT");
    const hasStale = onDisk.includes('print("old")');
    console.log(`[EDITSAVE] FINDING: edit persisted=${hasEdit}, stale-old-content-on-disk=${hasStale} -> ${hasEdit && !hasStale ? "FIXED (edit saved)" : "BUG (edit lost / old content written)"}`);

    assert.ok(hasEdit, "the edited content must be written to disk");
    assert.ok(!hasStale, "the old (pre-edit) content must NOT survive on disk");
    // The second cell is untouched, so it stays byte-exact.
    assert.ok(onDisk.includes("x = 1"), "the untouched second cell must be preserved verbatim");

    // And it still parses back to two cells (markers intact, no glue/collapse).
    const reopened = await vscode.workspace.openNotebookDocument(uri);
    void dec; // (decoder kept for symmetry with sibling suites)
    console.log(`[EDITSAVE] reopened cellCount=${reopened.cellCount}`);
    assert.strictEqual(reopened.cellCount, 2, "must still be two cells after the edit");
  });
});
