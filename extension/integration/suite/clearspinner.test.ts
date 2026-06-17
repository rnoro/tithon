/**
 * v37 — REAL VSCode: clearing a cell's output must NOT leave it stuck "running"
 * (a spinner that never ends), and live output must not keep the notebook
 * perpetually dirty (the autosave storm). Both are user-reported regressions.
 *
 *  - Stuck spinner: when the user clears a finished cell, the extension forwards
 *    the clear to the daemon, which broadcasts a `clear_output` tombstone back.
 *    The live sink used to handle that echo with ensureStarted() -> it spun up a
 *    fresh proxy execution (spinner) that had no matching `done`, so the cell span
 *    forever (only a window reload cleared it). The fix: a clear with no live
 *    execution must not start one. We assert the cell never appears in the sink's
 *    open-execution set (`tithon._activeExecCells`) after the clear.
 *  - Save storm: outputs live in the daemon journal, not the `.py`, so the
 *    serializer is registered with transientOutputs. We assert the notebook is
 *    NOT dirty after a cell streams output (pre-fix it stayed dirty -> autosave
 *    fired ~1/s).
 */
import * as assert from "assert";
import * as vscode from "vscode";
import { readFileSync } from "fs";
import { parse, cellSource } from "../../src/serializer";
import { SessionClient } from "../../src/sessionClient";
import { computeCellHash } from "../../src/cellAttach";

const dec = new TextDecoder();

function plainText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) {
    for (const item of o.items) {
      if (item.mime === "text/plain" || item.mime.includes("stdout")) s += dec.decode(item.data);
    }
  }
  return s;
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

function findTithonExtension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.all.find((e) =>
    (e.packageJSON?.contributes?.commands ?? []).some(
      (c: { command?: string }) => c.command === "tithon.startLive",
    ),
  );
  if (!ext) throw new Error("Tithon extension not found");
  return ext;
}

async function activeExecCells(): Promise<number[]> {
  return ((await vscode.commands.executeCommand("tithon._activeExecCells")) as number[]) ?? [];
}

describe("Tithon clear leaves no stuck spinner, no save storm (v37)", () => {
  it("a user clear does not resurrect a never-ending execution, and outputs stay transient", async () => {
    const fixture = process.env.TITHON_FIXTURE!;
    assert.ok(fixture, "TITHON_FIXTURE must be set");
    const uri = vscode.Uri.file(fixture);

    const ext = findTithonExtension();
    await ext.activate();

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "notebook cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext.id });
    await vscode.commands.executeCommand("tithon.startLive");

    // Drive one cell that prints, from a separate client (runs on the daemon).
    const text = readFileSync(fixture, "utf8");
    const cells = parse(text).cells;
    const cellIdx = cells.findIndex((c) => c.kind === "code");
    assert.ok(cellIdx >= 0, "fixture must have a code cell");
    const srcCode = cellSource(cells[cellIdx]);

    const driver = new SessionClient(undefined, uri.toString());
    const execId = await driver.execute(srcCode, {
      uri: uri.toString(),
      range: { start: 0, end: 0 },
      cell_hash: computeCellHash(srcCode),
      index: cellIdx,
    });

    const cell = () => nb.cellAt(cellIdx);
    await waitFor(() => plainText(cell()).includes("CLEARME"), 30000, "first output");
    assert.ok(cell().outputs.length > 0, "cell should have output before clearing");

    // The run's own execution must finish (leave the sink's open set) so the
    // subsequent clear is a genuine *user* clear of a finished cell.
    await waitFor(async () => !(await activeExecCells()).includes(cellIdx), 30000, "run to finish");

    // (A) transientOutputs: streaming output must not have dirtied the notebook
    //     (pre-fix the notebook stayed dirty -> autosave fired every ~1s).
    assert.strictEqual(nb.isDirty, false, "notebook must not be dirty after live output (transientOutputs)");

    // The user clears all cell outputs (native VSCode command).
    await vscode.commands.executeCommand("notebook.clearAllCellsOutputs");

    // Wait until the daemon has durably tombstoned the clear (a fresh attach folds
    // to empty) — by then the live client has also received the `clear_output`
    // echo, which is exactly when the pre-fix bug would have spun up a phantom.
    await waitFor(async () => {
      const probe = new SessionClient(undefined, uri.toString());
      await probe.attach(0);
      const empty = probe.outputsOf(execId).length === 0;
      probe.close();
      return empty;
    }, 30000, "daemon to tombstone the clear");

    // Settle past the live echo so any (buggy) resurrected execution would show.
    await new Promise((r) => setTimeout(r, 1000));

    // (B) THE stuck-spinner fix: the cleared cell must NOT be in the sink's open
    //     execution set. Pre-fix, sink.clear() ensureStarted()'d a phantom here.
    const active = await activeExecCells();
    assert.ok(
      !active.includes(cellIdx),
      `cleared cell ${cellIdx} must not have an open execution (stuck spinner); active=${JSON.stringify(active)}`,
    );

    // The output is actually gone, and the notebook is still clean.
    assert.strictEqual(cell().outputs.length, 0, "cleared cell should have no outputs");
    assert.strictEqual(nb.isDirty, false, "notebook must stay non-dirty after clear (transientOutputs)");
  });
});
