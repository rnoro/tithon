/**
 * Tithon VSCode extension activation.
 *
 * Wires the three §3.2/§3.3 pieces:
 *  - the percent NotebookSerializer for the `tithon-py` Cell View,
 *  - a "Run Cell" CodeLens on the plain-text view that submits to the daemon,
 *  - the widget renderer messaging (push mirror snapshots to the renderer).
 * The output<->cell attachment uses the journal's cell_hash (see cellAttach).
 */
import * as path from "path";
import * as vscode from "vscode";
import { PercentNotebookSerializer } from "./notebookSerializer";
import { PercentCodeLensProvider, RUN_CELL_COMMAND } from "./codeLens";
import { DaemonClient, defaultSocketPath, type ExecOrigin } from "./daemonClient";
import { ensureDaemon } from "./daemonProcess";
import { registerRestore, workdirForUri } from "./sessionController";
import { confirmDestructive, notifyInfo, notifyWarn } from "./notify";

/* ===========================================================================
 * SINGLE-REPRESENTATION INVARIANTS — read this before editing anything below.
 *
 * A tithon-py Cell View reuses the .py's OWN `file://` URI as its notebook URI,
 * which is what keeps ruff / ty / Pylance alive inside cells. The price is that
 * notebook-aware language servers key ONE URI as both a text document and a
 * notebook document, and desync if both exist. The five rules below are what
 * keep that from happening. They are stated once here; implementation sites
 * point back to the relevant rule.
 *
 * I1. ONE representation per URI. While a URI is in `cellViewUris`, no plain
 *     text editor for that same URI may stay open (`closeStaleTextTabs`, and the
 *     `onDidChangeTabs` guard). Scoped to cell-viewed URIs only — navigating to
 *     another file still opens a normal text editor.
 *
 * I2. didClose BEFORE the opposite didOpen. `openAsNotebook` must await
 *     `closeTextDocsAndWait` (the text DOCUMENT gone, not merely the tab) before
 *     `openWith … tithon-py`; ty rejects a `notebookDocument/didOpen` for a URI
 *     it still holds as text and then fails every later didChange ("document not
 *     found"), killing go-to-definition. The wait is bounded, so a stuck
 *     buffer degrades to the racy order — never to a freeze.
 *
 * I3. Arm/disarm the guard on the correct side of the switch. `openAsNotebook`
 *     adds to `cellViewUris` FIRST (so the guard keeps the URI text-free across
 *     the switch); `openAsText` deletes FIRST (so the guard does not close the
 *     very text editor being opened).
 *
 * I4. The guard keys off a TAB-BACKED notebook, never a notebook DOCUMENT.
 *     Overlapping fast toggles can strand a tabless "zombie" notebook document
 *     that lingers in `workspace.notebookDocuments` forever; keying off it would
 *     auto-close every reopened text editor and make the .py un-openable.
 *     Hence `hasCellViewTab`, and the self-heal that DROPS a stale
 *     `cellViewUris` entry instead of eating the user's editor.
 *
 * I5. Toggles are serialized per URI (`queueToggle`). Both commands have async
 *     tails (I2's wait is up to 3s), so unserialized rapid toggles interleave two
 *     `openWith` calls and produce exactly the I4 zombie.
 *
 * These depend on VSCode/LSP internals rather than on our own API surface, so
 * unit tests alone cannot hold them.
 * ======================================================================== */

/** Find a tithon-py notebook document that corresponds to the given file URI. */
function findNotebook(fileUri: vscode.Uri): vscode.NotebookDocument | undefined {
  return vscode.workspace.notebookDocuments.find((n) => n.uri.fsPath === fileUri.fsPath);
}

/** Whether a tithon-py tab exists; a notebook document is insufficient (I4). */
function hasCellViewTab(fileUri: vscode.Uri): boolean {
  const key = fileUri.toString();
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .some(
      (t) =>
        t.input instanceof vscode.TabInputNotebook &&
        t.input.notebookType === "tithon-py" &&
        t.input.uri.toString() === key,
    );
}

/**
 * Resolve a notebook URI from a command argument.
 *
 * Different invokers hand a command different shapes: the `editor/title` menu and
 * direct callers pass a `vscode.Uri`, but the `notebook/toolbar` menu forwards a
 * notebook action-context object — `{ notebookEditor: { notebookUri } }` — NOT a
 * Uri. A handler that trusts the raw arg then calls `vscode.openWith` on a plain
 * object and fails with "Invalid argument 'resource'" (silently, from a toolbar
 * button) — the cause of "Open as Text does nothing". Unwrap the known shapes;
 * return undefined for anything else so the caller can fall back.
 */
function resolveNotebookUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  if (arg && typeof arg === "object") {
    const o = arg as Record<string, unknown>;
    const ne = o.notebookEditor as Record<string, unknown> | undefined;
    const candidate = ne?.notebookUri ?? o.notebookUri ?? o.uri;
    if (candidate instanceof vscode.Uri) return candidate;
  }
  return undefined;
}

/**
 * The file a per-file command should act on, from either representation. The
 * notebook editor is consulted BEFORE the text editor: inside a Cell View,
 * `activeTextEditor` is the focused CELL (`vscode-notebook-cell:`), not the .py.
 */
function resolveTargetUri(arg: unknown): vscode.Uri | undefined {
  return (
    resolveNotebookUri(arg) ??
    vscode.window.activeNotebookEditor?.notebook.uri ??
    vscode.window.activeTextEditor?.document.uri
  );
}

/** Close every open Cell-View (tithon-py notebook) tab for `uriStr`. */
async function closeCellViewTabs(uriStr: string): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t) =>
        t.input instanceof vscode.TabInputNotebook &&
        t.input.notebookType === "tithon-py" &&
        t.input.uri.toString() === uriStr,
    );
  if (tabs.length) {
    try {
      await vscode.window.tabGroups.close(tabs, true);
    } catch {
      /* a dirty/locked tab may refuse; openWith below still switches focus */
    }
  }
}

/** True for a notebook backed by Tithon's Cell View. */
function isTithon(nb: vscode.NotebookDocument): boolean {
  return nb.notebookType === "tithon-py";
}

/** URIs currently guarded as tithon-py notebooks (I1). */
const cellViewUris = new Set<string>();
let alwaysOpenWithPickerOpen = false;

/** Execute text<->notebook transitions sequentially per URI (I5). */
const toggleQueues = new Map<string, Promise<unknown>>();
function queueToggle(uriStr: string, op: () => Promise<void>): Promise<void> {
  const prev = toggleQueues.get(uriStr) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(op);
  toggleQueues.set(uriStr, next);
  // Drop the entry once this op is the tail, so the map can't grow unbounded.
  void next
    .catch(() => {})
    .finally(() => {
      if (toggleQueues.get(uriStr) === next) toggleQueues.delete(uriStr);
    });
  return next;
}

/** Close every plain-text editor tab showing `uriStr` (a coexisting text view
 * of a Cell View). Notebook/custom tabs are left untouched. */
async function closeStaleTextTabs(uriStr: string): Promise<void> {
  const stale = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uriStr);
  if (stale.length) {
    try {
      await vscode.window.tabGroups.close(stale, true);
    } catch {
      /* a dirty/locked tab may refuse; best-effort single-representation */
    }
  }
}

/** Close text tabs and wait, boundedly, for the underlying document to close (I2). */
async function closeTextDocsAndWait(uriStr: string): Promise<void> {
  await closeStaleTextTabs(uriStr);
  const stillOpen = (): boolean =>
    vscode.workspace.textDocuments.some(
      (d) => d.uri.scheme === "file" && d.uri.toString() === uriStr,
    );
  const deadline = Date.now() + 3000;
  while (stillOpen() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30));
  }
}

function trackCellView(nb: vscode.NotebookDocument): void {
  if (!isTithon(nb)) return;
  cellViewUris.add(nb.uri.toString());
  void closeStaleTextTabs(nb.uri.toString());
}

/**
 * Redirect Pylance's `<notebook>.py.py` pseudo-path go-to-definition.
 *
 * For an in-notebook definition Pylance answers with a `file://` Location whose
 * path is the notebook uri's path plus an EXTRA `.py`, carrying the target
 * cell's handle in the fragment — e.g. `file:///x/a.py.py#W0sZmlsZQ==`. For a
 * normal `.ipynb` notebook (`a.ipynb` → `a.ipynb.py`) that pseudo-path round-
 * trips back to a `vscode-notebook-cell:` uri and navigation stays in-notebook;
 * but a tithon-py notebook reuses the `.py`'s OWN uri (ADR-041), so the pseudo-
 * path is `a.py.py` and the round-trip never fires — VSCode instead opens a
 * phantom text tab for the non-existent `a.py.py` file ("go-to-def opens
 * a.py.py"). We detect that phantom tab, close it, and reveal the real cell the
 * fragment points at. Scheme-agnostic across the LSP: anything that routes a
 * definition/declaration/reference through the pseudo-path lands here.
 *
 * Guarded so it can never hijack a genuine user file literally named `*.py.py`:
 * it acts ONLY when the de-doubled path is an OPEN tithon-py notebook AND the
 * fragment matches one of that notebook's live cells.
 */
async function redirectPseudoPathDefinition(tab: vscode.Tab): Promise<void> {
  if (!(tab.input instanceof vscode.TabInputText)) return;
  const uri = tab.input.uri;
  if (uri.scheme !== "file" || !uri.path.endsWith(".py.py") || !uri.fragment) return;
  // De-double: drop the trailing extra ".py" to recover the notebook path.
  const nbPath = uri.fsPath.slice(0, -3); // ".../a.py.py" -> ".../a.py"
  const nb = vscode.workspace.notebookDocuments.find(
    (n) => n.notebookType === "tithon-py" && n.uri.fsPath === nbPath,
  );
  if (!nb) return; // not a tithon-py pseudo-path
  const cell = nb.getCells().find((c) => c.document.uri.fragment === uri.fragment);
  if (!cell) return; // fragment is not a live cell handle — leave the tab alone
  try {
    await vscode.window.tabGroups.close(tab, true);
  } catch {
    /* a dirty/locked tab may refuse; the reveal below still helps */
  }
  try {
    const ed = await vscode.window.showNotebookDocument(nb);
    const range = new vscode.NotebookRange(cell.index, cell.index + 1);
    ed.selection = range;
    ed.revealRange(range, vscode.NotebookEditorRevealType.InCenter);
  } catch {
    /* best-effort navigation */
  }
}

/* ===========================================================================
 * DURABLE "open this .py as a Notebook" — the editor-association rules.
 *
 * `contributes.notebooks[].priority: "option"` keeps an unassociated `.py`
 * resolving to the TEXT editor while `vscode.openWith(uri, "tithon-py")` still
 * works, so Tithon writes NOTHING to settings just to stay out of the way. The
 * only settings write left is the user's explicit per-file opt-in below.
 *
 * A1. Write ONLY `inspect().workspaceValue`, never the object `get()` returns.
 *     `get()` merges User + Workspace, so spreading it into a Workspace update
 *     copies the user's unrelated associations into a COMMITTED
 *     `.vscode/settings.json`.
 *
 * A2. Resolution is longest-pattern-STRING-wins, not semantic specificity
 *     (`getRawAssociationsForResourceFromSetting` sorts by
 *     `filenamePattern.length` desc; `getConfiguredDefaultEditor` takes `[0]`),
 *     and per key a Workspace value beats a User one. That is what lets a
 *     `**`+`/<rel>.py` pattern outrank a pre-existing User `*.py`. Equal-length
 *     matches are an unordered tie — do not rely on precedence there.
 *
 * A3. A pattern containing `/` is matched against `` `${scheme}:${uri.path}` ``,
 *     one without `/` against the basename alone. Measured consequences: an
 *     ABSOLUTE `/abs/x.py` pattern never matches, and neither does a
 *     scheme-qualified `file:` + `**`+`/x.py`. Only a bare suffix glob matches.
 *
 * A4. Config alone does not switch an ALREADY-OPEN editor, and must not try to
 *     by itself: the text -> Cell View switch is the ordered, serialized
 *     `openAsNotebook` path (I2/I5 above). The command writes the key, then
 *     delegates the switch to that command.
 *
 * A5. There is no per-session "prefer text" override. `openAsText` stays a
 *     per-open escape hatch that leaves the association alone — a session-state
 *     override reintroduces a per-session state machine that strands a file
 *     opening as plain text after a couple of reopens.
 *
 * A6. A DIFF resolves to the notebook diff editor only when BOTH sides match an
 *     association (measured: one side pinned still gives a text diff, both gives
 *     a notebook diff, on 1.85.0 and 1.133.0 alike). A git diff pairs `git:` and
 *     `file:` URIs of the SAME path, and the pattern matches on the path, so
 *     pinning a file silently turns its source-control diffs into notebook
 *     diffs. A `.py` carries no outputs, so that trades line-level review for
 *     cell chrome; `workbench.diffEditorAssociations` -> "default" keeps it
 *     textual. Diff resolution reads that setting FIRST and falls back to
 *     `workbench.editorAssociations` only when it matched nothing, so the entry
 *     REPLACES rather than merges — which is also why forgetting a file must
 *     retract it, or a stale entry keeps overriding that path. The setting does
 *     not exist on the `engines.vscode` floor, hence the capability check —
 *     see `isRegisteredSetting`.
 * ======================================================================== */

const ASSOCIATIONS_KEY = "workbench.editorAssociations";
const DIFF_ASSOCIATIONS_KEY = "workbench.diffEditorAssociations";

/**
 * Is `key` a registered configuration on the VSCode running us? `update()` on an
 * unregistered key THROWS ("not a registered configuration"), and
 * `workbench.diffEditorAssociations` is absent on our `engines.vscode` floor
 * (measured: registered on 1.133.0, not on 1.85.0). `inspect()` answers without
 * throwing — an unregistered key comes back as `{ key }` alone, a registered one
 * always carries a `defaultValue`.
 */
function isRegisteredSetting(key: string): boolean {
  return vscode.workspace.getConfiguration().inspect(key)?.defaultValue !== undefined;
}

/**
 * The association pattern that pins ONE file to the Cell View, or undefined when
 * the file is outside every workspace folder (nothing to scope a Workspace write
 * to). Root-relative, so `**` + `/sub/train.py` outranks a User `*.py` by A2.
 *
 * This is a suffix glob, not a file identity: in a multi-root window two roots
 * with the same relative path collide. Lengthening the suffix until exactly one
 * workspace file matches is the known refinement.
 */
function associationPatternFor(uri: vscode.Uri): string | undefined {
  // Both commands can be reached from the palette, where the target falls back
  // to whatever editor is active — pinning a .md (or a `git:` revision) to a
  // Python notebook type would be a resolution the user could not undo from the
  // same menu, since the inverse only offers itself for a .py.
  if (uri.scheme !== "file" || !uri.path.toLowerCase().endsWith(".py")) return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
  if (!rel || rel.startsWith("..")) return undefined;
  return `**/${rel}`;
}

/**
 * Apply `mutate` to the WORKSPACE-scoped value of `key` only (A1) and write the
 * result back. Returns false when there is nothing to change. Rejections are
 * left to the caller to surface — a silently dropped write leaves the user with
 * a menu item that appears to do nothing.
 */
async function updateWorkspaceAssociations(
  key: string,
  mutate: (assoc: Record<string, string>) => boolean,
): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration();
  const current = cfg.inspect<Record<string, string>>(key)?.workspaceValue ?? {};
  const next = { ...current };
  if (!mutate(next)) return false;
  await cfg.update(
    key,
    Object.keys(next).length ? next : undefined,
    vscode.ConfigurationTarget.Workspace,
  );
  return true;
}

/**
 * Keep `pattern`'s diffs textual while it is pinned (A6). Best effort by design:
 * the setting is missing below VSCode ~1.9x, where the only consequence is that
 * this file's git diffs render as notebook diffs — the pin itself still works,
 * so this must never abort it.
 */
async function syncDiffAssociation(pattern: string, pinned: boolean): Promise<void> {
  if (!isRegisteredSetting(DIFF_ASSOCIATIONS_KEY)) return;
  try {
    await updateWorkspaceAssociations(DIFF_ASSOCIATIONS_KEY, (assoc) => {
      if (pinned) {
        if (assoc[pattern] === "default") return false;
        assoc[pattern] = "default";
        return true;
      }
      if (assoc[pattern] !== "default") return false;
      delete assoc[pattern];
      return true;
    });
  } catch (err) {
    vscode.window.showWarningMessage(
      `Tithon: the editor association was saved, but this file's diffs could not be kept textual — ${String(err)}`,
    );
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const client = new DaemonClient();

  // The reconnect/restore half (subscribe -> fold -> restore -> attach).
  // Also owns the executeHandler so the native cell play button works.
  const notebookCtrl = registerRestore(context);

  // Auto-restore + live sync is driven by the controller's kernel-selection
  // event (see TithonNotebookController): when the Tithon kernel becomes the
  // notebook's selected kernel — which VSCode does automatically on reopen by
  // remembering the last kernel — it attach(0)s, restores folded output + cell
  // state, and continues live. The user runs NO command (the "it should just
  // work" feedback #3/#4). Here we only need to tear down on close as a belt:
  context.subscriptions.push(
    vscode.workspace.onDidCloseNotebookDocument((nb) => {
      if (isTithon(nb)) {
        notebookCtrl.disposeLive(nb.uri);
        cellViewUris.delete(nb.uri.toString());
      }
    }),
  );

  // Track auto-reopened notebooks and reject a second representation (I1).
  vscode.workspace.notebookDocuments.forEach(trackCellView);
  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument(trackCellView),
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of [...e.opened, ...e.changed]) {
        if (
          tab.input instanceof vscode.TabInputText &&
          cellViewUris.has(tab.input.uri.toString())
        ) {
          // A stale set entry must self-heal instead of closing the user's tab (I4).
          if (hasCellViewTab(tab.input.uri)) {
            void closeStaleTextTabs(tab.input.uri.toString());
          } else {
            cellViewUris.delete(tab.input.uri.toString());
          }
        }
      }
      // Redirect Pylance's `<notebook>.py.py` go-to-definition phantom tab to the
      // real cell (the pseudo-path never round-trips for a tithon-py notebook).
      for (const tab of e.opened) {
        void redirectPseudoPathDefinition(tab);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(
      "tithon-py",
      new PercentNotebookSerializer(),
      // Cell OUTPUTS live in the daemon journal, never in the `.py` on disk (the
      // serializer writes pure percent-format code, no outputs). Mark them
      // transient so VSCode does NOT treat live output writes as unsaved edits:
      // otherwise every appendOutput/clear makes the notebook "dirty" but the save
      // never persists outputs, so it can never reconcile to clean — autosave then
      // fires every ~1s ("saving…" in the status bar) and the constant churn lags
      // the editor. transientOutputs lets restore/live-sync write freely with no
      // phantom dirty state. (The verbatim `tithonCell` metadata stays persistent.)
      { transientOutputs: true },
    ),
    vscode.languages.registerCodeLensProvider(
      { language: "python", scheme: "file" },
      new PercentCodeLensProvider(),
    ),
    vscode.commands.registerCommand(
      RUN_CELL_COMMAND,
      async (arg: { code: string; origin: ExecOrigin }) => {
        try {
          // Auto-start live sync so output appears without a manual step.
          // Active notebook editor takes priority; fall back to any open notebook
          // for the same file (covers the text-editor CodeLens path).
          const nb =
            vscode.window.activeNotebookEditor?.notebook ??
            (vscode.window.activeTextEditor
              ? findNotebook(vscode.window.activeTextEditor.document.uri)
              : undefined);
          await ensureDaemon(defaultSocketPath()); // auto-start host daemon if down
          if (nb) {
            await notebookCtrl.ensureLive(nb);
            notebookCtrl.refreshLive(nb); // pick up cells added since live started (ADR-022)
          }

          const workdir = workdirForUri(vscode.Uri.parse(arg.origin.uri));
          // Enable the input()/getpass() bridge only when a Cell View is attached
          // to present the input box; without one (a bare text-editor run) keep
          // allow_stdin off so input() fails fast instead of hanging (ADR-050).
          const execId = await client.execute(arg.code, arg.origin, workdir, nb !== undefined);
          // Deliberately the status bar, not a notification: this fires on EVERY
          // run, and "Run All" over a 40-cell file would stack 40 toasts. Command
          // outcomes go through `notify.ts`; per-execution chatter does not.
          vscode.window.setStatusBarMessage(`Tithon: submitted ${execId}`, 3000);
        } catch (err) {
          vscode.window.showErrorMessage(`Tithon: ${String(err)}`);
        }
      },
    ),
    // Kernel control (Jupyter parity): restart gives a fresh namespace, interrupt
    // stops a runaway cell. Both act on the active notebook's per-file kernel.
    // Restart destroys the namespace this whole system exists to keep alive, so
    // it asks first (see `confirmDestructive`) — the toolbar button sits one
    // click away from ▶ and a mis-click costs a multi-hour training state.
    vscode.commands.registerCommand("tithon.restartKernel", async () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      if (!nb) return;
      const name = path.basename(nb.uri.fsPath);
      const ok = await confirmDestructive({
        message: `Restart the kernel for ${name}?`,
        detail:
          "The Python process is replaced: every variable, import and loaded model is lost, and any running cell stops. Previous outputs stay restorable.",
        confirmLabel: "Restart",
      });
      if (!ok) return;
      try {
        await notebookCtrl.restartKernel(nb);
        notifyInfo(`Tithon: kernel restarted (${name})`);
      } catch (err) {
        vscode.window.showErrorMessage(`Tithon restart: ${String(err)}`);
      }
    }),
    // Open the active .py (or a given uri) as the Tithon Cell View notebook.
    // A .py resolves to TEXT unless associated (`priority: "option"`), so this is
    // the one-off opt-in; `tithon.alwaysOpenAsNotebook` is the durable one.
    vscode.commands.registerCommand("tithon.openAsNotebook", async (arg?: vscode.Uri) => {
      const uri = arg ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        notifyWarn("Tithon: open a .py file first");
        return;
      }
      return queueToggle(uri.toString(), async () => {
        // Arm before closing; open only after the text document is gone (I2/I3/I5).
        cellViewUris.add(uri.toString());
        await closeTextDocsAndWait(uri.toString());
        await vscode.commands.executeCommand("vscode.openWith", uri, "tithon-py");
      });
    }),
    // Reopen the active Tithon notebook as a plain text editor. Invoked from the
    // notebook/toolbar button; normalize its action context via resolveNotebookUri.
    vscode.commands.registerCommand("tithon.openAsText", async (arg?: unknown) => {
      const uri = resolveNotebookUri(arg) ?? vscode.window.activeNotebookEditor?.notebook.uri;
      if (!uri) {
        notifyWarn("Tithon: no notebook to open as text");
        return;
      }
      // Disarm before closing; both directions share the per-URI queue (I3/I5).
      return queueToggle(uri.toString(), async () => {
        try {
          cellViewUris.delete(uri.toString());
          await closeCellViewTabs(uri.toString());
          await vscode.commands.executeCommand("vscode.openWith", uri, "default");
        } catch (err) {
          vscode.window.showErrorMessage(`Tithon open as text: ${String(err)}`);
        }
      });
    }),
    // One durable choice, shaped like VSCode's Open With picker. The public
    // menus expose only this command; the two legacy commands below stay
    // registered so existing keybindings and integrations keep working.
    vscode.commands.registerCommand("tithon.alwaysOpenWith", async (arg?: unknown) => {
      const uri = resolveTargetUri(arg);
      const pattern = uri ? associationPatternFor(uri) : undefined;
      if (!uri || !pattern) {
        notifyWarn("Tithon: choose a .py file inside the open workspace folder first");
        return;
      }

      type EditorPick = vscode.QuickPickItem & { editorId: "default" | "tithon-py" };
      let pick: EditorPick | undefined;
      alwaysOpenWithPickerOpen = true;
      try {
        pick = await vscode.window.showQuickPick<EditorPick>(
          [
            { label: "$(file-code) Text Editor", editorId: "default" },
            { label: "$(notebook) Notebook", editorId: "tithon-py" },
          ],
          {
            title: "Always Open With…",
            placeHolder: `Choose how ${path.basename(uri.fsPath)} opens in this workspace`,
          },
        );
      } finally {
        alwaysOpenWithPickerOpen = false;
      }
      if (!pick) return;

      if (pick.editorId === "tithon-py") {
        await vscode.commands.executeCommand("tithon.alwaysOpenAsNotebook", uri);
        return;
      }

      try {
        await updateWorkspaceAssociations(ASSOCIATIONS_KEY, (assoc) => {
          if (assoc[pattern] === "default") return false;
          assoc[pattern] = "default";
          return true;
        });
        // The exact `default` entry already makes diffs textual. Do not delete
        // an existing diff entry: VSCode exposes no provenance that could tell
        // Tithon's companion apart from the user's same-pattern preference.
        await vscode.commands.executeCommand("tithon.openAsText", uri);
        notifyInfo(
          `Tithon: ${path.basename(uri.fsPath)} now opens in the Text Editor in this workspace`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Tithon: could not save the editor association — ${String(err)}`,
        );
      }
    }),
    // Make this ONE file open as the Cell View from now on, in this workspace.
    // `priority: "option"` means an unassociated .py resolves to text, so the
    // durable choice is exactly this key and nothing else (see the A1-A5 block).
    vscode.commands.registerCommand("tithon.alwaysOpenAsNotebook", async (arg?: unknown) => {
      const uri = resolveTargetUri(arg);
      if (!uri) {
        notifyWarn("Tithon: open a .py file first");
        return;
      }
      const pattern = associationPatternFor(uri);
      if (!pattern) {
        notifyWarn(
          "Tithon: this only applies to a .py file inside the open workspace folder — there is nowhere to save the choice otherwise.",
        );
        return;
      }
      try {
        await updateWorkspaceAssociations(ASSOCIATIONS_KEY, (assoc) => {
          if (assoc[pattern] === "tithon-py") return false;
          assoc[pattern] = "tithon-py";
          return true;
        });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Tithon: could not save the editor association — ${String(err)}`,
        );
        return;
      }
      await syncDiffAssociation(pattern, true);
      // A4: the association decides FUTURE opens. Switching what is on screen
      // now is the ordered, serialized toggle's job — never an ad-hoc openWith.
      if (!hasCellViewTab(uri)) {
        await vscode.commands.executeCommand("tithon.openAsNotebook", uri);
      }
      notifyInfo(`Tithon: ${path.basename(uri.fsPath)} now opens as a Notebook in this workspace`);
    }),
    // The inverse. Removes only its own key; every other association — including
    // ones the user or VSCode's own "Configure default editor" wrote — is left
    // byte-identical. Deliberately does NOT close the Cell View on screen: this
    // is about future opens, and "Open as Text" is the per-open escape (A5).
    vscode.commands.registerCommand("tithon.forgetAlwaysOpenAsNotebook", async (arg?: unknown) => {
      const uri = resolveTargetUri(arg);
      const pattern = uri ? associationPatternFor(uri) : undefined;
      if (!uri || !pattern) {
        notifyWarn("Tithon: open a .py file inside the workspace folder first");
        return;
      }
      try {
        const changed = await updateWorkspaceAssociations(ASSOCIATIONS_KEY, (assoc) => {
          if (assoc[pattern] !== "tithon-py") return false;
          delete assoc[pattern];
          return true;
        });
        await syncDiffAssociation(pattern, false);
        if (changed) {
          notifyInfo(`Tithon: ${path.basename(uri.fsPath)} opens as text again`);
        } else {
          notifyWarn(`Tithon: ${path.basename(uri.fsPath)} was not pinned to the Notebook view`);
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Tithon: could not update the editor association — ${String(err)}`,
        );
      }
    }),
    // Palette/keybinding entry to the same interrupt the cell ⏹ uses. It reports
    // its own outcome, so there is nothing to wrap here (see `interruptKernel`).
    vscode.commands.registerCommand("tithon.interruptKernel", async () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      if (nb) await notebookCtrl.interruptKernel(nb);
    }),
    // Test affordance for asserting the single-representation bookkeeping.
    vscode.commands.registerCommand("tithon._cellViewState", () => ({
      cellViewUris: [...cellViewUris],
    })),
    // Lets the real-VSCode suite wait for the picker itself before sending UI
    // navigation commands; a timer would race the Extension Host under load.
    vscode.commands.registerCommand("tithon._alwaysOpenWithState", () => ({
      pickerOpen: alwaysOpenWithPickerOpen,
    })),
    // Test affordance: which lost-kernel ("state cleared") warnings have fired,
    // as `${uri}#${pid}`. Lets an integration test assert the host-reboot signal
    // reached the client without depending on notification UI.
    vscode.commands.registerCommand("tithon._lostStateWarnings", () =>
      notebookCtrl.lostStateWarnings(),
    ),
  );
}

export function deactivate(): void {
  /* nothing to tear down: the daemon and kernel outlive the extension host */
}
