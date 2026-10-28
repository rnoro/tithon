"""Read installed classic widget bundles with their frontend package metadata."""

from __future__ import annotations

import base64
import hashlib
import importlib.metadata
import json
import os
import re
import stat
import subprocess
import tempfile
from pathlib import Path

import psutil

from .kernel import KernelHandle

MAX_WIDGET_MODULE_BYTES = 4 * 1024 * 1024
_PACKAGE = re.compile(r"(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*/)?[a-zA-Z0-9][a-zA-Z0-9._-]*\Z")


def _read_within(prefix: Path, parts: tuple[str, ...], limit: int) -> bytes:
    directory = None
    descriptor = None
    try:
        directory = os.open(prefix, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        for part in parts[:-1]:
            child = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=directory
            )
            os.close(directory)
            directory = child
        descriptor = os.open(
            parts[-1], os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
        )
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("Widget module is not a regular file")
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = None
            data = stream.read(limit + 1)
    except OSError as error:
        raise ValueError("Installed widget module is unavailable") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if directory is not None:
            os.close(directory)
    if len(data) > limit:
        raise ValueError("Installed widget module is too large")
    return data


def _owned_by_one_distribution(prefix: Path, files: dict[Path, bytes]) -> bool:
    """Check that both frontend files match one installed distribution's RECORD."""
    paths = list((prefix / "lib").glob("python*/site-packages"))
    paths += list((prefix / "lib64").glob("python*/site-packages"))
    expected = {os.path.abspath(str(path)): data for path, data in files.items()}
    root = prefix.resolve()
    sites = [str(path) for path in paths if path.resolve().is_relative_to(root)]
    for distribution in importlib.metadata.distributions(path=sites):
        matched: set[str] = set()
        for entry in distribution.files or []:
            path = os.path.abspath(str(distribution.locate_file(entry)))
            if path not in expected or not entry.hash or entry.hash.mode != "sha256":
                continue
            digest = (
                base64.urlsafe_b64encode(hashlib.sha256(expected[path]).digest())
                .decode()
                .rstrip("=")
            )
            if digest == entry.hash.value:
                matched.add(path)
        if len(matched) == len(expected):
            return True
    return False


def kernel_environment(executable: str, environment: dict[str, str], workdir: Path) -> Path:
    """Determine the surviving kernel interpreter's prefix without running a cell."""
    try:
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(
                [executable, "-c", "import json,sys; print(json.dumps(sys.prefix))"],
                env=environment,
                cwd=workdir,
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
            output.seek(0)
            raw = output.read(16385)
        prefix = json.loads(raw)
        if result.returncode != 0 or len(raw) > 16384 or not isinstance(prefix, str):
            raise ValueError("Kernel environment is unavailable")
        path = Path(prefix)
        if not path.is_absolute():
            raise ValueError("Kernel environment is unavailable")
        return path
    except (OSError, subprocess.TimeoutExpired, ValueError, UnicodeError) as error:
        raise ValueError("Kernel environment is unavailable") from error


def read_widget_module(prefix: Path, name: str) -> dict[str, str]:
    """Return a bounded classic bundle with its verified installation version."""
    if not isinstance(name, str) or len(name) > 214 or not _PACKAGE.fullmatch(name):
        raise ValueError("Invalid widget module name")
    base = ("share", "jupyter")
    module = tuple(name.split("/"))
    manifest_parts = (*base, "labextensions", *module, "package.json")
    source_parts = (*base, "nbextensions", *module, "index.js")
    try:
        manifest_bytes = _read_within(prefix, manifest_parts, 65536)
        metadata = json.loads(manifest_bytes)
        version = metadata.get("version")
        if metadata.get("name") != name or not isinstance(version, str) or not version:
            raise ValueError("Widget module metadata does not match")
        source_bytes = _read_within(prefix, source_parts, MAX_WIDGET_MODULE_BYTES)
        if not _owned_by_one_distribution(
            prefix,
            {
                prefix.joinpath(*manifest_parts): manifest_bytes,
                prefix.joinpath(*source_parts): source_bytes,
            },
        ):
            raise ValueError("Widget module files do not match one installed distribution")
        source = source_bytes.decode("utf-8")
    except (UnicodeError, json.JSONDecodeError, AttributeError) as error:
        raise ValueError("Installed widget module metadata or source is invalid") from error
    return {"name": name, "version": version, "source": source}


def read_kernel_widget_module(kernel: KernelHandle, identity: str, name: str) -> dict[str, str]:
    """Resolve the environment only from the process identified by this kernel binding."""
    pid = kernel.pid
    try:
        if not isinstance(pid, int) or kernel.kernel_id != identity:
            raise ValueError("Kernel environment is unavailable")
        process = psutil.Process(pid)
        if not process.is_running() or kernel._identity(pid) != identity:
            raise ValueError("Kernel environment is unavailable")
        command = process.cmdline()
        if "ipykernel_launcher" not in command or str(kernel.conn_file) not in command:
            raise ValueError("Kernel environment is unavailable")
        environment = process.environ()
        if not process.is_running() or kernel._identity(pid) != identity:
            raise ValueError("Kernel environment is unavailable")
        prefix = kernel_environment(command[0], environment, kernel.workdir)
    except (OSError, psutil.Error, IndexError, TypeError) as error:
        raise ValueError("Kernel environment is unavailable") from error
    return read_widget_module(prefix, name)
