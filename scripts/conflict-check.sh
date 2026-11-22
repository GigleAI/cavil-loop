#!/usr/bin/env bash
# Would this PR merge cleanly into its base right now? (GitHub#599; the rule itself is GitHub#82's
# hand-off check, unchanged.) Run by the worker / reviewer through the templates' `cavil_step`:
#
#   bash conflict-check.sh --result-fd 3 --repo <owner/repo> <pr number>
#
# Run inside the item's worktree (the remote `origin` is fetched). Results on fd 3 (protocol: _step.sh):
#   clean     {base, head}
#   conflict  {base, head, files}    files = the conflicting paths, from git itself
#   error     {stage, diag}          the check could not run; never "no conflict"
#   usage     {diag}
# The verdict rule matches `pr_conflict_verdict` in _lib.sh and is cross-checked against it by
# tests/pending-human-conflict.test.sh: GitHub's head commit of the PR (not the local HEAD) is merged
# with origin/<base>; merge-tree exit 1 is a conflict only when its first line is a tree id.

# ── Conflict check before a PR is handed on: rules moved from the root AGENTS.md (GitHub#658); read before changing ──
# Conflict check before a PR is handed on (GitHub#82) → `tests/conflict-check-prompts.test.sh`. Since
# GitHub#599 the check is `scripts/conflict-check.sh`, called as `cavil_step conflict-check <PR>` from
# `issue-comment.template.md` (§ A), `pr-comment.template.md` and `review.template.md` (step 2C); the
# worker-side handling section is identical in the two worker templates. The test checks the
# `cavil_step` definition block is identical in all four composed prompts, that the step comes before
# the label flip / verdict, and runs the composed definition in a real git worktree with a fake `gh`.
# The verdict rule is `pr_conflict_verdict`'s: `tests/pending-human-conflict.test.sh` runs the script
# and the daemon on the same PRs
#
set -uo pipefail

# shellcheck source=_step.sh
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/_step.sh"

usage_bad=0
step_parse conflict-check "$@" || usage_bad=$?
[ "$usage_bad" -ne 2 ] || exit 64
P="${STEP_ARGS[0]:-}"
[ "${#STEP_ARGS[@]}" -eq 1 ] || usage_bad=1
case "$P" in ''|*[!0-9]*) usage_bad=1 ;; esac

# the start marker is the only proof the caller has that nothing was sent: no marker, no request
step_start || exit 65

if [ "$usage_bad" -ne 0 ]; then
    step_result '{"step":"conflict-check","status":"usage","diag":"usage:bad-arguments"}'
    exit 0
fi

fail_with() {   # fail_with <stage> <diag>
    step_result "$(jq -nc --arg s "$1" --arg d "$2" '{step: "conflict-check", status: "error", stage: $s, diag: $d}')"
    exit 0
}

step_gh read-pr api "repos/$STEP_REPO/pulls/$P" --jq '"\(.base.ref) \(.head.sha)"' \
    || fail_with read-pr "$STEP_DIAG"
read -r BASE HEAD_OID <<<"$STEP_OUT"
[ -n "${BASE:-}" ] && printf '%s' "${HEAD_OID:-}" | grep -Eq '^[0-9a-f]{40}([0-9a-f]{24})?$' \
    || fail_with read-pr "read-pr:bad-answer"
git check-ref-format --branch "$BASE" >/dev/null 2>&1 3>&- || fail_with read-pr "read-pr:bad-base"

# the base may be briefly unreachable: step_git tries twice
step_git fetch fetch -q origin "$BASE" "pull/$P/head" || fail_with fetch "$STEP_DIAG"
git rev-parse -q --verify "origin/$BASE^{commit}" >/dev/null 2>&1 3>&- || fail_with verify "verify:no-base"
git rev-parse -q --verify "$HEAD_OID^{commit}" >/dev/null 2>&1 3>&- || fail_with verify "verify:no-head"

rc=0
MT=$(git merge-tree --write-tree --name-only "$HEAD_OID" "origin/$BASE" 2>/dev/null 3>&-) || rc=$?
if [ "$rc" -eq 0 ]; then
    step_result "$(jq -nc --arg b "$BASE" --arg h "$HEAD_OID" '{step: "conflict-check", status: "clean", base: $b, head: $h}')"
elif [ "$rc" -eq 1 ] && grep -qE '^[0-9a-f]{40}([0-9a-f]{24})?$' <<<"${MT%%$'\n'*}"; then
    files=$(sed -n '2,/^$/p' <<<"$MT" | sed '/^$/d' | jq -R . 3>&- | jq -cs . 3>&-)
    step_result "$(printf '%s' "${files:-[]}" | jq -c --arg b "$BASE" --arg h "$HEAD_OID" \
        '{step: "conflict-check", status: "conflict", base: $b, head: $h, files: .}' 3>&-)"
else
    fail_with merge-tree "merge-tree:git-exit-$rc"
fi
