"""Folded output snapshots (materialized view of raw iopub messages).

Collapses the raw per-execution iopub message stream into the "current
display state" a live frontend would show:

- stream messages: terminal semantics for ``\r`` (carriage return),
  ``\n`` and ``\b`` so that tqdm-style progress collapses to its final line.
- ``clear_output`` (including ``wait=True`` deferred clear).
- ``update_display_data``: only the latest content per ``display_id``.
- ``ipywidgets.Output`` **output areas**: see `ExecutionFold` on claims.

Pure logic, no I/O — unit-tested independently of the daemon.
"""
from __future__ import annotations

import re

_CTRL = re.compile(r"[\r\n\x08]")

#: Key a DAEMON-SYNTHESIZED message carries to force cell scope, overriding any
#: Output claim active at the time. Only the kernel's own iopub is subject to a
#: claim; a message the daemon invented (the user's "Clear Outputs", a shell
#: `execute_reply` payload, a kernel-death error) is about the CELL and must not
#: be captured by whatever widget happened to be claiming. It travels IN the
#: synthetic message so `_rebuild_folds` derives the same scope from the journal
#: alone — a live-only flag would make a restart fold differently. Safe to add:
#: these messages are the daemon's own, so the "preserve kernel messages
#: verbatim" invariant does not cover them, and every client reads only the
#: fields it knows (`wait`, `name`/`text`, `ename`/...).
SCOPE_KEY = "tithon_scope"
SCOPE_CELL = "cell"

#: Comm message types the fold consumes for claim tracking ONLY — they never
#: produce an output item. Duplicated from `widgets.COMM_TYPES` deliberately:
#: folding.py is pure logic with no widgets import, and the two lists answer
#: different questions ("does this carry widget state" vs "does this move an
#: output area's claim").
_COMM = ("comm_open", "comm_msg", "comm_close")


class StreamBuf:
    """Line buffer with terminal-ish cursor semantics (\\r, \\n, \\b)."""

    __slots__ = ("lines", "cur", "pos")

    def __init__(self) -> None:
        self.lines: list[str] = []
        self.cur = ""
        self.pos = 0

    def write(self, text: str) -> None:
        idx = 0
        for m in _CTRL.finditer(text):
            seg = text[idx : m.start()]
            if seg:
                self._emit(seg)
            c = m.group()
            if c == "\n":
                self.lines.append(self.cur)
                self.cur = ""
                self.pos = 0
            elif c == "\r":
                self.pos = 0
            else:  # \b
                if self.pos:
                    self.pos -= 1
            idx = m.end()
        seg = text[idx:]
        if seg:
            self._emit(seg)

    def _emit(self, seg: str) -> None:
        end = self.pos + len(seg)
        self.cur = self.cur[: self.pos] + seg + self.cur[end:]
        self.pos = end

    @property
    def text(self) -> str:
        out = "\n".join(self.lines)
        if self.lines:
            out += "\n"
        return out + self.cur


class ExecutionFold:
    """Folds one execution's raw iopub messages into current output state.

    A cell is not one output area. `ipywidgets.Output` implements capture by
    CLAIMING the running cell's request msg_id (`__enter__` sets its `msg_id`
    trait, `__exit__` sets it back to ""), and every output published while the
    claim holds belongs to that widget's area, not to the cell. Crucially
    `Output.clear_output()` wraps itself in `with self:`, so its `clear_output`
    arrives under the claim — folding it as a cell-wide clear destroys the
    cell's OTHER outputs — a training loop showing a tqdm bar next to a live
    plot would lose the bar the instant the first frame is drawn.

    So each item remembers the area that produced it (`_owner`, a comm_id, or
    absent for the cell itself) and a clear only reaches its own area. Claims
    nest — two different Output widgets can hold the same msg_id at once — so
    they are a LIFO stack, not one current owner.

    Claim state is derived from the comm messages themselves, which are
    journaled under the same exec_id and replayed in seq order, so a rebuilt
    fold reaches the identical state as the live one without any side channel.
    """

    def __init__(self) -> None:
        self._items: list[dict] = []
        self._pending_clear = False
        # Output areas claiming this execution's msg_id, innermost last.
        self._claims: list[str] = []
        # Areas holding a deferred (`wait=True`) clear. Per area, because a
        # clear is consumed by the next output in the SAME area — a cell-level
        # write must not discharge a widget's pending clear, or vice versa.
        self._pending_owner_clear: set[str] = set()

    def _owner_for(self, content: dict) -> str | None:
        """The area a message belongs to: the innermost claim, unless the
        message is daemon-synthesized and forced to cell scope (`SCOPE_KEY`)."""
        if content.get(SCOPE_KEY) == SCOPE_CELL:
            return None
        return self._claims[-1] if self._claims else None

    def _drop(self, owner: str | None) -> None:
        """Clear one area. Cell scope takes the whole cell WITH every area in
        it (that is what the user's "Clear Outputs" means), so it also discards
        the areas' deferred clears — leaving one armed would let the next
        widget write wipe output produced after the clear."""
        if owner is None:
            self._items.clear()
            self._pending_owner_clear.clear()
        else:
            self._items = [it for it in self._items if it.get("_owner") != owner]

    def _apply_comm(self, msg_type: str, content: dict) -> None:
        comm_id = content.get("comm_id")
        if comm_id is None:
            return
        if msg_type == "comm_close":
            # A widget torn down without releasing (kernel death mid-`with`,
            # or an explicit close) must not hold the claim forever.
            while comm_id in self._claims:
                self._claims.remove(comm_id)
            self._pending_owner_clear.discard(comm_id)
            return
        if msg_type != "comm_msg":
            return  # comm_open: a fresh Output's msg_id is "" — never a claim
        data = content.get("data") or {}
        if data.get("method") not in ("update", "echo_update"):
            return
        state = data.get("state")
        if not isinstance(state, dict) or "msg_id" not in state:
            return
        if state.get("msg_id"):
            if comm_id not in self._claims:
                self._claims.append(comm_id)
        else:
            while comm_id in self._claims:
                self._claims.remove(comm_id)

    def apply(self, msg_type: str, content: dict) -> None:
        if msg_type in _COMM:
            self._apply_comm(msg_type, content)
            return
        owner = self._owner_for(content)
        if msg_type == "clear_output":
            if content.get("wait"):
                if owner is None:
                    self._pending_clear = True
                else:
                    self._pending_owner_clear.add(owner)
            else:
                self._drop(owner)
            return
        if msg_type == "update_display_data":
            did = (content.get("transient") or {}).get("display_id")
            if did is None:
                return
            for it in self._items:
                if it.get("display_id") == did:
                    it["data"] = content.get("data", {})
                    it["metadata"] = content.get("metadata", {})
            return
        if msg_type not in ("stream", "display_data", "execute_result", "error"):
            return  # status, execute_input, ... do not affect outputs

        # A deferred clear is discharged by the next output in its OWN area.
        if owner is None:
            if self._pending_clear:
                self._items.clear()
                self._pending_clear = False
        elif owner in self._pending_owner_clear:
            self._drop(owner)
            self._pending_owner_clear.discard(owner)

        if msg_type == "stream":
            name = content.get("name", "stdout")
            text = content.get("text", "")
            last = self._last_in_area(owner)
            # The merge candidate is the last item in THIS area, not the last
            # item overall: a real frontend keeps each area's outputs in its own
            # list, so an interleaved widget frame does not interrupt the cell's
            # stream. Honouring the flat order here instead would restart the
            # stream item on every frame — a `\r` progress line printed beside a
            # live plot would fold to one line PER FRAME (measured: 118 items for
            # 118 steps) rather than the single updating line the user wrote.
            # An item in the SAME area still breaks the run, matching Jupyter.
            if (last is not None and last["output_type"] == "stream"
                    and last["name"] == name):
                last["_buf"].write(text)
            else:
                buf = StreamBuf()
                buf.write(text)
                self._items.append(self._own({"output_type": "stream", "name": name, "_buf": buf}, owner))
        elif msg_type == "display_data":
            item = {
                "output_type": "display_data",
                "data": content.get("data", {}),
                "metadata": content.get("metadata", {}),
            }
            did = (content.get("transient") or {}).get("display_id")
            if did is not None:
                item["display_id"] = did
            self._items.append(self._own(item, owner))
        elif msg_type == "execute_result":
            self._items.append(
                self._own(
                    {
                        "output_type": "execute_result",
                        "data": content.get("data", {}),
                        "metadata": content.get("metadata", {}),
                        "execution_count": content.get("execution_count"),
                    },
                    owner,
                )
            )
        elif msg_type == "error":
            self._items.append(
                self._own(
                    {
                        "output_type": "error",
                        "ename": content.get("ename"),
                        "evalue": content.get("evalue"),
                        "traceback": content.get("traceback", []),
                    },
                    owner,
                )
            )

    @classmethod
    def hydrate(cls, outputs: list[dict], state: dict | None = None) -> "ExecutionFold":
        """Rebuild a fold from a persisted `outputs()` + `fold_state()` pair.

        The inverse of those two, for an execution whose raw messages are NOT in
        this journal — one imported from a shared sidecar (see `sidecar.py`).
        Such an execution must not rebuild as an empty fold: `artifact_ids()`
        feeds the startup GC refcount, so an empty one would make the sweep
        delete the very image files the import brought in.
        """
        fold = cls()
        owners = (state or {}).get("owners") or []
        for i, item in enumerate(outputs):
            owner = owners[i] if i < len(owners) else None
            if item.get("output_type") == "stream":
                buf = StreamBuf()
                buf.write(item.get("text", ""))
                it = {"output_type": "stream", "name": item.get("name", "stdout"), "_buf": buf}
            else:
                it = dict(item)
            fold._items.append(cls._own(it, owner))
        if state:
            fold._claims = list(state.get("claims") or [])
            fold._pending_clear = bool(state.get("pending_clear"))
            fold._pending_owner_clear = set(state.get("pending_owner_clear") or [])
        return fold

    def fold_state(self) -> dict:
        """Continuation state a client needs BEYOND `outputs()` to keep folding
        identically. `outputs()` is renderable output only, so a client seeded
        from it alone would treat every item as the cell's own and scope no
        clear — a plot repainted inside an `Output` would then accumulate one
        frame per step instead of superseding. `owners` is index-aligned with
        `outputs()`: both walk `_items` in order."""
        return {
            "owners": [it.get("_owner") for it in self._items],
            "claims": list(self._claims),
            "pending_clear": self._pending_clear,
            "pending_owner_clear": sorted(self._pending_owner_clear),
        }

    def _last_in_area(self, owner: str | None) -> dict | None:
        """The most recent item belonging to `owner`, ignoring other areas."""
        for it in reversed(self._items):
            if it.get("_owner") == owner:
                return it
        return None

    @staticmethod
    def _own(item: dict, owner: str | None) -> dict:
        if owner is not None:
            item["_owner"] = owner
        return item

    def artifact_ids(self) -> set[str]:
        """Artifact ids referenced by the CURRENT folded output.

        A frame dropped by ``clear_output``/``update_display_data`` leaves this
        set, which the daemon uses to GC its no-longer-referenced file.
        """
        ids: set[str] = set()
        for it in self._items:
            data = it.get("data")
            if not isinstance(data, dict):
                continue
            for v in data.values():
                ref = v.get("$tithon_artifact") if isinstance(v, dict) else None
                if isinstance(ref, dict) and "artifact_id" in ref:
                    ids.add(ref["artifact_id"])
        return ids

    def outputs(self) -> list[dict]:
        """The renderable snapshot. Bookkeeping keys are `_`-prefixed and never
        cross the wire — `_owner` is fold-internal, and a client seeded from
        this loses it, so a client reconnecting mid-claim cannot scope its own
        subsequent clears: the snapshot needs a continuation sidecar before
        `outputFold.ts` can be scoped too."""
        out = []
        for it in self._items:
            if it["output_type"] == "stream":
                out.append({"output_type": "stream", "name": it["name"], "text": it["_buf"].text})
            else:
                out.append({k: v for k, v in it.items() if not k.startswith("_")})
        return out


def fold_messages(msgs: list[tuple[str, dict]]) -> list[dict]:
    """Fold a (msg_type, content) sequence into final output items."""
    f = ExecutionFold()
    for msg_type, content in msgs:
        f.apply(msg_type, content)
    return f.outputs()
