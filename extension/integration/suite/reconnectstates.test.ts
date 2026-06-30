/**
 * v16 — REAL VSCode mid-run reconnect must restore CELL EXECUTION STATE, not just
 * output: a completed cell (✓ + output), a running cell (spinner + partial
 * output), and a queued cell (pending clock, waiting behind the running one).
 * The daemon serializes executions FIFO, so submitting A,B,C gives exactly:
 * A done, B running, C queued. We reconnect during that window. State indicators
 * (spinner/clock/check) are only visible in the rendered UI, so this test logs
 * what the API can see and HOLDS the window open for a screenshot.
 */
import * as assert from "assert";
import * as vscode from "vscode";
import { readFileSync } from "fs";
import { parse, cellSource } from "../../src/serializer";
import { SessionClient } from "../../src/sessionClient";
import { computeCellHash } from "../../src/cellAttach";

const dec = new TextDecoder();
function cellText(c: vscode.NotebookCell): string {
  let s = "";
  for (const o of c.outputs) for (const it of o.items)
    if (it.mime.includes("stdout") || it.mime === "text/plain") s += dec.decode(it.data);
  return s;
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

describe("Tithon reconnect restores cell execution STATE (v16)", () => {
  it("done / running / queued cells are all restored", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const cells = parse(readFileSync(uri.fsPath, "utf8")).cells;
    const code = (kw: string) => {
      const i = cells.findIndex((c) => c.kind === "code" && c.body.some((l) => l.text.includes(kw)));
      assert.ok(i >= 0, `fixture missing ${kw}`);
      return { i, src: cellSource(cells[i]) };
    };
    const A = code("DONE_CELL"), B = code("range(40)"), C = code("QUEUED_CELL");

    // Submit A, B, C in order — daemon FIFO => A runs, B runs, C waits.
    const driver = new SessionClient(undefined, uri.toString());
    for (const x of [A, B, C]) {
      await driver.execute(x.src, { uri: uri.toString(), range: { start: 0, end: 0 }, cell_hash: computeCellHash(x.src), index: x.i });
    }

    // Wait for the A-done / B-running / C-queued window via a watcher client.
    const w = new SessionClient(undefined, uri.toString()); await w.attach(0);
    const status = (src: string) => w.executions().find((e) => e.cellHash === computeCellHash(src))?.status;
    const outOf = (src: string) => {
      const ex = w.executions().find((e) => e.cellHash === computeCellHash(src));
      return ex ? ((w.outputsOf(ex.execId)[0] as any)?.text ?? "") : "";
    };
    await waitFor(() => status(A.src) === "done" && status(B.src) === "running" && /(^|\n)3(\n|$)/.test(outOf(B.src)),
      30000, "A done, B running (>=3 lines), C queued");
    console.log(`[v16] pre-reconnect: A=${status(A.src)} B=${status(B.src)} C=${status(C.src)}`);
    assert.strictEqual(status(C.src), "queued", "C should be queued behind B");
    w.close();

    // Reconnect.
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 3, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    // Give the UI a moment to paint the restored states.
    await new Promise((r) => setTimeout(r, 1500));
    const summ = (i: number) => JSON.stringify(nb.cellAt(i).executionSummary ?? null);
    console.log(`[v16] after reconnect: A.out=${JSON.stringify(cellText(nb.cellAt(A.i)))} A.summary=${summ(A.i)}`);
    console.log(`[v16] B.out=${JSON.stringify(cellText(nb.cellAt(B.i)).split("\n").filter(Boolean).slice(-3).join(","))} B.summary=${summ(B.i)}`);
    console.log(`[v16] C.out=${JSON.stringify(cellText(nb.cellAt(C.i)))} C.summary=${summ(C.i)}`);

    // Stable-API assertions for STATE + TIMING:
    //  A (done): output restored + a completed executionSummary with real timing.
    assert.ok(cellText(nb.cellAt(A.i)).includes("DONE_CELL"), "A (done) output restored");
    const aSummary = nb.cellAt(A.i).executionSummary;
    assert.strictEqual(aSummary?.success, true, "A shows completed (success) state");
    assert.ok(
      aSummary?.timing !== undefined && aSummary.timing.endTime > aSummary.timing.startTime,
      "A carries real start/end timing (duration)",
    );
    //  B (running): partial output, NOT yet completed.
    assert.ok(/\d/.test(cellText(nb.cellAt(B.i))), "B (running) partial output restored");
    assert.notStrictEqual(nb.cellAt(B.i).executionSummary?.success, true, "B is still running, not done");
    //  C (queued): no output yet (the pending clock is screenshot-verified).
    assert.strictEqual(cellText(nb.cellAt(C.i)).trim(), "", "C (queued) has no output yet");

    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
    driver.close();
  });
});
