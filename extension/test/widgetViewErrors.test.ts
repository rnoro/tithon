// @vitest-environment jsdom
import * as base from "@jupyter-widgets/base";
import { expect, it, vi } from "vitest";
import { createManager } from "../src/widgetRender";

it.each([false, true])(
  "preserves the original error when a widget view fails to render (async=%s)",
  async (asyncFailure) => {
    const manager = createManager();
    const original = new Error("view rendering failed");
    class BrokenView extends base.DOMWidgetView {
      render(): any {
        if (asyncFailure) return Promise.reject(original);
        throw original;
      }
    }
    (manager as any).loadViewClass = vi.fn().mockResolvedValue(BrokenView);
    const model = new base.DOMWidgetModel(
      { _view_name: "BrokenView", _view_module: "broken", _view_module_version: "1.0.0" },
      { widget_manager: manager, model_id: "broken" },
    );
    const view = await manager.create_view(model);
    expect(view.el.querySelector(".jupyter-widgets-error-widget")).not.toBeNull();
    expect(view.model.get("error")).toBe(original);
    view.remove();
  },
);

it("preserves a rejected view error when displaying it", async () => {
  const manager = createManager();
  const host = document.createElement("div");
  document.body.append(host);
  const original = new Error("view promise failed");
  try {
    await manager.display_view(Promise.reject(original), host);
    const error = host.querySelector(".jupyter-widgets-error-widget");
    expect(error).not.toBeNull();
    (error!.parentElement as HTMLElement).click();
    expect(host.textContent).toContain("view promise failed");
  } finally {
    host.remove();
  }
});
