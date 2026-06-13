import { describe, it, expect } from "vitest";
import { parse, cellSource } from "../src/serializer";
import {
  attachOutputs,
  computeCellHash,
  docCellsFromParsed,
  executionsFromSnapshot,
  type JournalExecution,
  type SnapshotExecution,
} from "../src/cellAttach";

const SRC = ["# %% a", "x = 1", "# %% b", "y = 2", "# %% c", "z = 3", ""].join("\n");

function docCells() {
  return docCellsFromParsed(parse(SRC).cells);
}

describe("output -> cell attachment", () => {
  it("attaches by cell_hash to the exact cell", () => {
    const cells = docCells();
    // execution from cell "b" (hash of its body source).
    const bHash = cells[1].cellHash;
    const execs: JournalExecution[] = [
      { execId: "e1", cellHash: bHash, range: { start: 99, end: 99 }, outputs: ["B"] },
    ];
    const att = attachOutputs(execs, cells);
    expect(att.get(1)?.execId).toBe("e1");
    expect(att.get(1)?.stale).toBe(false);
    expect(att.get(1)?.outputs).toEqual(["B"]);
    // nothing attached to other cells
    expect(att.has(0)).toBe(false);
    expect(att.has(2)).toBe(false);
  });

  it("falls back to range proximity and marks the output stale when the cell was edited", () => {
    const cells = docCells();
    // execution whose code no longer matches any cell (hash changed), but its
    // recorded range is closest to cell "c".
    const execs: JournalExecution[] = [
      {
        execId: "e9",
        cellHash: computeCellHash("z = 3  # edited away\n"),
        range: { start: 4, end: 5 },
        outputs: ["stale-C"],
      },
    ];
    const att = attachOutputs(execs, cells);
    expect(att.get(2)?.execId).toBe("e9");
    expect(att.get(2)?.stale).toBe(true);
  });

  it("lets the later execution win when several target the same cell", () => {
    const cells = docCells();
    const aHash = cells[0].cellHash;
    const execs: JournalExecution[] = [
      { execId: "old", cellHash: aHash, range: { start: 0, end: 1 }, outputs: ["old"] },
      { execId: "new", cellHash: aHash, range: { start: 0, end: 1 }, outputs: ["new"] },
    ];
    const att = attachOutputs(execs, cells);
    expect(att.get(0)?.execId).toBe("new");
    expect(att.get(0)?.outputs).toEqual(["new"]);
  });

  it("computes a stable, content-addressed cell hash", () => {
    expect(computeCellHash("x = 1\n")).toBe(computeCellHash("x = 1\n"));
    expect(computeCellHash("x = 1\n")).not.toBe(computeCellHash("x = 2\n"));
  });
});

describe("daemon snapshot -> cell attachment (end-to-end bridge)", () => {
  it("attaches outputs from a real-shaped daemon snapshot via cell_hash", () => {
    const cells = docCells();
    // The daemon computes cell_hash = sha256(code); the extension hashes the
    // cell's verbatim source the same way, so these line up.
    const snapshotExecs: SnapshotExecution[] = [
      {
        exec_id: "e1",
        cell_hash: computeCellHash(cellAt(1)),
        origin: { uri: "file:///w/n.py", range: { start: 2, end: 3 } },
        outputs: ["from-daemon-B"],
      },
    ];
    const execs = executionsFromSnapshot(snapshotExecs);
    expect(execs).toHaveLength(1);
    const att = attachOutputs(execs, cells);
    expect(att.get(1)?.execId).toBe("e1");
    expect(att.get(1)?.stale).toBe(false);
    expect(att.get(1)?.outputs).toEqual(["from-daemon-B"]);
  });

  it("skips executions that carry no cell_hash", () => {
    const execs = executionsFromSnapshot([
      { exec_id: "e1", outputs: [] },
      { exec_id: "e2", cell_hash: null, outputs: [] },
    ]);
    expect(execs).toHaveLength(0);
  });
});

/** Verbatim source of the cell at index `i` in SRC (mirrors the daemon code). */
function cellAt(i: number): string {
  return cellSource(parse(SRC).cells[i]);
}
