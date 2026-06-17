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

function trackCellView(nb: vscode.NotebookDocument): void {
  if (!isTithon(nb)) return;
  cellViewUris.add(nb.uri.toString());
  void closeStaleTextTabs(nb.uri.toString());
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
          void closeStaleTextTabs(tab.input.uri.toString());
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(
      "tithon-py",
      new PercentNotebookSerializer(),
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
          const execId = await client.execute(arg.code, arg.origin, workdir);
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
      await vscode.commands.executeCommand("vscode.openWith", uri, "tithon-py");
      // Belt to the onDidOpenNotebookDocument hook: ensure no text view lingers.
      cellViewUris.add(uri.toString());
      await closeStaleTextTabs(uri.toString());
    }),
    // Reopen the active Tithon notebook as a plain text editor. Drop it from the
    // Cell-View set FIRST so the single-representation guard does not then close
    // the very text editor the user just asked for.
    vscode.commands.registerCommand("tithon.openAsText", async (arg?: vscode.Uri) => {
      const uri = arg ?? vscode.window.activeNotebookEditor?.notebook.uri;
      if (!uri) return;
      cellViewUris.delete(uri.toString());
      await vscode.commands.executeCommand("vscode.openWith", uri, "default");
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
  );
}

export function deactivate(): void {
  /* nothing to tear down: the daemon and kernel outlive the extension host */
}
