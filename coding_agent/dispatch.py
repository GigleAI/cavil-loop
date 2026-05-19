from __future__ import annotations

import os
from pathlib import Path

from coding_agent.config import Config
from coding_agent.git_ops import (
    copy_files_to_worktree,
    create_branch,
    create_worktree,
    fetch_origin,
    run_setup_cmd,
    set_worktree_identity,
)
from coding_agent.log_util import log
from coding_agent.platform import PlatformBase
from coding_agent.prompt import (
    build_prompt_vars,
    find_prompt_template,
    render_template,
    write_prompt_file,
)
from coding_agent.state import State
from coding_agent.worker import WorkerStatus, get_worker


def _build_env(config: Config) -> dict[str, str]:
    env: dict[str, str] = {}
    raw = getattr(config, "WORKER_PASS_ENV", "").strip()
    if not raw:
        return env
    for name in raw.split():
        value = os.environ.get(name)
        if value is not None:
            env[name] = value
    return env


def _get_extra_flags(config: Config) -> list[str]:
    if config.WORKER == "opencode":
        raw = getattr(config, "OPENCODE_EXTRA_FLAGS", "")
    else:
        raw = getattr(config, "CLAUDE_EXTRA_FLAGS", "")
    if not raw.strip():
        return []
    return raw.strip().split()


def _get_worker(config: Config):
    kwargs: dict = {}
    if config.WORKER == "opencode":
        kwargs["base_url"] = config.OPENCODE_SERVER_URL
    return get_worker(config.WORKER, **kwargs)


def _flip_issue_label(config: Config, issue_num: int, add: list[str], remove: list[str]) -> None:
    config.get_platform().edit_labels(str(issue_num), "issue", config.REPO, add, remove)


def _flip_pr_label(config: Config, pr_num: int, add: list[str], remove: list[str]) -> None:
    config.get_platform().edit_labels(str(pr_num), "pr", config.REPO, add, remove)


def dispatch_new_issue(config: Config, state: State, issue_num: int) -> bool:
    try:
        branch = config.branch_name(issue_num)
        worktree = config.worktree_path(issue_num)
        session_name = config.claude_session_name(issue_num)

        if not create_branch(config.PROJECT_ROOT, branch):
            log(f"dispatch-new-issue: create branch failed for #{issue_num}")
            return False

        wt = create_worktree(config.PROJECT_ROOT, worktree, branch, config.WORKTREE_BASE)
        if not wt:
            log(f"dispatch-new-issue: create worktree failed for #{issue_num}")
            return False

        set_worktree_identity(
            worktree,
            getattr(config, "WORKTREE_GIT_USER_NAME", ""),
            getattr(config, "WORKTREE_GIT_USER_EMAIL", ""),
        )
        copy_files_to_worktree(config.PROJECT_ROOT, worktree, config.COPY_TO_WORKTREE)
        run_setup_cmd(worktree, config.WORKTREE_SETUP_CMD)

        platform = config.get_platform()
        issue_title = platform.get_issue_title(issue_num, config.REPO)
        prompt_vars = build_prompt_vars(config, issue_num, TITLE=issue_title)

        template = find_prompt_template("new-issue", config.PROJECT_ROOT, config.SKILL_DIR)
        if template:
            prompt_content = render_template(template, prompt_vars)
        else:
            cli = platform.cli_cmd
            prompt_content = (
                f"你正在处理 GitHub issue #{issue_num}（仓库 {config.REPO}，标题：{issue_title}）。\n"
                f"工作目录 {worktree}  分支 {branch}。\n"
                f'读 issue → 实现 → 测试通过 → commit + push → {cli} pr create --base main (body 含 "Closes #{issue_num}")\n'
                f"拿到 PR 编号 <P> 后：{cli} pr edit <P> --add-label {config.LABEL_PENDING_HUMAN}\n"
                f"+ {cli} issue edit {issue_num} --add-label {config.LABEL_PENDING_HUMAN} --remove-label {config.LABEL_PENDING_AGENT}\n"
                f'最后回一句 "PR #<P> 已开" 停 idle。'
            )

        write_prompt_file(prompt_content, issue_num)

        worker = _get_worker(config)
        env = _build_env(config)
        extra_flags = _get_extra_flags(config)
        info = worker.start(
            session_name, worktree, prompt_content, env=env, extra_flags=extra_flags
        )

        if not info.id:
            log(f"dispatch-new-issue: worker start failed for #{issue_num}")
            return False

        state.set_session(str(issue_num), info.id, config.WORKER)

        _flip_issue_label(
            config,
            issue_num,
            add=[config.LABEL_AGENT_DOING],
            remove=[config.LABEL_PENDING_AGENT],
        )

        log(f"dispatch-new-issue done: #{issue_num} -> session {info.id}")
        return True
    except Exception as exc:
        log(f"dispatch-new-issue error for #{issue_num}: {exc}")
        return False


def dispatch_issue_comment(
    config: Config, state: State, issue_num: int, latest_comment_id: int
) -> bool:
    try:
        worktree = config.worktree_path(issue_num)
        session_name = config.claude_session_name(issue_num)

        prompt_vars = build_prompt_vars(config, issue_num)
        template = find_prompt_template("issue-comment", config.PROJECT_ROOT, config.SKILL_DIR)
        if template:
            prompt_content = render_template(template, prompt_vars)
        else:
            cli = config.get_platform().cli_cmd
            prompt_content = (
                f"Issue #{issue_num} 有新评论。读 `{cli} issue view {issue_num} --repo {config.REPO} --comments` 看最新一段，按内容判断：\n"
                f"- 用户确认方案 → 进入开发阶段（实现 / 测试 / commit + push / 开 PR / Closes #{issue_num}）\n"
                f"- 用户要求改方案 → 修订设计、重发 issue comment、idle\n"
                f"- 不明确 → 反问 + idle\n"
                f"完成后翻 label：{cli} issue edit {issue_num} --add-label {config.LABEL_PENDING_HUMAN} --remove-label {config.LABEL_AGENT_DOING}"
            )

        write_prompt_file(prompt_content, issue_num, suffix=f"cmt-{latest_comment_id}")

        worker = _get_worker(config)
        extra_flags = _get_extra_flags(config)
        session_info = state.get_session(str(issue_num))

        if session_info and session_info.get("session_id"):
            status = worker.get_status(session_info["session_id"])
            if status != WorkerStatus.NOT_FOUND:
                log(f"issue #{issue_num} -> resume existing session {session_info['session_id']}")
                worker.resume(
                    session_info["session_id"], worktree, prompt_content, extra_flags=extra_flags
                )
                _flip_issue_label(
                    config,
                    issue_num,
                    add=[config.LABEL_AGENT_DOING],
                    remove=[config.LABEL_PENDING_AGENT],
                )
                return True

        if Path(worktree).exists():
            log(f"issue #{issue_num} -> worktree exists, starting new session in {worktree}")
            env = _build_env(config)
            info = worker.start(
                session_name, worktree, prompt_content, env=env, extra_flags=extra_flags
            )
            if info.id:
                state.set_session(str(issue_num), info.id, config.WORKER)
            _flip_issue_label(
                config,
                issue_num,
                add=[config.LABEL_AGENT_DOING],
                remove=[config.LABEL_PENDING_AGENT],
            )
            return True

        log(f"issue #{issue_num} -> no worktree, fallback to dispatch-new-issue")
        return dispatch_new_issue(config, state, issue_num)
    except Exception as exc:
        log(f"dispatch-issue-comment error for #{issue_num}: {exc}")
        return False


def dispatch_pr_comment(
    config: Config, state: State, pr_num: int, branch: str, latest_comment_id: int
) -> bool:
    try:
        issue_n = PlatformBase.branch_to_issue_num(branch, config.BRANCH_PREFIX)

        if issue_n is None:
            log(
                f"PR #{pr_num}: branch '{branch}' does not match BRANCH_PREFIX '{config.BRANCH_PREFIX}'"
            )
            _flip_pr_label(
                config,
                pr_num,
                add=[config.LABEL_PENDING_HUMAN],
                remove=[config.LABEL_PENDING_AGENT],
            )
            return True

        worktree = config.worktree_path(issue_n)
        session_name = config.claude_session_name(issue_n)

        prompt_vars = build_prompt_vars(
            config, issue_n, PR=str(pr_num), ISSUE_N=str(issue_n), BRANCH=branch
        )
        template = find_prompt_template("pr-comment", config.PROJECT_ROOT, config.SKILL_DIR)
        if template:
            prompt_content = render_template(template, prompt_vars)
        else:
            cli = config.get_platform().cli_cmd
            prompt_content = (
                f"PR #{pr_num} 有新评论。读 `{cli} pr view {pr_num} --repo {config.REPO} --comments`，按内容处理：\n"
                f"- 讨论 → {cli} pr comment 回答\n"
                f"- 改代码 → 改 + 测试 + commit + push + 评论\n"
                f"- 不明 → 反问\n"
                f"完成后 {cli} pr edit {pr_num} --add-label {config.LABEL_PENDING_HUMAN} --remove-label {config.LABEL_PENDING_AGENT}"
            )

        write_prompt_file(prompt_content, issue_n, suffix=f"pr-{pr_num}")

        worker = _get_worker(config)
        extra_flags = _get_extra_flags(config)
        session_info = state.get_session(str(issue_n))

        if session_info and session_info.get("session_id"):
            status = worker.get_status(session_info["session_id"])
            if status != WorkerStatus.NOT_FOUND:
                log(f"PR #{pr_num} -> resume existing session {session_info['session_id']}")
                worker.resume(
                    session_info["session_id"], worktree, prompt_content, extra_flags=extra_flags
                )
                _flip_pr_label(
                    config,
                    pr_num,
                    add=[config.LABEL_AGENT_DOING],
                    remove=[config.LABEL_PENDING_AGENT],
                )
                return True

        if Path(worktree).exists():
            log(f"PR #{pr_num} -> worktree exists, starting new session in {worktree}")
            env = _build_env(config)
            info = worker.start(
                session_name, worktree, prompt_content, env=env, extra_flags=extra_flags
            )
            if info.id:
                state.set_session(str(issue_n), info.id, config.WORKER)
            _flip_pr_label(
                config,
                pr_num,
                add=[config.LABEL_AGENT_DOING],
                remove=[config.LABEL_PENDING_AGENT],
            )
            return True

        log(f"PR #{pr_num} -> rebuilding worktree on {branch}")
        fetch_origin(config.PROJECT_ROOT, branch)
        wt = create_worktree(config.PROJECT_ROOT, worktree, branch, config.WORKTREE_BASE)
        if not wt:
            log(f"PR #{pr_num}: create worktree failed")
            return False

        set_worktree_identity(
            worktree,
            getattr(config, "WORKTREE_GIT_USER_NAME", ""),
            getattr(config, "WORKTREE_GIT_USER_EMAIL", ""),
        )
        copy_files_to_worktree(config.PROJECT_ROOT, worktree, config.COPY_TO_WORKTREE)
        run_setup_cmd(worktree, config.WORKTREE_SETUP_CMD)

        env = _build_env(config)
        info = worker.start(
            session_name, worktree, prompt_content, env=env, extra_flags=extra_flags
        )
        if info.id:
            state.set_session(str(issue_n), info.id, config.WORKER)

        _flip_pr_label(
            config,
            pr_num,
            add=[config.LABEL_AGENT_DOING],
            remove=[config.LABEL_PENDING_AGENT],
        )

        log(f"dispatch-pr-comment done: PR #{pr_num} fresh worktree + session")
        return True
    except Exception as exc:
        log(f"dispatch-pr-comment error for PR #{pr_num}: {exc}")
        return False
