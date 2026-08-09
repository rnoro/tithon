/**
 * REGRESSION (was BUG H3) — a cell calling input()/getpass() must not deadlock
 * the session, and in the Cell View it now bridges to a VSCode input box.
 *
 * The Cell View submits with allow_stdin=true, so input() raises an input_request
 * that the daemon's stdin pump surfaces as a `tithon.input_request` event. The
 * controller presents a VSCode input box; the user's answer is sent back as an
 * input_reply, the blocked input() returns it, and the cell completes normally.
 * Cancelling instead interrupts the kernel (no bogus input). A bare text-editor
 * run (no Cell View attached) keeps allow_stdin off so input() still fails fast
 * rather than hanging (ADR-050) — covered hermetically by _check_input_bridge.py.
 *
 * Pre-bridge this either hung forever (allow_stdin=True with nobody answering) or
 * errored with StdinNotImplementedError (allow_stdin=False); now it round-trips.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const dec = new TextDecoder();
function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) for (const it of o.items)
    if (it.mime.includes("stdout") || it.mime === "text/plain" || it.mime.includes("error")) s += dec.decode(it.data);
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
async function selectCell(i: number): Promise<void> {
  const edr = vscode.window.activeNotebookEditor;
  if (edr) edr.selections = [new vscode.NotebookRange(i, i + 1)];
}
async function runCell(uri: vscode.Uri, i: number): Promise<void> {
  await selectCell(i);
  await vscode.commands.executeCommand("notebook.cell.execute", { ranges: [new vscode.NotebookRange(i, i + 1)], document: uri });
}

describe("REGRESSION H3: input() bridges to an input box and the cell continues", () => {
  it("answers input() via the input box, the cell completes, and a later cell runs", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 2, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    // Stub the input box: capture the prompt and answer it.
    const orig = vscode.window.showInputBox;
    let seenPrompt: string | undefined;
    (vscode.window as unknown as { showInputBox: unknown }).showInputBox =
      async (opts?: vscode.InputBoxOptions) => { seenPrompt = opts?.prompt; return "Ada"; };
    try {
      // (a) The input() cell bridges to the box and completes SUCCESSFULLY with
      //     the answered value bound (output "GOT Ada"), not an error or a hang.
      await runCell(uri, 0);
      await waitFor(() => nb.cellAt(0).executionSummary?.success !== undefined, 30000, "input() cell completes");
      const cell0 = cellText(nb.cellAt(0));
      console.log(`[H3] input() cell success=${nb.cellAt(0).executionSummary?.success} prompt=${JSON.stringify(seenPrompt)} output=${JSON.stringify(cell0.trim().slice(0, 120))}`);
      assert.ok(seenPrompt && /name/.test(seenPrompt), `the input box should show the cell's prompt; got ${JSON.stringify(seenPrompt)}`);
      assert.strictEqual(nb.cellAt(0).executionSummary?.success, true, "input() cell should COMPLETE via the bridge, not error/hang");
      assert.ok(/GOT Ada/.test(cell0), `the answered value should be bound; got ${JSON.stringify(cell0)}`);
    } finally {
      (vscode.window as unknown as { showInputBox: unknown }).showInputBox = orig;
    }

    // (b) A later cell runs normally — the session was never wedged.
    await runCell(uri, 1);
    await waitFor(() => cellText(nb.cellAt(1)).includes("AFTER_INPUT"), 20000, "later cell runs");
    assert.ok(cellText(nb.cellAt(1)).includes("AFTER_INPUT"), "a later cell must run after input() was answered");
  });
});
