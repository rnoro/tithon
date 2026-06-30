/**
 * v8 — REAL VSCode integration: the extension restores the daemon's outputs into
 * a real notebook's cells, inside an actual Extension Host (xvfb + electron).
 *
 * This removes the "spike, never run in VSCode" caveat for sessionController:
 * we open the fixture .py as a `tithon-py` notebook and select the Tithon
 * controller as its kernel — which auto-restores the folded snapshot — and
 * assert the cells now carry the outputs the daemon journaled (stdout "0\n1\n2\n",
 * execute_result "42", an error with ename ValueError).
 */
import * as assert from "assert";
import * as vscode from "vscode";

const dec = new TextDecoder();

interface DecodedOutput {
  mime: string;
  text: string;
}

function decodeCell(cell: vscode.NotebookCell): DecodedOutput[] {
  const out: DecodedOutput[] = [];
  for (const o of cell.outputs) {
    for (const item of o.items) {
      out.push({ mime: item.mime, text: dec.decode(item.data) });
    }
  }
  return out;
}

async function waitFor(pred: () => boolean, ms = 30000, label = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Find the Tithon extension by its contributed restore command (publisher-agnostic). */
function findTithonExtension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.all.find((e) =>
    (e.packageJSON?.contributes?.commands ?? []).some(
      (c: { command?: string }) => c.command === "tithon.restartKernel",
    ),
  );
  if (!ext) throw new Error("Tithon extension not found in the host");
  return ext;
}

describe("Tithon restore inside a real VSCode host (v8)", () => {
  it("restores daemon outputs into the notebook cells", async () => {
    const fixture = process.env.TITHON_FIXTURE;
    assert.ok(fixture, "TITHON_FIXTURE must be set");
    const uri = vscode.Uri.file(fixture!);

    const ext = findTithonExtension();
    await ext.activate();

    // Open the percent .py as our notebook type and show it.
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 3, 15000, "notebook cells");

    // Select the Tithon controller as this notebook's kernel so the controller
    // can write cell outputs via createNotebookCellExecution().
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon",
      extension: ext.id,
    });

    // Selecting the kernel auto-attaches the daemon session and restores the
    // folded snapshot into the cells (ensureLive) — no manual restore command.

    // Wait until outputs land on at least three cells.
    await waitFor(
      () => nb.getCells().filter((c) => c.outputs.length > 0).length >= 3,
      30000,
      "restored cell outputs",
    );

    const all = nb.getCells().map(decodeCell);
    const flat = all.flat();

    // loop cell: folded stdout stream
    const hasLoop = flat.some((o) => o.text.includes("0\n1\n2\n"));
    // value cell: execute_result text/plain "42"
    const hasValue = flat.some((o) => o.text.trim() === "42");
    // boom cell: an error output carrying ValueError
    const hasError = flat.some(
      (o) => o.mime.includes("error") && o.text.includes("ValueError"),
    );

    assert.ok(hasLoop, `expected a cell with stdout "0\\n1\\n2\\n"; got ${JSON.stringify(all)}`);
    assert.ok(hasValue, `expected a cell with execute_result "42"; got ${JSON.stringify(all)}`);
    assert.ok(hasError, `expected a cell with a ValueError error; got ${JSON.stringify(all)}`);
  });
});
