"""Measure workspace I/O on a selected filesystem using a disposable fixture.

New runtime measurements reset Pyruns caches, not the operating system or NFS
server caches. Timings and separately counted Python I/O describe this machine.
No existing workspace is opened and no task is executed.
"""

from __future__ import annotations

import argparse
from collections import Counter
from contextlib import ExitStack
from functools import wraps
import json
import os
from pathlib import Path
import platform
import shutil
import statistics
import sys
import tempfile
import threading
import time
import traceback
from unittest.mock import patch
import uuid


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.benchmark_scaling import _make_workspace, _source_state  # noqa: E402


class PythonIO:
    """Count Python probes and bounded reads, including loading worker threads.

    These are calls, not kernel syscalls, disk transfers, or NFS RPCs. DirEntry
    may satisfy stat/type checks from enumeration data. Ripgrep performs its own
    reads in child processes; only its launch count is observed here.
    """

    def __init__(self, root):
        self.root = os.path.normcase(os.path.abspath(root))
        self.counts = Counter()
        self.lock = threading.Lock()
        self.stack = ExitStack()

    def add(self, key, amount=1):
        with self.lock:
            self.counts[key] += amount

    def contains(self, path):
        if not isinstance(path, (str, bytes, os.PathLike)):
            return False
        try:
            value = os.path.normcase(os.path.abspath(os.fsdecode(path)))
            return os.path.commonpath([value, self.root]) == self.root
        except ValueError:
            return False

    def path_call(self, original, label):
        @wraps(original)
        def call(path, *args, **kwargs):
            if self.contains(path):
                self.add(label)
            return original(path, *args, **kwargs)
        return call

    def __enter__(self):
        from pyruns.utils import info_io, log_search, task_files

        for owner, name in ((os, "stat"), (os, "lstat"), (os, "open"), (os.path, "realpath")):
            original = getattr(owner, name)
            self.stack.enter_context(patch.object(owner, name, self.path_call(original, name)))

        original_scandir = os.scandir
        counter = self

        class Entry:
            def __init__(self, entry):
                self.entry = entry

            def __getattr__(self, name):
                return getattr(self.entry, name)

            def stat(self, *args, **kwargs):
                counter.add("direntry_stat")
                return self.entry.stat(*args, **kwargs)

            def is_dir(self, *args, **kwargs):
                counter.add("direntry_is_dir")
                return self.entry.is_dir(*args, **kwargs)

            def is_file(self, *args, **kwargs):
                counter.add("direntry_is_file")
                return self.entry.is_file(*args, **kwargs)

        class Entries:
            def __init__(self, iterator):
                self.iterator = iterator

            def __enter__(self):
                self.iterator.__enter__()
                return self

            def __exit__(self, *args):
                return self.iterator.__exit__(*args)

            def __iter__(self):
                return self

            def __next__(self):
                entry = next(self.iterator)
                counter.add("scandir_entries")
                return Entry(entry)

            def close(self):
                self.iterator.close()

        def scandir(path="."):
            iterator = original_scandir(path)
            if not self.contains(path):
                return iterator
            self.add("scandir")
            return Entries(iterator)

        self.stack.enter_context(patch.object(os, "scandir", scandir))
        for owner, category in ((info_io, "metadata"), (task_files, "payload")):
            original_read = owner.read_bounded_bytes

            def read(handle, limit, original_read=original_read, category=category):
                data = original_read(handle, limit)
                if self.contains(handle.name):
                    self.add(f"{category}_reads")
                    self.add(f"{category}_bytes", len(data))
                return data

            self.stack.enter_context(patch.object(owner, "read_bounded_bytes", read))

        original_popen = log_search.subprocess.Popen

        def popen(arguments, *args, **kwargs):
            process = original_popen(arguments, *args, **kwargs)
            if Path(arguments[0]).name in {"rg", "rg.exe"}:
                self.add("ripgrep_launches")
            return process

        self.stack.enter_context(patch.object(log_search.subprocess, "Popen", popen))
        return self

    def __exit__(self, *args):
        return self.stack.__exit__(*args)


def _filesystem(root):
    import psutil

    entry = max(
        (item for item in psutil.disk_partitions(all=True)
         if root.is_relative_to(Path(item.mountpoint))),
        key=lambda item: len(item.mountpoint), default=None,
    )
    return {
        "detection": "psutil.disk_partitions(all=True); longest matching mountpoint",
        "mountpoint": entry.mountpoint if entry else None,
        "type": entry.fstype if entry else None,
        "options": entry.opts if entry else None,
        "is_nfs": entry.fstype.lower() in {"nfs", "nfs4"} if entry else None,
    }


def _cleanup_fixture(root, parent, token, identity):
    """Delete only the exact marked directory created by this invocation."""
    current = root.lstat()
    if (root.is_symlink() or root.parent != parent or root.resolve().parent != parent
            or not root.name.startswith("pyruns-workspace-io-")
            or (current.st_dev, current.st_ino) != identity
            or (root / ".benchmark-owner").read_text(encoding="ascii") != token):
        raise ValueError(f"Refusing to clean a changed benchmark directory: {root}")
    shutil.rmtree(root)


def _measure(call, check, root, samples, *, cleanup=lambda: None):
    timings = []
    for _ in range(samples):
        try:
            started = time.perf_counter()
            value = call()
            timings.append((time.perf_counter() - started) * 1000)
            check(value)
        finally:
            cleanup()
    # Instrumentation is a separate observation; it does not inflate timings.
    try:
        with PythonIO(root) as observed:
            value = call()
        check(value)
    finally:
        cleanup()
    return {
        "samples_ms": timings, "median_ms": statistics.median(timings), "max_ms": max(timings),
        "python_io_single_observation": dict(sorted(observed.counts.items())), "passed": True,
    }


def benchmark(root, count, samples, log_kib, save):
    from pyruns.core.task_manager import TaskManager
    from pyruns.utils.info_io import load_task_metadata
    from pyruns.utils.log_search import LogSearch, ripgrep_path
    from pyruns.utils.task_files import read_task_payload_snapshot
    from pyruns.web.runtime import PyrunsRuntime

    workspace, fixtures = _make_workspace(root, count)
    expected_logs = 0
    log_bytes = 0
    for name, (_, info) in fixtures.items():
        if info["run_index"]:
            text = "fixture filler line\n" * max(1, log_kib * 1024 // 20)
            data = (text + f"pyruns-benchmark-match {name}\n").encode("utf-8")
            (workspace / "tasks" / name / "run_logs" / "run1.log").write_bytes(data)
            expected_logs += 1
            log_bytes += len(data)
    stages = {}
    record = {"workspace": str(workspace), "tasks": count, "log_files": expected_logs,
              "log_bytes": log_bytes, "stages": stages}

    def new_runtime():
        return PyrunsRuntime(str(workspace), task_manager_factory=lambda tasks_dir: TaskManager(
            tasks_dir=tasks_dir, lazy_scan=None, owns_task_lifecycle=False,
        ))

    def check_page(page):
        assert page.total == count and len(page.items) == min(50, count)
        assert sum(page.status_counts.values()) == count
        assert not any(item.get("_load_error") for item in page.items)

    def measure(label, call, check, **kwargs):
        stages[label] = _measure(call, check, root, samples, **kwargs)
        save(record)

    cold_runtimes = []

    def first_list():
        runtime = new_runtime()
        cold_runtimes.append(runtime)
        return runtime.list_tasks(summary=True, refresh=False, sort_mode="name_asc")

    def close_cold():
        while cold_runtimes:
            cold_runtimes.pop().shutdown()

    # Imports and dependency lookup are outside timing, as with the scale suite.
    ripgrep_path()
    measure("new_runtime_first_list", first_list, check_page, cleanup=close_cold)
    runtime = new_runtime()
    try:
        check_page(runtime.list_tasks(summary=True, refresh=False))
        manager = runtime.task_manager
        tasks = workspace / "tasks"
        names = sorted(fixtures)

        def check_scan(result):
            assert result[0] and sorted(result[1]) == names

        measure("directory_discovery", lambda: manager._scan_task_dir_names(raise_on_error=True), check_scan)

        def check_metadata(values):
            assert len(values) == count
            for name, value in zip(names, values, strict=True):
                assert value["name"] == name and value["status"] == fixtures[name][1]["status"]

        measure("metadata_read_parse", lambda: [
            load_task_metadata(str(tasks / name), raise_error=True) for name in names
        ], check_metadata)

        def check_payload(values):
            assert len(values) == count
            for name, value in zip(names, values, strict=True):
                assert not value.load_error and value.config == fixtures[name][0]

        measure("payload_read_parse", lambda: [
            read_task_payload_snapshot(str(tasks / name), fixtures[name][1], config_view=True)
            for name in names
        ], check_payload)
        measure("warm_summary_list", lambda: runtime.list_tasks(summary=True, refresh=False), check_page)

        def unchanged(result):
            assert result is False

        measure("metadata_refresh", lambda: manager.refresh_from_disk(
            check_all=True, check_payload=False, raise_on_error=True,
        ), unchanged)
        measure("payload_refresh", lambda: manager.refresh_from_disk(
            check_all=True, check_payload=True, raise_on_error=True,
        ), unchanged)
        measure("forced_list_refresh", lambda: runtime.list_tasks(
            summary=True, refresh=True, force_refresh=True,
        ), check_page)

        def search(*, fresh):
            if fresh:
                runtime._log_search = LogSearch()
            return runtime.search_tasks(
                query="pyruns-benchmark-match", search_field="log", refresh=False,
                max_results=0, cancelled=threading.Event(),
            )

        def check_search(page):
            assert page.total == expected_logs and len(page.items) == min(50, expected_logs)
            assert not page.search_errors and page.search_complete and not page.search_limit_hit
            assert all(item["search_match_count"] == 1 for item in page.items)

        measure("log_search_new_cache", lambda: search(fresh=True), check_search)
        measure("log_search_reuse_cache", lambda: search(fresh=False), check_search)
        return record
    finally:
        runtime.shutdown()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--temp-root", type=Path, required=True,
                        help="Existing parent on the filesystem to measure, e.g. /mnt/nfs/benchmarks")
    parser.add_argument("--tasks", type=int, default=1000, help="Disposable fixture task count (default: 1000)")
    parser.add_argument("--samples", type=int, default=5, help="Timing samples per operation (default: 5)")
    parser.add_argument("--log-kib", type=int, default=4, help="Approximate fixture KiB per log (default: 4)")
    parser.add_argument("--output", type=Path, required=True, help="JSON report path, outside the disposable fixture")
    args = parser.parse_args()
    if min(args.tasks, args.samples, args.log_kib) < 1:
        parser.error("--tasks, --samples and --log-kib must be positive")
    parent = args.temp_root.resolve(strict=True)
    if not parent.is_dir():
        parser.error("--temp-root must be an existing directory")
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="pyruns-workspace-io-", dir=parent))
    token = uuid.uuid4().hex
    (root / ".benchmark-owner").write_text(token, encoding="ascii")
    info = root.lstat()
    identity = (info.st_dev, info.st_ino)
    report = {
        "schema_version": 1, "passed": False, "python": sys.version, "platform": platform.platform(),
        "source": _source_state(), "filesystem": _filesystem(root), "temporary_directory": str(root),
        "cache_state": "new runtime resets Pyruns caches only; OS/client/server caches are not cleared; fixture just written",
        "timing_scope": "operation only; imports, fixture creation, validation, I/O counting and shutdown excluded",
        "io_scope": "separate single observation; fixture-path Python calls and bytes returned by bounded document reads; "
                    "DirEntry can reuse enumeration attributes; excludes ripgrep child I/O, kernel syscalls, disk bytes and NFS RPCs",
        "cleanup": "pending; failures retain the isolated fixture", "case": None,
    }

    def save(case=None):
        if case is not None:
            report["case"] = case
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    try:
        save()
        benchmark(root, args.tasks, args.samples, args.log_kib, save)
        _cleanup_fixture(root, parent, token, identity)
        report.update(passed=True, cleanup="removed owned fixture after successful validation")
    except Exception:
        report["error"] = traceback.format_exc()
        report["cleanup"] = "retained fixture for diagnosis; remove only temporary_directory after inspection"
        print(report["error"], file=sys.stderr)
    finally:
        save()
    print(json.dumps({"passed": report["passed"], "filesystem": report["filesystem"],
                      "cleanup": report["cleanup"], "output": str(output)}), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
