"""Tithon CLI: ``tithon daemon | run | attach | status``."""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
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

    asyncio.run(Daemon(home, Path.cwd()).run())
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
        await ws.send(json.dumps({"op": "attach", "last_seen_seq": -1}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("op") == "sync":
                break
        await ws.send(json.dumps({"op": "execute", "code": args.code}))
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


def cmd_run(args) -> int:
    coro = _run(args)
    if args.timeout > 0:
        coro = asyncio.wait_for(coro, args.timeout)
    return asyncio.run(coro)


async def _attach(args) -> int:
    async with await _connect() as ws:
        await ws.send(json.dumps({"op": "attach", "last_seen_seq": args.since}))
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


async def _status() -> int:
    async with await _connect() as ws:
        await ws.send(json.dumps({"op": "status"}))
        m = json.loads(await ws.recv())
        print(json.dumps(m, indent=2))
    return 0


def cmd_status(args) -> int:
    return asyncio.run(_status())


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
    sp.set_defaults(fn=cmd_daemon)

    sp = sub.add_parser("run", help="execute code in the session")
    sp.add_argument("-c", "--code", required=True)
    sp.add_argument("--no-wait", action="store_true", help="submit and exit (prints exec_id)")
    sp.add_argument("--timeout", type=float, default=0.0)
    sp.set_defaults(fn=cmd_run)

    sp = sub.add_parser("attach", help="attach and stream events as NDJSON")
    sp.add_argument("--since", type=int, default=0, help="last seen seq (0=full snapshot)")
    sp.add_argument("--once", action="store_true", help="exit after backlog sync")
    sp.add_argument("--until-done", action="store_true", help="exit after a done event")
    sp.set_defaults(fn=cmd_attach)

    sp = sub.add_parser("status", help="print daemon/session status")
    sp.set_defaults(fn=cmd_status)

    args = p.parse_args(argv)
    try:
        sys.exit(args.fn(args))
    except (ConnectionRefusedError, FileNotFoundError) as e:
        print(f"tithon: cannot reach daemon at {sock_path()}: {e}", file=sys.stderr)
        sys.exit(2)
    except (asyncio.TimeoutError, TimeoutError):
        print("tithon: timed out", file=sys.stderr)
        sys.exit(3)
    except KeyboardInterrupt:
        sys.exit(130)
