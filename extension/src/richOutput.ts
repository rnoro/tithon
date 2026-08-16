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

export interface WidgetState {
  version_major?: number;
  version_minor?: number;
  state?: Record<string, WidgetStateEntry>;
}

/** Payload carried by a {@link TITHON_WIDGET_MIME} output item. */
export interface TithonWidgetPayload {
  model_id: string;
  state: WidgetState;
}

/** Prefix ipywidgets uses to reference one model from another's trait value. */
const MODEL_REF = "IPY_MODEL_";

/** Model ids `state` references, anywhere in its nested arrays/objects. */
function referencedModels(state: unknown, out: Set<string>): void {
  if (typeof state === "string") {
    if (state.startsWith(MODEL_REF)) out.add(state.slice(MODEL_REF.length));
    return;
  }
  if (Array.isArray(state)) {
    for (const v of state) referencedModels(v, out);
    return;
  }
  if (state && typeof state === "object") {
    for (const v of Object.values(state as Record<string, unknown>)) referencedModels(v, out);
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
  const id = widgetModelIdOf(item);
  const models = widgets?.state;
  if (!id || !models?.[id]) return undefined;
  const reachable: Record<string, WidgetStateEntry> = {};
  const queue = [id];
  while (queue.length) {
    const next = queue.pop()!;
    if (reachable[next] || !models[next]) continue;
    reachable[next] = models[next];
    const refs = new Set<string>();
    referencedModels(models[next].state, refs);
    for (const r of refs) if (!reachable[r]) queue.push(r);
  }
  return {
    model_id: id,
    state: {
      version_major: widgets?.version_major ?? 2,
      version_minor: widgets?.version_minor ?? 0,
      state: reachable,
    },
  };
}

// Widgets with no client -> kernel back-channel. The comm path is receive-only,
// so a control's own DOM interaction updates its LOCAL view state and never
// reaches the kernel or errors — a slider drag or button click does nothing, with
// no indication anything is wrong. This is an ALLOW-list, not a deny-list, on
// purpose: an unrecognized model — including any future ipywidgets control — falls
// back to text by default rather than risking a silent no-op control that LOOKS
// functional. Every entry verified against the installed `@jupyter-widgets`
// package source (its View class registers no DOM listener that writes back to
// the model) — an entry that cannot be checked against that source does not
// belong here. `OutputModel` is deliberately
// EXCLUDED despite having no interaction of its own: its `outputs` trait can
// nest a `display_data` item carrying ANOTHER widget's
// `application/vnd.jupyter.widget-view+json` reference, entirely outside the
// `children` array this function walks — an interactive widget captured inside
// an Output widget would slip past this guard undetected.
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

/**
 * Whether this widget — and, for a container, every descendant reachable via
 * `children` — is display-only. A container holding even one interactive or
 * unrecognized child is NOT safe to render interactively: the child would still
 * silently swallow its own input. Mirrors `widgetFallbackText`'s own traversal.
 */
export function isDisplayOnlyWidget(
  modelId: string,
  widgets: WidgetState | null | undefined,
): boolean {
  const models = widgets?.state;
  if (!models) return false;
  const seen = new Set<string>();
  const check = (id: string): boolean => {
    if (seen.has(id)) return true; // a cycle can't introduce a NEW interactive node
    seen.add(id);
    const s = models[id]?.state;
    if (!s) return false; // unknown model: fail closed
    const name = String(s._model_name ?? "");
    if (!DISPLAY_ONLY_MODELS.has(name)) return false;
    const ch = s.children;
    // `undefined` (a leaf widget) means no descendants to check. Anything ELSE
    // that isn't an array (a malformed/unexpected shape) fails closed instead of
    // silently being treated as childless.
    if (ch === undefined) return true;
    if (!Array.isArray(ch)) return false;
    for (const c of ch) {
      if (typeof c !== "string") return false;
      if (!check(c.replace(/^IPY_MODEL_/, ""))) return false;
    }
    return true;
  };
  return check(modelId);
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
  const models = widgets?.state;
  const attrsOf = (id: string): Record<string, unknown> | undefined => models?.[id]?.state;
  const root = attrsOf(modelId);
  if (!root) return undefined;

  let progress: { value: number; max: number } | undefined;
  const labels: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const s = attrsOf(id);
    if (!s) return;
    const name = String(s._model_name ?? "");
    if (name.includes("Progress") && typeof s.value === "number") {
      if (!progress) progress = { value: s.value, max: typeof s.max === "number" ? s.max : 0 };
    } else if (
      (name === "HTMLModel" || name === "LabelModel") &&
      typeof s.value === "string" &&
      s.value
    ) {
      labels.push(unescapeHtml(s.value).trim());
    }
    const ch = s.children;
    if (Array.isArray(ch)) {
      for (const c of ch) if (typeof c === "string") visit(c.replace(/^IPY_MODEL_/, ""));
    }
  };
  visit(modelId);

  if (progress) {
    const pct = progress.max > 0 ? Math.round((progress.value / progress.max) * 100) : 0;
    const width = 20;
    const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    const left = labels[0] ?? `${pct}%`;
    const right = labels.slice(1).join(" ") || `${numStr(progress.value)}/${numStr(progress.max)}`;
    return `${left} |${bar}| ${right}`.trim();
  }
  if (labels.length) return labels.join(" ");
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
  const id = widgetModelIdOf(item);
  if (!id) return false;
  return String(widgets?.state?.[id]?.state?._model_name ?? "") === "OutputModel";
}
