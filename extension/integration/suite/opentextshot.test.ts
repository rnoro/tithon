/**
 * Screenshot suite (TITHON_SUITE=opentext, driven by scripts/shot.sh): opens the
 * .py as a Tithon Cell View, then invokes "Open as Text Editor" exactly the way
 * the notebook/toolbar button does — forwarding a `{ notebookEditor: {...} }`
 * context object (NOT a Uri). The window is held open on the RESULTING plain text
 * editor so an external screenshot captures the .py as text (the user bug was
 * that this button did nothing). Proof in pixels, not just the data model.
 */
import * as assert from "assert";
import * as vscode from "vscode";

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

const textTabsFor = (uri: vscode.Uri): vscode.Tab[] =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString(),
    );

const notebookTabsFor = (uri: vscode.Uri): vscode.Tab[] =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t) =>
        t.input instanceof vscode.TabInputNotebook &&
        t.input.notebookType === "tithon-py" &&
        t.input.uri.toString() === uri.toString(),
    );

describe("Tithon Open-as-Text screenshot demo", () => {
  it("opens Cell View, then Open as Text, and holds on the text editor", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    // Open the Cell View (the working half), make it active.
    await vscode.commands.executeCommand("tithon.openAsCellView", uri);
    await waitFor(
      () => notebookTabsFor(uri).length > 0,
      15000,
      "Cell View tab opened",
    );
    const nb = vscode.workspace.notebookDocuments.find(
      (d) => d.uri.toString() === uri.toString(),
    )!;
    await waitFor(() => nb.cellCount >= 1, 15000, "notebook cells");
    await vscode.window.showNotebookDocument(nb);

    // Click "Open as Text Editor" the way the toolbar does: a context object.
    const toolbarArg = { notebookEditor: { notebookUri: nb.uri } } as unknown;
    await vscode.commands.executeCommand("tithon.openAsText", toolbarArg);

    // Switched to a plain text editor; the Cell View tab is gone.
    await waitFor(() => textTabsFor(uri).length > 0, 15000, "text editor appeared");
    await waitFor(() => notebookTabsFor(uri).length === 0, 15000, "Cell View tab closed");
    // Make sure the text editor is focused/visible for the screenshot.
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    // eslint-disable-next-line no-console
    console.log(`[shot] opentext: textTabs=${textTabsFor(uri).length} notebookTabs=${notebookTabsFor(uri).length}`);
    assert.ok(textTabsFor(uri).length > 0, "expected a text editor for the .py");
    assert.strictEqual(notebookTabsFor(uri).length, 0, "Cell View tab must be gone");

    // Hold so the external screenshot captures the rendered text editor.
    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  });
});
