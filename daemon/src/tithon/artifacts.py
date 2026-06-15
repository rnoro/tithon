"""Rich-output artifact store: image payloads become real files on disk.

Base64 image data never enters the journal (SPEC.md) — it is decoded
on receipt, written to ``<workdir>/.tithon/outputs/`` with an sha-based
filename, deduplicated by sha256, and the message content carries only a
``$tithon_artifact`` reference.
"""
from __future__ import annotations

import base64
import hashlib
from pathlib import Path

from .journal import Journal

EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg"}
OUTPUTS_REL = Path(".tithon") / "outputs"


class ArtifactStore:
    def __init__(self, workdir: Path, journal: Journal):
        self.workdir = workdir
        self.outputs_dir = workdir / OUTPUTS_REL
        self.journal = journal
        self._counter = 0

    def extract(self, exec_id: str, content: dict) -> list[str]:
        """Replace rich image mime payloads in ``content['data']`` with refs.

        Returns the artifact ids referenced (possibly empty). Mutates content.
        """
        data = content.get("data")
        if not isinstance(data, dict):
            return []
        refs: list[str] = []
        for mime, ext in EXTENSIONS.items():
            payload = data.get(mime)
            if not isinstance(payload, str):
                continue
            try:
                raw = base64.b64decode(payload, validate=False)
            except Exception:
                continue
            sha = hashlib.sha256(raw).hexdigest()
            existing = self.journal.find_artifact(sha)
            if existing is not None:
                rel_path = existing[3]
            else:
                self.outputs_dir.mkdir(parents=True, exist_ok=True)
                fname = f"{exec_id}_{self._counter}_{sha[:8]}.{ext}"
                self._counter += 1
                rel_path = str(OUTPUTS_REL / fname)
                (self.workdir / rel_path).write_bytes(raw)
                self.journal.register_artifact(sha, sha, mime, rel_path, len(raw))
            data[mime] = {
                "$tithon_artifact": {
                    "artifact_id": sha,
                    "mime": mime,
                    "rel_path": rel_path,
                    "sha256": sha,
                }
            }
            refs.append(sha)
        return refs
