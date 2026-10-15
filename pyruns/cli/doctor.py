"""One-shot installation diagnostics, importable even when dependencies are broken."""

from __future__ import annotations

import importlib
from importlib import metadata
import json
import os
import platform
import shlex
import shutil
import subprocess
import sys
import tempfile
from typing import Any


_IMPORTS = {
    "anyio": "anyio", "fastapi": "fastapi", "omegaconf": "omegaconf",
    "packaging": "packaging", "pydantic": "pydantic", "psutil": "psutil",
    "pyyaml": "yaml", "regex": "regex", "uvicorn": "uvicorn", "websockets": "websockets",
}


def _repair_command() -> str:
    command = [sys.executable, "-m", "pip", "install", "--upgrade", "--force-reinstall", "pyruns"]
    return subprocess.list2cmdline(command) if os.name == "nt" else shlex.join(command)


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command, stdin=subprocess.DEVNULL, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=5, check=False,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )


def _storage_probe(workspace: str) -> str:
    from pyruns.utils.info_io import load_script_info, validate_workspace_directory
    from pyruns.utils.native_lock import NativeFileGuard

    validate_workspace_directory(workspace)
    if not load_script_info(workspace):
        raise ValueError("Workspace metadata is missing or unreadable")
    # Probe only disposable files; existing task state is never rewritten.
    with tempfile.TemporaryDirectory(prefix=".pyruns-doctor-", dir=workspace) as directory:
        original = os.path.join(directory, "before")
        replaced = os.path.join(directory, "after")
        with open(original, "xb") as handle:
            handle.write(b"pyruns doctor\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(original, replaced)
        with open(replaced, "rb") as handle:
            if handle.read() != b"pyruns doctor\n":
                raise OSError("Workspace read-back differs from the written data")
        path = os.path.join(directory, "guard")
        with NativeFileGuard(path, directory, label="Doctor lock", timeout_sec=0.2):
            with_guard = NativeFileGuard(path, directory, label="Doctor lock", timeout_sec=0.2)
            try:
                if with_guard.try_acquire():
                    raise OSError("Filesystem lock did not exclude a second writer")
            finally:
                with_guard.close()
        with NativeFileGuard(path, directory, label="Doctor lock", timeout_sec=0.2):
            pass
    return f"{workspace}: read/write, atomic replace, and native file locking passed"


def diagnose(context: Any) -> dict[str, Any]:
    """Collect independent checks and retain useful results after any failure."""
    from pyruns import __version__

    checks: list[dict[str, str]] = []

    def add(name: str, status: str, detail: str, remedy: str = "") -> None:
        check = {"name": name, "status": status, "detail": detail}
        if remedy:
            check["remedy"] = remedy
        checks.append(check)

    add("python", "ok" if sys.version_info >= (3, 10) else "error",
        f"Python {platform.python_version()} · {sys.executable}",
        "Use Python 3.10 or newer." if sys.version_info < (3, 10) else "")
    imports = {**_IMPORTS, **({"pywinpty": "winpty"} if os.name == "nt" else {})}
    try:
        from packaging.requirements import Requirement

        requirements = [Requirement(value) for value in metadata.requires("pyruns") or []]
        active = {
            requirement.name.lower().replace("_", "-"): requirement
            for requirement in requirements
            if requirement.marker is None or requirement.marker.evaluate({"extra": ""})
        }
    except Exception:
        active = {}
    dependencies_ok = True
    for package, module_name in imports.items():
        try:
            installed = metadata.version(package)
            requirement = active.get(package)
            if requirement is not None and not requirement.specifier.contains(installed, prereleases=True):
                raise RuntimeError(f"installed {installed}, required {requirement.specifier}")
            module = importlib.import_module(module_name)
            add(package, "ok", f"{installed} · {getattr(module, '__file__', module_name)}")
        except Exception as exc:
            dependencies_ok = False
            add(package, "error", f"{type(exc).__name__}: {exc}", _repair_command())
    runtime_ok = dependencies_ok
    if dependencies_ok:
        try:
            importlib.import_module("pyruns.utils.config_utils")
            importlib.import_module("pyruns.cli.commands")
            importlib.import_module("pyruns.web.app")
            add("runtime", "ok", "CLI, configuration, and Web UI imports passed")
        except Exception as exc:
            runtime_ok = False
            add("runtime", "error", f"{type(exc).__name__}: {exc}", _repair_command())
    else:
        add("runtime", "skipped", "Repair dependency errors before checking runtime imports.")

    workspace = None
    if runtime_ok:
        from pyruns.cli.commands import _find_project_root, resolve_workspace

        if context.workspace or _find_project_root():
            try:
                workspace = resolve_workspace(context)
            except Exception as exc:
                add("workspace", "error" if context.workspace else "warning", str(exc),
                    "Select an existing workspace with 'pyr -w WORKSPACE doctor'.")
        else:
            add("workspace", "skipped", "No existing workspace; installation checks do not require one.")
        if workspace:
            try:
                add("workspace", "ok", _storage_probe(workspace))
            except Exception as exc:
                add("workspace", "error", f"{type(exc).__name__}: {exc}",
                    "Check workspace permissions and filesystem file-lock support, or use a local workspace.")
        try:
            from pyruns.utils.shell_runtime import get_shell_runtime_for_workspace

            shell = get_shell_runtime_for_workspace(workspace)
            add("shell", "ok" if shell["available"] else "error", str(shell["executable"]),
                "Install the selected shell or set shell_executable and shell_mode to an available shell."
                if not shell["available"] else "")
        except Exception as exc:
            add("shell", "error", f"{type(exc).__name__}: {exc}", "Check shell settings with 'pyr config list'.")
        try:
            from pyruns.utils.log_search import ripgrep_path

            installed = metadata.version("ripgrep-bin")
            requirement = active.get("ripgrep-bin")
            if requirement is not None and not requirement.specifier.contains(installed, prereleases=True):
                raise RuntimeError(f"ripgrep-bin installed {installed}, required {requirement.specifier}")
            binary = ripgrep_path()
            result = _run([binary, "--version"])
            if result.returncode:
                raise RuntimeError(result.stderr.strip() or f"exit {result.returncode}")
            add("ripgrep", "ok", f"{result.stdout.splitlines()[0]} · {binary}")
        except Exception as exc:
            add("ripgrep", "error", f"{type(exc).__name__}: {exc}", _repair_command())
    else:
        for name in ("workspace", "shell", "ripgrep"):
            add(name, "skipped", "Repair runtime errors before checking this component.")

    gpu = shutil.which("nvidia-smi")
    if gpu:
        try:
            result = _run([gpu, "--query-gpu=name,memory.total", "--format=csv,noheader"])
            if result.returncode:
                raise RuntimeError(result.stderr.strip() or f"exit {result.returncode}")
            add("gpu", "ok" if result.stdout.strip() else "skipped", result.stdout.strip() or "No NVIDIA GPU detected.")
        except Exception as exc:
            add("gpu", "warning", f"{type(exc).__name__}: {exc}",
                "GPU checks are optional; check the NVIDIA driver if GPU waiting is needed.")
    else:
        add("gpu", "skipped", "nvidia-smi is unavailable; CPU tasks remain supported.")
    errors = sum(check["status"] == "error" for check in checks)
    warnings = sum(check["status"] == "warning" for check in checks)
    return {"schema_version": 1, "version": __version__, "ok": errors == 0,
            "errors": errors, "warnings": warnings, "checks": checks}


def cmd_doctor(context: Any) -> int:
    result = diagnose(context)
    if context.json_output:
        print(json.dumps(result, ensure_ascii=True, allow_nan=False, indent=2))
    else:
        for check in result["checks"]:
            print(f"{check['status'].upper():7} {check['name']}: {check['detail']}")
            if check.get("remedy"):
                print(f"        Fix: {check['remedy']}")
        print(f"{result['errors']} error(s), {result['warnings']} warning(s)")
    return 0 if result["ok"] else 1
