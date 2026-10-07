import { expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { SessionClient } from "../src/sessionClient";

vi.mock("vscode", async () => ({
  ...(await vi.importActual<typeof import("./vscodeMock")>("./vscodeMock")),
  NotebookCellKind: { Code: 2, Markup: 1 },
  NotebookCellOutput: class {
    constructor(public items: unknown[]) {}
  },
  NotebookCellOutputItem: {
    text: (text: string, mime: string) => ({ mime, data: new TextEncoder().encode(text) }),
  },
}));

import { VSCodeCellSink } from "../src/sessionController";

it("finishes a rerun whose status arrives while a historical seed append is pending", async () => {
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const appending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const handles: { ended: boolean; started: boolean; texts: string[] }[] = [];
  const cell = { kind: 2, outputs: [] };
  const controller = {
    createNotebookCellExecution() {
      if (handles.some((handle) => !handle.ended)) throw new Error("two executions own one cell");
      const handle = { ended: false, started: false, texts: [] as string[] };
      handles.push(handle);
      const alive = () => {
        if (handle.ended) throw new Error("execution ended");
      };
      return {
        start() {
          alive();
          handle.started = true;
        },
        async clearOutput() {
          alive();
        },
        async appendOutput(output: { items: { data: Uint8Array }[] }) {
          alive();
          handle.texts.push(new TextDecoder().decode(output.items[0].data));
          if (handles.length === 1) {
            entered();
            await barrier;
          }
          alive();
        },
        async appendOutputItems(item: { data: Uint8Array }) {
          alive();
          handle.texts.push(new TextDecoder().decode(item.data));
        },
        end() {
          alive();
          handle.ended = true;
        },
      };
    },
  } as unknown as vscode.NotebookController;
  const notebook = { cellCount: 1, cellAt: () => cell } as unknown as vscode.NotebookDocument;
  const client = {
    widgets: () => null,
    cachedArtifact: () => undefined,
  } as unknown as SessionClient;
  const sink = new VSCodeCellSink(controller, notebook, client);
  sink.seedCell(0, [{ output_type: "stream", name: "stdout", text: "old" }], "done");
  sink.seedCell(0, [], "queued");
  await appending;
  sink.status(0, "running");
  sink.appendStream(0, "stdout", "new");
  sink.status(0, "done");
  release();
  await sink.settled();
  expect(handles).toHaveLength(2);
  expect(handles[1].texts).toEqual(["new"]);
  expect(handles.every((handle) => handle.ended)).toBe(true);
  expect(sink.activeCells()).toEqual([]);
});
