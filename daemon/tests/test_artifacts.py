"""Rich-output artifact store: image payloads become real files, journaled as
references (SPEC.md, ADR-008). Pins the matplotlib path: a display_data
``image/png`` is decoded to a file + sha-deduped, the journal keeps only a
``$tithon_artifact`` ref, and the bytes are recoverable by artifact id (what
``Session.read_artifact`` / the ``get_artifact`` op serve to a client)."""
import base64

from tithon.artifacts import ArtifactStore
from tithon.journal import Journal

# 1x1 transparent PNG.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4"
    "2mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def _store(tmp_path):
    j = Journal(tmp_path / "journal.db")
    return j, ArtifactStore(tmp_path, j)


def test_image_extracted_to_file_and_ref(tmp_path):
    j, store = _store(tmp_path)
    content = {"data": {"image/png": base64.b64encode(PNG).decode(),
                        "text/plain": "<Figure size 640x480 with 1 Axes>"}}
    refs = store.extract("e1", content)

    assert len(refs) == 1
    # The base64 payload is gone from the journaled content — only a ref remains.
    ref = content["data"]["image/png"]
    assert "$tithon_artifact" in ref
    assert ref["$tithon_artifact"]["mime"] == "image/png"
    # text/plain is untouched (so a fallback renderer still has something).
    assert content["data"]["text/plain"].startswith("<Figure")
    # The real file exists and holds the original bytes.
    rel = ref["$tithon_artifact"]["rel_path"]
    assert (tmp_path / rel).read_bytes() == PNG


def test_artifact_recoverable_by_id(tmp_path):
    """The id -> bytes lookup that read_artifact / get_artifact rely on."""
    j, store = _store(tmp_path)
    content = {"data": {"image/png": base64.b64encode(PNG).decode()}}
    [art_id] = store.extract("e1", content)

    row = j.find_artifact(art_id)
    assert row is not None
    _, _, mime, rel_path, bytes_len = row
    assert mime == "image/png" and bytes_len == len(PNG)
    assert (tmp_path / rel_path).read_bytes() == PNG


def test_identical_image_is_deduped(tmp_path):
    j, store = _store(tmp_path)
    c1 = {"data": {"image/png": base64.b64encode(PNG).decode()}}
    c2 = {"data": {"image/png": base64.b64encode(PNG).decode()}}
    [id1] = store.extract("e1", c1)
    [id2] = store.extract("e2", c2)
    # Same sha -> same artifact id and the same on-disk file (no duplicate write).
    assert id1 == id2
    assert (c1["data"]["image/png"]["$tithon_artifact"]["rel_path"]
            == c2["data"]["image/png"]["$tithon_artifact"]["rel_path"])
    pngs = list((tmp_path / ".tithon" / "outputs").glob("*.png"))
    assert len(pngs) == 1


def test_non_image_data_untouched(tmp_path):
    j, store = _store(tmp_path)
    content = {"data": {"text/plain": "hello",
                        "application/vnd.jupyter.widget-view+json": {"model_id": "abc"}}}
    refs = store.extract("e1", content)
    assert refs == []
    assert content["data"]["text/plain"] == "hello"
    assert content["data"]["application/vnd.jupyter.widget-view+json"] == {"model_id": "abc"}
