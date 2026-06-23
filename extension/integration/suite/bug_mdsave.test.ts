/**
 * PROBE — markdown cell round-trip through the Cell View save path.
 *
 * Markdown cells are stored jupytext-style (`# ` prefix per line) and displayed
 * un-commented. serializeNotebook returns the stored verbatim cell ONLY when the
 * current display text equals the un-commented stored source; otherwise it
 * treats the cell as edited and re-comments via commentMarkdown. The risk this
 * probe checks: VSCode may normalize a markup cell's value (e.g. drop a trailing
 * newline), which would mis-fire the "edited" branch on an UNEDITED cell and
 * could rewrite bytes. The control case asserts an unedited save is byte-exact;
 * the edit case asserts an edit persists and the file still parses to two cells.
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
      (c: { command?: string }) => c.command === "tithon.startLive",
    ),
  );
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

describe("PROBE: markdown cell save round-trip", () => {
  it("control — saving an UNEDITED markdown notebook is byte-exact", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    const original = readFileSync(uri.fsPath).toString("latin1");
    await ext().activate();

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 2, 15000, "cells");
    assert.strictEqual(nb.cellAt(0).kind, vscode.NotebookCellKind.Markup, "cell 0 is markdown");

    await vscode.workspace.save(nb.uri);
    const after = readFileSync(uri.fsPath).toString("latin1");
    console.log(`[MDSAVE] control byte-exact=${after === original}; before=${JSON.stringify(original)} after=${JSON.stringify(after)}`);
    assert.strictEqual(after, original, "unedited markdown save must be byte-exact");
  });

  it("edits the markdown cell and saves — edit persists, re-commented, still 2 cells", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 2, 15000, "cells");

    const mdDoc = nb.cellAt(0).document;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(mdDoc.uri, new vscode.Range(0, 0, mdDoc.lineCount, 0), "New Title\n\nedited body");
    assert.ok(await vscode.workspace.applyEdit(edit), "markdown edit applied");

    await vscode.workspace.save(nb.uri);
    const onDisk = readFileSync(uri.fsPath).toString("latin1");
    const reparsed = parse(onDisk).cells;
    console.log(`[MDSAVE] after edit, disk=${JSON.stringify(onDisk)} cells=${reparsed.length}`);

    assert.ok(onDisk.includes("# New Title"), "edited markdown re-commented with `# ` prefix");
    assert.ok(onDisk.includes("# edited body"), "edited markdown body re-commented");
    assert.ok(!onDisk.includes("Heading"), "old markdown content gone");
    assert.strictEqual(reparsed.length, 2, "still a markdown cell + a code cell");
    assert.strictEqual(reparsed[0].kind, "markdown", "first cell stays markdown");
    assert.ok(onDisk.includes("x = 1"), "code cell preserved");
  });
});
