"""Tithon CLI: ``tithon daemon | run | attach | status``."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from importlib.metadata import version
from pathlib import Path


def get_home() -> Path:
    return Path(os.environ.get("TITHON_HOME", str(Path.home() / ".tithon"))).expanduser()


def sock_path() -> str:
    return str(get_home() / "daemon.sock")


async def _connect():
    from websockets.asyncio.client import unix_connect

    return unix_connect(sock_path(), max_size=None)


def cmd_daemon(args) -> int:
    home = get_home()
    home.mkdir(parents=True, exist_ok=True)
    level = getattr(logging, args.log_level.upper())
    fmt = "%(asctime)s %(name)s %(levelname)s %(message)s"
    root = logging.getLogger()
    root.setLevel(level)
    # Always write to daemon.log for post-mortem analysis.
    fh = logging.FileHandler(str(home / "daemon.log"))
    fh.setFormatter(logging.Formatter(fmt))
    root.addHandler(fh)
    # Always echo to stderr so `tithon daemon` shows live activity in the terminal.
    sh = logging.StreamHandler()
    sh.setFormatter(logging.Formatter(fmt))
    root.addHandler(sh)
    from .daemon import Daemon

    asyncio.run(
        Daemon(
            home,
            Path.cwd(),
            idle_timeout=args.idle_timeout,
            history_retention_days=args.history_retention_days,
            history_target_mib=args.history_target_mib,
        ).run()
    )
    return 0


def _render_output(payload: dict) -> None:
    msg_type = payload.get("msg_type")
    content = payload.get("content", {})
    if msg_type == "stream":
        out = sys.stderr if content.get("name") == "stderr" else sys.stdout
        out.write(content.get("text", ""))
        out.flush()
    elif msg_type == "execute_result":
        text = (content.get("data") or {}).get("text/plain", "")
        print(text)
    elif msg_type == "error":
        for line in content.get("traceback", []):
            print(line, file=sys.stderr)
    elif msg_type in ("display_data", "update_display_data"):
        data = content.get("data") or {}
        for value in data.values():
            if isinstance(value, dict) and "$tithon_artifact" in value:
                print(f"[artifact] {value['$tithon_artifact']['rel_path']}")
                break
        else:
            print(f"[display] {sorted(data)}")


async def _run(args) -> int:
    async with await _connect() as ws:
        await ws.send(json.dumps({"op": "attach", "last_seen_seq": -1, "session": args.session}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("op") == "error":
                print(f"tithon: {m.get('message', 'daemon error')}", file=sys.stderr)
                return 2
            if m.get("op") == "sync":
                break
        await ws.send(json.dumps({"op": "execute", "code": args.code, "session": args.session}))
        exec_id = None
        buffered: list[dict] = []

        def handle(ev: dict) -> str | None:
            """Returns final status if this event completes our execution."""
            if ev.get("exec_id") != exec_id:
                return None
            kind = ev.get("kind")
            if kind == "output":
                _render_output(ev.get("payload", {}))
            elif kind == "done":
                return ev.get("payload", {}).get("status", "ok")
            return None

        while True:
            m = json.loads(await ws.recv())
            op = m.get("op")
            if op == "execute_ack":
                exec_id = m["exec_id"]
                if args.no_wait:
                    print(exec_id)
                    return 0
                for ev in buffered:
                    status = handle(ev)
                    if status is not None:
                        return 0 if status == "ok" else 1
                buffered.clear()
            elif op == "event":
                if exec_id is None:
                    buffered.append(m)
                    continue
                status = handle(m)
                if status is not None:
                    return 0 if status == "ok" else 1


def project_root(source: Path, explicit: str | None = None) -> Path:
    """The project a notebook file belongs to: where its `.tithon/` lives.

    The nearest ancestor holding a project `.tithon/` (not the daemon home),
    then the nearest git root, then the file's own directory.
    """
    if explicit:
        return Path(explicit).absolute()
    home = get_home().resolve()
    ancestors = list(source.absolute().parents)
    for directory in ancestors:
        marker = directory / ".tithon"
        if marker.is_dir() and marker.resolve() != home:
            return directory
    for directory in ancestors:
        if (directory / ".git").exists():
            return directory
    return source.absolute().parent


async def _ask_daemon(message: dict) -> dict | None:
    """One session-free request to a running daemon; None when none answers.

    Never starts a daemon: reading outputs must not cost a process or a kernel.
    """
    if not Path(sock_path()).exists():
        return None
    try:
        async with await _connect() as ws:
            await ws.send(json.dumps(message))
            return json.loads(await asyncio.wait_for(ws.recv(), 30))
    except (OSError, TimeoutError):
        return None


def _query(source: Path, root: Path, args, cells: str | None) -> dict:
    from . import outputs

    request = {
        "op": "query_outputs",
        "source": str(source),
        "workdir": str(root),
        "cells": cells,
        "errors": getattr(args, "errors", False),
        "tail": args.tail,
        "head": args.head,
        "grep": args.grep,
    }
    reply = None if getattr(args, "offline", False) else asyncio.run(_ask_daemon(request))
    if reply is None:
        with source.open(encoding="utf-8", newline="") as handle:
            text = handle.read()
        snapshot, origin = outputs.saved_snapshot_for(source, root)
        reply = {
            "op": "outputs",
            "origin": origin,
            "cells": outputs.answer(snapshot, text, request),
        }
    if reply.get("op") == "error":
        raise ValueError(reply.get("message", "daemon error"))
    return reply


def _print_outputs(reply: dict, args) -> None:
    from . import outputs

    records = reply["cells"]
    if args.json:
        print(json.dumps({"origin": reply["origin"], "cells": records}, ensure_ascii=False))
    elif getattr(args, "summary", False):
        print(outputs.summary(records))
    else:
        print(outputs.render(records, args.max_chars, head=bool(args.head)))


def cmd_outputs(args) -> int:
    source = Path(args.file).absolute()
    reply = _query(source, project_root(source, args.workdir), args, args.cells)
    _print_outputs(reply, args)
    return 0


#: Kernel lifecycle states after which a submitted cell will never report done.
_RUN_ENDING = {
    "dead",
    "restarting",
    "restarted",
    "replaced",
    "killed",
    "gc",
    "shutdown",
    "disconnected",
}


async def _session_uri(source: Path) -> str:
    """The live session id of this file, matched by resolved path; else its uri.

    A file opened elsewhere through another spelling (a symlink) keeps one
    session and one kernel instead of gaining a second.
    """
    from urllib.parse import unquote, urlparse

    status = await _ask_daemon({"op": "status"})
    canonical = source.resolve()
    for info in (status or {}).get("sessions") or []:
        uri = info.get("session") if isinstance(info, dict) else None
        parsed = urlparse(uri) if isinstance(uri, str) else None
        if parsed is not None and parsed.scheme == "file":
            if Path(unquote(parsed.path)).resolve() == canonical:
                return uri
    return source.as_uri()


async def _run_cells(args, source: Path, root: Path) -> dict[str, str]:
    """Execute selected cells of a file in its session; return status per cell."""
    from websockets.exceptions import ConnectionClosed

    from . import outputs

    with source.open(encoding="utf-8", newline="") as handle:
        text = handle.read()
    chosen = outputs.parse_selection(args.cells)
    cells = [c for c in outputs.code_cells(text) if chosen is None or c["cell"] in chosen]
    if not cells:
        raise ValueError("No code cell matches the selection")
    session = await _session_uri(source)
    batch = [
        {
            "code": c["body"],
            "origin": {
                "uri": session,
                "index": c["cell"],
                "range": c["range"],
                "cell_hash": c["cell_hash"],
            },
        }
        for c in cells
    ]
    async with await _connect() as ws:
        attach = {"op": "attach", "last_seen_seq": -1, "session": session, "workdir": str(root)}
        await ws.send(json.dumps(attach))
        while True:
            m = json.loads(await ws.recv())
            if m.get("op") == "error":
                raise ValueError(m.get("message", "daemon error"))
            if m.get("op") == "sync":
                break
        await ws.send(
            json.dumps(
                {
                    "op": "execute_batch",
                    "cells": batch,
                    "stop_on_error": not args.keep_going,
                    "session": session,
                    "workdir": str(root),
                }
            )
        )
        pending: dict[str, int] | None = None
        early: dict[str, str] = {}
        statuses: dict[str, str] = {}
        while pending is None or len(statuses) < len(pending):
            try:
                m = json.loads(await ws.recv())
            except ConnectionClosed as closed:
                if pending is None:
                    message = "The daemon closed the connection before accepting the cells"
                    raise ValueError(message) from closed
                m = {"op": "event", "kind": "kernel", "payload": {"status": "disconnected"}}
            kernel = (m.get("payload") or {}).get("status") if m.get("kind") == "kernel" else None
            if kernel in _RUN_ENDING and pending is not None:
                # The kernel went away, so no `done` will come for what is left.
                for exec_id in pending:
                    statuses.setdefault(exec_id, kernel)
                break
            if m.get("op") == "execute_ack":
                pending = dict(
                    zip(m.get("exec_ids") or [], (c["cell"] for c in cells), strict=False)
                )
                statuses.update({k: v for k, v in early.items() if k in pending})
            elif m.get("op") == "event" and m.get("kind") == "done":
                status = (m.get("payload") or {}).get("status", "ok")
                target = statuses if pending is not None else early
                if pending is None or m.get("exec_id") in pending:
                    target[m.get("exec_id")] = status
    return {str(pending[e]): s for e, s in statuses.items()}


def cmd_run(args) -> int:
    if args.file:
        source = Path(args.file).absolute()
        root = project_root(source, args.workdir)
        coro = _run_cells(args, source, root)
        if args.timeout > 0:
            coro = asyncio.wait_for(coro, args.timeout)
        statuses = asyncio.run(coro)
        selected = ",".join(sorted(statuses, key=int))
        reply = _query(source, root, args, selected)
        for record in reply["cells"]:
            if statuses.get(str(record["cell"])) == "skipped":
                record.update(status="skipped", execution_count=None, outputs=[])
                record.pop("seconds", None)
        _print_outputs(reply, args)
        return 0 if all(s == "ok" for s in statuses.values()) else 1
    if args.code is None:
        raise ValueError("run needs a notebook file or -c CODE")
    coro = _run(args)
    if args.timeout > 0:
        coro = asyncio.wait_for(coro, args.timeout)
    return asyncio.run(coro)


async def _attach(args) -> int:
    async with await _connect() as ws:
        await ws.send(
            json.dumps({"op": "attach", "last_seen_seq": args.since, "session": args.session})
        )
        async for raw in ws:
            text = raw if isinstance(raw, str) else raw.decode()
            print(text, flush=True)
            m = json.loads(text)
            if args.once and m.get("op") == "sync":
                return 0
            if args.until_done and m.get("op") == "event" and m.get("kind") == "done":
                return 0
    return 0


def cmd_attach(args) -> int:
    return asyncio.run(_attach(args))


async def _status(args) -> int:
    async with await _connect() as ws:
        op = {"op": "status"}
        if args.session is not None:
            op["session"] = args.session
        await ws.send(json.dumps(op))
        m = json.loads(await ws.recv())
        print(json.dumps(m, indent=2))
    return 0


def cmd_status(args) -> int:
    return asyncio.run(_status(args))


async def _kernel_op(op: str, session: str) -> int:
    async with await _connect() as ws:
        await ws.send(json.dumps({"op": op, "session": session}))
        m = json.loads(await ws.recv())
        print(json.dumps(m, indent=2))
    return 0


def cmd_restart(args) -> int:
    return asyncio.run(_kernel_op("restart_kernel", args.session))


def cmd_interrupt(args) -> int:
    return asyncio.run(_kernel_op("interrupt", args.session))


async def _kill(target: str) -> int:
    async with await _connect() as ws:
        await ws.send(json.dumps({"op": "kill_kernel", "target": target}))
        m = json.loads(await ws.recv())
        print(json.dumps(m, indent=2))
    return 0 if m.get("ok") else 1


def cmd_kill(args) -> int:
    return asyncio.run(_kill(args.session))


async def _shutdown(kill_kernels: bool) -> int:
    async with await _connect() as ws:
        await ws.send(json.dumps({"op": "shutdown", "kill_kernels": kill_kernels}))
        try:
            m = json.loads(await ws.recv())
            print(json.dumps(m, indent=2))
        except Exception:
            pass
    return 0


def cmd_shutdown(args) -> int:
    return asyncio.run(_shutdown(args.kill_kernels))


def cmd_import(args) -> int:
    from .notebook import import_notebook

    print(
        json.dumps(
            import_notebook(
                Path(args.source),
                Path(args.destination),
                Path(args.workdir) if args.workdir else None,
            ),
            indent=2,
        )
    )
    return 0


async def _export(args, direction="export") -> int:
    from .notebook import export_notebook

    source = Path(args.source).absolute()
    root = Path(args.workdir).resolve() if args.workdir else source.parent
    try:
        async with await _connect() as ws:
            await ws.send(
                json.dumps(
                    {
                        "op": f"{direction}_notebook",
                        "source": str(source),
                        "destination": str(Path(args.destination).absolute()),
                        "workdir": str(root),
                    }
                )
            )
            result = json.loads(await ws.recv())
            if result.get("op") == "error":
                raise ValueError(result["message"])
    except (ConnectionRefusedError, FileNotFoundError):
        if direction == "copy":
            from .daemon import Daemon

            result = Daemon(get_home(), root)._copy_notebook(source, Path(args.destination), root)
        else:
            result = export_notebook(source, Path(args.destination), root)
    print(json.dumps(result, indent=2))
    return 0


def cmd_export(args) -> int:
    return asyncio.run(_export(args))


def cmd_copy(args) -> int:
    return asyncio.run(_export(args, "copy"))


RUN_EXAMPLES = """\
Cells are numbered from 0 in file order (markdown cells count); earlier cells'
variables stay loaded, so rerun only the cells you changed. Batch several
experiments in ONE shell command and print one line per cell:

  for depth in 2 4 8; do
    perl -pi -e "s/^depth = .*/depth = $depth/" exp.pynb
    tithon run exp.pynb --cells 3-5 --summary
  done

Read without running: tithon outputs nb.pynb --summary | --errors | --cells N
"""


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="tithon")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("daemon", help="run the tithon daemon (foreground)")
    sp.add_argument(
        "--log-level",
        default="INFO",
        metavar="LEVEL",
        help="logging verbosity: DEBUG|INFO|WARNING|ERROR (default: INFO)",
    )
    sp.add_argument(
        "--idle-timeout",
        type=float,
        default=None,
        metavar="SECONDS",
        help="reap a kernel idle this long (no attached client, nothing running/queued); "
        "outputs stay restorable from the journal. 0/omitted = never "
        "(env: TITHON_KERNEL_IDLE_TIMEOUT)",
    )
    from .retention import nonnegative

    sp.add_argument(
        "--history-retention-days",
        type=nonnegative,
        default=os.environ.get("TITHON_HISTORY_RETENTION_DAYS", "0"),
    )
    sp.add_argument(
        "--history-target-mib",
        type=nonnegative,
        default=os.environ.get("TITHON_HISTORY_TARGET_MIB", "0"),
    )
    sp.set_defaults(fn=cmd_daemon)

    def output_options(sp, *, run: bool = False) -> None:
        sp.add_argument("--workdir", help="project root (default: nearest .tithon/ or git root)")
        sp.add_argument("--cells", help="code cell indices, e.g. 3 or 1,4-6 (default: all)")
        sp.add_argument(
            "--tail",
            type=int,
            default=None,
            help="keep the last N lines per output (0 = all; default 5, tracebacks 20)",
        )
        sp.add_argument(
            "--head", type=int, default=0, help="keep the first N lines per output instead"
        )
        sp.add_argument("--grep", help="keep only lines matching this regex (case-insensitive)")
        sp.add_argument(
            "--max-chars",
            type=int,
            default=6000,
            help="stop the text view after N chars (0 = no limit)",
        )
        sp.add_argument("--json", action="store_true", help="print the bounded records as JSON")
        sp.add_argument("--summary", action="store_true", help="one line per cell")
        if not run:
            sp.add_argument(
                "--errors", action="store_true", help="only cells whose last run raised"
            )
            sp.add_argument(
                "--offline", action="store_true", help="read the shared output file only"
            )

    sp = sub.add_parser(
        "run",
        help="execute cells of a notebook file (prints their outputs) or code in a session",
        description="With FILE, run its cells in the file's persistent kernel and print "
        "their bounded outputs; exit 1 if a cell raised. With -c, run code in --session.",
        epilog=RUN_EXAMPLES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sp.add_argument("file", nargs="?", help="percent-format notebook (.pynb/.py)")
    sp.add_argument("-c", "--code")
    sp.add_argument("--session", default="default", help="session id (file uri); per-file kernel")
    sp.add_argument("--no-wait", action="store_true", help="submit and exit (prints exec_id)")
    sp.add_argument("--timeout", type=float, default=0.0)
    sp.add_argument(
        "--keep-going", action="store_true", help="run every selected cell after an error"
    )
    output_options(sp, run=True)
    sp.set_defaults(fn=cmd_run)

    sp = sub.add_parser(
        "outputs",
        help="print a notebook file's current cell outputs, bounded for agents",
        description="Read current outputs without running code or starting a daemon: from "
        "the running daemon (live, including running cells) or the shared output file.",
    )
    sp.add_argument("file", help="percent-format notebook (.pynb/.py)")
    output_options(sp)
    sp.set_defaults(fn=cmd_outputs)

    sp = sub.add_parser("attach", help="attach and stream events as NDJSON")
    sp.add_argument("--session", default="default", help="session id (file uri); per-file kernel")
    sp.add_argument("--since", type=int, default=0, help="last seen seq (0=full snapshot)")
    sp.add_argument("--once", action="store_true", help="exit after backlog sync")
    sp.add_argument("--until-done", action="store_true", help="exit after a done event")
    sp.set_defaults(fn=cmd_attach)

    sp = sub.add_parser("status", help="print daemon status (all sessions) or one session")
    sp.add_argument("--session", default=None, help="session id; omit for all-sessions status")
    sp.set_defaults(fn=cmd_status)

    sp = sub.add_parser("restart", help="restart a session's kernel (fresh namespace)")
    sp.add_argument("--session", default="default", help="session id (file uri)")
    sp.set_defaults(fn=cmd_restart)

    sp = sub.add_parser("interrupt", help="interrupt the running cell (SIGINT)")
    sp.add_argument("--session", default="default", help="session id (file uri)")
    sp.set_defaults(fn=cmd_interrupt)

    sp = sub.add_parser("kill", help="terminate one session's kernel and drop the session")
    sp.add_argument("--session", required=True, help="session id (file uri) to terminate")
    sp.set_defaults(fn=cmd_kill)

    sp = sub.add_parser(
        "shutdown", help="stop the daemon (kernels stay detached unless --kill-kernels)"
    )
    sp.add_argument(
        "--kill-kernels",
        action="store_true",
        help="also kill kernels (fresh start, e.g. interpreter switch)",
    )
    sp.set_defaults(fn=cmd_shutdown)

    for name, fn in (("import", cmd_import), ("export", cmd_export), ("copy", cmd_copy)):
        sp = sub.add_parser(
            name, help=f"{name} notebook source and saved outputs without executing code"
        )
        sp.add_argument("source")
        sp.add_argument("destination")
        sp.add_argument("--workdir", help="project root; defaults to the Python file's directory")
        sp.set_defaults(fn=fn)

    sp = sub.add_parser("version", help="print the Tithon package version")
    sp.set_defaults(fn=lambda args: print(version("tithon")))

    args = p.parse_args(argv)
    try:
        sys.exit(args.fn(args))
    except (ConnectionRefusedError, FileNotFoundError) as e:
        print(f"tithon: cannot reach daemon at {sock_path()}: {e}", file=sys.stderr)
        sys.exit(2)
    except TimeoutError:
        print("tithon: timed out", file=sys.stderr)
        sys.exit(3)
    except (ValueError, OSError) as e:
        print(f"tithon: {e}", file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)
