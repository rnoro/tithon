/**
 * v64 — REAL VSCode: the durable per-file "open this .py as a Notebook" choice.
 *
 * Two mechanisms, verified together because either alone is wrong:
 *   (a) `contributes.notebooks[].priority: "option"` — an UNASSOCIATED `.py`
 *       resolves to the text editor, so Tithon no longer writes a Global
 *       `workbench.editorAssociations` `*.py` key just to stay out of the way
 *       (the deleted `ensureTextDefaultForPy`, whose failure mode on a read-only
 *       settings host was: every `.py` becomes a notebook, every diff a notebook
 *       diff);
 *   (b) `tithon.alwaysOpenAsNotebook` — ONE Workspace-scoped key per file,
 *       `**` + `/<workspace-relative path>`, which outranks any User `*.py` by
 *       VSCode's longest-pattern-string-wins rule.
 *
 * The discriminating assertion for (b) is that the pinned file opens as a
 * notebook with ZERO file-scheme text documents opened for it: that is what
 * separates declarative editor resolution from an ADR-067-style open-then-convert
 * heuristic, which necessarily opens the text editor first.
 */
import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

const ASSOC = "workbench.editorAssociations";
const DIFF_ASSOC = "workbench.diffEditorAssociations";

function ext(): vscode.Extension<unknown> {
  const e = vscode.extensions.all.find((x) =>
    (x.packageJSON?.contributes?.commands ?? []).some(
      (c: { command?: string }) => c.command === "tithon.restartKernel",
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

const inspectAssoc = () =>
  vscode.workspace.getConfiguration().inspect<Record<string, string>>(ASSOC);

const workspaceAssoc = (): Record<string, string> => inspectAssoc()?.workspaceValue ?? {};

const notebookTabsFor = (uri: vscode.Uri): vscode.Tab[] =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t) =>
        t.input instanceof vscode.TabInputNotebook &&
        t.input.notebookType === "tithon-py" &&
        t.input.uri.toString() === uri.toString(),
    );

const textTabsFor = (uri: vscode.Uri): vscode.Tab[] =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString(),
    );

const hasFileTextDoc = (uri: vscode.Uri): boolean =>
  vscode.workspace.textDocuments.some(
    (d) => d.uri.scheme === "file" && d.uri.toString() === uri.toString(),
  );

/** Close every editor AND wait for the file's text document to be released, so a
 * following open is a real resolution and not a reveal of a lingering document. */
async function closeEverything(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(
    () => !hasFileTextDoc(uri) && notebookTabsFor(uri).length === 0,
    15000,
    "all editors closed and the text document released",
  );
}

describe("Tithon durable open-as-Notebook association (v64)", () => {
  // TITHON_FIXTURE is <workspace>/pkg/train.py — a nested path, so the pattern
  // exercises a real relative path rather than a bare basename.
  const target = vscode.Uri.file(process.env.TITHON_FIXTURE!);
  // A second .py that must keep opening as TEXT throughout.
  const unrelated = vscode.Uri.file(process.env.TITHON_HELPER!);
  // Created by the driver script beside the fixture; used for the diff check.
  const sibling = vscode.Uri.file(path.join(path.dirname(target.fsPath), "train_prev.py"));

  let targetPattern = "";
  let siblingPattern = "";
  // Registered on 1.133.0, absent on the 1.85.0 engines floor; an unregistered
  // key cannot be written at all (`update` throws), so the extension probes the
  // same way and the suite asserts the matching contract.
  let diffAssocSupported = false;
  // Seeded into .vscode/settings.json by the driver script: an association Tithon
  // did not write and must never touch.
  const SEEDED_KEY = "*.bin";

  before(async () => {
    await ext().activate();
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const rel = (u: vscode.Uri) => path.relative(root, u.fsPath).split(path.sep).join("/");
    targetPattern = `**/${rel(target)}`;
    siblingPattern = `**/${rel(sibling)}`;
    diffAssocSupported =
      vscode.workspace.getConfiguration().inspect(DIFF_ASSOC)?.defaultValue !== undefined;
  });

  it("activation writes no Global *.py association", () => {
    const global = inspectAssoc()?.globalValue ?? {};
    assert.ok(
      !("*.py" in global),
      `activation must not write a Global *.py association, got ${JSON.stringify(global)}`,
    );
    assert.deepStrictEqual(
      workspaceAssoc(),
      { [SEEDED_KEY]: "hexEditor" },
      "activation must not touch the workspace associations either",
    );
  });

  it("an unassociated .py still opens as TEXT (priority: option)", async () => {
    await vscode.commands.executeCommand("vscode.open", unrelated);
    await waitFor(
      () => vscode.window.activeTextEditor?.document.uri.toString() === unrelated.toString(),
      15000,
      "unassociated .py opened as text",
    );
    assert.strictEqual(
      notebookTabsFor(unrelated).length,
      0,
      "an unassociated .py must not resolve to the Tithon notebook",
    );
  });

  it("'Always Open as Notebook' pins one workspace key and switches the open editor", async () => {
    // Realistic menu path: the file is open as TEXT and the command takes no
    // argument, resolving the target from the active editor.
    await vscode.commands.executeCommand("vscode.open", target);
    await waitFor(
      () => vscode.window.activeTextEditor?.document.uri.toString() === target.toString(),
      15000,
      "target opened as text",
    );

    await vscode.commands.executeCommand("tithon.alwaysOpenAsNotebook");

    await waitFor(() => targetPattern in workspaceAssoc(), 15000, "workspace association written");
    assert.deepStrictEqual(
      workspaceAssoc(),
      { [SEEDED_KEY]: "hexEditor", [targetPattern]: "tithon-py" },
      "the command must add exactly its own key and preserve the pre-existing one",
    );
    assert.strictEqual(
      inspectAssoc()?.globalValue?.["*.py"],
      undefined,
      "the per-file opt-in must not write anything Global",
    );

    // The write decides FUTURE opens; the command must also perform the ordered
    // text -> Cell View switch for what is on screen now.
    await waitFor(() => notebookTabsFor(target).length === 1, 20000, "switched to the Cell View");
    await waitFor(() => textTabsFor(target).length === 0, 20000, "the text tab is gone");
  });

  it("the pinned file then opens as a notebook with no text document for it", async () => {
    await closeEverything(target);

    // An open-then-convert heuristic would necessarily open the text editor
    // first; declarative resolution never creates a file-scheme text document.
    const opened: string[] = [];
    const sub = vscode.workspace.onDidOpenTextDocument((d) => {
      if (d.uri.scheme === "file" && d.uri.toString() === target.toString()) {
        opened.push(d.uri.toString());
      }
    });
    try {
      await vscode.commands.executeCommand("vscode.open", target);
      await waitFor(() => notebookTabsFor(target).length === 1, 20000, "opened directly as a notebook");
      // Give a converter the time it would have needed to act, then check.
      await new Promise((r) => setTimeout(r, 1500));
      assert.strictEqual(
        opened.length,
        0,
        `the pinned file must resolve straight to tithon-py, but a text document was opened: ${JSON.stringify(opened)}`,
      );
      assert.strictEqual(textTabsFor(target).length, 0, "no text tab for the pinned file");
    } finally {
      sub.dispose();
    }
  });

  it("an unrelated .py in the same workspace still opens as TEXT", async () => {
    await vscode.commands.executeCommand("vscode.open", unrelated);
    await waitFor(
      () => vscode.window.activeTextEditor?.document.uri.toString() === unrelated.toString(),
      15000,
      "unrelated .py opened as text",
    );
    assert.strictEqual(
      notebookTabsFor(unrelated).length,
      0,
      "the per-file association must not leak to other .py files",
    );
  });

  it("a diff of two pinned files stays a TEXT diff", async () => {
    // BOTH sides pinned: measured on 1.85.0 and 1.133.0, a notebook diff appears
    // only when both sides match an association — which is exactly the shape of a
    // git diff, whose `git:` and `file:` URIs share the path the pattern matches.
    // With one side unassociated the diff is textual anyway, so pinning only the
    // target would make this assertion pass vacuously.
    await vscode.commands.executeCommand("tithon.alwaysOpenAsNotebook", sibling);
    await waitFor(() => siblingPattern in workspaceAssoc(), 15000, "sibling association written");
    await closeEverything(target);

    await vscode.commands.executeCommand("vscode.diff", sibling, target, "train_prev ↔ train");
    await waitFor(
      () => vscode.window.tabGroups.activeTabGroup.activeTab?.input !== undefined,
      15000,
      "diff editor opened",
    );
    const input = vscode.window.tabGroups.activeTabGroup.activeTab!.input;

    // `workbench.diffEditorAssociations` is what holds the diff textual, and it
    // does not exist on the `engines.vscode` floor (1.85.0) — so assert the
    // capability and the documented degradation separately rather than pinning
    // the suite to one VSCode build.
    if (diffAssocSupported) {
      assert.deepStrictEqual(
        vscode.workspace.getConfiguration().inspect<Record<string, string>>(DIFF_ASSOC)
          ?.workspaceValue,
        { [targetPattern]: "default", [siblingPattern]: "default" },
        "pinning must add a diff-association companion for each pinned file",
      );
      assert.ok(
        input instanceof vscode.TabInputTextDiff,
        `a pinned .py diff must stay a text diff, got ${input?.constructor?.name}`,
      );
    } else {
      assert.strictEqual(
        vscode.workspace.getConfiguration().inspect(DIFF_ASSOC)?.workspaceValue,
        undefined,
        "an unregistered setting must never be written",
      );
      assert.ok(
        input instanceof vscode.TabInputNotebookDiff,
        `below the diff-association floor the diff is expected to be a notebook diff, got ${input?.constructor?.name}`,
      );
    }
  });

  it("the inverse command removes exactly its own key and text opening returns", async () => {
    await vscode.commands.executeCommand("tithon.forgetAlwaysOpenAsNotebook", target);
    await waitFor(() => !(targetPattern in workspaceAssoc()), 15000, "association removed");
    assert.deepStrictEqual(
      workspaceAssoc(),
      { [SEEDED_KEY]: "hexEditor", [siblingPattern]: "tithon-py" },
      "forget must remove only the target's key, leaving every other association intact",
    );
    if (diffAssocSupported) {
      assert.deepStrictEqual(
        vscode.workspace.getConfiguration().inspect<Record<string, string>>(DIFF_ASSOC)
          ?.workspaceValue,
        { [siblingPattern]: "default" },
        "forget must retract its own diff companion and no one else's",
      );
    }

    await closeEverything(target);
    await vscode.commands.executeCommand("vscode.open", target);
    await waitFor(
      () => vscode.window.activeTextEditor?.document.uri.toString() === target.toString(),
      20000,
      "unpinned file opens as text again",
    );
    assert.strictEqual(notebookTabsFor(target).length, 0, "no Cell View after unpinning");
  });
});
