"""The daemon reports its own versions so a bug report needs no manual version list."""

import platform
from importlib.metadata import version

from tithon.daemon import Daemon, runtime_info


def test_runtime_info_names_the_installed_versions():
    info = runtime_info()
    assert info["daemon_version"] == version("tithon")
    assert info["daemon_python"] == platform.python_version()
    assert platform.system() in info["daemon_platform"]


def test_global_status_carries_runtime_info(tmp_path):
    reply = Daemon(tmp_path / "home", tmp_path / "work")._global_status()
    assert reply["daemon_version"] == version("tithon")
    assert reply["daemon_python"] == platform.python_version()
