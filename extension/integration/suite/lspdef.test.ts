/**
 * v41 — REAL VSCode + Pylance: SAME-file go-to-definition in a tithon-py Cell
 * View must NOT open a phantom `a.py.py` file.
 *
 * Background: a tithon-py notebook reuses the .py's OWN file:// uri as the
 * notebook uri (ADR-041). For an IN-notebook definition Pylance answers with a
 * `file://` Location whose path is the notebook uri's path plus an EXTRA `.py`,
 * carrying the target cell's handle in the fragment — e.g.
 * `file:///x/a.py.py#W0sZmlsZQ==`. For a normal `.ipynb` (`a.ipynb` →
 * `a.ipynb.py`) that pseudo-path round-trips back to a `vscode-notebook-cell:`
 * uri, but here it becomes `a.py.py` and the round-trip never fires, so VSCode
 * opens a phantom text tab for the non-existent `a.py.py` ("go-to-def opens
 * a.py.py"). The extension detects that phantom tab and redirects to the real
 * cell.
 *
 * Asserts, with Pylance live in a real Extension Host:
 *   (A) go-to-definition FROM the use cell resolves to a same-file definition;
 *   (B) opening that definition leaves NO phantom `*.py.py` text tab;
 *   (C) the tithon-py notebook is the active editor afterwards;
 *   (D) the DEFINING cell (index 0) is the selected cell.
 * Pre-fix this fails at (B)/(C): the phantom `a.py.py` tab survives and there is
 * no active notebook editor.
 *
 * Runs with Pylance ENABLED (the runner uses TITHON_LSP_EXT_DIR); v32 covers the
 * ruff/ty CROSS-file case (Pylance absent there).
 */
import * as assert from "assert";
import * as vscode from "vscode";

function ext(): vscode.Extension<unknown> {
  const e = vscode.extensions.all.find((x) =>
    (x.packageJSON?.contributes?.commands ?? []).some(
      (c: { command?: string }) => c.command === "tithon.restartKernel",
    ),
  );
  if (!e) throw new Error("Tithon extension not found");
  return e;
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

const notebookFor = (uri: vscode.Uri): vscode.NotebookDocument | undefined =>
  vscode.workspace.notebookDocuments.find(
    (d) => d.uri.toString() === uri.toString() && d.notebookType === "tithon-py",
  );

type DefResult = vscode.Location | vscode.LocationLink;
const defUri = (d: DefResult): vscode.Uri =>
  "targetUri" in d ? d.targetUri : d.uri;
const defRange = (d: DefResult): vscode.Range =>
  "targetRange" in d ? d.targetRange : (d as vscode.Location).range;

function positionOf(doc: vscode.TextDocument, needle: string): vscode.Position {
  const idx = doc.getText().lastIndexOf(needle);
  if (idx < 0) throw new Error(`'${needle}' not found in ${doc.uri.toString()}`);
  return doc.positionAt(idx);
}

const phantomTabsFor = (): string[] =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath.endsWith(".py.py"))
    .map((t) => (t.input as vscode.TabInputText).uri.toString());

describe("same-file go-to-definition stays in the Cell View (v41, Pylance)", () => {
  it("redirects Pylance's a.py.py pseudo-path to the defining cell", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    const py = vscode.extensions.getExtension("ms-python.python");
    const pylance = vscode.extensions.getExtension("ms-python.vscode-pylance");
    assert.ok(pylance, "Pylance must be installed in the test host");
    await py?.activate();
    await pylance?.activate();
    // eslint-disable-next-line no-console
    console.log(`v41: pylance active=${pylance?.isActive}`);

    await vscode.commands.executeCommand("tithon.openAsNotebook", uri);
    await waitFor(() => !!notebookFor(uri), 15000, "Cell View opened");
    const nb = notebookFor(uri)!;
    await waitFor(() => nb.cellCount >= 2, 15000, "notebook cells");

    // Use site is in the LAST cell; the definition is in the FIRST cell.
    const useCell = nb.cellAt(nb.cellCount - 1).document;
    const pos = positionOf(useCell, "my_func");

    // (A) go-to-definition resolves to a same-file definition. Pylance hands back
    // the `<notebook>.py.py#<cell>` pseudo-path (logged for the record).
    let defs: DefResult[] = [];
    await waitFor(async () => {
      defs = (await vscode.commands.executeCommand<DefResult[]>(
        "vscode.executeDefinitionProvider", useCell.uri, pos,
      )) ?? [];
      return defs.length > 0;
    }, 40000, "go-to-definition resolved");
    const target = defUri(defs[0]);
    // eslint-disable-next-line no-console
    console.log(`v41: raw definition uri = ${target.toString()} (scheme=${target.scheme})`);
    assert.ok(phantomTabsFor().length === 0, "no phantom tab before the open");

    // Open the definition (what Ctrl+Click / Go to Definition does).
    await vscode.commands.executeCommand("vscode.open", target, { selection: defRange(defs[0]) });

    // (B) the redirect must leave NO phantom `*.py.py` text tab.
    await waitFor(() => phantomTabsFor().length === 0, 15000,
      `phantom .py.py tab must be closed (have ${JSON.stringify(phantomTabsFor())})`);

    // (C)/(D) the notebook is active and the DEFINING cell (index 0) is selected.
    await waitFor(
      () => vscode.window.activeNotebookEditor?.notebook.uri.toString() === uri.toString(),
      15000, "the tithon-py notebook is the active editor after redirect");
    const ane = vscode.window.activeNotebookEditor!;
    // eslint-disable-next-line no-console
    console.log(`v41: active notebook = ${ane.notebook.uri.toString()} selCell=${ane.selection.start}`);
    assert.strictEqual(ane.selection.start, 0, "the defining cell (index 0) must be selected");
  });
});
