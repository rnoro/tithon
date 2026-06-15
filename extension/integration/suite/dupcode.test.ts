/**
 * v20 — REAL VSCode: two cells holding IDENTICAL code must each show their OWN
 * output (user feedback #2: "the second cell's output appeared on the first
 * cell"). cell_hash = sha256(code) is identical for both, so the old
 * hash-only mapping collapsed both onto cell 0. The fix maps by the recorded
 * cell index (ADR-026). Here both cells print "SAME"; the assertion is that
 * cell 1 ALSO got output (it would be empty if collapsed onto cell 0).
 */
import * as assert from "assert";
import * as vscode from "vscode";

const dec = new TextDecoder();
function cellText(cell: vscode.NotebookCell): string {
  let s = "";
  for (const o of cell.outputs) for (const it of o.items)
    if (it.mime.includes("stdout") || it.mime === "text/plain") s += dec.decode(it.data);
  return s;
}
async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) { if (Date.now() > deadline) throw new Error(`timed out: ${label}`); await new Promise((r) => setTimeout(r, 50)); }
}
function ext(): vscode.Extension<unknown> {
  const e = vscode.extensions.all.find((x) =>
    (x.packageJSON?.contributes?.commands ?? []).some((c: { command?: string }) => c.command === "tithon.startLive"));
  if (!e) throw new Error("Tithon extension not found");
  return e;
}

describe("Tithon duplicate-code cells map independently (v20)", () => {
  it("the second of two identical cells gets its OWN output", async () => {
    const uri = vscode.Uri.file(process.env.TITHON_FIXTURE!);
    await ext().activate();
    const nb = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(nb);
    await waitFor(() => nb.cellCount >= 2, 15000, "two cells");
    await vscode.commands.executeCommand("notebook.selectKernel", { id: "tithon", extension: ext().id });

    // Run ALL cells the native way (Run All) — this submits BOTH cells.
    await vscode.commands.executeCommand("notebook.execute");

    // The bug: cell 1 stayed empty (its output landed on cell 0). Require BOTH.
    await waitFor(
      () => cellText(nb.cellAt(0)).includes("SAME") && cellText(nb.cellAt(1)).includes("SAME"),
      30000, "both cells to show their own output",
    );

    assert.ok(cellText(nb.cellAt(0)).includes("SAME"), "cell 0 missing output");
    assert.ok(cellText(nb.cellAt(1)).trim().length > 0, "cell 1 is EMPTY (collapsed onto cell 0)");
    assert.ok(cellText(nb.cellAt(1)).includes("SAME"), "cell 1 missing its own output");

    // Hold the window open so scripts/shot.sh can screenshot the rendered cells.
    const holdMs = Number(process.env.TITHON_HOLD_MS ?? "0");
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  });
});
