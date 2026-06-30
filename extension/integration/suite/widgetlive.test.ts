/**
 * v30 — REAL VSCode LIVE ipywidget animation (SPEC.md live path): a
 * tqdm.notebook bar renders AND animates while the cell runs, with NO reconnect.
 *
 * This is the live half of §6⑤: the client builds the widget mirror from comm
 * events (so the widget output is emitted with state during a fresh run), the
 * renderer paints it (html), and live comm-state deltas pushed over the renderer
 * channel update the model — the renderer confirms each applied update, which we
 * assert (the bar filling in real time).
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
    (x.packageJSON?.contributes?.commands ?? []).some((c: { command?: string }) => c.command === "tithon.restartKernel"));
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

const renderLog = async () =>
  (await vscode.commands.executeCommand("tithon._widgetRenderLog")) as Array<{ mode?: string }>;
const updateCount = async () =>
  (await vscode.commands.executeCommand("tithon._widgetUpdateCount")) as number;

describe("Tithon live ipywidget animation in a real VSCode host (v30)", () => {
  it("renders + animates a tqdm.notebook bar during a live run (no restore)", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    // Live run (the loop sleeps so comm updates flow over time). No restore.
    await vscode.commands.executeCommand("notebook.execute");

    // The widget is emitted WITH state DURING the live run (mirror built from comm
    // events), so it renders as a real widget — not the 0% text fallback.
    await waitFor(() => outputMimes(nb.cellAt(0)).includes(WIDGET_MIME), 30000,
      "live widget mime to be emitted (mirror built from comm events)");
    console.log(`[v30] live cell mimes: ${outputMimes(nb.cellAt(0)).join(", ")}`);
    await waitFor(async () => (await renderLog()).some((r) => r.mode === "html"), 25000,
      "widget renderer to paint html live");

    // Live animation: comm-state deltas pushed to the renderer were applied.
    await waitFor(async () => (await updateCount()) > 0, 30000, "live widget updates to be applied");
    const updates = await updateCount();
    console.log(`[v30] live widget updates applied: ${updates}`);
    assert.ok(updates > 0, "expected live comm updates to animate the widget");
    assert.ok((await renderLog()).some((r) => r.mode === "html"), "widget rendered html (not fallback)");

    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  });
});
