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

it("loads installed bqplot and bqscales, updates and reconnects a live figure", async () => {
  assert.equal(vscode.workspace.isTrusted, true);
  const extension = vscode.extensions.all.find((entry) =>
    (entry.packageJSON.contributes?.commands ?? []).some(
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
  const action = async (operation: string, model = "figure") => {
    const id = ++serial;
    await channel.postMessage({
      type: "test.widget-action",
      model,
      action: operation,
      id,
    });
    await until(() => received.some((m) => m.id === id), "figure inspection");
    const reply = received.find((m) => m.id === id);
    assert.equal(reply.type, "test.widget-done", reply.error);
    return reply;
  };
  const inspect = () => action("inspect");
  const query = async (code: string) =>
    (
      await promisify(execFile)(
        process.env.TITHON_HELPER!,
        ["-m", "tithon", "run", "--session", notebook.uri.toString(), "-c", code],
        { env: process.env, timeout: 30000 },
      )
    ).stdout;
  const ready = (model = "figure") =>
    received.filter((m) => m.type === "test.widget-ready" && m.model === model).length;
  try {
    await until(() => ready() > 0, "figure mounted");
    const initial = await inspect();
    if (initial.errorCount > 0) {
      const debug = await action("debugError");
      throw new Error(`Third-party figure failed: ${debug.text}`);
    }
    await until(async () => {
      const result = await inspect();
      return result.available && result.svgCount > 0 && result.text.includes("First title");
    }, "third-party figure rendered");
    await until(
      () => received.some((m) => m.type === "test.widget-ready" && m.model === "missing"),
      "missing module handled",
    );
    const missing = await action("inspect", "missing");
    assert.ok(missing.errorCount > 0, missing.text);
    await until(() => ready("mixed") > 0, "mixed container mounted");
    await until(() => ready("view-errors") > 0, "view error container mounted");
    await until(async () => {
      const result = await action("inspect", "view-errors");
      return result.available && result.errorCount > 0 && result.text.includes("Keep working");
    }, "view error isolated alongside supported button");
    const errorView = await action("debugError", "view-errors");
    assert.ok(errorView.text.includes("intentional view failure"), errorView.text);
    await action("displayError", "view-errors");
    const displayError = await action("debugError", "view-errors");
    assert.ok(displayError.text.includes("intentional display failure"), displayError.text);
    await until(() => ready("model-errors") > 0, "model error container mounted");
    await until(async () => {
      const result = await action("inspect", "model-errors");
      return result.available && result.errorCount > 0 && result.text.includes("Keep working");
    }, "model error isolated alongside supported button");
    const modelError = await action("debugError", "model-errors");
    assert.ok(modelError.text.includes("intentional model failure"), modelError.text);
    await until(async () => {
      const result = await action("inspect", "mixed");
      return result.available && result.errorCount > 0 && result.text.includes("Keep working");
    }, "supported button and unavailable child rendered together");
    await action("click", "mixed");
    await until(
      async () => (await query("print('CLICKS', clicks)")).includes("CLICKS 1"),
      "mixed button reached Python",
    );
    await action("brush");
    await until(
      async () =>
        (
          await query(
            "print('SELECTED', len(selector.selected) if selector.selected is not None else 0)",
          )
        ).includes("SELECTED 2"),
      "brush selection reached Python",
    );
    await query("fig.title = 'Updated title'; print('UPDATED')");
    await until(
      async () => (await inspect()).text.includes("Updated title"),
      "kernel trait update",
    );
    const count = ready();
    const mixedCount = ready("mixed");
    const errorsCount = ready("view-errors");
    const modelErrorsCount = ready("model-errors");
    await vscode.commands.executeCommand("tithon.retryRestore");
    await until(() => ready() > count, "figure reconnected");
    await until(async () => {
      const result = await inspect();
      return result.available && result.svgCount > 0 && result.text.includes("Updated title");
    }, "current state after reconnect");
    await until(() => ready("mixed") > mixedCount, "mixed container reconnected");
    await until(() => ready("view-errors") > errorsCount, "view error container reconnected");
    await until(
      () => ready("model-errors") > modelErrorsCount,
      "model error container reconnected",
    );
    await until(async () => {
      const result = await action("inspect", "mixed");
      return result.available && result.errorCount > 0 && result.text.includes("Keep working");
    }, "mixed container after reconnect");
    assert.ok((await query("print('CLICKS', clicks)")).includes("CLICKS 1"));
    await action("click", "mixed");
    await until(
      async () => (await query("print('CLICKS', clicks)")).includes("CLICKS 2"),
      "mixed button after reconnect",
    );
    await query("mixed.children = (button, w.Label(value='Now available')); print('REPLACED')");
    await until(
      async () => (await action("inspect", "mixed")).text.includes("Now available"),
      "dynamic child replacement",
    );
    await action("click", "mixed");
    await until(
      async () => (await query("print('CLICKS', clicks)")).includes("CLICKS 3"),
      "mixed button after replacement",
    );
    await until(async () => {
      const result = await action("inspect", "view-errors");
      return result.available && result.errorCount > 0 && result.text.includes("Keep working");
    }, "view error isolation after reconnect");
    await action("click", "view-errors");
    await until(
      async () => (await query("print('CLICKS', clicks)")).includes("CLICKS 4"),
      "supported sibling after view failure and reconnect",
    );
    await until(async () => {
      const result = await action("inspect", "model-errors");
      return result.available && result.errorCount > 0 && result.text.includes("Keep working");
    }, "model error isolation after reconnect");
    await action("click", "model-errors");
    await until(
      async () => (await query("print('CLICKS', clicks)")).includes("CLICKS 5"),
      "supported sibling after model failure and reconnect",
    );
    await action("displayError", "view-errors");
    const restoredDisplayError = await action("debugError", "view-errors");
    assert.ok(restoredDisplayError.text.includes("intentional display failure"));
    assert.ok((await query("print('SELECTED', len(selector.selected))")).includes("SELECTED 2"));
    await vscode.commands.executeCommand("tithon.restartKernel");
    await until(async () => (await inspect()).available === false, "old figure revoked");
    await until(
      async () => (await action("inspect", "view-errors")).available === false,
      "old mixed view revoked",
    );
    await until(
      async () => (await action("inspect", "model-errors")).available === false,
      "old model error view revoked",
    );
  } finally {
    listener.dispose();
  }
});
