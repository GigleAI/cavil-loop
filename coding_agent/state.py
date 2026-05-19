from __future__ import annotations

import json
import os
import platform
import sys
import tempfile
from pathlib import Path

if platform.system() != "Windows":
    import fcntl
else:
    import msvcrt


_SCHEMA_DEFAULTS: dict[str, object] = {
    "seen_comments": {},
    "seen_issue_comments": {},
    "seen_review_comments": {},
    "seen_reviews": {},
    "cleaned_prs": [],
    "sessions": {},
}

_DICT_FIELDS = (
    "seen_comments",
    "seen_issue_comments",
    "seen_review_comments",
    "seen_reviews",
    "sessions",
)

_LIST_FIELDS = ("cleaned_prs",)


class State:
    seen_comments: dict[str, int]
    seen_issue_comments: dict[str, int]
    seen_review_comments: dict[str, int]
    seen_reviews: dict[str, int]
    cleaned_prs: list[int]
    sessions: dict[str, dict[str, str]]

    _state_dir: str
    _state_path: Path

    def __init__(self, state_dir: str) -> None:
        self._state_dir = state_dir
        self._state_path = Path(state_dir) / "state.json"
        self.seen_comments = {}
        self.seen_issue_comments = {}
        self.seen_review_comments = {}
        self.seen_reviews = {}
        self.cleaned_prs = []
        self.sessions = {}

    @classmethod
    def load(cls, state_dir: str) -> State:
        state = cls(state_dir)
        path = state._state_path

        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
        else:
            raw = {}

        for field in _DICT_FIELDS:
            if field not in raw:
                raw[field] = {}
        for field in _LIST_FIELDS:
            if field not in raw:
                raw[field] = []

        state.seen_comments = raw["seen_comments"]
        state.seen_issue_comments = raw["seen_issue_comments"]
        state.seen_review_comments = raw["seen_review_comments"]
        state.seen_reviews = raw["seen_reviews"]
        state.cleaned_prs = raw["cleaned_prs"]
        state.sessions = raw["sessions"]

        return state

    def save(self) -> None:
        data = {
            "seen_comments": self.seen_comments,
            "seen_issue_comments": self.seen_issue_comments,
            "seen_review_comments": self.seen_review_comments,
            "seen_reviews": self.seen_reviews,
            "cleaned_prs": self.cleaned_prs,
            "sessions": self.sessions,
        }
        path = self._state_path
        dir_path = path.parent
        dir_path.mkdir(parents=True, exist_ok=True)

        tmp_fd, tmp_name = tempfile.mkstemp(
            dir=str(dir_path), suffix=".tmp", prefix="state_"
        )
        try:
            with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_name, str(path))
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    def get_seen_comments(self, pr_num: str) -> int:
        return self.seen_comments.get(pr_num, 0)

    def get_seen_review_comments(self, pr_num: str) -> int:
        return self.seen_review_comments.get(pr_num, 0)

    def get_seen_reviews(self, pr_num: str) -> int:
        return self.seen_reviews.get(pr_num, 0)

    def get_seen_issue_comments(self, issue_num: str) -> int:
        return self.seen_issue_comments.get(issue_num, 0)

    def update_seen_comments(self, pr_num: str, id: int) -> None:
        self.seen_comments[pr_num] = id
        self.save()

    def update_seen_review_comments(self, pr_num: str, id: int) -> None:
        self.seen_review_comments[pr_num] = id
        self.save()

    def update_seen_reviews(self, pr_num: str, id: int) -> None:
        self.seen_reviews[pr_num] = id
        self.save()

    def update_seen_issue_comments(self, issue_num: str, id: int) -> None:
        self.seen_issue_comments[issue_num] = id
        self.save()

    def is_pr_cleaned(self, pr_num: int) -> bool:
        return pr_num in self.cleaned_prs

    def mark_pr_cleaned(self, pr_num: int) -> None:
        if pr_num not in self.cleaned_prs:
            self.cleaned_prs.append(pr_num)
            self.save()

    def bootstrap_cleaned_prs(self, pr_nums: list[int]) -> None:
        self.cleaned_prs = list(pr_nums)
        self.save()

    def get_session(self, issue_num: str) -> dict[str, str] | None:
        return self.sessions.get(issue_num)

    def set_session(self, issue_num: str, session_id: str, worker: str) -> None:
        self.sessions[issue_num] = {"session_id": session_id, "worker": worker}
        self.save()

    def remove_session(self, issue_num: str) -> None:
        if issue_num in self.sessions:
            del self.sessions[issue_num]
            self.save()


_LOCK_FD: int | None = None


def _lock_path(state_dir: str) -> Path:
    return Path(state_dir) / "poll.lock"


def acquire_lock(state_dir: str) -> bool:
    global _LOCK_FD
    lock_file = _lock_path(state_dir)
    lock_file.parent.mkdir(parents=True, exist_ok=True)

    fd = os.open(str(lock_file), os.O_CREAT | os.O_RDWR)

    try:
        if platform.system() == "Windows":
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, IOError):
        os.close(fd)
        return False

    _LOCK_FD = fd
    return True


def release_lock(state_dir: str) -> None:
    global _LOCK_FD
    if _LOCK_FD is None:
        return

    try:
        if platform.system() == "Windows":
            msvcrt.locking(_LOCK_FD, msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(_LOCK_FD, fcntl.LOCK_UN)
    except (OSError, IOError):
        pass

    os.close(_LOCK_FD)
    _LOCK_FD = None