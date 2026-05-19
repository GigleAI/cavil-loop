from __future__ import annotations

from pathlib import Path

import pytest

from coding_agent.log_util import Logger, log, setup_logger


@pytest.fixture(autouse=True)
def reset_global_logger():
    import coding_agent.log_util as lu

    lu.logger = None
    yield
    lu.logger = None


def test_logger_init_creates_parent_dir(tmp_path):
    log_file = str(tmp_path / "deep" / "nested" / "dir" / "test.log")
    Logger("prefix", log_file)
    assert Path(log_file).parent.is_dir()


def test_logger_log_writes_stderr_and_file(tmp_path, capsys):
    log_file = str(tmp_path / "test.log")
    logger = Logger("myprefix", log_file)
    logger.log("hello world")
    captured = capsys.readouterr()
    assert "myprefix" in captured.err
    assert "hello world" in captured.err
    content = Path(log_file).read_text()
    assert "myprefix" in content
    assert "hello world" in content


def test_logger_log_includes_timestamp_and_prefix(tmp_path, capsys):
    log_file = str(tmp_path / "ts.log")
    logger = Logger("pfx", log_file)
    logger.log("msg")
    captured = capsys.readouterr()
    line = captured.err.strip()
    assert line.startswith("[")
    assert "[pfx]" in line
    content = Path(log_file).read_text().strip()
    assert content.startswith("[")
    assert "[pfx]" in content


def test_setup_logger_sets_global(tmp_path):
    log_file = str(tmp_path / "global.log")
    logger = setup_logger("glpfx", log_file)
    import coding_agent.log_util as lu

    assert lu.logger is logger
    assert logger.prefix == "glpfx"


def test_log_uses_global_logger(tmp_path, capsys):
    log_file = str(tmp_path / "via_global.log")
    setup_logger("gpfx", log_file)
    log("test message")
    captured = capsys.readouterr()
    assert "gpfx" in captured.err
    assert "test message" in captured.err


def test_log_fallback_stderr_no_logger(capsys):
    import coding_agent.log_util as lu

    lu.logger = None
    log("fallback msg")
    captured = capsys.readouterr()
    assert "fallback msg" in captured.err
