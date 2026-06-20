/**
 * v39 — REAL VSCode: a percent-format `.py` (with a `# %%` cell marker) opened as
 * TEXT auto-switches to the Tithon Cell View, so the user doesn't press "Open as
 * Cell View" on every reopen (tithon.autoOpenCellView, default on). Guards that
 * matter:
 *   (1) a percent .py opened via vscode.open auto-becomes a Cell View (no manual
 *       command), single representation (no lingering text tab);
 *   (2) "Open as Text Editor" switches it back to text AND STICKS — re-activating
 *       the text editor must NOT flip it back to a notebook (textPreferred guard;
 *       without it the content heuristic and the toggle fight in an endless loop);
 *   (3) a PLAIN script (no markers) opened as text STAYS text (the ADR-032 intent
 *       — don't render every .py as a notebook).
 *
 * Merged here (ADR-048, retiring the redundant v25/v36 scripts):
 *   (4) the opt-in `tithon.openAsCellView` still opens a RUNNABLE Tithon notebook
 *       for a markerless .py — proves vscode.openWith works with an EMPTY selector
 *       (was scripts/v25.sh / editordefault.test.ts);
 *   (5) "Open as Text" also resolves with NO argument via the active editor — the
 *       realistic toolbar path (was scripts/v36.sh / opentext.test.ts; (2) above
 *       already covers the non-Uri-argument path).
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

function ext(): vscode.Extension<unknown> {
  const e = vscode.extensions.all.find((x) =>
    (x.packageJSON?.contributes?.commands ?? []).some(
      (c: { command?: string }) => c.command === "tithon.startLive",
    ),
  );
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const textTabsFor = (uri: vscode.Uri): vscode.Tab[] =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());

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

describe("Tithon auto-opens percent .py as Cell View (v39)", () => {
  it("auto-converts on open, Open-as-Text sticks, plain scripts stay text", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!); // percent .py
    const plainUri = vscode.Uri.file(process.env.TITHON_HELPER!); // plain script
    await ext().activate();
    // Make sure the feature is on (default true; be explicit so the run is hermetic).
    await vscode.workspace
      .getConfiguration("tithon")
      .update("autoOpenCellView", true, vscode.ConfigurationTarget.Global);

    // (1) Open the percent .py the way a user does — it must AUTO-open as a Cell
    // View with no manual command, and leave no coexisting text tab.
    await vscode.commands.executeCommand("vscode.open", uri);
    await waitFor(() => notebookTabsFor(uri).length > 0, 20000,
      "percent .py auto-opened as a Cell View");
    await waitFor(() => textTabsFor(uri).length === 0, 15000,
      "no text tab lingers after auto-open (single representation)");
    // eslint-disable-next-line no-console
    console.log(`v39 (1): notebookTabs=${notebookTabsFor(uri).length} textTabs=${textTabsFor(uri).length}`);

    // (2) Open as Text -> switches to text, and the choice STICKS.
    const nb = notebookFor(uri)!;
    await vscode.window.showNotebookDocument(nb);
    await vscode.commands.executeCommand("tithon.openAsText", { notebookEditor: { notebookUri: nb.uri } });
    await waitFor(() => textTabsFor(uri).length > 0, 15000, "switched to a text editor");
    await waitFor(() => notebookTabsFor(uri).length === 0, 15000, "Cell View tab closed");

    // The loop guard: re-activate the text editor; it must NOT auto-flip back.
    await vscode.commands.executeCommand("vscode.open", plainUri); // move focus away
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc); // re-activate the percent .py as text
    await waitFor(
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15000, "percent .py re-activated as text",
    );
    await new Promise((r) => setTimeout(r, 1500)); // give any (wrong) auto-open a chance to fire
    // eslint-disable-next-line no-console
    console.log(`v39 (2): after re-activate textTabs=${textTabsFor(uri).length} notebookTabs=${notebookTabsFor(uri).length}`);
    assert.ok(textTabsFor(uri).length > 0, "percent .py must STAY text after Open as Text");
    assert.strictEqual(notebookTabsFor(uri).length, 0, "must not auto-flip back to a notebook");

    // (3) A plain script (no markers) must never auto-convert.
    // eslint-disable-next-line no-console
    console.log(`v39 (3): plain notebookTabs=${notebookTabsFor(plainUri).length} textTabs=${textTabsFor(plainUri).length}`);
    assert.strictEqual(notebookTabsFor(plainUri).length, 0, "plain .py must not become a Cell View");
    assert.ok(textTabsFor(plainUri).length > 0, "plain .py stays a text editor");
  });

  // (4) Merged from v25/editordefault: the opt-in Cell View still works and runs.
  it("opt-in 'Open as Cell View' opens a runnable notebook (empty selector)", async () => {
    const plainUri = vscode.Uri.file(process.env.TITHON_HELPER!); // markerless script
    await ext().activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // A markerless .py opens as TEXT (no auto-convert); opting in must open a real
    // Tithon notebook. The notebook type has an EMPTY selector, so this also proves
    // vscode.openWith(uri, "tithon-py") works with no filename selector.
    await vscode.commands.executeCommand("vscode.open", plainUri);
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === plainUri.toString(),
      15000, "markerless .py opened as text");
    assert.strictEqual(notebookTabsFor(plainUri).length, 0, "markerless .py must not auto-open as a notebook");

    await vscode.commands.executeCommand("tithon.openAsCellView", plainUri);
    await waitFor(() => !!notebookFor(plainUri), 15000, "Cell View opened on demand");
    const nb = notebookFor(plainUri)!;
    await waitFor(() => nb.cellCount >= 1, 15000, "notebook has cells");

    // And it's a real, runnable Tithon notebook.
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(0, 1)], document: plainUri,
    });
    await waitFor(() => cellText(nb.cellAt(0)).includes("just a script"), 30000,
      "cell ran in the opted-in Cell View");
  });

  // (5) Merged from v36/opentext: "Open as Text" with NO argument resolves via the
  // active notebook editor (the realistic toolbar path; (2) covered the non-Uri arg).
  it("'Open as Text' resolves with no argument via the active editor", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!); // percent .py
    await ext().activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Open the Cell View explicitly (a prior test may have marked this URI
    // textPreferred via the loop-guard, so auto-open won't fire — opt in directly).
    await vscode.commands.executeCommand("tithon.openAsCellView", uri);
    await waitFor(() => !!notebookFor(uri), 15000, "Cell View opened");
    const nb = notebookFor(uri)!;
    await waitFor(() => nb.cellCount >= 1, 15000, "notebook has cells");
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => vscode.window.activeNotebookEditor?.notebook.uri.toString() === uri.toString(),
      15000, "Cell View is the active editor");

    await vscode.commands.executeCommand("tithon.openAsText"); // no argument
    await waitFor(() => textTabsFor(uri).length > 0, 15000, "switched to a text editor (no-arg path)");
    await waitFor(() => notebookTabsFor(uri).length === 0, 15000, "Cell View tab closed (no-arg path)");
    assert.ok(textTabsFor(uri).length > 0, "no-arg Open as Text must produce a text editor");
    assert.strictEqual(notebookTabsFor(uri).length, 0, "no-arg Open as Text must close the Cell View");
  });
});
