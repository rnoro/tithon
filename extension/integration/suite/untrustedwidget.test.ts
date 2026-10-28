import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

it("blocks custom widget code in a restricted workspace without disabling stock widgets", async () => {
  assert.equal(vscode.workspace.isTrusted, false, "the test must actually use restricted mode");
  const extension = vscode.extensions.all.find((entry) =>
    (entry.packageJSON.contributes?.commands ?? []).some(
      (command: any) => command.command === "tithon.restartKernel",
    ),
  )!;
  await extension.activate();
  const channel = vscode.notebooks.createRendererMessaging("tithon-widget");
  const received: any[] = [];
  const listener = channel.onDidReceiveMessage((event) => received.push(event.message));
  const notebook = await vscode.workspace.openNotebookDocument(
    vscode.Uri.file(process.env.TITHON_FIXTURE!),
  );
  await vscode.window.showNotebookDocument(notebook);
  await vscode.commands.executeCommand("notebook.selectKernel", {
    id: "tithon-notebook",
    extension: extension.id,
  });
  const query = async (code: string) =>
    (
      await promisify(execFile)(
        process.env.TITHON_HELPER!,
        ["-m", "tithon", "run", "--session", notebook.uri.toString(), "-c", code],
        { env: process.env, timeout: 30000 },
      )
    ).stdout;
  let serial = 0;
  const action = async (operation: string) => {
    const id = ++serial;
    await channel.postMessage({
      type: "test.widget-action",
      model: "button",
      action: operation,
      id,
    });
    await until(() => received.some((entry) => entry.id === id), `DOM action ${id}`);
    const result = received.find((entry) => entry.id === id);
    assert.equal(result.type, "test.widget-done", result.error);
    return result;
  };
  try {
    await until(
      () =>
        received.some((entry) => entry.type === "test.widget-ready" && entry.model === "button"),
      "stock widget rendered",
    );
    await until(async () => (await action("inspect")).available, "stock widget synchronized");
    await until(
      () =>
        notebook
          .cellAt(1)
          .outputs.some((output) =>
            output.items.some(
              (item) =>
                item.mime === "text/plain" &&
                Buffer.from(item.data).toString().includes("AnyModel"),
            ),
          ),
      "custom widget fallback",
    );
    assert.ok(
      !received.some((entry) => entry.type === "test.widget-ready" && entry.model === "custom"),
    );
    await until(
      () =>
        notebook
          .cellAt(2)
          .outputs.some((output) =>
            output.items.some(
              (item) =>
                item.mime === "text/plain" &&
                Buffer.from(item.data).toString().includes("FigureModel"),
            ),
          ),
      "third-party widget fallback",
    );
    assert.ok(
      !received.some(
        (entry) => entry.type === "test.widget-ready" && entry.model === "untrusted-figure",
      ),
    );
    assert.ok(!received.some((entry) => entry.type === "tithon.widget-load-module"));
    assert.ok((await query("print('CUSTOM_EVENTS', events)")).includes("CUSTOM_EVENTS []"));
    await action("click");
    await until(
      async () => (await query("print('CLICKS', clicks)")).includes("CLICKS 1"),
      "stock widget remains active",
    );
  } finally {
    listener.dispose();
  }
});
