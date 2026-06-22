/**
 * BUG HUNT H4b (decisive, GENUINE reconnect) — does ADR-026 (two identical-code
 * cells told apart by recorded INDEX) survive a real reconnect?
 *
 * A separate driver client runs the two identical-code cells against the daemon
 * (so the kernel + journal hold both executions), THEN VSCode opens the notebook
 * for the first time and attaches — the real "reopen over the tunnel" path. We
 * also read tithon._seedTrace to see the actual exec->cell mapping.
 */
import * as assert from "assert";
import * as vscode from "vscode";
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

describe("BUG H4b: duplicate-code cell identity (ADR-026) on GENUINE reconnect", () => {
  it("two identical-code cells keep their own output when the notebook is opened fresh", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    // 1) Open the notebook (NOT yet selecting the kernel, so no attach happens) to
    //    read each cell's EXACT getText() — the same bytes the daemon hashes when
    //    the user actually runs each cell. Seeding the driver with each cell's own
    //    code+hash+index faithfully reconstructs "two same-source cells were run",
    //    so the genuine reconnect exercises the per-index identity (ADR-026) with
    //    real hashes (no guessed-hash skew from the serializer's trailing newline).
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 2, 15000, "cells");
    const code0 = nb.cellAt(0).document.getText();
    const code1 = nb.cellAt(1).document.getText();

    const driver = new SessionClient(undefined, uri.toString());
    await driver.attach(0);
    const e1 = await driver.execute(code0, { uri: uri.toString(), range: { start: 0, end: 2 }, cell_hash: computeCellHash(code0), index: 0 });
    const e2 = await driver.execute(code1, { uri: uri.toString(), range: { start: 3, end: 5 }, cell_hash: computeCellHash(code1), index: 1 });
    await waitFor(() => {
      const m = new Map(driver.executions().map((e) => [e.execId, e.status]));
      return ["done", "error"].includes(m.get(e1) ?? "") && ["done", "error"].includes(m.get(e2) ?? "");
    }, 30000, "both driver execs done");
    console.log(`[H4b] seeded e1=${e1}(RUN ${JSON.stringify(cellOut(driver, e1))}) e2=${e2}(RUN ${JSON.stringify(cellOut(driver, e2))})`);
    driver.close();

    // 2) Now select the kernel -> startLive attach(0) = the genuine reconnect.
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
    // Ensure live/seed actually ran (auto path is kernel-selection driven).
    await vscode.commands.executeCommand("tithon.startLive");
    await new Promise((r) => setTimeout(r, 4000));

    const trace = (await vscode.commands.executeCommand("tithon._seedTrace")) as Array<{ staleMap?: boolean }>;
    const c0 = cellText(nb.cellAt(0));
    const c1 = cellText(nb.cellAt(1));
    console.log(`[H4b] SEED TRACE: ${JSON.stringify(trace)}`);
    console.log(`[H4b] AFTER RECONNECT: cell0=${JSON.stringify(c0)} cell1=${JSON.stringify(c1)}`);
    // Same code on disk and executed -> the strong index+hash match (not stale).
    assert.ok(!trace.some((t) => t.staleMap), "identical on-disk code must map via the strong (non-stale) path");
    const honored = c0.includes("RUN 1") && c1.includes("RUN 2");
    const collapsed = c1 === "" && c0.includes("RUN 2");
    console.log(`[H4b] FINDING: ${honored ? "index HONORED on reconnect (ADR-026 holds)" : collapsed ? "COLLAPSED onto cell 0 — ADR-026 duplicate-cell bug REAPPEARS on reconnect (cell 1 lost its output)" : "OTHER"}`);
    assert.ok(honored, `duplicate-code cells must keep their own output after reconnect (cell0=${JSON.stringify(c0)}, cell1=${JSON.stringify(c1)})`);
  });
});

function cellOut(c: SessionClient, id: string): string {
  const o = c.outputsOf(id)[0] as { text?: string } | undefined;
  return (o?.text ?? "").trim();
}
