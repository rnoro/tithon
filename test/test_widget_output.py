"""Callback output has durable owners without submitting another execution."""

import asyncio
import json

from test_feature_processes import host as host
from test_feature_processes import run
from test_widget_transport import action, recv, transact
from websockets.asyncio.client import unix_connect

from tithon import sidecar

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
CODE = f"""import ipywidgets as w
from IPython.display import display, HTML, Image, clear_output
import base64
button = w.Button(model_id='button')
out = w.Output(model_id='out')
clicks = 0
def clicked(_):
    global clicks
    clicks += 1
    print('PLAIN', clicks, flush=True)
    if clicks == 3:
        raise RuntimeError('plain-error')
    with out:
        clear_output(wait=True)
        print('CAPTURE', clicks, flush=True)
        display(HTML('<b>captured-%s</b>' % clicks))
        display(Image(data=base64.b64decode('{PNG}')))
        if clicks == 2:
            raise ValueError('captured-error')
    print('TAIL', clicks, flush=True)
button.on_click(clicked)
display(out)
print('SIBLING A')
"""


async def attach(sock, sid, work, binding=None, last=0):
    ws = await unix_connect(str(sock), max_size=None)
    await ws.send(
        json.dumps(
            {
                "op": "attach",
                "session": sid,
                "workdir": str(work),
                "widget_binding": binding,
                "last_seen_seq": last,
            }
        )
    )
    frames = []
    while True:
        frame = await recv(ws)
        if frame["op"] == "sync":
            return ws, frames
        frames.append(frame)


async def prime(sock, sid, work):
    ws, frames = await attach(sock, sid, work)
    await ws.close()
    return frames[0]


def text(execution):
    return "".join(o.get("text", "") for o in execution["outputs"])


def test_callback_capture_cross_cell_replay_restart_and_later_clear(host):
    root, work, env, start = host
    daemon = start()
    source = work / "callback.pynb"
    source.write_text("# %%\n" + CODE + "\n# %%\ndisplay(button)\n")
    sid = source.as_uri()
    sock = root / "home/daemon.sock"
    asyncio.run(prime(sock, sid, work))
    run(env, "run", "--session", sid, "-c", CODE)
    run(env, "run", "--session", sid, "-c", "display(button)\nprint('SIBLING B')")

    async def exercise():
        ws, initial = await attach(sock, sid, work, "client-a")
        original = initial[0]
        identity = original["kernel"]["kernel_id"]
        live = []
        try:
            for index in range(1, 4):
                live += await transact(ws, action(identity, index, session=sid))
            replay, frames = await attach(sock, sid, work, last=original["max_seq"])
            await replay.close()
            assert frames == live
            fresh, frames = await attach(sock, sid, work)
            await fresh.close()
            return original, frames[0]
        finally:
            await ws.close()

    original, snapshot = asyncio.run(exercise())
    assert len(snapshot["executions"]) == 2
    assert [e["execution_count"] for e in snapshot["executions"]] == [1, 2]
    a, b = snapshot["executions"]
    assert "SIBLING A" in text(a) and "CAPTURE 2" in text(a) and "CAPTURE 1" not in text(a)
    assert "PLAIN" not in text(a) and "TAIL" not in text(a)
    assert "SIBLING B" in text(b) and "PLAIN 1" in text(b) and "TAIL 2" in text(b)
    assert "CAPTURE" not in text(b)
    assert [o["evalue"] for o in a["outputs"] if o["output_type"] == "error"] == ["captured-error"]
    assert [o["evalue"] for o in b["outputs"] if o["output_type"] == "error"] == ["plain-error"]
    assert sum(o.get("data", {}).get("text/html") == "<b>captured-2</b>" for o in a["outputs"]) == 1
    assert len(list((work / ".tithon/outputs").glob("*.png"))) == 1
    shared = sidecar.read(sidecar.sidecar_path(work, source))[0]
    assert [e["outputs"] for e in shared["executions"]] == [
        e["outputs"] for e in sidecar.saved_snapshot(snapshot)["executions"]
    ]
    daemon.kill()
    daemon.wait(timeout=10)
    sock.unlink(missing_ok=True)
    start("--history-retention-days", "0.000000001")

    async def restored():
        ws, frames = await attach(sock, sid, work)
        await ws.close()
        return frames[0]

    after = asyncio.run(restored())
    assert after["kernel"]["pid"] == original["kernel"]["pid"]
    assert after["executions"] == snapshot["executions"]
    run(env, "run", "--session", sid, "-c", "with out:\n    clear_output()\n")
    cleared = asyncio.run(restored())
    a, b, _ = cleared["executions"]
    assert text(a) == "SIBLING A\n"
    assert "SIBLING B" in text(b) and "PLAIN 1" in text(b)
    assert not list((work / ".tithon/outputs").glob("*.png"))


def test_callback_parent_and_output_capture_survive_actual_daemon_crash(host):
    root, work, env, start = host
    daemon = start()
    sock = root / "home/daemon.sock"
    sid = (work / "inflight.pynb").as_uri()
    code = """import ipywidgets as w
from IPython.display import display
from pathlib import Path
import time
button = w.Button(model_id='button')
out = w.Output(model_id='out')
clicks = 0
def clicked(_):
    global clicks
    clicks += 1
    with out:
        print('BEFORE', flush=True)
        probed = False
        while not Path('release').exists():
            if Path('probe').exists() and not probed:
                print('HEARTBEAT', flush=True)
                probed = True
            time.sleep(0.01)
        print('AFTER', flush=True)
    print('TAIL', flush=True)
button.on_click(clicked)
display(out)
"""
    asyncio.run(prime(sock, sid, work))
    run(env, "run", "--session", sid, "-c", code)
    run(env, "run", "--session", sid, "-c", "display(button)")

    async def check():
        ws, frames = await attach(sock, sid, work, "client-a")
        original = frames[0]
        identity = original["kernel"]["kernel_id"]
        await ws.send(json.dumps(action(identity, 1, session=sid)))
        while True:
            frame = await recv(ws)
            if "BEFORE" in frame.get("payload", {}).get("content", {}).get("text", ""):
                break
        daemon.kill()
        await asyncio.to_thread(daemon.wait, timeout=10)
        await ws.close()
        sock.unlink(missing_ok=True)
        await asyncio.to_thread(start)
        ws, frames = await attach(sock, sid, work, "client-b")
        try:
            assert frames[0]["kernel"]["pid"] == original["kernel"]["pid"]
            (work / "probe").touch()
            while True:
                frame = await recv(ws)
                if "HEARTBEAT" in frame.get("payload", {}).get("content", {}).get("text", ""):
                    assert frame["exec_id"] == original["executions"][0]["exec_id"]
                    break
            (work / "release").touch()
            while True:
                frame = await recv(ws)
                if (
                    frame.get("kind") == "widget_status"
                    and frame["payload"]["message"]["content"]["execution_state"] == "idle"
                ):
                    break
        finally:
            await ws.close()
        ws, frames = await attach(sock, sid, work)
        await ws.close()
        a, b = frames[0]["executions"]
        assert text(a) == "BEFORE\nHEARTBEAT\nAFTER\n"
        assert text(b) == "TAIL\n"
        assert len(frames[0]["executions"]) == 2

    asyncio.run(check())
