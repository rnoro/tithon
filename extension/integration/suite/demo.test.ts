/**
 * DEMO ASSET — the narrative recorded by scripts/record_demo.sh into the README
 * hero GIF: a long training run streams live, the client disconnects while the
 * detached kernel keeps going, and the reopened notebook restores the output AND
 * resumes streaming — with the execution timer still counting from the original
 * start, which is the part that proves nothing re-ran.
 *
 * It differs from livereconnect.test.ts (the same story as a pass/fail gate) in
 * that every step here is also chosen to look right in a muted, autoplaying GIF:
 * the window chrome is stripped, the fixture emits a tqdm widget plus a
 * training-log line so the frame shows rich output rather than a wall of text,
 * and each phase logs a `[demo]` marker the recorder times captions against.
 *
 * Assertions are kept as strong as the gate's: if the product does not actually
 * restore and continue, the recorder fails and no demo is written.
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

/** Highest `step N` the cell has painted, or -1. Mirrors the fixture's log line. */
function maxStep(t: string): number {
  const ns = t.split("\n")
    .map((x) => /^\s*step\s+(\d+)\s/.exec(x))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  return ns.length ? Math.max(...ns) : -1;
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

/**
 * Strip the Extension-Development-Host chrome that would otherwise dominate a
 * 900px-wide GIF: the chat/secondary bar eats a quarter of the width, and the
 * root-user and disabled-extensions toasts sit on top of the cell output. Both
 * come back on their own, so callers re-run this before each capture-worthy phase.
 */
async function tidyChrome(): Promise<void> {
  for (const cmd of ["workbench.action.closeAuxiliaryBar", "notifications.clearAll"]) {
    await vscode.commands.executeCommand(cmd).then(undefined, () => undefined);
  }
}

async function openSelect(uri: vscode.Uri): Promise<vscode.NotebookDocument> {
  const nb = await vscode.workspace.openNotebookDocument(uri);
  await vscode.window.showNotebookDocument(nb);
  await waitFor(() => nb.cellCount >= 1, 15000, "cells");
  await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
  await tidyChrome();
  return nb;
}

describe("Tithon DEMO ASSET: kernel survives the client", () => {
  it("streams, survives a disconnect, and restores + resumes on reconnect", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const cells = parse(readFileSync(uri.fsPath, "utf8")).cells;
    const loopIdx = cells.findIndex((c) => c.kind === "code" && c.body.some((l) => l.text.includes("TITHON_DEMO_LOOP")));
    assert.ok(loopIdx >= 0, "fixture needs the TITHON_DEMO_LOOP cell");
    const src = cellSource(cells[loopIdx]);

    // Submitted through a headless client, so the run is owned by the kernel and
    // not by whichever UI happens to be attached — that is the whole premise.
    const driver = new SessionClient(undefined, uri.toString());
    await driver.execute(src, {
      uri: uri.toString(), range: { start: 0, end: 0 }, cell_hash: computeCellHash(src), index: loopIdx,
    });

    // 1) LIVE — attach and watch it stream.
    let nb = await openSelect(uri);
    await waitFor(() => maxStep(cellText(nb.cellAt(loopIdx))) >= 4, 40000, "streaming before disconnect");
    // Marker first, then dwell: the recorder runs this caption from the marker
    // to the next one, so the dwell has to sit AFTER the log or the phase gets
    // no screen time.
    console.log(`[demo] streaming live before disconnect, at step ${maxStep(cellText(nb.cellAt(loopIdx)))}`);
    await new Promise((r) => setTimeout(r, 5000)); // let the bar visibly advance on camera
    const beforeDrop = maxStep(cellText(nb.cellAt(loopIdx)));

    // 2) DISCONNECT — closing every editor is what a dropped tunnel looks like
    //    from the extension host's side: the live session is torn down.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    // Marker BEFORE the settle wait: the editors are already gone from the
    // framebuffer here, and the recorder times the caption off this line.
    // VSCode can keep the NotebookDocument alive briefly after its editors
    // close, so the wait below is best-effort and must not stretch the gap.
    console.log("[demo] disconnected (notebook closed); loop still running on kernel");
    await waitFor(
      () => !vscode.workspace.notebookDocuments.some((d) => d.uri.toString() === uri.toString()),
      1500, "notebook closed").catch(() => undefined);
    // Long enough to read as "the client is gone", short enough that dead air
    // does not dominate a ~20s GIF.
    await new Promise((r) => setTimeout(r, 2000));

    // 3) RECONNECT — reopen; restore + live resume happen with no command.
    nb = await openSelect(uri);
    await waitFor(() => maxStep(cellText(nb.cellAt(loopIdx))) >= beforeDrop, 40000, "prior output restored");
    const atReconnect = maxStep(cellText(nb.cellAt(loopIdx)));
    console.log(`[demo] reconnected; restored output up to step ${atReconnect}`);

    // 4) STILL RUNNING — output advances past the reconnect point and the cell is
    //    not marked done, so the spinner and its elapsed timer keep counting from
    //    the original start. That timer is the proof nothing re-ran.
    await waitFor(() => maxStep(cellText(nb.cellAt(loopIdx))) > atReconnect + 2, 40000, "live continued");
    assert.notStrictEqual(nb.cellAt(loopIdx).executionSummary?.success, true, "cell should still be running");
    assert.ok(atReconnect >= beforeDrop, "reconnect restored at least the pre-disconnect output");
    console.log(`[demo] streaming continued after reconnect, now at step ${maxStep(cellText(nb.cellAt(loopIdx)))}`);

    // Hold for the recorder's tail, keeping the frame clean the whole time.
    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    const until = Date.now() + holdMs;
    while (Date.now() < until) {
      await tidyChrome();
      await new Promise((r) => setTimeout(r, 1500));
    }
    driver.close();
  });
});
