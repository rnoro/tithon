"""Folded output snapshots (materialized view of raw iopub messages).

Collapses the raw per-execution iopub message stream into the "current
display state" a live frontend would show:

- stream messages: terminal semantics for ``\r`` (carriage return),
  ``\n`` and ``\b`` so that tqdm-style progress collapses to its final line.
- ``clear_output`` (including ``wait=True`` deferred clear).
- ``update_display_data``: only the latest content per ``display_id``.

Pure logic, no I/O — unit-tested independently of the daemon.
"""
from __future__ import annotations

import re

_CTRL = re.compile(r"[\r\n\x08]")


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
    """Folds one execution's raw iopub messages into current output state."""

    def __init__(self) -> None:
        self._items: list[dict] = []
        self._pending_clear = False

    def apply(self, msg_type: str, content: dict) -> None:
        if msg_type == "clear_output":
            if content.get("wait"):
                self._pending_clear = True
            else:
                self._items.clear()
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
            return  # status, execute_input, comm_*, ... do not affect outputs

        if self._pending_clear:
            self._items.clear()
            self._pending_clear = False

        if msg_type == "stream":
            name = content.get("name", "stdout")
            text = content.get("text", "")
            last = self._items[-1] if self._items else None
            if last is not None and last["output_type"] == "stream" and last["name"] == name:
                last["_buf"].write(text)
            else:
                buf = StreamBuf()
                buf.write(text)
                self._items.append({"output_type": "stream", "name": name, "_buf": buf})
        elif msg_type == "display_data":
            item = {
                "output_type": "display_data",
                "data": content.get("data", {}),
                "metadata": content.get("metadata", {}),
            }
            did = (content.get("transient") or {}).get("display_id")
            if did is not None:
                item["display_id"] = did
            self._items.append(item)
        elif msg_type == "execute_result":
            self._items.append(
                {
                    "output_type": "execute_result",
                    "data": content.get("data", {}),
                    "metadata": content.get("metadata", {}),
                    "execution_count": content.get("execution_count"),
                }
            )
        elif msg_type == "error":
            self._items.append(
                {
                    "output_type": "error",
                    "ename": content.get("ename"),
                    "evalue": content.get("evalue"),
                    "traceback": content.get("traceback", []),
                }
            )

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
        out = []
        for it in self._items:
            if it["output_type"] == "stream":
                out.append({"output_type": "stream", "name": it["name"], "text": it["_buf"].text})
            else:
                out.append({k: v for k, v in it.items() if k != "_buf"})
        return out


def fold_messages(msgs: list[tuple[str, dict]]) -> list[dict]:
    """Fold a (msg_type, content) sequence into final output items."""
    f = ExecutionFold()
    for msg_type, content in msgs:
        f.apply(msg_type, content)
    return f.outputs()
