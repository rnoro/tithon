"""``execute_reply.payload`` reaches the client (the ``?``/``??`` pager).

IPython does NOT publish the help pager on iopub — ``obj?`` puts its text in the
shell reply's ``payload`` list. A daemon that reads only ``status``/
``execution_count`` therefore renders NOTHING for the single most common IPython
idiom: no output, no error, a silent hole. This pins the fix: any payload
carrying ``text/plain`` becomes a stdout ``stream`` message, journaled + folded +
broadcast like any other output (matching vscode-jupyter's ``handleExecuteReply``).

``set_next_input`` (``%load``/``%recall``) is deliberately NOT acted on here — it
needs cell structure, which belongs to the client, so it must not cross into the
daemon. These tests pin that boundary too. v47.sh proves the end-to-end path on a
real kernel.
"""

from __future__ import annotations

import asyncio
import json

from tithon.daemon import Session, Subscriber
from tithon.folding import ExecutionFold


def make_session(tmp_path) -> Session:
    # Session.__init__ wires Journal/ArtifactStore without spawning a kernel.
    work = tmp_path / "work"
    work.mkdir(parents=True, exist_ok=True)
    return Session("default", tmp_path / "sess", work)


def seed_exec(s: Session, exec_id: str = "e1") -> ExecutionFold:
    """An execution mid-flight: row inserted, fold registered, nothing folded."""
    s.journal.insert_execution(exec_id, 1, "len?")
    fold = ExecutionFold()
    s._folds[exec_id] = fold
    return fold


PAGE = {
    "source": "page",
    "data": {"text/plain": "Signature: len(obj, /)\nDocstring: Return the number of items."},
    "start": 0,
}


def test_page_payload_becomes_stream_output(tmp_path):
    s = make_session(tmp_path)
    fold = seed_exec(s)

    s._emit_reply_payloads("e1", [PAGE])

    outs = fold.outputs()
    assert len(outs) == 1
    assert outs[0]["output_type"] == "stream"
    assert outs[0]["name"] == "stdout"
    assert "Signature: len(obj, /)" in outs[0]["text"]


def test_page_payload_is_journaled(tmp_path):
    """Journaled, not just broadcast — a reconnecting client must see the pager
    in its snapshot, exactly like any other output."""
    s = make_session(tmp_path)
    seed_exec(s)

    s._emit_reply_payloads("e1", [PAGE])

    msgs = [(t, json.loads(c)) for _seq, t, c in s.journal.messages_for_exec("e1")]
    assert [t for t, _ in msgs] == ["stream"]
    assert msgs[0][1]["name"] == "stdout"


def test_page_payload_is_broadcast_live(tmp_path):
    s = make_session(tmp_path)
    seed_exec(s)
    sub = Subscriber(asyncio.Queue())
    s._subs.add(sub)

    s._emit_reply_payloads("e1", [PAGE])

    ev = sub.queue.get_nowait()
    assert ev["kind"] == "output"
    assert ev["payload"]["msg_type"] == "stream"
    assert ev["exec_id"] == "e1"
    assert ev["seq"] > 0


def test_multiple_payloads_preserve_order(tmp_path):
    s = make_session(tmp_path)
    fold = seed_exec(s)

    s._emit_reply_payloads(
        "e1",
        [
            {"source": "page", "data": {"text/plain": "first"}},
            {"source": "page", "data": {"text/plain": "second"}},
        ],
    )

    # Consecutive same-name streams coalesce into one folded item (the buffer),
    # so order is asserted on the concatenated text, not on item count.
    text = "".join(o["text"] for o in fold.outputs() if o["output_type"] == "stream")
    assert text.index("first") < text.index("second")


def test_set_next_input_is_not_executed_by_the_daemon(tmp_path):
    """`set_next_input` carries `text`, NOT `data['text/plain']`. The daemon must
    ignore it: inserting a cell needs cell structure the daemon does not own."""
    s = make_session(tmp_path)
    fold = seed_exec(s)

    s._emit_reply_payloads(
        "e1", [{"source": "set_next_input", "text": "print('loaded')", "replace": False}]
    )

    assert fold.outputs() == []
    assert list(s.journal.messages_for_exec("e1")) == []


def test_payload_without_text_plain_is_ignored(tmp_path):
    s = make_session(tmp_path)
    fold = seed_exec(s)

    s._emit_reply_payloads("e1", [{"source": "page", "data": {"text/html": "<b>hi</b>"}}])

    assert fold.outputs() == []


def test_malformed_payloads_do_not_raise(tmp_path):
    """The payload list is kernel-controlled; a bad entry must not kill the
    exec worker (which would wedge every queued cell)."""
    s = make_session(tmp_path)
    fold = seed_exec(s)

    s._emit_reply_payloads("e1", [None, "junk", {}, {"data": None}, {"data": {}}, PAGE])

    assert len(fold.outputs()) == 1  # only the good one landed


def test_unknown_exec_id_is_a_noop(tmp_path):
    """A reply whose execution has no fold (already cleared/orphaned) must not
    create one — it would resurrect an output the user removed."""
    s = make_session(tmp_path)

    s._emit_reply_payloads("nope", [PAGE])

    assert "nope" not in s._folds


def test_empty_payload_list_writes_nothing(tmp_path):
    s = make_session(tmp_path)
    fold = seed_exec(s)

    s._emit_reply_payloads("e1", [])

    assert fold.outputs() == []
    assert list(s.journal.messages_for_exec("e1")) == []
