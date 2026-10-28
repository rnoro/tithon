// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { WidgetModuleLoader } from "../src/widgetModuleLoader";

const scope = { session: "file:///notebook", kernel_id: "kernel", binding: "binding" };

describe("installed widget module requests", () => {
  it("rejects a wrong installed version and ignores replies from another scope", async () => {
    const send = vi.fn();
    const loader = new WidgetModuleLoader(scope, send);
    const result = loader.load("bqplot", "^0.6.1");
    const request = send.mock.calls[0][0];
    loader.receive({
      type: "tithon.widget-module-result",
      scope: { ...scope, kernel_id: "other" },
      request_id: request.request_id,
      module: { name: "bqplot", version: "0.6.1", source: "" },
    });
    loader.receive({
      type: "tithon.widget-module-result",
      scope,
      request_id: request.request_id,
      module: { name: "bqplot", version: "1.0.0", source: "" },
    });
    await expect(result).rejects.toThrow("version");
    loader.dispose();
  });

  it("shares pending requests and rejects them when the binding is revoked", async () => {
    const send = vi.fn();
    const loader = new WidgetModuleLoader(scope, send);
    const first = loader.load("bqplot", "^0.6.1");
    const second = loader.load("bqplot", "^0.6.1");
    expect(first).toBe(second);
    expect(send).toHaveBeenCalledTimes(1);
    loader.dispose();
    await expect(first).rejects.toThrow("connection ended");
    await expect(loader.load("bqplot", "^0.6.1")).rejects.toThrow("connection ended");
  });

  it.each([{}, { version: "0.5.0" }])(
    "rejects a bundle whose exported version is missing or differs from its metadata",
    async (exports) => {
      const send = vi.fn();
      const loader = new WidgetModuleLoader(scope, send);
      (loader as any).importAmd = vi.fn().mockResolvedValue(exports);
      const result = loader.load("bqplot", "^0.6.1");
      const request = send.mock.calls[0][0];
      loader.receive({
        type: "tithon.widget-module-result",
        scope,
        request_id: request.request_id,
        module: { name: "bqplot", version: "0.6.1", source: "" },
      });
      await expect(result).rejects.toThrow("version");
      loader.dispose();
    },
  );

  it("shares one installed module across compatible ranges and rejects changed bytes", async () => {
    const send = vi.fn();
    const loader = new WidgetModuleLoader(scope, send);
    const exports = { version: "0.6.1" };
    const importAmd = vi.fn().mockResolvedValue(exports);
    (loader as any).importAmd = importAmd;
    const first = loader.load("bqplot", "^0.6.0");
    const second = loader.load("bqplot", "^0.6.1");
    for (const [message] of send.mock.calls) {
      loader.receive({
        type: "tithon.widget-module-result",
        scope,
        request_id: message.request_id,
        module: { name: "bqplot", version: "0.6.1", source: "same source" },
      });
    }
    expect(await first).toBe(exports);
    expect(await second).toBe(exports);
    expect(importAmd).toHaveBeenCalledTimes(1);
    const third = loader.load("bqplot", ">=0.6.1 <0.7.0");
    const request = send.mock.calls[2][0];
    loader.receive({
      type: "tithon.widget-module-result",
      scope,
      request_id: request.request_id,
      module: { name: "bqplot", version: "0.6.1", source: "changed source" },
    });
    await expect(third).rejects.toThrow("changed");
    loader.dispose();
  });

  it("uses the package version instead of a re-exported dependency's module version", async () => {
    const send = vi.fn();
    const loader = new WidgetModuleLoader(scope, send);
    const exports = { MODULE_NAME: "bqscales", MODULE_VERSION: "0.3.2", version: "0.6.1" };
    (loader as any).importAmd = vi.fn().mockResolvedValue(exports);
    const result = loader.load("bqplot", "^0.6.1");
    loader.receive({
      type: "tithon.widget-module-result",
      scope,
      request_id: send.mock.calls[0][0].request_id,
      module: { name: "bqplot", version: "0.6.1", source: "source" },
    });
    expect(await result).toBe(exports);
    loader.dispose();
  });

  it("uses MODULE_VERSION when MODULE_NAME identifies the requested package", async () => {
    const send = vi.fn();
    const loader = new WidgetModuleLoader(scope, send);
    const exports = { MODULE_NAME: "bqscales", MODULE_VERSION: "0.3.7" };
    (loader as any).importAmd = vi.fn().mockResolvedValue(exports);
    const result = loader.load("bqscales", "^0.3");
    loader.receive({
      type: "tithon.widget-module-result",
      scope,
      request_id: send.mock.calls[0][0].request_id,
      module: { name: "bqscales", version: "0.3.7", source: "source" },
    });
    expect(await result).toBe(exports);
    loader.dispose();
  });

  it("does not call an AMD factory after its connection is revoked", async () => {
    const loader = new WidgetModuleLoader(scope, vi.fn());
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "data:text/javascript,export%20default%201");
    URL.revokeObjectURL = vi.fn();
    const before = new Set(Object.getOwnPropertyNames(globalThis));
    try {
      const result = (loader as any).importAmd("define([], () => ({}));") as Promise<unknown>;
      const slot = Object.getOwnPropertyNames(globalThis).find(
        (key) => key.startsWith("__tithon_widget_") && !before.has(key),
      )!;
      const define = (globalThis as any)[slot];
      const factory = vi.fn();
      loader.dispose();
      expect(() => define([], factory)).toThrow("Widget connection ended");
      expect(factory).not.toHaveBeenCalled();
      await expect(result).rejects.toThrow();
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
