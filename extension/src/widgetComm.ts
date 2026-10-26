/** Classic comm callbacks stay correlated until the kernel's IOPub idle. */
import type { WidgetScope } from "./richOutput";

export interface RawWidgetMessage {
  header: { msg_type: string; [key: string]: unknown };
  parent_header: { msg_id?: string; [key: string]: unknown };
  metadata: Record<string, unknown>;
  content: any;
  buffers: string[];
}

export class WidgetComms {
  private readonly comms = new Map<string, any>();
  private readonly pending = new Map<
    string,
    { callbacks: any; timer: ReturnType<typeof setTimeout> }
  >();
  private active = true;

  constructor(
    readonly scope: WidgetScope,
    private readonly post: (message: unknown) => void,
    private readonly failed: (message: string) => void,
  ) {}

  comm(id: string): any {
    if (this.comms.has(id)) return this.comms.get(id);
    const comm: any = {
      comm_id: id,
      target_name: "jupyter.widget",
      on_msg: (callback: any) => {
        comm.receive = callback;
      },
      on_close: (callback: any) => {
        comm.closed = callback;
      },
      open: () => {
        throw new Error("Frontend-created widget comms are unsupported");
      },
      close: () => "",
      send: (data: unknown, callbacks: any = {}, _metadata: unknown = {}, buffers: any[] = []) => {
        if (!this.active) throw new Error("Widget connection ended");
        if (this.pending.size >= 64) {
          this.fail("Too many pending widget messages. Reconnect to refresh.");
          throw new Error("Too many pending widget messages");
        }
        if (
          buffers.length > 64 ||
          buffers.reduce((size, buffer) => size + buffer.byteLength, 0) > 4 * 1024 * 1024
        )
          throw new Error("Widget buffers are too large");
        const encoded = buffers.map((buffer) => {
          const bytes =
            buffer instanceof ArrayBuffer
              ? new Uint8Array(buffer)
              : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          let text = "";
          for (let i = 0; i < bytes.length; i += 8192)
            text += String.fromCharCode(...bytes.subarray(i, i + 8192));
          return btoa(text);
        });
        if (JSON.stringify(data).length > 256 * 1024 || encoded.join("").length > 6 * 1024 * 1024)
          throw new Error("Widget message is too large");
        const requestId = crypto.randomUUID();
        const timer = setTimeout(
          () => this.fail("Widget response is uncertain; reconnect to refresh state"),
          60000,
        );
        this.pending.set(requestId, { callbacks, timer });
        this.post({
          type: "tithon.widget-send",
          scope: this.scope,
          request_id: requestId,
          comm_id: id,
          data,
          buffers: encoded,
        });
        return requestId;
      },
    };
    this.comms.set(id, comm);
    return comm;
  }

  async receive(raw: RawWidgetMessage): Promise<void> {
    if (!this.active) return;
    const message = {
      ...raw,
      buffers: (raw.buffers ?? []).map((value) => {
        const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
        return new DataView(bytes.buffer);
      }),
    };
    const kind = raw.header.msg_type;
    const comm = this.comms.get(raw.content?.comm_id);
    if (kind === "comm_msg") await comm?.receive?.(message);
    if (kind === "comm_close") {
      await comm?.closed?.(message);
      this.comms.delete(raw.content.comm_id);
    }
    const requestId = raw.parent_header?.msg_id;
    const pending = requestId ? this.pending.get(requestId) : undefined;
    await pending?.callbacks?.iopub?.[kind]?.(message);
    if (kind === "status" && raw.content.execution_state === "idle" && requestId) {
      if (pending) clearTimeout(pending.timer);
      this.pending.delete(requestId);
    }
  }

  fail(message: string): void {
    this.dispose();
    this.failed(message);
  }

  dispose(): void {
    this.active = false;
    for (const request of this.pending.values()) clearTimeout(request.timer);
    this.pending.clear();
  }
}
