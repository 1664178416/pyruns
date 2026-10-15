"""On-demand run comparisons retain legacy history without reading task payloads."""

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from pyruns.core.run_inputs import save_run_input
from pyruns.core.task_manager import TaskManager
from pyruns.utils.info_io import save_task_info
from pyruns.web.app import create_app
from pyruns.web.runtime import PyrunsRuntime


def _workspace(tmp_path, name):
    root = tmp_path / name
    (root / "tasks").mkdir(parents=True)
    (root / "script_info.json").write_text(json.dumps({"workspace_kind": "shell", "project_root": str(tmp_path)}))
    return root


def _task(workspace, name, **changes):
    directory = workspace / "tasks" / name
    directory.mkdir()
    save_task_info(str(directory), {
        "name": name, "status": "completed", "run_index": 2, "task_kind": "shell", "config_file": "missing.sh",
        "start_times": ["2026-10-15_10-00-00", "2026-10-15_11-00-00"],
        "finish_times": ["2026-10-15_10-00-10", "2026-10-15_11-00-20"],
        "durations": [10, 20], "exit_codes": [0, 1], "run_statuses": ["completed", "failed"],
        "source_states": ["Git: abc123 clean", "Git: def456 dirty"],
        "run_environments": [{"host": "first", "launcher": "/usr/bin/bash"}, {"host": "second"}],
        "records": [{"accuracy": 0, "enabled": False, "nested": {"loss": 1}}, {"accuracy": 0.9}],
        "tracks": [{"unused": list(range(3000))}, {}], **changes,
    })
    return directory


def _runtime(workspace, monkeypatch):
    monkeypatch.setattr(TaskManager, "_scheduler_loop", lambda self: None)
    return PyrunsRuntime(root_dir=str(workspace))


def _client(runtime):
    client = TestClient(create_app(runtime, access_token="comparison-test-token"))
    client.get("/?token=comparison-test-token")
    return client


def test_compare_runs_supports_cross_task_and_missing_old_input_without_payloads_or_curves(tmp_path, monkeypatch):
    workspace = _workspace(tmp_path, "workspace")
    left = _task(workspace, "baseline")
    right = _task(workspace, "candidate")
    save_run_input(str(right), 2, {"task_kind": "shell", "payload_text": "echo candidate\n", "environment": {}})
    runtime = _runtime(workspace, monkeypatch)
    monkeypatch.setattr(runtime, "require_task", lambda *a, **kw: pytest.fail("Task payload was requested"))
    monkeypatch.setattr(TaskManager, "scan_disk", lambda *a, **kw: pytest.fail("Workspace scan was requested"))
    monkeypatch.setattr("pyruns.utils.track_store.read_tracks", lambda *a, **kw: pytest.fail("Curves were requested"))
    before = {path: path.read_bytes() for path in [left / "task_info.json", right / "task_info.json"]}
    client = _client(runtime)
    response = client.get("/api/tasks/candidate/runs/2/compare?other_task=baseline&other_run=1")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["left"]["reference"] == "baseline@1"
    assert result["left"]["record"] == {"accuracy": 0, "enabled": False, "nested": {"loss": 1}}
    assert result["left"]["exit_code"] == 0
    assert result["right"]["status"] == "failed"
    assert result["right"]["duration_seconds"] == 20
    assert result["right"]["source_state"] == "Git: def456 dirty"
    assert result["right"]["environment"]["host"] == "second"
    assert not result["input_diff"]["available"]
    assert result["input_diff"]["equal"] is None
    assert not result["left"]["input_available"] and result["right"]["input_available"]
    assert "tracks" not in response.text and "payload_text" not in response.text
    same_task = client.get("/api/tasks/candidate/runs/2/compare?other_run=2")
    assert same_task.status_code == 200 and same_task.json()["input_diff"]["equal"]
    assert all(path.read_bytes() == data for path, data in before.items())
    assert not runtime._tasks_loaded


def test_compare_runs_validates_reserved_slots_names_and_corrupt_inputs(tmp_path, monkeypatch):
    workspace = _workspace(tmp_path, "workspace")
    task = _task(workspace, "candidate", status="queued", run_index=3)
    runtime = _runtime(workspace, monkeypatch)
    client = _client(runtime)
    assert client.get("/api/tasks/candidate/runs/3/compare?other_run=1").status_code == 404
    assert client.get("/api/tasks/candidate/runs/2/compare?other_run=0").status_code == 422
    assert client.get("/api/tasks/candidate/runs/2/compare?other_run=1&other_task=missing").status_code == 404
    assert client.get("/api/tasks/candidate/runs/2/compare?other_run=1&other_task=..").status_code == 400
    save_run_input(str(task), 2, {"task_kind": "shell", "payload_text": "echo okay", "environment": {}})
    (task / "run_logs" / "run2.input.json").write_text('{"schema_version": 2}', encoding="utf-8")
    corrupt = client.get("/api/tasks/candidate/runs/2/compare?other_run=1")
    assert corrupt.status_code == 400 and "Invalid run input" in corrupt.text


def test_compare_runs_keeps_both_reads_in_one_workspace_and_rejects_stale_requests(tmp_path, monkeypatch):
    first = _workspace(tmp_path, "first")
    second = _workspace(tmp_path, "second")
    for root in [first, second]:
        _task(root, "same")
    runtime = _runtime(first, monkeypatch)
    client = _client(runtime)
    entered = threading.Event()
    proceed = threading.Event()
    switch_attempted = threading.Event()
    switched = threading.Event()
    from pyruns.web import runtime as runtime_module
    load = runtime_module.load_task_metadata

    def paused_read(task_dir, *args, **kwargs):
        if Path(task_dir) == first / "tasks" / "same":
            entered.set()
            assert proceed.wait(5)
        return load(task_dir, *args, **kwargs)

    monkeypatch.setattr(runtime_module, "load_task_metadata", paused_read)

    def switch():
        switch_attempted.set()
        runtime.reload(str(second))
        switched.set()

    with ThreadPoolExecutor(max_workers=2) as pool:
        reading = pool.submit(client.get, "/api/tasks/same/runs/2/compare?other_run=1",
                              headers={"X-Pyruns-Workspace": quote(str(first), safe="")})
        assert entered.wait(5)
        changing = pool.submit(switch)
        assert switch_attempted.wait(5)
        try:
            assert not switched.wait(0.05)
        finally:
            proceed.set()
        response = reading.result(timeout=10)
        changing.result(timeout=10)
    assert response.status_code == 200, response.text
    stale = client.get("/api/tasks/same/runs/2/compare?other_run=1", headers={"X-Pyruns-Workspace": quote(str(first), safe="")})
    assert stale.status_code == 409 and stale.json()["code"] == "workspace_changed"
