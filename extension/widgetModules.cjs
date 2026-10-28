const fs = require("node:fs");
const path = require("node:path");

const moduleId = "tithon:anywidget";
const virtualId = `\0${moduleId}`;

function anywidgetSource() {
  const source = fs.readFileSync(
    path.join(__dirname, "node_modules/anywidget/dist/index.js"),
    "utf8",
  );
  return `import * as base from "@jupyter-widgets/base";
let exports;
function define(dependencies, factory) {
  if (dependencies.length !== 1 || dependencies[0] !== "@jupyter-widgets/base") {
    throw new Error("Unsupported anywidget module dependencies");
  }
  exports = factory(base);
}
${source}
export default exports;
`;
}

function esbuildPlugin() {
  return {
    name: "tithon-widget-modules",
    setup(build) {
      build.onResolve({ filter: /^tithon:anywidget$/ }, () => ({
        path: moduleId,
        namespace: "tithon-widget",
      }));
      build.onLoad({ filter: /.*/, namespace: "tithon-widget" }, () => ({
        contents: anywidgetSource(),
        loader: "js",
        resolveDir: __dirname,
      }));
    },
  };
}

function vitePlugin() {
  return {
    name: "tithon-widget-modules",
    resolveId(id) {
      return id === moduleId ? virtualId : undefined;
    },
    load(id) {
      return id === virtualId ? anywidgetSource() : undefined;
    },
  };
}

module.exports = { esbuildPlugin, vitePlugin };
