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
 *   (b) `tithon.alwaysOpenWith` — one Explorer/editor/toolbar command whose
 *       real Quick Pick writes ONE Workspace-scoped key per file, `**` +
 *       `/<workspace-relative path>`, which outranks any User `*.py` by
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

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Drive the actual Quick Pick instead of bypassing the public chooser. */
async function chooseAlwaysOpenWith(
  arg: unknown,
  choice: "text" | "notebook" | "cancel",
): Promise<void> {
  const done = vscode.commands.executeCommand("tithon.alwaysOpenWith", arg);
  await waitFor(
    async () =>
      (await vscode.commands.executeCommand<{ pickerOpen: boolean }>(
        "tithon._alwaysOpenWithState",
      )).pickerOpen,
    5000,
    "Always Open With Quick Pick opened",
  );
  if (choice === "cancel") {
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
  } else {
    if (choice === "notebook") {
      await vscode.commands.executeCommand("workbench.action.quickOpenSelectNext");
    }
    await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  }
  await done;
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

  it("contributes one non-duplicated Always Open With surface", () => {
    const contributes = ext().packageJSON.contributes;
    const commands = contributes.commands as Array<{
      command: string;
      title: string;
      category?: string;
    }>;
    assert.strictEqual(
      contributes.notebooks.find((n: { type: string }) => n.type === "tithon-py")?.displayName,
      "Notebook",
      "VSCode appends the provider name; the notebook name must not repeat Tithon",
    );
    assert.deepStrictEqual(
      commands
        .filter((c) => c.command === "tithon.alwaysOpenWith")
        .map((c) => ({ title: c.title, category: c.category })),
      [{ title: "Always Open With…", category: "Tithon" }],
      "the durable chooser must have one user-facing command name",
    );
    assert.deepStrictEqual(
      commands.filter((c) => c.category === "Tithon" && c.title.startsWith("Tithon")),
      [],
      "the category already renders Tithon; command titles must not repeat it",
    );

    const menus = contributes.menus as Record<string, Array<{ command: string; when?: string }>>;
    for (const surface of ["explorer/context", "editor/title", "notebook/toolbar"]) {
      assert.strictEqual(
        menus[surface].filter((m) => m.command === "tithon.alwaysOpenWith").length,
        1,
        `${surface} must expose exactly one durable chooser`,
      );
    }
    assert.deepStrictEqual(
      menus["explorer/context"].find((m) => m.command === "tithon.alwaysOpenWith")?.when,
      "resourceScheme == file && resourceExtname == .py",
      "Explorer must offer the chooser only for local .py files",
    );
    for (const legacy of [
      "tithon.alwaysOpenAsNotebook",
      "tithon.forgetAlwaysOpenAsNotebook",
    ]) {
      assert.strictEqual(
        menus.commandPalette.find((m) => m.command === legacy)?.when,
        "false",
        `${legacy} must remain contributed for activation compatibility but hidden from users`,
      );
    }
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

  it("the Explorer-style chooser pins Notebook and switches the open editor", async () => {
    // A direct Uri is the argument shape VSCode's explorer/context menu sends.
    await chooseAlwaysOpenWith(target, "notebook");

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

  it("cancelling the chooser changes neither settings nor representation", async () => {
    const beforeAssoc = workspaceAssoc();
    const beforeDiff =
      vscode.workspace.getConfiguration().inspect<Record<string, string>>(DIFF_ASSOC)
        ?.workspaceValue;

    await chooseAlwaysOpenWith(target, "cancel");

    assert.deepStrictEqual(workspaceAssoc(), beforeAssoc, "cancel changed editor associations");
    assert.deepStrictEqual(
      vscode.workspace.getConfiguration().inspect<Record<string, string>>(DIFF_ASSOC)
        ?.workspaceValue,
      beforeDiff,
      "cancel changed diff associations",
    );
    assert.strictEqual(notebookTabsFor(target).length, 1, "cancel switched the visible editor");
    assert.strictEqual(textTabsFor(target).length, 0, "cancel opened a text editor");
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

  it("the notebook-toolbar chooser pins Text even over a broad Notebook association", async () => {
    await vscode.workspace.getConfiguration().update(
      ASSOC,
      { ...workspaceAssoc(), "*.py": "tithon-py" },
      vscode.ConfigurationTarget.Workspace,
    );

    // The real notebook toolbar sends this action-context object, not a Uri.
    await chooseAlwaysOpenWith({ notebookEditor: { notebookUri: target } }, "text");
    await waitFor(
      () => workspaceAssoc()[targetPattern] === "default",
      15000,
      "explicit Text Editor association written",
    );
    assert.deepStrictEqual(
      workspaceAssoc(),
      {
        [SEEDED_KEY]: "hexEditor",
        [targetPattern]: "default",
        [siblingPattern]: "tithon-py",
        "*.py": "tithon-py",
      },
      "Text must replace only the target key and preserve broader/unrelated associations",
    );
    if (diffAssocSupported) {
      assert.deepStrictEqual(
        vscode.workspace.getConfiguration().inspect<Record<string, string>>(DIFF_ASSOC)
          ?.workspaceValue,
        { [targetPattern]: "default", [siblingPattern]: "default" },
        "Text must not delete a same-pattern diff preference with unknown provenance",
      );
    }

    await waitFor(
      () => vscode.window.activeTextEditor?.document.uri.toString() === target.toString(),
      20000,
      "chooser switched the Cell View to text",
    );
    assert.strictEqual(notebookTabsFor(target).length, 0, "Cell View stayed open after Text choice");

    await closeEverything(target);
    await vscode.commands.executeCommand("vscode.open", target);
    await waitFor(
      () => vscode.window.activeTextEditor?.document.uri.toString() === target.toString(),
      20000,
      "specifically pinned file opens as text despite broad Notebook association",
    );
    assert.strictEqual(notebookTabsFor(target).length, 0, "specific Text choice lost to broad Notebook");

    const withoutBroad = { ...workspaceAssoc() };
    delete withoutBroad["*.py"];
    await vscode.workspace.getConfiguration().update(
      ASSOC,
      withoutBroad,
      vscode.ConfigurationTarget.Workspace,
    );
  });

  it("the hidden legacy inverse remains callable for existing integrations", async () => {
    await vscode.commands.executeCommand("tithon.forgetAlwaysOpenAsNotebook", sibling);
    await waitFor(() => !(siblingPattern in workspaceAssoc()), 15000, "legacy association removed");
    assert.deepStrictEqual(
      workspaceAssoc(),
      { [SEEDED_KEY]: "hexEditor", [targetPattern]: "default" },
      "legacy inverse must remove only its own Notebook key",
    );
    if (diffAssocSupported) {
      assert.deepStrictEqual(
        vscode.workspace.getConfiguration().inspect<Record<string, string>>(DIFF_ASSOC)
          ?.workspaceValue,
        { [targetPattern]: "default" },
        "legacy inverse must leave the Text choice's diff entry alone",
      );
    }
  });
});
