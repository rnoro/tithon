/**
 * VSCode NotebookSerializer for percent-format `.py` (notebook type
 * `tithon-py`, SPEC.md). Disk holds pure percent `.py`; this opens it as
 * a cell document. Round-trip is delegated to the byte-exact pure serializer:
 * each cell carries its verbatim parsed structure in metadata, and
 * `serializeNotebook` reconstructs from that — so an unedited open->save is a
 * 0-byte diff (the Phase 0 ⑥ guarantee, verified by scripts/v6.sh).
 */
import * as vscode from "vscode";
import {
  parse,
  serialize,
  cellSource,
  uncommentMarkdown,
  resolveCell,
  type Cell,
} from "./serializer";

const dec = new TextDecoder();
const enc = new TextEncoder();

const META_KEY = "tithonCell";

export class PercentNotebookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const text = dec.decode(content);
    const nb = parse(text);
    const cells = nb.cells.map((cell) => {
      const isMarkup = cell.kind === "markdown";
      const kind = isMarkup
        ? vscode.NotebookCellKind.Markup
        : vscode.NotebookCellKind.Code;
      const raw = cellSource(cell);
      const value = isMarkup ? uncommentMarkdown(raw) : raw;
      const data = new vscode.NotebookCellData(
        kind,
        value,
        isMarkup ? "markdown" : "python",
      );
      // verbatim structure for byte-exact serialization
      data.metadata = { [META_KEY]: cell };
      return data;
    });
    return new vscode.NotebookData(cells);
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    // resolveCell returns the stored structure verbatim for an UNEDITED cell
    // (byte-exact round-trip), but rebuilds the body from the cell's current
    // text when it was edited — so an edit to an existing cell is actually
    // persisted instead of silently reverting to the old metadata content.
    const cells: Cell[] = data.cells.map((c, i) => {
      const stored = c.metadata?.[META_KEY] as Cell | undefined;
      const isMarkup = c.kind === vscode.NotebookCellKind.Markup;
      // Only the first cell may be marker-less; pass the position so a header
      // cell moved off the top gets a marker instead of merging upward.
      return resolveCell(c.value, isMarkup, stored, i === 0);
    });
    return enc.encode(serialize({ cells }));
  }
}
