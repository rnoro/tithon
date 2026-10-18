import { afterEach, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const ui = vi.hoisted(() => ({
  limit: 0,
  notebooks: [] as unknown[],
  warnings: vi.fn(),
  cancel: undefined as (() => void) | undefined,
}));
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({ get: () => ui.limit }),
    get notebookDocuments() {
      return ui.notebooks;
    },
  },
  window: {
    showWarningMessage: ui.warnings,
    withProgress: (
      _options: unknown,
      task: (
        progress: { report(): void },
        token: { onCancellationRequested(cancel: () => void): { dispose(): void } },
      ) => Promise<void>,
    ) =>
      task(
        { report() {} },
        {
          onCancellationRequested: (cancel: () => void) => {
            ui.cancel = cancel;
            return { dispose() {} };
          },
        },
      ),
  },
  ProgressLocation: { Notification: 15 },
  Uri: { parse: (key: string) => ({ path: key }) },
}));

import { TithonNotebookController } from "../src/sessionController";

const key = "file:///retry.py";
function harness() {
  vi.useFakeTimers();
  ui.limit = 2;
  ui.warnings.mockReset().mockResolvedValue(undefined);
  const notebook = { uri: { toString: () => key } } as vscode.NotebookDocument;
  ui.notebooks = [notebook];
  const ctrl = Object.assign(Object.create(TithonNotebookController.prototype), {
    wantLive: new Set(),
    liveSessions: new Map(),
    pendingLive: new Map(),
    reconnectTimers: new Map(),
    reconnectAttempts: new Map(),
    reconnectProgress: new Map(),
    restoreStates: new Map(),
    closedRestoreOffered: new Set(),
    widgetFlushTimer: null,
    showRestoreState() {},
    invalidateWidgetUpdatesFor() {},
    flushWidgetUpdates() {},
    startLive: vi.fn().mockRejectedValue(new Error("offline")),
  });
  return { ctrl, notebook };
}
afterEach(() => {
  vi.useRealTimers();
  ui.cancel = undefined;
});

it("a successful connection cancels a waiting automatic retry", async () => {
  const { ctrl, notebook } = harness();
  await ctrl.ensureLive(notebook).catch(() => undefined);
  const dispose = vi.fn();
  ctrl.startLive.mockResolvedValue({ dispose });
  await ctrl.ensureLive(notebook);
  await vi.advanceTimersByTimeAsync(60000);
  expect(ctrl.startLive).toHaveBeenCalledTimes(2);
  expect(dispose).not.toHaveBeenCalled();
  expect(ctrl.restoreState(notebook.uri).state).toBe("connected");
  ctrl.disposeLive(notebook.uri);
});

it("cancelling an in-flight retry discards its late connection", async () => {
  const { ctrl, notebook } = harness();
  await ctrl.ensureLive(notebook).catch(() => undefined);
  let resolve!: (session: unknown) => void;
  ctrl.startLive.mockImplementationOnce(
    () =>
      new Promise((ready) => {
        resolve = ready;
      }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  ui.cancel!();
  const dispose = vi.fn();
  resolve({ dispose });
  await vi.advanceTimersByTimeAsync(60000);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(ctrl.liveSessions.size).toBe(0);
  expect(ctrl.startLive).toHaveBeenCalledTimes(2);
  expect(ctrl.restoreState(notebook.uri).reason).toContain("stopped");
});
it("counts automatic attempts, stops at the limit, and resets on manual retry", async () => {
  const { ctrl, notebook } = harness();
  await expect(ctrl.ensureLive(notebook)).rejects.toThrow("offline");
  await vi.advanceTimersByTimeAsync(1000);
  expect(ctrl.startLive).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(ctrl.startLive).toHaveBeenCalledTimes(3);
  expect(ctrl.restoreState(notebook.uri).state).toBe("failed");
  expect(ctrl.reconnectProgress.size).toBe(0);
  expect(ui.warnings).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60000);
  expect(ctrl.startLive).toHaveBeenCalledTimes(3);
  await expect(ctrl.retryRestore(notebook)).rejects.toThrow("offline");
  expect(ctrl.reconnectAttempts.has(key)).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(ctrl.reconnectAttempts.get(key)).toBe(1);
  ctrl.disposeLive(notebook.uri);
});

it("waits for restoration to settle before counting a retry or reporting exhaustion", async () => {
  const { ctrl, notebook } = harness();
  ui.limit = 1;
  let reject!: (error: Error) => void;
  ctrl.startLive.mockImplementation(
    () =>
      new Promise((_ready, fail) => {
        reject = fail;
      }),
  );
  const initial = ctrl.ensureLive(notebook).catch(() => undefined);
  ctrl.scheduleReconnect(notebook, "disconnect during initial restore");
  await vi.advanceTimersByTimeAsync(2000);
  expect(ctrl.startLive).toHaveBeenCalledTimes(1);
  expect(ctrl.reconnectAttempts.has(key)).toBe(false);
  reject(new Error("initial restore lost connection"));
  await initial;
  await vi.advanceTimersByTimeAsync(1000);
  expect(ctrl.startLive).toHaveBeenCalledTimes(2);
  ctrl.scheduleReconnect(notebook, "disconnect during final retry");
  expect(ui.warnings).not.toHaveBeenCalled();
  reject(new Error("retry restore lost connection"));
  await vi.advanceTimersByTimeAsync(60000);
  expect(ctrl.startLive).toHaveBeenCalledTimes(2);
  expect(ui.warnings).toHaveBeenCalledTimes(1);
  expect(ctrl.restoreState(notebook.uri).state).toBe("failed");
  ctrl.disposeLive(notebook.uri);
});
it("unlimited retries continue and success resets the cycle", async () => {
  const { ctrl, notebook } = harness();
  ui.limit = 0;
  await ctrl.ensureLive(notebook).catch(() => undefined);
  await vi.advanceTimersByTimeAsync(121000);
  expect(ctrl.startLive.mock.calls.length).toBeGreaterThan(7);
  expect(ui.warnings).not.toHaveBeenCalled();
  ctrl.startLive.mockResolvedValue({ dispose() {} });
  await vi.advanceTimersByTimeAsync(30000);
  expect(ctrl.restoreState(notebook.uri).state).toBe("connected");
  expect(ctrl.reconnectAttempts.has(key)).toBe(false);
  expect(ctrl.reconnectProgress.size).toBe(0);
  ctrl.disposeLive(notebook.uri);
});
it("cancelling progress stops retries and permits a fresh manual cycle", async () => {
  const { ctrl, notebook } = harness();
  await ctrl.ensureLive(notebook).catch(() => undefined);
  expect(ui.cancel).toBeTypeOf("function");
  ui.cancel!();
  await vi.advanceTimersByTimeAsync(60000);
  expect(ctrl.startLive).toHaveBeenCalledTimes(1);
  expect(ctrl.reconnectProgress.size).toBe(0);
  expect(ctrl.restoreState(notebook.uri).reason).toContain("stopped");
  await ctrl.retryRestore(notebook).catch(() => undefined);
  await vi.advanceTimersByTimeAsync(1000);
  expect(ctrl.startLive).toHaveBeenCalledTimes(3);
  ctrl.disposeLive(notebook.uri);
});
it("closing during a retry prevents further attempts and notifications", async () => {
  const { ctrl, notebook } = harness();
  await ctrl.ensureLive(notebook).catch(() => undefined);
  let reject!: (reason: Error) => void;
  ctrl.startLive.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  ctrl.disposeLive(notebook.uri);
  reject(new Error("closed"));
  await vi.advanceTimersByTimeAsync(60000);
  expect(ctrl.startLive).toHaveBeenCalledTimes(2);
  expect(ctrl.reconnectTimers.size).toBe(0);
  expect(ui.warnings).not.toHaveBeenCalled();
});
