/**
 * Bundle the extension for packaging so the .vsix is SELF-CONTAINED — no runtime
 * node_modules. The previous `vsce package --no-dependencies` shipped raw tsc
 * output that did `require("ws")`, which is absent from the vsix, so the
 * extension failed to activate ("Cannot open resource with notebook editor type
 * 'tithon-py'"). Bundling inlines `ws` (and everything else) into one file.
 *
 * Run by `vscode:prepublish` (vsce calls it before packaging) and by `npm run
 * bundle`. The dev/verify path still uses plain `tsc -p ./` (node_modules
 * present), so this only matters for the shipped artifact.
 */
import * as esbuild from "esbuild";

// Extension host (Node): inline ws; keep `vscode` and ws's optional native
// addons external (ws require()s them in a try/catch).
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

// NOTE: the ipywidget renderer (widgetRendererEntry + @jupyter-widgets) is NOT
// bundled/shipped. It's unverified in real VSCode (jsdom-only) and would add
// ~3MB; none of the verified output paths (stdout/stream/result/error/image)
// use it. The source is kept; re-enable here + restore the `notebookRenderer`
// contribution when ipywidget rendering is actually verified in a real host.
