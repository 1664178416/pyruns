import asyncio
import io
import os
from pathlib import Path
import runpy
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocket
from starlette.requests import ClientDisconnect

from pyruns.web.app import _TaskLogDownloadResponse
from pyruns.web.runtime import LogFileChangedError, OpenedTaskLog


_helpers = runpy.run_path(str(Path(__file__).with_name("test_web.py")))


@pytest.fixture
def log_workspace(tmp_path):
    root = _helpers["_make_workspace"](tmp_path, "main")
    _helpers["_add_task"](root, "alpha", status="completed", log_text="first\n")
    runtime = _helpers["_build_runtime"](root, owns_task_lifecycle=False)
    yield root, runtime, TestClient(_helpers["create_app"](runtime))
    runtime.shutdown()


def test_download_preserves_raw_bytes_size_identity_and_name(log_workspace):
    root, runtime, client = log_workspace
    path = root / "tasks" / "alpha" / "run_logs" / "run1.log"
    content = b"\x1b[32mraw\r\n\x1b[0m" + "中文🚀".encode() * 50000
    path.write_bytes(content)
    identity = runtime.get_task_logs("alpha")["log_identity"]
    response = client.get("/api/tasks/alpha/logs/download", params={
        "log_file_name": "run1.log", "log_identity": identity, "expected_workspace": str(root),
    }, headers={"Range": "bytes=0-9"})
    assert response.status_code == 200
    assert response.content == content
    assert int(response.headers["content-length"]) == len(content)
    assert response.headers["accept-ranges"] == "none"
    assert response.headers["x-pyruns-log-identity"] == identity
    assert "alpha--run1.log" in response.headers["content-disposition"]
    assert response.headers["cache-control"] == "no-store"


def test_download_rejects_stale_workspace_identity_paths_and_links(log_workspace, tmp_path):
    root, _, client = log_workspace
    endpoint = "/api/tasks/alpha/logs/download"
    assert client.get(endpoint, params={"log_file_name": "run1.log", "log_identity": "stale"}).status_code == 409
    assert client.get(endpoint, params={"log_file_name": "../run1.log"}).status_code == 400
    assert client.get(endpoint, params={"log_file_name": "run99.log"}).status_code == 404
    assert client.get(endpoint, params={"log_file_name": "run1.log", "expected_workspace": str(tmp_path)}).status_code == 409
    assert client.get(endpoint, params={"log_file_name": "run1.log"}, headers={
        "X-Pyruns-Workspace": quote(str(tmp_path), safe=""),
    }).status_code == 409
    link = root / "tasks" / "alpha" / "run_logs" / "run2.log"
    try:
        link.symlink_to(root / "tasks" / "alpha" / "run_logs" / "run1.log")
    except OSError:
        pytest.skip("symlinks unavailable")
    assert client.get(endpoint, params={"log_file_name": "run2.log"}).status_code == 400


def test_download_rechecks_identity_after_open_and_closes_on_failure(log_workspace, monkeypatch):
    _, runtime, _ = log_workspace
    import builtins
    original_open = builtins.open
    handles = []

    def opened(*args, **kwargs):
        handle = original_open(*args, **kwargs)
        if str(args[0]).endswith("run1.log"):
            handles.append(handle)
        return handle

    monkeypatch.setattr(builtins, "open", opened)
    monkeypatch.setattr(os.path, "samestat", lambda left, right: False)
    with pytest.raises(LogFileChangedError):
        runtime.open_task_log_download("alpha", "run1.log")
    assert handles and all(handle.closed for handle in handles)


@pytest.mark.parametrize("disconnect_before_read", [False, True])
def test_download_closes_handle_on_disconnect_and_reads_bounded_snapshot(disconnect_before_read):
    class TrackedBytes(io.BytesIO):
        def read(self, count=-1):
            assert 0 < count <= 64 * 1024
            return super().read(count)

    handle = TrackedBytes(b"a" * 200_000)
    response = _TaskLogDownloadResponse(OpenedTaskLog(handle, "alpha--run1.log", 130_000, "id"))

    async def exercise():
        frames = []

        async def receive():
            return {"type": "http.disconnect"}

        async def send(message):
            frames.append(message)
            if disconnect_before_read or message["type"] == "http.response.body":
                raise OSError("client disconnected")

        with pytest.raises((OSError, ClientDisconnect)):
            await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
        assert handle.closed
        assert len(b"".join(frame.get("body", b"") for frame in frames)) <= 64 * 1024

    asyncio.run(exercise())


def test_log_tail_zero_returns_current_cursor(log_workspace):
    root, _, client = log_workspace
    response = client.get("/api/tasks/alpha/logs", params={"tail_lines": 0})
    assert response.status_code == 200
    assert response.json()["content"] == ""
    assert response.json()["offset"] == (root / "tasks" / "alpha" / "run_logs" / "run1.log").stat().st_size


def test_download_reports_truncation_and_closes_handle():
    handle = io.BytesIO(b"short")
    response = _TaskLogDownloadResponse(OpenedTaskLog(handle, "run1.log", 100, "id"))

    async def exercise():
        async def receive():
            await asyncio.Event().wait()

        async def send(message):
            pass

        with pytest.raises(EOFError, match="Log truncated while downloading"):
            await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
        assert handle.closed

    asyncio.run(exercise())


@pytest.mark.parametrize("fails", [False, True])
def test_log_stream_reports_health_only_after_reads_and_errors_after_repeated_failure(log_workspace, monkeypatch, fails):
    from pyruns.web import app as app_mod
    _, runtime, _ = log_workspace
    app = _helpers["create_app"](runtime)
    endpoint = next(route.endpoint for route in app.routes if route.path == "/api/tasks/{task_name}/logs/stream")
    calls = 0
    original = runtime.get_task_logs

    def read(*args, **kwargs):
        nonlocal calls
        calls += 1
        if fails:
            raise OSError("simulated NFS unavailable")
        return original(*args, **kwargs)

    runtime.get_task_logs = read
    monkeypatch.setattr(app_mod, "LOG_STREAM_TAIL_INTERVAL_SEC", 0.001)
    monkeypatch.setattr(app_mod, "LOG_STREAM_HEARTBEAT_SEC", 0)

    async def exercise():
        import json
        messages = []
        disconnected = asyncio.Event()
        connected = False

        async def receive():
            nonlocal connected
            if not connected:
                connected = True
                return {"type": "websocket.connect"}
            await disconnected.wait()
            return {"type": "websocket.disconnect", "code": 1000}

        async def send(message):
            if message["type"] == "websocket.send":
                payload = json.loads(message["text"])
                messages.append(payload)
                assert calls > 0
                if not fails and payload["type"] == "heartbeat":
                    disconnected.set()

        scope = {"type": "websocket", "path": "/api/tasks/alpha/logs/stream", "headers": [(b"host", b"testserver")],
                 "client": ("testclient", 1), "server": ("testserver", 80), "scheme": "ws"}
        await asyncio.wait_for(endpoint(WebSocket(scope, receive, send), "alpha", log_file_name="run1.log",
                                        offset=0, log_identity=None, expected_workspace=None), 3)
        kinds = [message["type"] for message in messages]
        if fails:
            assert kinds == ["error"]
            assert calls == app_mod.LOG_STREAM_MAX_READ_FAILURES
        else:
            assert kinds[0] == "ready"
            assert "heartbeat" in kinds

    asyncio.run(exercise())
