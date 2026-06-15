import { describe, it, expect } from "vitest";
import {
  imageOf,
  imageRefsOf,
  widgetModelIdOf,
  widgetFallbackText,
  WIDGET_VIEW_MIME,
  type WidgetState,
} from "../src/richOutput";
import type { OutputItem } from "../src/outputFold";

const ref = (id: string) => ({
  $tithon_artifact: { artifact_id: id, mime: "image/png", rel_path: `p/${id}.png`, sha256: id },
});

describe("image detection (matplotlib)", () => {
  it("finds an artifact-ref image and prefers it over its text repr", () => {
    const item: OutputItem = {
      output_type: "display_data",
      data: { "image/png": ref("sha1"), "text/plain": "<Figure size 640x480 with 1 Axes>" },
    };
    expect(imageOf(item)).toEqual({ mime: "image/png", ref: expect.objectContaining({ artifact_id: "sha1" }) });
    expect(imageRefsOf(item).map((r) => r.artifact_id)).toEqual(["sha1"]);
    expect(widgetModelIdOf(item)).toBeUndefined();
  });

  it("handles an inline base64 image (no artifact extraction)", () => {
    const item: OutputItem = { output_type: "execute_result", data: { "image/png": "QUFBQQ==" } };
    expect(imageOf(item)).toEqual({ mime: "image/png", base64: "QUFBQQ==" });
    expect(imageRefsOf(item)).toEqual([]); // a raw string is not a fetchable ref
  });

  it("ignores non-image outputs", () => {
    expect(imageOf({ output_type: "stream", name: "stdout", text: "hi" })).toBeUndefined();
    expect(imageRefsOf({ output_type: "error", ename: "E", evalue: "v", traceback: [] })).toEqual([]);
  });
});

// The probed tqdm.notebook shape: an HBox container of [HTML, FloatProgress, HTML].
const tqdmWidgets: WidgetState = {
  state: {
    hbox: { state: { _model_name: "HBoxModel", children: ["IPY_MODEL_html1", "IPY_MODEL_prog", "IPY_MODEL_html2"] } },
    html1: { state: { _model_name: "HTMLModel", value: "100%" } },
    prog: { state: { _model_name: "FloatProgressModel", value: 5.0, max: 5.0, min: 0.0 } },
    html2: { state: { _model_name: "HTMLModel", value: "5/5 [00:00&lt;00:00, 371.80it/s]" } },
  },
};

describe("widget text fallback (design §3.3)", () => {
  it("identifies the widget-view model id", () => {
    const item: OutputItem = {
      output_type: "display_data",
      data: { "text/plain": "  0%|...", [WIDGET_VIEW_MIME]: { model_id: "hbox", version_major: 2, version_minor: 0 } },
    };
    expect(widgetModelIdOf(item)).toBe("hbox");
    expect(imageOf(item)).toBeUndefined();
  });

  it("reconstructs the final tqdm bar from the mirror (not the start state)", () => {
    const text = widgetFallbackText("hbox", tqdmWidgets)!;
    expect(text).toContain("100%");
    expect(text).toContain("█".repeat(20)); // full bar at value==max
    expect(text).toContain("5/5 [00:00<00:00, 371.80it/s]"); // labels, HTML-unescaped
    expect(text).not.toContain("&lt;");
  });

  it("renders a bare progress widget without labels as a bar + value/max", () => {
    const w: WidgetState = { state: { p: { state: { _model_name: "IntProgressModel", value: 3, max: 10 } } } };
    const text = widgetFallbackText("p", w)!;
    expect(text).toContain("30%");
    expect(text).toContain("3/10");
    expect(text).toContain("█".repeat(6)); // round(30% of 20)
  });

  it("returns undefined for an unknown model (fresh live run -> fall back to text/plain)", () => {
    expect(widgetFallbackText("missing", tqdmWidgets)).toBeUndefined();
    expect(widgetFallbackText("hbox", null)).toBeUndefined();
  });
});
