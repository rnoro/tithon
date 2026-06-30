/**
 * v43 — REAL VSCode + ty LSP: ty's per-cell ANALYSIS (inlay hints + go-to-def)
 * must be IDENTICAL after a Cell View -> Text Editor -> Cell View round trip.
 *
 * Follow-up to ADR-064 (which stopped the `notebookDocument/didChange: document
 * not found` flood). The user then reported ty's VISUAL rendering is still broken
 * after the round trip — type-annotation inlay hints vanish and the surviving
 * parameter-name hints render at STALE character offsets (a `device=` hint
 * injected mid-`val_loss` -> `val_lodevice=ss`). No edit, no running cell — a
 * pure toggle.
 *
 * This asserts ty's ANALYSIS is intact (the inlay hints ty RETURNS are byte-
 * identical fresh vs after, and cross-cell go-to-def still resolves) — isolating
 * the defect to the editor's PAINTED decorations vs ty's response. When
 * TITHON_HOLD_MS is set it instead holds the reopened notebook on screen so
 * scripts/shotlsp.sh can screenshot the actual rendering.
 *
 * Runs with ty ENABLED (the runner uses TITHON_LSP_EXT_DIR).
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

type Hint = { line: number; char: number; label: string };

function hintLabel(h: vscode.InlayHint): string {
  if (typeof h.label === "string") return h.label;
  return h.label.map((p) => p.value).join("");
}

function cellIndexWith(nb: vscode.NotebookDocument, needle: string): number {
  for (let i = 0; i < nb.cellCount; i++) {
    if (nb.cellAt(i).document.getText().includes(needle)) return i;
  }
  throw new Error(`no cell contains '${needle}'`);
}

async function runAllCode(nb: vscode.NotebookDocument, uri: vscode.Uri): Promise<void> {
  await vscode.window.showNotebookDocument(nb);
  await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [new vscode.NotebookRange(0, nb.cellCount)],
    document: uri,
  });
  await new Promise((r) => setTimeout(r, 2500));
}

/** Capture ty's inlay hints for a cell, retried until NON-EMPTY and stable. */
async function stableInlayHints(
  nb: vscode.NotebookDocument,
  cellIdx: number,
  ms: number,
  label: string,
): Promise<Hint[]> {
  const snap = async (): Promise<Hint[]> => {
    const doc = nb.cellAt(cellIdx).document;
    const range = new vscode.Range(0, 0, doc.lineCount, 0);
    const hints =
      (await vscode.commands.executeCommand<vscode.InlayHint[]>(
        "vscode.executeInlayHintProvider", doc.uri, range,
      )) ?? [];
    return hints
      .map((h) => ({ line: h.position.line, char: h.position.character, label: hintLabel(h).trim() }))
      .sort((a, b) => a.line - b.line || a.char - b.char || a.label.localeCompare(b.label));
  };
  let prev: Hint[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const cur = await snap();
    if (cur.length > 0 && JSON.stringify(cur) === JSON.stringify(prev)) return cur;
    prev = cur;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${label} (last=${JSON.stringify(prev)})`);
}

type DefResult = vscode.Location | vscode.LocationLink;
const defUri = (d: DefResult): vscode.Uri =>
  "targetUri" in d ? d.targetUri : d.uri;

describe("ty per-cell analysis survives a Cell View <-> Text round trip (v43, ty)", () => {
  it("inlay hints and go-to-def are identical after openAsText then openAsNotebook", async () => {
    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    const ty = vscode.extensions.getExtension("astral-sh.ty");
    assert.ok(ty, "ty extension must be installed in the test host");
    await ty?.activate();

    // --- FRESH open + run (live output, like the user) -------------------------
    await vscode.commands.executeCommand("tithon.openAsNotebook", uri);
    await waitFor(() => !!notebookFor(uri), 15000, "Cell View opened (1)");
    await waitFor(() => notebookFor(uri)!.cellCount >= 2, 15000, "notebook cells (1)");
    // eslint-disable-next-line no-console
    console.log(`v43: cells = ${notebookFor(uri)!.getCells().map((c) => (c.kind === vscode.NotebookCellKind.Markup ? "md" : "code")).join(",")}`);
    await runAllCode(notebookFor(uri)!, uri);
    const cellIdx = cellIndexWith(notebookFor(uri)!, "val_loss");

    const fresh = await stableInlayHints(notebookFor(uri)!, cellIdx, 45000, "fresh inlay hints");
    // eslint-disable-next-line no-console
    console.log(`v43: fresh hints (${fresh.length}) = ${JSON.stringify(fresh)}`);
    assert.ok(fresh.length > 0, "ty must produce inlay hints on the fresh Cell View (else vacuous)");

    // --- ROUND TRIP: Cell View -> Text -> Cell View (no edit, no running cell) --
    await vscode.commands.executeCommand("tithon.openAsText", uri);
    await waitFor(() => textTabsFor(uri).length > 0, 15000, "text editor opened");
    await waitFor(() => !notebookFor(uri), 15000, "notebook closed on switch to text");

    await vscode.commands.executeCommand("tithon.openAsNotebook", uri);
    await waitFor(() => !!notebookFor(uri), 15000, "Cell View reopened (2)");
    await waitFor(() => notebookFor(uri)!.cellCount >= 2, 15000, "notebook cells (2)");
    await waitFor(() => textTabsFor(uri).length === 0, 15000, "no coexisting text editor (2)");
    // The user's repro is a PURE toggle (no re-run). Re-running dirties the cell
    // text models and forces VSCode to recompute inlay-hint decorations, which
    // MASKS a stale-decoration paint bug. TITHON_NO_RERUN=1 skips the re-run so
    // the reopened cells keep whatever decorations VSCode's notebook editor
    // recycling left on the pooled cell widgets — the path that paints `device=`
    // (from `t.to(device)`) into `val_loss` -> `val_lodevice=ss`.
    if (process.env.TITHON_NO_RERUN !== "1") {
      await runAllCode(notebookFor(uri)!, uri);
    }

    const afterIdx = cellIndexWith(notebookFor(uri)!, "val_loss");

    // Screenshot mode: hold the reopened notebook on screen for shotlsp.sh.
    if (holdMs > 0) {
      const nb = notebookFor(uri)!;
      const editor = await vscode.window.showNotebookDocument(nb);
      // Exercise the cell-editor virtualization/recycling: scroll to the bottom,
      // then back up to the observed cell, so pooled cell widgets are reused (the
      // condition under which stale inlay-hint decorations get repainted).
      editor.revealRange(new vscode.NotebookRange(nb.cellCount - 1, nb.cellCount), vscode.NotebookEditorRevealType.AtTop);
      await new Promise((r) => setTimeout(r, 1200));
      editor.revealRange(new vscode.NotebookRange(0, 1), vscode.NotebookEditorRevealType.AtTop);
      await new Promise((r) => setTimeout(r, 1200));
      editor.revealRange(new vscode.NotebookRange(afterIdx, afterIdx + 1), vscode.NotebookEditorRevealType.AtTop);
      // eslint-disable-next-line no-console
      console.log(`v43: HOLD ${holdMs}ms showing reopened cell ${afterIdx} (rerun=${process.env.TITHON_NO_RERUN !== "1"})`);
      await new Promise((r) => setTimeout(r, holdMs));
      return;
    }

    const after = await stableInlayHints(notebookFor(uri)!, afterIdx, 45000, "after-round-trip inlay hints");
    // eslint-disable-next-line no-console
    console.log(`v43: after hints (${after.length}) = ${JSON.stringify(after)}`);
    assert.deepStrictEqual(after, fresh,
      "ty inlay hints (labels + positions) RETURNED must be identical after the round trip");

    const useDoc = notebookFor(uri)!.cellAt(afterIdx).document;
    const callIdx = useDoc.getText().indexOf("scale(");
    assert.ok(callIdx >= 0, "use site 'scale(' present");
    const pos = useDoc.positionAt(callIdx);
    let defs: DefResult[] = [];
    await waitFor(async () => {
      defs = (await vscode.commands.executeCommand<DefResult[]>(
        "vscode.executeDefinitionProvider", useDoc.uri, pos,
      )) ?? [];
      return defs.length > 0;
    }, 40000, "go-to-def resolves after round trip");
    // eslint-disable-next-line no-console
    console.log(`v43: scale go-to-def -> ${JSON.stringify(defs.map((d) => `${defUri(d).scheme}#${defUri(d).fragment}`))}`);
    assert.ok(defs.length > 0, "go-to-def must resolve after the round trip");
  });
});
