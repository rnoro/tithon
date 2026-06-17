/**
 * v36 — REAL VSCode: the "Open as Text Editor" button in the Tithon Cell View
 * toolbar must actually switch the .py from the Cell View (tithon-py notebook)
 * back to a plain TEXT editor.
 *
 * User bug: connecting from the VSCode client, "Open as Cell View" works, but in
 * the Cell View clicking "Open as Text Editor" does NOTHING. Suspected cause: the
 * ADR-041 single-representation guard (`tabGroups.onDidChangeTabs` closes any
 * TabInputText for a URI still in `cellViewUris`) races the command, and/or the
 * `notebook/toolbar` menu hands the command a non-Uri argument so the URI is
 * never dropped from `cellViewUris` and `vscode.openWith` is called on a bad
 * value — either way the text editor never appears.
 *
 * This suite drives the command both ways:
 *   (A) no argument  -> resolves via the active notebook editor (the realistic
 *       path when the toolbar passes a Uri or nothing);
 *   (B) a non-Uri object as the argument -> simulates a `notebook/toolbar` menu
 *       that forwards an editor-context object instead of a Uri.
 * Both must end with the .py shown as a TEXT editor and NO tithon-py notebook
 * left open for the URI.
 */
import * as assert from "assert";
import * as vscode from "vscode";

function ext(): vscode.Extension<unknown> {
  const e = vscode.extensions.all.find((x) =>
    (x.packageJSON?.contributes?.commands ?? []).some(
      (c: { command?: string }) => c.command === "tithon.startLive",
    ),
  );
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

async function waitFor(
  pred: () => boolean,
  ms: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const textTabsFor = (uri: vscode.Uri): vscode.Tab[] =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t) =>
        t.input instanceof vscode.TabInputText &&
        t.input.uri.toString() === uri.toString(),
    );

// Count OPEN Cell-View tabs (not workspace.notebookDocuments, which VSCode keeps
// cached after the tab closes) so "switched away from the notebook" is real.
const notebookTabsFor = (uri: vscode.Uri): vscode.Tab[] =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t) =>
        t.input instanceof vscode.TabInputNotebook &&
        t.input.notebookType === "tithon-py" &&
        t.input.uri.toString() === uri.toString(),
    );

const notebookFor = (uri: vscode.Uri): vscode.NotebookDocument | undefined =>
  vscode.workspace.notebookDocuments.find(
    (d) => d.uri.toString() === uri.toString() && d.notebookType === "tithon-py",
  );

async function openCellView(uri: vscode.Uri): Promise<vscode.NotebookDocument> {
  await vscode.commands.executeCommand("tithon.openAsCellView", uri);
  await waitFor(() => !!notebookFor(uri), 15000, "Cell View opened");
  const nb = notebookFor(uri)!;
  await waitFor(() => nb.cellCount >= 1, 15000, "notebook cells");
  // Make the notebook the active editor so the no-arg fallback resolves to it.
  await vscode.window.showNotebookDocument(nb);
  await waitFor(
    () => vscode.window.activeNotebookEditor?.notebook.uri.toString() === uri.toString(),
    15000,
    "Cell View is the active editor",
  );
  return nb;
}

async function assertSwitchedToText(uri: vscode.Uri, label: string): Promise<void> {
  // The whole point of "Open as Text": a TEXT editor for the URI appears and the
  // Cell-View tab no longer lingers (single representation per URI, ADR-041).
  await waitFor(() => textTabsFor(uri).length > 0, 15000,
    `${label}: a text editor for the .py appeared`);
  await waitFor(() => notebookTabsFor(uri).length === 0, 15000,
    `${label}: the Cell View tab closed`);
  // eslint-disable-next-line no-console
  console.log(`v36 ${label}: textTabs=${textTabsFor(uri).length} notebookTabs=${notebookTabsFor(uri).length} OK`);
  assert.ok(textTabsFor(uri).length > 0, `${label}: expected a text editor`);
  assert.strictEqual(notebookTabsFor(uri).length, 0, `${label}: Cell View tab must be gone`);
}

describe("Tithon 'Open as Text' switches Cell View back to a text editor (v36)", () => {
  it("(A) no-arg / active-editor path opens the .py as text", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    await openCellView(uri);
    // eslint-disable-next-line no-console
    console.log(`v36 A before: textTabs=${textTabsFor(uri).length} notebookOpen=${!!notebookFor(uri)}`);

    // Exactly what the toolbar button does when it forwards no / a Uri argument.
    await vscode.commands.executeCommand("tithon.openAsText");

    await assertSwitchedToText(uri, "A");
    // Clean up so suite B starts from a known state.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("(B) a non-Uri toolbar argument still opens the .py as text", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    const nb = await openCellView(uri);
    // eslint-disable-next-line no-console
    console.log(`v36 B before: textTabs=${textTabsFor(uri).length} notebookOpen=${!!notebookFor(uri)}`);

    // Simulate a `notebook/toolbar` menu that forwards an editor-context object
    // (NOT a vscode.Uri). A naive handler would call openWith on this object and
    // silently fail; the URI would also never leave `cellViewUris`.
    const bogusArg = { notebookEditor: { notebookUri: nb.uri } } as unknown;
    await vscode.commands.executeCommand("tithon.openAsText", bogusArg);

    await assertSwitchedToText(uri, "B");
  });
});
