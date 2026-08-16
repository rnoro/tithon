/**
 * DEMO ASSET — the narrative recorded by scripts/record_demo.sh into the
 * published demo video.
 *
 * The disconnect here is REAL and nothing about it is staged: the daemon is
 * SIGKILLed out from under an OPEN notebook, which is what actually drives
 * `client.onDisconnect -> scheduleReconnect` (the same path v52 gates). What the
 * camera then records is VSCode's own reconnect notification, the extension
 * auto-respawning the daemon, and the cell recovering — so the video needs no
 * overlay claiming a disconnect happened. The frame IS the evidence.
 *
 * Killing the server rather than closing the window is also the stronger claim.
 * A closed editor only shows that the client let go; a SIGKILLed daemon shows
 * that the process owning the session died and the training run did not care,
 * because the kernel is detached (`setsid`) and re-attaches through its
 * persisted connection file.
 *
 * Assertions are kept as strong as a gate's: if the product does not actually
 * survive, restore and resume, the recorder fails and no demo is written.
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { computeCellHash } from "../../src/cellAttach";
import { cellSource, parse } from "../../src/serializer";
import { SessionClient } from "../../src/sessionClient";
import { workdirForUri } from "../../src/sessionController";

const dec = new TextDecoder();

function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs)
    for (const it of o.items)
      if (it.mime.includes("stdout") || it.mime === "text/plain") s += dec.decode(it.data);
  return s;
}

/** Highest `step N` the cell has painted, or -1. Mirrors the fixture's log line. */
function maxStep(t: string): number {
  const ns = t
    .split("\n")
    .map((x) => /^\s*step\s+(\d+)\s/.exec(x))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  return ns.length ? Math.max(...ns) : -1;
}

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  ms: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
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

const daemonPid = (): number | null => {
  try {
    const p = fs.readFileSync(path.join(process.env.TITHON_HOME!, "daemon.pid"), "utf8").trim();
    return p ? Number(p) : null;
  } catch {
    return null;
  }
};

/**
 * The controller's own bookkeeping for the reconnect notification. The extension
 * API cannot query the notification surface, and this flag is set on the exact
 * `withProgress` call that creates it, so it is a faithful proxy for "the user
 * can see Tithon reconnecting" (see reconnectprogress.test.ts for the full
 * argument).
 */
const progressActive = async (): Promise<boolean> =>
  ((await vscode.commands.executeCommand("tithon._reconnectProgressActive")) as boolean) ?? false;

/**
 * Strip chrome that would otherwise dominate the frame. The Explorer and the
 * activity bar cost a quarter of the width to show one filename the tab already
 * names; the toasts sit on top of the cell output. Settings handle the activity
 * bar, but the side bar and notifications need commands, and both come back on
 * their own — so this runs again before every capture-worthy phase.
 */
async function tidyChrome(): Promise<void> {
  for (const cmd of [
    "workbench.action.closeSidebar",
    "workbench.action.closeAuxiliaryBar",
    "notifications.clearAll",
  ]) {
    await vscode.commands.executeCommand(cmd).then(undefined, () => undefined);
  }
}

describe("Tithon DEMO ASSET: the daemon dies, the training run does not", () => {
  // The default 90s in suite/index.ts is a gate's budget; this one deliberately
  // sits through a real daemon death, a respawn and a reconnect backoff.
  it("survives a real SIGKILL, restores and resumes with the timer intact", async function () {
    this.timeout(300000);
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    // Without an interpreter the extension cannot respawn the daemon it is about
    // to lose, and the demo would end at the disconnect.
    await vscode.workspace
      .getConfiguration("tithon")
      .update("pythonPath", process.env.TITHON_PYTHON!, vscode.ConfigurationTarget.Global);

    const cells = parse(readFileSync(uri.fsPath, "utf8")).cells;
    const loopIdx = cells.findIndex(
      (c) => c.kind === "code" && c.body.some((l) => l.text.includes("TITHON_DEMO_LOOP")),
    );
    assert.ok(loopIdx >= 0, "fixture needs the TITHON_DEMO_LOOP cell");
    const src = cellSource(cells[loopIdx]);

    // Submitted through a headless client, so the run is owned by the kernel and
    // not by whichever UI happens to be attached — that is the whole premise.
    // The workdir hint MUST match what the UI path sends. It selects the session's
    // on-disk dir (`sessions/<project>-<hash8>/<relpath>` with a hint, a bare
    // digest without), and that dir is where the kernel's connection file lives.
    // Seed the session from a hintless client and the respawned daemon resolves
    // the same notebook to a DIFFERENT dir, finds no connection file, and starts
    // a second kernel — orphaning the run this demo is about.
    const driver = new SessionClient(undefined, uri.toString(), workdirForUri(uri));
    const execId = await driver.execute(src, {
      uri: uri.toString(),
      range: { start: 0, end: 0 },
      cell_hash: computeCellHash(src),
      index: loopIdx,
    });

    // 1) LIVE — attach and watch it stream.
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon",
      extension: ext().id,
    });
    await tidyChrome();
    await waitFor(
      () => maxStep(cellText(nb.cellAt(loopIdx))) >= 4,
      40000,
      "streaming before the kill",
    );
    assert.strictEqual(await progressActive(), false, "no reconnect notification while healthy");
    const beforeObserver = new SessionClient(undefined, uri.toString(), workdirForUri(uri));
    await beforeObserver.attach(0);
    const kernelPidBefore = beforeObserver.kernelInfo()?.pid;
    const startedAtBefore = beforeObserver.executions().find((e) => e.execId === execId)?.startedAt;
    assert.ok(kernelPidBefore, "the live execution must expose its kernel pid");
    assert.ok(startedAtBefore, "the live execution must expose its original start time");
    beforeObserver.close();
    console.log(`[demo] streaming live, at step ${maxStep(cellText(nb.cellAt(loopIdx)))}`);
    await new Promise((r) => setTimeout(r, 5000)); // dwell on camera

    // A probe run stops here and just holds, so an experiment can interrupt the
    // connection its own way without this suite also killing the daemon.
    if (process.env.TITHON_DEMO_PROBE_STOP) {
      const until = Date.now() + Number(process.env.TITHON_HOLD_MS ?? "0");
      while (Date.now() < until) {
        await tidyChrome();
        await new Promise((r) => setTimeout(r, 1500));
      }
      driver.close();
      return;
    }

    // 2) SIGKILL — the real thing, notebook left open.
    const pidBefore = daemonPid();
    assert.ok(pidBefore, "daemon.pid must exist before the kill");
    const beforeKill = maxStep(cellText(nb.cellAt(loopIdx)));
    process.kill(pidBefore!, "SIGKILL");
    const killedAt = Date.now();
    console.log(`[demo] daemon SIGKILLed (pid ${pidBefore}); notebook still open`);

    // 3) VSCode shows its own reconnect notification — the camera records the
    //    product's real failure UI, so the video needs no caption to assert it.
    await waitFor(progressActive, 25000, "reconnect notification to appear");
    console.log("[demo] reconnecting — VSCode is showing Tithon's progress notification");

    // 4) The extension auto-starts a fresh daemon, which re-attaches the SAME
    //    detached kernel through its persisted connection file.
    await waitFor(
      () => {
        const p = daemonPid();
        return p !== null && p !== pidBefore;
      },
      60000,
      "daemon to auto-respawn with a new pid",
    );
    const newPid = daemonPid();

    // 5) Wait on the OUTCOME, not on the notification's bookkeeping flag. The
    //    retry loop backs off 1s,2s,4s…30s, so when the toast happens to clear
    //    is a property of the backoff schedule; that output advances past where
    //    the kill left it is the actual claim, and it can only happen if the new
    //    daemon re-attached the still-running kernel.
    // Poll out loud: if the run does NOT resume, the trace of what the cell was
    // showing while we waited is the whole diagnosis.
    const resumeDeadline = Date.now() + 150000;
    let last = -2;
    for (;;) {
      const now = maxStep(cellText(nb.cellAt(loopIdx)));
      if (now !== last) {
        console.log(
          `[demo:trace] +${Math.round((Date.now() - killedAt) / 1000)}s cell shows step ${now} (pre-kill ${beforeKill})`,
        );
        last = now;
      }
      if (now > beforeKill + 2) break;
      if (Date.now() > resumeDeadline)
        throw new Error(
          `timed out: streaming did not resume past the kill (stuck at ${now}, pre-kill ${beforeKill})`,
        );
      await new Promise((r) => setTimeout(r, 1000));
    }
    await tidyChrome();
    const atRecover = maxStep(cellText(nb.cellAt(loopIdx)));
    const afterObserver = new SessionClient(undefined, uri.toString(), workdirForUri(uri));
    await afterObserver.attach(0);
    const recovered = afterObserver.executions().find((e) => e.execId === execId);
    assert.ok(recovered, "the original execution id must survive the daemon kill");
    assert.strictEqual(
      afterObserver.kernelInfo()?.pid,
      kernelPidBefore,
      "the detached kernel pid must be unchanged",
    );
    assert.strictEqual(
      recovered.startedAt,
      startedAtBefore,
      "the original execution timer must be unchanged",
    );
    afterObserver.close();
    console.log(
      `[demo] reconnected to a new daemon (pid ${newPid}); streaming again at step ${atRecover}`,
    );
    assert.notStrictEqual(
      nb.cellAt(loopIdx).executionSummary?.success,
      true,
      "cell should still be running",
    );
    assert.ok(atRecover > beforeKill, "the run advanced across the kill");
    await new Promise((r) => setTimeout(r, 3000)); // dwell so the recovery is on camera
    const afterRecover = maxStep(cellText(nb.cellAt(loopIdx)));
    assert.ok(
      afterRecover > atRecover,
      "live synchronization must keep advancing after the recovered snapshot",
    );
    console.log(`[demo] streaming continued past the kill, now at step ${afterRecover}`);

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
