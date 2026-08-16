/**
 * Traceback ANSI cleanup — a pure function so it's unit-testable without a
 * DOM. IPython's own traceback formatter sets
 * background-color SGR codes in some color schemes (`\x1b[4Xm` / `\x1b[10Xm` /
 * `\x1b[48;5;Nm` / `\x1b[48;2;R;G;Bm`), which VSCode's ANSI renderer applies
 * verbatim — the kernel's chosen background can clash badly with the editor's
 * own theme (unlike foreground colors, which VSCode's renderer already
 * reconciles with the active theme). Only the background component of a
 * combined SGR sequence is dropped; foreground/weight attributes in the same
 * escape are preserved.
 */

// Matches the semicolon-separated SGR form ipykernel/IPython actually emit
// (confirmed against a real captured traceback, see the test fixture). ECMA-48
// also allows a colon-separated sub-parameter form (`\x1b[48:5:196m`) for the
// SAME 256-color/truecolor groups — not matched here, and left untouched if
// ever encountered. A colon-form background SET followed by a semicolon-form
// reset (`;49`) would then have its reset stripped without ever stripping the
// set it was resetting — an inconsistency only reachable by MIXING both forms
// in one stream, which this project's own kernel source never does.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is what an SGR sequence starts with, so this pattern cannot be written without it.
const SGR = /\x1b\[([0-9;]*)m/g;

function isBackgroundParam(params: string[], i: number): number {
  const n = Number(params[i]);
  // 48 must be checked BEFORE the 40-49 range below (48 falls inside it, but
  // needs its own multi-param group consumed, not a 1-param drop).
  if (n === 48) {
    // 48;5;N (256-color) or 48;2;R;G;B (truecolor) — consume the whole group.
    if (params[i + 1] === "5") return 3;
    if (params[i + 1] === "2") return 5;
    return 1; // malformed — just drop the bare 48
  }
  if (n >= 40 && n <= 49) return 1; // standard/8-color background (incl. 49 = default bg)
  if (n >= 100 && n <= 107) return 1; // bright background
  return 0;
}

/** Strip background-color SGR parameters from one string, leaving foreground/
 *  weight/etc. untouched. A sequence left with no parameters is dropped
 *  entirely (not emitted as a bare, no-op `\x1b[m`... except a genuine reset,
 *  which has no digits and is passed through unchanged). */
export function stripAnsiBackground(text: string): string {
  return text.replace(SGR, (whole, paramsStr: string) => {
    if (!paramsStr) return whole; // bare reset `\x1b[m` — leave as-is
    const params = paramsStr.split(";");
    const kept: string[] = [];
    for (let i = 0; i < params.length; ) {
      const consumed = isBackgroundParam(params, i);
      if (consumed > 0) {
        i += consumed;
        continue;
      }
      kept.push(params[i]);
      i += 1;
    }
    return kept.length ? `\x1b[${kept.join(";")}m` : "";
  });
}

/** Format a full traceback (one string per frame, as ipykernel sends it) for
 *  display: background-ANSI stripped, foreground/weight preserved. */
export function formatTraceback(lines: string[]): string[] {
  return lines.map(stripAnsiBackground);
}
