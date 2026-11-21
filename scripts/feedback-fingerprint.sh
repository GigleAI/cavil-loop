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

# each read: every page, one compact record per line (the filter runs per page). Raw fields are checked
# before anything is derived from them: a missing `labels` must never read as "no labels"
gh api "repos/$REPO/issues/$NUM" \
    --jq '{body: (.body // ""), pr: (.pull_request != null), state, labels}' \
    > "$TMP/issue" 2>/dev/null || unreadable read-item
jq -e 'type == "object" and (.body | type) == "string" and (.state == "open" or .state == "closed")
       and (.labels | type) == "array"
       and all(.labels[]; type == "object" and (.name | type) == "string" and (.name | length) > 0)' \
    "$TMP/issue" >/dev/null 2>&1 || unreadable read-item
jq -c '.labels |= map(.name)' "$TMP/issue" > "$TMP/issue.n" && mv "$TMP/issue.n" "$TMP/issue" || unreadable read-item
IS_PR=$(jq -r '.pr' "$TMP/issue")
echo '{}' > "$TMP/pr"
if [ "$IS_PR" = true ]; then
    gh api "repos/$REPO/pulls/$NUM" --jq '{head: .head.sha, base: .base.ref}' > "$TMP/pr" 2>/dev/null || unreadable read-pr
    jq -e '(.head | type) == "string" and (.head | length) > 0 and (.base | type) == "string" and (.base | length) > 0' \
        "$TMP/pr" >/dev/null 2>&1 || unreadable read-pr
else
    # an issue: its open PRs decide where a question-only answer leaves it (pending/PR vs pending/human),
    # so they are part of the item. The same work-number rule as session naming (pr_work_num_local):
    # branch name first, then the body's Closes / Fixes / Resolves / Refs #N
    gh api --paginate "repos/$REPO/pulls?state=open&per_page=100" \
        --jq '.[] | {number, head: .head.ref, body: (.body // "")}' > "$TMP/pulls" 2>/dev/null || unreadable read-open-prs
    jq -se 'all(.[]; (.number | type) == "number" and (.head | type) == "string" and (.body | type) == "string")' \
        "$TMP/pulls" >/dev/null 2>&1 || unreadable read-open-prs
    : > "$TMP/linked"
    n_pulls=$(jq -s 'length' "$TMP/pulls") || unreadable read-open-prs
    for ((i = 0; i < n_pulls; i++)); do
        pr_n=$(jq -rs --argjson i "$i" '.[$i].number' "$TMP/pulls") || unreadable read-open-prs
        pr_head=$(jq -rs --argjson i "$i" '.[$i].head' "$TMP/pulls") || unreadable read-open-prs
        pr_link=$(jq -rs --argjson i "$i" '.[$i].body' "$TMP/pulls" | pr_body_linked_issue)
        [ "$(pr_work_num_local "$pr_n" "$pr_head" "$pr_link")" != "$NUM" ] || echo "$pr_n" >> "$TMP/linked"
    done
    jq -Rn '{open_prs: ([inputs | tonumber] | sort)}' < "$TMP/linked" > "$TMP/pr" || unreadable read-open-prs
fi
# does this dispatch still hold the item? Checked on its own (the pre-send compare needs it), never part
# of the resume fingerprint — the daemon flips flow labels at every dispatch
HOLDING=$(jq -r --arg d "$LABEL_AGENT_DOING" 'if (.labels | index($d)) != null then "yes" else "no" end' "$TMP/issue") \
    || unreadable read-item
# the item's own labels minus the flow labels (the daemon flips those at every dispatch)
ci_report_flow_labels | jq -Rn '[inputs]' > "$TMP/flow" || unreadable flow-labels
jq -s --arg h "$HOLDING" --arg human "$LABEL_PENDING_HUMAN" --arg prl "$LABEL_PENDING_PR" '.[0] as $i | .[1] as $p | .[2] as $f
       | {body: $i.body, holding: ($h == "yes"), labels_to: {human: $human, pr: $prl}, item: ({state: $i.state, labels: ($i.labels - $f | sort)} + $p)}' \
    "$TMP/issue" "$TMP/pr" "$TMP/flow" > "$TMP/item" || unreadable assemble

gh api --paginate "repos/$REPO/issues/$NUM/comments" \
    --jq '.[] | {src: "conversation", id, node: .node_id, login: .user.login, type: .user.type, body, created: .created_at, updated: .updated_at}' \
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
               and ((.body // "") | type) == "string" and (.created | type) == "string"
               and (.src != "conversation" or ((.node | type) == "string" and (.node | length) > 0
                                               and (.updated | type) == "string")))' \
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

# when did each question's ticks last change, and who changed them: a loop comment's edit history
# (GraphQL userContentEdits, every page, newest first; each version carries its full text). Read only for
# loop comments that carry question ticks and were edited at all; an unreadable history is "cannot read"
EDITS_QUERY='query($id: ID!, $after: String) { node(id: $id) { ... on IssueComment {
  userContentEdits(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { editedAt deletedAt diff editor { login __typename } } } } } }'
echo '{}' > "$TMP/edits"
python3 "$SCRIPT_DIR/feedback_fingerprint.py" tick-ids < "$TMP/input" > "$TMP/tick-ids" || unreadable assemble
while read -r cid; do
    [[ "$cid" =~ ^[0-9]+$ ]] || unreadable assemble
    node=$(jq -r --argjson id "$cid" 'select(.src == "conversation" and .id == $id) | .node' "$TMP/items" | head -1)
    [ -n "$node" ] || unreadable "edit-history:$cid"
    after="" hist='[]'
    while :; do
        args=(api graphql -f query="$EDITS_QUERY" -f id="$node")
        [ -z "$after" ] || args+=(-f after="$after")
        gh "${args[@]}" > "$TMP/page" 2>/dev/null || unreadable "edit-history:$cid"
        jq -e '.data.node.userContentEdits | (.nodes | type) == "array" and (.pageInfo.hasNextPage | type) == "boolean"
               and all(.nodes[]; (.editedAt | type) == "string" and ((.diff | type) == "string" or .diff == null))' \
            "$TMP/page" >/dev/null 2>&1 || unreadable "edit-history:$cid"
        hist=$(printf '%s\n' "$hist" | jq -c --slurpfile p "$TMP/page" '. + [$p[0].data.node.userContentEdits.nodes[]
                 | {at: .editedAt, deleted: (.deletedAt != null), body: .diff, editor: (.editor.login // null),
                    editor_type: (.editor.__typename // null)}]') \
            || unreadable "edit-history:$cid"
        [ "$(jq -r '.data.node.userContentEdits.pageInfo.hasNextPage' "$TMP/page")" = true ] || break
        after=$(jq -r '.data.node.userContentEdits.pageInfo.endCursor // ""' "$TMP/page")
        [ -n "$after" ] || unreadable "edit-history:$cid"
    done
    printf '%s\n' "$hist" | jq -c --slurpfile e "$TMP/edits" --arg id "$cid" '. as $h | $e[0] + {($id): $h}' \
        > "$TMP/edits.n" && mv "$TMP/edits.n" "$TMP/edits" || unreadable assemble
done < "$TMP/tick-ids"
# who made each edit: the same classification as the comment authors (a tick by a maintainer is
# feedback, a rewording by the loop account is not); an editor whose role cannot be told is unreadable
: > "$TMP/eroles"
while IFS=$'\t' read -r login type; do
    [ -n "$login" ] || continue
    outsider_role "$login" "${type:-User}" || unreadable "editor-role:$(printf '%s' "$login" | tr -cd 'A-Za-z0-9._-')"
    case "$OS_ROLE" in loop|bot|maintainer|outsider) ;; *) unreadable "editor-role:$(printf '%s' "$login" | tr -cd 'A-Za-z0-9._-')" ;; esac
    printf '%s\t%s\n' "$login" "$OS_ROLE" >> "$TMP/eroles"
done < <(jq -r '.[][] | select(.editor != null) | [.editor, (.editor_type // "")] | @tsv' "$TMP/edits" | sort -u)
jq -Rn '[inputs | split("\t") | {(.[0]): .[1]}] | add // {}' < "$TMP/eroles" > "$TMP/erolemap" || unreadable roles
jq -c --slurpfile e "$TMP/edits" --slurpfile r "$TMP/erolemap" \
    '. + {edits: ($e[0] | map_values(map(. + {editor_role: (if .editor then $r[0][.editor] else null end)} | del(.editor_type))))}' \
    "$TMP/input" > "$TMP/input.n" && mv "$TMP/input.n" "$TMP/input" || unreadable assemble

if [ "$MODE" = snapshot ]; then
    python3 "$SCRIPT_DIR/feedback_fingerprint.py" snapshot < "$TMP/input"
else
    [ -r "$REC" ] || unreadable record-file
    python3 "$SCRIPT_DIR/feedback_fingerprint.py" compare "$REC" < "$TMP/input"
fi
