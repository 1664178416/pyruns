"""Bind edits and namespace actions to the task instance or admission observed."""

from pathlib import Path

import pytest

from pyruns.core.task_generator import TaskGenerator
from pyruns.core.task_manager import TaskManager, TaskStateConflict
from pyruns.utils.info_io import load_task_metadata, update_task_metadata


def _manager(tasks_dir, monkeypatch):
    manager = TaskManager(str(tasks_dir), lazy_scan=False, owns_task_lifecycle=False)
    monkeypatch.setattr(manager, "trigger_update", lambda: None)
    return manager


@pytest.mark.parametrize("operation", ["notes", "env"])
@pytest.mark.parametrize("refresh", [False, True])
def test_edit_rejects_same_name_replacement_even_after_manager_refresh(tmp_path, monkeypatch, operation, refresh):
    tasks_dir = tmp_path / "tasks"
    generator = TaskGenerator(str(tasks_dir))
    generator.create_task("alpha", {"instance": "original"}, exact_name=True)
    editor = _manager(tasks_dir, monkeypatch)
    original_identity = editor.get_task("alpha").get("task_identity")
    mover = _manager(tasks_dir, monkeypatch)
    assert mover.rename_task("alpha", "original-renamed")[0]
    replacement = generator.create_task("alpha", {"instance": "replacement"}, exact_name=True)
    kwargs = {}
    if refresh:
        assert editor.refresh_from_disk(check_all=True)
        assert editor.get_task("alpha")["task_identity"] != original_identity
        kwargs["expected_task_identity"] = original_identity

    with pytest.raises(TaskStateConflict, match="identity changed"):
        if operation == "notes":
            editor.update_task_notes("alpha", "old editor", "", **kwargs)
        else:
            editor.update_task_env("alpha", {"OLD_EDITOR": "1"}, {}, **kwargs)
    info = load_task_metadata(replacement["dir"])
    assert not info.get(operation)
    assert "task_identity" not in info


def test_load_cannot_assign_replacement_identity_to_old_metadata(tmp_path, monkeypatch):
    tasks_dir = tmp_path / "tasks"
    generator = TaskGenerator(str(tasks_dir))
    task = generator.create_task("alpha", {"instance": "original"}, exact_name=True)
    original_identity = TaskManager._task_identity_token(task["dir"])
    replaced = False

    def replace_after_read(task_dir, *args, **kwargs):
        nonlocal replaced
        info = load_task_metadata(task_dir, *args, **kwargs)
        if not replaced and task_dir == task["dir"]:
            replaced = True
            (tasks_dir / "alpha").rename(tasks_dir / "original-renamed")
            generator.create_task("alpha", {"instance": "replacement"}, exact_name=True)
        return info

    monkeypatch.setattr("pyruns.core.task_manager.load_task_metadata", replace_after_read)
    manager = _manager(tasks_dir, monkeypatch)
    assert replaced
    assert manager.get_task("alpha")["task_identity"] == original_identity
    with pytest.raises(TaskStateConflict, match="identity changed"):
        manager.update_task_notes("alpha", "old editor", "")
    assert not load_task_metadata(task["dir"]).get("notes")


def test_directory_identity_survives_normal_edits_and_rename(tmp_path, monkeypatch):
    tasks_dir = tmp_path / "tasks"
    task = TaskGenerator(str(tasks_dir)).create_task("alpha", {"value": 1}, exact_name=True)
    manager = _manager(tasks_dir, monkeypatch)
    identity = manager.get_task("alpha").get("task_identity")
    assert identity
    assert manager.update_task_notes("alpha", "note", "", expected_task_identity=identity)[0]
    assert manager.update_task_env("alpha", {"VALUE": "2"}, {}, expected_task_identity=identity)[0]
    assert manager.get_task("alpha", summary=True)["task_identity"] == identity
    assert manager.rename_task("alpha", "renamed")[0]
    assert manager.get_task("renamed")["task_identity"] == identity
    assert "task_identity" not in load_task_metadata(str(tasks_dir / "renamed"))
    assert task["name"] == "alpha"
    monkeypatch.setattr(
        TaskManager, "_directory_identity",
        staticmethod(lambda _path: pytest.fail("serializing a cached identity must not stat task directories")),
    )
    assert manager.get_task("renamed", summary=True)["task_identity"] == identity
    assert manager.get_task("renamed")["task_identity"] == identity


@pytest.mark.parametrize("operation,replacement_status", [
    ("delete", "pending"), ("delete", "queued"), ("rename", "pending"),
])
def test_namespace_action_rejects_replaced_cached_task(tmp_path, monkeypatch, operation, replacement_status):
    tasks_dir = tmp_path / "tasks"
    generator = TaskGenerator(str(tasks_dir))
    generator.create_task("alpha", {"instance": "original"}, exact_name=True)
    manager = _manager(tasks_dir, monkeypatch)
    mover = _manager(tasks_dir, monkeypatch)
    assert mover.rename_task("alpha", "original-renamed")[0]
    replacement = generator.create_task("alpha", {"instance": "replacement"}, exact_name=True)
    if replacement_status == "queued":
        mover.scan_disk()
        assert mover._sync_status_to_disk("alpha", "queued", expected_statuses={"pending"})
        update_task_metadata(replacement["dir"], lambda info: info.update({
            "runner_id": manager.runner_id, "runner_host": manager.runner_host,
        }))
    before = (tasks_dir / "alpha" / "task_info.json").read_bytes()
    for method in ("_mark_failed_on_disk", "_persist_pending_stop_summary"):
        monkeypatch.setattr(manager, method, lambda *a, **kw: pytest.fail("replacement must not be stopped"))

    if operation == "delete":
        assert manager.delete_tasks(["alpha"]) == []
    else:
        renamed, reason = manager.rename_task("alpha", "wrongly-renamed")
        assert not renamed and "identity changed" in reason
    assert (tasks_dir / "alpha" / "task_info.json").read_bytes() == before
    assert load_task_metadata(replacement["dir"])["status"] == replacement_status
    assert (tasks_dir / "original-renamed").is_dir()


def test_delete_keeps_original_identity_when_name_is_reused_after_metadata_read(tmp_path, monkeypatch):
    tasks_dir = tmp_path / "tasks"
    generator = TaskGenerator(str(tasks_dir))
    task = generator.create_task("alpha", {"instance": "original"}, exact_name=True)
    manager = _manager(tasks_dir, monkeypatch)
    mover = _manager(tasks_dir, monkeypatch)
    replacement_bytes = []

    def replace_after_read(task_dir, *args, **kwargs):
        info = load_task_metadata(task_dir, *args, **kwargs)
        if not replacement_bytes and Path(task_dir) == Path(task["dir"]):
            replacement_bytes.append(b"")
            assert mover.rename_task("alpha", "original-renamed")[0]
            generator.create_task("alpha", {"instance": "replacement"}, exact_name=True)
            replacement_bytes[0] = (tasks_dir / "alpha" / "task_info.json").read_bytes()
        return info

    monkeypatch.setattr("pyruns.core.task_manager.load_task_metadata", replace_after_read)
    assert manager.delete_tasks(["alpha"]) == []
    assert replacement_bytes and (tasks_dir / "alpha" / "task_info.json").read_bytes() == replacement_bytes[0]
    assert (tasks_dir / "original-renamed").is_dir()


def _queued_task(tmp_path, monkeypatch):
    tasks_dir = tmp_path / "tasks"
    task = TaskGenerator(str(tasks_dir)).create_task("alpha", {"value": 1}, exact_name=True)
    manager = _manager(tasks_dir, monkeypatch)
    assert manager._sync_status_to_disk("alpha", "queued", expected_statuses={"pending"})
    return manager, task


def _replace_queued_attempt(manager, original_mark):
    original_mark(manager.get_task("alpha"), final_status="cancelled")
    manager.scan_disk()
    assert manager.rerun_task("alpha")


def test_delete_cannot_stop_a_requeued_attempt_with_same_owner_and_index(tmp_path, monkeypatch):
    manager, task = _queued_task(tmp_path, monkeypatch)
    original_mark = manager._mark_failed_on_disk

    def replace_before_stop(*args, **kwargs):
        _replace_queued_attempt(manager, original_mark)
        return original_mark(*args, **kwargs)

    monkeypatch.setattr(manager, "_mark_failed_on_disk", replace_before_stop)
    assert manager.delete_tasks(["alpha"]) == []
    assert load_task_metadata(task["dir"])["status"] == "queued"


def test_delete_move_rechecks_attempt_after_stop_completed(tmp_path, monkeypatch):
    manager, task = _queued_task(tmp_path, monkeypatch)
    original_begin = manager._begin_namespace_operation

    def replace_before_move(*args, **kwargs):
        manager.scan_disk()
        assert manager.rerun_task("alpha")
        manager._mark_failed_on_disk(manager.get_task("alpha"), final_status="cancelled")
        return original_begin(*args, **kwargs)

    monkeypatch.setattr(manager, "_begin_namespace_operation", replace_before_move)
    assert manager.delete_tasks(["alpha"]) == []
    assert load_task_metadata(task["dir"])["status"] == "cancelled"


def test_old_cancel_request_cannot_cancel_requeued_attempt(tmp_path, monkeypatch):
    manager, task = _queued_task(tmp_path, monkeypatch)
    update_task_metadata(task["dir"], lambda info: info.update({"cancel_requested_at": "2026-01-01"}))
    manager.scan_disk()
    original_cancel = manager.cancel_task
    original_mark = manager._mark_failed_on_disk

    def replace_before_cancel(*args, **kwargs):
        _replace_queued_attempt(manager, original_mark)
        return original_cancel(*args, **kwargs)

    monkeypatch.setattr(manager, "cancel_task", replace_before_cancel)
    manager._process_cancel_requests()
    assert load_task_metadata(task["dir"])["status"] == "queued"
