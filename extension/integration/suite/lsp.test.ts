/**
 * v32 — REAL VSCode + ruff/ty LSP: a tithon-py Cell View must keep notebook-aware
 * Python language servers working IN the cells.
 *
 * Background: a tithon-py notebook reuses the .py's OWN file:// URI as the
 * notebook URI (extension.ts: `n.uri.fsPath === fileUri.fsPath`). If the same
 * .py is ALSO open as a plain text editor, ruff/ty key that one URI as both a
 * text document AND a notebook document and desync — ruff drops the cell
 * ("document vscode-notebook-cell://… isn't open"), ty's per-URI controller
 * collapses ("Document controller not available at file://…"), and cell LSP
 * dies. The fix (single representation per URI) closes coexisting text editors
 * when a Cell View is open — but ONLY for that one URI: navigating elsewhere
 * (go-to-definition into another file) must still open a normal text editor.
 *
 * Asserts, in a real Extension Host with ruff+ty enabled:
 *   (A) no plain-text editor for the cell-viewed URI survives once the Cell
 *       View is open (single representation);
 *   (B) ruff publishes a diagnostic ON the cell (F401 unused `import os`),
 *       proving the linter sees the cell;
 *   (C) go-to-definition FROM a cell resolves to the defining file (helper.py),
 *       proving LSP navigation works inside the Cell View;
 *   (D) opening that definition target opens it as a TEXT editor (not a
 *       notebook, not swallowed by the single-representation guard).
 * v32.sh additionally scans the ruff/ty server logs for the desync signatures.
 *
 * Unlike the other suites this one runs with ruff+ty ENABLED (the runner uses
 * TITHON_LSP_EXT_DIR instead of --disable-extensions).
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

const textTabsFor = (uri: vscode.Uri): vscode.Tab[] =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t) =>
        t.input instanceof vscode.TabInputText &&
        t.input.uri.toString() === uri.toString(),
    );

const notebookFor = (uri: vscode.Uri): vscode.NotebookDocument | undefined =>
  vscode.workspace.notebookDocuments.find(
    (d) => d.uri.toString() === uri.toString() && d.notebookType === "tithon-py",
  );

function ruffDiagnostics(cellUri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages
    .getDiagnostics(cellUri)
    .filter((d) => /ruff/i.test(String(d.source ?? "")));
}

/** Locate the LAST occurrence of `needle` in a document; returns its Position. */
function positionOf(doc: vscode.TextDocument, needle: string): vscode.Position {
  const idx = doc.getText().lastIndexOf(needle);
  if (idx < 0) throw new Error(`'${needle}' not found in ${doc.uri.toString()}`);
  return doc.positionAt(idx);
}

type DefResult = vscode.Location | vscode.LocationLink;
const defUri = (d: DefResult): vscode.Uri =>
  "targetUri" in d ? d.targetUri : d.uri;

describe("Tithon Cell View keeps ruff/ty LSP alive in cells (v32)", () => {
  it("single representation, ruff lints the cell, go-to-def opens text", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    const helperUri = vscode.Uri.file(process.env.TITHON_HELPER!);
    await ext().activate();

    // This suite deliberately reproduces a text/notebook COEXISTENCE on the same
    // URI; the percent-`.py` auto-open feature would convert the file to a Cell
    // View before we can, so disable it here (covered on by default in v37).
    await vscode.workspace
      .getConfiguration("tithon")
      .update("autoOpenCellView", false, vscode.ConfigurationTarget.Global);

    const ruff = vscode.extensions.getExtension("charliermarsh.ruff");
    const ty = vscode.extensions.getExtension("astral-sh.ty");
    assert.ok(ruff, "ruff extension must be installed in the test host");
    // eslint-disable-next-line no-console
    console.log(`v32: lsp ext present ruff=${!!ruff}(active=${ruff?.isActive}) ty=${!!ty}(active=${ty?.isActive})`);
    // Activation event is onLanguage:python; under the test host it does not
    // always fire on its own, so activate explicitly and let the servers start.
    await ruff?.activate();
    await ty?.activate();
    // eslint-disable-next-line no-console
    console.log(`v32: after activate ruff.active=${ruff?.isActive} ty.active=${ty?.isActive}`);

    // Reproduce the collision: open the .py as TEXT in two editor groups so a
    // text representation coexists with the soon-to-open notebook.
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two });
    await waitFor(() => textTabsFor(uri).length >= 2, 15000, "two text editors of the .py");
    // eslint-disable-next-line no-console
    console.log(`v32: text tabs before Cell View = ${textTabsFor(uri).length}`);

    // Open the Cell View.
    await vscode.commands.executeCommand("tithon.openAsCellView", uri);
    await waitFor(() => !!notebookFor(uri), 15000, "Cell View opened");
    const nb = notebookFor(uri)!;
    await waitFor(() => nb.cellCount >= 1, 15000, "notebook cells");

    // (A) single representation: no plain-text editor for this URI may coexist.
    await waitFor(() => textTabsFor(uri).length === 0, 15000,
      "all coexisting text editors closed once Cell View is open");
    // eslint-disable-next-line no-console
    console.log(`v32: text tabs after Cell View = ${textTabsFor(uri).length}`);

    // Drive the activity that triggered the user's didChange storm.
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(0, 1)],
      document: uri,
    });

    const cell0 = nb.cellAt(0).document;

    // (B) ruff must publish its F401 (unused `import os`) on the cell.
    // eslint-disable-next-line no-console
    console.log(`v32: cell0 uri = ${cell0.uri.toString()}`);
    await waitFor(() => ruffDiagnostics(cell0.uri).length > 0, 40000,
      "ruff published a diagnostic on the cell (LSP alive in Cell View)");
    const diags = ruffDiagnostics(cell0.uri);
    // eslint-disable-next-line no-console
    console.log(`v32: ruff diagnostics on cell0 = ${JSON.stringify(diags.map((d) => `${d.code}:${d.message}`))}`);
    assert.ok(diags.length > 0, "ruff diagnostic present on the cell");

    // (C) go-to-definition FROM the cell resolves into helper.py.
    const pos = positionOf(cell0, "my_helper(");
    let defs: DefResult[] = [];
    await waitFor(async () => {
      defs = (await vscode.commands.executeCommand<DefResult[]>(
        "vscode.executeDefinitionProvider", cell0.uri, pos,
      )) ?? [];
      return defs.some((d) => defUri(d).fsPath === helperUri.fsPath);
    }, 40000, "go-to-definition resolved into helper.py from a cell");
    // eslint-disable-next-line no-console
    console.log(`v32: definitions = ${JSON.stringify(defs.map((d) => defUri(d).fsPath))}`);
    assert.ok(defs.some((d) => defUri(d).fsPath === helperUri.fsPath),
      "definition points into helper.py");

    // (D) opening that target opens helper.py as a TEXT editor (not a notebook).
    await vscode.commands.executeCommand("vscode.open", helperUri);
    await waitFor(() => textTabsFor(helperUri).length > 0, 15000,
      "helper.py opened as a text editor via go-to-definition");
    assert.ok(!notebookFor(helperUri), "go-to target must NOT open as a tithon-py notebook");
    // eslint-disable-next-line no-console
    console.log(`v32: helper.py text tabs = ${textTabsFor(helperUri).length}`);
  });
});
