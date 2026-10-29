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

it("loads the mapped three dependency and restores a live pythreejs view", async () => {
  assert.equal(vscode.workspace.isTrusted, true);
  const extension = vscode.extensions.all.find((entry) =>
    (entry.packageJSON.contributes?.commands ?? []).some(
      (command: any) => command.command === "tithon.restartKernel",
    ),
  )!;
  await extension.activate();
  const channel = vscode.notebooks.createRendererMessaging("tithon-widget");
  const messages: any[] = [];
  const listener = channel.onDidReceiveMessage((event) => messages.push(event.message));
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
  const inspect = async (action = "inspect") => {
    const id = ++serial;
    await channel.postMessage({ type: "test.widget-action", model: "three", action, id });
    await until(() => messages.some((message) => message.id === id), "inspection response");
    const result = messages.find((message) => message.id === id);
    assert.equal(result.type, "test.widget-done", result.error);
    return result;
  };
  const ready = () =>
    messages.filter((message) => message.type === "test.widget-ready" && message.model === "three")
      .length;
  const query = async (code: string) =>
    (
      await promisify(execFile)(
        process.env.TITHON_HELPER!,
        ["-m", "tithon", "run", "--session", notebook.uri.toString(), "-c", code],
        { env: process.env, timeout: 30000 },
      )
    ).stdout;
  try {
    await until(() => ready() > 0, "threejs view mounted");
    const initial = await inspect();
    if (initial.errorCount > 0) {
      const debug = await inspect("debugError");
      throw new Error(`Threejs failed: ${debug.text}`);
    }
    try {
      await until(async () => {
        const result = await inspect();
        if (result.text?.includes("Widget unavailable:")) throw new Error(result.text);
        return result.canvasCount > 0;
      }, "threejs canvas rendered");
    } catch (error) {
      console.log("[v79] timed out view:", JSON.stringify(await inspect("debugDump")));
      console.log(
        "[v79] renderer errors:",
        JSON.stringify(messages.filter((m) => m.type === "test.widget-console")),
      );
      throw error;
    }
    const cameraPosition = async () =>
      (await query("print('CAMERA', tuple(camera.position))")).match(/^CAMERA .+$/m)?.[0];
    const initialCamera = await cameraPosition();
    assert.ok(initialCamera);
    await inspect("orbit");
    await until(async () => {
      const current = await cameraPosition();
      return !!current && current !== initialCamera;
    }, "camera interaction reached Python");
    await query("view.width = 321");
    await until(
      async () => (await inspect()).canvasStyleWidth === "321px",
      "threejs width updated",
    );
    const count = ready();
    await vscode.commands.executeCommand("tithon.retryRestore");
    await until(() => ready() > count, "threejs reconnected");
    await until(async () => (await inspect()).canvasStyleWidth === "321px", "threejs restored");
  } finally {
    listener.dispose();
  }
});
