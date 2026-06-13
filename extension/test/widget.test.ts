// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  renderWidget,
  renderWidgetView,
  renderFallbackText,
  findModelId,
  type WidgetStateSnapshot,
} from "../src/widgetRender";

const FIXTURE = join(__dirname, "fixtures", "tqdm_widget_state.json");

function loadSnapshot(): WidgetStateSnapshot {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

describe("widget render — html-manager renders the mirror snapshot", () => {
  it("the fixture is a real mirror snapshot with a completed FloatProgress", () => {
    const snap = loadSnapshot();
    expect(snap.version_major).toBe(2);
    const id = findModelId(snap, "FloatProgressModel");
    expect(id).toBeDefined();
    const st = snap.state[id!].state as any;
    // captured after tqdm.notebook(range(50000)) completed: value == total.
    expect(st.value).toBe(50000);
    expect(st.max).toBe(50000);
  });

  it("renders FloatProgress to a progress bar at 100% width (value == max)", async () => {
    const snap = loadSnapshot();
    const id = findModelId(snap, "FloatProgressModel")!;

    const host = document.createElement("div");
    document.body.appendChild(host); // Lumino attach needs a connected host

    await renderWidget(snap, id, host);

    const bar = host.querySelector(".progress-bar") as HTMLElement | null;
    expect(bar, "progress-bar element should be rendered").not.toBeNull();
    // value(50000) of max(50000) => 100% bar width.
    expect(bar!.style.width).toBe("100%");
  });

  it("renders the full tqdm HBox container without throwing", async () => {
    const snap = loadSnapshot();
    const id = findModelId(snap, "HBoxModel")!;

    const host = document.createElement("div");
    document.body.appendChild(host);

    // Rendering the container instantiates the whole widget tree (bar + labels);
    // a successful render with a nested progress bar is the end-to-end proof.
    // BoxView renders its children asynchronously, so poll for the nested bar.
    await renderWidget(snap, id, host);
    const ok = await waitFor(() => host.querySelector(".progress-bar") !== null);
    expect(ok, "nested progress-bar should render inside the HBox").toBe(true);
    const bar = host.querySelector(".progress-bar") as HTMLElement;
    expect(bar.style.width).toBe("100%");
  });

  it("renderWidgetView returns 'html' for the live renderer path", async () => {
    const snap = loadSnapshot();
    const id = findModelId(snap, "FloatProgressModel")!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const mode = await renderWidgetView(snap, { model_id: id }, host);
    expect(mode).toBe("html");
    expect(host.querySelector(".progress-bar")).not.toBeNull();
  });

  it("fallback (design §3.3) renders the final state as text (value/max)", () => {
    const snap = loadSnapshot();
    const id = findModelId(snap, "FloatProgressModel")!;
    const host = document.createElement("div");
    const text = renderFallbackText(snap, id, host);
    expect(text).toBe("50000/50000");
    expect(host.querySelector(".tithon-widget-fallback")?.textContent).toBe("50000/50000");
  });
});
