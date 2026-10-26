/** One live model registry per connection/kernel; output items own views only. */
import type { HTMLManager } from "@jupyter-widgets/html-manager/lib/htmlmanager";
import type { WidgetScope } from "./richOutput";
import { type RawWidgetMessage, WidgetComms } from "./widgetComm";
import { createManager, type WidgetStateSnapshot } from "./widgetRender";

type Group = {
  scope: WidgetScope;
  manager: HTMLManager;
  comms: WidgetComms;
  serial: Promise<void>;
  active: boolean;
  queued: number;
  queuedBytes: number;
  items: Set<string>;
};

export class LiveWidgetRenderer {
  private readonly groups = new Map<string, Group>();
  private readonly items = new Map<string, { group: Group; host: HTMLElement; view?: any }>();
  private readonly revoked = new Set<string>();
  constructor(private readonly post: (message: unknown) => void) {}

  private key(scope: WidgetScope): string {
    return JSON.stringify([scope.session, scope.binding, scope.kernel_id]);
  }
  private binding(scope: { session?: string; binding?: string }): string {
    return JSON.stringify([scope.session, scope.binding]);
  }

  invalidate(binding: { session?: string; binding?: string }): void {
    this.revoked.add(this.binding(binding));
    for (const group of this.groups.values())
      if (this.binding(group.scope) === this.binding(binding)) this.disable(group);
  }

  private disable(group: Group, reason = "Connection ended. Reconnect to refresh widgets."): void {
    group.active = false;
    group.comms.dispose();
    for (const id of group.items) {
      const host = this.items.get(id)?.host;
      if (!host) continue;
      host.inert = true;
      for (const element of Array.from(
        host.querySelectorAll<HTMLInputElement>("input,button,select,textarea"),
      ))
        element.disabled = true;
      if (!host.querySelector(".tithon-widget-status")) {
        const note = document.createElement("div");
        note.className = "tithon-widget-status";
        note.textContent = reason;
        host.appendChild(note);
      }
    }
  }

  receive(event: any): void {
    if (event?.type !== "tithon.widget-message" && event?.type !== "tithon.widget-error") return;
    const group = event.scope ? this.groups.get(this.key(event.scope)) : undefined;
    if (!group?.active) return;
    if (event.type === "tithon.widget-error") {
      group.comms.fail(event.message);
      return;
    }
    const message = event.message as RawWidgetMessage;
    const bytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
    if (group.queued >= 256 || group.queuedBytes + bytes > 8 * 1024 * 1024) {
      this.disable(group, "Widget updates exceeded the display buffer. Reconnect to refresh.");
      return;
    }
    group.queued += 1;
    group.queuedBytes += bytes;
    group.serial = group.serial
      .then(async () => {
        if (!group.active) return;
        if (message.header.msg_type === "comm_open") {
          const id = message.content.comm_id;
          if (!group.manager.has_model(id)) {
            const buffers = message.buffers.map(
              (b) => new DataView(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)).buffer),
            );
            await group.manager.handle_comm_open(group.comms.comm(id), {
              ...message,
              buffers,
            } as any);
          }
        } else await group.comms.receive(message);
        if (group.active && message.header.msg_type === "comm_msg")
          this.post({
            type: "tithon.widget-updated",
            comm_id: message.content.comm_id,
            scope: group.scope,
          });
      })
      .catch(() => this.disable(group, "Widget synchronization failed. Reconnect to refresh."))
      .finally(() => {
        group.queued -= 1;
        group.queuedBytes -= bytes;
      });
  }

  async render(
    id: string,
    payload: { scope: WidgetScope; state: WidgetStateSnapshot; model_id: string },
    host: HTMLElement,
  ): Promise<void> {
    this.dispose(id);
    const key = this.key(payload.scope);
    let group = this.groups.get(key);
    if (!group) {
      let created!: Group;
      const comms = new WidgetComms(payload.scope, this.post, (reason) =>
        this.disable(created, reason),
      );
      created = {
        scope: payload.scope,
        comms,
        manager: createManager((id) => comms.comm(id)),
        active: !this.revoked.has(this.binding(payload.scope)),
        serial: Promise.resolve(),
        queued: 0,
        queuedBytes: 0,
        items: new Set(),
      };
      if (!created.active) comms.dispose();
      group = created;
      this.groups.set(key, group);
    }
    const entry: { group: Group; host: HTMLElement; view?: any } = { group, host };
    this.items.set(id, entry);
    group.items.add(id);
    const target = group;
    target.serial = target.serial.then(async () => {
      const missing = Object.fromEntries(
        Object.entries(payload.state.state).filter(
          ([modelId]) => !target.manager.has_model(modelId),
        ),
      );
      await target.manager.set_state({ ...payload.state, state: missing } as any);
    });
    await target.serial;
    if (this.items.get(id) !== entry) return;
    const model = await target.manager.get_model(payload.model_id);
    entry.view = await target.manager.create_view(model!);
    if (this.items.get(id) !== entry) {
      entry.view.remove();
      return;
    }
    await target.manager.display_view(entry.view, host);
    if (!target.active) this.disable(target);
    else
      this.post({
        type: "tithon.widget-rendered",
        model_id: payload.model_id,
        mode: "html",
        scope: target.scope,
      });
  }

  dispose(id: string): void {
    const entry = this.items.get(id);
    if (!entry) return;
    entry.view?.remove();
    this.items.delete(id);
    entry.group.items.delete(id);
    if (!entry.group.items.size) {
      entry.group.active = false;
      entry.group.comms.dispose();
      this.groups.delete(this.key(entry.group.scope));
    }
  }
}
