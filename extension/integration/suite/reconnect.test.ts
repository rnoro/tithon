/**
 * v15 — REAL VSCode mid-run RECONNECT: a long loop is already running (driven by
 * a separate client, i.e. the kernel keeps going), then a fresh VSCode client
 * attaches partway through. The cell must show BOTH the output produced BEFORE
 * the reconnect (restored from the snapshot) AND the output produced AFTER it
 * (streamed live) — seamless, as if the client had watched from the start
 * (design.md §3.1: snapshot + delta + live).
 */
import * as assert from "assert";
import * as vscode from "vscode";
import { readFileSync } from "fs";
import { parse, cellSource } from "../../src/serializer";
import { SessionClient } from "../../src/sessionClient";
import { computeCellHash } from "../../src/cellAttach";

const dec = new TextDecoder();

function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) for (const it of o.items) {
    if (it.mime.includes("stdout") || it.mime === "text/plain") s += dec.decode(it.data);
  }
  return s;
}

async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function ext(): vscode.Extension<unknown> {
  const e = vscode.extensions.all.find((x) =>
    (x.packageJSON?.contributes?.commands ?? []).some((c: { command?: string }) => c.command === "tithon.startLive"));
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

function linesPresent(text: string): number[] {
  return text.split("\n").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);
}

describe("Tithon mid-run reconnect: restore prior + continue live (v15)", () => {
  it("shows pre-reconnect output AND keeps streaming after reconnect", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();

    // The loop cell source (must match the daemon's cell_hash via getText()).
    const cells = parse(readFileSync(uri.fsPath, "utf8")).cells;
    const loopIdx = cells.findIndex((c) => c.kind === "code" && c.body.some((l) => l.text.includes("range(30)")));
    assert.ok(loopIdx >= 0, "fixture must have the range(30) loop");
    const src = cellSource(cells[loopIdx]);

    // 1) A separate client starts the long loop; the kernel runs independently.
    const driver = new SessionClient();
    await driver.execute(src, { uri: uri.toString(), range: { start: 0, end: 0 }, cell_hash: computeCellHash(src) });

    // 2) Let it run partway so there is real pre-reconnect output to restore.
    const watcher = new SessionClient();
    await watcher.attach(0);
    await waitFor(() => {
      const ex = watcher.executions().find((e) => e.cellHash === computeCellHash(src));
      if (!ex) return false;
      return linesPresent((watcher.outputsOf(ex.execId)[0] as any)?.text ?? "").length >= 5;
    }, 20000, "at least 5 lines produced before reconnect");
    const preReconnectMax = (() => {
      const ex = watcher.executions().find((e) => e.cellHash === computeCellHash(src))!;
      return Math.max(...linesPresent((watcher.outputsOf(ex.execId)[0] as any)?.text ?? ""));
    })();
    watcher.close();
    console.log(`[v15] reconnecting after ~${preReconnectMax} lines already printed`);

    // 3) NOW a fresh VSCode client opens the notebook and attaches (the reconnect).
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 1, 15000, "cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });
    await vscode.commands.executeCommand("tithon.startLive");

    // 4) The cell must end up with the FULL 0..29 — early (restored) + late (live).
    await waitFor(() => cellText(nb.cellAt(loopIdx)).includes("29"), 30000, "loop to finish in the cell");

    const present = new Set(linesPresent(cellText(nb.cellAt(loopIdx))));
    const missing = [];
    for (let i = 0; i <= 29; i++) if (!present.has(i)) missing.push(i);
    console.log(`[v15] final cell lines: ${[...present].sort((a, b) => a - b).join(",")}`);
    assert.strictEqual(missing.length, 0, `cell missing lines ${missing.join(",")} (prior output not restored?)`);
    // Sanity: we really did reconnect mid-run (some lines predated the reconnect).
    assert.ok(preReconnectMax >= 4, "expected a real mid-run reconnect");

    driver.close();
    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  });
});
