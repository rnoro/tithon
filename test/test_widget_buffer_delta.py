"""RISKS #13: the comm delta frame (live broadcast AND attach-backlog replay,
via `event_from_message` — ADR-083's single builder) must carry binary
buffers when the underlying comm message had them, so a widget with
partly-binary state (e.g. `Image`) does not go stale between reconnects."""

import asyncio
import base64
import json

from tithon.daemon import Session, Subscriber
from tithon.journal import event_from_message


def make_session(tmp_path) -> Session:
    work = tmp_path / "work"
    work.mkdir(parents=True, exist_ok=True)
    return Session("default", tmp_path / "sess", work)


def test_event_from_message_forwards_buffers_when_present():
    encoded = base64.b64encode(b"hello").decode()
    content = {
        "comm_id": "c1",
        "data": {"state": {"value": 1}, "buffer_paths": [["value"]]},
        "_buffers_b64": [encoded],
    }
    ev = event_from_message(1, "e1", "comm_open", content)
    assert ev["kind"] == "widget"
    assert ev["payload"]["_buffers_b64"] == [encoded]
    assert ev["payload"]["data"]["buffer_paths"] == [["value"]]  # rides inside `data`, unchanged


def test_event_from_message_omits_buffers_field_when_absent():
    """No wire-size cost for the overwhelmingly common JSON-only widget tick."""
    content = {"comm_id": "c1", "data": {"state": {"value": 1}}}
    ev = event_from_message(1, "e1", "comm_msg", content)
    assert "_buffers_b64" not in ev["payload"]


def test_live_broadcast_and_replay_carry_identical_buffers(tmp_path):
    """ADR-083's invariant (one builder, live == replay) must hold for the
    buffer field too — not just comm_id/data as before this fix."""
    s = make_session(tmp_path)
    sub = Subscriber(asyncio.Queue(maxsize=100))
    s._subs.add(sub)

    payload = b"\x89PNG-fake-bytes"
    s._handle_comm(
        "e1",
        "comm_open",
        {
            "comm_id": "img1",
            "target_name": "jupyter.widget",
            "data": {
                "state": {"_model_name": "ImageModel", "format": "png"},
                "buffer_paths": [["value"]],
            },
        },
        [payload],
    )

    live = sub.queue.get_nowait()
    assert live["kind"] == "widget"
    assert live["payload"]["_buffers_b64"] == [base64.b64encode(payload).decode()]

    # Replay: rebuild the SAME frame directly from the journaled row.
    seq, exec_id, msg_type, content_json = s.journal.messages_after(0)[0]
    replayed = event_from_message(seq, exec_id, msg_type, json.loads(content_json))
    assert replayed == live


def test_buffer_bearing_comm_msg_also_carries_buffers_live_and_replayed(tmp_path):
    """Codex ② review, finding 4: coverage gap — all prior positive assertions
    used comm_open only. A comm_msg updating an EXISTING widget's buffer (the
    live-updating-Image case RISKS #13 exists for) must carry buffers too."""
    s = make_session(tmp_path)
    sub = Subscriber(asyncio.Queue(maxsize=100))
    s._subs.add(sub)

    s._handle_comm(
        "e1",
        "comm_open",
        {
            "comm_id": "img1",
            "target_name": "jupyter.widget",
            "data": {
                "state": {"_model_name": "ImageModel", "format": "png"},
                "buffer_paths": [["value"]],
            },
        },
        [b"first-frame"],
    )
    sub.queue.get_nowait()  # drain the comm_open broadcast

    new_frame = b"second-frame-updated-pixels"
    s._handle_comm(
        "e1",
        "comm_msg",
        {
            "comm_id": "img1",
            "data": {"method": "update", "buffer_paths": [["value"]]},
        },
        [new_frame],
    )

    live = sub.queue.get_nowait()
    assert live["payload"]["msg_type"] == "comm_msg"
    assert live["payload"]["_buffers_b64"] == [base64.b64encode(new_frame).decode()]

    seq, exec_id, msg_type, content_json = s.journal.messages_after(0)[1]  # the comm_msg row
    replayed = event_from_message(seq, exec_id, msg_type, json.loads(content_json))
    assert replayed == live
