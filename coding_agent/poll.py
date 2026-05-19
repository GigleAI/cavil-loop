from __future__ import annotations

import json
import time
from pathlib import Path

from coding_agent import cleanup, dispatch
from coding_agent.config import Config
from coding_agent.log_util import log
from coding_agent.platform import PlatformBase
from coding_agent.state import State, acquire_lock, release_lock
from coding_agent.worker import WorkerStatus, get_worker


def _count_active_workers(config: Config, state: State) -> int:
    worker = get_worker(config.WORKER)
    count = 0
    for session_data in state.sessions.values():
        status = worker.get_status(session_data["session_id"])
        if status == WorkerStatus.WORKING:
            count += 1
    return count


def _has_existing_work(config: Config, state: State, issue_num: int) -> bool:
    if state.get_session(str(issue_num)) is not None:
        return True
    return Path(config.worktree_path(issue_num)).exists()


def poll(config: Config, state: State) -> None:
    if not acquire_lock(state._state_dir):
        log("上一轮还没跑完，跳过")
        return

    try:
        log("===== poll start =====")

        platform = config.get_platform()

        active_workers = _count_active_workers(config, state)
        max_concurrent = int(config.MAX_CONCURRENT_WORKERS)
        log(f"active workers (busy): {active_workers} (max={max_concurrent})")

        issues = platform.list_issues(config.REPO, config.LABEL_PENDING_AGENT)
        for issue in issues:
            num = issue["number"]

            if _has_existing_work(config, state, num):
                latest_id = platform.get_latest_comment_id(
                    config.REPO, str(num), "issues_comments"
                )
                last_seen = state.get_seen_issue_comments(str(num))
                log(
                    f"issue #{num} 已有 worktree/session：latest_id={latest_id} last_seen={last_seen}"
                )
                if latest_id > last_seen:
                    log(f"dispatch issue-comment for #{num}")
                    if dispatch.dispatch_issue_comment(config, state, num, latest_id):
                        state.update_seen_issue_comments(str(num), latest_id)
                    else:
                        log(f"issue-comment 派工 #{num} 失败（state 不更新，下轮重试）")
                else:
                    log(
                        f"issue #{num}: pending/agent 但 issue 无新 comment，跳过（用户需 comment 才能让 agent 再动）"
                    )
                continue

            if active_workers >= max_concurrent:
                log(f"已达并发上限，issue #{num} 排队等下一轮")
                break

            log(f"dispatch new issue #{num}: {issue['title']}")
            if dispatch.dispatch_new_issue(config, state, num):
                active_workers += 1
            else:
                log(f"派工 issue #{num} 失败")

        prs = platform.list_prs(config.REPO, config.LABEL_PENDING_AGENT)
        for pr in prs:
            pr_num = pr["number"]
            branch = pr["headRefName"]

            latest_conv = platform.get_latest_comment_id(config.REPO, str(pr_num), "issues")
            latest_inline = platform.get_latest_comment_id(
                config.REPO, str(pr_num), "pulls_comments"
            )
            latest_review = platform.get_latest_comment_id(
                config.REPO, str(pr_num), "pulls_reviews"
            )

            seen_conv = state.get_seen_comments(str(pr_num))
            seen_inline = state.get_seen_review_comments(str(pr_num))
            seen_review = state.get_seen_reviews(str(pr_num))

            log(
                f"PR #{pr_num}: conv={latest_conv}/{seen_conv} "
                f"inline={latest_inline}/{seen_inline} "
                f"review={latest_review}/{seen_review}"
            )

            if (
                latest_conv > seen_conv
                or latest_inline > seen_inline
                or latest_review > seen_review
            ):
                log(f"dispatch PR #{pr_num} comment")
                kick_id = max(latest_conv, latest_inline, latest_review)
                if dispatch.dispatch_pr_comment(config, state, pr_num, branch, kick_id):
                    state.update_seen_comments(str(pr_num), latest_conv)
                    state.update_seen_review_comments(str(pr_num), latest_inline)
                    state.update_seen_reviews(str(pr_num), latest_review)
                else:
                    log(f"PR #{pr_num} 派工失败（state 不更新，下轮重试）")

        if config.AUTO_CLEANUP_ON_MERGE != "false":
            needs_bootstrap = False
            if state._state_path.exists():
                raw = json.loads(state._state_path.read_text(encoding="utf-8"))
                needs_bootstrap = "cleaned_prs" not in raw
            else:
                needs_bootstrap = True

            if needs_bootstrap:
                all_merged = platform.list_merged_prs(config.REPO, limit=200)
                pr_nums = [p["number"] for p in all_merged]
                state.bootstrap_cleaned_prs(pr_nums)
                log(f"auto-cleanup bootstrap: 标记 {len(pr_nums)} 个历史 merged PR 为已清")

            recent_merged = platform.list_merged_prs(config.REPO, limit=30)
            for merged_pr in recent_merged:
                pr_num = merged_pr["number"]
                branch = merged_pr["headRefName"]

                if state.is_pr_cleaned(pr_num):
                    continue

                issue_num = PlatformBase.branch_to_issue_num(branch, config.BRANCH_PREFIX)
                if issue_num is None:
                    log(
                        f"auto-cleanup: PR #{pr_num} branch '{branch}' 不符合 BRANCH_PREFIX，标记为已清不再扫"
                    )
                    state.mark_pr_cleaned(pr_num)
                    continue

                log(f"auto-cleanup PR #{pr_num} (issue #{issue_num}) → cleanup")

                if cleanup.cleanup_issue(config, state, issue_num):
                    state.mark_pr_cleaned(pr_num)
                    log(f"  auto-cleanup PR #{pr_num} done")

                    platform.edit_labels(
                        str(pr_num),
                        "pr",
                        config.REPO,
                        [config.LABEL_DONE],
                        [
                            config.LABEL_PENDING_HUMAN,
                            config.LABEL_PENDING_AGENT,
                            config.LABEL_AGENT_DOING,
                        ],
                    )

                    issue_state = platform.get_issue_state(issue_num, config.REPO)
                    if issue_state == "CLOSED":
                        platform.edit_labels(
                            str(issue_num),
                            "issue",
                            config.REPO,
                            [config.LABEL_DONE],
                            [
                                config.LABEL_PENDING_PR,
                                config.LABEL_PENDING_HUMAN,
                                config.LABEL_PENDING_AGENT,
                                config.LABEL_AGENT_DOING,
                            ],
                        )
                        log(f"  PR #{pr_num} → Done；issue #{issue_num} CLOSED (Closes #N) → Done")
                    else:
                        platform.edit_labels(
                            str(issue_num),
                            "issue",
                            config.REPO,
                            [config.LABEL_PENDING_HUMAN],
                            [
                                config.LABEL_PENDING_PR,
                                config.LABEL_PENDING_AGENT,
                                config.LABEL_AGENT_DOING,
                            ],
                        )
                        log(
                            f"  PR #{pr_num} → Done；issue #{issue_num} OPEN (Refs #N) → pending/human"
                        )
                else:
                    log(f"  auto-cleanup PR #{pr_num} 失败（busy/dirty/hook 报错），下轮重试")

        log("===== poll done =====")
    finally:
        release_lock(state._state_dir)


def daemon(config: Config, state: State) -> None:
    try:
        while True:
            poll(config, state)
            time.sleep(int(config.POLL_INTERVAL_SECS))
    except KeyboardInterrupt:
        log("daemon stopped")
