from __future__ import annotations

import subprocess

from coding_agent.config import Config
from coding_agent.log_util import log
from coding_agent.state import State


def _list_open_prs(repo: str, cli_cmd: str) -> list[int]:
    result = subprocess.run(
        [
            cli_cmd,
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            "open",
            "--json",
            "number",
            "--jq",
            ".[].number",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []
    nums = []
    for line in result.stdout.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            nums.append(int(line))
        except ValueError:
            continue
    return nums


def _list_open_issues(repo: str, cli_cmd: str) -> list[int]:
    result = subprocess.run(
        [
            cli_cmd,
            "issue",
            "list",
            "--repo",
            repo,
            "--state",
            "open",
            "--json",
            "number",
            "--jq",
            ".[].number",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []
    nums = []
    for line in result.stdout.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            nums.append(int(line))
        except ValueError:
            continue
    return nums


def seed_state(config: Config, state: State) -> None:
    log("seeding open PR latest-ids")
    repo = config.REPO
    platform = config.get_platform()
    cli_cmd = platform.cli_cmd

    for pr in _list_open_prs(repo, cli_cmd):
        c = platform.get_latest_comment_id(repo, str(pr), "issues")
        i = platform.get_latest_comment_id(repo, str(pr), "pulls_comments")
        r = platform.get_latest_comment_id(repo, str(pr), "pulls_reviews")
        state.seen_comments[str(pr)] = c
        state.seen_review_comments[str(pr)] = i
        state.seen_reviews[str(pr)] = r
        log(f"  PR #{pr} -> conv={c} inline={i} review={r}")

    log("seeding Issue latest-comment ids")
    for is_num in _list_open_issues(repo, cli_cmd):
        latest = platform.get_latest_comment_id(repo, str(is_num), "issues_comments")
        state.seen_issue_comments[str(is_num)] = latest
        log(f"  Issue #{is_num} -> last comment id {latest}")

    state.save()
