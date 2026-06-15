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

/** The canonical `widget-state+json` snapshot shape the daemon mirror emits
 *  (also the shape a live client builds incrementally from comm events). */
export interface WidgetStateEntry {
  model_name?: string;
  model_module?: string;
  model_module_version?: string;
  state?: Record<string, unknown>;
  buffers?: unknown[];
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

/**
 * Build the self-contained widget payload for a widget-view output: the model id
 * plus the mirror state that html-manager needs to instantiate it. Returns
 * undefined when the model isn't in the mirror (e.g. a fresh live run whose state
 * lives only in the snapshot) — the caller then uses the text fallback.
 */
export function widgetPayload(
  item: OutputItem,
  widgets: WidgetState | null | undefined,
): TithonWidgetPayload | undefined {
  const id = widgetModelIdOf(item);
  if (!id || !widgets?.state?.[id]) return undefined;
  return { model_id: id, state: widgets };
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
    } else if ((name === "HTMLModel" || name === "LabelModel") && typeof s.value === "string" && s.value) {
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
