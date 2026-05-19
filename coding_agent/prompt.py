from __future__ import annotations

import tempfile
from pathlib import Path


def find_prompt_template(name: str, project_root: str, skill_dir: str) -> str | None:
    candidates = [
        Path(project_root) / ".agents" / "skills" / "coding-agent-work-loop" / "prompts" / f"{name}.template.md",
        Path(project_root) / ".agents" / "skills" / "coding-agent-workflow" / "prompts" / f"{name}.template.md",
        Path(project_root) / ".coding-agent" / "prompts" / f"{name}.template.md",
        Path(skill_dir) / "prompts" / f"{name}.template.md",
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    return None


def render_template(template_path: str, vars: dict[str, str]) -> str:
    text = Path(template_path).read_text(encoding="utf-8")
    for key, value in vars.items():
        text = text.replace(f"${{{key}}}", value)
    return text


def write_prompt_file(content: str, issue_num: int, suffix: str = "") -> str:
    tmpdir = tempfile.gettempdir()
    if suffix:
        filename = f"coding-agent-issue-{issue_num}-{suffix}.md"
    else:
        filename = f"coding-agent-issue-{issue_num}-prompt.md"
    path = Path(tmpdir) / filename
    path.write_text(content, encoding="utf-8")
    return str(path)


def build_prompt_vars(config, issue_num: int, **kwargs) -> dict[str, str]:
    result: dict[str, str] = {
        "ISSUE": str(issue_num),
        "REPO": config.REPO,
        "WORKTREE": config.worktree_path(issue_num),
        "BRANCH": config.branch_name(issue_num),
        "LABEL_PENDING_AGENT": config.LABEL_PENDING_AGENT,
        "LABEL_PENDING_HUMAN": config.LABEL_PENDING_HUMAN,
        "LABEL_AGENT_DOING": config.LABEL_AGENT_DOING,
        "LABEL_PENDING_PR": config.LABEL_PENDING_PR,
        "CLI_CMD": config.get_platform().cli_cmd,
    }
    result.update(kwargs)
    return result
