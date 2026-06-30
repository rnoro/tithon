/**
 * v12 — DIAGNOSTIC: multiple cells, "Run All", in a real VSCode host.
 * Reproduces the user's report: with several `# %%` cells, only the last cell's
 * output shows, and it lands on the TOP cell. This logs the ground truth —
 * per-cell text, the hash the execute path computes vs. the hash the live-sync
 * index computes from the file — then asserts each cell shows ITS OWN output.
 */
import * as assert from "assert";
import * as vscode from "vscode";
import { readFileSync } from "fs";
import { parse, cellSource } from "../../src/serializer";
import { computeCellHash, docCellsFromParsed } from "../../src/cellAttach";

const dec = new TextDecoder();

function cellText(cell: vscode.NotebookCell): string {
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
    if (Date.now() > deadline) return; // diagnostic: don't throw, just report
    await new Promise((r) => setTimeout(r, 50));
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

describe("Tithon multi-cell Run All in a real VSCode host (v12)", () => {
  it("maps each cell's output to its own cell", async () => {
    const fixture = process.env.TITHON_FIXTURE!;
    const uri = vscode.Uri.file(fixture);
    const ext = findTithonExtension();
    await ext.activate();

    // Ground truth from the file as the live-sync index sees it.
    const fileText = readFileSync(fixture, "utf8");
    const parsed = parse(fileText).cells;
    const docCells = docCellsFromParsed(parsed);
    console.log("\n[v12] FILE has", parsed.length, "parsed cells");
    docCells.forEach((dc) => {
      console.log(`[v12]  file cell #${dc.index} hash=${dc.cellHash.slice(0, 12)} src=${JSON.stringify(cellSource(parsed[dc.index]))}`);
    });

    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    console.log("[v12] NOTEBOOK has", nb.cellCount, "cells");
    for (let i = 0; i < nb.cellCount; i++) {
      const t = nb.cellAt(i).document.getText();
      console.log(`[v12]  nb cell #${i} hash=${computeCellHash(t).slice(0, 12)} text=${JSON.stringify(t)}`);
    }

    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext.id });
    // Run ALL cells via the native command — no manual live step.
    await vscode.commands.executeCommand("notebook.execute");

    // Let outputs settle.
    await waitFor(() => {
      let withOutput = 0;
      for (let i = 0; i < nb.cellCount; i++) if (cellText(nb.cellAt(i)).length > 0) withOutput++;
      return withOutput >= nb.cellCount;
    }, 20000, "all cells to show output");

    console.log("[v12] RESULT per-cell output:");
    for (let i = 0; i < nb.cellCount; i++) {
      console.log(`[v12]  cell #${i} -> ${JSON.stringify(cellText(nb.cellAt(i)))}`);
    }

    // Each cell prints CELL<index>; assert it lands on the right cell.
    for (let i = 0; i < nb.cellCount; i++) {
      const t = cellText(nb.cellAt(i));
      assert.ok(t.includes(`CELL${i}`), `cell #${i} should contain CELL${i} but had ${JSON.stringify(t)}`);
    }
  });
});
