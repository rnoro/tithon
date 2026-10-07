"""Verify native/Xvfb dispatch and installed-extension platform selection."""

import json
import os
import platform
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def shell(script, env):
    return subprocess.run(
        ["bash", "-c", f'. "{ROOT}/scripts/lib.sh"\n{script}'],
        env=env,
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    ).stdout


def test_display_dispatch_preserves_linux_and_uses_native_mac(tmp_path):
    xvfb = tmp_path / "xvfb-run"
    xvfb.write_text('#!/bin/sh\nprintf "xvfb:%s\\n" "$1"\nshift\nexec "$@"\n')
    xvfb.chmod(0o755)
    env = dict(os.environ, PATH=f"{tmp_path}:{os.environ['PATH']}")
    command = "run_vscode env TITHON_TEST_VALUE='a b' sh -c 'printf \"native:%s\\n\" \"$TITHON_TEST_VALUE\"'"
    assert shell(f"TITHON_TEST_HOST=Linux\n{command}", env) == "xvfb:-a\nnative:a b\n"
    assert shell(f"TITHON_TEST_HOST=Darwin\n{command}", env) == "native:a b\n"


def test_native_kernel_liveness_checks_real_process_identity():
    process = subprocess.Popen(
        [str(ROOT / ".venv/bin/python"), "-c", "import time; time.sleep(20)", "ipykernel_launcher"]
    )
    try:
        env = dict(os.environ)
        assert (
            shell(f"TITHON_TEST_HOST=Darwin\nkernel_dead {process.pid} || echo alive", env)
            == "alive\n"
        )
        process.terminate()
        process.wait(timeout=5)
        assert (
            shell(f"TITHON_TEST_HOST=Darwin\nkernel_dead {process.pid} && echo dead", env)
            == "dead\n"
        )
        assert (
            shell(f"TITHON_TEST_HOST=Darwin\nkernel_dead {os.getpid()} && echo different", env)
            == "different\n"
        )
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


def test_extension_selector_rejects_other_host_and_picks_latest(tmp_path):
    arch = {"aarch64": "arm64", "x86_64": "x64"}.get(platform.machine(), platform.machine())
    import sys

    for version, target in [
        ("1.0.0", "universal"),
        ("2.0.0", f"{sys.platform}-{arch}"),
        ("99.0.0", "win32-x64"),
    ]:
        directory = tmp_path / f"example.language-{version}"
        directory.mkdir()
        (directory / "package.json").write_text(
            json.dumps({"version": version, "__metadata": {"targetPlatform": target}})
        )
    directory = tmp_path / "example.language-100.0.0-win32-x64"
    directory.mkdir()
    (directory / "package.json").write_text(json.dumps({"version": "100.0.0"}))
    env = dict(os.environ, TITHON_LSP_EXT_ROOT=str(tmp_path))
    assert shell("installed_extension example.language", env).strip() == str(
        tmp_path / "example.language-2.0.0"
    )
