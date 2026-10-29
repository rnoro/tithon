import base64
import csv
import hashlib
import json
import os
from types import SimpleNamespace

import pytest

from tithon.widget_mapping import classic_mappings
from tithon.widget_modules import read_kernel_widget_module, read_widget_module


def installed(prefix, name, version, source):
    nb = prefix / "share" / "jupyter" / "nbextensions" / name
    lab = prefix / "share" / "jupyter" / "labextensions" / name
    nb.mkdir(parents=True)
    lab.mkdir(parents=True)
    (nb / "index.js").write_text(source)
    (lab / "package.json").write_text(json.dumps({"name": name, "version": version}))
    site = prefix / "lib/python3.13/site-packages"
    dist = site / f"{name}-1.0.dist-info"
    dist.mkdir(parents=True)
    (dist / "METADATA").write_text(f"Name: {name}\nVersion: 1.0\n")
    with (dist / "RECORD").open("w", newline="") as stream:
        writer = csv.writer(stream)
        for path in (nb / "index.js", lab / "package.json"):
            data = path.read_bytes()
            digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
            writer.writerow([os.path.relpath(path, site), f"sha256={digest}", len(data)])


def record_extra(prefix, name, path):
    site = prefix / "lib/python3.13/site-packages"
    data = path.read_bytes()
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
    with (site / f"{name}-1.0.dist-info/RECORD").open("a", newline="") as stream:
        csv.writer(stream).writerow([os.path.relpath(path, site), f"sha256={digest}", len(data)])


def test_reads_installed_frontend_and_its_javascript_version(tmp_path):
    installed(tmp_path, "bqplot", "0.6.1", "define([], () => ({}));")
    assert read_widget_module(tmp_path, "bqplot") == {
        "name": "bqplot",
        "version": "0.6.1",
        "source": "define([], () => ({}));",
    }


@pytest.mark.parametrize(
    "name", ["../secrets", "/tmp/x", "foo/../../secret", "@x/../y", "x\\y", ""]
)
def test_rejects_names_that_are_not_package_names(tmp_path, name):
    with pytest.raises(ValueError):
        read_widget_module(tmp_path, name)


def test_rejects_missing_or_mismatched_metadata(tmp_path):
    installed(tmp_path, "chart", "1.0.0", "x")
    manifest = tmp_path / "share/jupyter/labextensions/chart/package.json"
    manifest.write_text(json.dumps({"name": "other", "version": "1.0.0"}))
    with pytest.raises(ValueError):
        read_widget_module(tmp_path, "chart")


def test_rejects_script_symlinks_outside_the_environment(tmp_path):
    prefix = tmp_path / "env"
    installed(prefix, "chart", "1.0.0", "x")
    outside = tmp_path / "secret"
    outside.write_text("secret")
    script = prefix / "share/jupyter/nbextensions/chart/index.js"
    script.unlink()
    script.symlink_to(outside)
    with pytest.raises(ValueError):
        read_widget_module(prefix, "chart")


def test_rejects_oversized_module(tmp_path):
    installed(tmp_path, "chart", "1.0.0", "x" * (4 * 1024 * 1024 + 1))
    with pytest.raises(ValueError):
        read_widget_module(tmp_path, "chart")


def test_rejects_source_changed_after_installation(tmp_path):
    installed(tmp_path, "chart", "2.0.0", "original")
    (tmp_path / "share/jupyter/nbextensions/chart/index.js").write_text("older bundle")
    with pytest.raises(ValueError, match="distribution"):
        read_widget_module(tmp_path, "chart")


def test_rejects_file_replaced_by_symlink_at_open(tmp_path, monkeypatch):
    prefix = tmp_path / "env"
    installed(prefix, "chart", "1.0.0", "x")
    outside = tmp_path / "secret"
    outside.write_text("secret")
    script = prefix / "share/jupyter/nbextensions/chart/index.js"
    original_open = os.open

    def raced_open(path, flags, *args, **kwargs):
        if path == "index.js":
            script.unlink()
            script.symlink_to(outside)
        return original_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", raced_open)
    with pytest.raises(ValueError):
        read_widget_module(prefix, "chart")


def test_rejects_fifo_without_blocking(tmp_path):
    installed(tmp_path, "chart", "1.0.0", "x")
    script = tmp_path / "share/jupyter/nbextensions/chart/index.js"
    script.unlink()
    os.mkfifo(script)
    with pytest.raises(ValueError):
        read_widget_module(tmp_path, "chart")


def test_extracts_literal_requirejs_mappings_without_executing_code():
    source = """define(() => {
        window.requirejs.config({map: {'*': {
            chart: 'nbextensions/chart/index', three: 'nbextensions/chart/three'
        }}});
    });"""
    assert classic_mappings(source) == {
        "chart": "nbextensions/chart/index",
        "three": "nbextensions/chart/three",
    }
    assert classic_mappings("// requirejs.config({map: {'*': {three: 'evil'}}})") == {}
    assert classic_mappings("requirejs[config]({map: {'*': {three: 'evil'}}})") == {}
    assert classic_mappings("requirejs.config({map: {'*': {three: dynamic}}})") == {}
    assert (
        classic_mappings("requirejs.config({map:{'*':{first:'same/path',second:'same/path.js'}}})")
        == {}
    )


def test_reads_real_installed_pythreejs_dependency():
    import sys
    from pathlib import Path

    result = read_widget_module(Path(sys.prefix), "jupyter-threejs")
    assert result["version"] == "2.4.1"
    assert result["dependencies"]["three"].startswith("// threejs.org/license")


def test_rejects_mapped_dependency_not_owned_by_distribution(tmp_path):
    installed(tmp_path, "chart", "1.0.0", "x")
    folder = tmp_path / "share/jupyter/nbextensions/chart"
    (folder / "extension.js").write_text(
        "requirejs.config({map:{'*':{chart:'nbextensions/chart/index',"
        "three:'nbextensions/chart/three'}}})"
    )
    record_extra(tmp_path, "chart", folder / "extension.js")
    (folder / "three.js").write_text("malicious")
    with pytest.raises(ValueError, match="distribution"):
        read_widget_module(tmp_path, "chart")


@pytest.mark.parametrize(
    "target", ["nbextensions/chart/../secret", "https://evil/x", "nbextensions/other/x"]
)
def test_rejects_dependency_paths_outside_own_extension(tmp_path, target):
    installed(tmp_path, "chart", "1.0.0", "x")
    folder = tmp_path / "share/jupyter/nbextensions/chart"
    (folder / "extension.js").write_text(
        f"requirejs.config({{map:{{'*':{{chart:'nbextensions/chart/index',three:'{target}'" + "}}})"
    )
    record_extra(tmp_path, "chart", folder / "extension.js")
    with pytest.raises(ValueError, match="dependency path"):
        read_widget_module(tmp_path, "chart")


@pytest.mark.parametrize("replacement", ["command", "identity"])
def test_rejects_kernel_pid_replacement_before_environment_probe(
    tmp_path, monkeypatch, replacement
):
    connection = tmp_path / "kernel.json"
    identities = iter(["original", "replacement" if replacement == "identity" else "original"])
    kernel = SimpleNamespace(
        pid=123,
        kernel_id="original",
        conn_file=connection,
        workdir=tmp_path,
        _identity=lambda _: next(identities),
    )
    process = SimpleNamespace(
        is_running=lambda: True,
        cmdline=lambda: (
            ["/other/program"]
            if replacement == "command"
            else ["/python", "-m", "ipykernel_launcher", "-f", str(connection)]
        ),
        environ=lambda: {},
    )
    monkeypatch.setattr("tithon.widget_modules.psutil.Process", lambda _: process)
    probe = []
    monkeypatch.setattr(
        "tithon.widget_modules.kernel_environment", lambda *args: probe.append(args)
    )
    with pytest.raises(ValueError, match="Kernel environment is unavailable"):
        read_kernel_widget_module(kernel, "original", "chart")
    assert not probe
