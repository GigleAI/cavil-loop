from __future__ import annotations

import argparse
import os
import subprocess
import sys

from coding_agent.cleanup import cleanup_issue
from coding_agent.config import Config
from coding_agent.log_util import setup_logger
from coding_agent.poll import daemon as run_daemon
from coding_agent.poll import poll as run_poll
from coding_agent.seed import seed_state
from coding_agent.setup_cmd import setup
from coding_agent.state import State
from coding_agent.worker import WorkerStatus, get_worker


def _load_config_and_state(args) -> tuple[Config, State]:
    if getattr(args, "config", None):
        os.environ["CODING_AGENT_CONFIG"] = args.config
    config = Config()
    log_file = os.path.join(config.STATE_DIR, "poll.log")
    setup_logger(config.TMUX_PREFIX, log_file)
    state = State.load(config.STATE_DIR)
    if getattr(args, "worker", None):
        config.WORKER = args.worker
    if getattr(args, "platform", None):
        config.PLATFORM = args.platform
    return config, state


def cmd_daemon(args) -> None:
    config, state = _load_config_and_state(args)
    run_daemon(config, state)


def cmd_poll(args) -> None:
    config, state = _load_config_and_state(args)
    run_poll(config, state)


def cmd_setup(args) -> None:
    setup(args.host_path, args.key or "")


def cmd_status(args) -> None:
    config, state = _load_config_and_state(args)
    worker = get_worker(config.WORKER)

    print(f"Project: {config.REPO}")
    print(f"Worker:  {config.WORKER}")
    print(f"Repo:    {config.REPO}")
    print()

    live_sessions = worker.list_sessions()
    live_ids = {s.id for s in live_sessions}

    issue_by_session_id: dict[str, str] = {}
    worktree_by_session_id: dict[str, str] = {}
    for issue_num, session_data in state.sessions.items():
        sid = session_data.get("session_id", "")
        issue_by_session_id[sid] = issue_num
        worktree_by_session_id[sid] = config.worktree_path(int(issue_num))

    print(f"{'SESSION_ID':<40} {'NAME':<20} {'STATUS':<15} {'ISSUE':<8} {'WORKTREE'}")
    print("-" * 110)

    for s in live_sessions:
        issue = issue_by_session_id.get(s.id, "")
        wt = worktree_by_session_id.get(s.id, s.worktree)
        print(f"{s.id:<40} {s.name:<20} {s.status.value:<15} {issue:<8} {wt}")

    dead_sessions = []
    for issue_num, session_data in state.sessions.items():
        sid = session_data.get("session_id", "")
        if sid not in live_ids:
            dead_sessions.append((issue_num, session_data))

    if dead_sessions:
        print()
        print("Dead sessions (in state but not in worker):")
        for issue_num, session_data in dead_sessions:
            sid = session_data.get("session_id", "")
            wt = config.worktree_path(int(issue_num))
            print(f"  {sid:<40} issue #{issue_num:<6} {wt}")

    active = sum(1 for s in live_sessions if s.status == WorkerStatus.WORKING)
    print()
    print(f"Total: {len(live_sessions)} session(s), {active} active worker(s)")


def cmd_attach(args) -> None:
    config, state = _load_config_and_state(args)
    session = state.get_session(str(args.issue_num))
    if not session:
        print(f"No session found for issue #{args.issue_num}", file=sys.stderr)
        sys.exit(1)

    session_id = session["session_id"]
    worker = get_worker(session.get("worker", config.WORKER))
    worker.attach(session_id)


def cmd_logs(args) -> None:
    config, state = _load_config_and_state(args)
    session = state.get_session(str(args.issue_num))
    if not session:
        print(f"No session found for issue #{args.issue_num}", file=sys.stderr)
        sys.exit(1)

    session_id = session["session_id"]
    worker = get_worker(session.get("worker", config.WORKER))

    if args.follow:
        session_name = config.claude_session_name(args.issue_num)
        log_path = config.session_log_path(session_name)
        if not log_path:
            print("SESSION_LOG_DIR not configured", file=sys.stderr)
            sys.exit(1)
        if not os.path.isfile(log_path):
            print(f"Log file not found: {log_path}", file=sys.stderr)
            sys.exit(1)
        if sys.platform == "win32":
            try:
                proc = subprocess.Popen(
                    ["powershell", "-Command", f"Get-Content -Path '{log_path}' -Wait -Tail 200"],
                )
                proc.wait()
            except KeyboardInterrupt:
                pass
        else:
            os.execvp("tail", ["tail", "-n", "200", "-F", log_path])
    else:
        output = worker.get_logs(session_id)
        print(output)


def cmd_cleanup(args) -> None:
    config, state = _load_config_and_state(args)
    ok = cleanup_issue(
        config,
        state,
        args.issue_num,
        force=args.force,
        keep_worktree=args.keep_worktree,
        delete_branch=args.delete_branch,
    )
    if not ok:
        print("Cleanup failed (session may be busy — use --force)", file=sys.stderr)
        sys.exit(1)


def cmd_seed(args) -> None:
    config, state = _load_config_and_state(args)
    seed_state(config, state)


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="coding_agent",
        description="coding-agent-work-loop CLI",
    )
    parser.add_argument("--config", help="Path to coding-agent.config")
    parser.add_argument(
        "--worker",
        choices=["claude", "opencode"],
        help="Worker backend (overrides config)",
    )
    parser.add_argument(
        "--platform",
        choices=["github", "gitlab"],
        help="Git platform (overrides config / auto-detect)",
    )

    sub = parser.add_subparsers(dest="command")
    sub.required = True

    sub.add_parser("daemon", help="Run poll loop (while True + sleep)")
    sub.add_parser("poll", help="Run one poll cycle and exit")

    sp_setup = sub.add_parser("setup", help="Deploy to a host project")
    sp_setup.add_argument("host_path", help="Path to host project")
    sp_setup.add_argument("--key", default="", help="Custom instance key")

    sub.add_parser("status", help="Show session list and daemon status")

    sp_attach = sub.add_parser("attach", help="Attach to worker session TUI")
    sp_attach.add_argument("issue_num", type=int, help="Issue number")

    sp_logs = sub.add_parser("logs", help="View session logs")
    sp_logs.add_argument("issue_num", type=int, help="Issue number")
    sp_logs.add_argument("--follow", "-f", action="store_true", help="Follow log output")

    sp_cleanup = sub.add_parser("cleanup", help="Cleanup issue worktree/session")
    sp_cleanup.add_argument("issue_num", type=int, help="Issue number")
    sp_cleanup.add_argument("--force", action="store_true", help="Force even if session busy")
    sp_cleanup.add_argument("--keep-worktree", action="store_true", help="Keep worktree")
    sp_cleanup.add_argument("--delete-branch", action="store_true", help="Delete local branch")

    sub.add_parser("seed", help="Initialize state.json with current data")

    args = parser.parse_args()

    try:
        handler = {
            "daemon": cmd_daemon,
            "poll": cmd_poll,
            "setup": cmd_setup,
            "status": cmd_status,
            "attach": cmd_attach,
            "logs": cmd_logs,
            "cleanup": cmd_cleanup,
            "seed": cmd_seed,
        }[args.command]
    except KeyError:
        parser.print_help()
        sys.exit(1)

    try:
        handler(args)
    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)