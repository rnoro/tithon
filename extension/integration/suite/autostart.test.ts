/**
 * v23 — REAL VSCode: the daemon AUTO-STARTS. No daemon is running when the test
 * begins; selecting the Tithon kernel + running a cell must spawn the host daemon
 * (tithon.autoStartDaemon) and stream output — "pip install tithon, then just
 * use it". Also asserts the kernel reports its Python version (label plumbing).
 */
import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SessionClient } from "../../src/sessionClient";

const dec = new TextDecoder();
function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) for (const it of o.items)
    if (it.mime.includes("stdout") || it.mime === "text/plain") s += dec.decode(it.data);
  return s;
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

describe("Tithon daemon auto-start (v23)", () => {
  it("spawns the daemon on first use and streams output (no pre-started daemon)", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    const home = process.env.TITHON_HOME!;
    const pidFile = path.join(home, "daemon.pid");
    assert.ok(!fs.existsSync(pidFile), "precondition: daemon must NOT be running yet");

    await ext().activate();
    // Point auto-start at the venv's tithon (it isn't on the test PATH).
    await vscode.workspace.getConfiguration("tithon")
      .update("daemonCommand", process.env.TITHON_DAEMON_CMD!, vscode.ConfigurationTarget.Global);

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    // Selecting the kernel triggers ensureLive -> ensureDaemon (auto-start).
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(0, 1)], document: uri,
    });

    // Output only appears if the daemon was actually auto-started.
    await waitFor(() => cellText(nb.cellAt(0)).includes("AUTO_OK"), 40000, "auto-started daemon streamed output");
    assert.ok(fs.existsSync(pidFile), "daemon.pid should exist after auto-start");

    // Kernel reports its Python version (for the "Tithon · Python x.y" label).
    const c = new SessionClient(undefined, uri.toString());
    await c.attach(0);
    const py = c.kernelInfo()?.python ?? "";
    c.close();
    assert.ok(/^\d+\.\d+/.test(py), `kernel should report a python version, got ${JSON.stringify(py)}`);
    console.log(`[v23] daemon auto-started; kernel python = ${py}`);
  });
});
