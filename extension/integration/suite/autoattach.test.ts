/**
 * v80 — REAL VSCode: a fresh window (no saved kernel affinity) attaches a notebook
 * whose file already has a daemon session, with NO kernel selection and NO
 * tithon.* command (#32). The runner's per-run user-data-dir is exactly the
 * "fresh browser profile" case: VS Code shows the sole Tithon controller as
 * current but never fires onDidChangeSelectedNotebooks.
 *
 * Also asserts the gate: opening a file that was never run must not create a
 * daemon session (which would spawn a kernel).
 */
import * as assert from "node:assert";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { computeCellHash } from "../../src/cellAttach";
import { DaemonClient } from "../../src/daemonClient";
import { cellSource, parse } from "../../src/serializer";
import { SessionClient } from "../../src/sessionClient";

const dec = new TextDecoder();
function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs)
    for (const it of o.items)
      if (it.mime.includes("stdout") || it.mime === "text/plain") s += dec.decode(it.data);
  return s;
}
function lines(t: string): number[] {
  return t
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => /^\d+$/.test(x))
    .map(Number);
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
    (x.packageJSON?.contributes?.commands ?? []).some(
      (c: { command?: string }) => c.command === "tithon.restartKernel",
    ),
  );
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

describe("Tithon auto-attach without kernel selection (v80)", () => {
  it("attaches a file with an existing session, and leaves a never-run file alone", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    const fresh = vscode.Uri.file(path.join(path.dirname(uri.fsPath), "fresh.py"));
    await ext().activate();

    const cells = parse(readFileSync(uri.fsPath, "utf8")).cells;
    const loopIdx = cells.findIndex(
      (c) => c.kind === "code" && c.body.some((l) => l.text.includes("range(40)")),
    );
    assert.ok(loopIdx >= 0, "fixture needs the range(40) loop");
    const src = cellSource(cells[loopIdx]);
    const driver = new SessionClient(undefined, uri.toString());
    await driver.execute(src, {
      uri: uri.toString(),
      range: { start: 0, end: 0 },
      cell_hash: computeCellHash(src),
      index: loopIdx,
    });
    const w = new SessionClient(undefined, uri.toString());
    await w.attach(0);
    const driverOut = () => {
      const ex = w.executions().find((e) => e.cellHash === computeCellHash(src));
      return ex ? ((w.outputsOf(ex.execId)[0] as any)?.text ?? "") : "";
    };
    await waitFor(() => lines(driverOut()).length >= 4, 20000, "loop produced >=4 lines");
    w.close();

    // Open + show only. No notebook.selectKernel, no tithon.* command.
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await waitFor(
      () => lines(cellText(nb.cellAt(loopIdx))).length >= 4,
      20000,
      "auto-attached and restored prior output without kernel selection",
    );
    const restoredMax = Math.max(...lines(cellText(nb.cellAt(loopIdx))));
    await waitFor(
      () => Math.max(...lines(cellText(nb.cellAt(loopIdx))), -1) > restoredMax,
      25000,
      "live output continued after auto-attach",
    );

    // The gate: a never-run file gets no session (and so no kernel).
    const freshNb = await vscode.workspace.openNotebookDocument(fresh);
    await vscode.window.showNotebookDocument(freshNb);
    await waitFor(() => freshNb.cellCount >= 1, 15000, "fresh cells");
    await new Promise((r) => setTimeout(r, 4000)); // give a wrong attach time to land
    const sessions = (await new DaemonClient().listKernels()).map((k) => k.session);
    assert.ok(sessions.includes(uri.toString()), `known session missing: ${sessions}`);
    assert.ok(
      !sessions.includes(fresh.toString()),
      `opening a never-run file created a session: ${sessions}`,
    );
    driver.close();
  });
});
