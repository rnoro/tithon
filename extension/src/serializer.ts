/**
 * Percent-format (`# %%`) <-> cell model, with byte-exact round-trip.
 *
 * Design (SPEC.md, Phase 0 item ⑥): the on-disk source is pure
 * percent-format `.py`. We parse it into a cell list for the Tithon Cell View
 * and serialize it back with ZERO reformatting. Round-trip integrity is an
 * absolute requirement, so the parser partitions the input into *physical
 * lines* (each carrying its exact terminator) and assigns every line to exactly
 * one cell; serialization just concatenates those verbatim spans in order.
 * No byte is ever added, dropped, or rewritten — round-trip is lossless by
 * construction, independent of how "correct" the marker detection is.
 *
 * Marker detection is still done properly (string- and bracket-aware) so the
 * cell *boundaries* are semantically right: a `# %%` that appears inside a
 * triple-quoted string literal or inside open brackets is NOT a cell marker.
 */

export type CellKind = "code" | "markdown" | "raw";

export interface PhysicalLine {
  /** Line content without its terminator. */
  text: string;
  /** Exact terminator: "\n" | "\r\n" | "\r" | "" (last line, no newline). */
  terminator: string;
}

export interface Cell {
  kind: CellKind;
  /** First cell may have no `# %%` marker (module header / leading code). */
  hasMarker: boolean;
  /** Verbatim marker line, present iff hasMarker. */
  markerLine?: PhysicalLine;
  /** Lines after the marker (or all lines for a leading marker-less cell). */
  body: PhysicalLine[];
}

export interface ParsedNotebook {
  cells: Cell[];
}

/** A line is a cell marker if (top-level) its text matches `#%%` / `# %%`. */
const MARKER_RE = /^#\s*%%(.*)$/;

/** Split text into physical lines preserving exact terminators. */
export function splitPhysicalLines(text: string): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  let i = 0;
  let start = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      lines.push({ text: text.slice(start, i), terminator: "\n" });
      i += 1;
      start = i;
    } else if (c === "\r") {
      if (i + 1 < n && text[i + 1] === "\n") {
        lines.push({ text: text.slice(start, i), terminator: "\r\n" });
        i += 2;
      } else {
        lines.push({ text: text.slice(start, i), terminator: "\r" });
        i += 1;
      }
      start = i;
    } else {
      i += 1;
    }
  }
  if (start < n) {
    lines.push({ text: text.slice(start), terminator: "" });
  } else if (n === 0) {
    // empty input -> no lines
  }
  return lines;
}

/**
 * For each physical line, decide whether its *start* is at top level (not
 * inside a string literal and bracket depth 0). Scans the full text char by
 * char tracking Python string / comment / bracket state.
 */
function topLevelLineStarts(lines: PhysicalLine[]): boolean[] {
  const result: boolean[] = new Array(lines.length);
  // string state: "" (none) | "'" | '"' | "'''" | '"""'
  let str = "";
  let depth = 0;
  let escaped = false;

  for (let li = 0; li < lines.length; li++) {
    // Record top-level-ness at the START of this line.
    result[li] = str === "" && depth === 0;
    const text = lines[li].text;
    let inComment = false;
    let k = 0;
    while (k < text.length) {
      const c = text[k];
      if (str !== "") {
        // inside a string literal
        if (escaped) {
          escaped = false;
          k += 1;
          continue;
        }
        if (c === "\\") {
          escaped = true;
          k += 1;
          continue;
        }
        if (str.length === 3) {
          if (c === str[0] && text.startsWith(str, k)) {
            str = "";
            k += 3;
            continue;
          }
          k += 1;
          continue;
        }
        // single-char string
        if (c === str) {
          str = "";
        }
        k += 1;
        continue;
      }
      if (inComment) {
        break; // rest of physical line is comment
      }
      if (c === "#") {
        inComment = true;
        k += 1;
        continue;
      }
      if (c === "'" || c === '"') {
        if (text.startsWith(c + c + c, k)) {
          str = c + c + c;
          k += 3;
          continue;
        }
        str = c;
        k += 1;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") {
        depth += 1;
      } else if (c === ")" || c === "]" || c === "}") {
        depth = Math.max(0, depth - 1);
      }
      k += 1;
    }
    // A single-char string does not survive a line break (real Python only
    // continues it across a line via a trailing backslash, which keeps
    // `escaped` true). Triple-quoted strings DO survive.
    if (str.length === 1 && !escaped) {
      str = "";
    }
    escaped = false;
  }
  return result;
}

function markerKind(markerSuffix: string): CellKind {
  const s = markerSuffix.trimStart().toLowerCase();
  if (s.startsWith("[markdown]")) return "markdown";
  if (s.startsWith("[raw]")) return "raw";
  return "code";
}

/** Parse percent-format source bytes (as a string) into a cell model. */
export function parse(text: string): ParsedNotebook {
  const lines = splitPhysicalLines(text);
  const topLevel = topLevelLineStarts(lines);
  const cells: Cell[] = [];

  let current: Cell | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = topLevel[i] ? MARKER_RE.exec(line.text) : null;
    if (m) {
      current = {
        kind: markerKind(m[1]),
        hasMarker: true,
        markerLine: line,
        body: [],
      };
      cells.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      // leading content before the first marker
      current = { kind: "code", hasMarker: false, body: [line] };
      cells.push(current);
    }
  }
  return { cells };
}

/** Serialize a cell model back to source bytes — byte-exact with the input. */
export function serialize(nb: ParsedNotebook): string {
  const parts: string[] = [];
  for (const cell of nb.cells) {
    if (cell.hasMarker && cell.markerLine) {
      parts.push(cell.markerLine.text + cell.markerLine.terminator);
    }
    for (const line of cell.body) {
      parts.push(line.text + line.terminator);
    }
  }
  return parts.join("");
}

/** The display source of a cell (its body, marker excluded), joined verbatim. */
export function cellSource(cell: Cell): string {
  return cell.body.map((l) => l.text + l.terminator).join("");
}

/**
 * Body lines for a cell synthesized from plain text (a cell added in the Cell
 * View, which carries no terminators). Every line — including the last — ends
 * with "\n" so a following `# %%` marker starts on its own line instead of
 * gluing onto the last code line (which would make parse() miss the marker and
 * collapse the file back to one cell). A trailing newline in `value` is
 * normalized so the cell ends with exactly one.
 */
export function bodyLinesFromText(value: string): PhysicalLine[] {
  const v = value.endsWith("\n") ? value : value + "\n";
  const lines = v.split("\n");
  lines.pop(); // drop the trailing "" produced by the final "\n"
  return lines.map((text) => ({ text, terminator: "\n" }));
}

/** Number of top-level cell markers in the source (for structural checks). */
export function countMarkers(text: string): number {
  const lines = splitPhysicalLines(text);
  const topLevel = topLevelLineStarts(lines);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (topLevel[i] && MARKER_RE.test(lines[i].text)) count += 1;
  }
  return count;
}
