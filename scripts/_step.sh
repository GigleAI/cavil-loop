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

# ── Step scripts the templates run: rules moved from the root AGENTS.md (GitHub#658); read before changing ──
# Step scripts the templates run (GitHub#599: `scripts/flip-label.sh`, `scripts/conflict-check.sh`,
# `scripts/pr-feedback.sh`, their shared `scripts/_step.sh`, the `cavil_step` / `flip_label` block in
# the four base templates, the `${CAVIL_STEP_DIR}` placeholder, `--body` of the footer command) →
# `tests/step-scripts.test.sh` (~5 s; the composed prompts' own `cavil_step` block run under `bash
# -euo pipefail`, the stateful fake GitHub). The result protocol is the whole point: a script writes
# `STARTED` to fd 3 before its first request and one JSON object at the end, nothing else ever reaches
# fd 3 (children run with `3>&-`), the scripts never `exec`; a script whose marker write fails exits
# 65 before any request (`step_start || exit 65`, a lint in the test); `cavil_step` accepts a result
# only through the stable table it carries inline (`tests/fixtures/step-result-stable.jq`: exactly one
# object, `step` = the script it ran, a `status` in the table, every field the table lists for it) and
# treats anything else as "outcome unknown". That file is **never edited**: a template is rendered at
# dispatch and may call the script of a later release, so it is the contract between every template
# and every future script (PR #607 review rounds 2–5: a copy next to the entrypoints, an inline copy
# of the current table, and a check with no fields each left one direction broken — a newer script's
# valid result rejected, or a success missing the data the next step reads accepted). Each script
# checks its own result with `scripts/step-result.jq` from its own release before writing it
# (`step_result`); that table must keep every step, status and field of the stable one and may only
# add — the test checks the superset, the four inline copies, and runs a template rendered against one
# release with the entrypoint already switched to a newer one (`tests/skill-deploy.test.sh`). A new
# status reads as "outcome unknown" in an older template, never as success; no status is ever renamed
# or given another meaning — flip-label's `done` is the one way to say "target reached" in every
# version and prints `EXIT=<code>` plus the result, `RESULT=not-started` (fd 3 empty — the only proof
# nothing was sent; the exit code proves nothing, a script that sent a request can still exit 127) or
# `RESULT=none` (did not finish, outcome unknown). Label hand-over contract: add first, delete only
# after a read-back shows every add, `done` only from the final read-back; a label that must stay goes
# into `--add` (the reviewer's "rounds used up" adds `pending/review` back — the daemon removed it at
# dispatch). When a flip is not `done` the agent writes no further label at all, it only comments (the
# maintainer chose this over a second write path, #599 Q1 = B). Every `flip_label` call in `prompts/`
# is listed in `tests/fixtures/flip-label-calls.txt`; a new or changed call updates that file. Scripts
# the agent runs that need no daemon state go through `entrypoints/` like the footer: add a new one to
# `skill-deploy.sh`, `release-entry.sh`, the all-or-none check in `_lib.sh`, and the table in
# `step-result.jq` together
#

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
