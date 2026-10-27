/**
 * Notebook widget entrypoint: self-contained snapshots bootstrap each view.
 * Active models use shared classic comms (see LiveWidgetRenderer); saved and
 * legacy display models receive scoped state deltas with a text fallback.
 */

// Injected into the webview so the rendered widgets are actually styled.
import widgetsCss from "@jupyter-widgets/controls/css/widgets.built.css";
import type { HTMLManager } from "@jupyter-widgets/html-manager/lib/htmlmanager";
import { LiveWidgetRenderer } from "./liveWidgetRenderer";
import type { WidgetBufferEntry, WidgetScope } from "./richOutput";
import {
  createManager,
  renderFallbackText,
  renderWidget,
  type WidgetStateSnapshot,
} from "./widgetRender";
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
  scope?: WidgetScope;
  live?: boolean;
}
interface UpdateMessage {
  type: "tithon.widget-update";
  comm_id: string;
  state: Record<string, unknown>;
  buffers?: WidgetBufferEntry[];
  scope?: WidgetScope;
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
  const live = new LiveWidgetRenderer((message) => context.postMessage?.(message));
  const managers = new Map<
    string,
    { manager: HTMLManager; scope?: WidgetScope; active: boolean }
  >();
  const updateChains = new Map<string, Promise<void>>();
  // Revocation also covers outputs mounted after their connection/kernel ended.
  // Library work already in flight may finish on its historical host.
  const revokedBindings = new Set<string>();
  const bindingKey = (scope: { session?: string; binding?: string }) =>
    JSON.stringify([scope.session, scope.binding]);
  const sameScope = (a?: WidgetScope, b?: WidgetScope) =>
    a?.session === b?.session && a?.kernel_id === b?.kernel_id && a?.binding === b?.binding;

  const invalidateItem = (id: string) => {
    const entry = managers.get(id);
    if (entry) entry.active = false;
    managers.delete(id);
    for (const key of updateChains.keys()) {
      if (key.startsWith(`${id}\u0000`)) updateChains.delete(key);
    }
  };

  context.onDidReceiveMessage?.((msg: unknown) => {
    live.receive(msg);
    const invalidation = msg as { type?: string; session?: string; binding?: string };
    if (invalidation?.type === "tithon.widget-invalidate") {
      revokedBindings.add(bindingKey(invalidation));
      live.invalidate(invalidation);
      for (const [id, entry] of managers) {
        if (
          entry.scope?.session === invalidation.session &&
          entry.scope?.binding === invalidation.binding
        ) {
          invalidateItem(id);
        }
      }
      return;
    }
    const m = msg as UpdateMessage;
    if (m?.type !== "tithon.widget-update") return;
    for (const [itemId, entry] of managers) {
      if (!entry.active || !sameScope(entry.scope, m.scope)) continue;
      const mgr = entry.manager;
      if (!(mgr as HTMLManager & { has_model(id: string): boolean }).has_model(m.comm_id)) continue;
      const chainKey = `${itemId}\u0000${m.comm_id}`;
      const prior = updateChains.get(chainKey) ?? Promise.resolve();
      const next = prior
        .then(async () => {
          if (!entry.active || managers.get(itemId) !== entry) return;
          // Manager deserialization restores binary buffers before merging traits.
          await mgr.set_state({
            version_major: 2,
            version_minor: 0,
            state: { [m.comm_id]: { state: m.state, buffers: m.buffers ?? [] } },
          } as unknown as Parameters<HTMLManager["set_state"]>[0]);
          if (entry.active && managers.get(itemId) === entry) {
            context.postMessage?.({
              type: "tithon.widget-updated",
              comm_id: m.comm_id,
              scope: entry.scope,
            });
          }
        })
        .catch(() => undefined);
      updateChains.set(chainKey, next);
      void next.finally(() => {
        if (updateChains.get(chainKey) === next) updateChains.delete(chainKey);
      });
    }
  });

  return {
    async renderOutputItem(item: OutputItem, element: HTMLElement) {
      invalidateItem(item.id);
      live.dispose(item.id);
      element.replaceChildren();
      const payload = item.json() as WidgetPayload;
      const host = document.createElement("div");
      host.className = "tithon-widget-host";
      element.appendChild(host);

      if (payload.live && payload.scope && !context.postMessage) {
        renderFallbackText(payload.state, payload.model_id, host);
        return;
      }
      if (payload.live && payload.scope) {
        try {
          await live.render(item.id, { ...payload, scope: payload.scope }, host);
        } catch {
          live.dispose(item.id);
          renderFallbackText(payload.state, payload.model_id, host);
        }
        return;
      }
      let mode: "html" | "fallback" = "fallback";
      const manager = createManager();
      const entry = {
        manager,
        scope: payload.scope,
        active: !payload.scope || !revokedBindings.has(bindingKey(payload.scope)),
      };
      managers.set(item.id, entry);
      try {
        await renderWidget(payload.state, payload.model_id, host, manager);
        if (!entry.active || managers.get(item.id) !== entry) return;
        mode = "html";
      } catch (err) {
        if (!entry.active || managers.get(item.id) !== entry) return;
        invalidateItem(item.id);
        renderFallbackText(payload.state, payload.model_id, host);
        const note = document.createElement("pre");
        note.textContent = `[tithon widget fallback] ${String((err as Error)?.message ?? err)}`;
        note.style.cssText = "opacity:.5;font-size:10px;margin:.25em 0 0";
        host.appendChild(note);
      }
      context.postMessage?.({
        type: "tithon.widget-rendered",
        model_id: payload.model_id,
        mode,
        scope: payload.scope,
      });
    },
    disposeOutputItem(id: string) {
      live.dispose(id);
      invalidateItem(id);
    },
  };
};
