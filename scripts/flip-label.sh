#!/usr/bin/env bash
# Change an issue / PR's flow labels and say, from a read-back, whether the target state was reached
# (GitHub#599). Run by the worker / reviewer through the templates' `flip_label`:
#
#   bash flip-label.sh --result-fd 3 --repo <owner/repo> <number> [--add <label>...] [--remove <label>...]
#
# Contract (the templates' hand-over rule depends on each line):
#   - target = every --add label present and every --remove label absent. A label that must stay
#     after the hand-over goes into --add, never "just not removed".
#   - add first; send deletes only after a read-back shows every --add label present. A failed or
#     unconfirmed add sends no delete, so the item keeps its old flow label.
#   - status comes only from the read-back after the deletes:
#       done      read back, target reached                      {labels}
#       not-done  read back, target not reached                  {missing, still_on, labels, deletes_sent, diag}
#       unknown   writes sent, the labels could not be read back {writes, diag}
#       usage     the call itself is malformed, nothing sent     {diag}
#   - a delete answered with 404 counts as done (the label is not there).
# Result protocol (STARTED, one JSON object on fd 3) and retries: scripts/_step.sh.
set -uo pipefail

# shellcheck source=_step.sh
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/_step.sh"

usage_bad=0
step_parse flip-label "$@" || usage_bad=$?
[ "$usage_bad" -ne 2 ] || exit 64   # no fd 3 to report on: the caller sees no STARTED and no request was sent

NUM="" ADDS=() REMOVES=()
mode=""
for a in "${STEP_ARGS[@]+"${STEP_ARGS[@]}"}"; do
    case "$a" in
        --add) mode=add ;;
        --remove) mode=remove ;;
        *)
            if [ -z "$mode" ] && [ -z "$NUM" ]; then NUM="$a"
            elif [ "$mode" = add ]; then ADDS+=("$a")
            elif [ "$mode" = remove ]; then REMOVES+=("$a")
            else usage_bad=1; fi ;;
    esac
done
case "$NUM" in ''|*[!0-9]*) usage_bad=1 ;; esac
[ $(( ${#ADDS[@]} + ${#REMOVES[@]} )) -gt 0 ] || usage_bad=1
for l in "${ADDS[@]+"${ADDS[@]}"}" "${REMOVES[@]+"${REMOVES[@]}"}"; do
    [ -n "$l" ] || usage_bad=1
done
for l in "${ADDS[@]+"${ADDS[@]}"}"; do
    for r in "${REMOVES[@]+"${REMOVES[@]}"}"; do [ "$l" != "$r" ] || usage_bad=1; done
done

step_start

if [ "$usage_bad" -ne 0 ]; then
    step_result '{"step":"flip-label","status":"usage","diag":"usage:bad-arguments"}'
    exit 0
fi

json_list() { printf '%s\n' "$@" | jq -R . 3>&- | jq -cs . 3>&-; }
ADD_JSON=$( [ ${#ADDS[@]} -eq 0 ] && echo '[]' || json_list "${ADDS[@]}")
REMOVE_JSON=$( [ ${#REMOVES[@]} -eq 0 ] && echo '[]' || json_list "${REMOVES[@]}")
WRITES='[]'
LAST_DIAG=""

note_write() {   # note_write <label> <add|remove> <ok|failed>
    WRITES=$(printf '%s' "$WRITES" | jq -c --arg l "$1" --arg a "$2" --arg r "$3" \
        '. + [{label: $l, action: $a, result: $r}]' 3>&-)
}

# read_labels: sets LABELS (JSON array of names); returns non-zero when the labels cannot be read
read_labels() {
    step_gh read-labels api "repos/$STEP_REPO/issues/$NUM" --jq '[.labels[].name]' || { LAST_DIAG="$STEP_DIAG"; return 1; }
    LABELS=$(printf '%s' "$STEP_OUT" | jq -c 'if type == "array" and all(type == "string") then . else error("bad") end' 3>&-) \
        || { LAST_DIAG="read-labels:bad-answer"; return 1; }
}

missing_of() { jq -nc --argjson want "$ADD_JSON" --argjson have "$LABELS" '$want - $have'; }
still_on_of() { jq -nc --argjson drop "$REMOVE_JSON" --argjson have "$LABELS" '[$drop[] | select(. as $x | $have | index($x))]'; }

finish_unknown() {
    step_result "$(jq -nc --argjson w "$WRITES" --arg d "${LAST_DIAG:-read-labels:unknown}" \
        '{step: "flip-label", status: "unknown", writes: $w, diag: $d}')"
    exit 0
}

finish_from_labels() {   # finish_from_labels <deletes_sent true|false>
    local missing still
    missing=$(missing_of 3>&-) || finish_unknown
    still=$(still_on_of 3>&-) || finish_unknown
    if [ "$missing" = '[]' ] && [ "$still" = '[]' ]; then
        step_result "$(jq -nc --argjson l "$LABELS" '{step: "flip-label", status: "done", labels: $l}')"
    else
        step_result "$(jq -nc --argjson m "$missing" --argjson s "$still" --argjson l "$LABELS" \
            --argjson sent "$1" --arg d "${LAST_DIAG:-readback:target-not-reached}" \
            '{step: "flip-label", status: "not-done", missing: $m, still_on: $s, labels: $l, deletes_sent: $sent, diag: $d}')"
    fi
    exit 0
}

# 1. add, then confirm the adds by reading back
if [ ${#ADDS[@]} -gt 0 ]; then
    args=()
    for l in "${ADDS[@]}"; do args+=(-f "labels[]=$l"); done
    if step_gh add-labels api -X POST "repos/$STEP_REPO/issues/$NUM/labels" "${args[@]}"; then
        for l in "${ADDS[@]}"; do note_write "$l" add ok; done
    else
        LAST_DIAG="$STEP_DIAG"
        for l in "${ADDS[@]}"; do note_write "$l" add failed; done
    fi
    saved_diag="$LAST_DIAG"
    read_labels || finish_unknown
    LAST_DIAG="$saved_diag"
    # an add not seen on the item: no delete is sent
    [ "$(missing_of 3>&-)" = '[]' ] || finish_from_labels false
fi

# 2. deletes (404 = already gone)
sent=false
for l in "${REMOVES[@]+"${REMOVES[@]}"}"; do
    sent=true
    enc=$(printf '%s' "$l" | jq -sRr @uri 3>&-)
    if step_gh remove-label api -X DELETE "repos/$STEP_REPO/issues/$NUM/labels/$enc"; then
        note_write "$l" remove ok
    else
        case "$STEP_DIAG" in
            *:http-404) note_write "$l" remove ok ;;
            *) note_write "$l" remove failed; LAST_DIAG="$STEP_DIAG" ;;
        esac
    fi
done

# 3. the read-back decides
read_labels || finish_unknown
finish_from_labels "$sent"
