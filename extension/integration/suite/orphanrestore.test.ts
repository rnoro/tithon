/**
 * v38 — REAL VSCode: an ORPHANED execution (one that was in-flight when the
 * daemon/kernel restarted, so no `done` will ever arrive) must restore its
 * captured output WITHOUT a perpetual spinner.
 *
 * Pre-fix, the client had no `orphaned` case in its status->state mapping, so it
 * fell through to "running" and `seedCell` started a spinner at the execution's
 * ORIGINAL start time that never ended — the user saw a cell stuck spinning with
 * a "26667s" elapsed on first open. The fix maps `orphaned` to a finished,
 * neutral (no ✓/✗) cell.
 *
 * We create a genuine orphan in-host: run a cell that prints then sleeps (so it
 * is RUNNING with output), then `tithon.restartKernel` — which calls the daemon's
 * journal.orphan_inflight() for real — and re-attaches. The cell must then show
 * its output, NOT be in the sink's open-execution set (no spinner), and not be
 * falsely marked successful; and live output must not have dirtied the notebook.
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
    await new Promise((r) => setTimeout(r, 40));
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

describe("Tithon orphaned execution restores output without a stuck spinner (v38)", () => {
  it("an orphaned cell shows its output, ends neutrally, and never spins", async () => {
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

    // Drive a cell that prints, then sleeps — so it is RUNNING with output.
    const text = readFileSync(fixture, "utf8");
    const cells = parse(text).cells;
    const cellIdx = cells.findIndex((c) => c.kind === "code");
    assert.ok(cellIdx >= 0, "fixture must have a code cell");
    const srcCode = cellSource(cells[cellIdx]);

    const driver = new SessionClient(undefined, uri.toString());
    await driver.execute(srcCode, {
      uri: uri.toString(),
      range: { start: 0, end: 0 },
      cell_hash: computeCellHash(srcCode),
      index: cellIdx,
    });

    const cell = () => nb.cellAt(cellIdx);
    await waitFor(() => plainText(cell()).includes("ORPHANME"), 30000, "running output");
    // Sanity: while running, the cell DOES have an open execution (a live spinner).
    await waitFor(async () => (await activeExecCells()).includes(cellIdx), 30000, "running spinner");

    // Restart the kernel: the daemon orphans the in-flight execution for real
    // (journal.orphan_inflight) and the extension re-attaches + re-seeds it.
    await vscode.commands.executeCommand("tithon.restartKernel");

    // Settle for the re-attach + re-seed of the now-orphaned execution.
    await new Promise((r) => setTimeout(r, 2000));

    // The captured output is still shown (restored from the journal fold).
    assert.ok(
      plainText(cell()).includes("ORPHANME"),
      `orphaned cell should still show its output; got ${JSON.stringify(plainText(cell()))}`,
    );
    // THE fix: the orphaned cell must NOT have an open execution — no perpetual
    // spinner (pre-fix it spun forever at the original start time, "26667s").
    const active = await activeExecCells();
    assert.ok(
      !active.includes(cellIdx),
      `orphaned cell ${cellIdx} must not have an open execution (stuck spinner); active=${JSON.stringify(active)}`,
    );
    // It ends neutrally — not falsely reported as a successful run.
    assert.notStrictEqual(
      cell().executionSummary?.success,
      true,
      "orphaned cell must not be shown as a successful (✓) run",
    );
    // And outputs stayed transient (no autosave storm).
    assert.strictEqual(nb.isDirty, false, "notebook must not be dirty (transientOutputs)");

    // Hold the window open for the pixel-render screenshot (scripts/shot.sh).
    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
    driver.close();
  });
});
