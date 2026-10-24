import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { DaemonClient } from "../../src/daemonClient";
import { redirectPseudoPathDefinition } from "../../src/extension";
import { SessionClient } from "../../src/sessionClient";

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function text(notebook: vscode.NotebookDocument): string {
  return notebook
    .getCells()
    .flatMap((cell) =>
      cell.outputs.flatMap((output) =>
        output.items
          .filter((item) => item.mime.includes("stdout"))
          .map((item) => new TextDecoder().decode(item.data)),
      ),
    )
    .join("");
}

function hasImage(notebook: vscode.NotebookDocument): boolean {
  return notebook
    .getCells()
    .some((cell) =>
      cell.outputs.some((output) =>
        output.items.some((item) => item.mime === "image/png" && item.data.length > 0),
      ),
    );
}

async function append(notebook: vscode.NotebookDocument, code: string): Promise<number> {
  const index = notebook.cellCount;
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [
    vscode.NotebookEdit.insertCells(index, [
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, "python"),
    ]),
  ]);
  assert.ok(await vscode.workspace.applyEdit(edit));
  return index;
}

async function run(notebook: vscode.NotebookDocument, index: number): Promise<void> {
  const editor = await vscode.window.showNotebookDocument(notebook);
  editor.selections = [new vscode.NotebookRange(index, index + 1)];
  assert.strictEqual(editor.selection.start, index, "native execution targets the intended cell");
  console.log(
    `pynb: run ${notebook.uri.toString()} cell=${index} code=${JSON.stringify(notebook.cellAt(index).document.getText())}`,
  );
  await vscode.commands.executeCommand("notebook.cell.execute", {
    document: notebook.uri,
    ranges: [new vscode.NotebookRange(index, index + 1)],
  });
}

describe("Dedicated Python Notebook files", () => {
  it("opens by default, executes/restores, and copies source/output into an independent session", async () => {
    const extension = vscode.extensions.all.find((entry) =>
      entry.packageJSON.contributes?.commands?.some(
        (command: { command: string }) => command.command === "tithon.newNotebook",
      ),
    );
    assert.ok(extension);
    await extension.activate();
    const root = process.env.TITHON_WORKSPACE!;
    const source = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    const target = vscode.Uri.file(path.join(root, "converted.pynb"));
    const fresh = vscode.Uri.file(path.join(root, "new.pynb"));
    const client = new DaemonClient();
    await vscode.commands.executeCommand("tithon.openAsNotebook", source);
    const original = vscode.window.activeNotebookEditor!.notebook;
    assert.strictEqual(original.notebookType, "tithon-py");
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon",
      extension: extension.id,
    });
    await run(original, 0);
    await waitFor(
      () => text(original).includes("SOURCE 41") && hasImage(original),
      "original execution/image",
    );
    await waitFor(
      async () =>
        (await client.listKernels()).find((session) => session.session === source.toString())
          ?.kernel_status === "idle",
      "source idle",
    );

    // Conversion must save the source editor before copying its bytes.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(
      original.cellAt(0).document.uri,
      original.cellAt(0).document.positionAt(original.cellAt(0).document.getText().length),
      "\n# saved during copy\n",
    );
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(original.isDirty);
    assert.ok(!fs.readFileSync(source.fsPath, "utf8").includes("saved during copy"));
    await vscode.commands.executeCommand("tithon.copyAsNotebook", source, target);
    assert.ok(fs.existsSync(target.fsPath), "copy command created destination");
    assert.strictEqual(
      fs.readFileSync(source.fsPath, "utf8"),
      fs.readFileSync(target.fsPath, "utf8"),
    );
    assert.ok(fs.readFileSync(source.fsPath, "utf8").includes("saved during copy"));
    let copied = vscode.window.activeNotebookEditor!.notebook;
    assert.strictEqual(copied.uri.toString(), target.toString());
    assert.strictEqual(copied.notebookType, "tithon-notebook");
    assert.ok(copied.getCells().every((cell) => cell.document.languageId === "python"));
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon-notebook",
      extension: extension.id,
    });
    await waitFor(
      () => text(copied).includes("SOURCE 41") && hasImage(copied),
      "copied saved outputs/image",
    );
    const stateIndex = await append(copied, 'print("COPIED_STATE", "source_only" in globals())');
    await run(copied, stateIndex);
    await waitFor(
      () =>
        copied
          .cellAt(stateIndex)
          .outputs.some((output) =>
            output.items.some(
              (item) =>
                item.mime.includes("stdout") &&
                new TextDecoder().decode(item.data).includes("COPIED_STATE "),
            ),
          ),
      "namespace probe output on the appended cell",
    );
    const namespaceOutput = copied
      .cellAt(stateIndex)
      .outputs.flatMap((output) =>
        output.items
          .filter((item) => item.mime.includes("stdout"))
          .map((item) => new TextDecoder().decode(item.data)),
      )
      .join("");
    assert.ok(
      namespaceOutput.includes("COPIED_STATE False"),
      `copy must have no original kernel namespace: ${JSON.stringify(namespaceOutput)}`,
    );
    const kernels = await client.listKernels();
    const sourcePid = kernels.find((session) => session.session === source.toString())?.kernel_pid;
    const targetPid = kernels.find((session) => session.session === target.toString())?.kernel_pid;
    assert.ok(
      sourcePid && targetPid && sourcePid !== targetPid,
      "new URI has an independent kernel",
    );
    assert.ok(await copied.save());

    const imageReference = (name: string): { execId: string; path: string } => {
      const shared = JSON.parse(
        fs.readFileSync(path.join(root, ".tithon", "cells", `${name}.json`), "utf8"),
      );
      for (const execution of shared.executions) {
        for (const output of execution.outputs) {
          const reference = output.data?.["image/png"]?.$tithon_artifact;
          if (reference)
            return { execId: execution.exec_id, path: path.join(root, reference.rel_path) };
        }
      }
      throw new Error(`No image reference for ${name}`);
    };
    const sourceImage = imageReference("source.py");
    const copiedImage = imageReference("converted.pynb");
    assert.notStrictEqual(
      sourceImage.path,
      copiedImage.path,
      "copy owns a separate physical image",
    );
    const imageBytes = fs.readFileSync(sourceImage.path);
    assert.deepStrictEqual(fs.readFileSync(copiedImage.path), imageBytes);

    await vscode.window.showNotebookDocument(original);
    await waitFor(
      async () =>
        !(await vscode.commands.executeCommand<number[]>("tithon._activeExecCells"))?.includes(0),
      "source execution complete before clear",
    );
    await vscode.commands.executeCommand("notebook.clearAllCellsOutputs");
    await waitFor(async () => {
      const probe = new SessionClient(undefined, source.toString());
      try {
        await probe.attach(0);
        return probe.outputsOf(sourceImage.execId).length === 0;
      } finally {
        probe.close();
      }
    }, "source image-bearing execution durably cleared on daemon");
    await waitFor(() => !fs.existsSync(sourceImage.path), "source image physically reclaimed");
    assert.deepStrictEqual(
      fs.readFileSync(copiedImage.path),
      imageBytes,
      "source GC preserves destination bytes",
    );
    const replace = new vscode.WorkspaceEdit();
    const originalCell = original.cellAt(0).document;
    replace.replace(
      originalCell.uri,
      new vscode.Range(
        originalCell.positionAt(0),
        originalCell.positionAt(originalCell.getText().length),
      ),
      'print("SOURCE_REPLACED")\n',
    );
    assert.ok(await vscode.workspace.applyEdit(replace));
    assert.ok(await original.save());
    await run(original, 0);
    await waitFor(() => text(original).includes("SOURCE_REPLACED"), "source rerun");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("vscode.open", target);
    copied = vscode.window.activeNotebookEditor!.notebook;
    assert.strictEqual(
      copied.notebookType,
      "tithon-notebook",
      "ordinary open chooses dedicated type",
    );
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon-notebook",
      extension: extension.id,
    });
    await waitFor(
      () => hasImage(copied) && text(copied).includes("COPIED_STATE False"),
      "saved destination image/output survives source clear, GC, rerun and reopen",
    );
    assert.ok(fs.existsSync(source.fsPath), "source remains present");
    assert.ok(
      !fs.existsSync(sourceImage.path),
      "source image remains reclaimed after destination reopen",
    );
    assert.deepStrictEqual(fs.readFileSync(copiedImage.path), imageBytes);
    const reopenedImage = copied
      .getCells()
      .flatMap((cell) => cell.outputs.flatMap((output) => output.items))
      .find((item) => item.mime === "image/png");
    assert.ok(reopenedImage, "destination image is restored in notebook model");
    assert.deepStrictEqual(Buffer.from(reopenedImage.data), imageBytes);

    const realPythonFile = target.with({
      path: `${target.path}.py`,
      fragment: copied.cellAt(0).document.uri.fragment,
    });
    fs.writeFileSync(realPythonFile.fsPath, "real_file = True\n");
    await vscode.commands.executeCommand("vscode.open", realPythonFile, { preserveFocus: false });
    const realTab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(
        (tab) =>
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.fsPath === realPythonFile.fsPath,
      );
    assert.ok(realTab, "existing synthetic-looking file opens as text");
    // Await the production guard itself so the negative navigation assertion cannot race its event.
    await redirectPseudoPathDefinition(realTab);
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, realPythonFile.fsPath);
    assert.ok(vscode.window.tabGroups.all.flatMap((group) => group.tabs).includes(realTab));
    assert.strictEqual(fs.readFileSync(realPythonFile.fsPath, "utf8"), "real_file = True\n");

    const script = vscode.Uri.file(path.join(root, "exported.py"));
    const jupyter = vscode.Uri.file(path.join(root, "exported.ipynb"));
    const imported = vscode.Uri.file(path.join(root, "imported.pynb"));
    await waitFor(
      async () =>
        (await client.listKernels()).find((session) => session.session === target.toString())
          ?.kernel_status === "idle",
      "copy idle before export",
    );
    await vscode.commands.executeCommand("tithon.exportPythonScript", target, script);
    assert.strictEqual(
      fs.readFileSync(script.fsPath, "utf8"),
      fs.readFileSync(target.fsPath, "utf8"),
    );
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, script.fsPath);
    await vscode.commands.executeCommand("tithon.exportNotebook", target, jupyter);
    const exported = JSON.parse(fs.readFileSync(jupyter.fsPath, "utf8"));
    assert.strictEqual(exported.nbformat, 4);
    assert.ok(
      exported.cells.some((cell: { outputs?: Array<{ data?: Record<string, unknown> }> }) =>
        cell.outputs?.some((output) => output.data?.["image/png"]),
      ),
      "Jupyter export embeds the copied image",
    );
    await vscode.commands.executeCommand("tithon.importNotebook", jupyter, imported);
    const reimported = vscode.window.activeNotebookEditor!.notebook;
    assert.strictEqual(reimported.uri.toString(), imported.toString());
    assert.strictEqual(reimported.notebookType, "tithon-notebook");
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon-notebook",
      extension: extension.id,
    });
    await waitFor(
      () => hasImage(reimported) && text(reimported).includes("COPIED_STATE False"),
      "Jupyter .pynb import restores saved image/output",
    );
    assert.ok(fs.existsSync(source.fsPath) && fs.existsSync(target.fsPath));

    await vscode.commands.executeCommand("tithon.newNotebook", fresh);
    assert.ok(fs.existsSync(fresh.fsPath));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("vscode.open", fresh);
    const created = vscode.window.activeNotebookEditor!.notebook;
    assert.strictEqual(created.notebookType, "tithon-notebook");
    const newIndex = await append(created, 'print("NEW_NOTEBOOK_EXECUTED")');
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon-notebook",
      extension: extension.id,
    });
    await run(created, newIndex);
    await waitFor(() => text(created).includes("NEW_NOTEBOOK_EXECUTED"), "new notebook execution");
    assert.ok(await created.save());
    const before = fs.readFileSync(fresh.fsPath);
    await vscode.commands.executeCommand("tithon.newNotebook", fresh);
    assert.deepStrictEqual(fs.readFileSync(fresh.fsPath), before, "new notebook refuses overwrite");
  });
});
