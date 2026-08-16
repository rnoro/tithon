/**
 * VSCode notebook renderer entrypoint for {@link TITHON_WIDGET_MIME}
 * (`application/vnd.tithon.widget+json`) — the §3.3 ipywidget renderer that runs
 * inside the notebook webview. The output item is self-contained: it carries the
 * view's `model_id` AND the daemon mirror's widget state, so html-manager can
 * instantiate the model/view with no extension-host round-trip (avoids the
 * render-before-state race). On any failure it degrades to the §3.3 text fallback.
 *
 * Live updates: the extension host pushes `tithon.widget-update` messages (comm
 * state deltas, optionally carrying binary buffers) over the renderer
 * channel; we apply them to the live model so a tqdm.notebook bar animates, or an
 * Image widget's live-updating pixels stay current. We report the render outcome
 * back so the host (and verify) can confirm html vs fallback.
 *
 * Bundled by esbuild (platform=browser, format=esm) into dist/widgetRenderer.js;
 * the render logic itself is covered under jsdom by test/widget.test.ts.
 */
import {
  createManager,
  renderWidget,
  renderFallbackText,
  type WidgetStateSnapshot,
} from "./widgetRender";
import type { WidgetBufferEntry } from "./richOutput";
import type { HTMLManager } from "@jupyter-widgets/html-manager/lib/htmlmanager";
// Injected into the webview so the rendered widgets are actually styled.
import widgetsCss from "@jupyter-widgets/controls/css/widgets.built.css";
// Must follow it: re-points the vendored light-theme text colours at the active
// VSCode theme, winning on document order (see widgetTheme.css).
import widgetThemeCss from "./widgetTheme.css";

interface OutputItem {
  id: string;
  json(): unknown;
}
interface RendererContext {
  onDidReceiveMessage?: (cb: (msg: unknown) => void) => void;
  postMessage?: (msg: unknown) => void;
}
type ActivationFunction = (context: RendererContext) => {
  renderOutputItem(item: OutputItem, element: HTMLElement): void | Promise<void>;
  disposeOutputItem?(id: string): void;
};

interface WidgetPayload {
  model_id: string;
  state: WidgetStateSnapshot;
}
interface UpdateMessage {
  type: "tithon.widget-update";
  comm_id: string;
  state: Record<string, unknown>;
  buffers?: WidgetBufferEntry[];
}

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  try {
    for (const css of [widgetsCss, widgetThemeCss]) {
      const style = document.createElement("style");
      style.textContent = css as unknown as string;
      document.head.appendChild(style);
    }
  } catch {
    /* no document.head in this host */
  }
}

export const activate: ActivationFunction = (context) => {
  injectCss();
  // Live managers by output-item id, so a comm update reaches the right widget.
  const managers = new Map<string, HTMLManager>();
  // Per (output-item, comm_id) promise chain: `set_state()` is async, so a
  // fire-and-forget call per message lets an OLDER update's promise resolve
  // AFTER a newer one — restoring stale state/buffers — whenever two
  // `tithon.widget-update` messages for the same model arrive close together.
  // Chaining off the prior promise for the SAME (item, comm_id) pair enforces
  // arrival order without blocking updates to a DIFFERENT model.
  const updateChains = new Map<string, Promise<void>>();

  context.onDidReceiveMessage?.((msg: unknown) => {
    const m = msg as UpdateMessage;
    if (!m || m.type !== "tithon.widget-update") return;
    for (const [itemId, mgr] of managers) {
      // The patch targets one comm id; managers without it are left alone.
      const withHasModel = mgr as HTMLManager & { has_model(id: string): boolean };
      if (!withHasModel.has_model(m.comm_id)) continue;
      const chainKey = `${itemId}:${m.comm_id}`;
      const prior = updateChains.get(chainKey) ?? Promise.resolve();
      const next = prior
        .then(() =>
          // Route through the manager's OWN set_state — the exact machinery
          // that already restores buffers correctly for the initial full
          // snapshot (renderWidget below). For an EXISTING model it
          // deserializes only the attributes present in `m.state` (a delta)
          // and calls the model's own set(), which merges just those keys —
          // buffer-bearing or not — leaving every other trait (including
          // buffers not mentioned in this delta) untouched. Must NOT be
          // shortcut to `model.set_state()`: that skips the deserialize step,
          // so a buffer-bearing update never reaches the model.
          mgr.set_state({
            version_major: 2,
            version_minor: 0,
            state: { [m.comm_id]: { state: m.state, buffers: m.buffers ?? [] } },
          } as unknown as Parameters<HTMLManager["set_state"]>[0]),
        )
        .then(() => {
          // Confirm the live update landed (drives the animated bar) so the host
          // (and verify) can see the live path working end-to-end.
          context.postMessage?.({ type: "tithon.widget-updated", comm_id: m.comm_id });
        })
        .catch(() => undefined);
      updateChains.set(chainKey, next);
    }
  });

  return {
    async renderOutputItem(item: OutputItem, element: HTMLElement) {
      element.replaceChildren();
      const payload = item.json() as WidgetPayload;
      const host = document.createElement("div");
      host.className = "tithon-widget-host";
      element.appendChild(host);

      let mode: "html" | "fallback" = "fallback";
      try {
        const manager = createManager();
        await renderWidget(payload.state, payload.model_id, host, manager);
        managers.set(item.id, manager);
        mode = "html";
      } catch (err) {
        renderFallbackText(payload.state, payload.model_id, host);
        const note = document.createElement("pre");
        note.textContent = `[tithon widget fallback] ${String((err as Error)?.message ?? err)}`;
        note.style.cssText = "opacity:.5;font-size:10px;margin:.25em 0 0";
        host.appendChild(note);
      }
      context.postMessage?.({ type: "tithon.widget-rendered", model_id: payload.model_id, mode });
    },
    disposeOutputItem(id: string) {
      managers.delete(id);
      for (const key of [...updateChains.keys()]) {
        if (key.startsWith(`${id}:`)) updateChains.delete(key);
      }
    },
  };
};
