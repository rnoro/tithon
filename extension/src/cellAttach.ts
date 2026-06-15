/**
 * Output -> cell attachment (SPEC.md).
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
  /** 0-based cell index recorded at submit time — authoritative cell identity
   *  (distinguishes two cells with identical code). Null for legacy/CLI runs. */
  index?: number | null;
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

/** One execution as it appears in the daemon's `snapshot.executions[]`. */
export interface SnapshotExecution {
  exec_id: string;
  cell_hash?: string | null;
  origin?: { uri?: string | null; range?: LineRange | null; index?: number | null } | null;
  outputs: unknown[];
}

/**
 * Convert daemon snapshot executions into attachable journal executions. The
 * daemon computes `cell_hash = sha256(code)` (matching {@link computeCellHash}),
 * so this is the bridge between the live journal and {@link attachOutputs}.
 * Executions without a cell_hash (none should occur post-wiring) are skipped.
 */
export function executionsFromSnapshot(execs: SnapshotExecution[]): JournalExecution[] {
  const out: JournalExecution[] = [];
  for (const e of execs) {
    if (!e.cell_hash) continue;
    out.push({
      execId: e.exec_id,
      cellHash: e.cell_hash,
      range: e.origin?.range ?? { start: 0, end: 0 },
      index: e.origin?.index ?? null,
      outputs: e.outputs,
    });
  }
  return out;
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
 * Attach each execution's outputs to a document cell.
 *
 * Identity is resolved in priority order:
 *   1. the recorded `index` (authoritative — captured at submit time, so two
 *      cells with IDENTICAL code map to the right one; the duplicate-cell bug,
 *      DECISIONS ADR-026), then
 *   2. EXACT cell_hash match (covers legacy/CLI runs that carry no index).
 *
 * An execution that matches neither is SKIPPED, not collapsed onto a nearby
 * cell. The old range-proximity fallback piled mismatched runs onto cell 0
 * (ADR-019); with index-or-exact-hash only, a cell edited since its run simply
 * restores nothing rather than the wrong output. Callers should also scope
 * `executions` to the current file's uri (see {@link SessionClient.restoreInto}).
 *
 * When several executions resolve to the same cell, the later one (array order)
 * wins. Range proximity only tiebreaks genuine duplicate-hash cells with no
 * index.
 */
export function attachOutputs(
  executions: JournalExecution[],
  docCells: DocCell[],
): Map<number, Attachment> {
  const byCell = new Map<number, Attachment>();
  const byIndex = new Map<number, DocCell>();
  const byHash = new Map<string, DocCell[]>();
  for (const dc of docCells) {
    byIndex.set(dc.index, dc);
    const list = byHash.get(dc.cellHash);
    if (list) list.push(dc);
    else byHash.set(dc.cellHash, [dc]);
  }

  for (const ex of executions) {
    let target: DocCell | undefined;
    if (ex.index != null) target = byIndex.get(ex.index); // authoritative
    if (!target) {
      const hashMatches = byHash.get(ex.cellHash);
      if (!hashMatches || hashMatches.length === 0) continue; // no match -> skip
      // Among identical-hash (duplicate) cells, prefer the closest by range,
      // then earliest index. For the common 1:1 case this picks that one cell.
      target = hashMatches
        .slice()
        .sort(
          (a, b) =>
            proximity(a.range, ex.range) - proximity(b.range, ex.range) ||
            a.index - b.index,
        )[0];
    }
    byCell.set(target.index, {
      cellIndex: target.index,
      execId: ex.execId,
      stale: false,
      outputs: ex.outputs,
    });
  }
  return byCell;
}
