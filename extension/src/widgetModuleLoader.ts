import * as base from "@jupyter-widgets/base";
import * as controls from "@jupyter-widgets/controls";
import { satisfies, valid } from "semver";
import type { WidgetScope } from "./richOutput";

type InstalledModule = { name: string; version: string; source: string };

/** Load classic AMD bundles for the current trusted kernel connection. */
export class WidgetModuleLoader {
  private readonly pending = new Map<
    string,
    {
      resolve: (module: InstalledModule) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly cache = new Map<string, Promise<any>>();
  private readonly resolved = new Map<string, { source: string; module: Promise<any> }>();
  private active = true;

  constructor(
    private readonly scope: WidgetScope,
    private readonly post: (message: unknown) => void,
  ) {}

  receive(message: any): void {
    if (message?.type !== "tithon.widget-module-result") return;
    const scope = message.scope;
    if (
      scope?.session !== this.scope.session ||
      scope?.kernel_id !== this.scope.kernel_id ||
      scope?.binding !== this.scope.binding
    )
      return;
    const pending = this.pending.get(message.request_id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.request_id);
    if (message.module) pending.resolve(message.module);
    else pending.reject(new Error(message.error || "Widget module is unavailable"));
  }

  load(name: string, version: string): Promise<any> {
    if (!this.active) return Promise.reject(new Error("Widget connection ended"));
    const key = JSON.stringify([name, version]);
    const existing = this.cache.get(key);
    if (existing) return existing;
    const load = this.request(name, version).then(async (module) => {
      if (!this.active) throw new Error("Widget connection ended");
      if (module.name !== name || !satisfies(module.version, version))
        throw new Error(`Widget module version does not satisfy ${name}@${version}`);
      const resolvedKey = JSON.stringify([name, module.version]);
      const prior = this.resolved.get(resolvedKey);
      if (prior) {
        if (prior.source !== module.source) throw new Error(`Widget module changed: ${name}`);
        return prior.module;
      }
      const loaded = this.importAmd(module.source).then((value) => {
        const actualVersion = value?.MODULE_NAME === name ? value?.MODULE_VERSION : value?.version;
        if (
          typeof actualVersion !== "string" ||
          !valid(actualVersion) ||
          actualVersion !== module.version
        )
          throw new Error(
            `Widget bundle version is unavailable or mismatched: ${name} (bundle ${String(actualVersion)}, module ${String(value?.MODULE_NAME)}, metadata ${module.version})`,
          );
        return value;
      });
      this.resolved.set(resolvedKey, { source: module.source, module: loaded });
      void loaded.catch(() => {
        if (this.resolved.get(resolvedKey)?.module === loaded) this.resolved.delete(resolvedKey);
      });
      return loaded;
    });
    this.cache.set(key, load);
    void load.catch(() => {
      if (this.cache.get(key) === load) this.cache.delete(key);
    });
    return load;
  }

  private request(name: string, version: string): Promise<InstalledModule> {
    if (this.pending.size >= 16) return Promise.reject(new Error("Too many widget modules"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Widget module ${name} timed out`));
      }, 30000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.post({
        type: "tithon.widget-load-module",
        scope: this.scope,
        request_id: requestId,
        module_name: name,
        module_version: version,
      });
    });
  }

  private async importAmd(source: string): Promise<any> {
    let exports: any;
    let defined = false;
    const define = (...args: any[]) => {
      if (!this.active) throw new Error("Widget connection ended");
      if (defined) throw new Error("Widget bundle defines more than one module");
      if (typeof args[0] === "string") args.shift();
      const [dependencies, factory] = args;
      if (!Array.isArray(dependencies) || typeof factory !== "function")
        throw new Error("Unsupported widget bundle format");
      const modules = dependencies.map((dependency: string) => {
        if (dependency === "@jupyter-widgets/base") return base;
        if (dependency === "@jupyter-widgets/controls") return controls;
        throw new Error(`Unsupported widget dependency ${dependency}`);
      });
      defined = true;
      exports = factory(...modules);
    };
    Object.assign(define, { amd: {}, tithonActive: () => this.active });
    const slot = `__tithon_widget_${crypto.randomUUID().replace(/-/g, "")}`;
    (globalThis as any)[slot] = define;
    const url = URL.createObjectURL(
      new Blob(
        [
          `const define = globalThis[${JSON.stringify(slot)}];\nif (!define?.tithonActive()) throw new Error("Widget connection ended");\n`,
          source,
          "\n",
        ],
        {
          type: "text/javascript",
        },
      ),
    );
    try {
      await import(/* @vite-ignore */ url);
      if (!this.active || !defined) throw new Error("Widget module could not be loaded");
      return exports;
    } finally {
      URL.revokeObjectURL(url);
      delete (globalThis as any)[slot];
    }
  }

  dispose(): void {
    this.active = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Widget connection ended"));
    }
    this.pending.clear();
    this.cache.clear();
    this.resolved.clear();
  }
}
