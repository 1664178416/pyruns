"""Installation diagnostics must explain broken imports without needing a workspace."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from pyruns.cli.app import main
from pyruns.launcher import bootstrap_shell_workspace


def test_doctor_checks_storage_without_changing_project_and_tolerates_missing_gpu(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    workspace = Path(bootstrap_shell_workspace(str(tmp_path / "_pyruns_")))
    before = {path.relative_to(tmp_path): path.read_bytes() for path in tmp_path.rglob("*") if path.is_file()}
    which = shutil.which
    monkeypatch.setattr(shutil, "which", lambda name, *args, **kwargs: None if name == "nvidia-smi" else which(name, *args, **kwargs))
    status = main(["-C", str(tmp_path), "-w", "shell", "doctor", "--json"])
    report = json.loads(capsys.readouterr().out)
    assert status == 0, report
    assert report["schema_version"] == 1 and report["ok"]
    checks = {check["name"]: check for check in report["checks"]}
    assert checks["workspace"]["status"] == "ok"
    assert checks["gpu"]["status"] == "skipped"
    assert checks["ripgrep"]["status"] == "ok"
    after = {path.relative_to(tmp_path): path.read_bytes() for path in tmp_path.rglob("*") if path.is_file()}
    assert before == after
    assert not list(workspace.glob(".pyruns-doctor-*"))


def test_doctor_reports_broken_dependency_from_clean_cli_process(tmp_path):
    (tmp_path / "omegaconf.py").write_text("raise ImportError('broken dependency for doctor')\n", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, "-c", "from pyruns.cli.app import main; raise SystemExit(main(['doctor', '--json']))"],
        cwd=tmp_path,
        env={**os.environ, "PYTHONPATH": str(tmp_path) + os.pathsep + str(Path(__file__).resolve().parents[1])},
        capture_output=True, text=True, encoding="utf-8", timeout=30, check=False,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    assert result.returncode == 1, result.stderr
    report = json.loads(result.stdout)
    checks = {check["name"]: check for check in report["checks"]}
    assert checks["omegaconf"]["status"] == "error"
    assert "broken dependency for doctor" in checks["omegaconf"]["detail"]
    assert "pip install" in checks["omegaconf"]["remedy"]
    assert checks["runtime"]["status"] == "skipped"
    assert "Traceback" not in result.stderr
    assert not (tmp_path / "_pyruns_").exists()


def test_doctor_fails_when_workspace_cannot_exclude_another_writer(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    bootstrap_shell_workspace(str(tmp_path / "_pyruns_"))
    from pyruns.utils.native_lock import NativeFileGuard

    monkeypatch.setattr(NativeFileGuard, "try_acquire", lambda self: True)
    status = main(["-C", str(tmp_path), "-w", "shell", "doctor", "--json"])
    report = json.loads(capsys.readouterr().out)
    assert status == 1
    storage = next(check for check in report["checks"] if check["name"] == "workspace")
    assert storage["status"] == "error" and "second writer" in storage["detail"]
