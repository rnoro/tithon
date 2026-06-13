import { describe, it, expect } from "vitest";
import { ExecutionFold, foldMessages, type OutputItem } from "../src/outputFold";

function stream(name: string, text: string) {
  return ["stream", { name, text }] as [string, any];
}

describe("client output fold (mirrors daemon folding.py)", () => {
  it("concatenates consecutive same-name stream chunks", () => {
    const out = foldMessages([stream("stdout", "a"), stream("stdout", "b\n"), stream("stdout", "c")]);
    expect(out).toEqual([{ output_type: "stream", name: "stdout", text: "ab\nc" }]);
  });

  it("collapses \\r progress to the final line (tqdm-style)", () => {
    const out = foldMessages([
      stream("stdout", "10%\r"),
      stream("stdout", "50%\r"),
      stream("stdout", "100%"),
    ]);
    expect(out).toEqual([{ output_type: "stream", name: "stdout", text: "100%" }]);
  });

  it("honors \\b backspace within the current line", () => {
    const out = foldMessages([stream("stdout", "abc\b\bX")]);
    expect(out).toEqual([{ output_type: "stream", name: "stdout", text: "aXc" }]);
  });

  it("keeps stdout and stderr as separate items", () => {
    const out = foldMessages([stream("stdout", "out"), stream("stderr", "err")]);
    expect(out).toEqual([
      { output_type: "stream", name: "stdout", text: "out" },
      { output_type: "stream", name: "stderr", text: "err" },
    ]);
  });

  it("clears outputs on clear_output, and defers with wait=true", () => {
    const f = new ExecutionFold();
    f.apply("stream", { name: "stdout", text: "old\n" });
    f.apply("clear_output", { wait: true });
    // deferred: still shows old until the next real output arrives
    expect(f.outputs()).toEqual([{ output_type: "stream", name: "stdout", text: "old\n" }]);
    f.apply("stream", { name: "stdout", text: "new" });
    expect(f.outputs()).toEqual([{ output_type: "stream", name: "stdout", text: "new" }]);

    f.apply("clear_output", {}); // immediate
    expect(f.outputs()).toEqual([]);
  });

  it("appends execute_result and error items", () => {
    const out = foldMessages([
      ["execute_result", { data: { "text/plain": "42" }, execution_count: 7 }],
      ["error", { ename: "ValueError", evalue: "boom", traceback: ["a", "b"] }],
    ]);
    expect(out[0]).toMatchObject({ output_type: "execute_result", execution_count: 7 });
    expect(out[1]).toMatchObject({ output_type: "error", ename: "ValueError", traceback: ["a", "b"] });
  });

  it("update_display_data updates the latest item with that display_id", () => {
    const out = foldMessages([
      ["display_data", { data: { "text/plain": "v1" }, transient: { display_id: "d1" } }],
      ["update_display_data", { data: { "text/plain": "v2" }, transient: { display_id: "d1" } }],
    ]);
    expect(out).toEqual([
      { output_type: "display_data", data: { "text/plain": "v2" }, metadata: {}, display_id: "d1" },
    ]);
  });

  it("seed() resumes folding from already-folded snapshot outputs", () => {
    const seed: OutputItem[] = [{ output_type: "stream", name: "stdout", text: "progress 50%" }];
    const f = new ExecutionFold();
    f.seed(seed);
    // a live \r + new text overwrites the seeded line, proving the buffer resumed
    f.apply("stream", { name: "stdout", text: "\rprogress 100%\n" });
    expect(f.outputs()).toEqual([{ output_type: "stream", name: "stdout", text: "progress 100%\n" }]);
  });
});
