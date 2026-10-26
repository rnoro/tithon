import { describe, expect, it } from "vitest";
import { ExecutionFold, type OutputItem } from "../src/outputFold";
import { type WidgetState, widgetPayload, widgetStateForOutput } from "../src/richOutput";
import { SessionClient } from "../src/sessionClient";
import { fakeDaemon, settle } from "./fakeDaemon";

const model = (value: number): WidgetState => ({
  version_major: 2,
  version_minor: 0,
  state: { same: { state: { _model_name: "IntProgressModel", value, max: 100 } } },
});
const view = (kernel?: string): OutputItem => ({
  output_type: "display_data",
  data: { "application/vnd.jupyter.widget-view+json": { model_id: "same" } },
  ...(kernel ? { widget_kernel_id: kernel } : {}),
});

function scoped(): WidgetState {
  return {
    ...model(90),
    renderer_binding: { session: "notebook-a", binding: "connection-a" },
    widget_context: {
      kernel_id: "new",
      active_model_ids: ["same"],
      states: { saved: model(1), old: model(10), new: model(90) },
    },
  };
}

describe("widget identity", () => {
  it("resolves colliding model IDs by output provenance, with untagged imports saved", () => {
    const widgets = scoped();
    for (const [kernel, value] of [
      ["old", 10],
      ["new", 90],
      [undefined, 1],
    ] as const) {
      const payload = widgetPayload(view(kernel), widgets)!;
      expect(payload.state.state?.same.state?.value).toBe(value);
      expect(payload.scope).toEqual({
        session: "notebook-a",
        binding: "connection-a",
        kernel_id: kernel ?? "saved",
      });
    }
    expect(widgetPayload(view("missing"), widgets)).toBeUndefined();
    expect(widgetStateForOutput(view("old"), widgets)).toBe(widgets.widget_context?.states.old);
  });

  it("folds internal provenance independently of Jupyter metadata", () => {
    const fold = new ExecutionFold();
    const metadata = { tithon_widget_kernel_id: "user-value", custom: 2 };
    fold.apply("display_data", {
      data: { "application/vnd.jupyter.widget-view+json": { model_id: "same" } },
      metadata,
      transient: { display_id: "display" },
      _tithon_kernel_id: "old",
    });
    expect(fold.outputs()[0]).toMatchObject({ widget_kernel_id: "old", metadata });
    fold.apply("update_display_data", {
      data: {},
      metadata,
      transient: { display_id: "display" },
      _tithon_kernel_id: "new",
    });
    expect(fold.outputs()[0]).toMatchObject({ widget_kernel_id: "new", metadata });
    fold.apply("execute_result", { data: {}, metadata, _tithon_kernel_id: "new" });
    expect(fold.outputs()[1]).toMatchObject({ widget_kernel_id: "new", metadata });
    fold.apply("update_display_data", {
      data: { "text/plain": "ordinary replacement" },
      metadata,
      transient: { display_id: "display" },
    });
    expect(fold.outputs()[0]).not.toHaveProperty("widget_kernel_id");
    expect(fold.outputs()[0]).toMatchObject({
      metadata,
      data: { "text/plain": "ordinary replacement" },
    });
    expect(widgetStateForOutput(fold.outputs()[0], scoped())).toBeDefined();
    expect(widgetStateForOutput(fold.outputs()[0], scoped())?.state?.same.state?.value).toBe(1);
  });

  it("keeps historical state across replacement and clears live authority on death", async () => {
    let send!: (frame: unknown) => void;
    const daemon = await fakeDaemon((ws) => {
      send = (frame) => ws.send(JSON.stringify(frame));
      send({
        op: "snapshot",
        widgets: model(10),
        widget_context: {
          kernel_id: "old",
          active_model_ids: ["same"],
          states: { old: model(10) },
        },
      });
    });
    const client = new SessionClient(daemon.sock, "notebook-a");
    try {
      await client.attach(0);
      await settle(30);
      const binding = client.widgets()?.renderer_binding;
      send({
        op: "event",
        seq: 10,
        exec_id: null,
        kind: "kernel",
        payload: { status: "restarted", kernel_id: "new" },
      });
      send({
        op: "event",
        seq: 11,
        exec_id: null,
        kind: "widget",
        payload: {
          msg_type: "comm_open",
          comm_id: "same",
          _tithon_kernel_id: "new",
          data: { state: { _model_name: "IntProgressModel", value: 90 } },
        },
      });
      await settle(30);
      expect(widgetPayload(view("old"), client.widgets())?.state.state?.same.state?.value).toBe(10);
      expect(widgetPayload(view("new"), client.widgets())?.state.state?.same.state?.value).toBe(90);
      expect(client.widgets()?.widget_context?.active_model_ids).toEqual(["same"]);
      expect(client.widgets()?.renderer_binding?.binding).not.toBe(binding?.binding);
      expect(client.widgets()?.renderer_binding?.binding).toMatch(/:new$/);
      send({
        op: "event",
        seq: 12,
        exec_id: null,
        kind: "kernel",
        payload: { status: "dead", kernel_id: "new" },
      });
      await settle(30);
      expect(client.widgets()?.widget_context?.active_model_ids).toEqual([]);
      expect(widgetPayload(view("new"), client.widgets())?.state.state?.same.state?.value).toBe(90);
    } finally {
      client.close();
      await daemon.close();
    }
  });

  it("drops active authority when disconnected while preserving saved rendering", async () => {
    const daemon = await fakeDaemon((ws) => {
      ws.send(
        JSON.stringify({
          op: "snapshot",
          widgets: model(90),
          widget_context: scoped().widget_context,
        }),
      );
      ws.send(JSON.stringify({ op: "overflow" }));
    });
    const client = new SessionClient(daemon.sock, "notebook-a");
    try {
      await client.attach(0);
      await settle(30);
      expect(client.isConnected()).toBe(false);
      expect(client.widgets()?.widget_context?.active_model_ids).toEqual([]);
      expect(widgetPayload(view("new"), client.widgets())?.state.state?.same.state?.value).toBe(90);
    } finally {
      client.close();
      await daemon.close();
    }
  });
});

it("rejects a second attachment instead of reusing a connection binding", async () => {
  let attached = 0;
  const daemon = await fakeDaemon(() => {
    attached++;
  });
  const client = new SessionClient(daemon.sock, "notebook-a");
  try {
    await client.attach(0);
    await expect(client.attach(0)).rejects.toThrow("only attach once");
    expect(attached).toBe(1);
    client.close();
    await expect(client.attach(0)).rejects.toThrow("only attach once");
  } finally {
    client.close();
    await daemon.close();
  }
});

it.each(["dead", "restarting", "killed", "gc", "shutdown"])(
  "keeps legacy history but revokes availability on %s",
  async (status) => {
    let send!: (frame: unknown) => void;
    const daemon = await fakeDaemon((ws) => {
      send = (frame) => ws.send(JSON.stringify(frame));
      send({
        op: "snapshot",
        kernel: { status: "idle", kernel_id: "survivor" },
        widgets: model(10),
        widget_context: {
          kernel_id: "survivor",
          legacy_kernel_id: null,
          active_model_ids: [],
          states: { legacy: model(10) },
        },
      });
    });
    const client = new SessionClient(daemon.sock, "legacy-notebook");
    try {
      await client.attach(0);
      await settle(30);
      send({
        op: "event",
        seq: 1,
        exec_id: null,
        kind: "widget",
        payload: {
          msg_type: "comm_msg",
          comm_id: "same",
          _tithon_kernel_id: "legacy",
          _tithon_legacy_kernel_id: "survivor",
          data: { method: "update", state: { value: 20 } },
        },
      });
      await settle(30);
      expect(client.widgets()?.widget_context?.legacy_kernel_id).toBe("survivor");
      expect(client.widgets()?.widget_context?.active_model_ids).toEqual([]);
      expect(client.widgets()?.renderer_available).toBe(true);
      send({
        op: "event",
        seq: 2,
        exec_id: null,
        kind: "kernel",
        payload: { status, kernel_id: "survivor" },
      });
      await settle(30);
      expect(client.widgets()?.renderer_available).toBe(false);
      expect(client.widgets()?.widget_context?.legacy_kernel_id).toBe("survivor");
      expect(widgetPayload(view("legacy"), client.widgets())?.state.state?.same.state?.value).toBe(
        20,
      );
    } finally {
      client.close();
      await daemon.close();
    }
  },
);

it("keeps newly opened models and existing children in the surviving kernel's legacy graph", async () => {
  let send!: (frame: unknown) => void;
  const daemon = await fakeDaemon((ws) => {
    send = (frame) => ws.send(JSON.stringify(frame));
    send({
      op: "snapshot",
      kernel: { status: "idle", kernel_id: "survivor" },
      widgets: model(10),
      widget_context: {
        kernel_id: "survivor",
        legacy_kernel_id: "survivor",
        active_model_ids: [],
        states: {
          legacy: {
            ...model(10),
            state: {
              ...model(10).state,
              oldBox: { state: { _model_name: "VBoxModel", children: ["IPY_MODEL_same"] } },
            },
          },
        },
      },
    });
  });
  const client = new SessionClient(daemon.sock, "legacy-graph");
  const legacyEvent = (msg_type: string, comm_id: string, data: unknown) =>
    send({
      op: "event",
      seq: 1,
      exec_id: null,
      kind: "widget",
      payload: {
        msg_type,
        comm_id,
        _tithon_kernel_id: "legacy",
        _tithon_legacy_kernel_id: "survivor",
        data,
      },
    });
  const graphView = (id: string, kernel = "legacy"): OutputItem => ({
    output_type: "display_data",
    widget_kernel_id: kernel,
    data: { "application/vnd.jupyter.widget-view+json": { model_id: id } },
  });
  try {
    await client.attach(0);
    await settle(30);
    legacyEvent("comm_open", "newBox", {
      state: { _model_name: "VBoxModel", children: ["IPY_MODEL_same"] },
    });
    legacyEvent("comm_open", "newChild", {
      state: { _model_name: "LabelModel", value: "new child" },
    });
    legacyEvent("comm_msg", "oldBox", {
      method: "update",
      state: { children: ["IPY_MODEL_newChild"] },
    });
    legacyEvent("comm_msg", "same", { method: "update", state: { value: 30 } });
    await settle(30);
    const newBox = widgetPayload(graphView("newBox"), client.widgets())!;
    const oldBox = widgetPayload(graphView("oldBox"), client.widgets())!;
    expect(Object.keys(newBox.state.state ?? {}).sort()).toEqual(["newBox", "same"]);
    expect(newBox.state.state?.same.state?.value).toBe(30);
    expect(Object.keys(oldBox.state.state ?? {}).sort()).toEqual(["newChild", "oldBox"]);
    expect(oldBox.state.state?.newChild.state?.value).toBe("new child");
    expect(newBox.scope?.kernel_id).toBe("legacy");
    expect(oldBox.scope).toEqual(newBox.scope);
    expect(client.widgets()?.widget_context?.active_model_ids).toEqual([]);
    send({
      op: "event",
      seq: 2,
      exec_id: null,
      kind: "kernel",
      payload: { status: "restarted", kernel_id: "replacement" },
    });
    send({
      op: "event",
      seq: 3,
      exec_id: null,
      kind: "widget",
      payload: {
        msg_type: "comm_open",
        comm_id: "same",
        _tithon_kernel_id: "replacement",
        data: { state: { _model_name: "IntProgressModel", value: 99 } },
      },
    });
    await settle(30);
    expect(
      widgetPayload(graphView("newBox"), client.widgets())?.state.state?.same.state?.value,
    ).toBe(30);
    expect(
      widgetPayload(graphView("same", "replacement"), client.widgets())?.state.state?.same.state
        ?.value,
    ).toBe(99);
    expect(client.widgets()?.widget_context?.active_model_ids).toEqual(["same"]);
  } finally {
    client.close();
    await daemon.close();
  }
});
