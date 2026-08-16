/**
 * v63 — REAL VSCode: a session the user CLOSED is not re-seeded on open, and the
 * withheld history is still there for `Tithon: Restore Previous Outputs`.
 *
 * The daemon half is covered hermetically (v62): `kill_kernel` records the
 * intent, it survives a daemon restart, a new run re-arms it. What the daemon
 * cannot show is whether the EXTENSION honours the answer — the seed skip in
 * `startLive` is a single expression, and deleting it would leave every other
 * test in this repository green while the reported symptom (a deliberately
 * terminated kernel handing its outputs back on every reopen) came straight
 * back.
 *
 * Driven the way it actually happens: a driver runs the cell with no notebook
 * open, the kernel is terminated, and only THEN is the file opened — so the
 * document starts with genuinely empty cells (outputs are transient, ADR-046)
 * and anything in them afterwards came from the extension's seed.
 *
 * The trace is the discriminator. `tithon._seedTrace` is written BEFORE the
 * skip, so it proves the extension saw the execution and mapped it to this cell
 * and still put nothing there — an empty cell alone would also be satisfied by
 * an attach that simply failed.
 */
import * as assert from "node:assert";
import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { computeCellHash } from "../../src/cellAttach";
import { DaemonClient } from "../../src/daemonClient";
import { cellSource, parse } from "../../src/serializer";
import { SessionClient } from "../../src/sessionClient";

const dec = new TextDecoder();

function plainText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) {
    for (const item of o.items) {
      if (item.mime === "text/plain" || item.mime.includes("stdout")) s += dec.decode(item.data);
    }
  }
  return s;
}

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  ms: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

function findTithonExtension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.all.find((e) =>
    (e.packageJSON?.contributes?.commands ?? []).some(
      (c: { command?: string }) => c.command === "tithon.restartKernel",
    ),
  );
  if (!ext) throw new Error("Tithon extension not found");
  return ext;
}

interface SeedEntry {
  execId: string;
  mappedCell: number | undefined;
  status: string;
}

describe("Tithon does not re-seed a session the user closed (v63)", () => {
  it("withholds the seed on open, then restores it on request", async () => {
    const fixture = process.env.TITHON_FIXTURE!;
    assert.ok(fixture, "TITHON_FIXTURE must be set");
    const uri = vscode.Uri.file(fixture);
    const ext = findTithonExtension();
    await ext.activate();

    const cells = parse(readFileSync(fixture, "utf8")).cells;
    const cellIdx = cells.findIndex((c) => c.kind === "code");
    assert.ok(cellIdx >= 0, "fixture must have a code cell");
    const srcCode = cellSource(cells[cellIdx]);

    // 1. Work happened earlier, with no window open on the file. The driver must
    //    pass the SAME project root the extension will (`workdirForUri`): the
    //    workdir is honoured only when a session is first CREATED, and it decides
    //    which journal dir that session gets (ADR-044). Creating it without one
    //    here would hand the extension a different journal — and the sidecar
    //    would carry the outputs across while the close intent, which is
    //    per-session and machine-local, stayed behind.
    const workdir = process.env.TITHON_WORKSPACE;
    assert.ok(workdir, "TITHON_WORKSPACE must be set");
    const driver = new SessionClient(undefined, uri.toString(), workdir);
    await driver.execute(srcCode, {
      uri: uri.toString(),
      range: { start: 0, end: 0 },
      cell_hash: computeCellHash(srcCode),
      index: cellIdx,
    });
    await waitFor(
      async () => {
        const probe = new SessionClient(undefined, uri.toString(), workdir);
        await probe.attach(0);
        const done = probe.executions().some((e) => e.status === "done");
        probe.close();
        return done;
      },
      60000,
      "the driven execution to finish",
    );
    driver.close();

    // 2. The user is finished and terminates the kernel themselves.
    const daemon = new DaemonClient();
    assert.strictEqual(
      await daemon.killKernel(uri.toString()),
      true,
      "kill_kernel must report it terminated a live kernel",
    );

    // 3. They open the file again. Cells start empty (outputs are transient), so
    //    anything in them now was put there by the extension.
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "notebook cells");
    assert.strictEqual(nb.cellAt(cellIdx).outputs.length, 0, "a reopened cell starts empty");
    await vscode.commands.executeCommand("notebook.selectKernel", {
      id: "tithon",
      extension: ext.id,
    });
    // Long enough for the attach, the snapshot and the seed that must not happen.
    await new Promise((r) => setTimeout(r, 6000));

    // The extension saw the history and mapped it to this cell...
    const trace = (await vscode.commands.executeCommand("tithon._seedTrace")) as SeedEntry[];
    assert.ok(
      trace?.length >= 1,
      `extension must still see the history; trace=${JSON.stringify(trace)}`,
    );
    const mine = trace.find((t) => t.mappedCell === cellIdx);
    assert.ok(mine, `history must map to cell ${cellIdx}; trace=${JSON.stringify(trace)}`);
    assert.strictEqual(mine!.status, "done", "the withheld execution is a finished one");
    // ...and deliberately put nothing in it. THIS is the seed skip.
    assert.strictEqual(
      nb.cellAt(cellIdx).outputs.length,
      0,
      `a closed session must not re-seed; cell shows ${JSON.stringify(plainText(nb.cellAt(cellIdx)))}`,
    );

    // 4. Withheld, not deleted: asking brings it back.
    await vscode.commands.executeCommand("tithon.restoreOutputs");
    await waitFor(
      () => plainText(nb.cellAt(cellIdx)).includes("CLOSEDRUN"),
      30000,
      "the restore command to put the withheld output back",
    );

    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  });
});
