// @vitest-environment jsdom
import { expect, it } from "vitest";
import { LiveWidgetRenderer } from "../src/liveWidgetRenderer";
import { SessionClient } from "../src/sessionClient";
import { WidgetComms } from "../src/widgetComm";
import { fakeDaemonRaw, settle } from "./fakeDaemon";

const scope = { session: "file:///widget.pynb", binding: "client:kernel", kernel_id: "kernel" };

function snapshot() {
  return {
    version_major: 2,
    version_minor: 0,
    state: {
      button: {
        model_name: "ButtonModel",
        model_module: "@jupyter-widgets/controls",
        model_module_version: "2.0.0",
        state: {
          _model_name: "ButtonModel",
          _view_name: "ButtonView",
          _view_module: "@jupyter-widgets/controls",
          _view_module_version: "2.0.0",
          description: "Click",
        },
      },
    },
  };
}

it("shares a live button model between views and drops input on invalidation", async () => {
  const sent: any[] = [];
  const renderer = new LiveWidgetRenderer((m) => sent.push(m));
  const first = document.createElement("div"),
    second = document.createElement("div");
  document.body.append(first, second);
  try {
    const payload = { scope, model_id: "button", state: snapshot() };
    await renderer.render("first", payload, first);
    await renderer.render("second", payload, second);
    first.querySelector("button")!.click();
    second.querySelector("button")!.click();
    expect(sent.filter((m) => m.type === "tithon.widget-send")).toHaveLength(2);
    const raw = {
      header: { msg_type: "comm_msg" },
      parent_header: {},
      metadata: {},
      buffers: [],
      content: { comm_id: "button", data: { method: "update", state: { description: "Both" } } },
    };
    renderer.receive({ type: "tithon.widget-message", scope, message: raw });
    await settle(20);
    expect(first.querySelector("button")!.textContent).toBe("Both");
    expect(second.querySelector("button")!.textContent).toBe("Both");
    renderer.dispose("first");
    second.querySelector("button")!.click();
    expect(sent.filter((m) => m.type === "tithon.widget-send")).toHaveLength(3);
    renderer.invalidate(scope);
    second.querySelector("button")!.click();
    expect(second.querySelector("button")!.disabled).toBe(true);
    expect(sent.filter((m) => m.type === "tithon.widget-send")).toHaveLength(3);
    const late = document.createElement("div");
    document.body.append(late);
    await renderer.render("late", payload, late);
    expect(late.querySelector("button")!.disabled).toBe(true);
    renderer.dispose("late");
    late.remove();
  } finally {
    renderer.dispose("first");
    renderer.dispose("second");
    first.remove();
    second.remove();
  }
});

it("delivers raw binary custom and correlated idle callbacks in order", async () => {
  const posted: any[] = [],
    received: any[] = [],
    callbacks: any[] = [];
  const comms = new WidgetComms(
    scope,
    (m) => posted.push(m),
    () => {},
  );
  const comm = comms.comm("image");
  comm.on_msg((m: any) => received.push(m));
  const id = comm.send(
    { method: "custom", content: {} },
    { iopub: { status: (m: any) => callbacks.push(m.content.execution_state) } },
    {},
    [new Uint8Array([0, 255, 7])],
  );
  expect(posted[0].buffers).toEqual(["AP8H"]);
  await comms.receive({
    header: { msg_type: "comm_msg" },
    parent_header: { msg_id: id },
    metadata: {},
    buffers: ["AP8H"],
    content: { comm_id: "image", data: { method: "custom", content: { answer: 1 } } },
  });
  expect(Array.from(new Uint8Array(received[0].buffers[0].buffer))).toEqual([0, 255, 7]);
  for (const execution_state of ["busy", "idle"])
    await comms.receive({
      header: { msg_type: "status" },
      parent_header: { msg_id: id },
      metadata: {},
      buffers: [],
      content: { execution_state },
    });
  expect(callbacks).toEqual(["busy", "idle"]);
  comms.dispose();
  expect(() => comm.send({ method: "custom" })).toThrow("ended");
});

it("sends on the attached client binding and never retries a disconnected action", async () => {
  const requests: any[] = [];
  let attached: any;
  const daemon = await fakeDaemonRaw((ws) => {
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.op === "attach") {
        attached = frame;
        ws.send(
          JSON.stringify({
            op: "snapshot",
            widgets: snapshot(),
            kernel: { status: "idle" },
            widget_context: {
              kernel_id: "kernel",
              active_model_ids: ["button"],
              states: { kernel: snapshot() },
            },
          }),
        );
        ws.send(JSON.stringify({ op: "sync", seq: 0 }));
      } else {
        requests.push(frame);
        if (frame.op === "widget_message")
          ws.send(JSON.stringify({ op: "widget_ack", request_id: frame.request_id, ok: true }));
      }
    });
  });
  const client = new SessionClient(daemon.sock, scope.session);
  try {
    await client.attach();
    const own = { ...scope, binding: client.widgets()!.renderer_binding!.binding };
    expect(own.binding).toBe(`${attached.widget_binding}:kernel`);
    await client.sendWidgetMessage(own, "click-one", "button", {
      method: "custom",
      content: { event: "click" },
    });
    expect(requests[0]).toMatchObject({
      session: scope.session,
      binding: own.binding,
      request_seq: 1,
    });
    await expect(
      client.sendWidgetMessage({ ...own, session: "other" }, "cross", "button", {}),
    ).rejects.toThrow("unavailable");
    const event: any = {
      kind: "widget_status",
      payload: {
        kernel_id: "kernel",
        binding: attached.widget_binding,
        request_id: "click-one",
        message: {
          header: { msg_type: "status" },
          parent_header: { msg_id: "kernel-request" },
          content: { execution_state: "idle" },
        },
      },
    };
    expect(client.widgetMessageForRenderer(event).parent_header.msg_id).toBe("click-one");
    event.payload.binding = "other-client";
    expect(client.widgetMessageForRenderer(event)).toBeUndefined();
    client.close();
    await expect(client.sendWidgetMessage(own, "late", "button", {})).rejects.toThrow(
      "unavailable",
    );
    expect(requests).toHaveLength(1);
  } finally {
    client.close();
    await daemon.close();
  }
});

it("keeps repeated stock slider sends flowing and reconciles kernel correction", async () => {
  const { createManager } = await import("../src/widgetRender");
  const posts: any[] = [];
  const comms = new WidgetComms(
    scope,
    (m) => posts.push(m),
    () => {},
  );
  const manager = createManager((id) => comms.comm(id));
  await manager.set_state({
    version_major: 2,
    version_minor: 0,
    state: {
      slider: {
        model_name: "IntSliderModel",
        model_module: "@jupyter-widgets/controls",
        model_module_version: "2.0.0",
        state: { value: 0, max: 100 },
      },
    },
  } as any);
  const model: any = await manager.get_model("slider");
  try {
    for (let value = 1; value <= 21; value++) {
      model.set("value", value);
      model.save_changes();
      const post = posts.at(-1);
      expect(posts).toHaveLength(value);
      await comms.receive({
        header: { msg_type: "comm_msg" },
        parent_header: { msg_id: post.request_id },
        metadata: {},
        buffers: [],
        content: {
          comm_id: "slider",
          data: { method: "echo_update", state: { value }, buffer_paths: [] },
        },
      });
      await comms.receive({
        header: { msg_type: "status" },
        parent_header: { msg_id: post.request_id },
        metadata: {},
        buffers: [],
        content: { execution_state: "idle" },
      });
    }
    model.set("value", 999);
    model.save_changes();
    const id = posts.at(-1).request_id;
    for (const [method, value] of [
      ["echo_update", 999],
      ["update", 100],
    ] as const)
      await comms.receive({
        header: { msg_type: "comm_msg" },
        parent_header: { msg_id: id },
        metadata: {},
        buffers: [],
        content: { comm_id: "slider", data: { method, state: { value }, buffer_paths: [] } },
      });
    await comms.receive({
      header: { msg_type: "status" },
      parent_header: { msg_id: id },
      metadata: {},
      buffers: [],
      content: { execution_state: "idle" },
    });
    expect(model.get("value")).toBe(100);
    expect(model._pending_msgs).toBe(0);
    expect(model._expectedEchoMsgIds.size).toBe(0);
  } finally {
    comms.dispose();
  }
});

it("bounds queued raw traffic and disables inputs instead of accumulating updates", async () => {
  const renderer = new LiveWidgetRenderer(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  try {
    await renderer.render("bounded", { scope, model_id: "button", state: snapshot() }, host);
    const message = {
      header: { msg_type: "comm_msg" },
      parent_header: {},
      metadata: {},
      buffers: [],
      content: {
        comm_id: "button",
        data: { method: "update", state: { description: "x".repeat(8 * 1024 * 1024) } },
      },
    };
    renderer.receive({ type: "tithon.widget-message", scope, message });
    expect(host.querySelector("button")!.disabled).toBe(true);
    expect(host.textContent).toContain("exceeded the display buffer");
    renderer.receive({ type: "tithon.widget-message", scope, message });
    expect(host.querySelectorAll(".tithon-widget-status")).toHaveLength(1);
  } finally {
    renderer.dispose("bounded");
    host.remove();
  }
});

it("deserializes binary trait updates through the stock live ImageModel", async () => {
  const { createManager } = await import("../src/widgetRender");
  const comms = new WidgetComms(
    scope,
    () => {},
    () => {},
  );
  const manager = createManager((id) => comms.comm(id));
  try {
    await manager.set_state({
      version_major: 2,
      version_minor: 0,
      state: {
        image: {
          model_name: "ImageModel",
          model_module: "@jupyter-widgets/controls",
          model_module_version: "2.0.0",
          state: { format: "png" },
          buffers: [{ encoding: "base64", path: ["value"], data: "AQI=" }],
        },
      },
    } as any);
    const image: any = await manager.get_model("image");
    await comms.receive({
      header: { msg_type: "comm_msg" },
      parent_header: {},
      metadata: {},
      buffers: ["AP8H"],
      content: {
        comm_id: "image",
        data: { method: "update", state: {}, buffer_paths: [["value"]] },
      },
    });
    const value = image.get("value");
    expect(Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))).toEqual([
      0, 255, 7,
    ]);
  } finally {
    comms.dispose();
  }
});
