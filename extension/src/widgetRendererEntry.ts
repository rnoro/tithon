/**
 * VSCode notebook renderer entrypoint for
 * `application/vnd.jupyter.widget-view+json` (design.md §3.3). Instantiates
 * models/views with @jupyter-widgets/html-manager via the shared render logic,
 * falling back to a text rendering of the widget's final state on error.
 *
 * The widget *state* (the daemon mirror snapshot) is pushed from the extension
 * host over the renderer messaging channel; this entry caches it and renders the
 * referenced model. Not unit-tested here (needs the VSCode renderer host); the
 * render logic itself is covered under jsdom by test/widget.test.ts.
 */
import { renderWidgetView, type WidgetStateSnapshot } from "./widgetRender";

// Minimal shape of the VSCode notebook-renderer API we use (the real types ship
// with @vscode/test-electron's renderer host, unavailable in this environment).
interface OutputItem {
  json(): unknown;
}
interface RendererContext {
  onDidReceiveMessage?: (cb: (msg: unknown) => void) => void;
  postMessage?: (msg: unknown) => void;
}
type ActivationFunction = (context: RendererContext) => {
  renderOutputItem(item: OutputItem, element: HTMLElement): void | Promise<void>;
};

interface WidgetStateMessage {
  type: "tithon.widget-state";
  snapshot: WidgetStateSnapshot;
}

export const activate: ActivationFunction = (context) => {
  let snapshot: WidgetStateSnapshot | undefined;

  if (context.onDidReceiveMessage) {
    context.onDidReceiveMessage((msg: unknown) => {
      const m = msg as WidgetStateMessage;
      if (m && m.type === "tithon.widget-state") snapshot = m.snapshot;
    });
  }

  return {
    async renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
      element.replaceChildren();
      const view = outputItem.json() as { model_id: string };
      if (!snapshot) {
        const p = document.createElement("pre");
        p.textContent = `[tithon] widget ${view.model_id} (awaiting state from daemon)`;
        element.appendChild(p);
        return;
      }
      const host = document.createElement("div");
      element.appendChild(host);
      await renderWidgetView(snapshot, view, host);
    },
  };
};
