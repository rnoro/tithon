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

// Error models require manager options in the renderer's strict JavaScript bundle.
function repairErrorModels(source, manager) {
  const replacements =
    manager === "base-manager"
      ? [
          [
            "const errorModel = new ModelCls();",
            "const errorModel = new ModelCls({}, { widget_manager: this, model_id: model.model_id });",
          ],
          [
            "const widget_model = new Cls();",
            "const widget_model = new Cls({}, { widget_manager: this, model_id });",
          ],
        ]
      : [
          [
            "const errorModel = new ModelCls();",
            "const errorModel = new ModelCls({}, { widget_manager: this, model_id: crypto.randomUUID() });",
          ],
        ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) {
      throw new Error(`Unexpected ${manager} error model construction`);
    }
    source = source.replace(before, after);
  }
  return source;
}

function esbuildPlugin() {
  return {
    name: "tithon-widget-modules",
    setup(build) {
      const patched = new Set();
      build.onLoad(
        {
          filter:
            /[\\/]@jupyter-widgets[\\/](base-manager|html-manager)[\\/]lib[\\/](manager-base|htmlmanager)\.js$/,
        },
        (args) => {
          const manager = args.path.includes(`${path.sep}base-manager${path.sep}`)
            ? "base-manager"
            : "html-manager";
          const contents = repairErrorModels(fs.readFileSync(args.path, "utf8"), manager);
          patched.add(manager);
          return {
            contents,
            loader: "js",
            resolveDir: path.dirname(args.path),
          };
        },
      );
      build.onEnd(() => {
        const missing = ["base-manager", "html-manager"].filter((manager) => !patched.has(manager));
        if (missing.length)
          return { errors: [{ text: `Widget error model patch missing: ${missing.join(", ")}` }] };
      });
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
