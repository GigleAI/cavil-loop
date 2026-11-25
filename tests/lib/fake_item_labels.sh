# Single-item reads and label writes for the hand-made fake `gh` scripts in tests (GitHub#700).
#
# Since GitHub#700 every dispatch reads the item before it claims it (open? trigger label still there?),
# writes doing/agent + removes the trigger label, and reads it back; a read it cannot parse counts as
# "unknown" and nothing is handed over. A stateless fake `gh` that answers `{}` to everything therefore
# stops every dispatch. A fake sources this file right after its own logging line:
#
#     [ -z "${FAKE_ITEM_LABELS_LIB:-}" ] || . "$FAKE_ITEM_LABELS_LIB" "$@"
#
# and the test exports FAKE_ITEM_LABELS_LIB (this file) and FAKE_ITEM_DIR (a directory of its own).
# Handled here, everything else falls through to the fake's own cases:
#   gh api repos/<owner>/<repo>/issues/<n>                  → {"number", "state", "labels"} from the state below
#   gh api repos/<owner>/<repo>/pulls/<n>                   → open, unmerged PR on main (only asked for items marked as PRs)
#   gh api -X POST   repos/…/issues/<n>/labels -f labels[]=…  → adds
#   gh api -X DELETE repos/…/issues/<n>/labels/<name>         → removes (404 when absent, like GitHub)
# State, one file per item in $FAKE_ITEM_DIR: <n> = one label per line. An item with no file starts with
# the labels in $FAKE_ITEM_LABELS (comma separated, default pending/agent). <n>.pr present = the item is a PR;
# <n>.closed present = closed.
[ -n "${FAKE_ITEM_DIR:-}" ] || return 0
_fil_n=""; _fil_m=GET; _fil_path=""
_fil_a=("$@")
for ((_fil_i = 0; _fil_i < ${#_fil_a[@]}; _fil_i++)); do
    case "${_fil_a[_fil_i]}" in
        -X|--method) _fil_m="${_fil_a[_fil_i+1]}" ;;
        repos/*) [ -n "$_fil_path" ] || _fil_path="${_fil_a[_fil_i]}" ;;
    esac
done
[ "${_fil_a[0]:-}" = api ] && [ -n "$_fil_path" ] || return 0
mkdir -p "$FAKE_ITEM_DIR"
_fil_state() {   # <n>
    [ -e "$FAKE_ITEM_DIR/$1" ] || printf '%s\n' "${FAKE_ITEM_LABELS-pending/agent}" | tr ',' '\n' | sed '/^$/d' > "$FAKE_ITEM_DIR/$1"
}
if [[ "$_fil_path" =~ ^repos/[^/]+/[^/]+/issues/([0-9]+)$ ]] && [ "$_fil_m" = GET ] && [ "$#" = 2 ]; then
    _fil_n="${BASH_REMATCH[1]}"; _fil_state "$_fil_n"
    jq -cR . "$FAKE_ITEM_DIR/$_fil_n" | jq -cs --argjson n "$_fil_n" \
        --arg st "$([ -e "$FAKE_ITEM_DIR/$_fil_n.closed" ] && echo closed || echo open)" \
        --argjson pr "$([ -e "$FAKE_ITEM_DIR/$_fil_n.pr" ] && echo '{"url":"x"}' || echo null)" \
        '{number: $n, state: $st, pull_request: $pr, labels: map({name: .})}'
    exit 0
fi
if [[ "$_fil_path" =~ ^repos/([^/]+/[^/]+)/pulls/([0-9]+)$ ]] && [ "$_fil_m" = GET ] && [ "$#" = 2 ]; then
    jq -cn --arg r "${BASH_REMATCH[1]}" '{merged: false, base: {ref: "main"}, head: {sha: "0000000000000000000000000000000000000001", repo: {full_name: $r}}}'
    exit 0
fi
if [[ "$_fil_path" =~ ^repos/[^/]+/[^/]+/issues/([0-9]+)/labels$ ]] && [ "$_fil_m" = POST ]; then
    _fil_n="${BASH_REMATCH[1]}"; _fil_state "$_fil_n"
    for _fil_x in "$@"; do
        case "$_fil_x" in "labels[]="*)
            grep -qxF -- "${_fil_x#labels[]=}" "$FAKE_ITEM_DIR/$_fil_n" || printf '%s\n' "${_fil_x#labels[]=}" >> "$FAKE_ITEM_DIR/$_fil_n" ;;
        esac
    done
    jq -cR '{name: .}' "$FAKE_ITEM_DIR/$_fil_n" | jq -cs .
    exit 0
fi
if [[ "$_fil_path" =~ ^repos/[^/]+/[^/]+/issues/([0-9]+)/labels/(.+)$ ]] && [ "$_fil_m" = DELETE ]; then
    _fil_n="${BASH_REMATCH[1]}"; _fil_state "$_fil_n"
    _fil_x=$(printf '%s' "${BASH_REMATCH[2]}" | python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.stdin.read()))')
    grep -qxF -- "$_fil_x" "$FAKE_ITEM_DIR/$_fil_n" || { echo "HTTP 404: Label does not exist" >&2; exit 1; }
    grep -vxF -- "$_fil_x" "$FAKE_ITEM_DIR/$_fil_n" > "$FAKE_ITEM_DIR/$_fil_n.tmp"; mv "$FAKE_ITEM_DIR/$_fil_n.tmp" "$FAKE_ITEM_DIR/$_fil_n"
    echo '{}'
    exit 0
fi
return 0
