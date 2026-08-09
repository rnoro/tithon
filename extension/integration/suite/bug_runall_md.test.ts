/**
 * PROBE — "Run All" with an interleaved MARKDOWN cell. A notebook commonly mixes
 * markdown and code. The controller's _executeHandler submits every cell it is
 * handed as Python code (no markup filter), trusting VSCode to pass only code
 * cells. This verifies that: the markdown cell (index 1) gets NO error output
 * (its display text "# A Heading / some prose here" would raise SyntaxError if
 * submitted as code), and the two code cells run.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const dec = new TextDecoder();
function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs)
    for (const it of o.items)
      if (it.mime.includes("stdout") || it.mime === "text/plain" || it.mime.includes("error"))
        s += dec.decode(it.data);
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

describe("PROBE: Run All with an interleaved markdown cell", () => {
  it("does not submit the markdown cell as code (no SyntaxError on it)", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    const edr = await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 3, 15000, "cells");
    assert.strictEqual(nb.cellAt(1).kind, vscode.NotebookCellKind.Markup, "cell 1 is markdown");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    edr.selections = [new vscode.NotebookRange(0, nb.cellCount)];
    await vscode.commands.executeCommand("notebook.execute");

    await waitFor(() => /CELL2_RAN/.test(cellText(nb.cellAt(2))), 30000, "cell 2 ran");
    await new Promise((r) => setTimeout(r, 1500));

    const t0 = cellText(nb.cellAt(0));
    const tmd = cellText(nb.cellAt(1));
    const t2 = cellText(nb.cellAt(2));
    console.log(`[RUNALL_MD] cell0=${JSON.stringify(t0.trim())} md=${JSON.stringify(tmd.trim())} cell2=${JSON.stringify(t2.trim())}`);
    console.log(`[RUNALL_MD] FINDING: markdownHasError=${/Error|Traceback|SyntaxError/.test(tmd)} -> ${/Error|Traceback|SyntaxError/.test(tmd) ? "BUG (markdown submitted as code)" : "OK (markdown not executed)"}`);

    assert.ok(t0.includes("CELL0_RAN"), "code cell 0 ran");
    assert.ok(t2.includes("CELL2_RAN"), "code cell 2 ran");
    assert.ok(!/Error|Traceback|SyntaxError/.test(tmd), "markdown cell must NOT have an error output");
    assert.strictEqual(nb.cellAt(1).outputs.length, 0, "markdown cell must have no outputs");
  });
});
