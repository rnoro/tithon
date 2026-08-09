/**
 * v22 — REAL VSCode: opening a file auto-restores output AND continues live with
 * NO manual command (user feedback #3 "after a window restart nothing syncs, and
 * the restore command does nothing" + #4 "it should just work without commands").
 *
 * A separate driver starts a long loop on the file's kernel. We then open the
 * notebook and select the (remembered) Tithon kernel — but invoke NO tithon.*
 * command. Auto-open must (a) restore the lines already produced and (b) keep
 * appending new lines as the loop runs.
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
  return s;
}
function lines(t: string): number[] {
  return t.split("\n").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number);
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

describe("Tithon auto-restore + live on open, no command (v22)", () => {
  it("opening a file with a running loop shows output and keeps streaming", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate(); // registers the onDidOpenNotebookDocument auto-start

    // Driver starts the long loop on this file's kernel (independent of the UI).
    const cells = parse(readFileSync(uri.fsPath, "utf8")).cells;
    const loopIdx = cells.findIndex((c) => c.kind === "code" && c.body.some((l) => l.text.includes("range(30)")));
    assert.ok(loopIdx >= 0, "fixture needs the range(30) loop");
    const src = cellSource(cells[loopIdx]);
    const driver = new SessionClient(undefined, uri.toString());
    await driver.execute(src, {
      uri: uri.toString(), range: { start: 0, end: 0 }, cell_hash: computeCellHash(src), index: loopIdx,
    });

    // Let a few lines accumulate so there is real prior output to auto-restore.
    const w = new SessionClient(undefined, uri.toString());
    await w.attach(0);
    const driverOut = () => {
      const ex = w.executions().find((e) => e.cellHash === computeCellHash(src));
      return ex ? ((w.outputsOf(ex.execId)[0] as any)?.text ?? "") : "";
    };
    await waitFor(() => lines(driverOut()).length >= 4, 20000, "loop produced >=4 lines");
    w.close();

    // Open the notebook + select the kernel. NO tithon.* command is invoked —
    // auto-open (ensureLive) must do the restore + live continuation itself.
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    // (a) prior output restored: at least the early lines show up.
    await waitFor(() => lines(cellText(nb.cellAt(loopIdx))).length >= 4, 20000, "auto-restored prior output");
    const restoredMax = Math.max(...lines(cellText(nb.cellAt(loopIdx))));

    // (b) live continues: the cell keeps growing past what was there at open.
    await waitFor(() => Math.max(...lines(cellText(nb.cellAt(loopIdx))), -1) > restoredMax,
      25000, "live output continued after open");

    const final = lines(cellText(nb.cellAt(loopIdx)));
    assert.ok(final.length >= 5, `expected continuous output, got ${JSON.stringify(final)}`);
    driver.close();
  });
});
