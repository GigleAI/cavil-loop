from __future__ import annotations

import os
import subprocess
from pathlib import Path

from coding_agent.config import Config
from coding_agent.git_ops import delete_branch, remove_worktree, show_ref
from coding_agent.log_util import log
from coding_agent.state import State
from coding_agent.worker import WorkerStatus, get_worker


def cleanup_issue(
    config: Config,
    state: State,
    issue_num: int,
    force: bool = False,
    keep_worktree: bool = False,
    delete_branch: bool = False,
) -> bool:
    session = state.get_session(str(issue_num))
    worktree = config.worktree_path(issue_num)
    branch = config.branch_name(issue_num)

    log(f"cleanup-issue #{issue_num}: worktree={worktree} branch={branch}")

    if session:
        worker = get_worker(session.get("worker", config.WORKER))
        status = worker.get_status(session["session_id"])
        if status == WorkerStatus.WORKING:
            if not force:
                log(f"session still busy, use --force")
                return False
            log(f"session busy but --force, continuing")

    if config.CLEANUP_HOOK:
        hook = config.CLEANUP_HOOK
        if not hook.startswith("/"):
            hook = os.path.join(config.PROJECT_ROOT, hook)
        if Path(hook).is_file():
            log(f"running cleanup hook: {hook}")
            env = {
                "ISSUE": str(issue_num),
                "WORKTREE": worktree,
                "BRANCH": branch,
                "REPO": config.REPO,
                "PROJECT_ROOT": config.PROJECT_ROOT,
            }
            merged_env = {**os.environ, **env}
            result = subprocess.run(
                ["bash", hook],
                capture_output=True,
                text=True,
                env=merged_env,
            )
            if result.stdout:
                for line in result.stdout.splitlines():
                    log(f"  [hook] {line}")
            if result.returncode != 0:
                if result.stderr:
                    for line in result.stderr.splitlines():
                        log(f"  [hook] {line}")
                log(f"hook non-zero exit (continuing cleanup)")
        else:
            log(f"CLEANUP_HOOK={config.CLEANUP_HOOK} file not found, skipping")

    if session:
        worker = get_worker(session.get("worker", config.WORKER))
        worker.stop(session["session_id"])

    if not keep_worktree and Path(worktree).exists():
        ok = remove_worktree(config.PROJECT_ROOT, worktree, force=force)
        if not ok and not force:
            return False

    if delete_branch or config.REMOVE_BRANCH == "1":
        if show_ref(config.PROJECT_ROOT, f"refs/heads/{branch}"):
            delete_branch(config.PROJECT_ROOT, branch)

    state.remove_session(str(issue_num))

    log(f"cleanup-issue #{issue_num} done")
    return True