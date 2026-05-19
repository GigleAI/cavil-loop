from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

from coding_agent.prompt import (
    build_prompt_vars,
    find_prompt_template,
    render_template,
    write_prompt_file,
)


def test_find_prompt_template_skill_dir(tmp_path):
    skill_dir = tmp_path / "skill"
    prompts_dir = skill_dir / "prompts"
    prompts_dir.mkdir(parents=True)
    template = prompts_dir / "new-issue.template.md"
    template.write_text("hello")
    result = find_prompt_template("new-issue", str(tmp_path / "project"), str(skill_dir))
    assert result is not None
    assert Path(result).name == "new-issue.template.md"


def test_find_prompt_template_coding_agent_dir(tmp_path):
    project_root = tmp_path / "project"
    skill_dir = tmp_path / "skill"
    skill_prompts = skill_dir / "prompts"
    skill_prompts.mkdir(parents=True)
    (skill_prompts / "new-issue.template.md").write_text("skill version")

    ca_dir = project_root / ".coding-agent" / "prompts"
    ca_dir.mkdir(parents=True)
    (ca_dir / "new-issue.template.md").write_text("ca version")

    result = find_prompt_template("new-issue", str(project_root), str(skill_dir))
    assert result is not None
    content = Path(result).read_text()
    assert content == "ca version"


def test_find_prompt_template_returns_none(tmp_path):
    result = find_prompt_template("nonexistent", str(tmp_path), str(tmp_path / "skill"))
    assert result is None


def test_find_prompt_template_priority_order(tmp_path):
    project_root = tmp_path / "project"
    skill_dir = tmp_path / "skill"

    agents_dir = project_root / ".agents" / "skills" / "coding-agent-work-loop" / "prompts"
    agents_dir.mkdir(parents=True)
    (agents_dir / "test.template.md").write_text("agents version")

    ca_dir = project_root / ".coding-agent" / "prompts"
    ca_dir.mkdir(parents=True)
    (ca_dir / "test.template.md").write_text("ca version")

    skill_prompts = skill_dir / "prompts"
    skill_prompts.mkdir(parents=True)
    (skill_prompts / "test.template.md").write_text("skill version")

    result = find_prompt_template("test", str(project_root), str(skill_dir))
    content = Path(result).read_text()
    assert content == "agents version"


def test_render_template_replaces_vars(tmp_path):
    template = tmp_path / "test.template.md"
    template.write_text("Issue ${ISSUE} on ${REPO}")
    result = render_template(str(template), {"ISSUE": "5", "REPO": "owner/repo"})
    assert result == "Issue 5 on owner/repo"


def test_render_template_unmatched_vars_left(tmp_path):
    template = tmp_path / "test.template.md"
    template.write_text("Issue ${ISSUE} ${UNKNOWN_VAR}")
    result = render_template(str(template), {"ISSUE": "5"})
    assert result == "Issue 5 ${UNKNOWN_VAR}"


def test_render_template_multiple_vars(tmp_path):
    template = tmp_path / "test.template.md"
    template.write_text("${A} and ${B} and ${C}")
    result = render_template(str(template), {"A": "1", "B": "2", "C": "3"})
    assert result == "1 and 2 and 3"


def test_write_prompt_file_creates_file():
    path = write_prompt_file("content here", 42)
    assert Path(path).exists()
    assert Path(path).read_text() == "content here"
    assert "42" in Path(path).name
    assert "prompt" in Path(path).name


def test_write_prompt_file_with_suffix():
    path = write_prompt_file("resume content", 7, suffix="resume")
    assert Path(path).exists()
    assert "7" in Path(path).name
    assert "resume" in Path(path).name


def test_build_prompt_vars_includes_standard():
    config = MagicMock()
    config.REPO = "test/repo"
    config.LABEL_PENDING_AGENT = "pending/agent"
    config.LABEL_PENDING_HUMAN = "pending/human"
    config.LABEL_AGENT_DOING = "agent/doing"
    config.LABEL_PENDING_PR = "pending/PR"
    config.worktree_path = MagicMock(return_value="/wt/issue-5")
    config.branch_name = MagicMock(return_value="feature/issue-5")
    platform_mock = MagicMock()
    platform_mock.cli_cmd = "gh"
    config.get_platform = MagicMock(return_value=platform_mock)

    vars = build_prompt_vars(config, 5)
    assert vars["ISSUE"] == "5"
    assert vars["REPO"] == "test/repo"
    assert vars["WORKTREE"] == "/wt/issue-5"
    assert vars["BRANCH"] == "feature/issue-5"
    assert vars["LABEL_PENDING_AGENT"] == "pending/agent"
    assert vars["LABEL_PENDING_HUMAN"] == "pending/human"
    assert vars["LABEL_AGENT_DOING"] == "agent/doing"
    assert vars["LABEL_PENDING_PR"] == "pending/PR"


def test_build_prompt_vars_includes_cli_cmd():
    config = MagicMock()
    config.REPO = "test/repo"
    config.LABEL_PENDING_AGENT = "pending/agent"
    config.LABEL_PENDING_HUMAN = "pending/human"
    config.LABEL_AGENT_DOING = "agent/doing"
    config.LABEL_PENDING_PR = "pending/PR"
    config.worktree_path = MagicMock(return_value="/wt/issue-10")
    config.branch_name = MagicMock(return_value="feature/issue-10")
    platform_mock = MagicMock()
    platform_mock.cli_cmd = "glab"
    config.get_platform = MagicMock(return_value=platform_mock)

    vars = build_prompt_vars(config, 10)
    assert vars["CLI_CMD"] == "glab"


def test_build_prompt_vars_kwargs_override():
    config = MagicMock()
    config.REPO = "test/repo"
    config.LABEL_PENDING_AGENT = "pending/agent"
    config.LABEL_PENDING_HUMAN = "pending/human"
    config.LABEL_AGENT_DOING = "agent/doing"
    config.LABEL_PENDING_PR = "pending/PR"
    config.worktree_path = MagicMock(return_value="/wt/issue-1")
    config.branch_name = MagicMock(return_value="feature/issue-1")
    platform_mock = MagicMock()
    platform_mock.cli_cmd = "gh"
    config.get_platform = MagicMock(return_value=platform_mock)

    vars = build_prompt_vars(config, 1, EXTRA="val", REPO="override/repo")
    assert vars["EXTRA"] == "val"
    assert vars["REPO"] == "override/repo"
