/**
 * v65 — REAL VSCode: the destructive-action gate. `tithon.restartKernel` and
 * `tithon.restartDaemon` must ask before touching anything, and must fail SAFE
 * when the answer is not an explicit confirm — nothing is restarted.
 *
 * This is the one suite that runs with `tithon.confirmDestructiveActions` at its
 * shipped default (`TITHON_CONFIRM_DESTRUCTIVE=1`); every other suite has the
 * gate turned off by the harness bootstrap, because the Extension Host runner
 * REFUSES to show modal dialogs at all ("DialogService: refused to show dialog
 * in tests" — the promise rejects). That refusal is what makes this test sharp:
 * the confirmation can never succeed here, so the commands are driven exactly as
 * a user who clicks Cancel drives them, and every observable must be untouched.
 * Delete the gate — or move it after the daemon call — and the kernel restarts.
 *
 * ONE command per Extension Host run (`TITHON_CONFIRM_TARGET`); v65.sh drives
 * both halves and owns the daemon-pid assertion.
 */
import * as assert from "assert";
import * as vscode from "vscode";
import { DaemonClient } from "../../src/daemonClient";

const dec = new TextDecoder();

function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) {
    for (const it of o.items) {
      if (it.mime.includes("stdout") || it.mime === "text/plain") s += dec.decode(it.data);
    }
  }
  return s;
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

/** The gate is armed by DEFAULT, not by this suite — otherwise it passes vacuously. */
function assertGateArmedByDefault(): void {
  const cfg = vscode.workspace.getConfiguration("tithon");
  assert.strictEqual(
    cfg.inspect<boolean>("confirmDestructiveActions")?.defaultValue,
    true,
    "package.json must default tithon.confirmDestructiveActions to true",
  );
  assert.strictEqual(
    cfg.get<boolean>("confirmDestructiveActions"),
    true,
    "the effective value must be true in this host",
  );
}

/**
 * The premise the whole suite rests on: in THIS host a modal confirmation cannot
 * be answered affirmatively. Asserted rather than assumed, so a future VSCode
 * that starts auto-answering dialogs turns this suite red instead of green-and-
 * meaningless. The non-modal form is checked too — only modals are refused, so
 * this also pins that the refusal is about modality, not about dialogs at large.
 */
async function assertModalsUnanswerable(): Promise<void> {
  let refused = "";
  try {
    await vscode.window.showWarningMessage("tithon-probe", { modal: true }, "Yes");
    assert.fail(
      "a modal dialog was answerable in the test host — this suite cannot prove anything",
    );
  } catch (err) {
    refused = String(err);
  }
  assert.ok(
    /refused to show dialog/i.test(refused),
    `expected the test host to refuse modal dialogs, got: ${refused}`,
  );

  // The same call WITHOUT `modal` is routed to the notification service instead
  // and is not refused — so the rejection above is evidence of modality, not of
  // a host that blocks messages wholesale. Never awaited to completion: a
  // button-less notification only settles when someone dismisses it.
  let notifyRejected: string | undefined;
  void Promise.resolve(vscode.window.showWarningMessage("tithon-probe")).then(undefined, (e) => {
    notifyRejected = String(e);
  });
  await new Promise((r) => setTimeout(r, 1000));
  assert.strictEqual(
    notifyRejected,
    undefined,
    `a non-modal message was refused too, so the refusal proves nothing: ${notifyRejected}`,
  );
}

const TARGET = process.env.TITHON_CONFIRM_TARGET ?? "kernel";

describe("Tithon destructive-action confirmation (v65)", () => {
  if (TARGET === "kernel") {
    it("an unconfirmed Restart Kernel leaves the kernel process untouched", async () => {
      const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
      await ext().activate();
      assertGateArmedByDefault();
      await assertModalsUnanswerable();

      const nb = await vscode.workspace.openNotebookDocument(uri);
      await vscode.window.showNotebookDocument(nb);
      await waitFor(() => nb.cellCount >= 1, 15000, "cells");
      await vscode.commands.executeCommand("notebook.selectKernel", {
        id: "tithon",
        extension: ext().id,
      });

      // Run cell 0 so there is a real kernel with a real namespace to lose.
      const ed = vscode.window.activeNotebookEditor;
      if (ed) ed.selections = [new vscode.NotebookRange(0, 1)];
      await vscode.commands.executeCommand("notebook.cell.execute", {
        ranges: [new vscode.NotebookRange(0, 1)],
        document: uri,
      });
      await waitFor(() => cellText(nb.cellAt(0)).includes("SET 42"), 30000, "set v");

      const daemon = new DaemonClient();
      const session = uri.toString();
      const pidOf = async (): Promise<number | null> =>
        (await daemon.listKernels()).find((k) => k.session === session)?.kernel_pid ?? null;
      const before = await pidOf();
      assert.ok(before, "no kernel pid before the restart attempt");

      // Must resolve, not reject: an unshowable dialog is a declined action, not
      // a command failure the user sees as a raw error toast.
      await vscode.commands.executeCommand("tithon.restartKernel");
      await new Promise((r) => setTimeout(r, 2000));

      // Same pid = the same Python process = the namespace the dialog promised
      // to protect is still loaded. A restart would have replaced it.
      const after = await pidOf();
      assert.strictEqual(
        after,
        before,
        `kernel restarted without a confirmation (${before} -> ${after})`,
      );

      // ...and the file's live view still works, so declining did not leave the
      // session half-torn-down.
      if (ed) ed.selections = [new vscode.NotebookRange(0, 1)];
      await vscode.commands.executeCommand("notebook.cell.execute", {
        ranges: [new vscode.NotebookRange(0, 1)],
        document: uri,
      });
      await waitFor(() => cellText(nb.cellAt(0)).includes("SET 42"), 30000, "cell still runs");
      assert.strictEqual(await pidOf(), before, "kernel changed on the follow-up run");
    });
  } else {
    it("an unconfirmed Restart Daemon leaves the daemon process untouched", async () => {
      await ext().activate();
      assertGateArmedByDefault();
      await assertModalsUnanswerable();

      // No notebook needed: the gate must come before anything else the handler
      // does. The daemon pid is asserted by v65.sh, which owns it.
      await vscode.commands.executeCommand("tithon.restartDaemon");
      await new Promise((r) => setTimeout(r, 2000));
    });
  }
});
