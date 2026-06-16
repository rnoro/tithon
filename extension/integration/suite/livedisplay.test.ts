/**
 * v33 — REAL VSCode in-place update_display_data: a cell that creates a display
 * with a display_id and then calls update_display() in a loop must update that
 * ONE output IN PLACE (not stack a new output per frame), inside an actual
 * Extension Host (xvfb + electron).
 *
 * Proves the Fix C wiring end-to-end: the extension attaches live, renders the
 * initial display_data, and each update_display_data REPLACES the same
 * NotebookCellOutput (replaceOutputItems) keyed by display_id. The cell's output
 * count is observed to stay at 1 throughout (it would grow to N before the fix)
 * and ends showing the LATEST frame. Coalescing bounds are unit-verified in
 * test/liveSync.test.ts; here we verify the real in-place render.
 */
import * as assert from "assert";
import * as vscode from "vscode";
import { readFileSync } from "fs";
import { parse, cellSource } from "../../src/serializer";
import { SessionClient } from "../../src/sessionClient";
import { computeCellHash } from "../../src/cellAttach";

const dec = new TextDecoder();
const FRAMES = 12; // 1 display_data + (FRAMES-1) update_display_data

function plainText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) {
    for (const item of o.items) {
      if (item.mime === "text/plain") s += dec.decode(item.data);
    }
  }
  return s;
}

async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 30));
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

describe("Tithon in-place update_display_data inside a real VSCode host (v33)", () => {
  it("updates one display output in place instead of stacking per frame", async () => {
    const fixture = process.env.TITHON_FIXTURE!;
    assert.ok(fixture, "TITHON_FIXTURE must be set");
    const uri = vscode.Uri.file(fixture);

    const ext = findTithonExtension();
    await ext.activate();

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "notebook cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext.id });

    // Start live sync BEFORE submitting so the extension catches the whole stream.
    await vscode.commands.executeCommand("tithon.startLive");

    // Drive the display/update loop from a separate client (runs on the daemon).
    const text = readFileSync(fixture, "utf8");
    const cells = parse(text).cells;
    const cellIdx = cells.findIndex((c) => c.kind === "code");
    assert.ok(cellIdx >= 0, "fixture must have a code cell");
    const srcCode = cellSource(cells[cellIdx]);

    const driver = new SessionClient(undefined, uri.toString());
    await driver.execute(srcCode, {
      uri: uri.toString(),
      range: { start: 0, end: 0 },
      cell_hash: computeCellHash(srcCode),
    });

    // Observe the cell as it animates: track the MAX number of outputs ever seen.
    // In place => stays 1; the pre-fix append => grows toward FRAMES.
    let maxOutputs = 0;
    const cell = () => nb.cellAt(cellIdx);
    await waitFor(() => {
      maxOutputs = Math.max(maxOutputs, cell().outputs.length);
      return plainText(cell()).includes(`frame${FRAMES - 1}`);
    }, 30000, "loop to reach the final frame");

    // settle one render tick past the last update
    await new Promise((r) => setTimeout(r, 300));
    maxOutputs = Math.max(maxOutputs, cell().outputs.length);

    const finalText = plainText(cell());
    assert.ok(
      finalText.includes(`frame${FRAMES - 1}`),
      `cell should show the latest frame; got: ${JSON.stringify(finalText)}`,
    );
    // THE fix: exactly one output, in place — not one per frame.
    assert.strictEqual(
      cell().outputs.length,
      1,
      `expected a single in-place output, got ${cell().outputs.length}`,
    );
    assert.strictEqual(
      maxOutputs,
      1,
      `outputs must never stack across frames; max observed was ${maxOutputs} (pre-fix would approach ${FRAMES})`,
    );
    // and no stale earlier frame lingers (in-place replace, not append).
    assert.ok(
      !finalText.includes("frame0\n") && !finalText.includes("'frame0'"),
      `stale first frame must not remain; got: ${JSON.stringify(finalText)}`,
    );
  });
});
