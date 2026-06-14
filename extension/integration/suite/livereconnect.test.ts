/**
 * DEMO — long training-style loop, then DISCONNECT (close the notebook, as a
 * VSCode/network drop does) while the loop keeps running on the detached kernel,
 * then RECONNECT (reopen): prior output + cell STATE/timing are restored AND
 * live streaming continues — as if never disconnected. Holds open for a
 * multi-frame screenshot (the spinner + elapsed timer + growing output are only
 * visible in pixels). Driven by verify/demo_reconnect.sh.
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
function maxLine(t: string): number {
  const ns = t.split("\n").map((x) => x.trim()).filter((x) => /^step \d+$/.test(x)).map((x) => Number(x.split(" ")[1]));
  return ns.length ? Math.max(...ns) : -1;
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
async function openSelect(uri: vscode.Uri): Promise<vscode.NotebookDocument> {
  const nb = await vscode.workspace.openNotebookDocument(uri);
  await vscode.window.showNotebookDocument(nb);
  await waitFor(() => nb.cellCount >= 1, 15000, "cells");
  await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
  return nb;
}

describe("Tithon DEMO: disconnect + reconnect keeps state & streaming", () => {
  it("restores output+state and continues streaming after a reconnect", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const cells = parse(readFileSync(uri.fsPath, "utf8")).cells;
    const loopIdx = cells.findIndex((c) => c.kind === "code" && c.body.some((l) => l.text.includes("range(120)")));
    assert.ok(loopIdx >= 0, "fixture needs the range(120) loop");
    const src = cellSource(cells[loopIdx]);

    // Long loop runs on this file's kernel, independent of any UI.
    const driver = new SessionClient(undefined, uri.toString());
    await driver.execute(src, {
      uri: uri.toString(), range: { start: 0, end: 0 }, cell_hash: computeCellHash(src), index: loopIdx,
    });

    // 1) Connect: open + select kernel -> auto live. Watch it stream a bit.
    let nb = await openSelect(uri);
    await waitFor(() => maxLine(cellText(nb.cellAt(loopIdx))) >= 3, 30000, "streaming before disconnect");
    const beforeDrop = maxLine(cellText(nb.cellAt(loopIdx)));
    console.log(`[demo] streaming live before disconnect, at step ${beforeDrop}`);

    // 2) DISCONNECT: close the notebook (VSCode/network drop). The live session
    //    is torn down; the loop keeps running on the detached kernel.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(
      () => !vscode.workspace.notebookDocuments.some((d) => d.uri.toString() === uri.toString()),
      8000, "notebook closed").catch(() => undefined);
    console.log("[demo] disconnected (notebook closed); loop still running on kernel");
    await new Promise((r) => setTimeout(r, 5000)); // stay disconnected ~5s

    // 3) RECONNECT: reopen + select kernel. Auto restore + live, no command.
    nb = await openSelect(uri);
    await waitFor(() => maxLine(cellText(nb.cellAt(loopIdx))) >= beforeDrop, 30000, "prior output restored on reconnect");
    const atReconnect = maxLine(cellText(nb.cellAt(loopIdx)));
    console.log(`[demo] reconnected; restored output up to step ${atReconnect}`);

    // 4) Streaming CONTINUES past the reconnect point, and the cell is still
    //    running (not marked done) — i.e. the spinner + timer keep going.
    await waitFor(() => maxLine(cellText(nb.cellAt(loopIdx))) > atReconnect + 2, 30000, "live continued after reconnect");
    assert.notStrictEqual(nb.cellAt(loopIdx).executionSummary?.success, true, "cell should still be running");
    assert.ok(atReconnect >= beforeDrop, "reconnect restored at least the pre-disconnect output");
    console.log(`[demo] streaming continued after reconnect, now at step ${maxLine(cellText(nb.cellAt(loopIdx)))}`);

    // Hold open so the screenshot harness can capture multiple frames.
    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
    driver.close();
  });
});
