/**
 * Screenshot suite (TITHON_SUITE=autocellview, driven by scripts/shot.sh): opens
 * a percent-format `.py` the way a user does — `vscode.open` — and shows it has
 * AUTO-switched to the Tithon Cell View (no "Open as Cell View" click), runs the
 * cells so output is painted, then holds the window for an external screenshot.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const dec = new TextDecoder();
function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) for (const it of o.items)
    if (it.mime.includes("stdout") || it.mime === "text/plain") s += dec.decode(it.data);
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
      (c: { command?: string }) => c.command === "tithon.startLive",
    ),
  );
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

const notebookFor = (uri: vscode.Uri): vscode.NotebookDocument | undefined =>
  vscode.workspace.notebookDocuments.find(
    (d) => d.uri.toString() === uri.toString() && d.notebookType === "tithon-py",
  );

describe("Tithon auto-open Cell View screenshot demo", () => {
  it("opens a percent .py that auto-becomes a Cell View, runs it, holds open", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    await vscode.workspace
      .getConfiguration("tithon")
      .update("autoOpenCellView", true, vscode.ConfigurationTarget.Global);

    // Just open the file — no "Open as Cell View" command.
    await vscode.commands.executeCommand("vscode.open", uri);
    await waitFor(() => !!notebookFor(uri), 20000, "auto-opened as a Cell View");
    const nb = notebookFor(uri)!;
    await waitFor(() => nb.cellCount >= 1, 15000, "notebook cells");
    await vscode.window.showNotebookDocument(nb);

    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
    await vscode.commands.executeCommand("notebook.execute"); // Run All
    await waitFor(() => cellText(nb.cellAt(0)).includes("HELLO_AUTOCELL"), 30000, "cell ran");
    // eslint-disable-next-line no-console
    console.log(`[shot] autocellview: cells=${nb.cellCount} cell0=${JSON.stringify(cellText(nb.cellAt(0)))}`);
    assert.ok(cellText(nb.cellAt(0)).includes("HELLO_AUTOCELL"));

    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  });
});
