#!/usr/bin/env bash
# Read every piece of feedback on a PR in one go (GitHub#599): conversation comments, inline review
# comments and review submissions, every page of each. Run by the PR-comment worker through the
# template's `cavil_step`:
#
#   bash pr-feedback.sh --result-fd 3 --repo <owner/repo> <pr number>
#
# Results on fd 3 (protocol: _step.sh):
#   ok     {comments: [...]}   one record per comment / review, oldest first per source:
#            source (conversation | inline | review), id, author, created, updated, edited,
#            body (latest full text); conversation: has_checkbox; inline: path, line; review: state
#   error  {stage, diag}       a source could not be read whole: no record at all is given
#   usage  {diag}
# `edited` + `has_checkbox` are how the worker finds a human's tick in one of the agent's older
# question comments (ticking edits that comment; no new comment appears).
# The bodies are other people's text: they only ever travel JSON-escaped inside the result, so a
# body cannot fake a record or a field; `diag` holds fixed words and numbers only.
set -uo pipefail

# shellcheck source=_step.sh
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/_step.sh"

usage_bad=0
step_parse pr-feedback "$@" || usage_bad=$?
[ "$usage_bad" -ne 2 ] || exit 64
P="${STEP_ARGS[0]:-}"
[ "${#STEP_ARGS[@]}" -eq 1 ] || usage_bad=1
case "$P" in ''|*[!0-9]*) usage_bad=1 ;; esac

# the start marker is the only proof the caller has that nothing was sent: no marker, no request
step_start || exit 65

if [ "$usage_bad" -ne 0 ]; then
    step_result '{"step":"pr-feedback","status":"usage","diag":"usage:bad-arguments"}'
    exit 0
fi

fail_with() {
    step_result "$(jq -nc --arg s "$1" --arg d "$2" '{step: "pr-feedback", status: "error", stage: $s, diag: $d}')"
    exit 0
}

# --paginate runs the filter per page, so each one emits one compact record per line
CONV_JQ='.[] | {source: "conversation", id, author: .user.login, created: .created_at, updated: .updated_at,
  edited: (.updated_at != .created_at), has_checkbox: ((.body // "") | test("- \\[[ xX]\\]")), body: (.body // "")}'
INLINE_JQ='.[] | {source: "inline", id, author: .user.login, created: .created_at, updated: (.updated_at // .created_at),
  edited: ((.updated_at // .created_at) != .created_at), path, line, body: (.body // "")}'
REVIEW_JQ='.[] | {source: "review", id, author: .user.login, created: .submitted_at, updated: .submitted_at,
  edited: false, state, body: (.body // "")}'

step_gh read-conversation api --paginate "repos/$STEP_REPO/issues/$P/comments" --jq "$CONV_JQ" \
    || fail_with read-conversation "$STEP_DIAG"
conv="$STEP_OUT"
step_gh read-inline api --paginate "repos/$STEP_REPO/pulls/$P/comments" --jq "$INLINE_JQ" \
    || fail_with read-inline "$STEP_DIAG"
inline="$STEP_OUT"
step_gh read-reviews api --paginate "repos/$STEP_REPO/pulls/$P/reviews" --jq "$REVIEW_JQ" \
    || fail_with read-reviews "$STEP_DIAG"
reviews="$STEP_OUT"

# content read back from GitHub is piped, never passed as an argument (it has no size limit)
all=$(printf '%s\n%s\n%s\n' "$conv" "$inline" "$reviews" | sed '/^$/d' \
    | jq -cs '{step: "pr-feedback", status: "ok", comments: .}' 3>&-) || fail_with assemble "assemble:bad-answer"
step_result "$all"
