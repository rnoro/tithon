"""Real daemon/kernel verification of compacted reconnect and notebook interchange."""

import asyncio
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import nbformat
import psutil
import pytest
from websockets.asyncio.client import unix_connect


@pytest.fixture
def host():
    root = Path(tempfile.mkdtemp(prefix="tithon-features-", dir="/tmp"))
    processes = []
    env = dict(os.environ, TITHON_HOME=str(root / "home"))
    work = root / "work"
    work.mkdir()

    def start(*args):
        log = (root / "daemon-test.log").open("ab")
        p = subprocess.Popen(
            [sys.executable, "-m", "tithon", "daemon", *args],
            cwd=work,
            env=env,
            stdout=log,
            stderr=log,
        )
        log.close()
        processes.append(p)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if p.poll() is not None:
                pytest.fail((root / "daemon-test.log").read_text())
            if (root / "home/daemon.sock").exists():
                return p
            time.sleep(0.05)
        pytest.fail("daemon did not bind")

    yield root, work, env, start
    for p in processes:
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(timeout=5)
    for pid_file in (root / "home").rglob("kernel.pid"):
        try:
            pid = int(pid_file.read_text())
            process = psutil.Process(pid)
            if str(root) in " ".join(process.cmdline()):
                os.killpg(pid, signal.SIGKILL)
        except (OSError, ValueError, psutil.Error):
            pass
    shutil.rmtree(root)


async def request(sock, message):
    async with unix_connect(str(sock), max_size=None, open_timeout=10) as ws:
        await ws.send(json.dumps(message))
        return json.loads(await asyncio.wait_for(ws.recv(), 30))


async def attach(sock, sid, work, last=0):
    async with unix_connect(str(sock), max_size=None) as ws:
        await ws.send(
            json.dumps(
                {"op": "attach", "session": sid, "workdir": str(work), "last_seen_seq": last}
            )
        )
        result = []
        while True:
            m = json.loads(await asyncio.wait_for(ws.recv(), 30))
            result.append(m)
            if m["op"] in ("sync", "error"):
                return result


def run(env, *args):
    return subprocess.run(
        [sys.executable, "-m", "tithon", *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )


def test_compaction_restart_and_deleted_cursor_boundaries(host):
    root, work, env, start = host
    sock = root / "home/daemon.sock"
    p = start()
    code = "from IPython.display import display, update_display\ndisplay('first', display_id='plot')\nupdate_display('final', display_id='plot')\nprint('KEPT')\nidentity = 731"
    run(env, "run", "-c", code)
    initial = asyncio.run(attach(sock, "default", work))[0]
    pid = initial["kernel"]["pid"]
    # A real SIGKILL; the detached kernel must preserve both identity and state.
    p.kill()
    p.wait(timeout=10)
    (root / "home/daemon.sock").unlink(missing_ok=True)
    p2 = start("--history-retention-days", "0.000000001")
    restored = asyncio.run(attach(sock, "default", work))[0]
    assert restored["op"] == "snapshot"
    assert restored["kernel"]["pid"] == pid
    assert restored["executions"] == initial["executions"]
    floor = restored["history_floor"]
    assert floor > 0
    assert restored["max_seq"] >= initial["max_seq"]
    db_path = root / "home/sessions/default/journal.db"
    with sqlite3.connect(db_path) as db:
        assert (
            db.execute("SELECT COUNT(*) FROM messages WHERE msg_type='stream'").fetchone()[0] == 0
        )
        assert db.execute("SELECT COUNT(*) FROM executions").fetchone()[0] == 1
    assert asyncio.run(attach(sock, "default", work, floor - 1))[0]["op"] == "snapshot"
    at_floor = asyncio.run(attach(sock, "default", work, floor))
    assert all(m["op"] != "snapshot" for m in at_floor)
    assert "IDENTITY 731" in run(env, "run", "-c", "print('IDENTITY', identity)").stdout
    status = json.loads(run(env, "status", "--session", "default").stdout)
    assert status["storage"]["last_cleanup"]["deleted_messages"] >= 3
    assert status["storage"]["policy"]["retention_days"] > 0
    p2.kill()
    p2.wait(timeout=10)
    (root / "home/daemon.sock").unlink(missing_ok=True)
    start()
    again = asyncio.run(attach(sock, "default", work))[0]
    assert again["kernel"]["pid"] == pid
    assert again["history_floor"] >= floor
    assert any(
        "IDENTITY 731" in o.get("text", "") for e in again["executions"] for o in e["outputs"]
    )


def test_conversion_protocol_does_not_spawn_or_execute_and_cli_export(host):
    root, work, env, start = host
    sock = root / "home/daemon.sock"
    start()
    source, py, destination = work / "input.ipynb", work / "imported.py", work / "output.ipynb"
    doc = nbformat.v4.new_notebook(
        cells=[
            nbformat.v4.new_code_cell(
                "assert False, 'must not execute'",
                outputs=[nbformat.v4.new_output("stream", name="stdout", text="stored output\n")],
                execution_count=8,
            ),
            nbformat.v4.new_markdown_cell("# Markdown"),
        ],
        metadata={"language_info": {"name": "python"}},
    )
    nbformat.write(doc, source)
    imported = asyncio.run(
        request(
            sock,
            {
                "op": "import_notebook",
                "source": str(source),
                "destination": str(py),
                "workdir": str(work),
            },
        )
    )
    assert imported["op"] == "notebook_converted"
    assert asyncio.run(request(sock, {"op": "status"}))["sessions"] == []
    run(env, "export", str(py), str(destination))
    assert nbformat.read(destination, as_version=4).cells == doc.cells
    snapshot = asyncio.run(attach(sock, py.as_uri(), work))[0]
    assert snapshot["executions"][0]["outputs"][0]["text"] == "stored output\n"
    assert snapshot["executions"][0]["status"] == "done"
    # Associate a real execution with the imported cell, then defeat the disk fallback.
    live_code = "print('live output')\n"
    py.write_text("# %%\n" + live_code + "# %% [markdown]\n# # Markdown\n")

    async def execute_cell():
        async with unix_connect(str(sock), max_size=None) as ws:
            await ws.send(
                json.dumps(
                    {
                        "op": "attach",
                        "session": py.as_uri(),
                        "workdir": str(work),
                        "last_seen_seq": -1,
                    }
                )
            )
            while json.loads(await ws.recv())["op"] != "sync":
                pass
            await ws.send(
                json.dumps(
                    {
                        "op": "execute",
                        "code": live_code,
                        "origin": {"index": 0, "range": {"start": 1, "end": 1}},
                    }
                )
            )
            while True:
                message = json.loads(await asyncio.wait_for(ws.recv(), 30))
                if message.get("kind") == "done":
                    assert message["payload"]["status"] == "ok"
                    return

    asyncio.run(execute_cell())
    from tithon.sidecar import sidecar_path

    sidecar_path(work, py).unlink()
    output2 = work / "live.ipynb"
    run(env, "export", str(py), str(output2))
    assert nbformat.read(output2, as_version=4).cells[0].outputs[0].text == "live output\n"
    error = asyncio.run(
        request(
            sock,
            {
                "op": "import_notebook",
                "source": str(source),
                "destination": str(py),
                "workdir": str(work),
            },
        )
    )
    assert error["op"] == "error" and "already exists" in error["message"]
