from __future__ import annotations

import pytest

from coding_agent.worker import (
    _WORKER_REGISTRY,
    SessionInfo,
    WorkerBase,
    WorkerStatus,
    available_workers,
    get_worker,
    register_worker,
)


@pytest.fixture(autouse=True)
def reset_worker_registry():
    from coding_agent.worker import _lazy_import_workers

    _lazy_import_workers()
    yield


def test_available_workers():
    workers = available_workers()
    assert "claude" in workers
    assert "opencode" in workers


def test_get_worker_claude():
    worker = get_worker("claude")
    assert worker.name == "claude"


def test_get_worker_opencode_default():
    worker = get_worker("opencode")
    assert worker.base_url == "http://127.0.0.1:4096"


def test_get_worker_opencode_custom_base_url():
    worker = get_worker("opencode", base_url="http://localhost:9999")
    assert worker.base_url == "http://localhost:9999"


def test_get_worker_unknown_raises():
    with pytest.raises(ValueError, match="Unknown worker"):
        get_worker("unknown")


def test_claude_worker_name():
    from coding_agent.worker.claude import ClaudeWorker

    w = ClaudeWorker()
    assert w.name == "claude"


def test_opencode_worker_name():
    from coding_agent.worker.opencode import OpencodeWorker

    w = OpencodeWorker()
    assert w.name == "opencode"


def test_worker_status_enum_values():
    assert WorkerStatus.WORKING.value == "working"
    assert WorkerStatus.IDLE.value == "idle"
    assert WorkerStatus.NEEDS_INPUT.value == "needs_input"
    assert WorkerStatus.COMPLETED.value == "completed"
    assert WorkerStatus.FAILED.value == "failed"
    assert WorkerStatus.STOPPED.value == "stopped"
    assert WorkerStatus.NOT_FOUND.value == "not_found"


def test_session_info_creation():
    si = SessionInfo(
        id="abc123",
        name="issue5",
        status=WorkerStatus.WORKING,
        worktree="/tmp/worktree",
        worker="claude",
        issue_num=5,
    )
    assert si.id == "abc123"
    assert si.name == "issue5"
    assert si.status == WorkerStatus.WORKING
    assert si.worktree == "/tmp/worktree"
    assert si.worker == "claude"
    assert si.issue_num == 5


def test_register_worker_custom():
    class MockWorker(WorkerBase):
        @property
        def name(self) -> str:
            return "mock"

        def start(self, session_name, worktree, prompt, env=None, extra_flags=None):
            return SessionInfo("", "", WorkerStatus.FAILED, "")

        def resume(self, session_id, worktree, prompt, extra_flags=None):
            return SessionInfo("", "", WorkerStatus.FAILED, "")

        def get_status(self, session_id):
            return WorkerStatus.NOT_FOUND

        def list_sessions(self):
            return []

        def stop(self, session_id):
            pass

        def get_logs(self, session_id):
            return ""

        def has_history(self, worktree):
            return False

        def attach(self, session_id):
            pass

    register_worker(MockWorker)
    assert "mock" in _WORKER_REGISTRY
    w = get_worker("mock")
    assert w.name == "mock"


def test_worker_base_cannot_instantiate():
    with pytest.raises(TypeError):
        WorkerBase()
