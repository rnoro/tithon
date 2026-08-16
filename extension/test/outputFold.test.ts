import { describe, it, expect } from "vitest";
import { ExecutionFold, foldMessages, type OutputItem } from "../src/outputFold";

function stream(name: string, text: string) {
  return ["stream", { name, text }] as [string, any];
}

describe("client output fold (mirrors daemon folding.py)", () => {
  it("concatenates consecutive same-name stream chunks", () => {
    const out = foldMessages([
      stream("stdout", "a"),
      stream("stdout", "b\n"),
      stream("stdout", "c"),
    ]);
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
    expect(out[1]).toMatchObject({
      output_type: "error",
      ename: "ValueError",
      traceback: ["a", "b"],
    });
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
    expect(f.outputs()).toEqual([
      { output_type: "stream", name: "stdout", text: "progress 100%\n" },
    ]);
  });
});

describe("ExecutionFold — Output-widget areas (RISKS #17)", () => {
  const claim = (id: string, msgId = "req-1"): [string, any] => [
    "comm_msg",
    { comm_id: id, data: { method: "update", state: { msg_id: msgId } } },
  ];
  const release = (id: string): [string, any] => claim(id, "");
  const png = (aid: string): [string, any] => [
    "display_data",
    { data: { "image/png": { $tithon_artifact: { artifact_id: aid } } }, metadata: {} },
  ];
  const stream = (text: string): [string, any] => ["stream", { name: "stdout", text }];

  it("a widget's clear spares its sibling outputs", () => {
    const msgs: Array<[string, any]> = [
      [
        "display_data",
        { data: { "application/vnd.jupyter.widget-view+json": { model_id: "bar" } }, metadata: {} },
      ],
    ];
    for (let i = 0; i < 4; i++) {
      msgs.push(claim("out"), ["clear_output", { wait: true }], png(`f${i}`), release("out"));
    }
    const out = foldMessages(msgs);
    expect(out).toHaveLength(2);
    expect((out[0] as any).data).toHaveProperty("application/vnd.jupyter.widget-view+json");
    expect((out[1] as any).data["image/png"].$tithon_artifact.artifact_id).toBe("f3");
  });

  it("a cell-level clear still clears everything", () => {
    expect(
      foldMessages([
        stream("t"),
        claim("out"),
        png("a"),
        release("out"),
        ["clear_output", { wait: false }],
      ]),
    ).toEqual([]);
  });

  it("a synthetic cell-scope clear overrides an active claim", () => {
    expect(
      foldMessages([
        stream("t"),
        claim("out"),
        png("a"),
        ["clear_output", { wait: false, tithon_scope: "cell" }],
      ]),
    ).toEqual([]);
  });

  it("interleaved widget frames do not restart the cell stream", () => {
    const msgs: Array<[string, any]> = [];
    for (let i = 0; i < 5; i++) {
      msgs.push(
        claim("out"),
        ["clear_output", { wait: true }],
        png(`f${i}`),
        release("out"),
        stream(`\rStep ${i}`),
      );
    }
    const out = foldMessages(msgs);
    expect(out.map((o) => o.output_type)).toEqual(["stream", "display_data"]);
    expect((out[0] as any).text).toBe("Step 4");
  });

  it("streams do not merge across areas", () => {
    const out = foldMessages([stream("cell "), claim("out"), stream("widget"), release("out")]);
    expect(out.map((o) => (o as any).text)).toEqual(["cell ", "widget"]);
  });

  it("nested claims restore the outer area", () => {
    const out = foldMessages([
      claim("a"),
      claim("b"),
      release("b"),
      png("x"),
      ["clear_output", { wait: false }],
      stream("still here"),
    ]);
    expect(out.map((o) => o.output_type)).toEqual(["stream"]);
  });

  it("comm_close releases a claim left open", () => {
    expect(
      foldMessages([
        stream("t"),
        claim("out"),
        ["comm_close", { comm_id: "out" }],
        ["clear_output", { wait: false }],
      ]),
    ).toEqual([]);
  });

  it("state() round-trips through seed() so a reconnect keeps scoping", () => {
    // Reconnect mid-claim: without the sidecar the resumed fold would treat the
    // plot as the cell's own and never supersede it.
    const a = new ExecutionFold();
    for (const m of [claim("out"), ["clear_output", { wait: true }] as [string, any], png("f0")])
      a.apply(m[0], m[1]);

    const b = new ExecutionFold();
    b.seed(a.outputs(), a.state());
    for (const m of [["clear_output", { wait: true }] as [string, any], png("f1"), release("out")])
      b.apply(m[0], m[1]);

    const direct = new ExecutionFold();
    for (const m of [
      claim("out"),
      ["clear_output", { wait: true }] as [string, any],
      png("f0"),
      ["clear_output", { wait: true }] as [string, any],
      png("f1"),
      release("out"),
    ])
      direct.apply(m[0], m[1]);

    expect(b.outputs()).toEqual(direct.outputs());
    expect(b.outputs()).toHaveLength(1);
  });

  it("seeding WITHOUT the sidecar accumulates — the reason it must be sent", () => {
    const a = new ExecutionFold();
    for (const m of [claim("out"), png("f0")]) a.apply(m[0], m[1]);
    const naive = new ExecutionFold();
    naive.seed(a.outputs()); // no state: the claim and the owner are lost
    naive.apply("clear_output", { wait: false });
    naive.apply(...png("f1"));
    expect(naive.outputs()).toHaveLength(1); // the blind clear wiped, then re-appended
  });

  it("owner never reaches the wire", () => {
    for (const o of foldMessages([claim("out"), png("a"), stream("t")])) {
      expect(Object.keys(o)).not.toContain("owner");
    }
  });
});
