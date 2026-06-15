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

describe("Tithon rich outputs in a real VSCode host (v28)", () => {
  it("renders matplotlib PNG + tqdm, and restores the widget final-state text", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 3, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    const mplIdx = 0, tqdmIdx = 1, nbIdx = 2;

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
    await vscode.commands.executeCommand("tithon.restoreOutputs");
    await waitFor(() => streamText(nb.cellAt(nbIdx)).includes("100%"), 20000,
      "tqdm.notebook widget text to reconstruct the final bar");
    const nbText = streamText(nb.cellAt(nbIdx));
    assert.ok(nbText.includes("100%") && nbText.includes("5/5"),
      `widget fallback should show the final bar, got: ${JSON.stringify(nbText)}`);
    console.log(`[v28] tqdm.notebook fallback: ${JSON.stringify(nbText.trim())}`);

    // matplotlib image survives the restore (rendered from the artifact store too).
    assert.ok(imageBytes(nb.cellAt(mplIdx)) !== undefined, "image still present after restore");

    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  });
});
