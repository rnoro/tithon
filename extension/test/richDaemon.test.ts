/**
 * v27 — rich outputs (matplotlib + tqdm) over a *real* daemon (no mocks).
 *
 * Submits real cells to a real kernel and proves, after a *fresh reconnect*:
 *   - matplotlib inline: the image is journaled as a $tithon_artifact ref (NOT
 *     base64 in the journal), and get_artifact returns the real PNG bytes;
 *   - terminal tqdm: the `\r` stream folds to a single final bar line (100%);
 *   - tqdm.notebook: the widget mirror restores, and the §3.3 text fallback
 *     reconstructs the final bar from it.
 *
 * Skips unless a daemon socket is present (so plain `npm test` stays hermetic);
 * verify/v27.sh starts the daemon and sets TITHON_HOME before running this file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "fs";
import { SessionClient, defaultSocketPath } from "../src/sessionClient";
import { computeCellHash } from "../src/cellAttach";
import { imageOf, widgetModelIdOf, widgetFallbackText } from "../src/richOutput";
import type { OutputItem } from "../src/outputFold";

const SOCK = defaultSocketPath();
const live = existsSync(SOCK);

const MPL = "%matplotlib inline\nimport matplotlib.pyplot as plt\nplt.plot([0,1,2],[0,1,4])\nplt.show()";
const TQDM = "from tqdm import tqdm\nimport sys\nfor i in tqdm(range(20), file=sys.stderr):\n    pass";
const TQDM_NB = "from tqdm.notebook import tqdm as tnb\nfor i in tnb(range(5)):\n    pass";

function terminal(status: string): boolean {
  return status === "done" || status === "error" || status === "orphaned";
}
async function waitFor(pred: () => boolean, ms = 30000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]; // \x89 P N G

describe.skipIf(!live)("rich outputs over a real daemon (v27)", () => {
  let driver: SessionClient;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    driver = new SessionClient(SOCK, "file:///w/rich.py");
    await driver.attach(0);
    for (const [key, code] of [["mpl", MPL], ["tqdm", TQDM], ["nb", TQDM_NB]] as const) {
      ids[key] = await driver.execute(code, {
        uri: "file:///w/rich.py",
        range: { start: 0, end: 0 },
        cell_hash: computeCellHash(code),
      });
    }
    await waitFor(() => {
      const byId = new Map(driver.executions().map((e) => [e.execId, e]));
      return Object.values(ids).every((id) => byId.has(id) && terminal(byId.get(id)!.status));
    });
  }, 90000);

  afterAll(() => driver?.close());

  it("matplotlib inline: journaled as an artifact ref, bytes are real PNG", async () => {
    const reconnect = new SessionClient(SOCK, "file:///w/rich.py");
    await reconnect.attach(0);
    try {
      const outs = reconnect.outputsOf(ids.mpl);
      const fig = outs.find((o) => imageOf(o) !== undefined);
      expect(fig, "an image output is present").toBeTruthy();
      const img = imageOf(fig!)!;
      expect(img.mime).toBe("image/png");
      // The journal must carry a REFERENCE, not inline base64 (design.md §3.1).
      expect(img.ref, "image is a $tithon_artifact ref, not inline base64").toBeTruthy();

      const art = await reconnect.getArtifact(img.ref!.artifact_id);
      expect(art, "get_artifact returns bytes").toBeTruthy();
      expect(art!.mime).toBe("image/png");
      expect([...art!.bytes.slice(0, 4)]).toEqual(PNG_MAGIC);
      expect(art!.bytes.length).toBeGreaterThan(1000);
    } finally {
      reconnect.close();
    }
  });

  it("terminal tqdm: \\r stream folds to one final bar line at 100%", () => {
    const outs = driver.outputsOf(ids.tqdm);
    const stderr = outs.find(
      (o): o is Extract<OutputItem, { output_type: "stream" }> =>
        o.output_type === "stream" && o.name === "stderr",
    );
    expect(stderr, "a stderr stream is present").toBeTruthy();
    const text = stderr!.text;
    expect(text).toContain("100%");
    expect(text).toContain("20/20");
    // \r-folded: the final bar is a single line, not 20 stacked progress lines.
    expect(text.split("\n").filter((l) => l.includes("%")).length).toBe(1);
  });

  it("tqdm.notebook: the live widget mirror is built from comm events (Phase 3)", () => {
    // `driver` attached BEFORE the run, so its widgets() came purely from live
    // `widget` events (daemon payload carries the comm state -> client mirror),
    // NOT a reconnect snapshot — this is what makes a live bar animate.
    const widgets = driver.widgets();
    expect(widgets?.state, "live mirror populated from events").toBeTruthy();
    const models = Object.values(widgets!.state!);
    const prog = models.find((m) => String(m.state?._model_name ?? "").includes("Progress"));
    expect(prog, "FloatProgress present in the live mirror").toBeTruthy();
    // Final live state: value reached max (the run completed before we read it).
    expect((prog!.state as any).value).toBe((prog!.state as any).max);
  });

  it("tqdm.notebook: widget mirror restores; §3.3 text fallback reconstructs the bar", async () => {
    const reconnect = new SessionClient(SOCK, "file:///w/rich.py");
    await reconnect.attach(0);
    try {
      const outs = reconnect.outputsOf(ids.nb);
      const widgetOut = outs.find((o) => widgetModelIdOf(o) !== undefined);
      expect(widgetOut, "a widget-view output is present").toBeTruthy();
      const modelId = widgetModelIdOf(widgetOut!)!;

      const widgets = reconnect.widgets();
      expect(widgets?.state, "snapshot carries the widget mirror").toBeTruthy();

      const text = widgetFallbackText(modelId, widgets)!;
      expect(text, "fallback text reconstructed from mirror").toBeTruthy();
      expect(text).toContain("100%"); // final state, not the 0% start
      expect(text).toContain("5/5");
    } finally {
      reconnect.close();
    }
  });
});
