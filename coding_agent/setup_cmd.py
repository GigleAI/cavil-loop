from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

from coding_agent.config import Config
from coding_agent.log_util import log
from coding_agent.platform import detect_platform, get_platform
from coding_agent.seed import seed_state
from coding_agent.state import State

_LABELS = [
    ("pending/agent", "5539d3", "waiting for agent"),
    ("agent/doing", "0e8a16", "agent working"),
    ("pending/human", "4bc81f", "waiting for human"),
    ("pending/PR", "bfd4f2", "work tracked via PR"),
    ("Done", "586069", "closed"),
]


def _check_dependency(cmd: str) -> bool:
    result = subprocess.run(
        ["which", cmd] if sys.platform != "win32" else ["where", cmd],
        capture_output=True,
    )
    return result.returncode == 0


def _check_python_version() -> bool:
    v = sys.version_info
    return v.major >= 3 and v.minor >= 11


def _write_conf(conf_path: Path, project_root: str, config_path: str) -> None:
    python_dir = str(Path(sys.executable).parent)
    home = str(Path.home())
    lines = [
        f"PROJECT_ROOT={project_root}",
        f"CODING_AGENT_CONFIG={config_path}",
        f"PATH={python_dir}:{home}/.local/bin:/usr/local/bin:/usr/bin:/bin",
    ]
    conf_path.parent.mkdir(parents=True, exist_ok=True)
    conf_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def setup(host_path: str, instance_key: str = "") -> None:
    host = Path(host_path).resolve()
    if not host.is_dir():
        print(f"{host} does not exist")
        sys.exit(1)
    if not (host / ".git").exists():
        print(f"{host} is not a git repo (.git not found)")
        sys.exit(1)

    if not instance_key:
        instance_key = host.name
    if not re.match(r"^[A-Za-z0-9_.-]+$", instance_key):
        print(f"instance key must match [A-Za-z0-9_.-]: {instance_key}")
        sys.exit(1)

    platform_name = detect_platform(str(host))
    if not platform_name:
        print("Cannot detect platform (GitHub or GitLab) from git remote")
        sys.exit(1)
    platform = get_platform(platform_name)

    skill_dir = Path(__file__).resolve().parent.parent

    log("coding-agent-work-loop setup")
    log(f"  host project: {host}")
    log(f"  skill dir:    {skill_dir}")
    log(f"  instance key: {instance_key}")

    missing = []
    for cmd in ("git", platform.cli_cmd, "python3"):
        if not _check_dependency(cmd):
            missing.append(cmd)
    if not _check_python_version():
        missing.append("python3.11+")
    if missing:
        print(f"missing dependencies: {', '.join(missing)}")
        sys.exit(1)
    log("dependencies ok")

    if not platform.auth_status():
        print(f"{platform.cli_cmd} not logged in. Run `{platform.cli_cmd} auth login` first")
        sys.exit(1)
    log(f"{platform.cli_cmd} auth ok")

    config_path = host / "coding-agent.config"
    if config_path.exists():
        log(f"{config_path} already exists, skipping")
    else:
        default_repo = platform.get_repo_name(str(host))
        project_name = host.name
        home = str(Path.home())
        example_path = skill_dir / "coding-agent.config.example"
        content = example_path.read_text(encoding="utf-8")
        content = content.replace("myorg/myrepo", default_repo)
        content = content.replace("$HOME/github/myproject", str(host))
        content = content.replace(
            "$HOME/github/worktree/myproject", f"{home}/github/worktree/{project_name}"
        )
        content = content.replace(
            "$HOME/.local/state/coding-agent-poll",
            f"{home}/.local/state/coding-agent-poll/{project_name}",
        )
        content = content.replace('TMUX_PREFIX="myproject"', f'TMUX_PREFIX="{project_name}"')
        config_path.write_text(content, encoding="utf-8")
        log(f"generated {config_path}")

    gitignore_path = host / ".gitignore"
    gitignore_content = ""
    if gitignore_path.exists():
        gitignore_content = gitignore_path.read_text(encoding="utf-8")
    if not re.search(r"^\s*coding-agent\.config\s*$", gitignore_content, re.MULTILINE):
        if not gitignore_path.exists():
            gitignore_path.touch()
        with open(str(gitignore_path), "a", encoding="utf-8") as f:
            f.write("\n# coding-agent-work-loop per-project config\ncoding-agent.config\n")
        log("added coding-agent.config to .gitignore")
    else:
        log("coding-agent.config already in .gitignore")

    conf_dir = Path.home() / ".config" / "coding-agent-work-loop"
    conf_path = conf_dir / f"{instance_key}.conf"
    _write_conf(conf_path, str(host), str(config_path))
    log(f"wrote {conf_path}")

    repo = default_repo
    for name, color, desc in _LABELS:
        created = platform.create_label(name, color, desc, repo)
        if created:
            log(f"created label: {name}")
        else:
            log(f"label {name} already exists")

    config = Config(config_path)
    state = State.load(config.STATE_DIR)
    seed_state(config, state)

    print()
    print("Setup complete. Next steps:")
    print(f"  1. $EDITOR {config_path} - review config (especially WORKTREE_SETUP_CMD)")
    print("  2. Run daemon: python -m coding_agent daemon")
