// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { WidgetState } from "../src/richOutput";
import type { EventFrame } from "../src/sessionClient";
import * as widgetRender from "../src/widgetRender";
import { activate } from "../src/widgetRendererEntry";

const wire = vi.hoisted(() => ({
  clients: [] as { connected: boolean; event?: (event: EventFrame) => void }[],
  ready: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../src/daemonProcess", () => ({ ensureDaemon: async () => wire.ready?.() }));
vi.mock("../src/sessionClient", () => ({
  SessionClient: class {
    readonly connection = {
      connected: true,
      event: undefined as ((event: EventFrame) => void) | undefined,
    };
    constructor() {
      wire.clients.push(this.connection);
    }
    async attach() {}
    onDisconnect() {}
    onEvent(callback: (event: EventFrame) => void) {
      this.connection.event = callback;
    }
    kernelInfo() {
      return null;
    }
    widgets() {
      return null;
    }
    widgetMessageForRenderer() {
      return undefined;
    }
    async sendWidgetMessage() {}
    async fetchWidgetModule() {
      throw new Error("No widget module fixture");
    }
    executions() {
      return [];
    }
    isClosedByUser() {
      return false;
    }
    pendingInput() {
      return null;
    }
    isConnected() {
      return this.connection.connected;
    }
    close() {
      this.connection.connected = false;
    }
  },
}));
vi.mock("vscode", () => ({
  workspace: {
    isTrusted: true,
    getWorkspaceFolder: () => undefined,
    onDidChangeNotebookDocument: () => ({ dispose() {} }),
  },
}));

import { TithonNotebookController, VSCodeCellSink } from "../src/sessionController";

function harness(postMessage: ReturnType<typeof vi.fn>): TithonNotebookController {
  return Object.assign(Object.create(TithonNotebookController.prototype), {
    controllers: new Map([
      ["tithon-py", {}],
      ["tithon-notebook", {}],
    ]),
    sockPath: "unused.sock",
    liveSessions: new Map(),
    pendingLive: new Map(),
    wantLive: new Set(),
    lastSeedTrace: new Map(),
    reconnectAttempts: new Map(),
    reconnectTimers: new Map(),
    closedRestoreOffered: new Set(),
    restoreStates: new Map(),
    widgetUpdateBuf: new Map(),
    widgetFlushTimer: null,
    widgetMessaging: { postMessage },
    setRestoreState() {},
    showRestoreState() {},
    finishReconnectProgress() {},
    applyKernelLabel() {},
    warnIfStateLost() {},
    warnKernelDied() {},
  }) as TithonNotebookController;
}

afterEach(() => {
  wire.ready = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("holds a view refresh until its live connection finishes restoring", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const postMessage = vi.fn();
  const controller = harness(postMessage);
  const owner = "file:///restoring.py";
  const binding = { session: owner, binding: "binding" };
  const scope = { ...binding, kernel_id: "kernel" };
  const state: WidgetState = {
    state: { check: { state: { _model_name: "CheckboxModel", value: true } } },
  };
  const widgets: WidgetState = {
    renderer_binding: binding,
    widget_context: { kernel_id: "kernel", active_model_ids: ["check"], states: { kernel: state } },
  };
  (controller as any).pendingLive.set(owner, { promise, abort: new AbortController() });
  (controller as any).resyncWidget(owner, "check", scope, "view", "token");
  expect(postMessage).not.toHaveBeenCalled();
  (controller as any).liveSessions.set(owner, { widgets: () => widgets });
  release();
  await promise;
  await Promise.resolve();
  expect(postMessage).toHaveBeenCalledWith({
    type: "tithon.widget-resync",
    scope,
    state: expect.objectContaining({ state: state.state }),
    view_id: "view",
    view_token: "token",
  });
});

it("holds a module request until its matching live connection finishes restoring", async () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const postMessage = vi.fn();
  const controller = harness(postMessage);
  const owner = "file:///restoring.py";
  const scope = { session: owner, binding: "binding", kernel_id: "kernel" };
  const editor = {};
  const module = { name: "bqplot", version: "0.6.1", source: "define([]);" };
  const fetchWidgetModule = vi.fn().mockResolvedValue(module);
  (controller as any).pendingLive.set(owner, { promise, abort: new AbortController() });
  (controller as any).loadWidgetModule(owner, editor, scope, "request", "bqplot", "^0.6.1");
  expect(fetchWidgetModule).not.toHaveBeenCalled();
  (controller as any).liveSessions.set(owner, {
    fetchWidgetModule,
    widgets: () => ({ renderer_binding: scope, widget_context: { kernel_id: "kernel" } }),
  });
  release();
  await promise;
  await vi.waitFor(() =>
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "tithon.widget-module-result",
        scope,
        request_id: "request",
        module,
      },
      editor,
    ),
  );
  expect(fetchWidgetModule).toHaveBeenCalledWith(scope, "bqplot", "^0.6.1");
});

it("revokes a rendered binding when no connection is restoring", () => {
  const postMessage = vi.fn();
  const controller = harness(postMessage);
  const scope = { session: "file:///closed.py", binding: "closed", kernel_id: "old" };
  (controller as any).resyncWidget(scope.session, "check", scope, "view", "token");
  expect(postMessage).toHaveBeenCalledWith({ type: "tithon.widget-invalidate", ...scope });
});

it.each([false, true])(
  "keeps restore-time widget deltas and honors cancellation=%s",
  async (cancel) => {
    vi.useFakeTimers();
    wire.clients.length = 0;
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const restoring = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(VSCodeCellSink.prototype, "prefetch").mockResolvedValue(undefined);
    vi.spyOn(VSCodeCellSink.prototype, "settled").mockImplementation(async () => {
      entered();
      await barrier;
    });
    const postMessage = vi.fn();
    const controller = harness(postMessage);
    const uri = { toString: () => "file:///restoring.py" } as vscode.Uri;
    const notebook = {
      uri,
      notebookType: "tithon-py",
      getCells: () => [],
    } as unknown as vscode.NotebookDocument;
    const pending = controller.ensureLive(notebook);
    await restoring;
    const update = (state: Record<string, unknown>) =>
      wire.clients[0].event?.({
        op: "event",
        seq: 1,
        exec_id: null,
        kind: "widget",
        payload: { msg_type: "comm_msg", comm_id: "progress", data: { method: "update", state } },
      });
    update({ value: 3, max: 10 });
    await vi.advanceTimersByTimeAsync(50);
    expect(postMessage).not.toHaveBeenCalled();
    update({ value: 8 });
    await vi.advanceTimersByTimeAsync(50);
    if (cancel) {
      controller.disposeLive(uri);
      update({ value: 9 });
    }
    release();
    if (cancel) await expect(pending).rejects.toThrow("cancelled");
    else await pending;
    await vi.advanceTimersByTimeAsync(100);
    if (cancel) expect(postMessage).not.toHaveBeenCalled();
    else {
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith({
        type: "tithon.widget-update",
        comm_id: "progress",
        state: { value: 8, max: 10 },
      });
      controller.disposeLive(uri);
      update({ value: 9 });
      await vi.advanceTimersByTimeAsync(100);
      expect(postMessage).toHaveBeenCalledTimes(1);
    }
  },
);

it("a cancelled connection cannot purge a replacement connection's widget updates", async () => {
  vi.useFakeTimers();
  wire.clients.length = 0;
  const release: (() => void)[] = [];
  const entered: (() => void)[] = [];
  const barriers = [0, 1].map(() => new Promise<void>((resolve) => release.push(resolve)));
  const restoring = [0, 1].map(() => new Promise<void>((resolve) => entered.push(resolve)));
  let call = 0;
  vi.spyOn(VSCodeCellSink.prototype, "prefetch").mockResolvedValue(undefined);
  vi.spyOn(VSCodeCellSink.prototype, "settled").mockImplementation(async () => {
    const index = call++;
    entered[index]();
    await barriers[index];
  });
  const postMessage = vi.fn();
  const controller = harness(postMessage);
  const uri = { toString: () => "file:///replacement.py" } as vscode.Uri;
  const notebook = {
    uri,
    notebookType: "tithon-py",
    getCells: () => [],
  } as unknown as vscode.NotebookDocument;
  const first = controller.ensureLive(notebook);
  const rejected = expect(first).rejects.toThrow("cancelled");
  await restoring[0];
  controller.disposeLive(uri);
  const second = controller.ensureLive(notebook);
  await restoring[1];
  wire.clients[1].event?.({
    op: "event",
    seq: 1,
    exec_id: null,
    kind: "widget",
    payload: {
      msg_type: "comm_msg",
      comm_id: "progress",
      data: { method: "update", state: { value: 9 } },
    },
  });
  await vi.advanceTimersByTimeAsync(50);
  release[0]();
  await rejected;
  release[1]();
  await second;
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).toHaveBeenCalledWith({
    type: "tithon.widget-update",
    comm_id: "progress",
    state: { value: 9 },
  });
  controller.disposeLive(uri);
});

it("resyncs the actual model after a renderer mounts later than an activation delta", async () => {
  const snap = JSON.parse(
    readFileSync(join(__dirname, "fixtures", "tqdm_widget_state.json"), "utf8"),
  );
  const id = Object.keys(snap.state).find(
    (key) => snap.state[key].model_name === "FloatProgressModel",
  )!;
  const latest = structuredClone(snap);
  latest.state[id].state.value = 90;
  latest.state[id].state.max = 100;
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rendering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = widgetRender.renderWidget;
  vi.spyOn(widgetRender, "renderWidget").mockImplementation(async (...args) => {
    entered();
    await barrier;
    return original(...args);
  });
  let receive: ((message: unknown) => void) | undefined;
  const controller = harness(vi.fn((message: unknown) => receive?.(message)));
  const bridge = controller as unknown as {
    liveSessions: Map<string, { widgets: () => WidgetState }>;
    resyncWidget(owner: string, modelId: string): void;
  };
  bridge.liveSessions.set("file:///late.py", { widgets: () => latest });
  const renderer = activate({
    onDidReceiveMessage: (callback) => {
      receive = callback;
    },
    postMessage: (message: unknown) => {
      if ((message as { type: string }).type === "tithon.widget-rendered")
        bridge.resyncWidget("file:///late.py", id);
    },
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const pending = renderer.renderOutputItem(
    { id: "late-output", json: () => ({ model_id: id, state: snap }) },
    host,
  );
  await rendering;
  receive?.({ type: "tithon.widget-update", comm_id: id, state: { value: 90, max: 100 } });
  release();
  await pending;
  const deadline = Date.now() + 2000;
  while (
    (host.querySelector(".progress-bar") as HTMLElement | null)?.style.width !== "90%" &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect((host.querySelector(".progress-bar") as HTMLElement | null)?.style.width).toBe("90%");
  renderer.disposeOutputItem?.("late-output");
  host.remove();
});

it("cancellation during daemon readiness leaves a replacement connection untouched", async () => {
  vi.useFakeTimers();
  wire.clients.length = 0;
  let releaseReadiness!: () => void;
  let readinessEntered!: () => void;
  let releaseRestore!: () => void;
  let restoreEntered!: () => void;
  const readiness = new Promise<void>((resolve) => {
    releaseReadiness = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    readinessEntered = resolve;
  });
  const restore = new Promise<void>((resolve) => {
    releaseRestore = resolve;
  });
  const restoring = new Promise<void>((resolve) => {
    restoreEntered = resolve;
  });
  let call = 0;
  wire.ready = async () => {
    if (call++ === 0) {
      readinessEntered();
      await readiness;
    }
  };
  vi.spyOn(VSCodeCellSink.prototype, "prefetch").mockResolvedValue(undefined);
  vi.spyOn(VSCodeCellSink.prototype, "settled").mockImplementation(async () => {
    restoreEntered();
    await restore;
  });
  const postMessage = vi.fn();
  const controller = harness(postMessage);
  const uri = { toString: () => "file:///readiness.py" } as vscode.Uri;
  const notebook = {
    uri,
    notebookType: "tithon-py",
    getCells: () => [],
  } as unknown as vscode.NotebookDocument;
  const first = controller.ensureLive(notebook);
  const rejected = expect(first).rejects.toThrow("cancelled");
  await waiting;
  controller.disposeLive(uri);
  const second = controller.ensureLive(notebook);
  await restoring;
  wire.clients[0].event?.({
    op: "event",
    seq: 1,
    exec_id: null,
    kind: "widget",
    payload: {
      msg_type: "comm_msg",
      comm_id: "progress",
      data: { method: "update", state: { value: 9 } },
    },
  });
  await vi.advanceTimersByTimeAsync(50);
  releaseReadiness();
  await rejected;
  expect(wire.clients).toHaveLength(1);
  expect(wire.clients[0].connected).toBe(true);
  releaseRestore();
  await second;
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).toHaveBeenCalledWith({
    type: "tithon.widget-update",
    comm_id: "progress",
    state: { value: 9 },
  });
  controller.disposeLive(uri);
});

it("host coalescing rejects historical scopes and purges closed models before flush", async () => {
  vi.useFakeTimers();
  const postMessage = vi.fn();
  const controller = harness(postMessage);
  const widgets: WidgetState = {
    version_major: 2,
    version_minor: 0,
    state: {},
    renderer_binding: { session: "file:///scoped.py", binding: "current-connection" },
    widget_context: { kernel_id: "current", active_model_ids: ["same"], states: {} },
  };
  const bridge = controller as unknown as {
    liveSessions: Map<string, { widgets: () => WidgetState }>;
    queueWidgetUpdate(owner: string, payload: unknown, state?: WidgetState): void;
    resyncWidget(owner: string, modelId: string, scope: unknown): void;
  };
  const owner = "file:///scoped.py";
  bridge.liveSessions.set(owner, { widgets: () => widgets });
  const update = (kernel: string, value: number) =>
    bridge.queueWidgetUpdate(owner, {
      msg_type: "comm_msg",
      comm_id: "same",
      _tithon_kernel_id: kernel,
      data: { method: "update", state: { value } },
    });
  update("old", 10);
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).not.toHaveBeenCalled();
  update("current", 50);
  widgets.widget_context!.active_model_ids = [];
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).not.toHaveBeenCalled();
  widgets.widget_context!.active_model_ids = ["same"];
  update("current", 90);
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).toHaveBeenCalledWith({
    type: "tithon.widget-update",
    comm_id: "same",
    state: { value: 90 },
    scope: { session: owner, binding: "current-connection", kernel_id: "current" },
  });
  postMessage.mockClear();
  widgets.widget_context!.states.old = { state: { same: { state: { value: 10 } } } };
  bridge.resyncWidget(owner, "same", {
    session: owner,
    binding: "current-connection",
    kernel_id: "old",
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).not.toHaveBeenCalled();
});

it.each(["render", "update"])(
  "revokes an %s already in flight without affecting the new kernel manager",
  async (phase) => {
    const snap = JSON.parse(
      readFileSync(join(__dirname, "fixtures", "tqdm_widget_state.json"), "utf8"),
    );
    const id = Object.keys(snap.state).find(
      (key) => snap.state[key].model_name === "FloatProgressModel",
    )!;
    snap.state[id].state.value = 10;
    snap.state[id].state.max = 100;
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalRender = widgetRender.renderWidget;
    const manager = widgetRender.createManager();
    vi.spyOn(widgetRender, "createManager").mockReturnValueOnce(manager);
    if (phase === "render") {
      vi.spyOn(widgetRender, "renderWidget").mockImplementationOnce(async (...args) => {
        entered();
        await barrier;
        return originalRender(...args);
      });
    } else {
      const originalSetState = manager.set_state.bind(manager);
      let calls = 0;
      vi.spyOn(manager, "set_state").mockImplementation(async (...args) => {
        if (++calls > 1) {
          entered();
          await barrier;
        }
        return originalSetState(...args);
      });
    }
    let receive: ((msg: unknown) => void) | undefined;
    const posted: any[] = [];
    const renderer = activate({
      onDidReceiveMessage: (cb) => {
        receive = cb;
      },
      postMessage: (msg) => posted.push(msg),
    });
    const old = { session: "same", kernel_id: "old", binding: "connection:old" };
    const current = { session: "same", kernel_id: "new", binding: "connection:new" };
    const oldHost = document.createElement("div");
    const newHost = document.createElement("div");
    document.body.append(oldHost, newHost);
    const rendering = renderer.renderOutputItem(
      { id: "in-flight-old", json: () => ({ model_id: id, state: snap, scope: old }) },
      oldHost,
    );
    if (phase === "update") {
      await rendering;
      receive?.({ type: "tithon.widget-update", comm_id: id, scope: old, state: { value: 90 } });
    }
    await waiting;
    receive?.({ type: "tithon.widget-invalidate", session: old.session, binding: old.binding });
    await renderer.renderOutputItem(
      { id: "replacement", json: () => ({ model_id: id, state: snap, scope: current }) },
      newHost,
    );
    release();
    await rendering;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((newHost.querySelector(".progress-bar") as HTMLElement)?.style.width).toBe("10%");
    expect(posted.filter((msg) => msg.type === "tithon.widget-updated")).toHaveLength(0);
    receive?.({ type: "tithon.widget-update", comm_id: id, scope: old, state: { value: 60 } });
    receive?.({ type: "tithon.widget-update", comm_id: id, scope: current, state: { value: 50 } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((newHost.querySelector(".progress-bar") as HTMLElement)?.style.width).toBe("50%");
    expect(posted.filter((msg) => msg.type === "tithon.widget-updated")).toHaveLength(1);
    renderer.disposeOutputItem?.("in-flight-old");
    renderer.disposeOutputItem?.("replacement");
    oldHost.remove();
    newHost.remove();
  },
);

it("delivers legacy mirror updates only for the surviving available source kernel", async () => {
  vi.useFakeTimers();
  const postMessage = vi.fn();
  const controller = harness(postMessage);
  const widgets: WidgetState = {
    version_major: 2,
    version_minor: 0,
    state: {},
    renderer_binding: { session: "file:///legacy.py", binding: "connection:survivor" },
    renderer_available: true,
    widget_context: {
      kernel_id: "survivor",
      legacy_kernel_id: "survivor",
      active_model_ids: [],
      states: {
        legacy: { state: { same: { state: { _model_name: "IntProgressModel", value: 10 } } } },
      },
    },
  };
  const bridge = controller as unknown as {
    liveSessions: Map<string, { widgets: () => WidgetState }>;
    queueWidgetUpdate(owner: string, payload: unknown): void;
    resyncWidget(owner: string, modelId: string, scope: unknown): void;
  };
  const owner = "file:///legacy.py";
  const scope = { session: owner, binding: "connection:survivor", kernel_id: "legacy" };
  bridge.liveSessions.set(owner, { widgets: () => widgets });
  const update = (source: string | undefined) =>
    bridge.queueWidgetUpdate(owner, {
      msg_type: "comm_msg",
      comm_id: "same",
      _tithon_kernel_id: "legacy",
      _tithon_legacy_kernel_id: source,
      data: { method: "update", state: { value: 20 } },
    });
  update(undefined);
  update("different-kernel");
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).not.toHaveBeenCalled();
  update("survivor");
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).toHaveBeenCalledWith({
    type: "tithon.widget-update",
    comm_id: "same",
    state: { value: 20 },
    scope,
  });
  expect(widgets.widget_context!.active_model_ids).toEqual([]);
  postMessage.mockClear();
  bridge.resyncWidget(owner, "same", scope);
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).toHaveBeenCalledTimes(1);
  postMessage.mockClear();
  update("survivor");
  widgets.renderer_available = false;
  await vi.advanceTimersByTimeAsync(100);
  update("survivor");
  bridge.resyncWidget(owner, "same", scope);
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).not.toHaveBeenCalled();
  widgets.renderer_available = true;
  widgets.widget_context!.kernel_id = "replacement";
  update("survivor");
  bridge.resyncWidget(owner, "same", scope);
  await vi.advanceTimersByTimeAsync(100);
  expect(postMessage).not.toHaveBeenCalled();
});
