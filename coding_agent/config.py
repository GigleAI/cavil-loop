from __future__ import annotations

import os
import re
from pathlib import Path


_REQUIRED_FIELDS = (
    "REPO",
    "PROJECT_ROOT",
    "WORKTREE_BASE",
    "STATE_DIR",
    "TMUX_PREFIX",
    "BRANCH_PREFIX",
    "SESSION_NAME_PREFIX",
    "LABEL_PENDING_AGENT",
    "LABEL_PENDING_HUMAN",
)

_DEFAULTS: dict[str, str] = {
    "LABEL_AGENT_DOING": "agent/doing",
    "LABEL_PENDING_PR": "pending/PR",
    "LABEL_DONE": "Done",
    "WORKER": "claude",
    "MAX_CONCURRENT_WORKERS": "1",
    "POLL_INTERVAL_SECS": "60",
    "AUTO_CLEANUP_ON_MERGE": "true",
    "WORKTREE_SETUP_CMD": ":",
    "COPY_TO_WORKTREE": ".env",
    "WORKTREE_GIT_USER_NAME": "",
    "WORKTREE_GIT_USER_EMAIL": "",
    "CLAUDE_EXTRA_FLAGS": "--dangerously-skip-permissions",
    "OPENCODE_EXTRA_FLAGS": "",
    "OPENCODE_SERVER_URL": "http://127.0.0.1:4096",
    "WORKER_PASS_ENV": "GH_TOKEN",
    "CLEANUP_HOOK": "",
    "PLATFORM": "",
}


def _find_config() -> Path:
    env_path = os.environ.get("CODING_AGENT_CONFIG")
    if env_path:
        p = Path(env_path)
        if p.is_file():
            return p
    d = Path.cwd()
    while d != d.parent:
        candidate = d / "coding-agent.config"
        if candidate.is_file():
            return candidate
        d = d.parent
    raise FileNotFoundError(
        "coding-agent.config not found. "
        "Set CODING_AGENT_CONFIG or place coding-agent.config in a parent directory."
    )


def _parse_config(text: str) -> dict[str, str]:
    home = Path.home()
    result: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if not m:
            continue
        key, value = m.group(1), m.group(2)
        value = value.strip()
        if len(value) >= 2 and (
            (value.startswith('"') and value.endswith('"'))
            or (value.startswith("'") and value.endswith("'"))
        ):
            value = value[1:-1]
        value = value.replace("~", str(home))
        value = value.replace("$HOME", str(home))
        while True:
            new_value = re.sub(
                r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}",
                lambda m: result.get(m.group(1), m.group(0)),
                value,
            )
            new_value = re.sub(
                r"\$([A-Za-z_][A-Za-z0-9_]*)",
                lambda m: result.get(m.group(1), m.group(0)),
                new_value,
            )
            if new_value == value:
                break
            value = new_value
        result[key] = value
    return result


class Config:
    def __init__(self, config_path: Path | None = None) -> None:
        if config_path is None:
            config_path = _find_config()
        self._config_path = config_path
        text = config_path.read_text(encoding="utf-8")
        parsed = _parse_config(text)
        for key in _REQUIRED_FIELDS:
            if key not in parsed:
                raise ValueError(f"Required config field missing: {key}")
        for key, default in _DEFAULTS.items():
            parsed.setdefault(key, default)
        if "SESSION_LOG_DIR" not in parsed:
            parsed["SESSION_LOG_DIR"] = parsed["STATE_DIR"] + "/sessions"
        skill_dir = os.environ.get("CLAUDE_PLUGIN_ROOT")
        if skill_dir:
            parsed["SKILL_DIR"] = skill_dir
        else:
            parsed["SKILL_DIR"] = str(config_path.parent.parent.resolve())
        for key, value in parsed.items():
            setattr(self, key, value)
        Path(self.STATE_DIR).mkdir(parents=True, exist_ok=True)
        if not self.PLATFORM:
            from coding_agent.platform import detect_platform
            detected = detect_platform(self.PROJECT_ROOT)
            if detected:
                self.PLATFORM = detected
            else:
                raise ValueError(
                    "Cannot auto-detect platform from git remote URL. "
                    "Set PLATFORM=github or PLATFORM=gitlab in coding-agent.config."
                )

    def worktree_path(self, issue_num: int) -> str:
        return f"{self.WORKTREE_BASE}/{self.SESSION_NAME_PREFIX}-{issue_num}"

    def branch_name(self, issue_num: int) -> str:
        return f"{self.BRANCH_PREFIX}{issue_num}"

    def tmux_session_name(self, issue_num: int) -> str:
        return f"{self.TMUX_PREFIX}-{self.SESSION_NAME_PREFIX}{issue_num}"

    def claude_session_name(self, issue_num: int) -> str:
        return f"{self.SESSION_NAME_PREFIX}{issue_num}"

    def session_log_path(self, session_name: str) -> str:
        if not self.SESSION_LOG_DIR:
            return ""
        return f"{self.SESSION_LOG_DIR}/{session_name}.log"

    _platform_instance = None

    def get_platform(self):
        if self._platform_instance is None:
            from coding_agent.platform import get_platform
            self._platform_instance = get_platform(self.PLATFORM)
        return self._platform_instance
