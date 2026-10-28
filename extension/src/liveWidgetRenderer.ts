/** One live model registry per connection/kernel; output items own views only. */
import type { WidgetScope } from "./richOutput";
import { type RawWidgetMessage, WidgetComms } from "./widgetComm";
import { createManager, type WidgetStateSnapshot } from "./widgetRender";

const VIEW_SYNC_TIMEOUT_MS = 60_000;

type Group = {
  scope: WidgetScope;
  manager: ReturnType<typeof createManager>;
  comms: WidgetComms;
  allowCustom: boolean;
  failedModels: Set<string>;
  serial: Promise<void>;
  active: boolean;
  queued: number;
  queuedBytes: number;
  items: Set<string>;
};

export class LiveWidgetRenderer {
  private readonly groups = new Map<string, Group>();
  private readonly items = new Map<
    string,
    {
      group: Group;
      host: HTMLElement;
      modelId: string;
      models: Set<string>;
      token: string;
      pending: HTMLElement;
      timer?: ReturnType<typeof setTimeout>;
      view?: any;
    }
  >();
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
      clearTimeout(this.items.get(id)?.timer);
      host.inert = true;
      host.querySelector(".tithon-widget-pending")?.remove();
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

  private failModel(group: Group, modelId: string): void {
    group.failedModels.add(modelId);
    group.comms.disableComm(modelId);
    for (const id of group.items) {
      const entry = this.items.get(id);
      if (!entry?.models.has(modelId)) continue;
      clearTimeout(entry.timer);
      entry.host.inert = true;
      entry.pending.remove();
      if (!entry.host.querySelector(".tithon-widget-status")) {
        const note = document.createElement("div");
        note.className = "tithon-widget-status";
        note.textContent = "Widget failed. Reconnect to retry.";
        entry.host.appendChild(note);
      }
    }
  }

  receive(event: any): void {
    if (
      event?.type !== "tithon.widget-message" &&
      event?.type !== "tithon.widget-error" &&
      event?.type !== "tithon.widget-resync"
    )
      return;
    const group = event.scope ? this.groups.get(this.key(event.scope)) : undefined;
    if (!group?.active) return;
    if (event.type === "tithon.widget-error") {
      group.comms.fail(event.message);
      return;
    }
    const message = event.message as RawWidgetMessage;
    const state = event.type === "tithon.widget-resync" ? structuredClone(event.state) : undefined;
    const bytes = new TextEncoder().encode(JSON.stringify(state ?? message)).byteLength;
    if (group.queued >= 256 || group.queuedBytes + bytes > 8 * 1024 * 1024) {
      this.disable(group, "Widget updates exceeded the display buffer. Reconnect to refresh.");
      return;
    }
    group.queued += 1;
    group.queuedBytes += bytes;
    group.serial = group.serial
      .then(async () => {
        if (!group.active) return;
        if (state) {
          const entry = this.items.get(event.view_id);
          if (!entry || entry.group !== group || entry.token !== event.view_token) return;
          const existing = Object.fromEntries(
            Object.entries(state.state ?? {}).filter(([id]) => group.manager.has_model(id)),
          );
          if (!(entry.modelId in existing)) {
            clearTimeout(entry.timer);
            entry.pending.textContent = "Widget unavailable. Reconnect to refresh.";
            return;
          }
          await group.manager.set_state({ ...state, state: existing });
          if (group.active && this.items.get(event.view_id) === entry) {
            clearTimeout(entry.timer);
            entry.pending.remove();
            entry.host.inert = false;
          }
          return;
        }
        const commId = message.content?.comm_id;
        const commType = message.header.msg_type;
        if (typeof commId === "string" && group.failedModels.has(commId)) return;
        try {
          if (commType === "comm_open") {
            const id = message.content.comm_id;
            const moduleName = message.content?.data?.state?._model_module;
            if (
              typeof moduleName === "string" &&
              moduleName !== "@jupyter-widgets/base" &&
              moduleName !== "@jupyter-widgets/controls" &&
              !(moduleName === "anywidget" && group.allowCustom)
            )
              return;
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
        } catch (error) {
          if (
            typeof commId !== "string" ||
            !["comm_open", "comm_msg", "comm_close"].includes(commType)
          )
            throw error;
          this.failModel(group, commId);
          return;
        }
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
    payload: {
      scope: WidgetScope;
      state: WidgetStateSnapshot;
      model_id: string;
      allow_custom_widgets?: boolean;
    },
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
        manager: createManager((id) => comms.comm(id), payload.allow_custom_widgets === true),
        allowCustom: payload.allow_custom_widgets === true,
        failedModels: new Set(),
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
    group.allowCustom = payload.allow_custom_widgets === true;
    group.manager.setCustomAllowed(group.allowCustom);
    const pending = document.createElement("div");
    pending.className = "tithon-widget-pending";
    pending.textContent = "Synchronizing widget…";
    host.appendChild(pending);
    host.inert = true;
    const entry = {
      group,
      host,
      modelId: payload.model_id,
      models: new Set(Object.keys(payload.state.state)),
      token: crypto.randomUUID(),
      pending,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      view: undefined as any,
    };
    this.items.set(id, entry);
    group.items.add(id);
    const target = group;
    const loading = target.serial.then(async () => {
      if ([...entry.models].some((modelId) => target.failedModels.has(modelId)))
        throw new Error("Widget model is unavailable");
      const missing = Object.fromEntries(
        Object.entries(payload.state.state).filter(
          ([modelId]) => !target.manager.has_model(modelId),
        ),
      );
      await target.manager.set_state({ ...payload.state, state: missing } as any);
    });
    target.serial = loading.catch(() => undefined);
    await loading;
    if (this.items.get(id) !== entry) return;
    const model = await target.manager.get_model(payload.model_id);
    entry.view = await target.manager.create_view(model!);
    if (this.items.get(id) !== entry) {
      entry.view.remove();
      return;
    }
    await target.manager.display_view(entry.view, host);
    if (!target.active) this.disable(target);
    else {
      entry.timer = setTimeout(() => {
        if (this.items.get(id) === entry && target.active)
          entry.pending.textContent = "Widget synchronization timed out. Reconnect to refresh.";
      }, VIEW_SYNC_TIMEOUT_MS);
      this.post({
        type: "tithon.widget-rendered",
        model_id: payload.model_id,
        mode: "html",
        scope: target.scope,
        view_id: id,
        view_token: entry.token,
      });
    }
  }

  dispose(id: string): void {
    const entry = this.items.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.view?.remove();
    this.items.delete(id);
    entry.group.items.delete(id);
    if (!entry.group.items.size) {
      entry.group.active = false;
      entry.group.comms.dispose();
      this.groups.delete(this.key(entry.group.scope));
      void entry.group.serial
        .catch(() => undefined)
        .then(() => entry.group.manager.clear_state())
        .catch(() => undefined);
    }
  }
}
