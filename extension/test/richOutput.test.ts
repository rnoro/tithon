import { describe, expect, it } from "vitest";
import type { OutputItem } from "../src/outputFold";
import {
  imageOf,
  imageRefsOf,
  isDisplayOnlyWidget,
  isOutputAreaView,
  isRenderableWidget,
  partialWidgetPayload,
  WIDGET_VIEW_MIME,
  type WidgetState,
  widgetFallbackText,
  widgetModelIdOf,
  widgetPayload,
} from "../src/richOutput";

const ref = (id: string) => ({
  $tithon_artifact: { artifact_id: id, mime: "image/png", rel_path: `p/${id}.png`, sha256: id },
});

it("projects supported saved children without custom code or live authority", () => {
  const item: OutputItem = {
    output_type: "display_data",
    data: { [WIDGET_VIEW_MIME]: { model_id: "box" } },
  };
  const state: WidgetState = {
    version_major: 2,
    version_minor: 0,
    state: {
      box: {
        model_name: "VBoxModel",
        model_module: "@jupyter-widgets/controls",
        model_module_version: "2.0.0",
        state: {
          _model_name: "VBoxModel",
          _model_module: "@jupyter-widgets/controls",
          _model_module_version: "2.0.0",
          _view_name: "VBoxView",
          _view_module: "@jupyter-widgets/controls",
          _view_module_version: "2.0.0",
          children: ["IPY_MODEL_label", "IPY_MODEL_custom", "IPY_MODEL_missing"],
        },
      },
      label: {
        model_name: "LabelModel",
        model_module: "@jupyter-widgets/controls",
        model_module_version: "2.0.0",
        state: {
          _model_name: "LabelModel",
          _model_module: "@jupyter-widgets/controls",
          _model_module_version: "2.0.0",
          _view_name: "LabelView",
          _view_module: "@jupyter-widgets/controls",
          _view_module_version: "2.0.0",
          value: "Safe label",
        },
      },
      custom: {
        model_name: "AnyModel",
        model_module: "anywidget",
        state: { _model_name: "AnyModel", _model_module: "anywidget", _esm: "unsafe code" },
      },
    },
  };
  const before = JSON.stringify(state);
  const result = partialWidgetPayload(item, state)!;
  expect(result.partial_tree?.kind).toBe("container");
  expect(result.live).toBe(false);
  expect(result.scope).toBeUndefined();
  expect(JSON.stringify(result.partial_tree)).toContain("Safe label");
  expect(JSON.stringify(result)).not.toContain("unsafe code");
  expect(Object.keys(result.state.state!)).not.toContain("custom");
  expect(JSON.stringify(result)).toContain('"reason":"missing"');
  expect(JSON.stringify(result)).toContain('"reason":"unsupported"');
  expect(JSON.stringify(state)).toBe(before);
  const withoutEnumeration = new Proxy(state.state!, {
    ownKeys() {
      throw new Error("unrelated models must not be enumerated");
    },
  });
  expect(partialWidgetPayload(item, { ...state, state: withoutEnumeration })?.partial_tree).toEqual(
    result.partial_tree,
  );
  expect(partialWidgetPayload(item, { ...state, version_major: undefined })).toBeUndefined();
  expect(partialWidgetPayload(item, { ...state, version_minor: 1 })).toBeUndefined();
  expect(partialWidgetPayload(item, { ...state, version_major: 3 })).toBeUndefined();
  const boxState = state.state!.box.state!;
  const shared = { safe: "value" };
  boxState.extra = [shared, shared];
  expect(partialWidgetPayload(item, state)?.partial_tree).toEqual(result.partial_tree);
  let nested: unknown = "value";
  for (let index = 0; index < 100; index++) nested = { nested };
  boxState.extra = nested;
  expect(partialWidgetPayload(item, state)).toBeUndefined();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  boxState.extra = cyclic;
  expect(partialWidgetPayload(item, state)).toBeUndefined();
  delete boxState.extra;
  state.state!.progress = {
    model_name: "FloatProgressModel",
    model_module: "@jupyter-widgets/controls",
    model_module_version: "2.0.0",
    state: {
      _model_name: "FloatProgressModel",
      _model_module: "@jupyter-widgets/controls",
      _model_module_version: "2.0.0",
      _view_name: "ProgressView",
      _view_module: "@jupyter-widgets/controls",
      _view_module_version: "2.0.0",
      min: -Number.MAX_VALUE,
      max: Number.MAX_VALUE,
      value: 0,
    },
  };
  boxState.children = ["IPY_MODEL_progress", "IPY_MODEL_missing"];
  expect(partialWidgetPayload(item, state)).toBeUndefined();
});

it("rejects partial projections with missing non-child dependencies or cycles", () => {
  const item: OutputItem = {
    output_type: "display_data",
    data: { [WIDGET_VIEW_MIME]: { model_id: "box" } },
  };
  const box = {
    model_name: "VBoxModel",
    model_module: "@jupyter-widgets/controls",
    model_module_version: "2.0.0",
    state: {
      _model_name: "VBoxModel",
      _model_module: "@jupyter-widgets/controls",
      _model_module_version: "2.0.0",
      _view_name: "VBoxView",
      _view_module: "@jupyter-widgets/controls",
      _view_module_version: "2.0.0",
      children: ["IPY_MODEL_missing"],
      layout: "IPY_MODEL_absent-layout",
    },
  };
  expect(
    partialWidgetPayload(item, { version_major: 2, version_minor: 0, state: { box } }),
  ).toBeUndefined();
  box.state.layout = "";
  box.state.children = ["IPY_MODEL_box", "IPY_MODEL_missing"];
  expect(
    partialWidgetPayload(item, { version_major: 2, version_minor: 0, state: { box } }),
  ).toBeUndefined();
});

it("keeps partial output within its historical scope and rejects unsafe roles and buffers", () => {
  const item: OutputItem = {
    output_type: "display_data",
    data: { [WIDGET_VIEW_MIME]: { model_id: "box" } },
    widget_kernel_id: "old",
  };
  const entry = (name: string, view: string) => ({
    model_name: name,
    model_module: "@jupyter-widgets/controls",
    model_module_version: "2.0.0",
    state: {
      _model_name: name,
      _model_module: "@jupyter-widgets/controls",
      _model_module_version: "2.0.0",
      _view_name: view,
      _view_module: "@jupyter-widgets/controls",
      _view_module_version: "2.0.0",
    } as Record<string, unknown>,
  });
  const box = entry("VBoxModel", "VBoxView");
  box.state.children = ["IPY_MODEL_label", "IPY_MODEL_constructor"];
  const label = entry("LabelModel", "LabelView");
  label.state.value = "historical";
  const old: WidgetState = { version_major: 2, version_minor: 0, state: { box, label } };
  const current: WidgetState = {
    version_major: 2,
    version_minor: 0,
    state: { box, label: { ...label, state: { ...label.state, value: "current" } } },
  };
  const widgets: WidgetState = {
    widget_context: {
      kernel_id: "new",
      active_model_ids: ["box", "label"],
      states: { old, new: current },
    },
  };
  const result = partialWidgetPayload(item, widgets)!;
  expect(JSON.stringify(result.partial_tree)).toContain("historical");
  expect(JSON.stringify(result.partial_tree)).not.toContain("current");
  expect(JSON.stringify(result.partial_tree)).toContain('"reason":"missing"');
  expect(result.scope).toBeUndefined();
  box.state.layout = "IPY_MODEL_label";
  expect(partialWidgetPayload(item, widgets)).toBeUndefined();
  delete box.state.layout;
  box.state._view_name = "ButtonView";
  expect(partialWidgetPayload(item, widgets)).toBeUndefined();
  box.state._view_name = "VBoxView";
  box.state.extra = Array(5000).fill(0);
  expect(partialWidgetPayload(item, widgets)).toBeUndefined();
  delete box.state.extra;
  (box as any).buffers = [{ encoding: "base64", path: ["children"], data: "eA==" }];
  expect(partialWidgetPayload(item, widgets)).toBeUndefined();
});

it("bounds the number of expanded partial views", () => {
  const item: OutputItem = {
    output_type: "display_data",
    data: { [WIDGET_VIEW_MIME]: { model_id: "box" } },
  };
  const box = {
    model_name: "VBoxModel",
    model_module: "@jupyter-widgets/controls",
    model_module_version: "2.0.0",
    state: {
      _model_name: "VBoxModel",
      _model_module: "@jupyter-widgets/controls",
      _model_module_version: "2.0.0",
      _view_name: "VBoxView",
      _view_module: "@jupyter-widgets/controls",
      _view_module_version: "2.0.0",
      children: Array(129).fill("IPY_MODEL_missing"),
    },
  };
  expect(
    partialWidgetPayload(item, { version_major: 2, version_minor: 0, state: { box } }),
  ).toBeUndefined();
});

it("bounds the normal graph scan before selecting a partial fallback", () => {
  const item: OutputItem = {
    output_type: "display_data",
    data: { [WIDGET_VIEW_MIME]: { model_id: "box" } },
  };
  let nested: unknown = "value";
  for (let index = 0; index < 100; index++) nested = { nested };
  const state = { state: { box: { state: { _model_name: "VBoxModel", nested } } } };
  expect(widgetPayload(item, state)).toBeUndefined();
  expect(isRenderableWidget(item, state)).toBe(false);
  const throwingState = new Proxy(
    { _model_name: "VBoxModel" },
    {
      ownKeys() {
        throw new Error("cannot enumerate");
      },
    },
  );
  const exotic = { state: { box: { state: throwingState } } };
  expect(widgetPayload(item, exotic)).toBeUndefined();
  expect(partialWidgetPayload(item, exotic)).toBeUndefined();
  expect(isRenderableWidget(item, exotic)).toBe(false);
  const throwingLookup = new Proxy(
    {},
    {
      get() {
        throw new Error("cannot read");
      },
    },
  );
  expect(isRenderableWidget(item, { state: throwingLookup })).toBe(false);
  expect(isOutputAreaView(item, { state: throwingLookup })).toBe(false);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(widgetPayload(item, { state: { box: { state: cyclic } } })).toBeUndefined();
  const shared = { value: "safe" };
  expect(
    widgetPayload(item, { state: { box: { state: { items: [shared, shared] } } } }),
  ).toBeDefined();
});

it("renders a deeply nested text fallback without recursive stack growth", () => {
  const states: NonNullable<WidgetState["state"]> = {};
  for (let index = 0; index < 10000; index++) {
    states[String(index)] = {
      state: { _model_name: "VBoxModel", children: [`IPY_MODEL_${index + 1}`] },
    };
  }
  states["10000"] = { state: { _model_name: "LabelModel", value: "Deep label" } };
  expect(widgetFallbackText("0", { state: states })).toContain("Deep label");
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

  it("identifies unavailable children alongside supported content in mixed containers", () => {
    const w: WidgetState = {
      state: {
        box: {
          state: {
            _model_name: "VBoxModel",
            children: [
              "IPY_MODEL_label",
              "anywidget:custom",
              "IPY_MODEL_missing",
              "IPY_MODEL_image",
              "IPY_MODEL_fake",
            ],
          },
        },
        label: { state: { _model_name: "LabelModel", value: "Available label" } },
        custom: { state: { _model_name: "MapModel", _model_module: "unbundled-map" } },
        image: { state: { _model_name: "ImageModel", _model_module: "unbundled-image" } },
        fake: { state: { _model_name: "CustomProgressModel", value: 3, max: 4 } },
      },
    };
    const text = widgetFallbackText("box", w)!;
    expect(text).toContain("Available label");
    expect(text).toContain("[Widget not shown: MapModel (unbundled-map)]");
    expect(text).toContain("[Widget not shown: missing]");
    expect(text).toContain("[Widget not shown: ImageModel (unbundled-image)]");
    expect(text).toContain("[Widget not shown: CustomProgressModel]");
    expect(text).not.toContain("75%");
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

it("renders live bundled controls without granting saved or external models input", () => {
  const checkbox: WidgetState = {
    state: {
      check: {
        state: {
          _model_name: "CheckboxModel",
          _model_module: "@jupyter-widgets/controls",
          _view_module: "@jupyter-widgets/controls",
          value: false,
        },
      },
    },
  };
  const widgets: WidgetState = {
    widget_context: { kernel_id: "live", active_model_ids: ["check"], states: { live: checkbox } },
  };
  const item: OutputItem = {
    output_type: "display_data",
    data: { [WIDGET_VIEW_MIME]: { model_id: "check" } },
    widget_kernel_id: "live",
  };
  expect(isRenderableWidget(item, widgets)).toBe(true);
  widgets.widget_context!.active_model_ids = [];
  expect(isRenderableWidget(item, widgets)).toBe(false);
  widgets.widget_context!.active_model_ids = ["check"];
  checkbox.state!.check.state!._view_module = "external-widget";
  expect(isRenderableWidget(item, widgets)).toBe(false);
});

it("admits anywidget code only in a trusted, active, complete model graph", () => {
  const state: WidgetState = {
    state: {
      root: {
        model_module: "anywidget",
        state: {
          _model_name: "AnyModel",
          _model_module: "anywidget",
          _view_module: "anywidget",
          nested: "anywidget:child",
        },
      },
      child: {
        model_module: "anywidget",
        state: { _model_name: "AnyModel", _model_module: "anywidget", _view_module: "anywidget" },
      },
    },
  };
  const widgets: WidgetState = {
    allow_custom_widgets: true,
    widget_context: {
      kernel_id: "live",
      active_model_ids: ["root", "child"],
      states: { live: state },
    },
  };
  const item: OutputItem = {
    output_type: "display_data",
    data: { [WIDGET_VIEW_MIME]: { model_id: "root" } },
    widget_kernel_id: "live",
  };
  expect(isRenderableWidget(item, widgets)).toBe(true);
  widgets.allow_custom_widgets = false;
  expect(isRenderableWidget(item, widgets)).toBe(false);
  widgets.allow_custom_widgets = true;
  widgets.widget_context!.active_model_ids = ["root"];
  expect(isRenderableWidget(item, widgets)).toBe(false);
  widgets.widget_context!.active_model_ids = ["root", "child"];
  state.state!.child.model_module = "other-module";
  expect(isRenderableWidget(item, widgets)).toBe(false);
});

it("admits external models only for trusted complete live graphs", () => {
  const state: WidgetState = {
    state: {
      figure: {
        model_module: "bqplot",
        state: {
          _model_name: "FigureModel",
          _model_module: "bqplot",
          _view_module: "bqplot",
          scales: "IPY_MODEL_scale",
        },
      },
      scale: {
        model_module: "bqscales",
        state: { _model_name: "LinearScaleModel", _model_module: "bqscales" },
      },
    },
  };
  const widgets: WidgetState = {
    allow_custom_widgets: true,
    widget_context: {
      kernel_id: "live",
      active_model_ids: ["figure", "scale"],
      states: { live: state },
    },
  };
  const item: OutputItem = {
    output_type: "display_data",
    data: { [WIDGET_VIEW_MIME]: { model_id: "figure" } },
    widget_kernel_id: "live",
  };
  expect(isRenderableWidget(item, widgets)).toBe(true);
  widgets.allow_custom_widgets = false;
  expect(isRenderableWidget(item, widgets)).toBe(false);
  widgets.allow_custom_widgets = true;
  widgets.widget_context!.active_model_ids = ["figure"];
  expect(isRenderableWidget(item, widgets)).toBe(false);
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

  it("includes anywidget composition references nested in model state", () => {
    const state: WidgetState = {
      state: {
        root: { state: { nested: [{ child: "anywidget:child" }] } },
        child: { state: { layout: "IPY_MODEL_layout" } },
        layout: { state: {} },
        unrelated: { state: {} },
      },
    };
    expect(Object.keys(widgetPayload(view("root"), state)!.state.state!).sort()).toEqual([
      "child",
      "layout",
      "root",
    ]);
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
