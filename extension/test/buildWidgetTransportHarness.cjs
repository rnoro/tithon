const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const widgetModules = require("../widgetModules.cjs");
const target = process.argv[2];
if (!target) throw new Error("Disposable extension directory required");
for (const name of ["dist", "out-int"])
  fs.cpSync(path.join(__dirname, "..", name), path.join(target, name), { recursive: true });
fs.symlinkSync(
  path.resolve(__dirname, "../node_modules"),
  path.join(target, "node_modules"),
  "dir",
);
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json")));
manifest.contributes.notebookRenderer.find((r) => r.id === "tithon-widget").entrypoint =
  "./dist/widgetTransportHarness.js";
fs.writeFileSync(path.join(target, "package.json"), JSON.stringify(manifest));
esbuild
  .build({
    entryPoints: [path.join(__dirname, "fixtures/widgetTransportRenderer.ts")],
    outfile: path.join(target, "dist/widgetTransportHarness.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    plugins: [widgetModules.esbuildPlugin()],
    target: "es2020",
    loader: {
      ".css": "text",
      ".svg": "text",
      ".eot": "empty",
      ".ttf": "empty",
      ".woff": "empty",
      ".woff2": "empty",
    },
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
