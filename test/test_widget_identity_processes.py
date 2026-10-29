"""Real daemon replacement preserves historical widgets without rebinding them."""

import asyncio
import base64
import json
import sqlite3

from test_feature_processes import attach, request, run
from test_feature_processes import host as host
from websockets.asyncio.client import unix_connect

VIEW = "application/vnd.jupyter.widget-view+json"
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="


def snapshot(sock, sid, work):
    return asyncio.run(attach(sock, sid, work))[0]


def widget_code(value):
    return f"""import base64
import ipywidgets as widgets
from IPython.display import display
sentinel = 731
progress = widgets.IntProgress(value={value}, max=100, model_id='progress-shared')
image = widgets.Image(value=base64.b64decode('{PNG}'), format='png', model_id='image-shared')
group = widgets.VBox([progress, image], model_id='group-shared')
display(group)
print('VALUE', progress.value)
"""


def test_empty_history_has_distinct_actual_kernel_identity(host):
    root, work, env, start = host
    start()
    sock = root / "home/daemon.sock"
    first = snapshot(sock, "default", work)
    identity = first["widget_context"]["kernel_id"]
    assert isinstance(identity, str) and len(identity) == 64
    assert first["executions"] == []
    assert first["widget_context"]["active_model_ids"] == []
    killed = asyncio.run(request(sock, {"op": "kill_kernel", "target": "default"}))
    assert killed["ok"]
    second = snapshot(sock, "default", work)
    assert second["widget_context"]["kernel_id"] != identity
    assert second["kernel"]["pid"] != first["kernel"]["pid"]
    assert second["executions"] == []


def test_collision_crash_replay_retention_and_copied_state(host):
    root, work, env, start = host
    daemon = start()
    sock = root / "home/daemon.sock"
    source = work / "widgets.pynb"
    source.write_text("# %%\n" + widget_code(10))
    sid = source.as_uri()
    snapshot(sock, sid, work)
    reply = asyncio.run(request(sock, {"op": "restart_kernel", "session": sid}))
    assert reply["op"] == "kernel_restarted"

    async def live_and_replay():
        async with unix_connect(str(sock), max_size=None) as ws:
            await ws.send(
                json.dumps(
                    {"op": "attach", "session": sid, "workdir": str(work), "last_seen_seq": -1}
                )
            )
            sync = json.loads(await asyncio.wait_for(ws.recv(), 30))
            assert sync["op"] == "sync"
            assert sync["seq"] > 0
            await asyncio.to_thread(run, env, "run", "--session", sid, "-c", widget_code(10))
            live = []
            while True:
                frame = json.loads(await asyncio.wait_for(ws.recv(), 30))
                live.append(frame)
                if frame.get("kind") == "done":
                    break
        replay = await attach(sock, sid, work, sync["seq"])
        assert live == replay[:-1]
        comms = [frame for frame in live if frame.get("kind") == "widget"]
        assert comms and all(frame["payload"].get("_tithon_kernel_id") for frame in comms)
        return snapshot_data(comms)

    def snapshot_data(comms):
        return comms[0]["payload"]["_tithon_kernel_id"]

    first_id = asyncio.run(live_and_replay())
    first = snapshot(sock, sid, work)
    assert first["kernel"]["kernel_id"] == first_id
    assert "group-shared" in first["widget_context"]["active_model_ids"]
    first_models = first["widget_context"]["states"][first_id]["state"]
    assert first_models["progress-shared"]["state"]["value"] == 10
    assert base64.b64decode(first_models["image-shared"]["buffers"][0]["data"]) == base64.b64decode(
        PNG
    )
    first_widget = next(o for o in first["executions"][0]["outputs"] if VIEW in o.get("data", {}))
    assert first_widget["widget_kernel_id"] == first_id

    # Crash the actual daemon; PID and Python namespace must survive reattachment.
    daemon.kill()
    daemon.wait(timeout=10)
    sock.unlink(missing_ok=True)
    daemon = start("--history-retention-days", "0.000000001")
    restored = snapshot(sock, sid, work)
    assert restored["kernel"]["pid"] == first["kernel"]["pid"]
    assert restored["widget_context"] == first["widget_context"]
    assert restored["executions"][0]["outputs"] == first["executions"][0]["outputs"]
    assert (
        "SENTINEL 731"
        in run(env, "run", "--session", sid, "-c", "print('SENTINEL',sentinel)").stdout
    )
    assert restored["history_floor"] > 0
    journals = list((root / "home/sessions").rglob("journal.db"))
    assert len(journals) == 1
    with sqlite3.connect(journals[0]) as db:
        assert (
            db.execute("SELECT COUNT(*) FROM messages WHERE msg_type='display_data'").fetchone()[0]
            == 0
        )

    reply = asyncio.run(request(sock, {"op": "restart_kernel", "session": sid}))
    assert reply["op"] == "kernel_restarted"
    fresh = snapshot(sock, sid, work)
    second_id = fresh["widget_context"]["kernel_id"]
    assert second_id != first_id
    assert fresh["widget_context"]["active_model_ids"] == []
    run(env, "run", "--session", sid, "-c", widget_code(90))
    current = snapshot(sock, sid, work)
    context = current["widget_context"]
    assert context["states"][first_id]["state"]["progress-shared"]["state"]["value"] == 10
    assert context["states"][second_id]["state"]["progress-shared"]["state"]["value"] == 90
    assert (
        context["states"][first_id]["state"]["image-shared"]["buffers"]
        == first_models["image-shared"]["buffers"]
    )
    widget_outputs = [
        o for ex in current["executions"] for o in ex["outputs"] if VIEW in o.get("data", {})
    ]
    assert {o["widget_kernel_id"] for o in widget_outputs} == {first_id, second_id}

    # A sidecar carries both histories with independent saved model IDs and no authority.
    shared = json.loads((work / ".tithon/cells/widgets.pynb.json").read_text())
    assert "widget_context" not in shared
    model_ids = [
        o["data"][VIEW]["model_id"]
        for ex in shared["executions"]
        for o in ex["outputs"]
        if VIEW in o.get("data", {})
    ]
    assert len(set(model_ids)) == 2
    assert all("widget_kernel_id" not in o for ex in shared["executions"] for o in ex["outputs"])
    clone = work / "clone.pynb"
    clone.write_text(source.read_text())
    (work / ".tithon/cells/clone.pynb.json").write_text(json.dumps(shared))
    imported = snapshot(sock, clone.as_uri(), work)
    assert imported["widget_context"]["active_model_ids"] == []
    assert set(imported["widget_context"]["states"]) == {"saved"}
    saved = imported["widget_context"]["states"]["saved"]["state"]
    progress_ids = [
        saved[identity]["state"]["children"][0].removeprefix("IPY_MODEL_") for identity in model_ids
    ]
    assert sorted(saved[identity]["state"]["value"] for identity in progress_ids) == [10, 90]

    # Another real daemon crash verifies the scoped history survived retention seeds.
    daemon.kill()
    daemon.wait(timeout=10)
    sock.unlink(missing_ok=True)
    start()
    after = snapshot(sock, sid, work)
    assert after["widget_context"]["kernel_id"] == second_id
    assert after["widget_context"]["states"] == context["states"]
    assert {
        o["widget_kernel_id"]
        for ex in after["executions"]
        for o in ex["outputs"]
        if VIEW in o.get("data", {})
    } == {first_id, second_id}


def test_preupgrade_surviving_widgets_keep_readonly_live_updates(host):
    root, work, env, start = host
    daemon = start()
    sock = root / "home/daemon.sock"
    source = work / "legacy.pynb"
    source.write_text("# %%\n" + widget_code(10))
    sid = source.as_uri()
    snapshot(sock, sid, work)
    run(env, "run", "--session", sid, "-c", widget_code(10))
    original = snapshot(sock, sid, work)
    identity = original["kernel"]["kernel_id"]
    daemon.kill()
    daemon.wait(timeout=10)
    sock.unlink(missing_ok=True)
    journals = list((root / "home/sessions").rglob("journal.db"))
    assert len(journals) == 1
    # Reconstruct the pre-upgrade persisted shape while keeping the actual kernel.
    with sqlite3.connect(journals[0]) as db:
        for seq, content in db.execute("SELECT msg_seq, content_json FROM messages").fetchall():
            value = json.loads(content)
            value.pop("_tithon_kernel_id", None)
            value.pop("kernel_id", None)
            db.execute(
                "UPDATE messages SET content_json=? WHERE msg_seq=?", (json.dumps(value), seq)
            )
        for execution, folded in db.execute(
            "SELECT exec_id,folded_json FROM executions"
        ).fetchall():
            if folded:
                outputs = json.loads(folded)
                for output in outputs:
                    output.pop("widget_kernel_id", None)
                db.execute(
                    "UPDATE executions SET folded_json=? WHERE exec_id=?",
                    (json.dumps(outputs), execution),
                )
    daemon = start()
    migrated = snapshot(sock, sid, work)
    assert migrated["kernel"]["pid"] == original["kernel"]["pid"]
    assert migrated["widget_context"]["kernel_id"] == identity
    assert migrated["widget_context"]["legacy_kernel_id"] == identity
    assert migrated["widget_context"]["active_model_ids"] == []
    run(env, "run", "--session", sid, "-c", "progress.value = 40\ndisplay(progress)\n")
    live = snapshot(sock, sid, work)
    assert (
        live["widget_context"]["states"]["legacy"]["state"]["progress-shared"]["state"]["value"]
        == 40
    )
    assert live["widget_context"]["active_model_ids"] == []
    outputs = [o for ex in live["executions"] for o in ex["outputs"] if VIEW in o.get("data", {})]
    assert outputs and all(o["widget_kernel_id"] == "legacy" for o in outputs)
    # A replacement must never inherit the readonly live binding of its predecessor.
    asyncio.run(request(sock, {"op": "restart_kernel", "session": sid}))
    run(env, "run", "--session", sid, "-c", widget_code(90))
    after = snapshot(sock, sid, work)
    assert after["widget_context"]["kernel_id"] != identity
    assert after["widget_context"]["legacy_kernel_id"] == identity
    assert (
        after["widget_context"]["states"]["legacy"]["state"]["progress-shared"]["state"]["value"]
        == 40
    )
    daemon.kill()
    daemon.wait(timeout=10)
    sock.unlink(missing_ok=True)
    start()
    reattached = snapshot(sock, sid, work)
    assert reattached["widget_context"]["legacy_kernel_id"] == identity
    assert reattached["widget_context"]["kernel_id"] == after["widget_context"]["kernel_id"]
