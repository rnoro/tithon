/**
 * v11 — REAL VSCode "just run the cell" path, the flow a real user actually does
 * and the one that was broken: open a tithon-py notebook, select the kernel, and
 * press the native Run/play button on a cell — WITHOUT first invoking
 * tithon.startLive. Before the fix, the cell's executeHandler was a no-op (and
 * the CodeLens path closed its connection on ack), so the kernel ran but the
 * output never reached the cell and the cell stayed empty (exactly the user's
 * VSCode-tunnel report: the daemon log showed execute -> CLOSE -> output).
 *
 * After the fix, executing a cell auto-starts live sync (ensureLive) so a
 * persistent subscriber is attached before submit, and the streamed output lands
 * in the cell. This test asserts the cell shows output with no manual live step.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const dec = new TextDecoder();

function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) {
    for (const item of o.items) {
      if (item.mime.includes("stdout") || item.mime === "text/plain") s += dec.decode(item.data);
    }
  }
  return s;
}

async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function findTithonExtension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.all.find((e) =>
    (e.packageJSON?.contributes?.commands ?? []).some(
      (c: { command?: string }) => c.command === "tithon.startLive",
    ),
  );
  if (!ext) throw new Error("Tithon extension not found");
  return ext;
}

describe("Tithon native Run Cell inside a real VSCode host (v11)", () => {
  it("shows cell output from the play button WITHOUT a manual live-sync step", async () => {
    const fixture = process.env.TITHON_FIXTURE!;
    assert.ok(fixture, "TITHON_FIXTURE must be set");
    const uri = vscode.Uri.file(fixture);

    const ext = findTithonExtension();
    await ext.activate();

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "notebook cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext.id });

    // The whole point: NO `tithon.startLive` here. Just run the cell natively,
    // the way a user clicks the play button. This invokes the controller's
    // executeHandler, which must auto-start live sync.
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(0, 1)],
      document: uri,
    });

    // The cell must end up showing the printed output.
    await waitFor(() => cellText(nb.cellAt(0)).includes("Iteration 4"), 30000, "cell output to appear");

    const text = cellText(nb.cellAt(0));
    for (let i = 0; i < 5; i++) {
      assert.ok(text.includes(`Iteration ${i}`), `missing line ${i} in cell output: ${JSON.stringify(text)}`);
    }
  });
});
