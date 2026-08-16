import { describe, expect, it } from "vitest";
import { formatTraceback, stripAnsiBackground } from "../src/tracebackFormatter";

const ESC = "\x1b";

describe("stripAnsiBackground (RISKS #8/T6)", () => {
  it("drops a standalone standard background code", () => {
    expect(stripAnsiBackground(`${ESC}[41mred bg${ESC}[49m`)).toBe("red bg");
  });

  it("drops a bright background code (100-107)", () => {
    expect(stripAnsiBackground(`${ESC}[103mbright yellow bg${ESC}[49m`)).toBe("bright yellow bg");
  });

  it("keeps the foreground/weight components of a combined sequence, drops only the background", () => {
    // bold(1) + red bg(41) + white fg(37) in ONE escape — a real IPython "Linux"
    // scheme shape. Only 41 must go; 1 and 37 must survive.
    expect(stripAnsiBackground(`${ESC}[1;41;37mtext${ESC}[0m`)).toBe(`${ESC}[1;37mtext${ESC}[0m`);
  });

  it("consumes a 256-color background group (48;5;N) as one unit", () => {
    expect(stripAnsiBackground(`${ESC}[38;5;28;48;5;196mtext${ESC}[0m`)).toBe(
      `${ESC}[38;5;28mtext${ESC}[0m`,
    );
  });

  it("consumes a truecolor background group (48;2;R;G;B) as one unit", () => {
    expect(stripAnsiBackground(`${ESC}[1;48;2;255;0;0;37mtext${ESC}[0m`)).toBe(
      `${ESC}[1;37mtext${ESC}[0m`,
    );
  });

  it("leaves a bare reset (\\x1b[m) untouched", () => {
    expect(stripAnsiBackground(`before${ESC}[mafter`)).toBe(`before${ESC}[mafter`);
  });

  it("leaves foreground-only text completely unchanged", () => {
    const s = `${ESC}[31mred${ESC}[39m plain ${ESC}[36mcyan${ESC}[39m`;
    expect(stripAnsiBackground(s)).toBe(s);
  });

  it("documents the colon-form SGR limitation (RISKS #8/T6 Codex ② review, finding 3)", () => {
    // ECMA-48's colon-separated sub-parameter form is not recognized (only the
    // semicolon form ipykernel/IPython actually emit is) — a colon-form
    // background SET passes through untouched, on its own.
    const colonForm = `${ESC}[48:5:196mtext${ESC}[0m`;
    expect(stripAnsiBackground(colonForm)).toBe(colonForm);
    // Known, accepted inconsistency: if a colon-form SET were ever followed by
    // a semicolon-form reset (mixing both forms, which this project's own
    // kernel source never does), the reset WOULD be stripped without the set
    // that started it — this pins the limitation rather than leaving it silent.
    const mixed = `${ESC}[48:5:196mA${ESC}[49mB`;
    expect(stripAnsiBackground(mixed)).toBe(`${ESC}[48:5:196mAB`);
  });

  it("matches a real captured IPython 8 traceback line byte-for-byte when it has no background codes", () => {
    // Captured 2026-07-28 from a real ipykernel `error` message (division by
    // zero) — this project's default color scheme uses foreground only, so the
    // formatter must be a no-op here (proves it doesn't corrupt real output).
    const line =
      `${ESC}[36mCell${ESC}[36m ${ESC}[39m${ESC}[32mIn[1]${ESC}[39m${ESC}[32m, line 5${ESC}[39m\n` +
      `${ESC}[32m----> ${ESC}[39m${ESC}[32m5${ESC}[39m bar()`;
    expect(stripAnsiBackground(line)).toBe(line);
  });
});

describe("formatTraceback", () => {
  it("maps stripAnsiBackground over every frame", () => {
    const frames = [`${ESC}[41mframe1${ESC}[49m`, "plain frame", `${ESC}[31mred${ESC}[39m`];
    expect(formatTraceback(frames)).toEqual(["frame1", "plain frame", `${ESC}[31mred${ESC}[39m`]);
  });

  it("handles an empty traceback", () => {
    expect(formatTraceback([])).toEqual([]);
  });
});
