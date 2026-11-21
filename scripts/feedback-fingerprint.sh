#!/usr/bin/env bash
# The answer record for question-only rounds (GitHub#614). Read-only: reads GitHub with the polling
# identity, writes nothing anywhere but stdout (and --out).
#
#   bash feedback-fingerprint.sh --config <project config> snapshot <issue/PR number>
#   bash feedback-fingerprint.sh --config <project config> compare  <issue/PR number> --record <file>
#
# snapshot  first line: the record `<!-- agent-answer-only v=2 … -->` itself, which the worker saves to a
#           file and pastes into its answer verbatim. After it, from the same read: the item (state,
#           labels, PR head / base), its description, the human feedback (maintainers and the requester
#           bot) with times, the loop account's comments with role and time, the step the record binds
#           in full, and the latest answer / wait record.
# compare   the same read again, checked against the record in <file> (the answer comment's text):
#           `verdict resume | new-feedback | need-continue`, `reason …`, then the changed items or the
#           step to continue in full, as read this time.
# Rules (what counts, which record format) live in feedback_fingerprint.py, the only place.
#
# Exit codes: 0 = answered (stdout); 2 = usage / config; 3 = could not read everything — the first
# line is `unreadable <reason>` and nothing else is printed (never a partial result).
set -euo pipefail

usage() { echo "用法: feedback-fingerprint.sh --config <项目配置> snapshot|compare <编号> [--record <文件>]" >&2; exit 2; }

CFG="" MODE="" NUM="" REC=""
while [ $# -gt 0 ]; do
    case "$1" in
        --config) [ $# -ge 2 ] || usage; CFG="$2"; shift 2 ;;
        --record) [ $# -ge 2 ] || usage; REC="$2"; shift 2 ;;
        snapshot|compare) [ -z "$MODE" ] && [ $# -ge 2 ] || usage; MODE="$1"; NUM="$2"; shift 2 ;;
        *) usage ;;
    esac
done
[[ "$NUM" =~ ^[0-9]+$ ]] || usage
case "$MODE" in snapshot) [ -z "$REC" ] || usage ;; compare) [ -n "$REC" ] || usage ;; *) usage ;; esac
[ -z "$CFG" ] || export CODING_AGENT_CONFIG="$CFG"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
unreadable() { echo "unreadable $1"; exit 3; }

# each read: every page, one compact record per line (the filter runs per page)
gh api "repos/$REPO/issues/$NUM" \
    --jq '{body: (.body // ""), pr: (.pull_request != null), state, labels: [.labels[]?.name]}' \
    > "$TMP/issue" 2>/dev/null || unreadable read-item
jq -e 'type == "object" and (.body | type) == "string" and (.state | type) == "string" and (.state | length) > 0
       and (.labels | type) == "array" and all(.labels[]; type == "string" and length > 0)' \
    "$TMP/issue" >/dev/null 2>&1 || unreadable read-item
IS_PR=$(jq -r '.pr' "$TMP/issue")
echo '{}' > "$TMP/pr"
if [ "$IS_PR" = true ]; then
    gh api "repos/$REPO/pulls/$NUM" --jq '{head: .head.sha, base: .base.ref}' > "$TMP/pr" 2>/dev/null || unreadable read-pr
    jq -e '(.head | type) == "string" and (.head | length) > 0 and (.base | type) == "string" and (.base | length) > 0' \
        "$TMP/pr" >/dev/null 2>&1 || unreadable read-pr
fi
# the item's own labels minus the flow labels (the daemon flips those at every dispatch)
ci_report_flow_labels | jq -Rn '[inputs]' > "$TMP/flow" || unreadable flow-labels
jq -s '.[0] as $i | .[1] as $p | .[2] as $f
       | {body: $i.body, item: ({state: $i.state, labels: ($i.labels - $f | sort)} + $p)}' \
    "$TMP/issue" "$TMP/pr" "$TMP/flow" > "$TMP/item" || unreadable assemble

gh api --paginate "repos/$REPO/issues/$NUM/comments" \
    --jq '.[] | {src: "conversation", id, login: .user.login, type: .user.type, body, created: .created_at, updated: .updated_at}' \
    > "$TMP/items" 2>/dev/null || unreadable read-conversation
if [ "$IS_PR" = true ]; then
    gh api --paginate "repos/$REPO/pulls/$NUM/comments" \
        --jq '.[] | {src: "inline", id, login: .user.login, type: .user.type, body, created: .created_at, updated: .updated_at}' \
        >> "$TMP/items" 2>/dev/null || unreadable read-inline
    gh api --paginate "repos/$REPO/pulls/$NUM/reviews" \
        --jq '.[] | select(.state != "PENDING") | {src: "review", id, login: .user.login, type: .user.type, state, body, created: .submitted_at}' \
        >> "$TMP/items" 2>/dev/null || unreadable read-reviews
fi
# every record must be whole: a number id, an author with login and type, a text body (a review with
# no text has ""), a time (a draft review — PENDING, seen only by its author — is not feedback and is
# left out above). Anything missing is "cannot read" — never filtered out as an outside account
jq -se 'all(.[]; (.id | type) == "number" and (.login | type) == "string" and (.login | length) > 0
               and (.type | type) == "string" and (.type | length) > 0
               and ((.body // "") | type) == "string" and (.created | type) == "string")' \
    "$TMP/items" >/dev/null 2>&1 || unreadable incomplete-record

# who wrote what: the same judgement the outside-content guard uses (outsider_role → repo_maintainer_check).
# Outside accounts are dropped here, before anything is printed or fingerprinted; a role that cannot be
# told is "unreadable", never a guess
: > "$TMP/roles"
while IFS=$'\t' read -r login type; do
    outsider_role "$login" "$type" || unreadable "author-role:$(printf '%s' "$login" | tr -cd 'A-Za-z0-9._-')"
    case "$OS_ROLE" in loop|bot|maintainer|outsider) ;; *) unreadable "author-role:$(printf '%s' "$login" | tr -cd 'A-Za-z0-9._-')" ;; esac
    printf '%s\t%s\n' "$login" "$OS_ROLE" >> "$TMP/roles"
done < <(jq -r '[.login, .type] | @tsv' "$TMP/items" | sort -u)

jq -Rn '[inputs | split("\t") | {(.[0]): .[1]}] | add // {}' < "$TMP/roles" > "$TMP/rolemap" || unreadable roles
# a login with no role here was never classified: unreadable, not "outsider"
jq -se --slurpfile r "$TMP/rolemap" 'all(.[]; $r[0][.login] != null)' "$TMP/items" >/dev/null 2>&1 || unreadable roles
jq -s --slurpfile r "$TMP/rolemap" --slurpfile it "$TMP/item" '
    $it[0] + {items: [ .[] | . + {role: $r[0][.login]} | select(.role != "outsider")
                       | {src, id, role, body: (.body // ""), created} + (if .updated then {updated} else {} end)
                         + (if .state then {state} else {} end) ]}' \
    "$TMP/items" > "$TMP/input" || unreadable assemble

if [ "$MODE" = snapshot ]; then
    python3 "$SCRIPT_DIR/feedback_fingerprint.py" snapshot < "$TMP/input"
else
    [ -r "$REC" ] || unreadable record-file
    python3 "$SCRIPT_DIR/feedback_fingerprint.py" compare "$REC" < "$TMP/input"
fi
