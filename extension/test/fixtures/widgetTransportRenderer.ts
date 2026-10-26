/** Test-only DOM driver wrapping the production renderer in a disposable extension. */
import { activate as production } from "../../src/widgetRendererEntry";

export const activate = (context: any) => {
  const renderer = production(context);
  const hosts = new Map<string, HTMLElement>();
  context.onDidReceiveMessage((message: any) => {
    if (message.type !== "test.widget-action") return;
    try {
      const host = hosts.get(message.model);
      if (!host) throw new Error(`No rendered view for ${message.model}`);
      if (message.action === "click") host.querySelector<HTMLButtonElement>("button")?.click();
      if (message.action === "key") {
        const handle = host.querySelector(".noUi-handle");
        if (!handle) throw new Error("No slider handle");
        handle.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39, bubbles: true, cancelable: true}));
      }
      if (message.action === "text") {
        const input = host.querySelector<HTMLInputElement>("input")!;
        input.value = message.value; input.dispatchEvent(new Event("input", {bubbles: true}));
      }
      if (message.action === "dropdown") {
        const input = host.querySelector<HTMLSelectElement>("select")!;
        input.value = message.value; input.dispatchEvent(new Event("change", {bubbles: true}));
      }
      context.postMessage({type: "test.widget-done", id: message.id,
        text: host.textContent, disabled: host.querySelector<HTMLButtonElement>("button")?.disabled,
        interactive: host.isConnected && !!host.querySelector("button:not([disabled])")});
    } catch (error) { context.postMessage({type: "test.widget-error", id: message.id, error: String(error)}); }
  });
  return { ...renderer, async renderOutputItem(item: any, element: HTMLElement) {
    await renderer.renderOutputItem(item, element);
    hosts.set(item.json().model_id, element);
    context.postMessage({type: "test.widget-ready", model: item.json().model_id});
  }};
};
