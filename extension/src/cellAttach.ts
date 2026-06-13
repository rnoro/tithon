/**
 * Output -> cell attachment (design.md §3.2).
 *
 * The journal owns outputs, not the `.py` file. Each execution recorded a
 * `cell_hash` (hash of the submitted cell code) and the line range it came
 * from. When opening the Cell View we attach journal outputs to the cells now
 * present in the document by:
 *   1. `cell_hash` exact match (authoritative — same code => same output), else
 *   2. range proximity (the cell was edited; show the old output as "stale"
 *      until re-run).
 */

import { createHash } from "crypto";
import type { Cell } from "./serializer";
import { cellSource } from "./serializer";

export interface LineRange {
  /** 0-based inclusive start line. */
  start: number;
  /** 0-based inclusive end line. */
  end: number;
}

export interface JournalExecution {
  execId: string;
  cellHash: string;
  range: LineRange;
  outputs: unknown[];
}

export interface DocCell {
  index: number;
  cellHash: string;
  range: LineRange;
}

export interface Attachment {
  cellIndex: number;
  execId: string;
  /** True when matched only by proximity (cell code changed since the run). */
  stale: boolean;
  outputs: unknown[];
}

/** Stable cell hash: sha256 of the cell's verbatim source bytes (UTF-8). */
export function computeCellHash(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** Build doc-cell descriptors from a parsed notebook's cells. */
export function docCellsFromParsed(cells: Cell[]): DocCell[] {
  const out: DocCell[] = [];
  let line = 0;
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index];
    const span =
      (cell.hasMarker ? 1 : 0) + cell.body.length;
    const start = line;
    const end = Math.max(start, line + span - 1);
    out.push({ index, cellHash: computeCellHash(cellSource(cell)), range: { start, end } });
    line += span;
  }
  return out;
}

function proximity(a: LineRange, b: LineRange): number {
  // 0 if overlapping, else gap between the ranges.
  if (a.start <= b.end && b.start <= a.end) return 0;
  return a.start > b.end ? a.start - b.end : b.start - a.end;
}

/**
 * Attach each execution's outputs to a document cell. Returns one attachment
 * per cell that received output; when several executions target the same cell
 * the later execution (by array order) wins.
 */
export function attachOutputs(
  executions: JournalExecution[],
  docCells: DocCell[],
): Map<number, Attachment> {
  const byCell = new Map<number, Attachment>();
  const byHash = new Map<string, DocCell[]>();
  for (const dc of docCells) {
    const list = byHash.get(dc.cellHash);
    if (list) list.push(dc);
    else byHash.set(dc.cellHash, [dc]);
  }

  for (const ex of executions) {
    let target: DocCell | undefined;
    let stale = false;
    const hashMatches = byHash.get(ex.cellHash);
    if (hashMatches && hashMatches.length > 0) {
      // Prefer the closest hash match by range, then earliest index.
      target = hashMatches
        .slice()
        .sort(
          (a, b) =>
            proximity(a.range, ex.range) - proximity(b.range, ex.range) ||
            a.index - b.index,
        )[0];
    } else if (docCells.length > 0) {
      stale = true;
      target = docCells
        .slice()
        .sort(
          (a, b) =>
            proximity(a.range, ex.range) - proximity(b.range, ex.range) ||
            a.index - b.index,
        )[0];
    }
    if (target === undefined) continue;
    byCell.set(target.index, {
      cellIndex: target.index,
      execId: ex.execId,
      stale,
      outputs: ex.outputs,
    });
  }
  return byCell;
}
