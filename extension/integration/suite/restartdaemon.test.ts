/**
 * v26 — REAL VSCode: "Restart Daemon" (the action behind switching interpreter)
 * stops the daemon, KILLS the kernels, and relaunches — so cells run on a FRESH
 * kernel (new pid, reset namespace). This is what makes an interpreter change
 * actually take effect (kernels run under the daemon's Python).
 *
 * The fixture prints the kernel pid + a counter. After restart the daemon pid
 * changes AND the kernel pid changes AND the counter resets to 1 (fresh kernel,
 * not a re-attach).
 */
import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

const dec = new TextDecoder();
function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) for (const it of o.items)
    if (it.mime.includes("stdout") || it.mime === "text/plain") s += dec.decode(it.data);
  return s;
}
function kpid(t: string): number | null {
  const m = t.match(/RUN (\d+) kpid=(\d+)/);
  return m ? Number(m[2]) : null;
}
function runN(t: string): number | null {
  const m = t.match(/RUN (\d+) kpid=(\d+)/);
  return m ? Number(m[1]) : null;
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
const daemonPid = () => {
  try { return fs.readFileSync(path.join(process.env.TITHON_HOME!, "daemon.pid"), "utf8").trim(); }
  catch { return ""; }
};
async function runCell0(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("notebook.cell.execute", { ranges: [new vscode.NotebookRange(0, 1)], document: uri });
}

describe("Tithon restart daemon -> fresh kernels (v26)", () => {
  it("restarting the daemon kills kernels and runs on a fresh one", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    // The extension must be able to relaunch the daemon after shutdown; give it
    // the venv interpreter (no `tithon` on the test PATH, no Python extension).
    await vscode.workspace.getConfiguration("tithon")
      .update("pythonPath", process.env.TITHON_PYTHON!, vscode.ConfigurationTarget.Global);
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    await runCell0(uri);
    await waitFor(() => kpid(cellText(nb.cellAt(0))) !== null, 30000, "first run");
    const pid1 = daemonPid();
    const kpid1 = kpid(cellText(nb.cellAt(0)))!;
    assert.strictEqual(runN(cellText(nb.cellAt(0))), 1, "first run should be RUN 1");
    console.log(`[v26] before restart: daemon=${pid1} kernel=${kpid1}`);

    // Restart the daemon (the interpreter-switch action).
    await vscode.commands.executeCommand("tithon.restartDaemon");
    await waitFor(() => daemonPid() !== "" && daemonPid() !== pid1, 30000, "daemon pid changed");
    const pid2 = daemonPid();

    // Re-run: must be a FRESH kernel (different pid, counter reset to 1).
    await runCell0(uri);
    await waitFor(() => {
      const k = kpid(cellText(nb.cellAt(0)));
      return k !== null && k !== kpid1;
    }, 30000, "fresh kernel after restart");
    const txt = cellText(nb.cellAt(0));
    assert.strictEqual(runN(txt), 1, `namespace must reset on fresh kernel (RUN 1), got ${JSON.stringify(txt)}`);
    assert.notStrictEqual(kpid(txt), kpid1, "kernel pid must change after restart");
    console.log(`[v26] after restart: daemon=${pid2} kernel=${kpid(txt)} (reset to RUN ${runN(txt)})`);
  });
});
