/**
 * Rich-output rendering helpers (matplotlib images + ipywidget text fallback).
 *
 * The daemon journals image payloads as `$tithon_artifact` references, not
 * base64 (SPEC.md) — these helpers turn a folded {@link OutputItem} into
 * what VSCode needs: image bytes fetched on demand, and a *text* fallback for
 * ipywidgets (SPEC.md fallback) reconstructed from the daemon's widget
 * state mirror (so a reconnect shows e.g. tqdm.notebook's FINAL bar, not "0%").
 *
 * Pure and DOM-free so it is unit-testable; the network fetch + VSCode binding
 * live in sessionClient/sessionController.
 */
import type { OutputItem } from "./outputFold";

export const WIDGET_VIEW_MIME = "application/vnd.jupyter.widget-view+json";
/** Self-contained widget output: the view's model id + the full mirror state, so
 *  the notebook renderer instantiates html-manager without a separate round-trip. */
export const TITHON_WIDGET_MIME = "application/vnd.tithon.widget+json";
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp"];

export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.includes(mime);
}

/** A reference left in the journal where an image payload used to be. */
export interface ArtifactRef {
  artifact_id: string;
  mime: string;
  rel_path: string;
  sha256: string;
}

function asArtifactRef(v: unknown): ArtifactRef | undefined {
  if (v && typeof v === "object" && "$tithon_artifact" in (v as Record<string, unknown>)) {
    return (v as { $tithon_artifact: ArtifactRef }).$tithon_artifact;
  }
  return undefined;
}

function dataOf(item: OutputItem): Record<string, unknown> | undefined {
  if (item.output_type === "display_data" || item.output_type === "execute_result") {
    return item.data ?? {};
  }
  return undefined;
}

/** Image artifact references carried by this output (for prefetching bytes). */
export function imageRefsOf(item: OutputItem): ArtifactRef[] {
  const data = dataOf(item);
  if (!data) return [];
  const out: ArtifactRef[] = [];
  for (const v of Object.values(data)) {
    const r = asArtifactRef(v);
    if (r && isImageMime(r.mime)) out.push(r);
  }
  return out;
}

/** The first renderable image in this output: an artifact ref, or inline base64. */
export function imageOf(
  item: OutputItem,
): { mime: string; ref?: ArtifactRef; base64?: string } | undefined {
  const data = dataOf(item);
  if (!data) return undefined;
  for (const mime of IMAGE_MIMES) {
    const v = data[mime];
    const ref = asArtifactRef(v);
    if (ref) return { mime, ref };
    if (typeof v === "string") return { mime, base64: v }; // not extracted (e.g. CLI inline)
  }
  return undefined;
}

/** The widget-view model id referenced by this output, if any. */
export function widgetModelIdOf(item: OutputItem): string | undefined {
  const data = dataOf(item);
  const view = data?.[WIDGET_VIEW_MIME] as { model_id?: string } | undefined;
  return view && typeof view.model_id === "string" ? view.model_id : undefined;
}

/** One binary buffer, base64-encoded — the shape `WidgetMirror.snapshot()`
 *  (daemon) and html-manager's `set_state()` both use for a widget's binary
 *  trait values (e.g. `Image.value`), kept out of the JSON `state`. */
export interface WidgetBufferEntry {
  encoding: string;
  path: (string | number)[];
  data: string;
}
/** The canonical `widget-state+json` snapshot shape the daemon mirror emits
 *  (also the shape a live client builds incrementally from comm events). */
export interface WidgetStateEntry {
  model_name?: string;
  model_module?: string;
  model_module_version?: string;
  state?: Record<string, unknown>;
  buffers?: WidgetBufferEntry[];
}
/**
 * Decode a comm event's `_buffers_b64` (daemon-forwarded, base64) into
 * {@link WidgetBufferEntry} entries keyed by their `buffer_paths`. Tolerates
 * a length mismatch between the two arrays (zips to the shorter) rather than
 * throwing — the daemon's own `_merge_buffers` is equally lenient.
 */
export function decodeBufferEntries(
  bufferPaths: unknown,
  buffersB64: string[] | undefined,
): WidgetBufferEntry[] {
  if (!Array.isArray(bufferPaths) || !buffersB64?.length) return [];
  const n = Math.min(bufferPaths.length, buffersB64.length);
  const out: WidgetBufferEntry[] = [];
  for (let i = 0; i < n; i++) {
    const path = bufferPaths[i];
    if (!Array.isArray(path)) continue;
    out.push({ encoding: "base64", path, data: buffersB64[i] });
  }
  return out;
}

function bufferPathKey(path: (string | number)[]): string {
  return JSON.stringify(path);
}

/**
 * Merge new buffer entries into a model's existing ones BY PATH — matching
 * the daemon's `WidgetMirror._merge_buffers`: a path present in `next`
 * replaces the prior entry at that path; every other path is left untouched.
 * ipywidgets' own comm protocol only resends buffers that actually changed
 * so replacing the whole array would silently drop unrelated,
 * still-current buffers (e.g. a size update on an Image widget must not wipe
 * its still-valid pixel data).
 */
export function mergeBufferEntries(
  prev: WidgetBufferEntry[] | undefined,
  next: WidgetBufferEntry[],
): WidgetBufferEntry[] {
  if (!next.length) return prev ?? [];
  const merged = new Map<string, WidgetBufferEntry>();
  for (const b of prev ?? []) merged.set(bufferPathKey(b.path), b);
  for (const b of next) merged.set(bufferPathKey(b.path), b);
  return [...merged.values()];
}

export interface WidgetContext {
  kernel_id: string | null;
  active_model_ids: string[];
  legacy_kernel_id?: string | null;
  states: Record<string, WidgetState>;
}

export interface WidgetScope {
  session: string;
  kernel_id: string;
  binding: string;
}

export interface WidgetState {
  version_major?: number;
  version_minor?: number;
  state?: Record<string, WidgetStateEntry>;
  widget_context?: WidgetContext;
  renderer_binding?: { session: string; binding: string };
  renderer_available?: boolean;
  allow_custom_widgets?: boolean;
}

/** Payload carried by a {@link TITHON_WIDGET_MIME} output item. */
export interface TithonWidgetPayload {
  model_id: string;
  state: WidgetState;
  scope?: WidgetScope;
  live?: boolean;
  allow_custom_widgets?: boolean;
  partial_tree?: PartialWidgetNode;
}

/** Resolve saved outputs against their own kernel's mirror, including model-id collisions. */
export function widgetStateForOutput(
  item: OutputItem,
  widgets: WidgetState | null | undefined,
): WidgetState | null | undefined {
  if (!widgets?.widget_context) return widgets;
  const kernelId =
    "widget_kernel_id" in item && typeof item.widget_kernel_id === "string"
      ? item.widget_kernel_id
      : "saved";
  return widgets.widget_context.states[kernelId];
}

export function widgetScopeForOutput(
  item: OutputItem,
  widgets: WidgetState | null | undefined,
): WidgetScope | undefined {
  if (!widgets?.renderer_binding) return undefined;
  const kernelId = widgets.widget_context
    ? "widget_kernel_id" in item && typeof item.widget_kernel_id === "string"
      ? item.widget_kernel_id
      : "saved"
    : "legacy";
  return { ...widgets.renderer_binding, kernel_id: kernelId };
}

/** Prefix ipywidgets uses to reference one model from another's trait value. */
const MODEL_REFS = ["IPY_MODEL_", "anywidget:"];
const MAX_WIDGET_GRAPH_MODELS = 16384;
const MAX_WIDGET_GRAPH_VALUES = 1000000;
const MAX_WIDGET_GRAPH_DEPTH = 64;

/** Model ids `state` references, anywhere in its nested arrays/objects. */
function referencedModels(
  state: unknown,
  out: Set<string>,
  budget: { remaining: number },
): boolean {
  const queue: Array<{ value: unknown; depth: number; exit?: boolean }> = [
    { value: state, depth: 0 },
  ];
  const active = new Set<object>();
  const complete = new Set<object>();
  try {
    while (queue.length) {
      if (--budget.remaining < 0) return false;
      const { value, depth, exit } = queue.pop()!;
      if (depth > MAX_WIDGET_GRAPH_DEPTH) return false;
      if (exit && value && typeof value === "object") {
        active.delete(value);
        complete.add(value);
        continue;
      }
      if (typeof value === "string") {
        for (const prefix of MODEL_REFS) {
          if (value.startsWith(prefix)) {
            out.add(value.slice(prefix.length));
            if (out.size > MAX_WIDGET_GRAPH_MODELS) return false;
          }
        }
      } else if (value && typeof value === "object") {
        if (active.has(value)) return false;
        if (complete.has(value)) continue;
        active.add(value);
        queue.push({ value, depth, exit: true });
        for (const key in value) {
          if (--budget.remaining < 0) return false;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor) continue;
          if (!("value" in descriptor)) return false;
          queue.push({ value: descriptor.value, depth: depth + 1 });
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the self-contained widget payload for a widget-view output: the model id
 * plus the mirror state that html-manager needs to instantiate it. Returns
 * undefined when the model isn't in the mirror (e.g. a fresh live run whose state
 * lives only in the snapshot) — the caller then uses the text fallback.
 *
 * The state is narrowed to the models this view actually reaches — following
 * `IPY_MODEL_` references transitively, the same way ipywidgets' own
 * `unpack_models` deserializer resolves them, so a `layout`/`style`/`children`
 * reference is followed wherever it sits in the trait. The mirror is
 * SESSION-wide: sending all of it would put every widget of every cell in every
 * widget output, and html-manager's `set_state` instantiates each one — a
 * training cell with three tqdm bars re-created ~35 models per bar and shipped
 * the whole mirror three times per repaint (measured: 34KB x3 per plot frame).
 */
export function widgetPayload(
  item: OutputItem,
  widgets: WidgetState | null | undefined,
): TithonWidgetPayload | undefined {
  try {
    return buildWidgetPayload(item, widgets);
  } catch {
    return undefined;
  }
}

function buildWidgetPayload(
  item: OutputItem,
  widgets: WidgetState | null | undefined,
): TithonWidgetPayload | undefined {
  const source = widgets;
  const scope = widgetScopeForOutput(item, widgets);
  widgets = widgetStateForOutput(item, widgets);
  const id = widgetModelIdOf(item);
  const models = widgets?.state;
  if (!id || !models || !Object.getOwnPropertyDescriptor(models, id)?.value) return undefined;
  const reachable: Record<string, WidgetStateEntry> = Object.create(null);
  const queue = [id];
  const queued = new Set(queue);
  const budget = { remaining: MAX_WIDGET_GRAPH_VALUES };
  let complete = true;
  while (queue.length) {
    const next = queue.pop()!;
    if (reachable[next]) continue;
    const entry = Object.getOwnPropertyDescriptor(models, next)?.value as
      | WidgetStateEntry
      | undefined;
    if (!entry) {
      complete = false;
      continue;
    }
    reachable[next] = entry;
    const refs = new Set<string>();
    if (!referencedModels(entry.state, refs, budget)) return undefined;
    for (const r of refs) {
      if (queued.has(r)) continue;
      if (queued.size >= MAX_WIDGET_GRAPH_MODELS) return undefined;
      queued.add(r);
      queue.push(r);
    }
  }
  return {
    model_id: id,
    ...(scope ? { scope } : {}),
    ...(source?.allow_custom_widgets ? { allow_custom_widgets: true } : {}),
    live:
      complete &&
      widgetsLiveForOutput(item, source) &&
      Object.keys(reachable).every((id) => source?.widget_context?.active_model_ids.includes(id)),
    state: {
      version_major: widgets?.version_major ?? 2,
      version_minor: widgets?.version_minor ?? 0,
      state: reachable,
    },
  };
}

function widgetsLiveForOutput(item: OutputItem, widgets: WidgetState | null | undefined): boolean {
  const context = widgets?.widget_context;
  return (
    !!context &&
    widgets?.renderer_available !== false &&
    "widget_kernel_id" in item &&
    item.widget_kernel_id === context.kernel_id
  );
}

export function isRenderableWidget(
  item: OutputItem,
  widgets: WidgetState | null | undefined,
): boolean {
  try {
    return checkRenderableWidget(item, widgets);
  } catch {
    return false;
  }
}

function checkRenderableWidget(item: OutputItem, widgets: WidgetState | null | undefined): boolean {
  const id = widgetModelIdOf(item);
  if (!id) return false;
  const state = widgetStateForOutput(item, widgets);
  const payload = widgetPayload(item, widgets);
  if (!payload) return false;
  const live = payload?.live === true;
  const allowCustom = live && widgets?.allow_custom_widgets === true;
  for (const entry of Object.values(payload?.state.state ?? {})) {
    const attrs = entry.state ?? {};
    const declared = entry.model_module;
    const modelModule = attrs._model_module;
    if (declared && typeof modelModule === "string" && declared !== modelModule) return false;
    for (const moduleName of [declared ?? modelModule, attrs._view_module]) {
      if (
        moduleName == null ||
        moduleName === "@jupyter-widgets/base" ||
        moduleName === "@jupyter-widgets/controls"
      )
        continue;
      if (typeof moduleName === "string" && allowCustom) continue;
      return false;
    }
  }
  return supportedGraph(id, state, live, allowCustom);
}

const DISPLAY_ONLY_MODELS = new Set([
  "HTMLModel",
  "HTMLMathModel",
  "LabelModel",
  "ImageModel",
  "IntProgressModel",
  "FloatProgressModel",
  "BoxModel",
  "HBoxModel",
  "VBoxModel",
  "GridBoxModel",
]);

export type PartialWidgetNode =
  | { kind: "container"; direction: "row" | "column"; children: PartialWidgetNode[] }
  | { kind: "label"; text: string }
  | { kind: "progress"; value: number; min: number; max: number }
  | { kind: "omitted"; reason: "missing" | "unsupported" };

const PARTIAL_VIEWS: Record<string, string> = {
  BoxModel: "BoxView",
  HBoxModel: "HBoxView",
  VBoxModel: "VBoxView",
  GridBoxModel: "GridBoxView",
  LabelModel: "LabelView",
  IntProgressModel: "ProgressView",
  FloatProgressModel: "ProgressView",
};
const PARTIAL_CONTAINERS = new Set(["BoxModel", "HBoxModel", "VBoxModel", "GridBoxModel"]);

/** Project only plain, read-only widget data; no manager or custom code receives it. */
export function partialWidgetPayload(
  item: OutputItem,
  widgets: WidgetState | null | undefined,
): TithonWidgetPayload | undefined {
  try {
    return buildPartialWidgetPayload(item, widgets);
  } catch {
    return undefined;
  }
}

function buildPartialWidgetPayload(
  item: OutputItem,
  widgets: WidgetState | null | undefined,
): TithonWidgetPayload | undefined {
  const id = widgetModelIdOf(item);
  const snapshot = widgetStateForOutput(item, widgets);
  const source = snapshot?.state;
  if (!id || !source || snapshot?.version_major !== 2 || snapshot.version_minor !== 0)
    return undefined;
  let hidden = false;
  let nodes = 0;
  let inspected = 0;
  const stack = new Set<string>();
  const model = (modelId: string): WidgetStateEntry | undefined =>
    Object.getOwnPropertyDescriptor(source, modelId)?.value;
  const references = (value: unknown): Set<string> | undefined => {
    const refs = new Set<string>();
    const queue: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 1 }];
    const active = new Set<object>();
    const complete = new Set<object>();
    let count = 0;
    while (queue.length) {
      if (++count > 4096 || ++inspected > 16384) return undefined;
      const { value: current, depth, exit } = queue.pop()!;
      if (depth > MAX_WIDGET_GRAPH_DEPTH) return undefined;
      if (exit && current && typeof current === "object") {
        active.delete(current);
        complete.add(current);
        continue;
      }
      if (typeof current === "string") {
        for (const prefix of MODEL_REFS) {
          if (current.startsWith(prefix)) refs.add(current.slice(prefix.length));
        }
      } else if (current && typeof current === "object") {
        if (active.has(current)) return undefined;
        if (complete.has(current)) continue;
        active.add(current);
        queue.push({ value: current, depth, exit: true });
        for (const key in current) {
          if (++inspected > 16384 || queue.length + count >= 4096) return undefined;
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor) continue;
          if (["__proto__", "constructor", "prototype"].includes(key) || !("value" in descriptor))
            return undefined;
          queue.push({ value: descriptor.value, depth: depth + 1 });
        }
      }
    }
    return refs;
  };
  const valid = (
    entry: WidgetStateEntry | undefined,
    name: string,
    module: string,
    view: string,
    viewModule: string,
  ) => {
    const state = entry?.state;
    return !!(
      state &&
      !entry?.buffers?.length &&
      entry?.model_name === name &&
      entry.model_module === module &&
      entry.model_module_version === "2.0.0" &&
      state._model_name === name &&
      state._model_module === module &&
      state._model_module_version === "2.0.0" &&
      state._view_name === view &&
      state._view_module === viewModule &&
      state._view_module_version === "2.0.0"
    );
  };
  const dependenciesValid = (state: Record<string, unknown>, name: string): boolean => {
    for (const key in state) {
      if (++inspected > 16384) return false;
      const descriptor = Object.getOwnPropertyDescriptor(state, key);
      if (!descriptor) continue;
      if (["__proto__", "constructor", "prototype"].includes(key) || !("value" in descriptor))
        return false;
      const value = descriptor.value;
      if (key === "children") continue;
      const refs = references(value);
      if (!refs) return false;
      if (!refs.size) continue;
      if (
        (key !== "layout" && key !== "style") ||
        typeof value !== "string" ||
        !value.startsWith("IPY_MODEL_") ||
        refs.size !== 1
      )
        return false;
      const dep = model(value.slice("IPY_MODEL_".length));
      const depName =
        key === "layout"
          ? "LayoutModel"
          : name === "LabelModel"
            ? "LabelStyleModel"
            : name.endsWith("ProgressModel")
              ? "ProgressStyleModel"
              : "";
      const depModule = key === "layout" ? "@jupyter-widgets/base" : "@jupyter-widgets/controls";
      const depView = key === "layout" ? "LayoutView" : "StyleView";
      if (!depName || !valid(dep, depName, depModule, depView, "@jupyter-widgets/base"))
        return false;
      const nested = references(dep!.state);
      if (!nested || nested.size) return false;
    }
    return true;
  };
  const visit = (modelId: string, depth: number): PartialWidgetNode | undefined => {
    if (++nodes > 128 || depth > 16 || stack.has(modelId)) return undefined;
    const entry = model(modelId);
    const name = entry?.model_name ?? "";
    const view = Object.keys(PARTIAL_VIEWS).includes(name) ? PARTIAL_VIEWS[name] : undefined;
    if (
      !view ||
      !valid(entry, name, "@jupyter-widgets/controls", view, "@jupyter-widgets/controls")
    ) {
      hidden = true;
      return { kind: "omitted", reason: entry ? "unsupported" : "missing" };
    }
    const state = entry!.state!;
    if (!dependenciesValid(state, name)) return undefined;
    if (PARTIAL_CONTAINERS.has(name)) {
      if (!Array.isArray(state.children)) return undefined;
      stack.add(modelId);
      const children: PartialWidgetNode[] = [];
      for (const child of state.children) {
        if (typeof child !== "string" || !child.startsWith("IPY_MODEL_")) return undefined;
        const childNode = visit(child.slice("IPY_MODEL_".length), depth + 1);
        if (!childNode) return undefined;
        children.push(childNode);
      }
      stack.delete(modelId);
      return { kind: "container", direction: name === "HBoxModel" ? "row" : "column", children };
    }
    if (state.children !== undefined) return undefined;
    if (name === "LabelModel") {
      if (typeof state.value !== "string" || state.value.length > 16384) return undefined;
      return { kind: "label", text: state.value };
    }
    if (
      ![state.value, state.min, state.max].every((n) => typeof n === "number" && Number.isFinite(n))
    )
      return undefined;
    const value = state.value as number,
      min = state.min as number,
      max = state.max as number;
    if (max <= min || !Number.isFinite(max - min)) return undefined;
    return { kind: "progress", value, min, max };
  };
  if (!PARTIAL_CONTAINERS.has(model(id)?.model_name ?? "")) return undefined;
  const tree = visit(id, 0);
  if (tree?.kind !== "container" || !hidden) return undefined;
  return {
    model_id: id,
    partial_tree: tree,
    live: false,
    state: { version_major: 2, version_minor: 0, state: {} },
  };
}

/** Classify graphs that remain renderable without live input authority. */
export function isDisplayOnlyWidget(
  modelId: string,
  widgets: WidgetState | null | undefined,
): boolean {
  return supportedGraph(modelId, widgets, false, false);
}

function supportedGraph(
  modelId: string,
  widgets: WidgetState | null | undefined,
  interactive: boolean,
  allowCustom: boolean,
): boolean {
  try {
    return checkSupportedGraph(modelId, widgets, interactive, allowCustom);
  } catch {
    return false;
  }
}

function checkSupportedGraph(
  modelId: string,
  widgets: WidgetState | null | undefined,
  interactive: boolean,
  allowCustom: boolean,
): boolean {
  const models = widgets?.state;
  if (!models) return false;
  const seen = new Set<string>();
  const queue = [modelId];
  const queued = new Set(queue);
  let edges = 0;
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    if (seen.size >= MAX_WIDGET_GRAPH_MODELS) return false;
    seen.add(id);
    const s = (Object.getOwnPropertyDescriptor(models, id)?.value as WidgetStateEntry | undefined)
      ?.state;
    if (!s) return false; // unknown model: fail closed
    const name = String(s._model_name ?? "");
    const bundledControl =
      interactive &&
      s._model_module === "@jupyter-widgets/controls" &&
      s._view_module === "@jupyter-widgets/controls";
    const customWidget =
      allowCustom && typeof s._model_module === "string" && typeof s._view_module === "string";
    if (!DISPLAY_ONLY_MODELS.has(name) && !bundledControl && !customWidget) return false;
    const ch = s.children;
    // `undefined` (a leaf widget) means no descendants to check. Anything ELSE
    // that isn't an array (a malformed/unexpected shape) fails closed instead of
    // silently being treated as childless.
    if (ch === undefined) continue;
    if (!Array.isArray(ch)) return false;
    for (const c of ch) {
      if (++edges > MAX_WIDGET_GRAPH_VALUES || typeof c !== "string") return false;
      const childId = c.replace(/^(?:IPY_MODEL_|anywidget:)/, "");
      if (queued.has(childId)) continue;
      if (queued.size >= MAX_WIDGET_GRAPH_MODELS) return false;
      queued.add(childId);
      queue.push(childId);
    }
  }
  return true;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/ /g, " ")
    .replace(/&amp;/g, "&");
}

function numStr(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * A one-line text rendering of an ipywidget from the mirror state (SPEC.md
 * fallback). For a progress widget (tqdm.notebook) it reconstructs the
 * familiar bar from the FINAL mirrored state: `100% |████████| 5/5 [time]`.
 * Returns undefined when the model is unknown (e.g. a fresh live run before any
 * snapshot) so the caller can fall back to the display's own text/plain.
 */
export function widgetFallbackText(
  modelId: string,
  widgets: WidgetState | null | undefined,
): string | undefined {
  try {
    return buildWidgetFallbackText(modelId, widgets);
  } catch {
    return undefined;
  }
}

function buildWidgetFallbackText(
  modelId: string,
  widgets: WidgetState | null | undefined,
): string | undefined {
  const models = widgets?.state;
  const entryOf = (id: string): WidgetStateEntry | undefined =>
    models ? Object.getOwnPropertyDescriptor(models, id)?.value : undefined;
  const attrsOf = (id: string): Record<string, unknown> | undefined => entryOf(id)?.state;
  const root = attrsOf(modelId);
  if (!root) return undefined;

  let progress: { value: number; max: number } | undefined;
  const labels: string[] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();
  const queue = [modelId];
  let edges = 0;
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    if (seen.size >= MAX_WIDGET_GRAPH_MODELS) {
      unavailable.push("[Additional widgets not shown]");
      break;
    }
    seen.add(id);
    const s = attrsOf(id);
    if (!s) {
      unavailable.push(`[Widget not shown: ${id}]`);
      continue;
    }
    const name = String(s._model_name ?? "");
    const declared = entryOf(id)?.model_module;
    const modelModule = s._model_module;
    const viewModule = s._view_module;
    const bundled = (value: unknown) =>
      value == null || value === "@jupyter-widgets/base" || value === "@jupyter-widgets/controls";
    const supported = !(
      !DISPLAY_ONLY_MODELS.has(name) ||
      !bundled(declared) ||
      !bundled(modelModule) ||
      !bundled(viewModule) ||
      (declared && typeof modelModule === "string" && declared !== modelModule)
    );
    if (!supported) {
      const module = typeof s._model_module === "string" ? ` (${s._model_module})` : "";
      unavailable.push(`[Widget not shown: ${name || id}${module}]`);
    }
    if (supported && name.includes("Progress") && typeof s.value === "number") {
      if (!progress) progress = { value: s.value, max: typeof s.max === "number" ? s.max : 0 };
    } else if (
      supported &&
      (name === "HTMLModel" || name === "LabelModel") &&
      typeof s.value === "string" &&
      s.value
    ) {
      labels.push(unescapeHtml(s.value).trim());
    }
    const ch = s.children;
    if (Array.isArray(ch)) {
      const count = Math.min(ch.length, MAX_WIDGET_GRAPH_MODELS - edges);
      if (count < ch.length) unavailable.push("[Additional widgets not shown]");
      for (let index = count - 1; index >= 0; index--) {
        const child = ch[index];
        if (typeof child === "string") queue.push(child.replace(/^(?:IPY_MODEL_|anywidget:)/, ""));
      }
      edges += count;
    }
  }

  if (progress) {
    const pct = progress.max > 0 ? Math.round((progress.value / progress.max) * 100) : 0;
    const width = 20;
    const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    const left = labels[0] ?? `${pct}%`;
    const right = labels.slice(1).join(" ") || `${numStr(progress.value)}/${numStr(progress.max)}`;
    return [`${left} |${bar}| ${right}`.trim(), ...unavailable].join(" ");
  }
  if (labels.length || unavailable.length) return [...labels, ...unavailable].join(" ");
  return `[${String(root._model_name ?? "widget")}]`;
}

/**
 * An `ipywidgets.Output` widget's OWN view is not worth rendering.
 *
 * The widget exists to display the outputs it captured, and Tithon renders
 * those at cell level (they fold into the same cell), so its
 * view is a placeholder for content already shown directly below it. It cannot
 * take the html-manager path either: `OutputModel` is deliberately absent from
 * the display-only allow-list, because its `outputs` trait nests other widgets
 * outside `children` and the allow-list could not vet them (ADR-096). What is
 * left is the last-resort fallback label — a bare `[OutputModel]`, which reads
 * as a bug rather than as information. Drop it.
 */
export function isOutputAreaView(
  item: OutputItem,
  widgets: WidgetState | null | undefined,
): boolean {
  try {
    const id = widgetModelIdOf(item);
    if (!id) return false;
    return (
      String(widgetStateForOutput(item, widgets)?.state?.[id]?.state?._model_name ?? "") ===
      "OutputModel"
    );
  } catch {
    return false;
  }
}
