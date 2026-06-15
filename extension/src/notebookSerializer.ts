/**
 * VSCode NotebookSerializer for percent-format `.py` (notebook type
 * `tithon-py`, SPEC.md). Disk holds pure percent `.py`; this opens it as
 * a cell document. Round-trip is delegated to the byte-exact pure serializer:
 * each cell carries its verbatim parsed structure in metadata, and
 * `serializeNotebook` reconstructs from that — so an unedited open->save is a
 * 0-byte diff (the Phase 0 ⑥ guarantee, verified by verify/v6.sh).
 */
import * as vscode from "vscode";
import { parse, serialize, cellSource, bodyLinesFromText, type Cell } from "./serializer";

const dec = new TextDecoder();
const enc = new TextEncoder();

const META_KEY = "tithonCell";

/** Display source for a markdown cell: drop the leading `# ` jupytext comment. */
function uncommentMarkdown(src: string): string {
  return src.replace(/^# ?/gm, "");
}

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
    const cells: Cell[] = data.cells.map((c) => {
      const stored = c.metadata?.[META_KEY] as Cell | undefined;
      if (stored) return stored;
      // a cell the user added in the Cell View: synthesize a percent cell.
      return synthesizeCell(c);
    });
    return enc.encode(serialize({ cells }));
  }
}

function synthesizeCell(c: vscode.NotebookCellData): Cell {
  const isMarkup = c.kind === vscode.NotebookCellKind.Markup;
  // A cell added via the Cell View carries no line terminators; bodyLinesFromText
  // ensures each line ends with "\n" so the next `# %%` marker isn't glued onto
  // the last code line (which would collapse the file back to one cell).
  const body = bodyLinesFromText(c.value);
  return {
    kind: isMarkup ? "markdown" : "code",
    hasMarker: true,
    markerLine: { text: isMarkup ? "# %% [markdown]" : "# %%", terminator: "\n" },
    body,
  };
}
