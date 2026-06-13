/**
 * ipywidget rendering from a Widget State Mirror snapshot (design.md §3.3).
 *
 * The extension contributes a notebook renderer for
 * `application/vnd.jupyter.widget-view+json` and instantiates models/views with
 * `@jupyter-widgets/html-manager` — the same code path exercised here against a
 * jsdom DOM. The snapshot fed in is exactly what the daemon's mirror emits
 * (`application/vnd.jupyter.widget-state+json`), so a passing render proves the
 * daemon output is directly consumable by the real widget manager.
 *
 * html-manager's stock `loadClass` resolves the bundled `@jupyter-widgets/base`
 * and `controls` modules via webpack-style `require(...)` (plus a CSS require).
 * That doesn't work under an ESM runtime (vite/jsdom — and is the same class of
 * "renderer sandbox" constraint flagged in §3.3 / §4). We override `loadClass`
 * to resolve those bundled modules through ESM imports instead; the rendering
 * logic itself (ProgressView etc.) is untouched.
 */
// Import from the submodule, not the package root: the root `index` pulls in
// `libembed-amd` (a webpack-only AMD/CDN loader using `__webpack_public_path__`
// and CSS imports) which we don't use — we resolve bundled modules ourselves.
import { HTMLManager } from "@jupyter-widgets/html-manager/lib/htmlmanager";
import * as base from "@jupyter-widgets/base";
import * as controls from "@jupyter-widgets/controls";

export interface WidgetStateSnapshot {
  version_major: number;
  version_minor: number;
  state: Record<string, WidgetStateEntry>;
}

export interface WidgetStateEntry {
  model_name?: string;
  model_module?: string;
  model_module_version?: string;
  state: Record<string, unknown>;
  buffers?: Array<{ encoding: string; path: (string | number)[]; data: string }>;
}

class TithonWidgetManager extends HTMLManager {
  protected async loadClass(
    className: string,
    moduleName: string,
    moduleVersion: string,
  ): Promise<any> {
    let mod: any = null;
    if (moduleName === "@jupyter-widgets/base") mod = base;
    else if (moduleName === "@jupyter-widgets/controls") mod = controls;
    if (mod) {
      if (mod[className]) return mod[className];
      throw new Error(`Class ${className} not found in ${moduleName}@${moduleVersion}`);
    }
    return super.loadClass(className, moduleName, moduleVersion);
  }
}

export function createManager(): HTMLManager {
  return new TithonWidgetManager();
}

/** Find the first model id in the snapshot whose model_name matches. */
export function findModelId(
  snapshot: WidgetStateSnapshot,
  modelName: string,
): string | undefined {
  for (const [id, entry] of Object.entries(snapshot.state)) {
    if (entry.model_name === modelName) return id;
  }
  return undefined;
}

/**
 * Render the model identified by `modelId` from `snapshot` into `host` using the
 * real widget manager. `host` must be attached to the document (Lumino's attach
 * requires a connected host). Returns the manager for further inspection.
 */
export async function renderWidget(
  snapshot: WidgetStateSnapshot,
  modelId: string,
  host: HTMLElement,
  manager: HTMLManager = createManager(),
): Promise<HTMLManager> {
  await manager.set_state(snapshot as any);
  const model = await manager.get_model(modelId);
  if (!model) throw new Error(`model ${modelId} not in snapshot`);
  const view = await manager.create_view(model as any);
  await manager.display_view(view, host);
  return manager;
}

/**
 * Design §3.3 fallback: if the live renderer fails, show the widget's *final
 * state* as text so no information is lost. For progress widgets that is the
 * value/max pair the daemon mirror already holds.
 */
export function renderFallbackText(
  snapshot: WidgetStateSnapshot,
  modelId: string,
  host: HTMLElement,
): string {
  const s = (snapshot.state[modelId]?.state ?? {}) as Record<string, unknown>;
  let text: string;
  if (typeof s.value === "number" && typeof s.max === "number") {
    text = `${s.value}/${s.max}`;
  } else if ("value" in s) {
    text = String(s.value);
  } else {
    text = JSON.stringify(s);
  }
  const doc = host.ownerDocument || (globalThis as any).document;
  const pre = doc.createElement("pre");
  pre.className = "tithon-widget-fallback";
  pre.textContent = text;
  host.appendChild(pre);
  return text;
}

/**
 * Renderer entrypoint logic (shared with the VSCode notebook renderer): render
 * the widget referenced by a `widget-view+json` output against a mirror
 * snapshot, falling back to text on any error. Returns "html" or "fallback".
 */
export async function renderWidgetView(
  snapshot: WidgetStateSnapshot,
  outputJson: { model_id: string },
  host: HTMLElement,
): Promise<"html" | "fallback"> {
  try {
    await renderWidget(snapshot, outputJson.model_id, host);
    return "html";
  } catch (err) {
    renderFallbackText(snapshot, outputJson.model_id, host);
    return "fallback";
  }
}
