from __future__ import annotations

import argparse

import pytest


def _parse_args(args_list):
    parser = argparse.ArgumentParser(prog="coding_agent")
    parser.add_argument("--config")
    parser.add_argument("--worker", choices=["claude", "opencode"])
    parser.add_argument("--platform", choices=["github", "gitlab"])

    sub = parser.add_subparsers(dest="command")
    sub.required = True

    sub.add_parser("daemon")
    sub.add_parser("poll")

    sp_setup = sub.add_parser("setup")
    sp_setup.add_argument("host_path")
    sp_setup.add_argument("--key", default="")

    sub.add_parser("status")

    sp_attach = sub.add_parser("attach")
    sp_attach.add_argument("issue_num", type=int)

    sp_logs = sub.add_parser("logs")
    sp_logs.add_argument("issue_num", type=int)
    sp_logs.add_argument("--follow", "-f", action="store_true")

    sp_cleanup = sub.add_parser("cleanup")
    sp_cleanup.add_argument("issue_num", type=int)
    sp_cleanup.add_argument("--force", action="store_true")
    sp_cleanup.add_argument("--keep-worktree", action="store_true")
    sp_cleanup.add_argument("--delete-branch", action="store_true")

    sub.add_parser("seed")

    return parser.parse_args(args_list)


def test_no_args_exits():
    with pytest.raises(SystemExit):
        _parse_args([])


def test_help_exits_zero():
    with pytest.raises(SystemExit) as exc_info:
        _parse_args(["--help"])
    assert exc_info.value.code == 0


def test_poll_subcommand():
    args = _parse_args(["poll"])
    assert args.command == "poll"


def test_daemon_subcommand():
    args = _parse_args(["daemon"])
    assert args.command == "daemon"


def test_setup_parses_host_path():
    args = _parse_args(["setup", "/path/to/project"])
    assert args.host_path == "/path/to/project"


def test_setup_parses_key():
    args = _parse_args(["setup", "/path", "--key", "mykey"])
    assert args.key == "mykey"


def test_status_subcommand():
    args = _parse_args(["status"])
    assert args.command == "status"


def test_attach_parses_issue_num():
    args = _parse_args(["attach", "42"])
    assert args.issue_num == 42


def test_logs_parses_issue_num():
    args = _parse_args(["logs", "42"])
    assert args.issue_num == 42


def test_logs_parses_follow():
    args = _parse_args(["logs", "42", "-f"])
    assert args.follow is True


def test_cleanup_parses_issue_num():
    args = _parse_args(["cleanup", "42"])
    assert args.issue_num == 42


def test_cleanup_parses_all_flags():
    args = _parse_args(["cleanup", "42", "--force", "--keep-worktree", "--delete-branch"])
    assert args.force is True
    assert args.keep_worktree is True
    assert args.delete_branch is True


def test_config_option():
    args = _parse_args(["--config", "/path/to/config", "poll"])
    assert args.config == "/path/to/config"


def test_worker_claude():
    args = _parse_args(["--worker", "claude", "poll"])
    assert args.worker == "claude"


def test_worker_opencode():
    args = _parse_args(["--worker", "opencode", "poll"])
    assert args.worker == "opencode"


def test_platform_github():
    args = _parse_args(["--platform", "github", "poll"])
    assert args.platform == "github"


def test_platform_gitlab():
    args = _parse_args(["--platform", "gitlab", "poll"])
    assert args.platform == "gitlab"


def test_invalid_worker_exits():
    with pytest.raises(SystemExit):
        _parse_args(["--worker", "foo", "poll"])
