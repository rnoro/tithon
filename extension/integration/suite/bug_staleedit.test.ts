/**
 * REGRESSION (was BUG H8, GENUINE reconnect) — editing a cell's CODE after it ran
 * then reopening must NOT present the OLD output as a fresh successful run.
 *
 * Driver runs code A (prints ALPHA, index 0). The on-disk cell is then edited to
 * code B (prints BETA) but NOT re-run. On reopen the old ALPHA output is restored
 * onto cell 0 (its content is gone, so it maps back by index), but flagged STALE
 * (the §3.2 badge) and ended NEUTRAL — so a ✓ never implies BETA ran (ADR-047).
 */
import * as assert from "assert";
import * as vscode from "vscode";
import { writeFileSync } from "fs";
import { SessionClient } from "../../src/sessionClient";
import { computeCellHash } from "../../src/cellAttach";

const dec = new TextDecoder();
function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) for (const it of o.items)
    if (it.mime.includes("stdout") || it.mime === "text/plain") s += dec.decode(it.data);
  return s.trim();
}
function staleFlag(cell: vscode.NotebookCell): boolean {
  return cell.outputs.some((o) => (o.metadata as { tithonStale?: boolean } | undefined)?.tithonStale === true);
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
const CODE_A = 'print("ALPHA")\n';
const FILE_B = '# %%\nprint("BETA")\n';

describe("REGRESSION H8: edited cell's old output is restored flagged stale, not as ✓", () => {
  it("old output is restored onto the changed cell WITH a stale flag and neutral success", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    const driver = new SessionClient(undefined, uri.toString());
    await driver.attach(0);
    const e1 = await driver.execute(CODE_A, { uri: uri.toString(), range: { start: 0, end: 1 }, cell_hash: computeCellHash(CODE_A), index: 0 });
    await waitFor(() => driver.executions().find((e) => e.execId === e1)?.status === "done", 30000, "driver done");
    driver.close();

    // The user edits the cell's code (ALPHA -> BETA) and saves, without re-running.
    writeFileSync(uri.fsPath, FILE_B);

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
    await new Promise((r) => setTimeout(r, 4000));

    const trace = await vscode.commands.executeCommand("tithon._seedTrace");
    const t = cellText(nb.cellAt(0));
    const stale = staleFlag(nb.cellAt(0));
    const success = nb.cellAt(0).executionSummary?.success;
    const codeNow = nb.cellAt(0).document.getText().trim();
    console.log(`[H8] SEED TRACE: ${JSON.stringify(trace)}`);
    console.log(`[H8] cell code now=${JSON.stringify(codeNow)} output=${JSON.stringify(t)} staleFlag=${stale} success=${success}`);
    const showsStale = t.includes("ALPHA");
    console.log(`[H8] FINDING: stale output shown=${showsStale} for edited code (${JSON.stringify(codeNow)}); flaggedStale=${stale}, success=${success} -> ${stale && success !== true ? "marked stale + neutral (ADR-047, correct)" : "REGRESSION (old output looks freshly run)"}`);
    // ADR-047: the edited cell's old output is restored, but clearly flagged stale
    // and ended neutral (no ✓), so it can never masquerade as a fresh BETA run.
    assert.ok(showsStale, "expected the old ALPHA output to be restored onto the edited cell");
    assert.ok(stale, "the restored output must be flagged stale (tithonStale) after an edit");
    assert.notStrictEqual(success, true, "a stale restore must NOT show success ✓ (the edited code never ran)");
  });
});
