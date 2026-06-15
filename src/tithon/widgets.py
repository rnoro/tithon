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
_COMM_TYPES = ("comm_open", "comm_msg", "comm_close")


class WidgetMirror:
    def __init__(self) -> None:
        # comm_id -> {"state": {...json attrs...}, "buffers": {path_tuple: bytes}}
        self._models: dict[str, dict] = {}

    def apply(self, msg_type: str, content: dict, buffers=None) -> bool:
        """Update the mirror from one comm message. True if state changed."""
        buffers = list(buffers or [])
        if msg_type == "comm_open":
            if content.get("target_name") != WIDGET_TARGET:
                return False
            comm_id = content.get("comm_id")
            if comm_id is None:
                return False
            data = content.get("data") or {}
            model = {"state": dict(data.get("state") or {}), "buffers": {}}
            self._models[comm_id] = model
            self._merge_buffers(model, data.get("buffer_paths") or [], buffers)
            return True
        if msg_type == "comm_msg":
            comm_id = content.get("comm_id")
            model = self._models.get(comm_id)
            if model is None:
                return False
            data = content.get("data") or {}
            if data.get("method") not in ("update", "echo_update"):
                return False  # custom messages don't change persisted state
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
    return msg_type in _COMM_TYPES
