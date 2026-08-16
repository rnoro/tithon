/**
 * trainsync — does a training-loop cell render its three output channels IN SYNC
 * while it runs?
 *
 * The shape is `scripts/baseline.py` cell 37 reduced to its protocol essence (no
 * torch, no dataset): three `tqdm.notebook` bars, an `ipywidgets.Output`
 * repainted every step with a matplotlib figure, and a `\r` `print` — verified
 * against the user's real journal to emit the same per-step message sequence
 * (comm update -> stream -> comm msg_id claim -> clear_output(wait) ->
 * display_data(png) -> comm release).
 *
 * Those channels reach the screen by two INDEPENDENT paths: widget state is
 * coalesced latest-wins and postMessaged to the renderer, while stream/image
 * output is applied through chained VSCode edits. If the second path cannot keep
 * up, the bars advance while the print and the plot fall behind — the cell shows
 * three different instants of kernel time at once. This suite measures that skew
 * directly: at each sample it reads the live MODEL (fold tail + widget mirror,
 * one instant, via `tithon._liveDiag`) and the DOCUMENT, and compares the step
 * number each reports.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";

const STDOUT_MIME = "application/vnd.code.notebook.stdout";
const LOOP_CELL = 1;

interface LiveDiag {
  syncSeq: number;
  backlog: number;
  execs: Array<{
    execId: string;
    cell: number | undefined;
    status: string;
    stream: string;
    images: number;
    widgets: string[];
  }>;
}

/** The step number in `step <n>/<total>` text, or undefined. */
function stepOf(text: string | undefined): number | undefined {
  const m = /step (\d+)\/\d+/.exec(text ?? "");
  return m ? Number(m[1]) : undefined;
}

/** The step the tqdm "Training" bar reports, from its mirror text `12/40 [...]`. */
function barStep(widgets: string[]): number | undefined {
  for (const w of widgets) {
    if (!w.startsWith("Training")) continue;
    const m = /\| (\d+)\/\d+/.exec(w);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function renderedStdout(cell: vscode.NotebookCell): string | undefined {
  for (const o of cell.outputs) {
    for (const it of o.items) {
      if (it.mime === STDOUT_MIME) return Buffer.from(it.data).toString("utf8");
    }
  }
  return undefined;
}

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  ms: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
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

describe("training-loop live sync (tqdm x3 + Output-widget plot + \\r print)", function () {
  this.timeout(600_000);

  it("keeps the printed step, the plot and the bars on the same instant", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    const editor = await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount > LOOP_CELL, 30000, `>${LOOP_CELL} cells`);
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon",
      extension: ext().id,
    });

    // The editor SELECTION is what notebook.cell.execute runs; without it
    // nothing is submitted at all (addcell.test.ts documents the same trap).
    editor.selections = [new vscode.NotebookRange(0, LOOP_CELL + 1)];
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(0, LOOP_CELL + 1)],
      document: uri,
    });

    const loop = () => nb.cellAt(LOOP_CELL);
    await waitFor(
      async () => {
        const d = (await vscode.commands.executeCommand("tithon._liveDiag")) as LiveDiag | null;
        return !!d?.execs.some((e) => e.cell === LOOP_CELL && stepOf(e.stream) !== undefined);
      },
      180000,
      "loop cell to reach its first step",
    );

    // Put the loop cell's OUTPUT on screen: VSCode instantiates a renderer only
    // for a visible output, so the widget-churn assertion below is vacuous
    // otherwise (the bars would never render at all).
    editor.selections = [new vscode.NotebookRange(0, nb.cellCount)];
    await vscode.commands.executeCommand("notebook.cell.collapseCellInput");
    editor.selection = new vscode.NotebookRange(LOOP_CELL, LOOP_CELL + 1);
    editor.revealRange(
      new vscode.NotebookRange(LOOP_CELL, LOOP_CELL + 1),
      vscode.NotebookEditorRevealType.InCenter,
    );

    // Sample model vs document at the same instant, all the way through the run.
    const samples: Array<{
      t: number;
      model?: number;
      bar?: number;
      shown?: number;
      backlog: number;
      images: number;
    }> = [];
    const t0 = Date.now();
    let running = true;
    while (running && Date.now() - t0 < 300000) {
      const d = (await vscode.commands.executeCommand("tithon._liveDiag")) as LiveDiag | null;
      const e = d?.execs.find((x) => x.cell === LOOP_CELL);
      const shown = stepOf(renderedStdout(loop()));
      samples.push({
        t: Date.now() - t0,
        model: stepOf(e?.stream),
        bar: barStep(e?.widgets ?? []),
        shown,
        backlog: d?.backlog ?? 0,
        images: e?.images ?? 0,
      });
      running = e?.status === "running" || e?.status === "queued";
      await new Promise((r) => setTimeout(r, 400));
    }

    const skews = samples
      .filter((s) => s.model !== undefined && s.shown !== undefined)
      .map((s) => ({ ...s, skew: s.model! - s.shown! }));
    const maxSkew = Math.max(0, ...skews.map((s) => s.skew));
    const maxBacklog = Math.max(0, ...samples.map((s) => s.backlog));
    for (const s of skews) {
      console.log(
        `[trainsync] t=${(s.t / 1000).toFixed(1)}s model=${s.model} bar=${s.bar} shown=${s.shown}` +
          ` skew=${s.skew} backlog=${s.backlog}`,
      );
    }
    console.log(
      `[trainsync] SUMMARY maxSkew=${maxSkew} maxBacklog=${maxBacklog} samples=${skews.length}`,
    );

    // Settle: after the cell finishes, the document must converge on the model.
    await waitFor(
      async () => {
        const d = (await vscode.commands.executeCommand("tithon._liveDiag")) as LiveDiag | null;
        const e = d?.execs.find((x) => x.cell === LOOP_CELL);
        return d?.backlog === 0 && stepOf(renderedStdout(loop())) === stepOf(e?.stream);
      },
      120000,
      "document to converge on the model after the run",
    );

    const finalOutputs = loop().outputs.flatMap((o) => o.items.map((it) => it.mime));
    console.log(`[trainsync] final mimes = ${JSON.stringify(finalOutputs)}`);
    // Per-frame render cost: a repaint re-materializes EVERY output of the cell,
    // so these byte counts are what crosses the extension-host -> UI boundary on
    // each of the ~60 plot frames, and each widget view is re-instantiated.
    const bytes = loop().outputs.map((o) =>
      o.items.map((it) => `${it.mime}:${it.data.length}`).join(","),
    );
    console.log(`[trainsync] final output bytes = ${JSON.stringify(bytes)}`);
    const endDiag = (await vscode.commands.executeCommand("tithon._liveDiag")) as LiveDiag | null;
    console.log(
      `[trainsync] model at end = ${JSON.stringify(endDiag?.execs.find((x) => x.cell === LOOP_CELL))}`,
    );
    const renderLog = (await vscode.commands.executeCommand("tithon._widgetRenderLog")) as Array<{
      mode?: string;
    }>;
    const updates = (await vscode.commands.executeCommand("tithon._widgetUpdateCount")) as number;
    console.log(`[trainsync] widget renders=${renderLog.length} liveUpdatesApplied=${updates}`);

    // A live viewer must never see the print/plot more than a couple of steps
    // behind the bars. The skew is measured in STEPS, so it is independent of how
    // fast this host runs the fixture.
    assert.ok(skews.length >= 5, `too few samples to judge (${skews.length})`);
    assert.ok(
      maxSkew <= Number(process.env.TITHON_MAX_SKEW ?? "2"),
      `rendered output trailed the model by ${maxSkew} steps (backlog ${maxBacklog})`,
    );
    // The plot's clear_output repaints the cell on EVERY frame. A repaint that
    // rewrites the widget outputs tears each bar's view down and rebuilds it from
    // the mirror — three html-manager rebuilds per frame, which is what makes the
    // output path fall behind the widget path on a slower client. The bars must
    // render a handful of times, not once per frame.
    assert.ok(
      renderLog.length >= 3,
      `the bars never rendered (${renderLog.length}) — assertion would be vacuous`,
    );
    assert.ok(
      renderLog.length <= 24,
      `widget views were re-created ${renderLog.length} times for ~${samples.length} sampled frames`,
    );
    // ...and the bars must be ALIVE, not merely painted once: each of these is the
    // renderer's own confirmation that it applied a comm delta to a live model. A
    // repaint that stops rewriting the widget outputs is only correct while this
    // channel works, so the two assertions have to be made together.
    assert.ok(
      updates >= 20,
      `the renderer applied only ${updates} live widget updates — the bars are frozen`,
    );
    // The plot is the output the repaint exists for; a run that renders no image
    // would satisfy every other assertion here without exercising the path.
    assert.ok(
      finalOutputs.some((m) => m.startsWith("image/")),
      `the loop cell rendered no image: ${JSON.stringify(finalOutputs)}`,
    );
  });
});
