/**
 * Client-side folded output state (TS port of src/tithon/folding.py).
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters ARE the subject — this buffer exists to give \r, \n and \b their terminal cursor meaning.
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
    // biome-ignore lint/suspicious/noAssignInExpressions: assigning in the condition is how a /g regex is walked; splitting it needs a second exec call that can drift from this one.
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
  | {
      output_type: "display_data";
      data: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      display_id?: string;
    }
  | {
      output_type: "execute_result";
      data: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      execution_count?: number | null;
    }
  | { output_type: "error"; ename?: string; evalue?: string; traceback?: string[] };

interface StreamSlot {
  output_type: "stream";
  name: string;
  buf: StreamBuf;
}
type Slot = (StreamSlot | (OutputItem & { display_id?: string })) & { owner?: string };

/** Key a daemon-SYNTHESIZED message carries to force cell scope. Mirrors
 *  `folding.SCOPE_KEY` / `SCOPE_CELL`. */
const SCOPE_KEY = "tithon_scope";
const SCOPE_CELL = "cell";
const COMM = ["comm_open", "comm_msg", "comm_close"];

/**
 * Fold continuation state — everything a resuming client needs BEYOND the
 * renderable outputs to keep folding identically to the daemon. The daemon
 * sends it beside `outputs` in the snapshot; without it a client attaching
 * mid-claim would treat every item as cell-owned and scope nothing.
 */
export interface FoldState {
  /** Owner per item, index-aligned with `outputs()`; null = the cell itself. */
  owners?: (string | null)[];
  claims?: string[];
  pending_clear?: boolean;
  pending_owner_clear?: string[];
}

/** Folds one execution's raw iopub messages into current output state. */
export class ExecutionFold {
  private items: Slot[] = [];
  private pendingClear = false;
  // See folding.py's ExecutionFold: a cell is not one output area. An
  // ipywidgets Output claims the cell's msg_id and its clear_output arrives
  // under that claim, so a cell-wide clear would destroy sibling outputs.
  private claims: string[] = [];
  private pendingOwnerClear = new Set<string>();

  /** Seed from already-folded outputs (e.g. the daemon snapshot) so the fold
   *  can resume; stream items rebuild a live StreamBuf from their text. */
  seed(outputs: OutputItem[], state?: FoldState): void {
    const owners = state?.owners ?? [];
    outputs.forEach((o, i) => {
      const owner = owners[i] ?? undefined;
      if (o.output_type === "stream") {
        const buf = new StreamBuf();
        buf.write(o.text);
        this.items.push({ output_type: "stream", name: o.name, buf, owner });
      } else {
        this.items.push({ ...o, owner });
      }
    });
    this.claims = [...(state?.claims ?? [])];
    this.pendingClear = state?.pending_clear ?? false;
    this.pendingOwnerClear = new Set(state?.pending_owner_clear ?? []);
  }

  private ownerFor(content: any): string | undefined {
    if (content?.[SCOPE_KEY] === SCOPE_CELL) return undefined;
    return this.claims.length ? this.claims[this.claims.length - 1] : undefined;
  }

  private drop(owner: string | undefined): void {
    if (owner === undefined) {
      this.items = [];
      this.pendingOwnerClear.clear();
    } else {
      this.items = this.items.filter((it) => it.owner !== owner);
    }
  }

  private lastInArea(owner: string | undefined): Slot | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].owner === owner) return this.items[i];
    }
    return undefined;
  }

  private applyComm(msgType: string, content: any): void {
    const commId = content?.comm_id;
    if (commId == null) return;
    if (msgType === "comm_close") {
      this.claims = this.claims.filter((c) => c !== commId);
      this.pendingOwnerClear.delete(commId);
      return;
    }
    if (msgType !== "comm_msg") return; // comm_open: a fresh Output's msg_id is ""
    const data = content?.data ?? {};
    if (data.method !== "update" && data.method !== "echo_update") return;
    const state = data.state;
    if (state == null || typeof state !== "object" || !("msg_id" in state)) return;
    if (state.msg_id) {
      if (!this.claims.includes(commId)) this.claims.push(commId);
    } else {
      this.claims = this.claims.filter((c) => c !== commId);
    }
  }

  apply(msgType: string, content: any): void {
    if (COMM.includes(msgType)) {
      this.applyComm(msgType, content);
      return;
    }
    const owner = this.ownerFor(content);
    if (msgType === "clear_output") {
      if (content?.wait) {
        if (owner === undefined) this.pendingClear = true;
        else this.pendingOwnerClear.add(owner);
      } else {
        this.drop(owner);
      }
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
      return; // status, execute_input ... do not affect outputs
    }

    // A deferred clear is discharged by the next output in its OWN area.
    if (owner === undefined) {
      if (this.pendingClear) {
        this.items = [];
        this.pendingClear = false;
      }
    } else if (this.pendingOwnerClear.has(owner)) {
      this.drop(owner);
      this.pendingOwnerClear.delete(owner);
    }

    if (msgType === "stream") {
      const name = content?.name ?? "stdout";
      const text = content?.text ?? "";
      // The merge candidate is the last item in THIS area, not the last overall:
      // an interleaved widget frame must not interrupt the cell's stream, or a
      // `\r` progress line beside a live plot folds to one line PER FRAME.
      const last = this.lastInArea(owner);
      if (last && last.output_type === "stream" && (last as StreamSlot).name === name) {
        (last as StreamSlot).buf.write(text);
      } else {
        const buf = new StreamBuf();
        buf.write(text);
        this.items.push({ output_type: "stream", name, buf, owner });
      }
    } else if (msgType === "display_data") {
      const item: any = {
        output_type: "display_data",
        data: content?.data ?? {},
        metadata: content?.metadata ?? {},
        owner,
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
        owner,
      });
    } else if (msgType === "error") {
      this.items.push({
        output_type: "error",
        ename: content?.ename,
        evalue: content?.evalue,
        traceback: content?.traceback ?? [],
        owner,
      });
    }
  }

  outputs(): OutputItem[] {
    return this.items.map((it) => {
      if (it.output_type === "stream") {
        return {
          output_type: "stream",
          name: (it as StreamSlot).name,
          text: (it as StreamSlot).buf.text,
        };
      }
      const { owner: _owner, ...rest } = it as any;
      return rest as OutputItem;
    });
  }

  /** The continuation state a peer needs to keep folding identically. Mirrors
   *  `folding.ExecutionFold.fold_state()`; `owners` is index-aligned with
   *  `outputs()` because both walk `items` in order. */
  state(): FoldState {
    return {
      owners: this.items.map((it) => it.owner ?? null),
      claims: [...this.claims],
      pending_clear: this.pendingClear,
      pending_owner_clear: [...this.pendingOwnerClear],
    };
  }
}

/** Fold a (msgType, content) sequence into final output items. */
export function foldMessages(msgs: Array<[string, any]>): OutputItem[] {
  const f = new ExecutionFold();
  for (const [t, c] of msgs) f.apply(t, c);
  return f.outputs();
}
