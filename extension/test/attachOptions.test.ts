import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemonClient";
import { SessionClient } from "../src/sessionClient";
import { type FakeDaemon, fakeDaemonRaw } from "./fakeDaemon";

// The daemon learns a notebook's saved-widget-state choice only from these
// fields, so every path that can create or bind a session must carry them.
describe("per-session attach options", () => {
  let daemon: FakeDaemon | undefined;
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  async function recording() {
    const seen: Record<string, unknown>[] = [];
    daemon = await fakeDaemonRaw((ws) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        seen.push(m);
        const reply: Record<string, Record<string, unknown>[]> = {
          attach: [
            { op: "snapshot", max_seq: 0, executions: [] },
            { op: "sync", seq: 0 },
          ],
          execute: [{ op: "execute_ack", exec_id: "e1" }],
          refresh_outputs: [{ op: "outputs_refreshed", ok: true }],
          export_notebook: [{ op: "notebook_converted" }],
          import_notebook: [{ op: "notebook_converted" }],
        };
        for (const frame of reply[m.op] ?? []) ws.send(JSON.stringify(frame));
      });
    });
    return seen;
  }

  const options = (session: string) => ({ save_widget_state: false, scope: session });

  it("DaemonClient sends them on attach, refresh and conversion", async () => {
    const seen = await recording();
    const client = new DaemonClient(daemon!.sock, options);
    await client.execute("1", { uri: "file:///w/a.pynb" } as never, "/w");
    await client.refreshOutputs("/w/b.pynb", "/w");
    await client.convertNotebook("export", "/w/c.pynb", "/w/c.ipynb", "/w");
    await client.convertNotebook("import", "/w/d.ipynb", "/w/d.pynb", "/w");
    const byOp = (op: string) => seen.filter((m) => m.op === op);
    expect(byOp("attach")[0]).toMatchObject({
      save_widget_state: false,
      scope: "file:///w/a.pynb",
    });
    expect(byOp("execute")[0]).not.toHaveProperty("save_widget_state");
    expect(byOp("refresh_outputs")[0]).toMatchObject({ scope: "file:///w/b.pynb" });
    expect(byOp("export_notebook")[0]).toMatchObject({ scope: "file:///w/c.pynb" });
    expect(byOp("import_notebook")[0]).toMatchObject({ scope: "file:///w/d.pynb" });
  });

  it("SessionClient sends them on its attach", async () => {
    const seen = await recording();
    const client = new SessionClient(daemon!.sock, "file:///w/e.pynb", "/w", options);
    await client.attach(0);
    client.close();
    expect(seen.find((m) => m.op === "attach")).toMatchObject({
      save_widget_state: false,
      scope: "file:///w/e.pynb",
    });
  });
});
