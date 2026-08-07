/**
 * trainloop — REAL VSCode run of `scripts/baseline.py` cells 0..36, where cell 36
 * (the 37th) is the training loop whose output is THREE concurrent things at once:
 *   1. three `tqdm.notebook` bars (Running Epochs / Training / Validation),
 *   2. an `ipywidgets.Output` container repainted every step with a matplotlib
 *      figure (`with plot: clear_output(wait=True); display(fig)`),
 *   3. a `print(..., end="")` carriage-return stream line.
 *
 * The user reports this cell does not render correctly. This suite drives the real
 * thing and DUMPS the resulting output model so the failure is described by data,
 * not by eyeballing the screenshot alone; shot.sh captures the pixels alongside.
 */
import * as vscode from "vscode";

const WIDGET_MIME = "application/vnd.tithon.widget+json";
const LOOP_CELL = 36; // 0-based; the 37th cell

function describeOutputs(cell: vscode.NotebookCell): string {
  if (cell.outputs.length === 0) return "(no outputs)";
  return cell.outputs
    .map((o, i) => {
      const items = o.items.map((it) => {
        const head = it.mime === WIDGET_MIME || it.mime.startsWith("text/") || it.mime.endsWith("+json")
          ? JSON.stringify(Buffer.from(it.data).toString("utf8").slice(0, 220))
          : `<${it.data.length} bytes>`;
        return `${it.mime} ${head}`;
      });
      return `  [${i}] ${items.join("\n      ")}`;
    })
    .join("\n");
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function ext(): vscode.Extension<unknown> {
  const e = vscode.extensions.all.find((x) =>
    (x.packageJSON?.contributes?.commands ?? []).some((c: { command?: string }) => c.command === "tithon.restartKernel"));
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

describe("baseline.py training loop (tqdm x3 + Output-widget plot + \\r print)", function () {
  this.timeout(1_500_000); // the setup cells load a 9348-image dataset; mocha's 90s default is far too short

  it("runs cells 0..36 and reports what the loop cell actually renders", async function () {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    const editor = await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount > LOOP_CELL, 30000, `>${LOOP_CELL} cells`);
    console.log(`[trainloop] cellCount=${nb.cellCount}`);
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    // Cells 0..36 inclusive — exactly "run up to the 37th cell". The editor's
    // SELECTION is what notebook.cell.execute actually runs; the bare `ranges`
    // arg is unreliable (addcell.test.ts documents the same trap), and without
    // the selection nothing is submitted at all (daemon stays at executions=0).
    editor.selections = [new vscode.NotebookRange(0, LOOP_CELL + 1)];
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(0, LOOP_CELL + 1)], document: uri,
    });
    await waitFor(() => nb.getCells().some((c) => c.outputs.length > 0), 120000,
      "SOMETHING to execute (guards the selection trap)");

    // Keep the loop cell on screen so the screenshot captures IT, not the header.
    const reveal = () => {
      editor.selection = new vscode.NotebookRange(LOOP_CELL, LOOP_CELL + 1);
      editor.revealRange(new vscode.NotebookRange(LOOP_CELL, LOOP_CELL + 1),
        vscode.NotebookEditorRevealType.InCenter);
    };
    const ticker = setInterval(() => {
      const done = nb.getCells().filter((c) => c.outputs.length > 0).length;
      console.log(`[trainloop] progress: cells-with-output=${done} loopOutputs=${nb.cellAt(LOOP_CELL).outputs.length}`);
      reveal();
    }, 15000);

    // The setup cells load a 9348-image dataset and build a DataLoader, so give
    // the loop cell generous time to even START producing output.
    const loop = () => nb.cellAt(LOOP_CELL);
    try {
      await waitFor(() => loop().outputs.length > 0, 900000, "loop cell to produce any output");
    } finally {
      clearInterval(ticker);
    }
    console.log(`[trainloop] loop cell produced its first output`);
    reveal();

    // The loop cell's SOURCE is 43 lines, so its output area sits below the fold
    // and a screenshot of the cell shows only code. Collapse every input so the
    // captured frame is the OUTPUT — which is the whole point of this run.
    editor.selections = [new vscode.NotebookRange(0, nb.cellCount)];
    await vscode.commands.executeCommand("notebook.cell.collapseCellInput");
    reveal();

    // Let the loop actually iterate so all three output kinds have a chance to appear.
    for (let i = 0; i < 9; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      reveal();
    }

    const mimes = loop().outputs.flatMap((o) => o.items.map((it) => it.mime));
    console.log(`[trainloop] loop cell output count = ${loop().outputs.length}`);
    console.log(`[trainloop] loop cell mimes = ${JSON.stringify(mimes)}`);
    console.log(`[trainloop] loop cell outputs:\n${describeOutputs(loop())}`);

    const renderLog = (await vscode.commands.executeCommand("tithon._widgetRenderLog")) as Array<{ mode?: string }>;
    console.log(`[trainloop] widget render log = ${JSON.stringify(renderLog)}`);
    const updates = (await vscode.commands.executeCommand("tithon._widgetUpdateCount")) as number;
    console.log(`[trainloop] widget updates applied = ${updates}`);

    // Diagnostic only — this suite REPORTS, it does not gate. shot.sh captures pixels.
    console.log(`[trainloop] SUMMARY widgets=${mimes.filter((m) => m === WIDGET_MIME).length}` +
      ` images=${mimes.filter((m) => m.startsWith("image/")).length}` +
      ` stream=${mimes.filter((m) => m === "application/vnd.code.notebook.stdout").length}` +
      ` errors=${mimes.filter((m) => m.startsWith("application/vnd.code.notebook.error")).length}`);

    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  });
});
