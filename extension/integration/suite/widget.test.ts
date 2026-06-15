/**
 * v29 — REAL VSCode ipywidget rendering (design.md §6⑤, the highest-risk item):
 * a tqdm.notebook FloatProgress is rendered by the Tithon widget renderer
 * (@jupyter-widgets/html-manager) INSIDE the notebook webview — not the text
 * fallback. Proves the renderer contribution + browser bundle + mime routing +
 * html-manager all work in a real Extension Host.
 *
 * The widget output carries the daemon mirror state (TITHON_WIDGET_MIME), so the
 * renderer instantiates the model with no round-trip; it reports back whether it
 * painted "html" vs "fallback", which we assert via the test-only command.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const WIDGET_MIME = "application/vnd.tithon.widget+json";

function outputMimes(cell: vscode.NotebookCell): string[] {
  const mimes: string[] = [];
  for (const o of cell.outputs) for (const it of o.items) mimes.push(it.mime);
  return mimes;
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

function ext(): vscode.Extension<unknown> {
  const e = vscode.extensions.all.find((x) =>
    (x.packageJSON?.contributes?.commands ?? []).some((c: { command?: string }) => c.command === "tithon.startLive"));
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

async function renderLog(): Promise<Array<{ model_id?: string; mode?: string }>> {
  return (await vscode.commands.executeCommand("tithon._widgetRenderLog")) as Array<{ mode?: string }>;
}

describe("Tithon ipywidget renderer in a real VSCode host (v29)", () => {
  it("renders a tqdm.notebook progress bar as html (not the text fallback)", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    // Run the tqdm.notebook cell so the daemon mirror captures the widget state.
    await vscode.commands.executeCommand("notebook.execute");
    await waitFor(() => nb.cellAt(0).outputs.length > 0, 30000, "cell to produce output");

    // Reconnect (fresh attach -> snapshot carries the mirror) so the widget output
    // is emitted with TITHON_WIDGET_MIME and routed to the html-manager renderer.
    await vscode.commands.executeCommand("tithon.restoreOutputs");
    await waitFor(() => outputMimes(nb.cellAt(0)).includes(WIDGET_MIME), 20000,
      "widget mime output to be emitted");
    console.log(`[v29] cell output mimes: ${outputMimes(nb.cellAt(0)).join(", ")}`);

    // The renderer ran in the webview and reported HTML (real widget, not fallback).
    await waitFor(async () => (await renderLog()).some((r) => r.mode === "html"), 25000,
      "widget renderer to paint html");
    const log = await renderLog();
    console.log(`[v29] widget renders: ${JSON.stringify(log)}`);
    assert.ok(log.some((r) => r.mode === "html"),
      `expected an html render, got: ${JSON.stringify(log)}`);
    assert.ok(!log.length || log.every((r) => r.mode !== undefined), "render outcomes recorded");

    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  });
});
