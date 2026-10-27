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
        [
          "button",
          "slider",
          "float-slider",
          "text",
          "dropdown",
          "checkbox",
          "label",
          "group",
        ].every((id) => received.some((m) => m.type === "test.widget-ready" && m.model === id)),
      "interactive renderer views",
    );
    await until(
      async () =>
        (
          await Promise.all(
            ["button", "slider", "float-slider", "text", "dropdown", "checkbox"].map((model) =>
              action(model, "inspect"),
            ),
          )
        ).every((result) => result.available),
      "interactive views synchronized",
    );
    for (let i = 0; i < 5; i++) await action("button", "click");
    for (let i = 0; i < 21; i++) await action("slider", "key");
    await action("float-slider", "key");
    await action("text", "text", "edited");
    await action("dropdown", "dropdown", "b");
    await action("checkbox", "check");
    await until(
      async () =>
        (
          await query(
            "print('STATE', clicks, slider.value, fslider.value, text.value, dropdown.value, checkbox.value, label.value)",
          )
        ).includes("STATE 5 21 1.0 edited b True 5"),
      "Python values from DOM events",
    );
    await until(
      async () => (await action("label", "inspect")).text === "5",
      "kernel label DOM update",
    );
    assert.ok((await action("group", "inspect")).text.includes("5"));
    const before = await query("print('COUNT', clicks)");
    assert.ok(before.includes("COUNT 5"));

    const readyBefore = received.filter(
      (m) => m.type === "test.widget-ready" && m.model === "checkbox",
    ).length;
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await until(
      () =>
        !vscode.window.visibleNotebookEditors.some(
          (e) => e.notebook.uri.toString() === notebook.uri.toString(),
        ),
      "notebook editor closed",
    );
    const reopened = await vscode.workspace.openNotebookDocument(notebook.uri);
    await vscode.window.showNotebookDocument(reopened);
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon-notebook",
      extension: extension.id,
    });
    await until(
      () =>
        received.filter((m) => m.type === "test.widget-ready" && m.model === "checkbox").length >
        readyBefore,
      "checkbox view remounted",
    );
    await until(async () => {
      const result = await action("checkbox", "inspect");
      return result.available && result.checked === true;
    }, "restored checkbox value");
    await action("checkbox", "check");
    await until(
      async () => (await query("print('CHECKBOX', checkbox.value)")).includes("CHECKBOX False"),
      "checkbox after remount",
    );

    const readyBeforeReconnect = received.filter(
      (m) => m.type === "test.widget-ready" && m.model === "checkbox",
    ).length;
    await vscode.commands.executeCommand("tithon.retryRestore");
    await until(
      () =>
        received.filter((m) => m.type === "test.widget-ready" && m.model === "checkbox").length >
        readyBeforeReconnect,
      "checkbox view reconnected",
    );
    await until(async () => {
      const result = await action("checkbox", "inspect");
      return result.available && result.checked === false;
    }, "reconnected checkbox value");
    assert.ok(
      (await query("print('CHANGES', checkbox_changes)")).includes("CHANGES [True, False]"),
    );
    await action("checkbox", "check");
    await until(
      async () => (await query("print('CHECKBOX', checkbox.value)")).includes("CHECKBOX True"),
      "checkbox after reconnect",
    );
    assert.ok(
      (await query("print('CHANGES', checkbox_changes)")).includes("CHANGES [True, False, True]"),
    );

    await vscode.commands.executeCommand("tithon.restartKernel");
    await until(
      async () => (await action("button", "inspect")).interactive === false,
      "stale view disabled after replacement",
    );
    assert.equal((await action("button", "click")).blocked, true);
    assert.ok(
      (await query("print('OLD_CALLBACK', 'clicks' in globals())")).includes("OLD_CALLBACK False"),
    );
  } finally {
    listener.dispose();
  }
});
