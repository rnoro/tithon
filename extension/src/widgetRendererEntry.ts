/**
 * VSCode notebook renderer entrypoint for {@link TITHON_WIDGET_MIME}
 * (`application/vnd.tithon.widget+json`) — the §3.3 ipywidget renderer that runs
 * inside the notebook webview. The output item is self-contained: it carries the
 * view's `model_id` AND the daemon mirror's widget state, so html-manager can
 * instantiate the model/view with no extension-host round-trip (avoids the
 * render-before-state race). On any failure it degrades to the §3.3 text fallback.
 *
 * Live updates: the extension host pushes `tithon.widget-update` messages (comm
 * state deltas) over the renderer channel; we apply them to the live model so a
 * tqdm.notebook bar animates. We report the render outcome back so the host (and
 * verify) can confirm html vs fallback.
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
import type { HTMLManager } from "@jupyter-widgets/html-manager/lib/htmlmanager";
// Injected into the webview so the rendered widgets are actually styled.
import widgetsCss from "@jupyter-widgets/controls/css/widgets.built.css";

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
}

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  try {
    const style = document.createElement("style");
    style.textContent = widgetsCss as unknown as string;
    document.head.appendChild(style);
  } catch {
    /* no document.head in this host */
  }
}

export const activate: ActivationFunction = (context) => {
  injectCss();
  // Live managers by output-item id, so a comm update reaches the right widget.
  const managers = new Map<string, HTMLManager>();

  context.onDidReceiveMessage?.((msg: unknown) => {
    const m = msg as UpdateMessage;
    if (!m || m.type !== "tithon.widget-update") return;
    for (const mgr of managers.values()) {
      // The patch targets one comm id; managers without it resolve to undefined.
      void mgr
        .get_model(m.comm_id)
        .then((model) => {
          if (!model) return;
          (model as unknown as { set_state(s: unknown): void }).set_state(m.state);
          // Confirm the live update landed (drives the animated bar) so the host
          // (and verify) can see the live path working end-to-end.
          context.postMessage?.({ type: "tithon.widget-updated", comm_id: m.comm_id });
        })
        .catch(() => undefined);
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
    },
  };
};
