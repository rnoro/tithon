import { describe, expect, it } from "vitest";
import type { OutputItem } from "../src/outputFold";
import {
  imageOf,
  imageRefsOf,
  isDisplayOnlyWidget,
  isOutputAreaView,
  WIDGET_VIEW_MIME,
  type WidgetState,
  widgetFallbackText,
  widgetModelIdOf,
  widgetPayload,
} from "../src/richOutput";

const ref = (id: string) => ({
  $tithon_artifact: { artifact_id: id, mime: "image/png", rel_path: `p/${id}.png`, sha256: id },
});

describe("image detection (matplotlib)", () => {
  it("finds an artifact-ref image and prefers it over its text repr", () => {
    const item: OutputItem = {
      output_type: "display_data",
      data: { "image/png": ref("sha1"), "text/plain": "<Figure size 640x480 with 1 Axes>" },
    };
    expect(imageOf(item)).toEqual({
      mime: "image/png",
      ref: expect.objectContaining({ artifact_id: "sha1" }),
    });
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
    expect(imageRefsOf({ output_type: "error", ename: "E", evalue: "v", traceback: [] })).toEqual(
      [],
    );
  });
});

// The probed tqdm.notebook shape: an HBox container of [HTML, FloatProgress, HTML].
const tqdmWidgets: WidgetState = {
  state: {
    hbox: {
      state: {
        _model_name: "HBoxModel",
        children: ["IPY_MODEL_html1", "IPY_MODEL_prog", "IPY_MODEL_html2"],
      },
    },
    html1: { state: { _model_name: "HTMLModel", value: "100%" } },
    prog: { state: { _model_name: "FloatProgressModel", value: 5.0, max: 5.0, min: 0.0 } },
    html2: { state: { _model_name: "HTMLModel", value: "5/5 [00:00&lt;00:00, 371.80it/s]" } },
  },
};

describe("widget text fallback (design §3.3)", () => {
  it("identifies the widget-view model id", () => {
    const item: OutputItem = {
      output_type: "display_data",
      data: {
        "text/plain": "  0%|...",
        [WIDGET_VIEW_MIME]: { model_id: "hbox", version_major: 2, version_minor: 0 },
      },
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
    const w: WidgetState = {
      state: { p: { state: { _model_name: "IntProgressModel", value: 3, max: 10 } } },
    };
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

describe("interactive-widget allow-list (RISKS #4/T8: no client -> kernel comm yet)", () => {
  it("a display-only container (tqdm.notebook's HBox of HTML+Progress) is safe to render", () => {
    expect(isDisplayOnlyWidget("hbox", tqdmWidgets)).toBe(true);
  });

  it("a bare progress widget is safe to render", () => {
    const w: WidgetState = {
      state: { p: { state: { _model_name: "IntProgressModel", value: 3, max: 10 } } },
    };
    expect(isDisplayOnlyWidget("p", w)).toBe(true);
  });

  it("an interactive control (IntSlider) is NOT safe to render", () => {
    const w: WidgetState = { state: { s: { state: { _model_name: "IntSliderModel", value: 3 } } } };
    expect(isDisplayOnlyWidget("s", w)).toBe(false);
  });

  it("a container holding even one interactive child is NOT safe (the child would still swallow input)", () => {
    const w: WidgetState = {
      state: {
        box: { state: { _model_name: "VBoxModel", children: ["IPY_MODEL_html", "IPY_MODEL_btn"] } },
        html: { state: { _model_name: "HTMLModel", value: "label" } },
        btn: { state: { _model_name: "ButtonModel", description: "Click me" } },
      },
    };
    expect(isDisplayOnlyWidget("box", w)).toBe(false);
  });

  it("an unrecognized/unknown model fails closed (not on the allow-list, or missing from the mirror)", () => {
    expect(
      isDisplayOnlyWidget("s", {
        state: { s: { state: { _model_name: "SomeFutureWidgetModel" } } },
      }),
    ).toBe(false);
    expect(isDisplayOnlyWidget("missing", tqdmWidgets)).toBe(false);
    expect(isDisplayOnlyWidget("hbox", null)).toBe(false);
  });

  it("a self-referential children cycle does not infinite-loop", () => {
    const w: WidgetState = {
      state: { a: { state: { _model_name: "BoxModel", children: ["IPY_MODEL_a"] } } },
    };
    expect(isDisplayOnlyWidget("a", w)).toBe(true);
  });

  it("an OutputModel is NOT allow-listed — its outputs can nest another widget-view outside children", () => {
    const w: WidgetState = { state: { o: { state: { _model_name: "OutputModel", outputs: [] } } } };
    expect(isDisplayOnlyWidget("o", w)).toBe(false);
  });

  it("a malformed (non-array) children value fails closed instead of being treated as childless", () => {
    const w: WidgetState = {
      state: { box: { state: { _model_name: "BoxModel", children: "IPY_MODEL_html" } } },
    };
    expect(isDisplayOnlyWidget("box", w)).toBe(false);
  });
});

describe("isOutputAreaView — an Output widget's own view is redundant", () => {
  const view = (modelId: string): OutputItem => ({
    output_type: "display_data",
    data: {
      "application/vnd.jupyter.widget-view+json": { model_id: modelId },
      "text/plain": "Output()",
    },
    metadata: {},
  });
  const widgets = {
    state: {
      out: { state: { _model_name: "OutputModel" } },
      bar: { state: { _model_name: "FloatProgressModel", value: 1, max: 2 } },
    },
  };

  it("is true for an OutputModel — its captured content renders at cell level", () => {
    expect(isOutputAreaView(view("out"), widgets)).toBe(true);
  });

  it("is false for any other widget, so a tqdm bar still renders", () => {
    expect(isOutputAreaView(view("bar"), widgets)).toBe(false);
  });

  it("is false for a non-widget output and when the mirror is unknown", () => {
    expect(isOutputAreaView({ output_type: "stream", name: "stdout", text: "x" }, widgets)).toBe(
      false,
    );
    expect(isOutputAreaView(view("out"), null)).toBe(false);
  });
});

describe("widgetPayload — only the models this view reaches", () => {
  // Two independent tqdm bars in one session, plus the layout/style models
  // ipywidgets references from OUTSIDE `children`.
  const mirror: WidgetState = {
    version_major: 2,
    version_minor: 0,
    state: {
      barA: {
        state: {
          _model_name: "HBoxModel",
          children: ["IPY_MODEL_progA"],
          layout: "IPY_MODEL_layoutA",
        },
      },
      progA: {
        state: { _model_name: "FloatProgressModel", value: 3, max: 10, style: "IPY_MODEL_styleA" },
      },
      layoutA: { state: { _model_name: "LayoutModel" } },
      styleA: { state: { _model_name: "ProgressStyleModel" } },
      barB: { state: { _model_name: "HBoxModel", children: ["IPY_MODEL_progB"] } },
      progB: { state: { _model_name: "FloatProgressModel", value: 1, max: 4 } },
    },
  };
  const view = (modelId: string): OutputItem => ({
    output_type: "display_data",
    data: { [WIDGET_VIEW_MIME]: { model_id: modelId } },
    metadata: {},
  });

  it("carries the view's transitive closure, following refs outside children", () => {
    const p = widgetPayload(view("barA"), mirror)!;
    expect(p.model_id).toBe("barA");
    expect(Object.keys(p.state.state!).sort()).toEqual(["barA", "layoutA", "progA", "styleA"]);
  });

  it("leaves another cell's widgets out — html-manager instantiates every model it is given", () => {
    const p = widgetPayload(view("barA"), mirror)!;
    expect(p.state.state).not.toHaveProperty("barB");
    expect(p.state.state).not.toHaveProperty("progB");
    // and the protocol version the mirror declared rides along
    expect(p.state.version_major).toBe(2);
  });

  it("is undefined when the model is not mirrored (fresh run) so the caller falls back to text", () => {
    expect(widgetPayload(view("nope"), mirror)).toBeUndefined();
    expect(widgetPayload(view("barA"), null)).toBeUndefined();
  });

  it("terminates on a reference cycle", () => {
    const cyclic: WidgetState = {
      state: {
        a: { state: { _model_name: "BoxModel", children: ["IPY_MODEL_b"] } },
        b: { state: { _model_name: "BoxModel", children: ["IPY_MODEL_a"] } },
      },
    };
    expect(Object.keys(widgetPayload(view("a"), cyclic)!.state.state!).sort()).toEqual(["a", "b"]);
  });
});
