from __future__ import annotations

import json
from pathlib import Path

import pytest

from coding_agent.state import State, acquire_lock, release_lock


@pytest.fixture(autouse=True)
def reset_global_lock():
    import coding_agent.state as st

    st._LOCK_FD = None
    yield
    st._LOCK_FD = None


def test_state_load_creates_new(tmp_path):
    state_dir = str(tmp_path / "state_new")
    state = State.load(state_dir)
    assert state.seen_comments == {}
    assert state.seen_issue_comments == {}
    assert state.seen_review_comments == {}
    assert state.seen_reviews == {}
    assert state.cleaned_prs == []
    assert state.sessions == {}


def test_state_load_reads_existing(tmp_path):
    state_dir = str(tmp_path / "state_existing")
    Path(state_dir).mkdir()
    data = {
        "seen_comments": {"42": 100},
        "seen_issue_comments": {},
        "seen_review_comments": {},
        "seen_reviews": {},
        "cleaned_prs": [7],
        "sessions": {"5": {"session_id": "abc", "worker": "claude"}},
    }
    Path(state_dir, "state.json").write_text(json.dumps(data))
    state = State.load(state_dir)
    assert state.seen_comments == {"42": 100}
    assert state.cleaned_prs == [7]
    assert state.sessions == {"5": {"session_id": "abc", "worker": "claude"}}


def test_state_load_migration_missing_dict_fields(tmp_path):
    state_dir = str(tmp_path / "state_migrate_dict")
    Path(state_dir).mkdir()
    data = {"cleaned_prs": [1]}
    Path(state_dir, "state.json").write_text(json.dumps(data))
    state = State.load(state_dir)
    assert state.seen_comments == {}
    assert state.seen_issue_comments == {}
    assert state.seen_review_comments == {}
    assert state.seen_reviews == {}
    assert state.sessions == {}


def test_state_load_migration_missing_list_fields(tmp_path):
    state_dir = str(tmp_path / "state_migrate_list")
    Path(state_dir).mkdir()
    data = {"seen_comments": {"1": 5}}
    Path(state_dir, "state.json").write_text(json.dumps(data))
    state = State.load(state_dir)
    assert state.cleaned_prs == []


def test_state_save_atomic(tmp_path):
    state_dir = str(tmp_path / "state_save")
    state = State(state_dir)
    state.seen_comments = {"10": 99}
    state.save()
    path = Path(state_dir, "state.json")
    assert path.exists()
    raw = json.loads(path.read_text())
    assert raw["seen_comments"]["10"] == 99


def test_state_save_round_trip(tmp_path):
    state_dir = str(tmp_path / "state_roundtrip")
    state = State(state_dir)
    state.seen_comments = {"3": 50}
    state.seen_review_comments = {"7": 88}
    state.sessions = {"1": {"session_id": "x", "worker": "claude"}}
    state.save()
    loaded = State.load(state_dir)
    assert loaded.seen_comments == {"3": 50}
    assert loaded.seen_review_comments == {"7": 88}
    assert loaded.sessions == {"1": {"session_id": "x", "worker": "claude"}}


def test_seen_comments_get_and_update(tmp_path):
    state_dir = str(tmp_path / "state_comments")
    state = State.load(state_dir)
    assert state.get_seen_comments("42") == 0
    state.update_seen_comments("42", 101)
    assert state.get_seen_comments("42") == 101
    loaded = State.load(state_dir)
    assert loaded.get_seen_comments("42") == 101


def test_seen_review_comments_get_and_update(tmp_path):
    state_dir = str(tmp_path / "state_review_comments")
    state = State.load(state_dir)
    assert state.get_seen_review_comments("10") == 0
    state.update_seen_review_comments("10", 55)
    assert state.get_seen_review_comments("10") == 55


def test_seen_reviews_get_and_update(tmp_path):
    state_dir = str(tmp_path / "state_reviews")
    state = State.load(state_dir)
    assert state.get_seen_reviews("15") == 0
    state.update_seen_reviews("15", 77)
    assert state.get_seen_reviews("15") == 77


def test_seen_issue_comments_get_and_update(tmp_path):
    state_dir = str(tmp_path / "state_issue_comments")
    state = State.load(state_dir)
    assert state.get_seen_issue_comments("20") == 0
    state.update_seen_issue_comments("20", 33)
    assert state.get_seen_issue_comments("20") == 33


def test_is_pr_cleaned_and_mark(tmp_path):
    state_dir = str(tmp_path / "state_cleaned")
    state = State.load(state_dir)
    assert not state.is_pr_cleaned(5)
    state.mark_pr_cleaned(5)
    assert state.is_pr_cleaned(5)
    assert not state.is_pr_cleaned(6)


def test_mark_pr_cleaned_no_duplicates(tmp_path):
    state_dir = str(tmp_path / "state_no_dup")
    state = State.load(state_dir)
    state.mark_pr_cleaned(5)
    state.mark_pr_cleaned(5)
    state.mark_pr_cleaned(5)
    assert state.cleaned_prs == [5]


def test_bootstrap_cleaned_prs(tmp_path):
    state_dir = str(tmp_path / "state_bootstrap")
    state = State.load(state_dir)
    state.mark_pr_cleaned(1)
    state.mark_pr_cleaned(2)
    state.bootstrap_cleaned_prs([10, 20, 30])
    assert state.cleaned_prs == [10, 20, 30]
    loaded = State.load(state_dir)
    assert loaded.cleaned_prs == [10, 20, 30]


def test_session_get_set_remove(tmp_path):
    state_dir = str(tmp_path / "state_session")
    state = State.load(state_dir)
    assert state.get_session("5") is None
    state.set_session("5", "abc123", "claude")
    result = state.get_session("5")
    assert result == {"session_id": "abc123", "worker": "claude"}
    state.remove_session("5")
    assert state.get_session("5") is None


def test_acquire_and_release_lock(tmp_path):
    state_dir = str(tmp_path / "state_lock")
    assert acquire_lock(state_dir) is True
    release_lock(state_dir)
    import coding_agent.state as st

    assert st._LOCK_FD is None


def test_acquire_lock_second_fails(tmp_path):
    state_dir = str(tmp_path / "state_lock2")
    assert acquire_lock(state_dir) is True
    assert acquire_lock(state_dir) is False
    release_lock(state_dir)
