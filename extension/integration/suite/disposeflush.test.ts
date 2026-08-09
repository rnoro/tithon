/**
 * v51 — REAL VSCode: a live-sync teardown must not let an in-flight
 * `ThrottleScheduler` flush window resurrect a cell after `dispose()` has
 * already run `sink.endAll()` (RISKS #15).
 *
 * `setTimeout` firing is deterministic (not probabilistic) once a timer is
 * live, so the failure mode only requires a flush to be genuinely PENDING at
 * the instant `dispose()` runs. This test polls `tithon._hasPendingFlush` (a
 * direct read of `LiveOutputSync.hasPendingFlush()` for the active notebook)
 * while a tight loop streams output, and tears down the INSTANT it observes a
 * pending window — a direct precondition check, not a timing guess. When the
 * race lands, a stray `appendStream` call reaching the sink AFTER `endAll()`
 * calls `ensureStarted()`, which — finding no record in the now-empty
 * `execs` map — creates a BRAND NEW proxy execution and clears the cell's
 * output before appending its own delta: the cell's already-rendered "step
 * N" lines vanish, and the resurrected execution never receives a `done`
 * (the client is closed), a permanent spinner.
 *
 * `LiveOutputSync.dispose()` (liveSync.ts) cancels the scheduler
 * synchronously before `sink.endAll()` runs; `VSCodeCellSink.create()`
 * (sessionController.ts) additionally refuses to create an execution once
 * `endAll()` has fired. Teardown is driven via the `tithon._disposeLive`
 * test-only command — the exact same `disposeLive()` code path a real
 * close/deselect/restart takes — because `workbench.action.closeAllEditors`
 * does not reliably tear the notebook document down within a useful window
 * in this headless Extension Host, which would make the race untestable.
 *
 * Only the cell-content assertion is meaningful after teardown:
 * `disposeLive()` deletes the session from `liveSessions` (sessionController
 * .ts), so `tithon._activeExecCells` reads nothing for it post-dispose — it
 * cannot see a resurrection on the now-orphaned sink. A resurrected
 * execution's `ensureStarted()` always calls `clearOutput()` before
 * appending, so "the already-rendered output survives" is the direct,
 * observable symptom.
 */
import * as assert from "assert";
import * as vscode from "vscode";
import { readFileSync } from "fs";
import { parse, cellSource } from "../../src/serializer";
import { SessionClient } from "../../src/sessionClient";
import { computeCellHash } from "../../src/cellAttach";

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

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 15));
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

async function hasPendingFlush(): Promise<boolean> {
  return (await vscode.commands.executeCommand("tithon._hasPendingFlush")) as boolean;
}

describe("Tithon: dispose() cancels an in-flight flush window (v51, RISKS #15)", () => {
  it("tearing down live sync during an observed pending flush window leaves the cell's output intact", async () => {
    const fixture = process.env.TITHON_FIXTURE!;
    assert.ok(fixture, "TITHON_FIXTURE must be set");
    const uri = vscode.Uri.file(fixture);

    const ext = findTithonExtension();
    await ext.activate();

    const cells = parse(readFileSync(fixture, "utf8")).cells;
    const cellIdx = cells.findIndex((c) => c.kind === "code");
    assert.ok(cellIdx >= 0, "fixture must have a code cell");
    const srcCode = cellSource(cells[cellIdx]);

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "notebook cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext.id });

    const driver = new SessionClient(undefined, uri.toString());
    const execId = await driver.execute(srcCode, {
      uri: uri.toString(),
      range: { start: 0, end: 0 },
      cell_hash: computeCellHash(srcCode),
      index: cellIdx,
    });

    const cell = () => nb.cellAt(cellIdx);
    await waitFor(async () => (await activeExecCells()).includes(cellIdx), 15000, "run to start");
    await waitFor(() => plainText(cell()).length > 0, 15000, "some output rendered");
    const beforeDispose = plainText(cell());

    // Poll for a genuinely pending flush window (the precise precondition the
    // race needs), then dispose the instant one is observed — a direct
    // check, not an inference from a second client's event timing. A small
    // yield between checks is required: polling with NO delay floods
    // `executeCommand` IPC fast enough to make the Extension Host itself
    // unresponsive (observed directly — the run reported "Extension host is
    // unresponsive" and never caught a pending window), which would starve
    // the very event loop the race depends on.
    const pollDeadline = Date.now() + 15000;
    let caughtPending = false;
    while (Date.now() < pollDeadline) {
      if (await hasPendingFlush()) {
        caughtPending = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 3));
    }
    assert.ok(caughtPending, "never observed a pending flush window while the loop streamed output");

    // Mid-run teardown with a flush in flight — the exact scenario a real
    // close/deselect/restart produces. Exercises the SAME dispose() closure
    // sessionController.ts's startLive() returns.
    await vscode.commands.executeCommand("tithon._disposeLive");

    // Give any stray flush window(s) time to fire — several multiples of the
    // 50ms ThrottleScheduler window — before checking.
    await new Promise((r) => setTimeout(r, 500));

    // A resurrected execution's ensureStarted() -> clearOutput() would wipe
    // the cell's already-rendered output before appending its own delta.
    const afterDispose = plainText(cell());
    assert.ok(
      afterDispose.includes(beforeDispose),
      "a stray flush after teardown must not clear the cell's already-rendered output " +
        `(before=${JSON.stringify(beforeDispose)} after=${JSON.stringify(afterDispose)})`,
    );

    // Let the kernel-side loop actually finish so cleanup below is clean.
    await waitFor(async () => {
      const probe = new SessionClient(undefined, uri.toString());
      await probe.attach(0);
      const st = probe.executions().find((e) => e.execId === execId)?.status;
      probe.close();
      return st === "done";
    }, 30000, "driven execution to finish on the daemon");

    driver.close();
  });
});
