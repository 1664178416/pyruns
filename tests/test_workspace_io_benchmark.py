"""The filesystem benchmark counts its fixture and preserves cleanup boundaries."""

import json
import os
from pathlib import Path
import tempfile

import pytest

from scripts import benchmark_workspace_io as benchmark


def test_workspace_io_counts_bounded_reads_only_inside_fixture(tmp_path):
    from pyruns.utils.info_io import load_task_metadata
    from pyruns.utils.task_files import read_task_payload_snapshot

    root = tmp_path / "fixture"
    workspace, fixtures = benchmark._make_workspace(root, 1)
    other_workspace, _ = benchmark._make_workspace(tmp_path / "unrelated", 1)
    name = next(iter(fixtures))
    task = workspace / "tasks" / name
    with benchmark.PythonIO(root) as observed:
        assert load_task_metadata(str(task))["name"] == name
        assert not read_task_payload_snapshot(str(task), fixtures[name][1]).load_error
        assert load_task_metadata(str(other_workspace / "tasks" / name))["name"] == name
        with os.scandir(workspace / "tasks") as entries:
            entry = next(entries)
            assert entry.is_dir()
            entry.stat()
    assert observed.counts["metadata_reads"] == 1
    assert observed.counts["metadata_bytes"] == (task / "task_info.json").stat().st_size
    assert observed.counts["payload_reads"] == 1
    assert observed.counts["payload_bytes"] == (task / "config.yaml").stat().st_size
    assert observed.counts["scandir"] == observed.counts["scandir_entries"] == 1
    assert observed.counts["direntry_stat"] == observed.counts["direntry_is_dir"] == 1


@pytest.mark.parametrize("changed", ["marker", "identity"])
def test_workspace_io_cleanup_refuses_changed_ownership(tmp_path, changed):
    root = Path(tempfile.mkdtemp(prefix="pyruns-workspace-io-", dir=tmp_path))
    (root / ".benchmark-owner").write_text("owned", encoding="ascii")
    sentinel = root / "keep.txt"
    sentinel.write_text("keep", encoding="utf-8")
    info = root.lstat()
    identity = (info.st_dev, info.st_ino)
    if changed == "marker":
        (root / ".benchmark-owner").write_text("replaced", encoding="ascii")
    else:
        identity = (info.st_dev, info.st_ino + 1)
    with pytest.raises(ValueError, match="Refusing to clean"):
        benchmark._cleanup_fixture(root, tmp_path.resolve(), "owned", identity)
    assert sentinel.read_text(encoding="utf-8") == "keep"


@pytest.mark.parametrize("fail", [False, True])
def test_workspace_io_success_cleans_and_failure_retains_only_its_fixture(tmp_path, monkeypatch, fail):
    from pyruns import _config

    # Runtime reload changes these globals in this disposable benchmark process.
    monkeypatch.setattr(_config, "ROOT_DIR", _config.ROOT_DIR)
    monkeypatch.setenv(_config.ENV_KEY_ROOT, os.getenv(_config.ENV_KEY_ROOT, ""))
    foreign = tmp_path / "existing-task"
    foreign.mkdir()
    sentinel = foreign / "task_info.json"
    sentinel.write_bytes(b'{"status":"running"}')
    output = tmp_path / "report.json"
    monkeypatch.setattr("sys.argv", ["benchmark", "--temp-root", str(tmp_path), "--tasks", "12",
                                    "--samples", "1", "--log-kib", "1", "--output", str(output)])
    if fail:
        def broken(*args, **kwargs):
            raise RuntimeError("injected benchmark failure")

        monkeypatch.setattr(benchmark, "benchmark", broken)
    assert benchmark.main() == int(fail)
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["passed"] is not fail
    fixture = Path(report["temporary_directory"])
    assert fixture.parent == tmp_path.resolve()
    assert fixture.exists() is fail
    assert sentinel.read_bytes() == b'{"status":"running"}'
    if fail:
        assert "injected benchmark failure" in report["error"]
        assert (fixture / ".benchmark-owner").is_file()
    else:
        stages = report["case"]["stages"]
        assert stages["new_runtime_first_list"]["python_io_single_observation"]["metadata_reads"] == 12
        assert stages["warm_summary_list"]["python_io_single_observation"] == {}
        assert stages["log_search_new_cache"]["python_io_single_observation"]["ripgrep_launches"] > 0
