from __future__ import annotations

import re
import subprocess

from coding_agent.log_util import log
from coding_agent.platform import PlatformBase


def run_gh(desc: str, *args: str, repo: str = "") -> subprocess.CompletedProcess:
    cmd = ["gh"]
    if repo:
        cmd += ["--repo", repo]
    cmd += list(args)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        log(f"\u26a0\ufe0f {desc}\u5931\u8d25: {result.stderr.strip()}")
    return result


def list_issues(repo: str, label: str) -> list[dict]:
    from coding_agent.platform import get_platform
    return get_platform("github").list_issues(repo, label)


def list_prs(repo: str, label: str) -> list[dict]:
    from coding_agent.platform import get_platform
    return get_platform("github").list_prs(repo, label)


def list_merged_prs(repo: str, limit: int = 30) -> list[dict]:
    from coding_agent.platform import get_platform
    return get_platform("github").list_merged_prs(repo, limit)


def edit_labels(
    target: str,
    target_type: str,
    repo: str,
    add_labels: list[str],
    remove_labels: list[str],
) -> bool:
    from coding_agent.platform import get_platform
    return get_platform("github").edit_labels(target, target_type, repo, add_labels, remove_labels)


def create_label(name: str, color: str, description: str, repo: str) -> bool:
    from coding_agent.platform import get_platform
    return get_platform("github").create_label(name, color, description, repo)


def get_issue_title(issue_num: int, repo: str) -> str:
    from coding_agent.platform import get_platform
    return get_platform("github").get_issue_title(issue_num, repo)


def get_issue_state(issue_num: int, repo: str) -> str:
    from coding_agent.platform import get_platform
    return get_platform("github").get_issue_state(issue_num, repo)


def get_latest_comment_id(repo: str, issue_or_pr: str, endpoint: str) -> int:
    from coding_agent.platform import get_platform
    return get_platform("github").get_latest_comment_id(repo, issue_or_pr, endpoint)


def branch_to_issue_num(branch: str, branch_prefix: str) -> int | None:
    return PlatformBase.branch_to_issue_num(branch, branch_prefix)


def comment_on_issue(issue_num: int, repo: str, body: str) -> bool:
    from coding_agent.platform import get_platform
    return get_platform("github").comment_on_issue(issue_num, repo, body)


def comment_on_pr(pr_num: int, repo: str, body: str) -> bool:
    from coding_agent.platform import get_platform
    return get_platform("github").comment_on_pr(pr_num, repo, body)


def get_repo_name(host_path: str) -> str:
    from coding_agent.platform import get_platform
    return get_platform("github").get_repo_name(host_path)


def auth_status() -> bool:
    from coding_agent.platform import get_platform
    return get_platform("github").auth_status()