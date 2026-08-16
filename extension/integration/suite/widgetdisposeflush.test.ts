/**
 * v53 — REAL VSCode: a live-sync teardown must not let an in-flight widget-
 * update coalescing flush paint into a disposed session (RISKS #7 finding 2).
 *
 * `widgetUpdateBuf`/`widgetFlushTimer` (sessionController.ts) are GLOBAL —
 * shared across every notebook the controller has live, coalescing comm
 * deltas for ~50ms before pushing them to the renderer. `disposeLive()`
 * already tears down the notebook's `SessionClient`/`LiveOutputSync`, but
 * (before this fix) left any comm delta already sitting in that shared buffer
 * armed: the timer fires 50ms later regardless and calls
 * `widgetMessaging.postMessage()` with a stale update for a session that was
 * just torn down.
 *
 * Unlike v51 (disposeflush.test.ts), a 50ms window here is too tight for two
 * separate test-runner<->extension-host IPC round trips (poll, then a
 * SEPARATE dispose call) — the timer can fire on its own in the gap, which is
 * an artifact of driving the check from outside the process, not of the real
 * close/deselect path. `tithon._disposeLiveIfPendingWidgetFlush` closes that
 * gap by checking-and-disposing in ONE command, so nothing can slip in
 * between. The client's own websocket is closed by dispose, so no NEW widget
 * events can arrive from this session afterward; the only way
 * `widgetUpdatesApplied` could still climb post-dispose is exactly the stale
 * buffered entry this test targets.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const WIDGET_MIME = "application/vnd.tithon.widget+json";

function outputMimes(cell: vscode.NotebookCell): string[] {
  const mimes: string[] = [];
  for (const o of cell.outputs) for (const it of o.items) mimes.push(it.mime);
  return mimes;
}

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  ms: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 3));
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

const updateCount = async () =>
  (await vscode.commands.executeCommand("tithon._widgetUpdateCount")) as number;
const disposeLiveIfPendingWidgetFlush = async () =>
  (await vscode.commands.executeCommand("tithon._disposeLiveIfPendingWidgetFlush")) as {
    disposed: boolean;
    countAtDispose?: number;
  };

describe("Tithon: disposeLive() cancels a stray widget-update flush (v53, RISKS #7)", () => {
  it("a widget update pending at dispose time never reaches the renderer afterward", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon",
      extension: ext().id,
    });

    await vscode.commands.executeCommand("notebook.execute");
    await waitFor(() => outputMimes(nb.cellAt(0)).includes(WIDGET_MIME), 30000, "live widget mime");

    // Wait until the renderer has actually mounted the html-manager and
    // applied a REAL update, not just rendered the initial state — otherwise
    // the very first "pending" window races ahead of the renderer's own
    // `manager.has_model(comm_id)` registration (mounting an ipywidgets JS
    // bundle takes real wall-clock time) and any postMessage, stale or not,
    // gets silently dropped for an unrelated reason, masking this fix.
    await waitFor(async () => (await updateCount()) > 0, 20000, "at least one live update applied");

    const beforeDispose = await (async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const r = await disposeLiveIfPendingWidgetFlush();
        if (r.disposed) return r.countAtDispose!;
        await new Promise((res) => setTimeout(res, 3));
      }
      return undefined;
    })();
    assert.ok(
      beforeDispose !== undefined,
      "never observed a pending widget-flush window while the loop streamed updates",
    );

    // Several multiples of the 50ms coalescing window.
    await new Promise((r) => setTimeout(r, 500));

    const afterDispose = await updateCount();
    assert.strictEqual(
      afterDispose,
      beforeDispose,
      "a widget update pending at dispose time must not reach the renderer after disposeLive()",
    );
  });
});
