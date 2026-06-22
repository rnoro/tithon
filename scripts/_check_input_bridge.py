"""Real-kernel hermetic check: the input()/getpass() stdin bridge (#3 bug-hunt).

Verifies end-to-end against a REAL kernel that:
  (1) allow_stdin=True: input() emits a tithon.input_request (pending_input set);
      answering via send_input() unblocks input() so the cell completes OK and the
      value is bound in the namespace; a later cell then runs (no wedge).
  (2) allow_stdin=False (CLI/default): input() errors fast (StdinNotImplemented)
      and the session keeps moving (ADR-050 preserved).

Run:  .venv/bin/python scripts/_check_input_bridge.py
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


async def _wait(pred, timeout=20.0, label=""):
    deadline = asyncio.get_event_loop().time() + timeout
    while not pred():
        if asyncio.get_event_loop().time() > deadline:
            raise TimeoutError(f"timed out waiting for {label}")
        await asyncio.sleep(0.05)


async def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="tithon-inputbridge-"))
    work = tmp / "work"
    work.mkdir(parents=True, exist_ok=True)
    s = Session("default", tmp / "sess", work)
    await s.start()
    try:
        # (1) allow_stdin=True: bridge an input() prompt.
        e1 = s.submit('name = input("Your name: ")\n', allow_stdin=True)
        await _wait(lambda: s._pending_input is not None, label="input_request")
        assert s._pending_input["exec_id"] == e1, s._pending_input
        assert s._pending_input["prompt"] == "Your name: ", s._pending_input
        assert s._pending_input["password"] is False
        print(f"[bridge] input_request received: {s._pending_input!r}")

        ok = s.send_input("Ada Lovelace")
        assert ok, "send_input should answer the pending prompt"
        await _wait(lambda: _status(s, e1) == "done", label="input() cell done")
        assert s._pending_input is None, "prompt should be cleared after answering"

        e2 = s.submit("print(name)\n")  # a later cell runs (no wedge) and sees the value
        await _wait(lambda: _status(s, e2) == "done", label="follow-up cell done")
        text = "".join(
            o.get("text", "") for o in _outputs(s, e2) if o.get("output_type") == "stream"
        )
        assert "Ada Lovelace" in text, f"expected the entered value, got {text!r}"
        print(f"[bridge] answered + bound in namespace: {text.strip()!r}")

        # (2) allow_stdin=False (default): input() errors fast, session keeps moving.
        e3 = s.submit('x = input("nope: ")\n')  # allow_stdin defaults False
        await _wait(lambda: _status(s, e3) in ("done", "error"), label="no-stdin cell ends")
        assert _status(s, e3) == "error", "input() without allow_stdin should ERROR"
        assert s._pending_input is None, "no prompt should be pending for allow_stdin=False"
        err = "".join(
            (o.get("ename", "") + o.get("evalue", ""))
            for o in _outputs(s, e3) if o.get("output_type") == "error"
        )
        assert "stdin" in err.lower() or "StdinNotImplemented" in err, err
        print(f"[no-stdin] errored fast: {err.strip()[:80]!r}")

        e4 = s.submit("print('STILL_ALIVE')\n")
        await _wait(lambda: _status(s, e4) == "done", label="session still moving")
        print("[no-stdin] session keeps moving after the error")

        print("PASS: stdin bridge (answer unblocks) + allow_stdin=False fails fast")
        return 0
    finally:
        await s.stop(kill_kernel=True)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
