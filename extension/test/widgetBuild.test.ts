import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";
import { expect, it } from "vitest";
import widgetModules from "../widgetModules.cjs";

it("fails the renderer build when expected manager patch sites are absent", async () => {
  await expect(
    esbuild.build({
      stdin: { contents: "export default 1", loader: "js" },
      bundle: true,
      write: false,
      logLevel: "silent",
      plugins: [widgetModules.esbuildPlugin()],
    }),
  ).rejects.toThrow("Widget error model patch missing");
});

it("patches each pinned manager construction and rejects a changed target", async () => {
  const temp = mkdtempSync(join(tmpdir(), "tithon-widget-build-"));
  const names = ["base-manager/lib/manager-base.js", "html-manager/lib/htmlmanager.js"];
  try {
    const entries = names.map((name) => {
      const relative = join("node_modules", "@jupyter-widgets", name);
      const destination = join(temp, relative);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(join(process.cwd(), relative)));
      return destination;
    });
    const build = () =>
      esbuild.build({
        entryPoints: entries,
        outdir: join(temp, "out"),
        bundle: false,
        write: false,
        logLevel: "silent",
        plugins: [widgetModules.esbuildPlugin()],
      });
    const output = (await build()).outputFiles.map((file) => file.text).join("\n");
    expect(output).toContain("model_id: model.model_id");
    expect(output).toContain("model_id: crypto.randomUUID()");
    expect(output).toMatch(/widget_manager: this, model_id[ },]/);
    const changed = readFileSync(entries[0], "utf8").replace("const widget_model = new Cls();", "");
    writeFileSync(entries[0], changed);
    await expect(build()).rejects.toThrow("Unexpected base-manager error model construction");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
