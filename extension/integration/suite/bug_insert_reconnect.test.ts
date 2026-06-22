/**
 * REGRESSION (was BUG H4, GENUINE reconnect) — inserting a cell ABOVE
 * previously-run cells then reopening must NOT misattribute restored output.
 *
 * A driver runs FIRST (index 0) and SECOND (index 1) against the daemon while the
 * file has TWO cells. The on-disk file is then rewritten to THREE cells (a new
 * INSERTED cell at the top), as if the user inserted a cell and saved. VSCode
 * opens the file fresh: the journal still records the OLD indices (0,1), but the
 * cells are now at 1,2. With content-aware mapping (ADR-047) FIRST's output
 * follows its cell_hash to cell 1 and SECOND's to cell 2 (the inserted cell 0
 * stays empty) — index-first alone used to shift every output down by one.
 */
import * as assert from "assert";
import * as vscode from "vscode";
import { writeFileSync } from "fs";
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
async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) { if (Date.now() > deadline) throw new Error(`timed out: ${label}`); await new Promise((r) => setTimeout(r, 50)); }
}
function ext(): vscode.Extension<unknown> {
  const e = vscode.extensions.all.find((x) =>
    (x.packageJSON?.contributes?.commands ?? []).some((c: { command?: string }) => c.command === "tithon.startLive"));
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

const TWO_CELL = '# %%\nprint("FIRST", flush=True)\n\n# %%\nprint("SECOND", flush=True)\n';
const THREE_CELL = '# %%\nprint("INSERTED")\n\n' + TWO_CELL;

describe("REGRESSION H4: a top insert + reopen keeps output on the right cells", () => {
  it("after a top insert + reopen, output follows content (INSERTED empty, FIRST/SECOND correct)", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    // 1) Driver runs FIRST(idx0) and SECOND(idx1) against the 2-cell layout.
    const two = parse(TWO_CELL).cells.filter((c) => c.kind === "code");
    const firstSrc = cellSource(two[0]);
    const secondSrc = cellSource(two[1]);
    const driver = new SessionClient(undefined, uri.toString());
    await driver.attach(0);
    const e1 = await driver.execute(firstSrc, { uri: uri.toString(), range: { start: 0, end: 2 }, cell_hash: computeCellHash(firstSrc), index: 0 });
    const e2 = await driver.execute(secondSrc, { uri: uri.toString(), range: { start: 3, end: 4 }, cell_hash: computeCellHash(secondSrc), index: 1 });
    await waitFor(() => {
      const m = new Map(driver.executions().map((e) => [e.execId, e.status]));
      return ["done", "error"].includes(m.get(e1) ?? "") && ["done", "error"].includes(m.get(e2) ?? "");
    }, 30000, "driver execs done");
    driver.close();

    // 2) The user inserts a cell at the top and saves -> the file now has 3 cells.
    writeFileSync(uri.fsPath, THREE_CELL);

    // 3) Open fresh in VSCode (the reconnect) -> cells INSERTED(0) FIRST(1) SECOND(2).
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 3, 15000, "3 cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
    await vscode.commands.executeCommand("tithon.startLive");
    await new Promise((r) => setTimeout(r, 4000));

    const trace = await vscode.commands.executeCommand("tithon._seedTrace");
    const c0 = cellText(nb.cellAt(0)); // INSERTED
    const c1 = cellText(nb.cellAt(1)); // FIRST
    const c2 = cellText(nb.cellAt(2)); // SECOND
    console.log(`[H4] SEED TRACE: ${JSON.stringify(trace)}`);
    console.log(`[H4] after reopen: cell0(INSERTED)=${JSON.stringify(c0)} cell1(FIRST)=${JSON.stringify(c1)} cell2(SECOND)=${JSON.stringify(c2)}`);
    const correct = c0 === "" && c1.includes("FIRST") && c2.includes("SECOND");
    const misattributed = c0.includes("FIRST") || c1.includes("SECOND");
    console.log(`[H4] FINDING: ${correct ? "CORRECT (output followed content/hash — ADR-047)" : misattributed ? "MISATTRIBUTED (index-first shift by one) — REGRESSION" : "OTHER"}`);
    assert.ok(correct, `output must follow content after a top insert: cell0(INSERTED)=${JSON.stringify(c0)} cell1(FIRST)=${JSON.stringify(c1)} cell2(SECOND)=${JSON.stringify(c2)}`);
  });
});
