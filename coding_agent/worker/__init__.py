from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass


class WorkerStatus(Enum):
    WORKING = "working"
    IDLE = "idle"
    NEEDS_INPUT = "needs_input"
    COMPLETED = "completed"
    FAILED = "failed"
    STOPPED = "stopped"
    NOT_FOUND = "not_found"


@dataclass
class SessionInfo:
    id: str
    name: str
    status: WorkerStatus
    worktree: str
    worker: str = ""
    issue_num: int = 0


class WorkerBase(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        ...

    @abstractmethod
    def start(
        self,
        session_name: str,
        worktree: str,
        prompt: str,
        env: dict[str, str] | None = None,
        extra_flags: list[str] | None = None,
    ) -> SessionInfo:
        ...

    @abstractmethod
    def resume(
        self,
        session_id: str,
        worktree: str,
        prompt: str,
        extra_flags: list[str] | None = None,
    ) -> SessionInfo:
        ...

    @abstractmethod
    def get_status(self, session_id: str) -> WorkerStatus:
        ...

    @abstractmethod
    def list_sessions(self) -> list[SessionInfo]:
        ...

    @abstractmethod
    def stop(self, session_id: str) -> None:
        ...

    @abstractmethod
    def get_logs(self, session_id: str) -> str:
        ...

    @abstractmethod
    def has_history(self, worktree: str) -> bool:
        ...

    @abstractmethod
    def attach(self, session_id: str) -> None:
        ...

    def cleanup(self, session_id: str) -> None:
        pass


_WORKER_REGISTRY: dict[str, type[WorkerBase]] = {}


def register_worker(cls: type[WorkerBase]) -> type[WorkerBase]:
    key = cls.name if isinstance(cls.name, str) else cls().name
    _WORKER_REGISTRY[key] = cls
    return cls


def get_worker(name: str, **kwargs) -> WorkerBase:
    _lazy_import_workers()
    cls = _WORKER_REGISTRY.get(name)
    if cls is None:
        raise ValueError(
            f"Unknown worker: {name}. Available: {list(_WORKER_REGISTRY.keys())}"
        )
    return cls(**kwargs)


def available_workers() -> list[str]:
    _lazy_import_workers()
    return list(_WORKER_REGISTRY.keys())


def _lazy_import_workers() -> None:
    if _WORKER_REGISTRY:
        return
    from coding_agent.worker import claude as _claude  # noqa: F401
    from coding_agent.worker import opencode as _opencode  # noqa: F401
