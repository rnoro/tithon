/**
 * v56 — REAL VSCode: a `display_id` is SESSION-wide (RISKS #6). Cell B's
 * `update_display` must edit the output CELL A created — in place, after A has
 * already FINISHED — without resurrecting A's execution.
 *
 * The extension half is where ADR-093's CRITICAL finding lives: the redirected
 * event arrives carrying A's exec_id, so the naive path calls `ensureStarted(A)`,
 * which clears A's whole cell and opens a proxy execution no `done` will ever end
 * — cell A spins forever (the RISKS #15 class of bug, re-introduced by the fix
 * for a different one). The sink instead performs a bounded output edit: a
 * momentary execution that starts, replaces the tracked output and ends.
 *
 * The spinner guard is deliberately NOT `tithon._activeExecCells` alone: that
 * reports only the sink's tracked proxy executions and a stranded BOUNDED
 * execution would never appear there. So the test also RE-RUNS cell A afterwards
 * — VSCode refuses `createNotebookCellExecution` on a cell that already has one
 * open, so a stranded bounded execution makes the re-run render nothing and the
 * wait time out.
 */
import * as assert from "node:assert";
import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { computeCellHash } from "../../src/cellAttach";
import { cellSource, parse } from "../../src/serializer";
import { SessionClient } from "../../src/sessionClient";

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

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  ms: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 30));
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

async function activeExecCells(): Promise<number[]> {
  return ((await vscode.commands.executeCommand("tithon._activeExecCells")) as number[]) ?? [];
}

describe("Tithon cross-cell update_display inside a real VSCode host (v56)", () => {
  it("updates the creating cell's output in place after that cell finished", async () => {
    const fixture = process.env.TITHON_FIXTURE!;
    assert.ok(fixture, "TITHON_FIXTURE must be set");
    const uri = vscode.Uri.file(fixture);

    const ext = findTithonExtension();
    await ext.activate();

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 2, 15000, "notebook cells");
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon",
      extension: ext.id,
    });

    const cells = parse(readFileSync(fixture, "utf8")).cells;
    const code = cells.map((c) => cellSource(c));
    const driver = new SessionClient(undefined, uri.toString());
    const run = (idx: number) =>
      driver.execute(code[idx], {
        uri: uri.toString(),
        range: { start: 0, end: 0 },
        cell_hash: computeCellHash(code[idx]),
        index: idx,
      });

    const cellA = () => nb.cellAt(0);
    const cellB = () => nb.cellAt(1);

    // Cell A creates the display, then FINISHES — the precondition that makes
    // this the CRITICAL scenario rather than an ordinary same-cell update.
    await run(0);
    await waitFor(() => plainText(cellA()).includes("CELL_A_READY"), 30000, "cell A output");
    await waitFor(async () => !(await activeExecCells()).includes(0), 30000, "cell A to finish");
    assert.ok(plainText(cellA()).includes("v0"), "cell A should show the initial display");
    const outputsAfterA = cellA().outputs.length;

    // Cell B updates A's display from a DIFFERENT execution.
    await run(1);
    await waitFor(() => plainText(cellB()).includes("CELL_B_DONE"), 30000, "cell B output");
    // Wait for the SETTLED state, not merely for the first output to flip: the
    // sink replaces each tracked handle with its own await, so a predicate of
    // "shows v1 anywhere" passes mid-fan-out and the assertions below would read
    // a half-applied cell. If an output genuinely never updates, this times out.
    await waitFor(
      () => {
        const t = plainText(cellA());
        return !t.includes("v0") && t.split("v1").length - 1 === 2;
      },
      30000,
      "cell A to receive the update on EVERY output under the display_id",
    );

    // In place: same output count, old value gone, and B did not grow a copy.
    const aText = plainText(cellA());
    assert.strictEqual(
      cellA().outputs.length,
      outputsAfterA,
      `cell A must be edited in place, not grown; outputs ${outputsAfterA} -> ${cellA().outputs.length}`,
    );
    assert.ok(
      !aText.includes("v0"),
      `stale value must be replaced; cell A shows ${JSON.stringify(aText)}`,
    );
    // The fixture creates TWO outputs under one display_id, and both folds update
    // EVERY item carrying it — so a sink tracking a single handle would leave one
    // stale live and only agree with the daemon after a reconnect.
    assert.strictEqual(
      aText.split("v1").length - 1,
      2,
      `every output under the display_id must be updated; cell A shows ${JSON.stringify(aText)}`,
    );
    assert.ok(
      !plainText(cellB()).includes("v1"),
      `the update must not be appended to the EMITTING cell; cell B shows ${JSON.stringify(plainText(cellB()))}`,
    );

    // Settle past the bounded edit, then check no proxy execution was left open.
    await new Promise((r) => setTimeout(r, 1000));
    const active = await activeExecCells();
    assert.deepStrictEqual(
      active,
      [],
      `no cell may be left executing; active=${JSON.stringify(active)}`,
    );

    // The real phantom probe: a cell holding a stranded (bounded) execution
    // cannot start another one, so this re-run would never render.
    await run(0);
    await waitFor(
      () => plainText(cellA()).includes("v0"),
      30000,
      "cell A to re-run after the bounded edit",
    );
    await waitFor(
      async () => !(await activeExecCells()).includes(0),
      30000,
      "cell A re-run to finish",
    );
  });
});
