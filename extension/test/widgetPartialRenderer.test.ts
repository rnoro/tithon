// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { activate } from "../src/widgetRendererEntry";

it("rejects malformed or unbounded partial trees without creating a widget manager", async () => {
  const post = vi.fn();
  const renderer = activate({ onDidReceiveMessage: () => {}, postMessage: post });
  let deep: any = { kind: "omitted", reason: "missing" };
  for (let index = 0; index < 18; index++) {
    deep = { kind: "container", direction: "column", children: [deep] };
  }
  const cases = [
    null,
    { kind: "label", text: "not a container" },
    {
      kind: "container",
      direction: "row",
      children: Array(129).fill({ kind: "omitted", reason: "missing" }),
    },
    deep,
    {
      kind: "container",
      direction: "row",
      children: [{ kind: "progress", value: 1, min: 1, max: 1 }],
    },
    {
      kind: "container",
      direction: "row",
      children: [
        { kind: "progress", value: 0, min: -Number.MAX_VALUE, max: Number.MAX_VALUE },
        { kind: "omitted", reason: "missing" },
      ],
    },
    { kind: "container", direction: "row", children: [{ kind: "omitted", reason: "<script>" }] },
  ];
  for (const [index, tree] of cases.entries()) {
    const host = document.createElement("div");
    await renderer.renderOutputItem(
      {
        id: String(index),
        json: () => ({
          model_id: "box",
          partial_tree: tree,
          live: true,
          allow_custom_widgets: true,
          scope: { session: "notebook", kernel_id: "kernel", binding: "binding" },
        }),
      },
      host,
    );
    expect(host.textContent).toContain("Invalid widget snapshot");
    expect(host.querySelector(".tithon-widget-host")?.inert).toBe(true);
    expect(host.querySelector("progress")).toBeNull();
  }
  const valid = document.createElement("div");
  await renderer.renderOutputItem(
    {
      id: "valid",
      json: () => ({
        model_id: "box",
        partial_tree: {
          kind: "container",
          direction: "column",
          children: [{ kind: "omitted", reason: "unsupported" }],
        },
        live: true,
        allow_custom_widgets: true,
        scope: { session: "notebook", kernel_id: "kernel", binding: "binding" },
      }),
    },
    valid,
  );
  expect(valid.textContent).toContain("Widget not shown");
  expect(valid.querySelector(".tithon-widget-host")?.inert).toBe(true);
  expect(post).not.toHaveBeenCalled();
});
