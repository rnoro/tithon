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

  it("SKIPS an execution whose hash matches no cell (no proximity collapse) — ADR-019", () => {
    const cells = docCells();
    // execution whose code no longer matches any cell (edited since the run).
    // Old behavior collapsed it onto a nearby cell; now it is dropped so it can
    // never land on the wrong cell.
    const execs: JournalExecution[] = [
      {
        execId: "e9",
        cellHash: computeCellHash("z = 3  # edited away\n"),
        range: { start: 4, end: 5 },
        outputs: ["stale-C"],
      },
    ];
    const att = attachOutputs(execs, cells);
    expect(att.size).toBe(0);
  });

  it("does not collapse several non-matching executions onto cell 0 — ADR-019 (#2 repro)", () => {
    const cells = docCells();
    // Three executions, none matching the current file (e.g. a global/persistent
    // journal from another file). Previously all three piled onto cell 0 and the
    // last won; now every one is skipped.
    const execs: JournalExecution[] = [
      { execId: "e1", cellHash: "stale-a", range: { start: 0, end: 0 }, outputs: ["A"] },
      { execId: "e2", cellHash: "stale-b", range: { start: 0, end: 0 }, outputs: ["B"] },
      { execId: "e3", cellHash: "stale-c", range: { start: 0, end: 0 }, outputs: ["C"] },
    ];
    const att = attachOutputs(execs, cells);
    expect(att.size).toBe(0);
    expect(att.has(0)).toBe(false);
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

  it("maps duplicate-code cells by recorded index, not hash — ADR-026 (#2 repro)", () => {
    // Two cells with IDENTICAL code share a cell_hash. The output of the SECOND
    // cell must land on the second cell, not collapse onto the first.
    const dupSrc = ["# %% a", 'print("dup")', "# %% b", 'print("dup")', ""].join("\n");
    const cells = docCellsFromParsed(parse(dupSrc).cells);
    const h = cells[0].cellHash;
    expect(cells[1].cellHash).toBe(h); // same code => same hash
    const execs: JournalExecution[] = [
      { execId: "e0", cellHash: h, index: 0, range: { start: 0, end: 1 }, outputs: ["first"] },
      { execId: "e1", cellHash: h, index: 1, range: { start: 2, end: 3 }, outputs: ["second"] },
    ];
    const att = attachOutputs(execs, cells);
    expect(att.get(0)?.execId).toBe("e0");
    expect(att.get(0)?.outputs).toEqual(["first"]);
    expect(att.get(1)?.execId).toBe("e1");
    expect(att.get(1)?.outputs).toEqual(["second"]); // NOT collapsed onto cell 0
  });

  it("follows content to its new cell after a top insert shifts indices — ADR-047 (#2)", () => {
    // FIRST(idx0)/SECOND(idx1) ran, then a cell was INSERTED at the top, so the
    // file now has INSERTED(0) FIRST(1) SECOND(2). The recorded indices (0,1) are
    // stale; mapping must follow the cell_hash, NOT pile output onto the old index.
    const ran = ["# %% a", 'print("FIRST")', "# %% b", 'print("SECOND")', ""].join("\n");
    const after = ["# %% i", 'print("INSERTED")', "\n", ran].join("\n");
    const rc = docCellsFromParsed(parse(ran).cells);
    const cells = docCellsFromParsed(parse(after).cells);
    const execs: JournalExecution[] = [
      { execId: "e1", cellHash: rc[0].cellHash, index: 0, range: { start: 0, end: 1 }, outputs: ["FIRST"] },
      { execId: "e2", cellHash: rc[1].cellHash, index: 1, range: { start: 2, end: 3 }, outputs: ["SECOND"] },
    ];
    const att = attachOutputs(execs, cells);
    expect(att.has(0)).toBe(false); // INSERTED cell stays empty (not FIRST)
    expect(att.get(1)?.outputs).toEqual(["FIRST"]); // followed to its real cell
    expect(att.get(1)?.stale).toBe(false);
    expect(att.get(2)?.outputs).toEqual(["SECOND"]);
  });

  it("flags a cell edited-in-place since its run as stale — ADR-047 (#3)", () => {
    // cell 0 ran as ALPHA, then was edited to BETA without re-running. The old
    // output attaches to that same cell but flagged stale (not a fresh ✓ run).
    const after = docCellsFromParsed(parse(["# %% a", 'print("BETA")', ""].join("\n")).cells);
    const execs: JournalExecution[] = [
      { execId: "e1", cellHash: computeCellHash('print("ALPHA")\n'), index: 0, range: { start: 0, end: 1 }, outputs: ["ALPHA"] },
    ];
    const att = attachOutputs(execs, after);
    expect(att.get(0)?.outputs).toEqual(["ALPHA"]);
    expect(att.get(0)?.stale).toBe(true);
  });

  it("falls back to cell_hash when no index is recorded (legacy/CLI runs)", () => {
    const cells = docCells();
    const cHash = cells[2].cellHash;
    const execs: JournalExecution[] = [
      { execId: "e1", cellHash: cHash, range: { start: 4, end: 5 }, outputs: ["C"] },
    ];
    const att = attachOutputs(execs, cells);
    expect(att.get(2)?.execId).toBe("e1");
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
