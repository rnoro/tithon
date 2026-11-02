"""Bounded output queries: projection, selection, and the real daemon/CLI path."""

import asyncio
import hashlib
import json
import subprocess
import sys
import time

from test_feature_processes import host as host
from test_feature_processes import request

from tithon import outputs, sidecar

SOURCE = "# %%\nprint('a')\n# %% [markdown]\n# note\n# %%\nraise ValueError('bad')\n# %%\nx = 1\n"


def execution(seq, body, index, outputs_, status="done"):
    return {
        "exec_id": f"e{seq}",
        "seq": seq,
        "cell_hash": hashlib.sha256(body.encode()).hexdigest(),
        "origin": {"index": index, "range": {"start": 0, "end": 0}},
        "status": status,
        "execution_count": seq,
        "started_at": 10.0,
        "finished_at": 11.5,
        "outputs": outputs_,
    }


def snapshot():
    log = "".join(f"step {i}\n" for i in range(50))
    return {
        "executions": [
            execution(
                1,
                "print('a')\n",
                0,
                [
                    {"output_type": "stream", "name": "stdout", "text": log[:100]},
                    {"output_type": "stream", "name": "stdout", "text": log[100:]},
                    {
                        "output_type": "display_data",
                        "data": {
                            "image/png": {
                                "$tithon_artifact": {"rel_path": ".tithon/outputs/a.png"}
                            },
                            "text/plain": "<Figure>",
                        },
                    },
                ],
            ),
            execution(
                2,
                "raise ValueError('bad')\n",
                2,
                [
                    {
                        "output_type": "error",
                        "ename": "ValueError",
                        "evalue": "bad",
                        "traceback": [
                            "\x1b[31mTraceback\x1b[0m",
                            "  line 1",
                            "ValueError: bad",
                            "",
                        ],
                    }
                ],
                status="error",
            ),
        ]
    }


def test_select_projects_merges_and_reports_never_run_cells():
    records = outputs.select(snapshot(), SOURCE)
    assert [r["cell"] for r in records] == [0, 2, 3]
    first, failed, never = records
    assert first["lines"] == [1, 2] and first["seconds"] == 1.5
    assert [o["kind"] for o in first["outputs"]] == ["stdout", "image"]  # streams merged
    assert first["outputs"][1]["path"] == ".tithon/outputs/a.png"
    assert failed["status"] == "error" and "\x1b" not in failed["outputs"][0]["text"]
    assert never == {
        "cell": 3,
        "lines": [7, 8],
        "status": None,
        "execution_count": None,
        "outputs": [],
    }
    assert [r["cell"] for r in outputs.select(snapshot(), SOURCE, errors_only=True)] == [2]
    assert [r["cell"] for r in outputs.select(snapshot(), SOURCE, {0, 3})] == [0, 3]


def test_edited_cell_hides_output_of_older_code():
    edited = SOURCE.replace("print('a')", "print('b')")
    assert outputs.select(snapshot(), edited, {0})[0]["outputs"] == []


def test_bound_reports_what_it_dropped_and_grep_filters():
    records = outputs.select(snapshot(), SOURCE, {0})
    tail = outputs.bound(records, tail=3)[0]["outputs"][0]
    assert tail["text"] == "step 47\nstep 48\nstep 49" and tail["omitted_lines"] == 47
    head = outputs.bound(records, tail=3, head=2)[0]["outputs"][0]
    assert head["text"] == "step 0\nstep 1" and head["omitted_lines"] == 48
    grep = outputs.bound(records, grep="STEP 4[5-9]", tail=0)[0]["outputs"]
    assert [o["kind"] for o in grep] == ["stdout", "image"]
    assert grep[0]["text"].splitlines() == [f"step {i}" for i in range(45, 50)]
    assert outputs.bound(outputs.select(snapshot(), SOURCE, {2}), grep="nothing") == []
    error = outputs.bound(outputs.select(snapshot(), SOURCE, {2}), tail=1)[0]["outputs"][0]
    assert error["text"] == "ValueError: bad"  # trailing blank lines are not content


def test_render_and_summary_are_compact_and_say_how_to_get_more():
    records = outputs.bound(outputs.select(snapshot(), SOURCE), tail=2)
    text = outputs.render(records)
    assert text.splitlines()[:4] == [
        "## cell 0 lines 1-2 done [1] 1.5s",
        "stdout:",
        "[48 earlier lines omitted]",
        "step 48",
    ]
    assert "image: .tithon/outputs/a.png (image/png)" in text
    assert "## cell 3 lines 7-8 not run" in text
    stopped = outputs.render(records, max_chars=40)
    assert stopped.endswith("raise --max-chars]") and "cell 2" not in stopped
    assert outputs.summary(records).splitlines() == [
        "cell 0 lines 1-2 done [1] 1.5s | step 49 | 1 image(s)",
        "cell 2 lines 5-6 error [2] 1.5s | ValueError: bad",
        "cell 3 lines 7-8 not run",
    ]


def test_selection_parsing():
    assert outputs.parse_selection("1,4-6") == {1, 4, 5, 6}
    assert outputs.parse_selection(None) is None
    for bad in ("a", "1-x", "-2"):
        try:
            outputs.parse_selection(bad)
        except ValueError:
            continue
        raise AssertionError(bad)


def tithon(env, *args, cwd):
    return subprocess.run(
        [sys.executable, "-m", "tithon", *args],
        env=env,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=120,
    )


NOTEBOOK = """# %%
for i in range(30):
    print(f"epoch {i} loss {1 / (i + 1):.3f}")
# %%
import tqdm.notebook as tqdm
for _ in tqdm.tqdm(range(4)):
    pass
# %%
raise RuntimeError("diverged")
# %%
never = True
"""


def test_real_daemon_run_and_query_without_spawning_for_unknown_files(host):
    root, work, env, start = host
    (work / ".tithon").mkdir()
    notebook = work / "exp" / "train.pynb"
    notebook.parent.mkdir()
    notebook.write_text(NOTEBOOK)
    start()
    sock = root / "home/daemon.sock"

    ran = tithon(env, "run", str(notebook), "--tail", "2", cwd=notebook.parent)
    assert ran.returncode == 1, ran.stderr
    assert ran.stdout.splitlines()[:3] == [
        ran.stdout.splitlines()[0],
        "stdout:",
        "[28 earlier lines omitted]",
    ]
    assert "epoch 29 loss 0.033" in ran.stdout
    assert "widget: 100% |" in ran.stdout and "| 4/4" in ran.stdout
    assert "RuntimeError: diverged" in ran.stdout
    assert "## cell 3 lines 10-11 skipped" in ran.stdout  # stopped on the error

    # The shared file is found from the project root, not the notebook's directory.
    assert sidecar.sidecar_path(work, notebook).exists()
    live = tithon(env, "outputs", str(notebook), "--json", "--cells", "0,2", cwd=work)
    reply = json.loads(live.stdout)
    assert reply["origin"] == "live"
    assert [c["status"] for c in reply["cells"]] == ["done", "error"]

    summary = tithon(env, "outputs", "exp/train.pynb", "--summary", cwd=work).stdout
    assert summary.splitlines()[2].endswith("RuntimeError: diverged")
    assert summary.splitlines()[3].endswith("not run")

    other = work / "other.pynb"
    other.write_text("# %%\nprint('never run')\n")
    unknown = tithon(env, "outputs", str(other), "--json", cwd=work)
    assert json.loads(unknown.stdout)["origin"] == "none"
    status = asyncio.run(request(sock, {"op": "status"}))
    assert [s["session"] for s in status["sessions"]] == [notebook.as_uri()]

    rerun = tithon(env, "run", str(notebook), "--cells", "3", "--summary", cwd=work)
    assert rerun.returncode == 0 and rerun.stdout.startswith("cell 3 lines 10-11 done [")

    assert tithon(env, "shutdown", "--kill-kernels", cwd=work).returncode == 0
    offline = tithon(env, "outputs", str(notebook), "--errors", "--tail", "1", cwd=work)
    assert offline.returncode == 0
    assert offline.stdout.splitlines() == [
        offline.stdout.splitlines()[0],
        "error:",
        offline.stdout.splitlines()[2],
        "RuntimeError: diverged",
    ]
    assert (
        json.loads(tithon(env, "outputs", str(notebook), "--json", cwd=work).stdout)["origin"]
        == "saved"
    )


def test_render_cap_holds_for_one_huge_line_and_malformed_text_stays_visible():
    huge = {"cell": 0, "lines": [1, 2], "status": "done", "execution_count": 1}
    huge["outputs"] = [{"kind": "stdout", "text": "x" * 100_000}]
    text = outputs.render([huge, {**huge, "cell": 1}], max_chars=200)
    assert len(text) < 400 and "[cut " in text and "1 more cell(s)" in text
    mixed = {"output_type": "stream", "name": "stdout", "text": ["partial", 1]}
    assert outputs.project(mixed, None)["text"] == "partial1"
    scalar = {"output_type": "execute_result", "data": {"text/plain": 7}}
    assert outputs.project(scalar, None)["text"] == "7"


def test_run_follows_a_symlinked_spelling_and_ends_when_the_kernel_is_killed(host):
    root, work, env, start = host
    (work / ".tithon").mkdir()
    real = work / "real"
    real.mkdir()
    notebook = real / "nb.pynb"
    notebook.write_text("# %%\nimport time\nvalue = 1\n# %%\ntime.sleep(60)\n")
    (work / "link").symlink_to(real)
    start()
    sock = root / "home/daemon.sock"
    assert tithon(env, "run", str(notebook), "--cells", "0", cwd=work).returncode == 0
    linked = tithon(env, "run", str(work / "link/nb.pynb"), "--cells", "0", cwd=work)
    assert linked.returncode == 0, linked.stderr
    status = asyncio.run(request(sock, {"op": "status"}))
    assert [s["session"] for s in status["sessions"]] == [notebook.as_uri()]

    slow = subprocess.Popen(
        [sys.executable, "-m", "tithon", "run", str(notebook), "--cells", "1"],
        env=env,
        cwd=work,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    for _ in range(100):
        status = asyncio.run(request(sock, {"op": "status"}))
        if status["sessions"] and status["sessions"][0].get("kernel_status") == "busy":
            break
        time.sleep(0.1)
    assert tithon(env, "kill", "--session", notebook.as_uri(), cwd=work).returncode == 0
    out, err = slow.communicate(timeout=30)  # waiting forever is the defect
    assert slow.returncode == 1, (out, err)


def test_default_tail_is_short_for_logs_and_longer_for_tracebacks():
    trace = "\n".join(f"frame {i}" for i in range(30))
    record = {"cell": 0, "lines": [1, 2], "status": "error", "execution_count": 1}
    record["outputs"] = [
        {"kind": "stdout", "text": "\n".join(f"step {i}" for i in range(30))},
        {"kind": "error", "text": trace, "summary": "E: x"},
    ]
    log, error = outputs.bound([record])[0]["outputs"]
    assert log["text"].splitlines() == [f"step {i}" for i in range(25, 30)]
    assert log["omitted_lines"] == 25
    assert len(error["text"].splitlines()) == outputs.ERROR_TAIL == 20
    assert [len(o["text"].splitlines()) for o in outputs.bound([record], tail=3)[0]["outputs"]] == [
        3,
        3,
    ]
