/**
 * Client-side folded output state (TS port of daemon/tithon/folding.py).
 *
 * The daemon's snapshot already carries folded `outputs` per execution, but a
 * *live* (or delta) attach streams raw iopub messages — the client must fold
 * them itself to keep the rendered cell output current. This is that fold,
 * matching the daemon's terminal semantics exactly so client and server agree:
 *
 *  - `stream` with `\r` / `\n` / `\b` terminal cursor handling (tqdm collapses),
 *  - `clear_output` (incl. deferred `wait=true`),
 *  - `update_display_data` updates the latest item per `display_id`,
 *  - `execute_result` / `error` / `display_data` append.
 *
 * `seed()` lets a fold resume from the daemon's already-folded snapshot outputs,
 * so a snapshot-introduced (possibly still-running) execution keeps folding
 * correctly as more live events arrive.
 */

const CTRL = /[\r\n\x08]/g;

/** Line buffer with terminal-ish cursor semantics (\r, \n, \b). */
class StreamBuf {
  private lines: string[] = [];
  private cur = "";
  private pos = 0;

  write(text: string): void {
    let idx = 0;
    CTRL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CTRL.exec(text)) !== null) {
      const seg = text.slice(idx, m.index);
      if (seg) this.emit(seg);
      const c = m[0];
      if (c === "\n") {
        this.lines.push(this.cur);
        this.cur = "";
        this.pos = 0;
      } else if (c === "\r") {
        this.pos = 0;
      } else {
        // \b
        if (this.pos) this.pos -= 1;
      }
      idx = m.index + 1;
    }
    const seg = text.slice(idx);
    if (seg) this.emit(seg);
  }

  private emit(seg: string): void {
    const end = this.pos + seg.length;
    this.cur = this.cur.slice(0, this.pos) + seg + this.cur.slice(end);
    this.pos = end;
  }

  get text(): string {
    let out = this.lines.join("\n");
    if (this.lines.length) out += "\n";
    return out + this.cur;
  }
}

export type OutputItem =
  | { output_type: "stream"; name: string; text: string }
  | { output_type: "display_data"; data: Record<string, unknown>; metadata?: Record<string, unknown>; display_id?: string }
  | { output_type: "execute_result"; data: Record<string, unknown>; metadata?: Record<string, unknown>; execution_count?: number | null }
  | { output_type: "error"; ename?: string; evalue?: string; traceback?: string[] };

interface StreamSlot {
  output_type: "stream";
  name: string;
  buf: StreamBuf;
}
type Slot = StreamSlot | (OutputItem & { display_id?: string });

/** Folds one execution's raw iopub messages into current output state. */
export class ExecutionFold {
  private items: Slot[] = [];
  private pendingClear = false;

  /** Seed from already-folded outputs (e.g. the daemon snapshot) so the fold
   *  can resume; stream items rebuild a live StreamBuf from their text. */
  seed(outputs: OutputItem[]): void {
    for (const o of outputs) {
      if (o.output_type === "stream") {
        const buf = new StreamBuf();
        buf.write(o.text);
        this.items.push({ output_type: "stream", name: o.name, buf });
      } else {
        this.items.push({ ...o });
      }
    }
  }

  apply(msgType: string, content: any): void {
    if (msgType === "clear_output") {
      if (content?.wait) this.pendingClear = true;
      else this.items = [];
      return;
    }
    if (msgType === "update_display_data") {
      const did = content?.transient?.display_id;
      if (did == null) return;
      for (const it of this.items) {
        if ((it as any).display_id === did) {
          (it as any).data = content?.data ?? {};
          (it as any).metadata = content?.metadata ?? {};
        }
      }
      return;
    }
    if (!["stream", "display_data", "execute_result", "error"].includes(msgType)) {
      return; // status, execute_input, comm_* ... do not affect outputs
    }

    if (this.pendingClear) {
      this.items = [];
      this.pendingClear = false;
    }

    if (msgType === "stream") {
      const name = content?.name ?? "stdout";
      const text = content?.text ?? "";
      const last = this.items.length ? this.items[this.items.length - 1] : undefined;
      if (last && last.output_type === "stream" && (last as StreamSlot).name === name) {
        (last as StreamSlot).buf.write(text);
      } else {
        const buf = new StreamBuf();
        buf.write(text);
        this.items.push({ output_type: "stream", name, buf });
      }
    } else if (msgType === "display_data") {
      const item: any = {
        output_type: "display_data",
        data: content?.data ?? {},
        metadata: content?.metadata ?? {},
      };
      const did = content?.transient?.display_id;
      if (did != null) item.display_id = did;
      this.items.push(item);
    } else if (msgType === "execute_result") {
      this.items.push({
        output_type: "execute_result",
        data: content?.data ?? {},
        metadata: content?.metadata ?? {},
        execution_count: content?.execution_count ?? null,
      });
    } else if (msgType === "error") {
      this.items.push({
        output_type: "error",
        ename: content?.ename,
        evalue: content?.evalue,
        traceback: content?.traceback ?? [],
      });
    }
  }

  outputs(): OutputItem[] {
    return this.items.map((it) => {
      if (it.output_type === "stream") {
        return { output_type: "stream", name: (it as StreamSlot).name, text: (it as StreamSlot).buf.text };
      }
      const { ...rest } = it as any;
      return rest as OutputItem;
    });
  }
}

/** Fold a (msgType, content) sequence into final output items. */
export function foldMessages(msgs: Array<[string, any]>): OutputItem[] {
  const f = new ExecutionFold();
  for (const [t, c] of msgs) f.apply(t, c);
  return f.outputs();
}
