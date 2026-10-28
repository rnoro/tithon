"""Actual socket-to-kernel comm transport, without executing widget actions as cells."""

import asyncio
import base64
import json
import os
import signal
import subprocess
import sys
import sysconfig
import time
from pathlib import Path
from types import SimpleNamespace

import psutil
import pytest
from test_feature_processes import host as host
from test_feature_processes import request, run
from websockets.asyncio.client import unix_connect

from tithon.daemon import Session
from tithon.widget_transport import MAX_WIDGET_BUFFERS, request_content

CODE = """import ipywidgets as w
from IPython.display import display
button = w.Button(model_id='button')
slider = w.IntSlider(value=0, max=100, model_id='slider')
label = w.Label(value='0', model_id='label')
image = w.Image(model_id='image')
clicks = 0
values = []
def clicked(_):
    global clicks
    clicks += 1
    label.value = str(clicks)
button.on_click(clicked)
slider.observe(lambda change: values.append(change['new']), names='value')
image.on_msg(lambda widget, data, buffers: image.send(data, buffers=buffers))
display(button, slider, label, image)
"""


async def recv(ws):
    return json.loads(await asyncio.wait_for(ws.recv(), 30))


async def connected(sock, binding):
    ws = await unix_connect(str(sock), max_size=None)
    await ws.send(json.dumps({"op": "attach", "widget_binding": binding}))
    snap = await recv(ws)
    assert snap["op"] == "snapshot"
    sync = await recv(ws)
    assert sync["op"] == "sync"
    return ws, snap


def action(identity, index, comm="button", data=None, **extra):
    return {
        "op": "widget_message",
        "session": "default",
        "kernel_id": identity,
        "binding": f"client-a:{identity}",
        "request_id": f"action-{index}",
        "request_seq": index,
        "comm_id": comm,
        "data": data or {"method": "custom", "content": {"event": "click"}},
        **extra,
    }


async def transact(ws, frame):
    await ws.send(json.dumps(frame))
    events = []
    ack = idle = False
    while not (ack and idle):
        reply = await recv(ws)
        if reply["op"] == "widget_ack":
            assert reply["ok"], reply
            assert reply["request_id"] == frame["request_id"]
            ack = True
        else:
            events.append(reply)
            if reply.get("kind") == "widget_status":
                payload = reply["payload"]
                assert payload["request_id"] == frame["request_id"]
                assert payload["binding"] == "client-a"
                assert payload["kernel_id"] == frame["kernel_id"]
                idle = payload["message"]["content"]["execution_state"] == "idle"
    return events


def test_real_comm_clicks_slider_correction_binary_and_replay(host):
    root, work, env, start = host
    start()
    run(env, "run", "-c", CODE)
    sock = root / "home/daemon.sock"

    async def check():
        ws, snap = await connected(sock, "client-a")
        peer, _ = await connected(sock, "client-b")
        identity = snap["kernel"]["kernel_id"]
        cursor = snap["max_seq"]
        live = []
        try:
            for index in range(1, 6):
                live += await transact(ws, action(identity, index))
            for index in range(6, 27):
                live += await transact(
                    ws,
                    action(
                        identity,
                        index,
                        "slider",
                        {"method": "update", "state": {"value": index - 5}, "buffer_paths": []},
                    ),
                )
            corrected = await transact(
                ws,
                action(
                    identity,
                    27,
                    "slider",
                    {"method": "update", "state": {"value": 999}, "buffer_paths": []},
                ),
            )
            live += corrected
            updates = [
                e["payload"]["data"]["state"]["value"]
                for e in corrected
                if e.get("kind") == "widget"
                and e["payload"]["comm_id"] == "slider"
                and "value" in e["payload"]["data"].get("state", {})
            ]
            assert updates == [999, 100]
            binary = await transact(
                ws,
                action(
                    identity,
                    28,
                    "image",
                    {"method": "custom", "content": {"event": "binary"}},
                    buffers=[
                        base64.b64encode(bytes([0, 255, 7])).decode(),
                        base64.b64encode(b"x" * (1024 * 1024)).decode(),
                    ],
                ),
            )
            live += binary
            raw = [e["payload"]["_tithon_message"] for e in binary if e.get("kind") == "widget"]
            assert any(
                m["buffers"] == ["AP8H", base64.b64encode(b"x" * (1024 * 1024)).decode()]
                for m in raw
            )
            assert all("msg_id" in m["parent_header"] for m in raw)
            # The same connection cannot resend a completed action sequence.
            await ws.send(json.dumps(action(identity, 1)))
            assert (await recv(ws))["ok"] is False
            # Peers observe exactly the journaled events, without replaying actions.
            observed = [await recv(peer) for _ in live]
            assert observed == live
            async with unix_connect(str(sock), max_size=None) as replay:
                await replay.send(json.dumps({"op": "attach", "last_seen_seq": cursor}))
                replayed = []
                while True:
                    frame = await recv(replay)
                    if frame["op"] == "sync":
                        break
                    replayed.append(frame)
                assert replayed == live
        finally:
            await ws.close()
            await peer.close()

    asyncio.run(check())
    result = run(env, "run", "-c", "print('STATE', clicks, slider.value, len(values), label.value)")
    assert "STATE 5 100 22 5" in result.stdout


def test_unknown_unattached_stale_and_cross_connection_actions_do_not_spawn(host):
    root, work, env, start = host
    start()
    sock = root / "home/daemon.sock"
    rejected = asyncio.run(request(sock, action("missing", 1, session="missing")))
    assert rejected["op"] == "widget_ack" and not rejected["ok"]
    assert not list((root / "home").rglob("kernel.json"))
    assert asyncio.run(request(sock, {"op": "status"}))["sessions"] == []
    run(env, "run", "-c", CODE)

    async def check():
        ws, snap = await connected(sock, "client-a")
        identity = snap["kernel"]["kernel_id"]
        try:
            for index, extra in enumerate(
                (
                    {"kernel_id": "stale"},
                    {"binding": "other"},
                    {"session": "other"},
                    {"comm_id": "unknown"},
                ),
                1,
            ):
                await ws.send(json.dumps(action(identity, index, **extra)))
                assert not (await recv(ws))["ok"]
            untouched = await asyncio.to_thread(run, env, "run", "-c", "print('CLICKS', clicks)")
            assert "CLICKS 0" in untouched.stdout
            # Cached idle status is insufficient when the actual process died.
            os.kill(snap["kernel"]["pid"], signal.SIGKILL)
            async with asyncio.timeout(10):
                while True:
                    try:
                        alive = (
                            psutil.Process(snap["kernel"]["pid"]).status() != psutil.STATUS_ZOMBIE
                        )
                    except psutil.NoSuchProcess:
                        alive = False
                    if not alive:
                        break
                    await asyncio.sleep(0.01)
            await ws.send(json.dumps(action(identity, 5)))
            while True:
                reply = await recv(ws)
                if reply["op"] == "widget_ack":
                    assert not reply["ok"]
                    break
            global_status = await request(sock, {"op": "status"})
            assert global_status["sessions"][0]["kernel_pid"] == snap["kernel"]["pid"]
        finally:
            await ws.close()

    asyncio.run(check())


def test_module_authorization_rejects_reused_pid_with_matching_argv():
    kernel = SimpleNamespace(
        kernel_id="original", pid=123, is_alive=lambda: True, _identity=lambda _: "replacement"
    )
    mirror = SimpleNamespace(declares_module=lambda _name, _version: True)
    session = SimpleNamespace(
        kernel=kernel,
        _widget_mirrors={"original": mirror},
        _killed=False,
        _restarting=False,
        kc=object(),
        kernel_status="idle",
    )
    request = {
        "kernel_id": "original",
        "binding": "client:original",
        "module": "chart",
        "version": "^1.0.0",
    }
    assert not Session.widget_module_authorized(session, request, "client")
    kernel._identity = lambda _: "original"
    assert Session.widget_module_authorized(session, request, "client")


def test_module_download_requires_attached_current_kernel_and_declared_version(host):
    root, work, env, start = host
    start()
    sock = root / "home/daemon.sock"
    frame = {
        "op": "widget_module",
        "session": "default",
        "kernel_id": "missing",
        "binding": "client-a:missing",
        "request_id": "module-1",
        "module": "bqplot",
        "version": "^0.6.1",
    }
    result = asyncio.run(request(sock, frame))
    assert result["op"] == "widget_module_result" and not result["ok"]
    assert not list((root / "home").rglob("kernel.json"))
    run(
        env,
        "run",
        "-c",
        "import bqplot as bq\nfrom IPython.display import display\nfig=bq.Figure()\ndisplay(fig)",
    )

    async def check():
        ws, snap = await connected(sock, "client-a")
        identity = snap["kernel"]["kernel_id"]
        valid = {**frame, "kernel_id": identity, "binding": f"client-a:{identity}"}
        try:
            for invalid in (
                {"kernel_id": "stale"},
                {"binding": "other"},
                {"session": "other"},
                {"module": "bqscales"},
                {"version": "^9.0.0"},
                {"module": "../secret"},
            ):
                await ws.send(json.dumps({**valid, **invalid}))
                response = await recv(ws)
                assert response["op"] == "widget_module_result" and not response["ok"]
            await ws.send(json.dumps(valid))
            response = await recv(ws)
            assert response["ok"] and response["name"] == "bqplot"
            assert response["version"] == "0.6.1"
            assert 'define(["@jupyter-widgets/base"]' in response["source"][:150]
        finally:
            await ws.close()

    asyncio.run(check())


def test_module_download_uses_surviving_kernel_environment_after_daemon_switch(host):
    root, work, env, start = host
    first = start()
    run(
        env,
        "run",
        "-c",
        "import bqplot as bq\nfrom IPython.display import display\ndisplay(bq.Figure())",
    )
    sock = root / "home/daemon.sock"

    async def identity():
        ws, snapshot = await connected(sock, "client-a")
        await ws.close()
        return snapshot["kernel"]

    original = asyncio.run(identity())
    first.kill()
    first.wait(timeout=10)
    sock.unlink(missing_ok=True)
    alternative = root / "alternative"
    subprocess.run(
        [sys.executable, "-m", "venv", "--without-pip", str(alternative)], check=True, timeout=30
    )
    sites = list(alternative.glob("lib/python*/site-packages"))
    assert len(sites) == 1
    (sites[0] / "tithon-test.pth").write_text(
        sysconfig.get_path("purelib")
        + "\n"
        + str(Path(__file__).resolve().parents[1] / "src")
        + "\n"
    )
    with (root / "alternative-daemon.log").open("ab") as log:
        other = subprocess.Popen(
            [str(alternative / "bin/python"), "-m", "tithon", "daemon"],
            cwd=work,
            env=env,
            stdout=log,
            stderr=log,
        )
    try:
        deadline = time.monotonic() + 20
        while not sock.exists():
            if other.poll() is not None or time.monotonic() >= deadline:
                pytest.fail((root / "alternative-daemon.log").read_text())
            time.sleep(0.05)

        async def check():
            ws, snapshot = await connected(sock, "client-a")
            try:
                assert snapshot["kernel"]["pid"] == original["pid"]
                assert snapshot["kernel"]["kernel_id"] == original["kernel_id"]
                await ws.send(
                    json.dumps(
                        {
                            "op": "widget_module",
                            "session": "default",
                            "kernel_id": original["kernel_id"],
                            "binding": f"client-a:{original['kernel_id']}",
                            "request_id": "after-reattach",
                            "module": "bqplot",
                            "version": "^0.6.1",
                        }
                    )
                )
                response = await recv(ws)
                assert response["ok"] and response["version"] == "0.6.1", response
            finally:
                await ws.close()

        asyncio.run(check())
    finally:
        other.terminate()
        other.wait(timeout=10)


@pytest.mark.parametrize(
    "extra",
    [
        {"data": {"method": "execute", "code": "danger"}},
        {"data": {"method": "update", "state": []}},
        {"buffers": ["!"]},
        {"buffers": [None]},
        {"buffers": [base64.b64encode(b"x" * (MAX_WIDGET_BUFFERS + 1)).decode()]},
    ],
)
def test_invalid_comm_frames_are_rejected(extra):
    with pytest.raises((ValueError, TypeError)):
        request_content(action("kernel", 1, **extra))
