/**
 * v52 — REAL VSCode: killing the daemon out from under an OPEN, live notebook
 * must drive a reconnect progress cycle (RISKS #8/T6) spanning the whole
 * drop-to-recovery window — not a single ~3s status-bar flash — and it must
 * resolve once the client auto-reconnects (the daemon auto-respawns, matching
 * v23's auto-start capability). Unlike v15/v16 (close+reopen) or v26
 * (`tithon.restartDaemon`, a DELIBERATE dispose+respawn), this drives the
 * `client.onDisconnect -> scheduleReconnect` path specifically: a real,
 * abrupt SIGKILL with the notebook staying open the whole time.
 *
 * `tithon._reconnectProgressActive` reads the CONTROLLER's own bookkeeping map
 * (`reconnectProgress.has(uri)`), not the VSCode notification surface itself —
 * the extension API has no way to query which notifications are currently
 * rendered. That map entry is set synchronously, immediately before the
 * `withProgress` call that creates the real notification, so its presence is
 * a faithful proxy for "a notification is showing". Its ABSENCE, though, is
 * NOT proof the notification has visually dismissed: the implementation
 * intentionally holds the notification open for ~1s/~0.7s AFTER resolving
 * (a "reconnected"/"disconnected" grace message) — this test's "cleared"
 * assertion is about the underlying STATE transition (reconnected — the
 * thing actually under test), not the notification's own fade-out timing.
 */
import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

const dec = new TextDecoder();
function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs)
    for (const it of o.items)
      if (it.mime.includes("stdout") || it.mime === "text/plain") s += dec.decode(it.data);
  return s;
}
async function waitFor(
  pred: () => boolean | Promise<boolean>,
  ms: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
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
const daemonPid = (): number | null => {
  try {
    const p = fs.readFileSync(path.join(process.env.TITHON_HOME!, "daemon.pid"), "utf8").trim();
    return p ? Number(p) : null;
  } catch {
    return null;
  }
};
async function progressActive(): Promise<boolean> {
  return (
    ((await vscode.commands.executeCommand("tithon._reconnectProgressActive")) as boolean) ?? false
  );
}

describe("Tithon: reconnect progress notification spans a real disconnect/reconnect (v52, RISKS #8/T6)", () => {
  it("shows while the daemon is down and clears once auto-reconnected", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    await vscode.workspace
      .getConfiguration("tithon")
      .update("pythonPath", process.env.TITHON_PYTHON!, vscode.ConfigurationTarget.Global);

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon",
      extension: ext().id,
    });
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(0, 1)],
      document: uri,
    });
    await waitFor(() => cellText(nb.cellAt(0)).includes("RUN 1"), 30000, "first run");
    assert.strictEqual(await progressActive(), false, "no reconnect notification while healthy");

    const pidBefore = daemonPid();
    assert.ok(pidBefore, "daemon.pid must exist before the kill");

    // Abrupt crash — NOT the graceful `tithon.restartDaemon` command — with the
    // notebook staying open the whole time. This is what actually drives
    // client.onDisconnect -> scheduleReconnect (the code path under test).
    process.kill(pidBefore!, "SIGKILL");

    await waitFor(progressActive, 20000, "reconnect progress notification to appear");
    console.log("[v52] reconnect progress notification is active after the daemon was killed");

    // The retry loop's ensureLive() auto-starts a fresh daemon (v23's
    // mechanism) once backoff lets it try again; wait for that respawn and for
    // the notification to clear.
    await waitFor(
      () => {
        const p = daemonPid();
        return p !== null && p !== pidBefore;
      },
      40000,
      "daemon to auto-respawn with a new pid",
    );
    await waitFor(
      async () => !(await progressActive()),
      15000,
      "reconnect progress notification to clear",
    );
    console.log("[v52] reconnect progress notification cleared after auto-reconnect");

    // The live view actually recovered, not just the socket — a fresh kernel
    // (daemon auto-respawn, matching v26) resets the counter, so this is
    // RUN 1 again, not RUN 2.
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(0, 1)],
      document: uri,
    });
    await waitFor(() => /RUN \d+/.test(cellText(nb.cellAt(0))), 30000, "a run after reconnect");
  });
});
