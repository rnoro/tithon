// Polyfills for running @lumino / @jupyter-widgets under jsdom. These globals
// are referenced at module-load time by @lumino/dragdrop and the widget views
// but are not implemented by jsdom. Guarded so this file is inert under the
// plain node environment used by the serializer tests.
const g = globalThis as any;

// Some @jupyter-widgets/@jupyterlab modules reference webpack's public-path
// global at load time; define it so a bare read/assign doesn't ReferenceError.
if (typeof g.__webpack_public_path__ === "undefined") {
  g.__webpack_public_path__ = "";
}

if (typeof g.DragEvent === "undefined" && typeof g.MouseEvent !== "undefined") {
  g.DragEvent = class DragEvent extends g.MouseEvent {
    constructor(type: string, init?: any) {
      super(type, init);
    }
  };
}

if (typeof g.ResizeObserver === "undefined") {
  g.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

if (typeof g.matchMedia === "undefined" && typeof g.window !== "undefined") {
  g.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });
}
