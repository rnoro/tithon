/**
 * v42 — REAL VSCode + ty LSP: go-to-definition must survive a Cell View -> Text
 * Editor -> Cell View ROUND TRIP.
 *
 * Reported bug: open a `.py` as the Cell View and go-to-definition (ty) works;
 * switch to the Text Editor and back to the Cell View, and go-to-definition is
 * dead, with the ty server flooding
 *   ERROR notebookDocument/didChange: document not found for key: …/baseline.py
 *
 * Cause class (ADR-041): a tithon-py notebook reuses the .py's OWN file:// URI as
 * the notebook URI, so ty keys both the notebook document and (transiently) a
 * plain text document under the SAME URI. If the text<->notebook switch lets the
 * two representations co-register, or tears the notebook down without a clean
 * didClose/didOpen, ty drops its per-URI notebook controller; the VSCode LSP
 * client keeps streaming notebookDocument/didChange (live output / cell edits) to
 * a notebook ty no longer knows -> "document not found", and navigation is dead.
 *
 * v32 covers the FIRST open only (text coexistence -> Open as Cell View). This
 * suite drives the round trip the user actually hit and asserts go-to-definition
 * STILL resolves into helper.py after returning to the Cell View. v42.sh
 * additionally scans the ty server log for the "document not found" signature.
 *
 * Runs with ruff+ty ENABLED (the runner uses TITHON_LSP_EXT_DIR).
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

function positionOf(doc: vscode.TextDocument, needle: string): vscode.Position {
  const idx = doc.getText().lastIndexOf(needle);
  if (idx < 0) throw new Error(`'${needle}' not found in ${doc.uri.toString()}`);
  return doc.positionAt(idx);
}

type DefResult = vscode.Location | vscode.LocationLink;
const defUri = (d: DefResult): vscode.Uri =>
  "targetUri" in d ? d.targetUri : d.uri;

/** Drive go-to-definition from the first cell's `my_helper(` use site and report
 * whether ANY result lands in helper.py. Retries: ty answers asynchronously. */
async function gotoResolvesHelper(
  uri: vscode.Uri,
  helperUri: vscode.Uri,
  ms: number,
  label: string,
): Promise<void> {
  const nb = notebookFor(uri)!;
  const cell0 = nb.cellAt(0).document;
  const pos = positionOf(cell0, "my_helper(");
  let defs: DefResult[] = [];
  await waitFor(async () => {
    defs = (await vscode.commands.executeCommand<DefResult[]>(
      "vscode.executeDefinitionProvider", cell0.uri, pos,
    )) ?? [];
    return defs.some((d) => defUri(d).fsPath === helperUri.fsPath);
  }, ms, label);
  // eslint-disable-next-line no-console
  console.log(`v42: ${label} -> ${JSON.stringify(defs.map((d) => defUri(d).fsPath))}`);
}

describe("go-to-definition survives a Cell View <-> Text round trip (v42, ty)", () => {
  it("ty go-to-def still resolves after openAsText then openAsCellView", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    const helperUri = vscode.Uri.file(process.env.TITHON_HELPER!);
    await ext().activate();

    // Explicit transitions only; the percent auto-open would race our switches.
    await vscode.workspace
      .getConfiguration("tithon")
      .update("autoOpenCellView", false, vscode.ConfigurationTarget.Global);

    const ruff = vscode.extensions.getExtension("charliermarsh.ruff");
    const ty = vscode.extensions.getExtension("astral-sh.ty");
    assert.ok(ty, "ty extension must be installed in the test host");
    await ruff?.activate();
    await ty?.activate();
    // eslint-disable-next-line no-console
    console.log(`v42: ty present=${!!ty} active=${ty?.isActive}`);

    // --- PHASE 1: open as Cell View, go-to-def works ---------------------------
    await vscode.commands.executeCommand("tithon.openAsCellView", uri);
    await waitFor(() => !!notebookFor(uri), 15000, "Cell View opened (1)");
    await waitFor(() => notebookFor(uri)!.cellCount >= 1, 15000, "notebook cells (1)");
    await gotoResolvesHelper(uri, helperUri, 40000, "phase1 go-to-def into helper.py");

    // --- TRANSITION: Cell View -> Text Editor ----------------------------------
    await vscode.commands.executeCommand("tithon.openAsText", uri);
    await waitFor(() => textTabsFor(uri).length > 0, 15000, "text editor opened");
    await waitFor(() => !notebookFor(uri), 15000, "notebook document closed on switch to text");
    // eslint-disable-next-line no-console
    console.log(`v42: after openAsText: textTabs=${textTabsFor(uri).length} notebook=${!!notebookFor(uri)}`);

    // --- TRANSITION: Text Editor -> Cell View ----------------------------------
    await vscode.commands.executeCommand("tithon.openAsCellView", uri);
    await waitFor(() => !!notebookFor(uri), 15000, "Cell View reopened (2)");
    await waitFor(() => notebookFor(uri)!.cellCount >= 1, 15000, "notebook cells (2)");
    await waitFor(() => textTabsFor(uri).length === 0, 15000,
      "no text editor coexists after returning to the Cell View");
    // eslint-disable-next-line no-console
    console.log(`v42: after openAsCellView(2): textTabs=${textTabsFor(uri).length} notebook=${!!notebookFor(uri)}`);

    // Drive the live-sync notebookDocument/didChange stream the user saw flood ty:
    // select the kernel and run the cell so output writes mutate the notebook.
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(0, 1)],
      document: uri,
    });
    // Give live sync a beat to push changes into the reopened notebook.
    await new Promise((r) => setTimeout(r, 2000));

    // --- PHASE 2 (the regression): go-to-def must STILL resolve -----------------
    await gotoResolvesHelper(uri, helperUri, 40000,
      "phase2 go-to-def into helper.py after round trip");
  });
});
