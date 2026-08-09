/**
 * v28 — REAL VSCode rich outputs: matplotlib inline figures and tqdm render in
 * actual notebook cells (xvfb + electron), end-to-end through the play button.
 *
 *  - matplotlib: a `plt.show()` cell renders an `image/png` output item with real
 *    PNG bytes (resolved from the daemon artifact store via get_artifact), NOT a
 *    "<Figure ...>" text placeholder;
 *  - terminal tqdm: the `\r` progress stream renders and reaches 100%;
 *  - tqdm.notebook: on RESTORE (fresh attach -> snapshot), the §3.3 text fallback
 *    shows the widget's FINAL bar reconstructed from the mirror (100%, 5/5).
 */
import * as assert from "assert";
import * as vscode from "vscode";

const dec = new TextDecoder();

function streamText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) for (const it of o.items) {
    if (it.mime.includes("stdout") || it.mime.includes("stderr") || it.mime === "text/plain") {
      s += dec.decode(it.data);
    }
  }
  return s;
}

function imageBytes(cell: vscode.NotebookCell): Uint8Array | undefined {
  for (const o of cell.outputs) for (const it of o.items) {
    if (it.mime === "image/png") return it.data;
  }
  return undefined;
}

/** Count the DISTINCT cell outputs (mimebundles) whose items include `mime`.
 *  A NotebookCellOutput renders only one of its items, so an image and a stdout
 *  block must live in SEPARATE outputs to both be visible — this counts them. */
function outputsWith(cell: vscode.NotebookCell, pred: (it: vscode.NotebookCellOutputItem) => boolean): number {
  return cell.outputs.filter((o) => o.items.some(pred)).length;
}
function isImage(it: vscode.NotebookCellOutputItem): boolean {
  return it.mime === "image/png";
}
function textIncludes(it: vscode.NotebookCellOutputItem, needle: string): boolean {
  return (it.mime.includes("stdout") || it.mime.includes("stderr") || it.mime === "text/plain") &&
    dec.decode(it.data).includes(needle);
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
    (x.packageJSON?.contributes?.commands ?? []).some((c: { command?: string }) => c.command === "tithon.restartKernel"));
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

describe("Tithon rich outputs in a real VSCode host (v28)", () => {
  it("renders matplotlib PNG + tqdm, and restores the widget final-state text", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 4, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    const mplIdx = 0, tqdmIdx = 1, nbIdx = 2, comboIdx = 3;

    // Run all cells via the native play path (executeHandler -> daemon -> live).
    await vscode.commands.executeCommand("notebook.execute");

    // matplotlib: the figure renders as a real PNG image item (live path).
    await waitFor(() => imageBytes(nb.cellAt(mplIdx)) !== undefined, 45000, "matplotlib image to render");
    const png = imageBytes(nb.cellAt(mplIdx))!;
    assert.ok(png.length > 1000, `image too small (${png.length} bytes)`);
    assert.deepStrictEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], "PNG magic bytes");
    // It is the picture, not the "<Figure ...>" text repr.
    assert.ok(!streamText(nb.cellAt(mplIdx)).includes("<Figure"),
      "matplotlib cell shows the image, not the <Figure ...> text");
    console.log(`[v28] matplotlib rendered: image/png, ${png.length} bytes`);

    // terminal tqdm: the progress stream reaches 100%.
    await waitFor(() => streamText(nb.cellAt(tqdmIdx)).includes("100%"), 30000, "tqdm to reach 100%");
    console.log(`[v28] terminal tqdm reached 100%`);

    // tqdm.notebook final-state text via RESTORE (fresh attach -> snapshot has the
    // widget mirror). Wait for the cell to FINISH first so the mirror holds its
    // final state — restoring against a still-running cell captures a partial bar.
    await waitFor(() => nb.cellAt(nbIdx).executionSummary?.timing?.endTime !== undefined, 30000,
      "tqdm.notebook cell to finish");
    // The combo cell (widget + stdout + image + stdout) must finish too so restore
    // rebuilds its full folded output set.
    await waitFor(() => nb.cellAt(comboIdx).executionSummary?.timing?.endTime !== undefined, 30000,
      "combo cell to finish");
    await vscode.commands.executeCommand("tithon._restore");
    await waitFor(() => streamText(nb.cellAt(nbIdx)).includes("100%"), 20000,
      "tqdm.notebook widget text to reconstruct the final bar");
    const nbText = streamText(nb.cellAt(nbIdx));
    assert.ok(nbText.includes("100%") && nbText.includes("5/5"),
      `widget fallback should show the final bar, got: ${JSON.stringify(nbText)}`);
    console.log(`[v28] tqdm.notebook fallback: ${JSON.stringify(nbText.trim())}`);

    // matplotlib image survives the restore (rendered from the artifact store too).
    assert.ok(imageBytes(nb.cellAt(mplIdx)) !== undefined, "image still present after restore");

    // Mixed-output cell: widget + stdout + image + stdout must restore as SEPARATE
    // stacked outputs. A NotebookCellOutput renders only one of its items, so
    // flattening them into one mimebundle would show just one output (the
    // "only one output renders" bug). Assert they land in distinct outputs.
    const combo = nb.cellAt(comboIdx);
    const imgOutputs = outputsWith(combo, isImage);
    const stdoutLine = outputsWith(combo, (it) => textIncludes(it, "combo stdout line"));
    const afterPlot = outputsWith(combo, (it) => textIncludes(it, "after combo plot"));
    console.log(`[v28] combo cell after restore: ${combo.outputs.length} outputs ` +
      `(image=${imgOutputs}, "combo stdout line"=${stdoutLine}, "after combo plot"=${afterPlot})`);
    assert.ok(combo.outputs.length >= 3,
      `mixed cell must keep outputs separate, got ${combo.outputs.length} output(s): ` +
      JSON.stringify(combo.outputs.map((o) => o.items.map((it) => it.mime))));
    assert.strictEqual(imgOutputs, 1, "matplotlib image should be its own output");
    assert.ok(stdoutLine >= 1, `"combo stdout line" stdout must render (separate output)`);
    assert.ok(afterPlot >= 1, `"after combo plot" stdout must render (separate output)`);
    // The image and the trailing print must NOT share one output (the collapse bug).
    const imgAndPrintSameOutput = combo.outputs.some(
      (o) => o.items.some(isImage) && o.items.some((it) => textIncludes(it, "after combo plot")));
    assert.ok(!imgAndPrintSameOutput, "image and stdout collapsed into one mimebundle (bug)");

    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  });
});
