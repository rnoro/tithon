/**
 * REGRESSION (#1 bug-hunt) — LIVE output order: a print AFTER a figure must
 * render BELOW the figure, not jump above it.
 *
 * In the live sink, image outputs are appended on an async per-cell chain (they
 * fetch artifact bytes), while stream deltas used to append synchronously — so a
 * `print` right after `display(fig)` raced ahead of the still-fetching figure and
 * rendered ABOVE it (and two prints bracketing a figure merged into one block,
 * floating the figure to the bottom). The fix routes every output op through the
 * same chain and breaks the stdout block at a non-stream output, so the cell
 * renders BEFORE_FIG, then the image, then AFTER_FIG — in source order.
 *
 * This is the matplotlib-loss-plot-plus-log-line scenario (ADR-038). The reconnect
 * path was always correct (it prefetches then renders synchronously); only the
 * live path stacked out of order.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const dec = new TextDecoder();

/** Index of the first output that carries an image/png item (−1 if none). */
function imageOutputIndex(cell: vscode.NotebookCell): number {
  return cell.outputs.findIndex((o) => o.items.some((it) => it.mime === "image/png"));
}
/** Index of the first output whose stdout text contains `needle` (−1 if none). */
function streamOutputIndex(cell: vscode.NotebookCell, needle: string): number {
  return cell.outputs.findIndex((o) =>
    o.items.some((it) => it.mime.includes("stdout") && dec.decode(it.data).includes(needle)));
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
  const edr = vscode.window.activeNotebookEditor;
  if (edr) edr.selections = [new vscode.NotebookRange(i, i + 1)];
  await vscode.commands.executeCommand("notebook.cell.execute", { ranges: [new vscode.NotebookRange(i, i + 1)], document: uri });
}

describe("REGRESSION #1: live output keeps source order (print after figure stays below)", () => {
  it("renders BEFORE_FIG, then the image, then AFTER_FIG — in order", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    await runCell(uri, 0);
    const cell = () => nb.cellAt(0);
    // Wait until both the image and the trailing print have rendered live.
    await waitFor(
      () => imageOutputIndex(cell()) >= 0 && streamOutputIndex(cell(), "AFTER_FIG") >= 0,
      45000,
      "image + AFTER_FIG to render live",
    );

    const before = streamOutputIndex(cell(), "BEFORE_FIG");
    const img = imageOutputIndex(cell());
    const after = streamOutputIndex(cell(), "AFTER_FIG");
    console.log(`[#1] order before=${before} image=${img} after=${after} (n=${cell().outputs.length})`);

    assert.ok(before >= 0, "BEFORE_FIG stdout should be present");
    assert.ok(img >= 0, "the figure image should be present");
    assert.ok(after >= 0, "AFTER_FIG stdout should be present");
    // THE fix: source order is preserved — figure below the first print, above the last.
    assert.ok(before < img, `BEFORE_FIG (${before}) must come before the image (${img})`);
    assert.ok(img < after, `the image (${img}) must come before AFTER_FIG (${after}) — pre-fix the image floated to the bottom`);
    // And the two prints are NOT merged into one block (a separate block each side of the image).
    assert.notStrictEqual(before, after, "BEFORE_FIG and AFTER_FIG must be distinct output blocks, not merged");
  });
});
