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
 * Identity is resolved per execution in three tiers (DECISIONS ADR-047, which
 * refines ADR-019/026):
 *   1. STRONG — the cell at the recorded `index` still has the SAME code
 *      (`cellHash` matches). This is authoritative and handles two cells with
 *      IDENTICAL code (the duplicate-cell bug, ADR-026), since each carries its
 *      own submit-time index.
 *   2. MOVED — the index'd cell's code differs, but some OTHER cell still has
 *      this execution's exact `cellHash` (the cell moved, e.g. a cell was
 *      inserted above so every later cell shifted down). Attach to where the
 *      content actually is, not the stale index → fixes the "insert a cell, then
 *      reopen, and every output is off by one" misattribution.
 *   3. STALE — the index'd cell exists but was EDITED since it ran and the old
 *      code is nowhere else. Attach the old output to that same cell flagged
 *      `stale: true`, so it renders with the §3.2 stale badge instead of
 *      masquerading as a fresh successful run.
 *
 * Index-first alone (the old behavior) misattributed on inserts; pure exact-hash
 * (ADR-019) dropped edited cells and collapsed duplicates. Cross-file collapse
 * is prevented separately by uri-scoping the executions (see
 * {@link SessionClient.restoreInto}). When several executions resolve to the
 * same cell, the later one (array order) wins.
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

  /** Pick the closest same-hash cell to a range (tiebreak duplicate-hash cells). */
  const closestByHash = (cellHash: string, range: LineRange): DocCell | undefined => {
    const matches = byHash.get(cellHash);
    if (!matches || matches.length === 0) return undefined;
    return matches
      .slice()
      .sort((a, b) => proximity(a.range, range) - proximity(b.range, range) || a.index - b.index)[0];
  };

  for (const ex of executions) {
    let target: DocCell | undefined;
    let stale = false;
    const atIndex = ex.index != null ? byIndex.get(ex.index) : undefined;
    if (atIndex && atIndex.cellHash === ex.cellHash) {
      target = atIndex; // 1) strong: right index, unchanged code
    } else {
      const moved = closestByHash(ex.cellHash, ex.range);
      if (moved) {
        target = moved; // 2) moved: follow the content to its new cell
      } else if (atIndex) {
        target = atIndex; // 3) stale: edited in place, old code gone elsewhere
        stale = true;
      } else {
        continue; // no index and no hash match -> skip (don't guess a cell)
      }
    }
    byCell.set(target.index, {
      cellIndex: target.index,
      execId: ex.execId,
      stale,
      outputs: ex.outputs,
    });
  }
  return byCell;
}
