/**
 * BUG HUNT H2 (GENUINE reconnect) — re-running a cell produces TWO journal
 * executions for the same cell index. On a real reopen, both are in the snapshot
 * and seed onto the same cell. Confirm the latest run wins and the stale earlier
 * run does NOT reappear (and is not duplicated).
 */
import * as assert from "assert";
import * as vscode from "vscode";
import { readFileSync } from "fs";
import { parse, cellSource } from "../../src/serializer";
import { SessionClient } from "../../src/sessionClient";
import { computeCellHash } from "../../src/cellAttach";

const dec = new TextDecoder();
function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) for (const it of o.items)
    if (it.mime.includes("stdout") || it.mime === "text/plain") s += dec.decode(it.data);
  return s.trim();
}
function count(hay: string, needle: string): number { return hay.split(needle).length - 1; }
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
describe("BUG H2: re-run + GENUINE reconnect shows only the latest run", () => {
  it("after running a cell twice and opening fresh, the cell shows VALUE 2 once", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    // Run the EXACT code the on-disk cell holds, so on reconnect the hash matches
    // (a realistic same-code reconnect, not the edited/stale path).
    const CODE = cellSource(parse(readFileSync(uri.fsPath, "utf8")).cells.filter((c) => c.kind === "code")[0]);
    const driver = new SessionClient(undefined, uri.toString());
    await driver.attach(0);
    const h = computeCellHash(CODE);
    const e1 = await driver.execute(CODE, { uri: uri.toString(), range: { start: 0, end: 2 }, cell_hash: h, index: 0 });
    const e2 = await driver.execute(CODE, { uri: uri.toString(), range: { start: 0, end: 2 }, cell_hash: h, index: 0 });
    await waitFor(() => {
      const m = new Map(driver.executions().map((e) => [e.execId, e.status]));
      return ["done", "error"].includes(m.get(e1) ?? "") && ["done", "error"].includes(m.get(e2) ?? "");
    }, 30000, "both runs done");
    driver.close();

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
    await new Promise((r) => setTimeout(r, 4000));

    const trace = await vscode.commands.executeCommand("tithon._seedTrace");
    const t = cellText(nb.cellAt(0));
    console.log(`[H2] SEED TRACE: ${JSON.stringify(trace)}`);
    console.log(`[H2] FINDING: restored=${JSON.stringify(t)} | 'VALUE 2' x${count(t, "VALUE 2")} | stale 'VALUE 1'=${t.includes("VALUE 1")}`);
    assert.ok(t.includes("VALUE 2"), "latest run restored");
    assert.ok(!t.includes("VALUE 1"), "stale earlier run must not reappear");
    assert.strictEqual(count(t, "VALUE 2"), 1, "latest run appears exactly once");
  });
});
