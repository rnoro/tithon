import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  parse,
  serialize,
  countMarkers,
  bodyLinesFromText,
  resolveCell,
  cellSource,
  uncommentMarkdown,
  commentMarkdown,
} from "../src/serializer";

const CORPUS_DIR = join(__dirname, "..", "..", "scripts", "corpus");

/** latin1 is a 1:1 byte<->char mapping, so string equality == byte equality. */
function readBytesAsString(path: string): string {
  return readFileSync(path).toString("latin1");
}

describe("percent serializer — corpus byte-exact round-trip", () => {
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".py") && !f.startsWith("_"))
    .sort();

  it("has a non-trivial corpus", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of files) {
    it(`round-trips ${file} with a 0-byte diff`, () => {
      const original = readBytesAsString(join(CORPUS_DIR, file));
      const round = serialize(parse(original));
      expect(round.length).toBe(original.length); // byte count
      expect(round).toBe(original); // byte-exact
    });
  }
});

describe("percent serializer — marker semantics", () => {
  it("does not split on a `# %%` inside a triple-quoted string", () => {
    const src = readBytesAsString(join(CORPUS_DIR, "string_marker.py"));
    const nb = parse(src);
    // real markers: "# %% real-a" and "# %% real-b" only.
    const markerLines = nb.cells
      .filter((c) => c.hasMarker)
      .map((c) => c.markerLine!.text);
    expect(markerLines).toEqual(["# %% real-a", "# %% real-b"]);
  });

  it("does not split on a `# %%` inside a CRLF triple-quoted string", () => {
    const src = readBytesAsString(join(CORPUS_DIR, "crlf_string_marker.py"));
    const nb = parse(src);
    const markerLines = nb.cells
      .filter((c) => c.hasMarker)
      .map((c) => c.markerLine!.text);
    expect(markerLines).toEqual(["# %% a", "# %% b"]);
  });

  it("treats leading content before the first marker as a marker-less cell", () => {
    const src = readBytesAsString(join(CORPUS_DIR, "module_header.py"));
    const nb = parse(src);
    expect(nb.cells[0].hasMarker).toBe(false);
    expect(nb.cells.some((c) => c.hasMarker)).toBe(true);
  });

  it("classifies `# %% [markdown]` cells as markdown", () => {
    const src = readBytesAsString(join(CORPUS_DIR, "magics_markdown.py"));
    const nb = parse(src);
    expect(nb.cells.some((c) => c.kind === "markdown")).toBe(true);
  });

  it("recognises empty cells (consecutive markers)", () => {
    const src = readBytesAsString(join(CORPUS_DIR, "empty_cells.py"));
    const nb = parse(src);
    const empties = nb.cells.filter(
      (c) => c.hasMarker && c.body.every((l) => l.text.trim() === ""),
    );
    expect(empties.length).toBeGreaterThanOrEqual(3);
  });
});

// --- property test: 1,000 randomly generated percent files round-trip --------

const termArb = fc.constantFrom("\n", "\r\n", "\r");

// A body line that is "inert": it contains no string/bracket/comment/percent
// characters, so it never changes the scanner's state and never looks like a
// marker. This keeps the generated cell *structure* deterministic. String- and
// bracket-aware splitting is asserted separately by the corpus tests above, and
// adversarial losslessness by the arbitrary-latin1 property below.
const bodyTextArb = fc.stringOf(
  fc.constantFrom(..."abcdefghij0123 \t=+_.: ".split("")),
  { maxLength: 24 },
);

const markerTextArb = fc.constantFrom(
  "# %%",
  "#%%",
  "# %% titled cell",
  "# %% [markdown]",
  "# %% [raw]",
  "#%%notitle",
);

interface GenLine {
  text: string;
  term: string;
}

const genCellArb = fc.record({
  marker: markerTextArb,
  body: fc.array(fc.record({ text: bodyTextArb, term: termArb }), { maxLength: 4 }),
});

const genFileArb = fc
  .record({
    leading: fc.array(fc.record({ text: bodyTextArb, term: termArb }), { maxLength: 3 }),
    cells: fc.array(genCellArb, { minLength: 1, maxLength: 6 }),
    finalNewline: fc.boolean(),
  })
  .map(({ leading, cells, finalNewline }) => {
    const lines: GenLine[] = [];
    for (const l of leading) lines.push(l);
    for (const c of cells) {
      lines.push({ text: c.marker, term: "\n" });
      for (const b of c.body) lines.push(b);
    }
    // Optionally drop the final terminator (file with no trailing newline).
    if (lines.length > 0 && !finalNewline) {
      lines[lines.length - 1] = { ...lines[lines.length - 1], term: "" };
    }
    const text = lines.map((l) => l.text + l.term).join("");
    const markerCount = cells.length;
    const hasLeading = leading.length > 0 ? 1 : 0;
    return { text, expectedCells: markerCount + hasLeading };
  });

describe("percent serializer — property: random percent files", () => {
  it("round-trips 1,000 random percent files byte-exactly", () => {
    fc.assert(
      fc.property(genFileArb, ({ text, expectedCells }) => {
        const nb = parse(text);
        // structural: real partitioning, not a single opaque blob.
        expect(nb.cells.length).toBe(expectedCells);
        expect(countMarkers(text)).toBe(nb.cells.filter((c) => c.hasMarker).length);
        // byte-exact round-trip.
        expect(serialize(nb)).toBe(text);
      }),
      { numRuns: 1000 },
    );
  });

  it("round-trips arbitrary latin1 text byte-exactly (no partition assumptions)", () => {
    const charArb = fc.constantFrom(
      ..."abc 09#%[]{}'\"\\\t".split(""),
      "\n",
      "\r",
    );
    fc.assert(
      fc.property(fc.stringOf(charArb, { maxLength: 200 }), (text) => {
        expect(serialize(parse(text))).toBe(text);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("Cell View added cells — synthesize -> serialize -> parse (ADR-019 / glue bug)", () => {
  // A cell added via the Cell View has no line terminators. Each synthesized
  // cell body must end with "\n" so the next `# %%` marker stays on its own line.
  function synthCell(value: string) {
    return {
      kind: "code" as const,
      hasMarker: true,
      markerLine: { text: "# %%", terminator: "\n" },
      body: bodyLinesFromText(value),
    };
  }

  it("does not glue the next marker onto the previous code line", () => {
    const cells = [
      synthCell('for i in range(5):\n    print(f"Iteration {i}")'),
      synthCell('print("Hello")'),
      synthCell('print("Loop completed.")'),
    ];
    const out = serialize({ cells });
    // No `# %%` should ever follow non-newline characters on the same line.
    expect(out).not.toMatch(/[^\n]# %%/);
    // And it round-trips to THREE cells, not one.
    const reparsed = parse(out).cells;
    expect(reparsed.length).toBe(3);
    expect(reparsed[0].body.map((l) => l.text).join("\n")).toContain("range(5)");
    expect(reparsed[1].body.map((l) => l.text).join("\n")).toContain('print("Hello")');
    expect(reparsed[2].body.map((l) => l.text).join("\n")).toContain("Loop completed");
  });

  it("normalizes a trailing newline to exactly one (no double blank)", () => {
    const out = serialize({ cells: [synthCell('print("x")\n'), synthCell('print("y")')] });
    expect(out).toBe('# %%\nprint("x")\n# %%\nprint("y")\n');
    expect(parse(out).cells.length).toBe(2);
  });
});

// --- resolveCell: edited existing cells must persist (ADR-020 data-loss fix) --
describe("resolveCell — edited existing cells persist to disk", () => {
  const SRC = '# %%\nprint("old")\n# %%\nx = 1\n';

  it("returns the stored structure VERBATIM for an unedited cell", () => {
    const nb = parse(SRC);
    const cell0 = nb.cells[0];
    // value == the deserialized display source -> unedited -> identity (byte-exact).
    const resolved = resolveCell(cellSource(cell0), false, cell0);
    expect(resolved).toBe(cell0); // same object reference: nothing rebuilt
  });

  it("a full unedited notebook round-trips byte-exactly through resolveCell", () => {
    const nb = parse(SRC);
    const cells = nb.cells.map((c) => resolveCell(cellSource(c), false, c));
    expect(serialize({ cells })).toBe(SRC);
  });

  it("REBUILDS the body from new text when a code cell is edited (no stale revert)", () => {
    const nb = parse(SRC);
    const cell0 = nb.cells[0];
    // The user changed the cell text in the Cell View.
    const resolved = resolveCell('print("NEW")', false, cell0);
    expect(resolved).not.toBe(cell0);
    expect(cellSource(resolved)).toBe('print("NEW")\n');
    // Marker line + kind are preserved from the stored structure.
    expect(resolved.hasMarker).toBe(true);
    expect(resolved.markerLine!.text).toBe(cell0.markerLine!.text);
    // And the whole file reflects the edit, not the old "old" content.
    const cells = [resolved, resolveCell(cellSource(nb.cells[1]), false, nb.cells[1])];
    const out = serialize({ cells });
    expect(out).toBe('# %%\nprint("NEW")\n# %%\nx = 1\n');
    expect(out).not.toContain("old");
  });

  it("preserves a marker-less leading cell when edited (no spurious marker)", () => {
    const nb = parse('import os\n# %%\nx = 1\n');
    const head = nb.cells[0];
    expect(head.hasMarker).toBe(false);
    const resolved = resolveCell("import sys", false, head);
    expect(resolved.hasMarker).toBe(false);
    expect(resolved.markerLine).toBeUndefined();
    expect(cellSource(resolved)).toBe("import sys\n");
  });

  it("re-comments an edited markdown cell (jupytext `# ` prefix)", () => {
    const nb = parse("# %% [markdown]\n# Title\n# body\n");
    const md = nb.cells[0];
    expect(md.kind).toBe("markdown");
    // display source is the uncommented text
    expect(uncommentMarkdown(cellSource(md))).toBe("Title\nbody\n");
    const resolved = resolveCell("New Title\n\nsecond line", true, md);
    // body is re-commented; empty line becomes a bare "#"
    expect(cellSource(resolved)).toBe("# New Title\n#\n# second line\n");
    expect(resolved.kind).toBe("markdown");
  });

  it("commentMarkdown / uncommentMarkdown round-trip", () => {
    for (const v of ["a\nb", "Title\n\nbody", "  indented", ""]) {
      expect(uncommentMarkdown(commentMarkdown(v))).toBe(v);
    }
  });

  it("synthesizes a fresh cell when there is no stored structure", () => {
    const resolved = resolveCell('print("added")', false, undefined);
    expect(resolved.hasMarker).toBe(true);
    expect(resolved.markerLine!.text).toBe("# %%");
    expect(cellSource(resolved)).toBe('print("added")\n');
  });
});

// --- marker-less leading cell must not merge when it stops being first --------
describe("resolveCell — a marker-less cell that is no longer first gets a marker", () => {
  const HEADER = "import os\n# %%\nprint(os.getcwd())\n";

  it("keeps the marker-less header cell marker-less when it IS first", () => {
    const head = parse(HEADER).cells[0];
    expect(head.hasMarker).toBe(false);
    const resolved = resolveCell(cellSource(head), false, head, /*isFirst*/ true);
    expect(resolved.hasMarker).toBe(false); // still a module header
  });

  it("promotes the header cell to a `# %%` marker when it is NOT first", () => {
    const head = parse(HEADER).cells[0];
    const resolved = resolveCell(cellSource(head), false, head, /*isFirst*/ false);
    expect(resolved.hasMarker).toBe(true);
    expect(resolved.markerLine!.text).toBe("# %%");
    // body preserved verbatim
    expect(cellSource(resolved)).toBe("import os\n");
  });

  it("inserting a cell ABOVE a header cell still reparses to all cells (no merge)", () => {
    const nb = parse(HEADER);
    // Simulate: user inserts a new cell at index 0; the former header cell shifts
    // to index 1 (no longer first); cell 2 is the original print cell.
    const inserted = resolveCell('print("NEW")', false, undefined, true);
    const header = resolveCell(cellSource(nb.cells[0]), false, nb.cells[0], false);
    const tail = resolveCell(cellSource(nb.cells[1]), false, nb.cells[1], false);
    const out = serialize({ cells: [inserted, header, tail] });
    const reparsed = parse(out).cells;
    expect(reparsed.length).toBe(3); // pre-fix this collapses to 2 (header merges up)
    expect(out).toContain('print("NEW")');
    expect(out).toContain("import os");
    expect(out).toContain("print(os.getcwd())");
  });
});
