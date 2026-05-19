from __future__ import annotations

import subprocess
from unittest.mock import MagicMock, patch

import pytest

from coding_agent.platform import (
    PlatformBase,
    available_platforms,
    detect_platform,
    get_platform,
    register_platform,
)


def test_branch_to_issue_num_extracts_number():
    result = PlatformBase.branch_to_issue_num("feature/issue-42", "feature/issue-")
    assert result == 42


def test_branch_to_issue_num_returns_none_non_matching():
    result = PlatformBase.branch_to_issue_num("main", "feature/issue-")
    assert result is None


def test_branch_to_issue_num_special_regex_chars():
    result = PlatformBase.branch_to_issue_num("fix+issue-7", "fix+issue-")
    assert result == 7


def test_available_platforms():
    platforms = available_platforms()
    assert "github" in platforms
    assert "gitlab" in platforms


def test_get_platform_github():
    p = get_platform("github")
    assert isinstance(p, type(None).__class__.__mro__[1].__subclasses__()[-1]) or True
    from coding_agent.platform.github import GitHubPlatform

    assert isinstance(p, GitHubPlatform)


def test_get_platform_gitlab():
    from coding_agent.platform.gitlab import GitLabPlatform

    p = get_platform("gitlab")
    assert isinstance(p, GitLabPlatform)


def test_get_platform_unknown_raises():
    with pytest.raises(ValueError, match="Unknown platform"):
        get_platform("unknown")


def test_github_platform_name():
    from coding_agent.platform.github import GitHubPlatform

    p = GitHubPlatform()
    assert p.name == "github"


def test_github_platform_cli_cmd():
    from coding_agent.platform.github import GitHubPlatform

    p = GitHubPlatform()
    assert p.cli_cmd == "gh"


def test_gitlab_platform_name():
    from coding_agent.platform.gitlab import GitLabPlatform

    p = GitLabPlatform()
    assert p.name == "gitlab"


def test_gitlab_platform_cli_cmd():
    from coding_agent.platform.gitlab import GitLabPlatform

    p = GitLabPlatform()
    assert p.cli_cmd == "glab"


def test_register_platform_custom():
    from coding_agent.platform import _PLATFORM_REGISTRY

    class MockPlatform(PlatformBase):
        @property
        def name(self) -> str:
            return "mock"

        @property
        def cli_cmd(self) -> str:
            return "mockcli"

        def list_issues(self, repo, label):
            return []

        def list_prs(self, repo, label):
            return []

        def list_merged_prs(self, repo, limit=30):
            return []

        def edit_labels(self, target, target_type, repo, add_labels, remove_labels):
            return True

        def create_label(self, name, color, description, repo):
            return True

        def get_issue_title(self, issue_num, repo):
            return ""

        def get_issue_state(self, issue_num, repo):
            return "OPEN"

        def get_latest_comment_id(self, repo, issue_or_pr, endpoint):
            return 0

        def comment_on_issue(self, issue_num, repo, body):
            return True

        def comment_on_pr(self, pr_num, repo, body):
            return True

        def get_repo_name(self, host_path):
            return "owner/repo"

        def auth_status(self):
            return True

    register_platform(MockPlatform)
    assert "mock" in _PLATFORM_REGISTRY
    p = get_platform("mock")
    assert p.name == "mock"


def test_detect_platform_github_url():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "https://github.com/owner/repo.git"
    with patch("subprocess.run", return_value=mock_result):
        result = detect_platform("/some/path")
        assert result == "github"


def test_detect_platform_gitlab_url():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "https://gitlab.com/owner/repo.git"
    with patch("subprocess.run", return_value=mock_result):
        result = detect_platform("/some/path")
        assert result == "gitlab"


def test_detect_platform_unrecognized_url():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "https://bitbucket.org/owner/repo.git"
    with patch("subprocess.run", return_value=mock_result):
        result = detect_platform("/some/path")
        assert result is None


def test_detect_platform_subprocess_error():
    with patch("subprocess.run", side_effect=subprocess.CalledProcessError(1, "git")):
        result = detect_platform("/some/path")
        assert result is None
