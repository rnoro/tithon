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

it("routes real DOM input through production host/socket/kernel and revokes stale views", async () => {
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
  await vscode.window.showNotebookDocument(notebook);
  await vscode.commands.executeCommand("notebook.selectKernel", {
    id: "tithon-notebook",
    extension: extension.id,
  });
  await vscode.commands.executeCommand("notebook.execute");
  let serial = 0;
  const action = async (model: string, action: string, value?: string) => {
    const id = ++serial;
    await channel.postMessage({ type: "test.widget-action", model, action, value, id });
    await until(() => received.some((m) => m.id === id), `DOM action ${id}`);
    const reply = received.find((m) => m.id === id);
    assert.equal(reply.type, "test.widget-done", reply.error);
    return reply;
  };
  const query = async (code: string) =>
    (
      await promisify(execFile)(
        process.env.TITHON_HELPER!,
        ["-m", "tithon", "run", "--session", notebook.uri.toString(), "-c", code],
        { env: process.env, timeout: 30000 },
      )
    ).stdout;
  try {
    await until(
      () =>
        ["button", "slider", "float-slider", "text", "dropdown", "label", "group"].every((id) =>
          received.some((m) => m.type === "test.widget-ready" && m.model === id),
        ),
      "interactive renderer views",
    );
    for (let i = 0; i < 5; i++) await action("button", "click");
    for (let i = 0; i < 21; i++) await action("slider", "key");
    await action("float-slider", "key");
    await action("text", "text", "edited");
    await action("dropdown", "dropdown", "b");
    await until(
      async () =>
        (
          await query(
            "print('STATE', clicks, slider.value, fslider.value, text.value, dropdown.value, label.value)",
          )
        ).includes("STATE 5 21 1.0 edited b 5"),
      "Python values from DOM events",
    );
    await until(
      async () => (await action("label", "inspect")).text === "5",
      "kernel label DOM update",
    );
    assert.ok((await action("group", "inspect")).text.includes("5"));
    const before = await query("print('COUNT', clicks)");
    assert.ok(before.includes("COUNT 5"));
    await vscode.commands.executeCommand("tithon.restartKernel");
    await until(
      async () => (await action("button", "inspect")).interactive === false,
      "stale view disabled after replacement",
    );
    await action("button", "click");
    assert.ok(
      (await query("print('OLD_CALLBACK', 'clicks' in globals())")).includes("OLD_CALLBACK False"),
    );
  } finally {
    listener.dispose();
  }
});
