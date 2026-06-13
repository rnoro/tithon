/**
 * v10 — REAL VSCode live output sync: a long-running cell streams into the
 * notebook cell *as it runs*, inside an actual Extension Host (xvfb + electron).
 *
 * Proves the live path end-to-end: the extension (tithon.startLive) attaches to
 * the daemon and mirrors the output stream; a separate driver submits a slow
 * loop; the cell's stdout is observed GROWING over time (not a single dump at
 * the end) and ends with the full output. Coalescing/bounds are unit-verified in
 * test/liveSync.test.ts; here we verify the live wiring actually renders.
 */
import * as assert from "assert";
import * as vscode from "vscode";
import { readFileSync } from "fs";
import { parse, cellSource } from "../../src/serializer";
import { SessionClient } from "../../src/sessionClient";
import { computeCellHash } from "../../src/cellAttach";

const dec = new TextDecoder();

function stdoutText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) {
    for (const item of o.items) {
      if (item.mime.includes("stdout") || item.mime === "text/plain") s += dec.decode(item.data);
    }
  }
  return s;
}

async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

function findTithonExtension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.all.find((e) =>
    (e.packageJSON?.contributes?.commands ?? []).some(
      (c: { command?: string }) => c.command === "tithon.startLive",
    ),
  );
  if (!ext) throw new Error("Tithon extension not found");
  return ext;
}

describe("Tithon live output sync inside a real VSCode host (v10)", () => {
  it("streams a long-running cell into the notebook as it runs", async () => {
    const fixture = process.env.TITHON_FIXTURE!;
    assert.ok(fixture, "TITHON_FIXTURE must be set");
    const uri = vscode.Uri.file(fixture);

    const ext = findTithonExtension();
    await ext.activate();

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "notebook cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext.id });

    // Start live sync BEFORE submitting, so the extension catches the stream.
    await vscode.commands.executeCommand("tithon.startLive");

    // Drive the long cell from a separate client (the "kernel" runs on the daemon).
    const text = readFileSync(fixture, "utf8");
    const cells = parse(text).cells;
    const loopIdx = cells.findIndex((c) => c.kind === "code" && c.body.some((l) => l.text.includes("range(20)")));
    assert.ok(loopIdx >= 0, "fixture must have the loop cell");
    const src = cellSource(cells[loopIdx]);

    const driver = new SessionClient();
    await driver.execute(src, {
      uri: uri.toString(),
      range: { start: 0, end: 0 },
      cell_hash: computeCellHash(src),
    });

    // Observe the cell stdout growing: collect distinct line-counts over time.
    const seen = new Set<number>();
    const lineCount = () => {
      const t = stdoutText(nb.cellAt(loopIdx));
      return t ? t.split("\n").filter((x) => x.length > 0).length : 0;
    };
    await waitFor(() => {
      seen.add(lineCount());
      return stdoutText(nb.cellAt(loopIdx)).includes("19");
    }, 30000, "loop to finish streaming");

    const finalText = stdoutText(nb.cellAt(loopIdx));
    // final correctness: all 20 lines present
    for (let i = 0; i < 20; i++) {
      assert.ok(finalText.includes(`${i}`), `missing line ${i} in: ${JSON.stringify(finalText)}`);
    }
    // liveness: we saw an intermediate state (not just 0 -> 20), i.e. it streamed
    const intermediates = [...seen].filter((n) => n > 0 && n < 20);
    assert.ok(
      intermediates.length > 0,
      `expected to observe incremental growth; line-counts seen: ${[...seen].sort((a, b) => a - b)}`,
    );
  });
});
