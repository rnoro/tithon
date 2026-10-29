/** Test-only DOM driver wrapping the production renderer in a disposable extension. */
import { activate as production } from "../../src/widgetRendererEntry";
import * as controls from "@jupyter-widgets/controls";
import { createManager } from "../../src/widgetRender";

const originalButtonRender = controls.ButtonView.prototype.render;
const originalButtonInitialize = controls.ButtonModel.prototype.initialize;
controls.ButtonModel.prototype.initialize = function (...args: any[]) {
  if (args[1]?.model_id === "throwing-model") throw new Error("intentional model failure");
  return originalButtonInitialize.apply(this, args as any);
};
controls.ButtonView.prototype.render = function (...args: any[]) {
  if (this.model.model_id === "throwing-button") throw new Error("intentional view failure");
  return originalButtonRender.apply(this, args as []);
};

export const activate = (context: any) => {
  const originalError = console.error.bind(console);
  console.error = (...args: any[]) => {
    context.postMessage({ type: "test.widget-console", text: args.map((arg) => String(arg?.stack ?? arg)).join(" ") });
    originalError(...args);
  };
  const renderer = production(context);
  const hosts = new Map<string, HTMLElement>();
  context.onDidReceiveMessage(async (message: any) => {
    if (message.type !== "test.widget-action") return;
    try {
      const host = hosts.get(message.model);
      if (!host) throw new Error(`No rendered view for ${message.model}`);
      const available = !host.querySelector<HTMLElement>(".tithon-widget-host")?.inert;
      if (!["inspect", "debugDump", "debugError"].includes(message.action) && !available) {
        context.postMessage({type: "test.widget-done", id: message.id, blocked: true});
        return;
      }
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
      if (message.action === "check") {
        const input = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        input.click();
      }
      if (message.action === "brush") {
        const overlay = host.querySelector<SVGElement>("rect.overlay");
        if (!overlay) throw new Error("No brush overlay");
        const rect = overlay.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) throw new Error("Brush has no visible area");
        const x = rect.left + rect.width * 0.25;
        const y = rect.top + rect.height * 0.5;
        overlay.dispatchEvent(new MouseEvent("mousedown", {view: window, bubbles: true, button: 0, buttons: 1, clientX: x, clientY: y}));
        window.dispatchEvent(new MouseEvent("mousemove", {view: window, bubbles: true, buttons: 1, clientX: x + rect.width * 0.4, clientY: y}));
        window.dispatchEvent(new MouseEvent("mouseup", {view: window, bubbles: true, button: 0, clientX: x + rect.width * 0.4, clientY: y}));
      }
      if (message.action === "orbit") {
        const canvas = host.querySelector<HTMLCanvasElement>("canvas");
        if (!canvas) throw new Error("No 3D canvas");
        const rect = canvas.getBoundingClientRect();
        const x = rect.left + rect.width * 0.5;
        const y = rect.top + rect.height * 0.5;
        canvas.dispatchEvent(new MouseEvent("mousedown", {view: window, bubbles: true, button: 0, buttons: 1, clientX: x, clientY: y}));
        document.dispatchEvent(new MouseEvent("mousemove", {view: window, bubbles: true, buttons: 1, clientX: x + 50, clientY: y + 20}));
        document.dispatchEvent(new MouseEvent("mouseup", {view: window, bubbles: true, button: 0, clientX: x + 50, clientY: y + 20}));
      }
      if (message.action === "displayError") {
        await createManager().display_view(Promise.reject(new Error("intentional display failure")), host);
      }
      if (message.action === "debugError") {
        for (const item of host.querySelectorAll(".jupyter-widgets-error-widget")) {
          (item.parentElement as HTMLElement | null)?.click();
        }
      }
      context.postMessage({type: "test.widget-done", id: message.id,
        text: host.textContent, disabled: host.querySelector<HTMLButtonElement>("button")?.disabled,
        checked: host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
        anyCreated: (globalThis as any).__tithonAnyCreated || 0,
        anyDestroyed: (globalThis as any).__tithonAnyDestroyed || 0,
        svgCount: host.querySelectorAll("svg").length,
        canvasCount: host.querySelectorAll("canvas").length,
        canvasWidth: host.querySelector<HTMLCanvasElement>("canvas")?.width,
        canvasStyleWidth: host.querySelector<HTMLCanvasElement>("canvas")?.style.width,
        statusAccessible: !!host.querySelector('[role="status"]:not([inert] *)'),
        html: message.action === "debugDump" ? host.innerHTML.slice(0, 4000) : undefined,
        errorCount: host.querySelectorAll(".jupyter-widgets-error-widget").length,
        available, interactive: available && host.isConnected && !!host.querySelector("button:not([disabled])")});
    } catch (error) { context.postMessage({type: "test.widget-error", id: message.id, error: String(error)}); }
  });
  return { ...renderer, async renderOutputItem(item: any, element: HTMLElement) {
    await renderer.renderOutputItem(item, element);
    hosts.set(item.json().model_id, element);
    context.postMessage({type: "test.widget-ready", model: item.json().model_id});
  }};
};
