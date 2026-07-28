// @vitest-environment jsdom
/**
 * RISKS #13: a widget with partly-binary state (e.g. ImageModel's `value`)
 * must apply LIVE buffer updates, not just its initial snapshot. Verifies the
 * core mechanism (`HTMLManager.set_state()` on an already-existing model,
 * given a one-model state dict with `buffers`) and the shared client-side
 * merge helpers (`decodeBufferEntries`/`mergeBufferEntries`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { createManager } from "../src/widgetRender";
import { decodeBufferEntries, mergeBufferEntries, type WidgetBufferEntry } from "../src/richOutput";
import { activate } from "../src/widgetRendererEntry";

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}
function bytesOf(dv: DataView): string {
  return Buffer.from(dv.buffer, dv.byteOffset, dv.byteLength).toString("utf8");
}

function imageSnapshot(initial: string) {
  return {
    version_major: 2,
    version_minor: 0,
    state: {
      img1: {
        model_name: "ImageModel",
        model_module: "@jupyter-widgets/controls",
        model_module_version: "2.0.0",
        state: { format: "png" },
        buffers: [{ encoding: "base64", path: ["value"], data: b64(initial) }],
      },
    },
  };
}

describe("html-manager set_state applies a live buffer update to an existing model (RISKS #13)", () => {
  it("a comm_msg-shaped delta with buffers replaces the model's bytes in place", async () => {
    const manager = createManager();
    await manager.set_state(imageSnapshot("INITIAL-BYTES") as any);
    const model = await manager.get_model("img1");
    expect(bytesOf(model!.get("value"))).toBe("INITIAL-BYTES");

    // The exact shape widgetRendererEntry.ts's live-update handler builds.
    await manager.set_state({
      version_major: 2,
      version_minor: 0,
      state: { img1: { state: {}, buffers: [{ encoding: "base64", path: ["value"], data: b64("UPDATED-BYTES") }] } },
    } as any);

    expect(bytesOf(model!.get("value"))).toBe("UPDATED-BYTES");
  });

  it("a delta touching only JSON state leaves a previously-set buffer untouched", async () => {
    const manager = createManager();
    await manager.set_state(imageSnapshot("KEEP-ME") as any);
    const model = await manager.get_model("img1");

    // No `buffers` key at all — matches an ordinary comm_msg with no
    // buffer_paths (the overwhelmingly common case: a JSON-only widget tick).
    await manager.set_state({
      version_major: 2,
      version_minor: 0,
      state: { img1: { state: { format: "jpeg" } } },
    } as any);

    expect(model!.get("format")).toBe("jpeg");
    expect(bytesOf(model!.get("value"))).toBe("KEEP-ME"); // buffer survives an unrelated JSON update
  });
});

describe("decodeBufferEntries / mergeBufferEntries (client-side mirror helpers)", () => {
  it("decodes matching buffer_paths/_buffers_b64 pairs, tolerating a length mismatch", () => {
    const entries = decodeBufferEntries([["value"], ["other"]], [b64("a"), b64("b"), b64("extra")]);
    expect(entries).toEqual([
      { encoding: "base64", path: ["value"], data: b64("a") },
      { encoding: "base64", path: ["other"], data: b64("b") },
    ]);
    expect(decodeBufferEntries(undefined, [b64("x")])).toEqual([]);
    expect(decodeBufferEntries([["value"]], undefined)).toEqual([]);
  });

  it("merges new entries by path, preserving paths not present in the update", () => {
    const prev: WidgetBufferEntry[] = [
      { encoding: "base64", path: ["value"], data: b64("old-value") },
      { encoding: "base64", path: ["thumbnail"], data: b64("thumb") },
    ];
    const next: WidgetBufferEntry[] = [{ encoding: "base64", path: ["value"], data: b64("new-value") }];
    const merged = mergeBufferEntries(prev, next);
    expect(merged.find((b) => JSON.stringify(b.path) === JSON.stringify(["value"]))?.data).toBe(b64("new-value"));
    expect(merged.find((b) => JSON.stringify(b.path) === JSON.stringify(["thumbnail"]))?.data).toBe(b64("thumb"));
  });

  it("an empty update returns the prior entries unchanged", () => {
    const prev: WidgetBufferEntry[] = [{ encoding: "base64", path: ["value"], data: b64("v") }];
    expect(mergeBufferEntries(prev, [])).toBe(prev);
  });
});

describe("widgetRendererEntry.activate — live update wiring (RISKS #13)", () => {
  it("a tithon.widget-update message (with an empty buffers array) is applied without throwing and acks", async () => {
    // FloatProgress (not Image): renders cleanly in jsdom (no Blob/ObjectURL
    // dependency — ImageView needs those and jsdom doesn't implement them).
    // Buffer APPLICATION correctness is proven at the manager level above;
    // this only exercises the message-handling wiring itself.
    const snap = JSON.parse(
      readFileSync(join(__dirname, "fixtures", "tqdm_widget_state.json"), "utf8"),
    );
    const id = Object.keys(snap.state).find(
      (k) => snap.state[k].model_name === "FloatProgressModel",
    )!;

    let receive: ((msg: unknown) => void) | undefined;
    const posted: any[] = [];
    const ctx = {
      onDidReceiveMessage: (cb: (msg: unknown) => void) => {
        receive = cb;
      },
      postMessage: (msg: unknown) => {
        posted.push(msg);
      },
    };
    const renderer = activate(ctx);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const item = { id: "out1", json: () => ({ model_id: id, state: snap }) };
    await renderer.renderOutputItem(item, host);
    expect(posted.some((m) => m.type === "tithon.widget-rendered" && m.mode === "html")).toBe(true);

    receive?.({ type: "tithon.widget-update", comm_id: id, state: { value: 42 }, buffers: [] });
    await new Promise((r) => setTimeout(r, 30));
    expect(posted.some((m) => m.type === "tithon.widget-updated" && m.comm_id === id)).toBe(true);
  });

  it("two rapid updates for the same model apply in ARRIVAL order, not resolution order (Codex ② finding 1)", async () => {
    // set_state() is async; a fire-and-forget call per message could let an
    // older update's promise resolve AFTER a newer one, restoring stale
    // content. Fire two updates back-to-back with NO await between them
    // (simulating two tithon.widget-update messages arriving close together)
    // and assert the LAST one wins, via the DOM (the only thing observable
    // from outside activate()'s closure — mirrors widget.test.ts's own
    // convention of asserting on .progress-bar style, not internal state).
    const snap = JSON.parse(
      readFileSync(join(__dirname, "fixtures", "tqdm_widget_state.json"), "utf8"),
    );
    const id = Object.keys(snap.state).find(
      (k) => snap.state[k].model_name === "FloatProgressModel",
    )!;
    let receive: ((msg: unknown) => void) | undefined;
    const posted: any[] = [];
    const ctx = {
      onDidReceiveMessage: (cb: (msg: unknown) => void) => {
        receive = cb;
      },
      postMessage: (msg: unknown) => {
        posted.push(msg);
      },
    };
    const renderer = activate(ctx);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const item = { id: "out2", json: () => ({ model_id: id, state: snap }) };
    await renderer.renderOutputItem(item, host);

    receive?.({ type: "tithon.widget-update", comm_id: id, state: { value: 10, max: 100 } });
    receive?.({ type: "tithon.widget-update", comm_id: id, state: { value: 90, max: 100 } });

    const deadline = Date.now() + 2000;
    while (posted.filter((m) => m.type === "tithon.widget-updated").length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const bar = host.querySelector(".progress-bar") as HTMLElement | null;
    expect(bar?.style.width).toBe("90%"); // the later-arriving update, not whichever set_state() resolved first
  });
});
