import * as assert from "node:assert/strict";
import * as vscode from "vscode";

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
const decoder = new TextDecoder();
function values(cell: vscode.NotebookCell, mime: string): string[] {
  return cell.outputs.flatMap((o) =>
    o.items.filter((i) => i.mime === mime).map((i) => decoder.decode(i.data)),
  );
}
function stdout(cell: vscode.NotebookCell): string {
  return values(cell, "application/vnd.code.notebook.stdout").join("");
}

it("routes DOM callback output into separate cells and clears only its Output area", async () => {
  const extension = vscode.extensions.all.find((e) =>
    (e.packageJSON.contributes?.commands ?? []).some(
      (c: any) => c.command === "tithon.restartKernel",
    ),
  )!;
  await extension.activate();
  const channel = vscode.notebooks.createRendererMessaging("tithon-widget");
  const received: any[] = [];
  const listener = channel.onDidReceiveMessage((event) => received.push(event.message));
  const notebook = await vscode.workspace.openNotebookDocument(
    vscode.Uri.file(process.env.TITHON_FIXTURE!),
  );
  const editor = await vscode.window.showNotebookDocument(notebook);
  await vscode.commands.executeCommand("notebook.selectKernel", {
    id: "tithon-notebook",
    extension: extension.id,
  });
  async function run(start: number, end: number): Promise<void> {
    editor.selections = [new vscode.NotebookRange(start, end)];
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [new vscode.NotebookRange(start, end)],
      document: notebook.uri,
    });
  }
  const a = notebook.cellAt(0);
  const b = notebook.cellAt(1);
  try {
    await run(0, 2);
    await until(
      () => received.some((m) => m.type === "test.widget-ready" && m.model === "button"),
      "button DOM",
    );
    await until(
      () => stdout(a).includes("SIBLING A") && stdout(b).includes("SIBLING B"),
      "initial cells",
    );
    const orders = [a.executionSummary?.executionOrder, b.executionSummary?.executionOrder];
    for (let id = 1; id <= 3; id++) {
      const probe = -id;
      await channel.postMessage({
        type: "test.widget-action",
        model: "button",
        action: "inspect",
        id: probe,
      });
      await until(() => received.some((m) => m.id === probe), "live button before click");
      assert.equal(received.find((m) => m.id === probe).interactive, true);
      await channel.postMessage({
        type: "test.widget-action",
        model: "button",
        action: "click",
        id,
      });
      await until(() => received.some((m) => m.id === id), `DOM click ${id}`);
      assert.equal(received.find((m) => m.id === id).type, "test.widget-done");
      await until(() => stdout(b).includes(`PLAIN ${id}`), `callback ${id}`);
    }
    await until(
      () => values(b, "application/vnd.code.notebook.error").some((s) => s.includes("plain-error")),
      "plain error",
    );
    assert.ok(stdout(a).includes("SIBLING A"));
    assert.ok(stdout(a).includes("CAPTURE 2"));
    assert.ok(!stdout(a).includes("CAPTURE 1"));
    assert.ok(!stdout(a).includes("PLAIN"));
    assert.ok(!stdout(b).includes("CAPTURE"));
    assert.ok(stdout(b).includes("SIBLING B"));
    assert.ok(stdout(b).includes("TAIL 2"));
    assert.deepEqual(values(a, "text/html"), ["<b>captured-2</b>"]);
    assert.ok(
      values(a, "application/vnd.code.notebook.error").some((s) => s.includes("captured-error")),
    );
    const images = a.outputs.flatMap((o) => o.items.filter((i) => i.mime === "image/png"));
    assert.equal(images.length, 1);
    assert.deepEqual(Array.from(images[0].data.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual(
      [a.executionSummary?.executionOrder, b.executionSummary?.executionOrder],
      orders,
    );
    await run(2, 3);
    await until(
      () => stdout(notebook.cellAt(2)).includes("CLEARED") && !stdout(a).includes("CAPTURE"),
      "later clear",
    );
    assert.equal(stdout(a), "SIBLING A\n");
    assert.equal(a.outputs.flatMap((o) => o.items.filter((i) => i.mime === "image/png")).length, 0);
    assert.ok(stdout(b).includes("SIBLING B") && stdout(b).includes("PLAIN 3"));
    await until(
      async () =>
        ((await vscode.commands.executeCommand("tithon._activeExecCells")) as number[]).length ===
        0,
      "no lingering cell executions after callbacks and clear",
    );
  } finally {
    listener.dispose();
  }
});
