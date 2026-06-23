/**
 * PROBE / FIX — adding a NEW markdown cell in the Cell View and saving must
 * write jupytext-standard COMMENTED markdown (`# ` per line), not bare prose.
 *
 * The pre-ADR-055 synthesizeCell wrote a freshly-added markdown cell's body
 * verbatim (uncommented) under `# %% [markdown]`, producing a .py that other
 * jupytext tools (and "run as a script") would read as broken code. ADR-055's
 * synthesizeCell(value, isMarkup) now comments markdown bodies. This adds a
 * markdown cell, saves, and asserts the on-disk body is `# `-prefixed and that
 * it reparses back to a markdown cell whose display text is the original prose.
 */
import * as assert from "assert";
import * as vscode from "vscode";
import { readFileSync } from "fs";
import { parse, cellSource, uncommentMarkdown } from "../../src/serializer";

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

describe("PROBE: a newly added markdown cell saves as commented jupytext", () => {
  it("adds a markdown cell, saves, and the body is `# `-prefixed", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    const before = nb.cellCount;

    const md = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Markup,
      "Hello **world**\n\nsecond line",
      "markdown",
    );
    const we = new vscode.WorkspaceEdit();
    we.set(nb.uri, [vscode.NotebookEdit.insertCells(nb.cellCount, [md])]);
    assert.ok(await vscode.workspace.applyEdit(we), "markdown cell inserted");
    await waitFor(() => nb.cellCount === before + 1, 5000, "cell added");

    await vscode.workspace.save(nb.uri);
    const onDisk = readFileSync(uri.fsPath).toString("latin1");
    console.log(`[ADDMD] disk tail=${JSON.stringify(onDisk.slice(-80))}`);

    assert.ok(onDisk.includes("# %% [markdown]"), "markdown marker written");
    assert.ok(onDisk.includes("# Hello **world**"), "first body line is `# `-commented");
    assert.ok(onDisk.includes("# second line"), "later body line is `# `-commented");
    // The empty line between paragraphs becomes a bare `#`.
    assert.ok(/\n#\n/.test(onDisk), "blank markdown line is a bare `#`");
    // No bare (uncommented) prose line for the markdown content.
    assert.ok(!/\nHello \*\*world\*\*/.test(onDisk), "no uncommented prose leaked to disk");

    const cells = parse(onDisk).cells;
    const mdCell = cells[cells.length - 1];
    console.log(`[ADDMD] FINDING: lastCellKind=${mdCell.kind} commented=${onDisk.includes("# Hello")} -> ${mdCell.kind === "markdown" && onDisk.includes("# Hello") ? "OK (jupytext-standard)" : "BUG"}`);
    assert.strictEqual(mdCell.kind, "markdown", "reparses to a markdown cell");
    assert.strictEqual(uncommentMarkdown(cellSource(mdCell)), "Hello **world**\n\nsecond line\n", "display text round-trips");
  });
});
