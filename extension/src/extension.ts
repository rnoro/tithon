/**
 * Tithon VSCode extension activation (Phase 0 spike).
 *
 * Wires the three §3.2/§3.3 pieces verified in Phase 0:
 *  - the percent NotebookSerializer for the `tithon-py` Cell View,
 *  - a "Run Cell" CodeLens on the plain-text view that submits to the daemon,
 *  - the widget renderer messaging (push mirror snapshots to the renderer).
 * The output<->cell attachment uses the journal's cell_hash (see cellAttach).
 */
import * as vscode from "vscode";
import { PercentNotebookSerializer } from "./notebookSerializer";
import { PercentCodeLensProvider, RUN_CELL_COMMAND } from "./codeLens";
import { DaemonClient, defaultSocketPath, type ExecOrigin } from "./daemonClient";
import { ensureDaemon } from "./daemonProcess";
import { registerRestore, workdirForUri } from "./sessionController";

/** Find a tithon-py notebook document that corresponds to the given file URI. */
function findNotebook(fileUri: vscode.Uri): vscode.NotebookDocument | undefined {
  return vscode.workspace.notebookDocuments.find(
    (n) => n.uri.fsPath === fileUri.fsPath,
  );
}

/**
 * Is a tithon-py Cell View TAB currently on screen for this URI? Deliberately
 * distinct from `findNotebook` (which finds a notebook DOCUMENT): overlapping
 * fast toggles can strand a TABLESS "zombie" notebook document (ADR-065) that
 * lingers in `workspace.notebookDocuments` with no editor. The single-
 * representation guard must key off a real, VISIBLE notebook tab — not a zombie
 * document — otherwise it auto-closes a reopened text editor for a file that has
 * no Cell View on screen, and the .py becomes un-openable.
 */
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

/**
 * URIs currently presented as a Tithon Cell View.
 *
 * A tithon-py notebook reuses the .py's OWN file:// URI as its notebook URI (see
 * findNotebook). Notebook-aware Python language servers (ruff, ty, Pylance) key
 * documents by URI, so if the same .py is ALSO open as a plain text editor they
 * register one URI as both a text document AND a notebook document and desync:
 * ruff drops the cell ("vscode-notebook-cell://… isn't open"), ty's per-URI
 * controller collapses ("Document controller not available at file://…"), and
 * cell IntelliSense/diagnostics die. So we enforce a SINGLE representation per
 * URI: while a .py is a Cell View, no plain text editor for that same URI may
 * coexist. This is scoped to the cell-viewed URI only — navigating elsewhere
 * (go-to-definition into another file) still opens a normal text editor.
 */
const cellViewUris = new Set<string>();

/**
 * Per-URI serialization of the text<->Cell-View toggle. `openAsCellView` and
 * `openAsText` both issue async `vscode.openWith` calls plus tab closes, and
 * ADR-064's `closeTextDocsAndWait` keeps `openAsCellView` running for up to 3s.
 * So if the user toggles fast, command N's async tail can still be in flight when
 * command N+1 starts — two conflicting `openWith` calls interleave and strand a
 * TABLESS "zombie" notebook document: `findNotebook` then returns it forever, so
 * `cellViewUris` never clears, the single-representation guard auto-closes every
 * reopened text editor, and the .py won't reopen (ADR-065). Chaining both
 * commands through one per-URI queue makes rapid toggles apply sequentially so
 * the last toggle wins deterministically and no half-open state is left behind.
 */
const toggleQueues = new Map<string, Promise<unknown>>();
function queueToggle(uriStr: string, op: () => Promise<void>): Promise<void> {
  const prev = toggleQueues.get(uriStr) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(op);
  toggleQueues.set(uriStr, next);
  // Drop the entry once this op is the tail, so the map can't grow unbounded.
  void next.catch(() => {}).finally(() => {
    if (toggleQueues.get(uriStr) === next) toggleQueues.delete(uriStr);
  });
  return next;
}

/** Close every plain-text editor tab showing `uriStr` (a coexisting text view
 * of a Cell View). Notebook/custom tabs are left untouched. */
async function closeStaleTextTabs(uriStr: string): Promise<void> {
  const stale = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t) =>
        t.input instanceof vscode.TabInputText &&
        t.input.uri.toString() === uriStr,
    );
  if (stale.length) {
    try {
      await vscode.window.tabGroups.close(stale, true);
    } catch {
      /* a dirty/locked tab may refuse; best-effort single-representation */
    }
  }
}

/**
 * Close every plain-text editor for `uriStr` AND wait until its underlying text
 * DOCUMENT is gone from the workspace — i.e. the LSP `textDocument/didClose` has
 * been dispatched.
 *
 * A tithon-py notebook reuses the .py's OWN file:// URI (ADR-041), so a
 * notebook-aware Python LSP (ty/ruff) keys both representations under one URI. ty
 * REJECTS a `notebookDocument/didOpen` for a URI it still holds as a text
 * document, then errors every later `notebookDocument/didChange`
 * ("document not found …baseline.py") and go-to-definition dies. So a Cell View
 * must only open once NO file-scheme text document for the URI remains — closing
 * the tab is not enough, the document close (which drives the LSP didClose) lands
 * a tick later. Bounded by a short deadline so a stuck/dirty buffer can't hang
 * the switch (worst case we fall back to the old racy order, never a freeze).
 */
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

/**
 * Make .py open as TEXT by default. The tithon-py notebook needs a `*.py`
 * selector so `Open as Cell View` (vscode.openWith) works, but a notebook
 * selector also makes it the DEFAULT editor for .py — which the user does not
 * want. So we yield the default back to the text editor via editorAssociations,
 * leaving the Cell View available on demand (openWith / Reopen With). Guarded:
 * we only set it when the user has no `*.py` association, so an explicit user
 * choice (incl. "notebook as default") is never overwritten.
 */
async function ensureTextDefaultForPy(): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration();
    const assoc = cfg.get<Record<string, string>>("workbench.editorAssociations") ?? {};
    if (!("*.py" in assoc)) {
      await cfg.update(
        "workbench.editorAssociations",
        { ...assoc, "*.py": "default" },
        vscode.ConfigurationTarget.Global,
      );
    }
  } catch {
    /* settings may be read-only in some hosts; the opt-in command still works */
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const client = new DaemonClient();

  // .py opens as a plain text editor by default; Cell View is opt-in. Awaited so
  // the association is in place before the user opens a .py (activates on startup).
  await ensureTextDefaultForPy();

  // The reconnect/restore half (subscribe -> fold -> restore -> attach),
  // verified end-to-end against a real daemon by scripts/v7.
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

  // Single representation per URI (see cellViewUris). Track every tithon-py
  // notebook — including ones VSCode auto-reopens as a notebook on restart —
  // and, whenever a plain text editor for a cell-viewed URI appears (a second
  // group, a peek/reopen, etc.), close it so ruff/ty never key one URI as both
  // a text doc and a notebook doc.
  vscode.workspace.notebookDocuments.forEach(trackCellView);
  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument(trackCellView),
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of [...e.opened, ...e.changed]) {
        if (
          tab.input instanceof vscode.TabInputText &&
          cellViewUris.has(tab.input.uri.toString())
        ) {
          // Close the coexisting text editor ONLY when a real Cell View notebook
          // TAB is on screen for this URI (the genuine text+notebook LSP
          // collision, ADR-041). If cellViewUris still holds the URI but NO
          // notebook tab is visible, the entry is STALE — a ghost left by a torn-
          // down round trip, or a tabless "zombie" notebook document stranded by
          // overlapping fast toggles (ADR-065). Closing the text editor then would
          // make the .py un-openable: it flashes in the tab bar and vanishes. So
          // self-heal the stale entry instead of eating the user's editor. Keying
          // off a VISIBLE tab (not findNotebook, which a zombie document poisons)
          // is what makes the reopen reliable.
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
          vscode.window.setStatusBarMessage(`Tithon: submitted ${execId}`, 3000);
        } catch (err) {
          vscode.window.showErrorMessage(`Tithon: ${String(err)}`);
        }
      },
    ),
    // Kernel control (Jupyter parity): restart gives a fresh namespace, interrupt
    // stops a runaway cell. Both act on the active notebook's per-file kernel.
    vscode.commands.registerCommand("tithon.restartKernel", async () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      if (!nb) return;
      try {
        await notebookCtrl.restartKernel(nb);
        vscode.window.setStatusBarMessage("Tithon: kernel restarted", 3000);
      } catch (err) {
        vscode.window.showErrorMessage(`Tithon restart: ${String(err)}`);
      }
    }),
    // Open the active .py (or a given uri) as the Tithon Cell View notebook.
    // .py opens as TEXT by default now (no *.py notebook selector); this is the
    // explicit opt-in. VSCode remembers the choice per file via "keep" too.
    vscode.commands.registerCommand("tithon.openAsCellView", async (arg?: vscode.Uri) => {
      const uri = arg ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        vscode.window.showInformationMessage("Tithon: open a .py file first");
        return;
      }
      // Serialize against a concurrent openAsText for the same URI (ADR-065) so
      // rapid toggles can't interleave into a stranded zombie notebook.
      return queueToggle(uri.toString(), async () => {
        // Single representation per URI (ADR-041/ADR-064): close any coexisting
        // text editor and wait for its textDocument/didClose BEFORE opening the
        // notebook, so ty/ruff never see a notebookDocument/didOpen for a URI they
        // still hold as a text document (which they reject -> every later didChange
        // is "document not found" -> go-to-definition dies). This is the failing
        // open-as-text -> back-to-Cell-View round trip. Arm the guard first so
        // onDidChangeTabs also keeps the URI text-free across the switch.
        cellViewUris.add(uri.toString());
        await closeTextDocsAndWait(uri.toString());
        await vscode.commands.executeCommand("vscode.openWith", uri, "tithon-py");
      });
    }),
    // Reopen the active Tithon notebook as a plain text editor. Invoked from the
    // notebook/toolbar button, which forwards a `{ notebookEditor: {...} }`
    // context object — NOT a Uri (resolveNotebookUri unwraps it; fall back to the
    // active notebook editor). Drop the URI from the Cell-View set FIRST so the
    // single-representation guard (onDidChangeTabs) does not close the very text
    // editor we are opening, then close the Cell-View tab so we never leave both
    // a notebook and a text editor on the same URI (the ADR-041 LSP collision).
    vscode.commands.registerCommand("tithon.openAsText", async (arg?: unknown) => {
      const uri =
        resolveNotebookUri(arg) ?? vscode.window.activeNotebookEditor?.notebook.uri;
      if (!uri) {
        vscode.window.showInformationMessage("Tithon: no Cell View to open as text");
        return;
      }
      // Serialize against a concurrent openAsCellView for the same URI (ADR-065)
      // so rapid toggles can't interleave into a stranded zombie notebook.
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
    vscode.commands.registerCommand("tithon.interruptKernel", async () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      if (!nb) return;
      try {
        await notebookCtrl.interruptKernel(nb);
        vscode.window.setStatusBarMessage("Tithon: interrupt sent", 3000);
      } catch (err) {
        vscode.window.showErrorMessage(`Tithon interrupt: ${String(err)}`);
      }
    }),
    // Test affordance (like tithon._activeExecCells): expose the single-
    // representation bookkeeping so integration tests can assert a URI is not
    // left "stuck" in cellViewUris (which would make the guard auto-close every
    // later text editor for that file — the "file won't reopen" bug, ADR-065).
    vscode.commands.registerCommand("tithon._cellViewState", () => ({
      cellViewUris: [...cellViewUris],
    })),
  );
}

export function deactivate(): void {
  /* nothing to tear down: the daemon and kernel outlive the extension host */
}
