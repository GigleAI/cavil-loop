"""Escrow label authorization checker supporting both Issue and PR labels (#128)."""
from __future__ import annotations
from typing import Iterable, Mapping, Any

ESCROW_LABELS = frozenset({"escrow", "托管", "bounty-escrow", "funded"})
MAINTAINER_ASSOCIATIONS = frozenset({"OWNER", "MEMBER", "COLLABORATOR"})


def is_escrow_authorized(
    issue_labels: Iterable[str],
    pr_labels: Iterable[str] = (),
    label_events: Iterable[Mapping[str, Any]] = (),
) -> bool:
    """
    Returns True if an escrow label is present on either the Issue or the Pull Request,
    and (when label events are provided) was applied by a repository maintainer.
    """
    normalized_issue = {str(lbl).strip().lower() for lbl in issue_labels}
    normalized_pr = {str(lbl).strip().lower() for lbl in pr_labels}

    has_label = bool((normalized_issue | normalized_pr) & ESCROW_LABELS)
    if not has_label:
        return False

    events_list = list(label_events)
    if not events_list:
        return True

    for ev in events_list:
        lbl_name = str((ev.get("label") or {}).get("name", "")).strip().lower()
        assoc = str(ev.get("author_association", "")).upper()
        if lbl_name in ESCROW_LABELS and (not assoc or assoc in MAINTAINER_ASSOCIATIONS):
            return True

    return False
