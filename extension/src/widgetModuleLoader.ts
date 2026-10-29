import * as base from "@jupyter-widgets/base";
import * as controls from "@jupyter-widgets/controls";
import { satisfies, valid } from "semver";
import type { WidgetScope } from "./richOutput";

type InstalledModule = {
  name: string;
  version: string;
  source: string;
  dependencies?: Record<string, string>;
};

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
  private readonly dependencyCache = new Map<string, { source: string; module: Promise<any> }>();
  private readonly importing = new Set<(error: Error) => void>();
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
      const dependencies = module.dependencies ?? {};
      const sourceKey = JSON.stringify([module.source, Object.entries(dependencies).sort()]);
      const prior = this.resolved.get(resolvedKey);
      if (prior) {
        if (prior.source !== sourceKey) throw new Error(`Widget module changed: ${name}`);
        return prior.module;
      }
      const loaded = this.importAmd(module.source, dependencies, [name]).then((value) => {
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
      this.resolved.set(resolvedKey, { source: sourceKey, module: loaded });
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

  private async importAmd(
    source: string,
    dependencies: Record<string, string> = {},
    chain: string[] = [],
    deadline = Date.now() + 30000,
  ): Promise<any> {
    const exports: Record<string, unknown> = {};
    let factory: (...args: any[]) => any;
    let requested: string[] = [];
    let defined = false;
    const define = (...args: any[]) => {
      if (!this.active) throw new Error("Widget connection ended");
      if (defined) throw new Error("Widget bundle defines more than one module");
      if (typeof args[0] === "string" && args.shift() !== chain.at(-1))
        throw new Error("Widget bundle defines an unexpected module");
      const [names, fn] = args;
      if (
        !Array.isArray(names) ||
        !names.every((name) => typeof name === "string") ||
        typeof fn !== "function"
      )
        throw new Error("Unsupported widget bundle format");
      defined = true;
      requested = names;
      factory = fn;
    };
    let rejectScript: (error: Error) => void = () => {};
    Object.assign(define, {
      amd: {},
      tithonActive: () => this.active,
      tithonError: (error: unknown) =>
        rejectScript(error instanceof Error ? error : new Error(String(error))),
    });
    const slot = `__tithon_widget_${crypto.randomUUID().replace(/-/g, "")}`;
    (globalThis as any)[slot] = define;
    const url = URL.createObjectURL(
      new Blob(
        [
          `(()=>{const define = globalThis[${JSON.stringify(slot)}];\nif (!define?.tithonActive()) return;\ntry {\n`,
          source,
          "\n} catch (error) { define.tithonError(error); }\n})();",
        ],
        {
          type: "text/javascript",
        },
      ),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        const timer = setTimeout(
          () => finish(new Error("Widget module timed out")),
          Math.max(1, deadline - Date.now()),
        );
        const finish = (error?: Error) => {
          clearTimeout(timer);
          this.importing.delete(rejectScript);
          script.remove();
          if (error) reject(error);
          else resolve();
        };
        rejectScript = (error) => finish(error);
        this.importing.add(rejectScript);
        script.onload = () => finish();
        script.onerror = () => finish(new Error("Widget module could not be loaded"));
        script.src = url;
        document.head.append(script);
      });
      if (!this.active || !defined) throw new Error("Widget module could not be loaded");
      const module = { id: chain.at(-1), uri: url, exports };
      const args = [];
      for (const dependency of requested) {
        if (dependency === "@jupyter-widgets/base") args.push(base);
        else if (dependency === "@jupyter-widgets/controls") args.push(controls);
        else if (dependency === "exports") args.push(exports);
        else if (dependency === "module") args.push(module);
        else {
          if (!Object.keys(dependencies).includes(dependency) || chain.includes(dependency))
            throw new Error(`Unsupported widget dependency ${dependency}`);
          const signature = JSON.stringify([
            dependencies[dependency],
            Object.entries(dependencies).sort(),
          ]);
          const cacheKey = JSON.stringify([chain[0], dependency]);
          let cached = this.dependencyCache.get(cacheKey);
          if (cached && cached.source !== signature)
            throw new Error(`Widget dependency changed: ${dependency}`);
          if (!cached) {
            const loaded = this.importAmd(
              dependencies[dependency],
              dependencies,
              [...chain, dependency],
              deadline,
            );
            cached = { source: signature, module: loaded };
            this.dependencyCache.set(cacheKey, cached);
            void loaded.catch(() => {
              if (this.dependencyCache.get(cacheKey)?.module === loaded)
                this.dependencyCache.delete(cacheKey);
            });
          }
          args.push(await cached.module);
          if (!this.active) throw new Error("Widget connection ended");
        }
      }
      if (!this.active) throw new Error("Widget connection ended");
      if (Date.now() >= deadline) throw new Error("Widget module timed out");
      const result = factory!(...args) ?? module.exports;
      if (result && typeof result.then === "function")
        throw new Error("Asynchronous widget factories are not supported");
      return result;
    } finally {
      URL.revokeObjectURL(url);
      delete (globalThis as any)[slot];
    }
  }

  dispose(): void {
    this.active = false;
    for (const reject of this.importing) reject(new Error("Widget connection ended"));
    this.importing.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Widget connection ended"));
    }
    this.pending.clear();
    this.cache.clear();
    this.resolved.clear();
    this.dependencyCache.clear();
  }
}
