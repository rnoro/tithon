import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 40000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("Workspace daemon home and bounded reconnect", () => {
  it("uses the configured home throughout startup, execution, retry and management", async () => {
    const home = process.env.TITHON_CONFIGURED_HOME!;
    const inherited = process.env.TITHON_HOME!;
    const cfg = vscode.workspace.getConfiguration("tithon");
    const extension = vscode.extensions.getExtension("rnoro.tithon")!;
    assert.ok(extension, "extension installed");
    await extension.activate();
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    const notebook = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(notebook);
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon",
      extension: extension.id,
    });
    const state = () => vscode.commands.executeCommand<{ state: string }>("tithon._restoreState");
    await waitFor(async () => (await state())?.state === "connected", "initial connection");
    assert.ok(fs.existsSync(path.join(home, "daemon.sock")), "configured socket created");
    assert.ok(!fs.existsSync(path.join(inherited, "daemon.sock")), "inherited home untouched");
    const execute = async (expected: string) => {
      await vscode.commands.executeCommand("notebook.cell.execute", {
        ranges: [new vscode.NotebookRange(0, 1)],
        document: uri,
      });
      await waitFor(
        () =>
          notebook
            .cellAt(0)
            .outputs.some((output) =>
              output.items.some((item) => new TextDecoder().decode(item.data).includes(expected)),
            ),
        expected,
      );
    };
    await execute("VALUE 1");
    await cfg.update("autoStartDaemon", false, vscode.ConfigurationTarget.Workspace);
    const pid = Number(fs.readFileSync(path.join(home, "daemon.pid"), "utf8"));
    process.kill(pid, "SIGKILL");
    await waitFor(async () => (await state())?.state === "failed", "retry limit reached");
    assert.strictEqual(
      await vscode.commands.executeCommand("tithon._reconnectProgressActive"),
      false,
    );
    assert.ok(fs.readFileSync(path.join(home, "daemon.autostart.log"), "utf8").length > 0);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.strictEqual((await state())?.state, "failed", "stays stopped after limit");
    await cfg.update("autoStartDaemon", true, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand("tithon.retryRestore");
    assert.strictEqual((await state())?.state, "connected");
    await execute("VALUE 2");
    const nextHome = path.join(home, "after-reload");
    await cfg.update("homePath", nextHome, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand("tithon.restartDaemon");
    await waitFor(async () => (await state())?.state === "connected", "managed restart");
    assert.ok(
      !fs.existsSync(path.join(inherited, "daemon.sock")),
      "management stayed on configured home",
    );
    assert.ok(!fs.existsSync(nextHome), "changed home is inactive until reload");
  });
});
