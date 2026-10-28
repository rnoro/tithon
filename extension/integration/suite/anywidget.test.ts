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

it("renders and reconnects a real anywidget and its composed child", async () => {
  assert.equal(vscode.workspace.isTrusted, true, "the test workspace must permit widget code");
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
  await vscode.commands.executeCommand("notebook.execute");
  let serial = 0;
  const action = async (model: string, operation: string) => {
    const id = ++serial;
    await channel.postMessage({ type: "test.widget-action", model, action: operation, id });
    await until(() => received.some((entry) => entry.id === id), `DOM action ${id}`);
    const result = received.find((entry) => entry.id === id);
    assert.equal(result.type, "test.widget-done", result.error);
    return result;
  };
  const query = async (code: string) =>
    (
      await promisify(execFile)(
        process.env.TITHON_HELPER!,
        ["-m", "tithon", "run", "--session", notebook.uri.toString(), "-c", code],
        { env: process.env, timeout: 30000 },
      )
    ).stdout;
  const rendered = (id: string) =>
    received.filter((entry) => entry.type === "test.widget-ready" && entry.model === id).length;
  const ready = async (id: string, value: number) => {
    await until(() => rendered(id) > 0, `${id} rendered`);
    await until(async () => {
      const result = await action(id, "inspect");
      return result.available && result.text?.includes(`Count ${value}`);
    }, `${id} synchronized to ${value}`);
  };
  try {
    await ready("counter", 0);
    await ready("parent", 0);
    await ready("nested-parent", 0);
    await action("nested-parent", "click");
    await until(
      async () =>
        (await query("print('NESTED', nested.value, nested_changes)")).includes("NESTED 1 [1]"),
      "nested-only child interaction",
    );
    await action("counter", "click");
    await ready("parent", 1);
    await action("parent", "click");
    await ready("counter", 2);
    await until(
      async () =>
        (await query("print('STATE', counter.value, events)")).includes(
          "STATE 2 ['click', 'click']",
        ),
      "Python state and custom messages",
    );

    const lifetime = await action("counter", "inspect");
    assert.ok(lifetime.anyCreated >= 2);
    const counts = {
      counter: rendered("counter"),
      parent: rendered("parent"),
      nested: rendered("nested-parent"),
    };
    await vscode.commands.executeCommand("tithon.retryRestore");
    await until(
      () =>
        rendered("counter") > counts.counter &&
        rendered("parent") > counts.parent &&
        rendered("nested-parent") > counts.nested,
      "views recreated after reconnect",
    );
    await ready("counter", 2);
    await ready("parent", 2);
    await ready("nested-parent", 1);
    await until(
      async () => (await action("counter", "inspect")).anyDestroyed >= lifetime.anyDestroyed + 2,
      "old anywidget models cleaned up on reconnect",
    );
    assert.ok(
      (await query("print('NESTED', nested.value, nested_changes)")).includes("NESTED 1 [1]"),
    );
    await action("nested-parent", "click");
    await until(
      async () =>
        (await query("print('NESTED', nested.value, nested_changes)")).includes("NESTED 2 [1, 2]"),
      "nested-only child after reconnect",
    );
    assert.ok(
      (await query("print('STATE', counter.value, events)")).includes("STATE 2 ['click', 'click']"),
    );
    await action("parent", "click");
    await until(
      async () =>
        (await query("print('STATE', counter.value, events)")).includes(
          "STATE 3 ['click', 'click', 'click']",
        ),
      "interaction after reconnect",
    );
    await query("broken.value = 1; counter.value = 7; print('UPDATED')");
    await ready("counter", 7);
    await ready("parent", 7);
    await action("parent", "click");
    await until(
      async () =>
        (await query("print('STATE', counter.value, events)")).includes(
          "STATE 8 ['click', 'click', 'click', 'click']",
        ),
      "healthy model after another widget fails",
    );
    await vscode.commands.executeCommand("tithon.restartKernel");
    await until(
      async () => (await action("counter", "inspect")).available === false,
      "replacement revokes old view",
    );
    assert.equal((await action("counter", "click")).blocked, true);
    assert.ok((await query("print('OLD', 'counter' in globals())")).includes("OLD False"));
  } finally {
    listener.dispose();
  }
});
