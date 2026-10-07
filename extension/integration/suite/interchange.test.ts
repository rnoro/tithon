/** Real VSCode command conversion and restore-state lifecycle. */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  label: string,
  ms = 30000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function extension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.all.find((e) =>
    (e.packageJSON.contributes?.commands ?? []).some(
      (c: { command?: string }) => c.command === "tithon.importNotebook",
    ),
  );
  if (!ext) throw new Error("Tithon extension not found");
  return ext;
}

function outputText(nb: vscode.NotebookDocument): string {
  return nb
    .getCells()
    .flatMap((cell) =>
      cell.outputs.flatMap((out) =>
        out.items
          .filter((item) => item.mime.includes("stdout"))
          .map((item) => new TextDecoder().decode(item.data)),
      ),
    )
    .join("");
}

async function state(): Promise<{ state: string } | undefined> {
  return vscode.commands.executeCommand("tithon._restoreState");
}

describe("Notebook interchange and restore state", () => {
  it("imports without executing, restores output, exports current output, and cancels on deselection", async () => {
    const root = process.env.TITHON_WORKSPACE!;
    const input = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    const py = vscode.Uri.file(path.join(root, "converted.py"));
    const output = vscode.Uri.file(path.join(root, "converted.ipynb"));
    const ext = extension();
    await ext.activate();
    await vscode.commands.executeCommand("tithon.importNotebook", input, py);
    assert.ok(fs.existsSync(py.fsPath), "import command must create the Python source");
    const editor = vscode.window.activeNotebookEditor;
    assert.ok(editor, "import opens a Tithon notebook");
    const nb = editor!.notebook;
    assert.strictEqual(nb.uri.toString(), py.toString());
    assert.strictEqual(nb.cellCount, 3);
    assert.strictEqual(
      nb.cellAt(2).kind,
      vscode.NotebookCellKind.Markup,
      "raw cells must not execute as Python",
    );
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon",
      extension: ext.id,
    });
    await waitFor(async () => (await state())?.state === "connected", "restore complete");
    assert.ok(
      outputText(nb).includes("saved output"),
      "connected means cell output has already been applied",
    );
    assert.ok(
      nb.cellAt(0).outputs.some((out) => out.items.some((item) => item.mime === "image/png")),
      "rich output must already be applied at connected",
    );
    assert.ok(!fs.existsSync(path.join(root, "executed")), "import/restore must not execute code");
    await vscode.commands.executeCommand("tithon.showStorage");
    await vscode.commands.executeCommand("tithon.exportNotebook", py, output);
    const exported = JSON.parse(fs.readFileSync(output.fsPath, "utf8"));
    assert.strictEqual(exported.cells[0].source.join(""), "open('executed', 'w').write('bad')");
    assert.strictEqual(exported.cells[0].outputs[0].text.join(""), "saved output\n");
    assert.strictEqual(exported.cells[2].cell_type, "raw");
    assert.strictEqual(exported.metadata.authors[0].name, "Test Author");
    const before = fs.readFileSync(output.fsPath);
    await vscode.commands.executeCommand("tithon.exportNotebook", py, output);
    assert.deepStrictEqual(
      fs.readFileSync(output.fsPath),
      before,
      "existing output is never overwritten",
    );
    // Retry goes through the same restoration path and completes after applying outputs.
    await vscode.commands.executeCommand("tithon.retryRestore");
    assert.strictEqual((await state())?.state, "connected");
    // A missing artifact must preserve an actionable incomplete restore state.
    const imageDir = path.join(root, ".tithon", "outputs");
    const imagePath = path.join(
      imageDir,
      fs.readdirSync(imageDir).find((name) => name.endsWith(".png"))!,
    );
    const bytes = fs.readFileSync(imagePath);
    fs.unlinkSync(imagePath);
    try {
      await vscode.commands.executeCommand("tithon.retryRestore");
      const incomplete = await state();
      assert.ok(incomplete?.state === "failed" || incomplete?.state === "retrying");
    } finally {
      fs.writeFileSync(imagePath, bytes);
    }
    await vscode.commands.executeCommand("tithon.retryRestore");
    assert.strictEqual((await state())?.state, "connected");

    // Multiple historical executions of one cell must restore only its latest result.
    const edit = new vscode.WorkspaceEdit();
    edit.set(nb.uri, [
      vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(0, 1), [
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          "counter = globals().get('counter', 0) + 1\nprint('RERUN', counter)",
          "python",
        ),
      ]),
    ]);
    assert.ok(await vscode.workspace.applyEdit(edit));
    await nb.save();
    for (const count of [1, 2]) {
      vscode.window.activeNotebookEditor!.selections = [new vscode.NotebookRange(0, 1)];
      await vscode.commands.executeCommand("notebook.cell.execute", {
        ranges: [new vscode.NotebookRange(0, 1)],
        document: nb.uri,
      });
      await waitFor(
        () =>
          outputText(nb).includes(`RERUN ${count}`) &&
          nb.cellAt(0).executionSummary?.success === true,
        `rerun ${count}`,
      );
    }
    await vscode.commands.executeCommand("tithon.retryRestore");
    assert.strictEqual((await state())?.state, "connected");
    assert.ok(outputText(nb).includes("RERUN 2"));
    assert.ok(!outputText(nb).includes("RERUN 1"));
    await vscode.commands.executeCommand("tithon._disposeLive");
    assert.strictEqual(await state(), undefined, "deselection/disposal removes restore state");
  });
});
