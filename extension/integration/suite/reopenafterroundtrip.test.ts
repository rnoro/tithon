/**
 * v44 — REAL VSCode: after a Cell View -> Text -> Cell View round trip, CLOSING
 * the .py and REOPENING it must actually open the file.
 *
 * Reported bug (B): after the round trip the user closes the .py and reopens it;
 * the file flashes in the tab bar then immediately closes and never shows. Reload
 * Window fixes it -> stale in-memory extension state. Hypothesis: the URI is left
 * STUCK in `cellViewUris` with no live notebook, so the onDidChangeTabs single-
 * representation guard auto-closes every text editor opened for that .py.
 *
 * Asserts:
 *   (1) after the round trip + closeAllEditors, the URI is NOT stuck in
 *       cellViewUris (no live notebook -> no entry), via tithon._cellViewState;
 *   (2) reopening the .py leaves a VISIBLE editor (text or Cell View) for the URI
 *       that STAYS open (the guard must not auto-close it).
 * Pre-fix, (2) fails: the reopened tab is closed by the guard within ~1s.
 *
 * No LSP needed (pure tab/state logic) — runs under --disable-extensions.
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

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const textTabsFor = (uri: vscode.Uri): vscode.Tab[] =>
  vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(
    (t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString(),
  );

const notebookTabsFor = (uri: vscode.Uri): vscode.Tab[] =>
  vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(
    (t) => t.input instanceof vscode.TabInputNotebook && t.input.uri.toString() === uri.toString(),
  );

const anyTabsFor = (uri: vscode.Uri): vscode.Tab[] => [...textTabsFor(uri), ...notebookTabsFor(uri)];

const notebookFor = (uri: vscode.Uri): vscode.NotebookDocument | undefined =>
  vscode.workspace.notebookDocuments.find(
    (d) => d.uri.toString() === uri.toString() && d.notebookType === "tithon-py",
  );

async function cellViewState(): Promise<{ cellViewUris: string[]; textPreferred: string[] }> {
  return (await vscode.commands.executeCommand("tithon._cellViewState")) as {
    cellViewUris: string[];
    textPreferred: string[];
  };
}

describe("reopen after a Cell View<->Text round trip (v44)", () => {
  it("the .py reopens and stays open; no stuck cellViewUris entry", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    await vscode.workspace
      .getConfiguration("tithon")
      .update("autoOpenCellView", true, vscode.ConfigurationTarget.Global);

    // Open as Cell View, then round-trip through text and back.
    await vscode.commands.executeCommand("tithon.openAsCellView", uri);
    await waitFor(() => !!notebookFor(uri), 15000, "Cell View opened (1)");

    await vscode.commands.executeCommand("tithon.openAsText", uri);
    await waitFor(() => textTabsFor(uri).length > 0, 15000, "text editor opened");
    await waitFor(() => !notebookFor(uri), 15000, "notebook closed");

    await vscode.commands.executeCommand("tithon.openAsCellView", uri);
    await waitFor(() => !!notebookFor(uri), 15000, "Cell View reopened (2)");
    await waitFor(() => textTabsFor(uri).length === 0, 15000, "no coexisting text editor (2)");

    // User closes the file.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(() => anyTabsFor(uri).length === 0, 15000, "all editors for the .py closed");
    // Give onDidCloseNotebookDocument a beat to run its cleanup.
    await new Promise((r) => setTimeout(r, 800));

    // (1) No live notebook -> the URI must NOT linger in cellViewUris (else the
    // guard will auto-close every reopened text editor).
    const st = await cellViewState();
    // eslint-disable-next-line no-console
    console.log(`v44: after close: cellViewUris=${JSON.stringify(st.cellViewUris)} textPreferred=${JSON.stringify(st.textPreferred)} notebookOpen=${!!notebookFor(uri)}`);
    assert.ok(
      !st.cellViewUris.includes(uri.toString()) || !!notebookFor(uri),
      `URI is stuck in cellViewUris with no live notebook -> the guard will eat reopened text editors (cellViewUris=${JSON.stringify(st.cellViewUris)})`,
    );

    // (2) Reopen the .py. A healthy outcome leaves a VISIBLE editor (text that
    // stays, or an auto-converted Cell View) — the bug is the tab flashing then
    // closing. Open, wait past the guard's reaction window, assert it survived.
    await vscode.commands.executeCommand("vscode.open", uri);
    await waitFor(() => anyTabsFor(uri).length > 0, 15000, "the .py reopened (a tab appeared)");
    // The guard reacts on the next tab-change tick; wait well past it.
    await new Promise((r) => setTimeout(r, 2500));
    const tabs = anyTabsFor(uri);
    // eslint-disable-next-line no-console
    console.log(`v44: after reopen+settle: textTabs=${textTabsFor(uri).length} notebookTabs=${notebookTabsFor(uri).length}`);
    assert.ok(tabs.length > 0,
      "the reopened .py was auto-closed (flashes then closes) — a URI stuck in cellViewUris made the guard eat it");
  });

  it("RACE: overlapping toggles must not strand cellViewUris", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    // Settle to a known Cell View state first.
    await vscode.commands.executeCommand("tithon.openAsCellView", uri);
    await waitFor(() => !!notebookFor(uri), 15000, "Cell View opened");

    // Fast user: fire opposite toggles overlapping (openAsCellView's 3s
    // closeTextDocsAndWait window lets a "click Open as Text 1s later" interleave).
    for (let i = 0; i < 4; i++) {
      const a = vscode.commands.executeCommand("tithon.openAsText", uri);
      const b = vscode.commands.executeCommand("tithon.openAsCellView", uri);
      await Promise.allSettled([a, b]);
      await new Promise((r) => setTimeout(r, 250));
    }
    // End on Cell View deterministically, then close everything.
    await vscode.commands.executeCommand("tithon.openAsCellView", uri);
    await new Promise((r) => setTimeout(r, 1500));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(() => anyTabsFor(uri).length === 0, 15000, "all closed after race");
    await new Promise((r) => setTimeout(r, 1000));

    const st = await cellViewState();
    // eslint-disable-next-line no-console
    console.log(`v44 RACE: after close cellViewUris=${JSON.stringify(st.cellViewUris)} textPreferred=${JSON.stringify(st.textPreferred)} notebookOpen=${!!notebookFor(uri)}`);
    assert.ok(
      !st.cellViewUris.includes(uri.toString()) || !!notebookFor(uri),
      `RACE stranded the URI in cellViewUris with no live notebook (cellViewUris=${JSON.stringify(st.cellViewUris)})`,
    );

    // And the .py must reopen.
    await vscode.commands.executeCommand("vscode.open", uri);
    await waitFor(() => anyTabsFor(uri).length > 0, 15000, "reopened after race");
    await new Promise((r) => setTimeout(r, 2500));
    // eslint-disable-next-line no-console
    console.log(`v44 RACE: after reopen anyTabs=${anyTabsFor(uri).length}`);
    assert.ok(anyTabsFor(uri).length > 0, "the .py was auto-closed after the race (stuck cellViewUris)");
  });
});
