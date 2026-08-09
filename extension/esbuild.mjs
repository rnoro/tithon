/**
 * Bundle the extension for packaging so the .vsix is SELF-CONTAINED — no runtime
 * node_modules. The previous `vsce package --no-dependencies` shipped raw tsc
 * output that did `require("ws")`, which is absent from the vsix, so the
 * extension failed to activate ("Cannot open resource with notebook editor type
 * 'tithon-py'"). Bundling inlines `ws` (and everything else) into one file.
 *
 * Run by `vscode:prepublish` (vsce calls it before packaging) and by `npm run
 * bundle`. The dev/verify path runs the extension HOST from plain `tsc -p ./`
 * output (node_modules present), so that half only matters for the shipped
 * artifact — but the renderer half does not: `dist/widgetRenderer.js` has no tsc
 * equivalent, so the verify path builds it here too.
 *
 * `node esbuild.mjs` builds both; `node esbuild.mjs renderer` builds only the
 * renderer. scripts/lib.sh wants the second form — rebuilding the extension host
 * would replace the `dist/extension.js` tsc just emitted.
 */
import * as esbuild from "esbuild";

const rendererOnly = process.argv[2] === "renderer";

// Extension host (Node): inline ws; keep `vscode` and ws's optional native
// addons external (ws require()s them in a try/catch).
if (!rendererOnly) {
  await esbuild.build({
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode", "bufferutil", "utf-8-validate"],
    logLevel: "info",
  });
}

// ipywidget renderer (SPEC.md): runs INSIDE the notebook webview, so it
// must be a self-contained browser ESM bundle (it cannot require @jupyter-widgets
// from node_modules there). ~3MB with html-manager + base + controls + the
// ipywidgets CSS (inlined as text and injected into the webview). Loaded via the
// `notebookRenderer` contribution; verified in a real host by scripts/v29.
await esbuild.build({
  entryPoints: ["src/widgetRendererEntry.ts"],
  outfile: "dist/widgetRenderer.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2020",
  loader: {
    ".css": "text", // injected as a <style> by the renderer entry
    ".svg": "text",
    ".eot": "empty",
    ".ttf": "empty",
    ".woff": "empty",
    ".woff2": "empty",
  },
  logLevel: "info",
});
