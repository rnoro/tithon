"""Real-kernel hermetic check: a kernel that DIES mid-execution must not wedge.

A cell that crashes the kernel (here `os._exit`; on a GPU host a CUDA OOM-kill
or segfault does the same) sends no execute_reply, so the exec worker used to
block forever — the cell spun, the queue never drained, the whole session
wedged. The daemon now polls kernel liveness while waiting for the reply
(KERNEL_REPLY_POLL) and, on death, errors the cell so the session keeps moving.

Verifies end-to-end against a REAL kernel that:
  (1) a kernel-killing cell reaches terminal status "error" (not stuck running)
      with a KernelDied error, within a bounded time — no wedge;
  (2) a cell submitted AFTER the death also fails fast (no execute into the void);
  (3) restart_kernel() gives a fresh kernel and a normal cell then runs OK.

Run:  .venv/bin/python scripts/_check_kernel_death.py
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

from tithon.daemon import Session


def _status(s: Session, exec_id: str) -> str | None:
    for row in s.journal.executions():
        if row[0] == exec_id:
            return row[3]
    return None


def _outputs(s: Session, exec_id: str):
    fold = s._folds.get(exec_id)
    return fold.outputs() if fold else []


def _error_text(s: Session, exec_id: str) -> str:
    return "".join(
        (o.get("ename", "") + o.get("evalue", ""))
        for o in _outputs(s, exec_id) if o.get("output_type") == "error"
    )


async def _wait(pred, timeout=20.0, label=""):
    deadline = asyncio.get_event_loop().time() + timeout
    while not pred():
        if asyncio.get_event_loop().time() > deadline:
            raise TimeoutError(f"timed out waiting for {label}")
        await asyncio.sleep(0.05)


async def check_startup_failure() -> None:
    """A kernel that exits during startup (e.g. the interpreter lacks ipykernel)
    must fail FAST with a clear message, not poll the full 120s readiness timeout.
    Simulated by spawning then immediately killing the kernel before it is ready.
    """
    import time
    tmp = Path(tempfile.mkdtemp(prefix="tithon-startfail-"))
    work = tmp / "work"
    work.mkdir(parents=True, exist_ok=True)
    s = Session("default", tmp / "sess", work)
    s.kernel.ensure()
    s.kc = s.kernel.make_client()
    s.kernel.kill()  # kernel dies before becoming ready
    t0 = time.monotonic()
    raised = ""
    try:
        await s._wait_kernel_ready(timeout=120)  # production timeout
        raise AssertionError("expected a fast failure, but it became ready")
    except RuntimeError as e:
        raised = str(e)
    dt = time.monotonic() - t0
    try:
        s.kc.stop_channels()
    except Exception:
        pass
    assert dt < 10, f"startup failure took {dt:.1f}s — should fail fast, not poll 120s"
    assert "ipykernel" in raised or "exited during startup" in raised, raised
    print(f"[startup] dead-on-startup kernel failed fast in {dt:.1f}s: {raised[:60]!r}")


async def main() -> int:
    await check_startup_failure()
    tmp = Path(tempfile.mkdtemp(prefix="tithon-kerneldeath-"))
    work = tmp / "work"
    work.mkdir(parents=True, exist_ok=True)
    s = Session("default", tmp / "sess", work)
    await s.start()
    try:
        # (1) a cell that kills the kernel must reach terminal error, not wedge.
        e1 = s.submit('import os; print("about to die", flush=True); os._exit(0)\n')
        await _wait(lambda: _status(s, e1) in ("done", "error"), timeout=15,
                    label="killing cell reaches terminal status (no wedge)")
        assert _status(s, e1) == "error", f"expected error, got {_status(s, e1)!r}"
        err = _error_text(s, e1)
        assert "KernelDied" in err, f"expected KernelDied, got {err!r}"
        assert not s.kernel.is_alive(), "kernel should be detected dead"
        print(f"[death] killing cell errored cleanly (no wedge): {err.strip()[:60]!r}")

        # (2) a cell after the death also fails fast (does not execute into the void).
        e2 = s.submit('print("should not run")\n')
        await _wait(lambda: _status(s, e2) in ("done", "error"), timeout=10,
                    label="post-death cell fails fast")
        assert _status(s, e2) == "error", f"post-death cell should error, got {_status(s, e2)!r}"
        assert "KernelDied" in _error_text(s, e2)
        print("[death] post-death cell failed fast (no wedge)")

        # (3) restart gives a fresh kernel and a normal cell runs OK.
        await s.restart_kernel()
        assert s.kernel.is_alive(), "restart should spawn a live kernel"
        e3 = s.submit("print('ALIVE_AGAIN', 6*7)\n")
        await _wait(lambda: _status(s, e3) == "done", timeout=20, label="post-restart cell done")
        text = "".join(
            o.get("text", "") for o in _outputs(s, e3) if o.get("output_type") == "stream"
        )
        assert "ALIVE_AGAIN 42" in text, f"expected output after restart, got {text!r}"
        print(f"[restart] fresh kernel runs: {text.strip()!r}")

        print("PASS: startup-failure fast-fail + kernel death errors the cell (no wedge) + restart recovers")
        return 0
    finally:
        await s.stop(kill_kernel=True)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
