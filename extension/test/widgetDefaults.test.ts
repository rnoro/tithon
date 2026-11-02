// @vitest-environment jsdom

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as base from "@jupyter-widgets/base";
import * as controls from "@jupyter-widgets/controls";
import { describe, expect, it } from "vitest";
import { createManager, renderWidget, type WidgetStateSnapshot } from "../src/widgetRender";

// The daemon omits saved widget traits equal to these defaults and restores
// them on read, so the table must be exactly what the bundled renderer fills
// in for a missing trait. Regenerate with TITHON_UPDATE_WIDGET_DEFAULTS=1.
const TABLE = join(__dirname, "..", "..", "src", "tithon", "widget_defaults.json");

function bundledDefaults() {
  const models: Record<string, Record<string, unknown>> = {};
  const versions: Record<string, string> = {};
  for (const module of [base, controls] as Record<string, unknown>[]) {
    for (const [name, value] of Object.entries(module)) {
      if (!name.endsWith("Model") || typeof value !== "function") continue;
      const proto = (value as { prototype: { defaults?: () => Record<string, unknown> } })
        .prototype;
      if (typeof proto.defaults !== "function") continue;
      const defaults = proto.defaults.call(proto);
      const modelModule = defaults._model_module;
      const modelName = defaults._model_name;
      const version = defaults._model_module_version;
      if (typeof modelModule !== "string" || typeof modelName !== "string") continue;
      if (typeof version !== "string") continue;
      // JSON round-trip drops undefined and anything a saved state cannot hold.
      const json = JSON.parse(JSON.stringify(defaults));
      const key = `${modelModule}/${modelName}`;
      // The manager resolves a model class by its export name, so only the
      // export the name refers to supplies that model's missing traits.
      if (name !== modelName) continue;
      models[key] = json;
      versions[modelModule] = version;
    }
  }
  const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)));
  return { model_module_versions: versions, models: sorted };
}

describe("saved widget default table", () => {
  it("matches the bundled @jupyter-widgets model defaults", () => {
    const generated = `${JSON.stringify(bundledDefaults(), null, 1)}\n`;
    if (process.env.TITHON_UPDATE_WIDGET_DEFAULTS === "1") writeFileSync(TABLE, generated);
    const table = JSON.parse(readFileSync(TABLE, "utf8"));
    expect(table).toEqual(JSON.parse(generated));
    expect(table.models["@jupyter-widgets/base/LayoutModel"]).toBeDefined();
    expect(table.models["@jupyter-widgets/controls/FloatProgressModel"]).toBeDefined();
  });
});

// The daemon writes this compacted form (test_widget_save_state.py keeps the
// fixture in sync with `sidecar.compact_widgets`); omission is only sound if
// the renderer reconstructs exactly the same models and DOM from it.
describe("compacted saved widget state", () => {
  const load = (name: string): WidgetStateSnapshot =>
    JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

  it("renders models and DOM identical to the full state", async () => {
    const full = load("tqdm_widget_state.json");
    const compact = load("tqdm_widget_state.compact.json");
    expect(JSON.stringify(compact).length * 3).toBeLessThan(JSON.stringify(full).length);
    const root = "0552c8589ebe4644a9ecce646ea6e147";
    const rendered: { html: string; states: unknown }[] = [];
    for (const snapshot of [full, compact]) {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const manager = await renderWidget(snapshot, root, host, createManager());
      for (let i = 0; i < 100 && !host.querySelector(".progress-bar"); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      // The manager's own serialization: every trait of every model, with
      // model references as `IPY_MODEL_<id>` strings.
      const { state: states } = await manager.get_state();
      rendered.push({ html: host.innerHTML.replace(/ id="[^"]*"/g, ""), states });
    }
    expect(rendered[0].html).toContain("progress-bar");
    expect(rendered[1].states).toEqual(rendered[0].states);
    expect(rendered[1].html).toEqual(rendered[0].html);
  });
});
