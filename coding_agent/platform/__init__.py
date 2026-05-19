from __future__ import annotations

import re
from abc import ABC, abstractmethod


class PlatformBase(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        ...

    @property
    @abstractmethod
    def cli_cmd(self) -> str:
        ...

    @abstractmethod
    def list_issues(self, repo: str, label: str) -> list[dict]:
        ...

    @abstractmethod
    def list_prs(self, repo: str, label: str) -> list[dict]:
        ...

    @abstractmethod
    def list_merged_prs(self, repo: str, limit: int = 30) -> list[dict]:
        ...

    @abstractmethod
    def edit_labels(
        self,
        target: str,
        target_type: str,
        repo: str,
        add_labels: list[str],
        remove_labels: list[str],
    ) -> bool:
        ...

    @abstractmethod
    def create_label(self, name: str, color: str, description: str, repo: str) -> bool:
        ...

    @abstractmethod
    def get_issue_title(self, issue_num: int, repo: str) -> str:
        ...

    @abstractmethod
    def get_issue_state(self, issue_num: int, repo: str) -> str:
        ...

    @abstractmethod
    def get_latest_comment_id(self, repo: str, issue_or_pr: str, endpoint: str) -> int:
        ...

    @abstractmethod
    def comment_on_issue(self, issue_num: int, repo: str, body: str) -> bool:
        ...

    @abstractmethod
    def comment_on_pr(self, pr_num: int, repo: str, body: str) -> bool:
        ...

    @abstractmethod
    def get_repo_name(self, host_path: str) -> str:
        ...

    @abstractmethod
    def auth_status(self) -> bool:
        ...

    @staticmethod
    def branch_to_issue_num(branch: str, branch_prefix: str) -> int | None:
        m = re.match(re.escape(branch_prefix) + r"(\d+)", branch)
        return int(m.group(1)) if m else None


_PLATFORM_REGISTRY: dict[str, type[PlatformBase]] = {}


def register_platform(cls: type[PlatformBase]) -> type[PlatformBase]:
    key = cls.name if isinstance(cls.name, str) else cls().name
    _PLATFORM_REGISTRY[key] = cls
    return cls


def get_platform(name: str, **kwargs) -> PlatformBase:
    _lazy_import_platforms()
    cls = _PLATFORM_REGISTRY.get(name)
    if cls is None:
        raise ValueError(
            f"Unknown platform: {name}. Available: {list(_PLATFORM_REGISTRY.keys())}"
        )
    return cls(**kwargs)


def available_platforms() -> list[str]:
    _lazy_import_platforms()
    return list(_PLATFORM_REGISTRY.keys())


def detect_platform(project_root: str) -> str | None:
    import subprocess

    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            cwd=project_root,
        )
        if result.returncode != 0:
            return None
        url = result.stdout.strip().lower()
        if "github.com" in url:
            return "github"
        if "gitlab" in url:
            return "gitlab"
        return None
    except Exception:
        return None


def _lazy_import_platforms() -> None:
    if _PLATFORM_REGISTRY:
        return
    from coding_agent.platform import github as _github  # noqa: F401
    from coding_agent.platform import gitlab as _gitlab  # noqa: F401
