# shellcheck shell=bash
# Shared helpers for the worker-side step scripts (GitHub#599): flip-label.sh, conflict-check.sh,
# pr-feedback.sh. A template runs them through `cavil_step` (defined in each base template):
#
#   out=$(bash <script> --result-fd 3 --repo <owner/repo> <args> 3>&1 >/dev/null 2>&1)
#
# The contract the caller relies on, and the reason for every rule below:
#   - fd 3 carries exactly two things: the line `STARTED`, written before the first request
#     (step_start), and one single-line JSON object, written once at the very end (step_result).
#     An empty fd 3 is the only proof that no request was sent; anything else without a whole
#     result means "did not finish, outcome unknown".
#   - Nothing else ever reaches fd 3: every child (gh, git, jq) runs with fd 3 closed.
#   - The scripts never `exec` another program (tests/step-scripts.test.sh checks the text):
#     an exec after STARTED would still leave fd 3 non-empty, but the rule is kept simple.
#   - stdout / stderr go to /dev/null at the caller; diagnostics the agent may post are only the
#     fixed words and numbers in `stage` / `diag`. A best-effort local log keeps the raw text.
#   - Retries happen here, never in the agent.

STEP_FD=""
STEP_REPO=""
STEP_ARGS=()
STEP_LOG=""
STEP_RETRIES="${CAVIL_STEP_RETRIES:-3}"
STEP_SLEEP="${CAVIL_STEP_RETRY_SLEEP:-2}"
case "$STEP_RETRIES" in ''|*[!0-9]*|0) STEP_RETRIES=3 ;; esac
case "$STEP_SLEEP" in ''|*[!0-9]*) STEP_SLEEP=2 ;; esac

# step_parse <name> "$@": takes --result-fd 3 and --repo <owner/repo>; the rest lands in STEP_ARGS.
# Returns 1 on a malformed call (the script then reports status=usage after step_start).
step_parse() {
    STEP_NAME="$1"; shift
    STEP_ARGS=()
    local bad=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --result-fd) STEP_FD="${2:-}"; shift 2 || { bad=1; break; } ;;
            --repo) STEP_REPO="${2:-}"; shift 2 || { bad=1; break; } ;;
            *) STEP_ARGS+=("$1"); shift ;;
        esac
    done
    # only fd 3: children close it with a literal `3>&-` (works on the bash 3.2 macOS ships)
    [ "$STEP_FD" = 3 ] || return 2
    printf '%s' "$STEP_REPO" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' || bad=1
    step_log_open
    return "$bad"
}

step_log_open() {
    local dir="${XDG_STATE_HOME:-$HOME/.local/state}/cavil-loop/step-logs"
    mkdir -p "$dir" 2>/dev/null || return 0
    STEP_LOG="$dir/${STEP_NAME}-$(date +%Y%m%d-%H%M%S 2>/dev/null)-$$.log"
    : >"$STEP_LOG" 2>/dev/null || STEP_LOG=""
}

step_log() {
    [ -n "$STEP_LOG" ] || return 0
    printf '%s\n' "$*" >>"$STEP_LOG" 2>/dev/null || STEP_LOG=""
    return 0
}

# The first write to fd 3. Every script calls it before its first request and exits when it fails
# (`step_start || exit 65`): a request sent after a failed marker would be reported as "not started".
step_start() { printf 'STARTED\n' >&3 2>/dev/null; }

# step_result <json>: the one and only result, compacted to a single line; the log path is added.
# Called once, as the script's last action.
# Before writing, the result is checked with step-result.jq from this script's own release (its
# statuses and the fields each promises). A result that fails it is not written at all (the caller then
# sees "did not finish"). The caller's own check is a fixed minimal one in the templates — see the
# header of step-result.jq for why it is not this table.
step_result() {
    local line rule
    rule="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/step-result.jq"
    line=$(printf '%s' "$1" | jq -c --arg log "$STEP_LOG" '. + {log: $log}' 3>&-) || return 1
    if ! printf '%s' "$line" | jq -se --arg s "$STEP_NAME" -f "$rule" >/dev/null 2>&1 3>&-; then
        step_log "result failed its own check ($rule), not written"
        return 1
    fi
    printf '%s\n' "$line" >&3
}

# step_diag <stage> <stderr text> <exit code>: a fixed-word diagnostic built from numbers only —
# never from what GitHub or git printed (that text can carry an outside account's words).
step_diag() {
    local code
    code=$(printf '%s' "$2" | grep -Eo 'HTTP [0-9]{3}' 3>&- | head -n1 | tr -dc '0-9')
    if [ -n "$code" ]; then printf '%s:http-%s' "$1" "$code"
    else printf '%s:exit-%s' "$1" "$3"; fi
}

# step_gh <stage> <gh args...>: runs gh up to STEP_RETRIES times, stopping at the first success.
# Sets STEP_OUT (stdout of the last attempt), STEP_RC and STEP_DIAG. stderr goes to a temp file only
# to read the HTTP status from it; when no temp file can be made (TMPDIR gone) the exit code is used,
# so the scripts keep working without a writable directory.
step_gh() {
    local stage="$1"; shift
    local n=0 errf err
    STEP_DIAG=""
    while :; do
        n=$((n + 1))
        errf=$(mktemp 2>/dev/null) || errf=""
        STEP_RC=0
        STEP_OUT=$(gh "$@" 2>"${errf:-/dev/null}" 3>&-) || STEP_RC=$?
        err=""
        [ -z "$errf" ] || { err=$(cat "$errf" 2>/dev/null 3>&-); rm -f "$errf"; }
        if [ "$STEP_RC" -eq 0 ]; then STEP_DIAG=""; return 0; fi
        STEP_DIAG=$(step_diag "$stage" "$err" "$STEP_RC")
        step_log "$stage attempt $n rc=$STEP_RC: $err"
        # 404 on a label delete is final (the label is not there): no point retrying
        case "$STEP_DIAG" in *:http-404) return "$STEP_RC" ;; esac
        [ "$n" -lt "$STEP_RETRIES" ] || return "$STEP_RC"
        sleep "$STEP_SLEEP"
    done
}

# step_git <stage> <git args...>: same as step_gh for git, one retry less meaningful but uniform.
step_git() {
    local stage="$1"; shift
    local n=0 tries="${STEP_GIT_TRIES:-2}"
    STEP_DIAG=""
    while :; do
        n=$((n + 1))
        STEP_RC=0
        STEP_OUT=$(git "$@" 2>/dev/null 3>&-) || STEP_RC=$?
        if [ "$STEP_RC" -eq 0 ]; then STEP_DIAG=""; return 0; fi
        STEP_DIAG="$stage:git-exit-$STEP_RC"
        step_log "$stage attempt $n: git $* -> $STEP_RC"
        [ "$n" -lt "$tries" ] || return "$STEP_RC"
        sleep "$STEP_SLEEP"
    done
}
