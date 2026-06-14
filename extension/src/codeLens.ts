/**
 * CodeLens "Run Cell" for the plain-text view of a percent `.py` (design.md
 * §3.2, Phase 0 item 3 — minimal connection to the daemon). One lens per
 * `# %%` cell; invoking it submits the cell's code to the daemon.
 */
import * as vscode from "vscode";
import { parse, cellSource } from "./serializer";
import { computeCellHash } from "./cellAttach";

export const RUN_CELL_COMMAND = "tithon.runCell";

export class PercentCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const nb = parse(document.getText());
    const lenses: vscode.CodeLens[] = [];
    let line = 0;
    // index counts ALL cells (code + markup) so it aligns with notebook.cellAt(i)
    // and docCellsFromParsed — the authoritative cell identity for output mapping.
    let index = 0;
    for (const cell of nb.cells) {
      const span = (cell.hasMarker ? 1 : 0) + cell.body.length;
      if (cell.kind === "code") {
        const headerLine = cell.hasMarker ? line : line; // lens on the cell's top line
        const range = new vscode.Range(headerLine, 0, headerLine, 0);
        const code = cellSource(cell);
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(play) Run Cell",
            command: RUN_CELL_COMMAND,
            arguments: [
              {
                code,
                origin: {
                  uri: document.uri.toString(),
                  range: { start: line, end: Math.max(line, line + span - 1) },
                  cell_hash: computeCellHash(code),
                  index,
                },
              },
            ],
          }),
        );
      }
      line += span;
      index += 1;
    }
    return lenses;
  }
}
