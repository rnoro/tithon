"""Widget State Mirror — the daemon's "shadow frontend" (SPEC.md).

ipywidgets keep a kernel-side object in sync with a frontend model over a
Jupyter *comm* channel. Plain message replay can't restore that state, so the
daemon interprets the comm traffic itself and always holds the *current* widget
state as a snapshot in the canonical
``application/vnd.jupyter.widget-state+json`` shape.

- ``comm_open`` (target ``jupyter.widget``)  -> create a model from initial state
- ``comm_msg`` (method ``update`` / ``echo_update``) -> patch the model state
- ``comm_close`` -> drop the model

Binary buffers (``msg['buffers']`` + ``data['buffer_paths']``) are kept out of
the JSON state and carried separately, exactly as the widget-state schema
expects, so a fresh client attach restores them via html-manager's
``put_buffers``. Re-attach cost is the size of the final state, not the number
of updates — tqdm.notebook can update 50k times and the snapshot is one bar.
"""
from __future__ import annotations

import base64

WIDGET_TARGET = "jupyter.widget"
#: Public — the single authority for "is this a comm message", shared by
#: `is_comm()` and `journal.comm_messages_after()`'s SQL filter, so the two
#: can never silently diverge on a future addition.
COMM_TYPES = ("comm_open", "comm_msg", "comm_close")


def _is_state_shaped(data: dict) -> bool:
    """True iff `data["state"]` (when present) is dict-shaped and
    `data["buffer_paths"]` (when present) is a list of hashable paths —
    exactly what `apply()`'s mutation needs to not raise. A comm message is
    JSON-legal but not schema-legal when a buggy kernel/frontend sends e.g.
    `state: "garbage"`; `would_accept`/`apply` must REJECT that (not crash),
    or a malformed message journaled by `_handle_comm` (which journals before
    it mutates) would re-raise on every future `_rebuild_mirror` replay —
    turning a one-time in-memory failure into a permanent daemon-restart
    crash."""
    state = data.get("state")
    if state is not None and not isinstance(state, dict):
        return False
    paths = data.get("buffer_paths")
    if paths is not None:
        try:
            for p in paths:
                tuple(p)
        except TypeError:
            return False
    return True


class WidgetMirror:
    def __init__(self) -> None:
        # comm_id -> {"state": {...json attrs...}, "buffers": {path_tuple: bytes}}
        self._models: dict[str, dict] = {}

    def would_accept(self, msg_type: str, content: dict) -> bool:
        """Predict apply()'s accept/reject WITHOUT mutating — must stay in sync
        with apply()'s own guard clauses. Lets a caller journal before
        mutating (see daemon.py _handle_comm)."""
        if msg_type == "comm_open":
            if content.get("target_name") != WIDGET_TARGET or content.get("comm_id") is None:
                return False
            return _is_state_shaped(content.get("data") or {})
        if msg_type == "comm_msg":
            model = self._models.get(content.get("comm_id"))
            if model is None:
                return False
            data = content.get("data") or {}
            if data.get("method") not in ("update", "echo_update"):
                return False
            return _is_state_shaped(data)
        if msg_type == "comm_close":
            return content.get("comm_id") in self._models
        return False

    def apply(self, msg_type: str, content: dict, buffers=None) -> bool:
        """Update the mirror from one comm message. True if state changed.

        Never raises on JSON-legal-but-schema-malformed content (see
        `_is_state_shaped`) — validates and builds the full mutation before
        committing it to `self._models`, so a rejected message leaves NO
        partial state behind either.
        """
        buffers = list(buffers or [])
        if msg_type == "comm_open":
            if content.get("target_name") != WIDGET_TARGET:
                return False
            comm_id = content.get("comm_id")
            if comm_id is None:
                return False
            data = content.get("data") or {}
            if not _is_state_shaped(data):
                return False
            model = {"state": dict(data.get("state") or {}), "buffers": {}}
            self._merge_buffers(model, data.get("buffer_paths") or [], buffers)
            self._models[comm_id] = model  # commit only after the mutation fully built
            return True
        if msg_type == "comm_msg":
            comm_id = content.get("comm_id")
            model = self._models.get(comm_id)
            if model is None:
                return False
            data = content.get("data") or {}
            if data.get("method") not in ("update", "echo_update"):
                return False  # custom messages don't change persisted state
            if not _is_state_shaped(data):
                return False
            model["state"].update(data.get("state") or {})
            self._merge_buffers(model, data.get("buffer_paths") or [], buffers)
            return True
        if msg_type == "comm_close":
            return self._models.pop(content.get("comm_id"), None) is not None
        return False

    @staticmethod
    def _merge_buffers(model: dict, buffer_paths, buffers) -> None:
        for path, buf in zip(buffer_paths, buffers):
            model["buffers"][tuple(path)] = bytes(buf)

    def snapshot(self) -> dict:
        """Canonical ``widget-state+json`` of every live model."""
        state: dict[str, dict] = {}
        for comm_id, model in self._models.items():
            s = model["state"]
            state[comm_id] = {
                "model_name": s.get("_model_name"),
                "model_module": s.get("_model_module"),
                "model_module_version": s.get("_model_module_version"),
                "state": s,
                "buffers": [
                    {
                        "encoding": "base64",
                        "path": list(path),
                        "data": base64.b64encode(buf).decode("ascii"),
                    }
                    for path, buf in model["buffers"].items()
                ],
            }
        return {"version_major": 2, "version_minor": 0, "state": state}

    def __len__(self) -> int:
        return len(self._models)


def is_comm(msg_type: str) -> bool:
    return msg_type in COMM_TYPES
