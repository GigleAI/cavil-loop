from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import pytest

from coding_agent.config import Config, _parse_config


def _make_config(tmp_path, extra_lines=""):
    config_text = "\n".join(
        [
            'REPO="test/repo"',
            'PROJECT_ROOT="/tmp/test"',
            f'WORKTREE_BASE="{tmp_path}/worktree"',
            f'STATE_DIR="{tmp_path}/state"',
            'TMUX_PREFIX="test"',
            'BRANCH_PREFIX="feature/issue-"',
            'SESSION_NAME_PREFIX="issue"',
            'LABEL_PENDING_AGENT="pending/agent"',
            'LABEL_PENDING_HUMAN="pending/human"',
            'PLATFORM="github"',
            extra_lines,
        ]
    )
    config_path = tmp_path / "coding-agent.config"
    config_path.write_text(config_text)
    return config_path


def test_parse_config_basic():
    result = _parse_config("FOO=bar\nBAZ=123")
    assert result["FOO"] == "bar"
    assert result["BAZ"] == "123"


def test_parse_config_comments_skipped():
    result = _parse_config("# this is a comment\nFOO=bar\n# another comment")
    assert "FOO" in result
    assert len(result) == 1


def test_parse_config_empty_lines_skipped():
    result = _parse_config("\n\nFOO=bar\n\n\nBAZ=qux\n")
    assert result == {"FOO": "bar", "BAZ": "qux"}


def test_parse_config_double_quotes_stripped():
    result = _parse_config('FOO="hello world"')
    assert result["FOO"] == "hello world"


def test_parse_config_single_quotes_stripped():
    result = _parse_config("FOO='hello world'")
    assert result["FOO"] == "hello world"


def test_parse_config_tilde_expanded():
    home = str(Path.home())
    result = _parse_config("FOO=~/.config")
    assert result["FOO"] == home + "/.config"


def test_parse_config_home_expanded():
    home = str(Path.home())
    result = _parse_config("FOO=$HOME/.config")
    assert result["FOO"] == home + "/.config"


def test_parse_config_brace_var_ref_expanded():
    result = _parse_config("BASE=/opt\nFOO=${BASE}/sub")
    assert result["FOO"] == "/opt/sub"


def test_parse_config_dollar_var_ref_expanded():
    result = _parse_config("BASE=/opt\nFOO=$BASE/sub")
    assert result["FOO"] == "/opt/sub"


def test_parse_config_undefined_var_left_as_is():
    result = _parse_config("FOO=$UNDEFINED_VAR/sub")
    assert result["FOO"] == "$UNDEFINED_VAR/sub"


def test_parse_config_chained_var_expansion():
    result = _parse_config("A=/root\nB=${A}/mid\nC=${B}/end")
    assert result["C"] == "/root/mid/end"


def test_config_missing_required_field_raises(tmp_path):
    config_path = tmp_path / "coding-agent.config"
    config_path.write_text('REPO="test/repo"\nPROJECT_ROOT="/tmp"')
    with pytest.raises(ValueError, match="Required config field missing"):
        Config(config_path)


def test_config_defaults_applied(tmp_path):
    config_path = _make_config(tmp_path)
    cfg = Config(config_path)
    assert cfg.WORKER == "claude"
    assert cfg.MAX_CONCURRENT_WORKERS == "1"
    assert cfg.POLL_INTERVAL_SECS == "60"
    assert cfg.AUTO_CLEANUP_ON_MERGE == "true"
    assert cfg.WORKTREE_SETUP_CMD == ":"
    assert cfg.COPY_TO_WORKTREE == ".env"


def test_config_session_log_dir_default(tmp_path):
    config_path = _make_config(tmp_path)
    cfg = Config(config_path)
    assert cfg.STATE_DIR + "/sessions" == cfg.SESSION_LOG_DIR


def test_config_skill_dir_from_env(tmp_path):
    config_path = _make_config(tmp_path)
    with patch.dict(os.environ, {"CLAUDE_PLUGIN_ROOT": "/custom/skill"}):
        cfg = Config(config_path)
        assert cfg.SKILL_DIR == "/custom/skill"


def test_config_skill_dir_default(tmp_path):
    config_path = _make_config(tmp_path)
    env = os.environ.copy()
    env.pop("CLAUDE_PLUGIN_ROOT", None)
    with patch.dict(os.environ, env, clear=True):
        cfg = Config(config_path)
        assert str(config_path.parent.parent.resolve()) == cfg.SKILL_DIR


def test_config_state_dir_created(tmp_path):
    state_dir = tmp_path / "deep" / "nested" / "state"
    config_text = "\n".join(
        [
            'REPO="test/repo"',
            'PROJECT_ROOT="/tmp/test"',
            f'WORKTREE_BASE="{tmp_path}/worktree"',
            f'STATE_DIR="{state_dir}"',
            'TMUX_PREFIX="test"',
            'BRANCH_PREFIX="feature/issue-"',
            'SESSION_NAME_PREFIX="issue"',
            'LABEL_PENDING_AGENT="pending/agent"',
            'LABEL_PENDING_HUMAN="pending/human"',
            'PLATFORM="github"',
        ]
    )
    config_path = tmp_path / "coding-agent.config"
    config_path.write_text(config_text)
    Config(config_path)
    assert state_dir.is_dir()


def test_config_helper_methods(tmp_path):
    config_path = _make_config(tmp_path)
    cfg = Config(config_path)
    assert cfg.worktree_path(5) == f"{tmp_path}/worktree/issue-5"
    assert cfg.branch_name(5) == "feature/issue-5"
    assert cfg.tmux_session_name(5) == "test-issue5"
    assert cfg.claude_session_name(5) == "issue5"


def test_config_session_log_path(tmp_path):
    config_path = _make_config(tmp_path, 'SESSION_LOG_DIR="/var/log/sessions"')
    cfg = Config(config_path)
    assert cfg.session_log_path("issue5") == "/var/log/sessions/issue5.log"


def test_config_session_log_path_empty(tmp_path):
    config_path = _make_config(tmp_path, 'SESSION_LOG_DIR=""')
    cfg = Config(config_path)
    assert cfg.session_log_path("issue5") == ""


def test_config_platform_auto_detect_success(tmp_path):
    config_path = _make_config(tmp_path, 'PLATFORM=""')
    with patch("coding_agent.platform.detect_platform", return_value="github"):
        cfg = Config(config_path)
        assert cfg.PLATFORM == "github"


def test_config_platform_auto_detect_failure(tmp_path):
    config_path = _make_config(tmp_path, 'PLATFORM=""')
    with (
        patch("coding_agent.platform.detect_platform", return_value=None),
        pytest.raises(ValueError, match="Cannot auto-detect platform"),
    ):
        Config(config_path)
