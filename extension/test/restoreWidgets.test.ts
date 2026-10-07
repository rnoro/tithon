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
    getWorkspaceFolder: () => undefined,
    onDidChangeNotebookDocument: () => ({ dispose() {} }),
  },
}));

import { TithonNotebookController, VSCodeCellSink } from "../src/sessionController";

function harness(postMessage: ReturnType<typeof vi.fn>): TithonNotebookController {
  return Object.assign(Object.create(TithonNotebookController.prototype), {
    controller: {},
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
    const notebook = { uri, getCells: () => [] } as unknown as vscode.NotebookDocument;
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
  const notebook = { uri, getCells: () => [] } as unknown as vscode.NotebookDocument;
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
  const notebook = { uri, getCells: () => [] } as unknown as vscode.NotebookDocument;
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
