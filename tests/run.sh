#!/usr/bin/env bash
# One entry point for the self-contained tests in tests/ — the same script runs
# locally and in CI (.github/workflows/tests.yml, GitHub#117).
#
#   bash tests/run.sh                    run every tests/*.test.sh
#   bash tests/run.sh NAME...            run only these (NAME = file name without .test.sh,
#                                        or one part of a split file: NAME:K/N)
#   bash tests/run.sh --ci               skip what tests/ci-exclude.txt lists (CI machines
#                                        lack what those need; the reason is in the file)
#   bash tests/run.sh --shard K/N        run only the K-th of N shards (implies nothing
#                                        about --ci; CI passes both)
#   bash tests/run.sh -j N               run up to N units at once (default: half the CPUs,
#                                        at most 8; -j 1 = one after another)
#   bash tests/run.sh --list [--shard K/N] [--ci]
#                                        print "<shard> <unit>" (shard 1 without --shard)
#   bash tests/run.sh --verify DIR --ci  read every results.tsv under DIR (one per shard)
#                                        and pass only if each expected unit passed once
#   --out DIR                            where results.tsv and logs/<unit>.log go
#                                        (default: a fresh temp dir, printed at the end)
#
# MUTATION=1 is passed through untouched: each test file reads it itself.
#
# Units (GitHub#211). A file is one unit, unless its header declares parts:
#     # parts: 3
# Then each part is its own unit, named NAME:K/N, run as TEST_PART=K/N bash NAME.test.sh
# (tests/lib/parts.sh), weighed, sharded and verified on its own: --verify wants every
# part to pass exactly once, so a missing part or an extra one is red. A file whose header says
#     # parallel: no
# never runs next to anything else: its units run one at a time after the parallel ones
# (it touches something machine-wide — a real tmux server, systemd, fixed ports or paths).
#
# Verdicts per unit:
#   pass      exit 0
#   fail      exit != 0
#   timeout   still running after RUN_TEST_TIMEOUT seconds (default 900) — a failure
#   skipped   exit 0 but printed a line starting with "⏭" in column 0 — the file's
#             convention for "skipped the whole file". A failure unless the file is in
#             ci-exclude.txt: a test that silently skips itself would otherwise look
#             green forever after CI loses one of its dependencies. An indented "⏭"
#             is one group inside a file that otherwise ran; it is listed, not judged.
#   excluded  not run (--ci, listed in ci-exclude.txt; all parts of a listed file)
#
# Shards: units sorted by reference time in ci-weights.txt (a file's entry is split evenly
# over its parts unless a part has its own NAME:K/N line; unknown files count as
# DEFAULT_WEIGHT seconds), heaviest first, each into the currently lightest shard
# (ties: lower shard number; equal weights: name order). Every shard job computes the
# same split from the same checkout, so they never overlap or miss a unit — and
# --verify checks exactly that on the collected results.
#
# RUN_TESTS_DIR overrides which directory holds the tests (used by tests/run.test.sh).
set -euo pipefail

TESTS_DIR="${RUN_TESTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REPO_DIR="$(dirname "$TESTS_DIR")"
EXCLUDE_FILE="$TESTS_DIR/ci-exclude.txt"
WEIGHTS_FILE="$TESTS_DIR/ci-weights.txt"
DEFAULT_WEIGHT=5
TIMEOUT_SECS="${RUN_TEST_TIMEOUT:-900}"

die() { echo "run.sh: $*" >&2; exit 2; }

default_jobs() {
    local n
    n=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 2)
    [[ "$n" =~ ^[0-9]+$ ]] || n=2
    n=$((n / 2)); [ "$n" -ge 1 ] || n=1; [ "$n" -le 8 ] || n=8
    echo "$n"
}

CI_MODE=0; LIST=0; SHARD=""; OUT=""; VERIFY=""; NAMES=(); JOBS=""
while [ $# -gt 0 ]; do
    case "$1" in
        --ci) CI_MODE=1 ;;
        --list) LIST=1 ;;
        --shard) [ $# -ge 2 ] || die "--shard needs K/N"; SHARD="$2"; shift ;;
        --shard=*) SHARD="${1#--shard=}" ;;
        --out) [ $# -ge 2 ] || die "--out needs a directory"; OUT="$2"; shift ;;
        --out=*) OUT="${1#--out=}" ;;
        --verify) [ $# -ge 2 ] || die "--verify needs a directory"; VERIFY="$2"; shift ;;
        --verify=*) VERIFY="${1#--verify=}" ;;
        -j|--jobs) [ $# -ge 2 ] || die "$1 needs a number"; JOBS="$2"; shift ;;
        -j*) JOBS="${1#-j}" ;;
        --jobs=*) JOBS="${1#--jobs=}" ;;
        -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        -*) die "unknown option $1" ;;
        *) NAMES+=("${1%.test.sh}") ;;
    esac
    shift
done
[ -n "$JOBS" ] || JOBS=$(default_jobs)
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || die "-j wants a positive number, got [$JOBS]"

SHARD_K=1; SHARD_N=1
if [ -n "$SHARD" ]; then
    [[ "$SHARD" =~ ^([0-9]+)/([0-9]+)$ ]] || die "--shard wants K/N, got [$SHARD]"
    SHARD_K=${BASH_REMATCH[1]}; SHARD_N=${BASH_REMATCH[2]}
    [ "$SHARD_N" -ge 1 ] && [ "$SHARD_K" -ge 1 ] && [ "$SHARD_K" -le "$SHARD_N" ] \
        || die "--shard $SHARD out of range"
    [ ${#NAMES[@]} -eq 0 ] || die "--shard and explicit test names don't mix"
fi

# ── what exists ────────────────────────────────────────────────────────────────
discover() {
    local f
    for f in "$TESTS_DIR"/*.test.sh; do
        [ -e "$f" ] || continue
        f=$(basename "$f"); printf '%s\n' "${f%.test.sh}"
    done | LC_ALL=C sort
}
mapfile -t ALL < <(discover)
[ ${#ALL[@]} -gt 0 ] || die "no *.test.sh in $TESTS_DIR"

# Header declarations. Same pattern as tests/lib/parts.sh reads; anything else means 1 part.
declare -A PARTS=() SERIAL=()
for n in "${ALL[@]}"; do
    p=$(sed -n 's/^# parts: *\([0-9][0-9]*\) *$/\1/p' "$TESTS_DIR/$n.test.sh" | head -1)
    [ -z "$p" ] || [ "$p" -ge 1 ] || die "$n.test.sh: '# parts: $p' must be at least 1"
    PARTS[$n]="${p:-1}"
    grep -qE '^# parallel: no *$' "$TESTS_DIR/$n.test.sh" && SERIAL[$n]=1
done

units_of() {   # <file name> → its units, one per line
    local n="$1" k
    if [ "${PARTS[$n]}" -le 1 ]; then printf '%s\n' "$n"; return; fi
    for k in $(seq 1 "${PARTS[$n]}"); do printf '%s:%s/%s\n' "$n" "$k" "${PARTS[$n]}"; done
}
file_of() { printf '%s' "${1%%:*}"; }

# name<whitespace>reason ; '#' starts a comment line
declare -A EXCLUDED=()
if [ -f "$EXCLUDE_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
        name="${line%%[[:space:]]*}"; reason="${line#"$name"}"
        reason="${reason#"${reason%%[![:space:]]*}"}"
        name="${name%.test.sh}"
        [ -n "$reason" ] || die "ci-exclude.txt: $name has no reason"
        [ -e "$TESTS_DIR/$name.test.sh" ] || die "ci-exclude.txt lists $name, but tests/$name.test.sh does not exist"
        EXCLUDED[$name]="$reason"
    done < "$EXCLUDE_FILE"
fi

declare -A WEIGHT=()
if [ -f "$WEIGHTS_FILE" ]; then
    while read -r name secs _ || [ -n "${name:-}" ]; do
        [[ -z "${name:-}" || "$name" == \#* ]] && continue
        [[ "$secs" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "ci-weights.txt: bad seconds for $name: [$secs]"
        WEIGHT[$name]="$secs"
    done < "$WEIGHTS_FILE"
fi
weight_of() {   # <unit>
    local u="$1" f; f=$(file_of "$1")
    if [ -n "${WEIGHT[$u]+x}" ]; then printf '%s' "${WEIGHT[$u]}"
    elif [ "$u" != "$f" ]; then awk -v w="${WEIGHT[$f]:-$DEFAULT_WEIGHT}" -v n="${PARTS[$f]}" 'BEGIN { printf "%.3f", w / n }'
    else printf '%s' "${WEIGHT[$f]:-$DEFAULT_WEIGHT}"; fi
}

# The set a run is about: every unit, minus the exclusions under --ci.
selected() {
    local n
    for n in "${ALL[@]}"; do
        if [ "$CI_MODE" = 1 ] && [ -n "${EXCLUDED[$n]+x}" ]; then continue; fi
        units_of "$n"
    done
}

# "<shard> <unit>" for every selected unit, in name order.
assign() {
    local u
    for u in $(selected); do printf '%s %s\n' "$(weight_of "$u")" "$u"; done \
        | LC_ALL=C sort -k1,1gr -k2,2 \
        | awk -v N="$SHARD_N" '
            { best = 1
              for (i = 2; i <= N; i++) if (load[i] + 0 < load[best] + 0) best = i
              load[best] += $1; print best, $2 }' \
        | LC_ALL=C sort -k2,2
}

if [ "$LIST" = 1 ]; then
    if [ -n "$SHARD" ]; then assign | awk -v k="$SHARD_K" '$1 == k'; else assign; fi
    exit 0
fi

GHA=0; [ "${GITHUB_ACTIONS:-}" = true ] && GHA=1

# ── --verify: did every expected unit pass exactly once across the shards? ─────
if [ -n "$VERIFY" ]; then
    [ -d "$VERIFY" ] || die "--verify: no directory $VERIFY"
    declare -A SEEN=() STATUS=() SECS=()
    bad=0; problems=()
    while IFS= read -r -d '' rf; do
        while IFS=$'\t' read -r name status secs _; do
            [ -n "$name" ] || continue
            [ "$status" = excluded ] && continue
            SEEN[$name]=$(( ${SEEN[$name]:-0} + 1 ))
            STATUS[$name]="$status"; SECS[$name]="$secs"
        done < "$rf"
    done < <(find "$VERIFY" -name results.tsv -type f -print0)
    declare -A EXPECT=()
    for n in $(selected); do EXPECT[$n]=1; done
    for n in $(selected); do
        c=${SEEN[$n]:-0}
        if [ "$c" -eq 0 ]; then problems+=("$n: no result (no shard ran it)"); bad=1
        elif [ "$c" -gt 1 ]; then problems+=("$n: ran $c times"); bad=1
        elif [ "${STATUS[$n]:-}" != pass ]; then problems+=("$n: ${STATUS[$n]}"); bad=1
        fi
    done
    for n in "${!SEEN[@]}"; do
        [ -n "${EXPECT[$n]+x}" ] || { problems+=("$n: has a result but was not expected"); bad=1; }
    done
    total=0; passed=0
    for n in $(selected); do total=$((total+1)); [ "${STATUS[$n]:-}" = pass ] && [ "${SEEN[$n]:-0}" -eq 1 ] && passed=$((passed+1)); done
    {
        if [ "$bad" = 0 ]; then echo "## ✅ All $passed tests passed"; else echo "## ❌ $((total - passed)) of $total tests did not pass"; fi
        echo
        if [ ${#problems[@]} -gt 0 ]; then
            for p in "${problems[@]}"; do echo "- ❌ $p"; done; echo
        fi
        if [ "$CI_MODE" = 1 ] && [ ${#EXCLUDED[@]} -gt 0 ]; then
            echo "Excluded on CI (tests/ci-exclude.txt):"
            echo
            for n in $(printf '%s\n' "${!EXCLUDED[@]}" | LC_ALL=C sort); do echo "- \`$n\` — ${EXCLUDED[$n]}"; done
        fi
    } > "${TMPDIR:-/tmp}/run-verify.$$.md"
    cat "${TMPDIR:-/tmp}/run-verify.$$.md"
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "${TMPDIR:-/tmp}/run-verify.$$.md" >> "$GITHUB_STEP_SUMMARY"
    rm -f "${TMPDIR:-/tmp}/run-verify.$$.md"
    exit "$bad"
fi

# ── which units this run executes ──────────────────────────────────────────────
if [ ${#NAMES[@]} -gt 0 ]; then
    RUN=()
    for n in "${NAMES[@]}"; do
        f=$(file_of "$n")
        [ -e "$TESTS_DIR/$f.test.sh" ] || die "no test named $f"
        if [ "$n" = "$f" ]; then mapfile -t -O "${#RUN[@]}" RUN < <(units_of "$f")
        else
            units_of "$f" | grep -qxF -- "$n" || die "$f has no part ${n#*:} (it declares ${PARTS[$f]} part(s))"
            RUN+=("$n")
        fi
    done
else
    mapfile -t RUN < <(assign | awk -v k="$SHARD_K" '$1 == k { print $2 }')
fi
# Each unit runs at most once per run: results, logs and the "finished" marker are keyed by the unit
# name, so a second copy (a name given twice, or a file plus one of its parts) would share them and
# one copy's failure could vanish behind the other's pass (PR #221 review round 1).
declare -A ONCE=(); UNIQ=()
for u in "${RUN[@]}"; do
    if [ -n "${ONCE[$u]+x}" ]; then echo "run.sh: $u named more than once; it runs once" >&2; continue; fi
    ONCE[$u]=1; UNIQ+=("$u")
done
RUN=("${UNIQ[@]}")

if [ -z "$OUT" ]; then OUT=$(mktemp -d "${TMPDIR:-/tmp}/cavil-tests.XXXXXX"); fi
mkdir -p "$OUT/logs"
RESULTS="$OUT/results.tsv"; : > "$RESULTS"
RUNSTATE="$OUT/.running"; rm -rf "$RUNSTATE"; mkdir -p "$RUNSTATE"

TIMEOUT_CMD=(); command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD=(timeout "$TIMEOUT_SECS")

failed=0; declare -A ROW=()
note_excluded() {  # $1 name
    printf '%s\texcluded\t0\t%s\n' "$1" "${EXCLUDED[$1]}" >> "$RESULTS"
    ROW[$1]="| \`$1\` | ⏭ excluded | – | ${EXCLUDED[$1]} |"
}
if [ "$CI_MODE" = 1 ] && [ -z "$SHARD" ] && [ ${#NAMES[@]} -eq 0 ]; then
    for n in $(printf '%s\n' "${!EXCLUDED[@]}" | LC_ALL=C sort); do note_excluded "$n"; done
fi

log_of() { printf '%s/logs/%s.log' "$OUT" "$(printf '%s' "$1" | tr ':/' '._')"; }

# Start one unit in the background; it leaves "<rc> <seconds>" in $RUNSTATE/<id>.done.
start_unit() {   # <unit>
    local u="$1" f id part=()
    f=$(file_of "$u"); id=$(printf '%s' "$u" | tr ':/' '._')
    [ "$u" = "$f" ] || part=(TEST_PART="${u#*:}")
    (
        t0=$(date +%s)
        set +e
        (cd "$REPO_DIR" && env -u TEST_PART "${part[@]}" "${TIMEOUT_CMD[@]}" bash "$TESTS_DIR/$f.test.sh") \
            > "$(log_of "$u")" 2>&1 < /dev/null
        rc=$?
        echo "$rc $(( $(date +%s) - t0 ))" > "$RUNSTATE/$id.tmp" && mv "$RUNSTATE/$id.tmp" "$RUNSTATE/$id.done"
    ) &
}

# Judge a finished unit and print its line (and, on failure, its output).
finish_unit() {   # <unit>
    local u="$1" f id rc secs log note groups status mark
    f=$(file_of "$u"); id=$(printf '%s' "$u" | tr ':/' '._')
    read -r rc secs < "$RUNSTATE/$id.done"
    log=$(log_of "$u")
    note=""
    groups=$(grep -cE '^[[:space:]]+⏭' "$log" || true)
    [ "$groups" -gt 0 ] && note="$groups group(s) skipped inside the file"
    if [ "$rc" -eq 124 ] && [ ${#TIMEOUT_CMD[@]} -gt 0 ]; then
        status=timeout; note="no result after ${TIMEOUT_SECS}s"
    elif [ "$rc" -ne 0 ]; then
        status=fail; note="exit $rc"
    elif grep -qE '^⏭' "$log"; then
        if [ -n "${EXCLUDED[$f]+x}" ]; then
            status=skipped-ok; note="skipped itself; excluded on CI: ${EXCLUDED[$f]}"
        else
            status=skipped; note="skipped the whole file: $(grep -m1 -E '^⏭' "$log")"
        fi
    else
        status=pass
    fi
    printf '%s\t%s\t%s\t%s\n' "$u" "$status" "$secs" "$note" >> "$RESULTS"
    case "$status" in pass|skipped-ok) mark="✅" ;; *) mark="❌"; failed=$((failed+1)) ;; esac
    ROW[$u]="| \`$u\` | $mark $status | ${secs}s | $note |"

    if [ "$GHA" = 1 ]; then
        echo "::group::$mark $u ($status, ${secs}s)"; cat "$log"; echo "::endgroup::"
        if [ "$mark" = "❌" ]; then
            echo "::error title=$u $status::tests/$f.test.sh${u#"$f"}: $status${note:+ — $note}"
            echo "──── full output of $u ────"; cat "$log"; echo "──── end of $u ────"
        fi
    else
        printf '%s %-34s %-10s %4ss %s\n' "$mark" "$u" "$status" "$secs" "$note"
        if [ "$mark" = "❌" ]; then echo "──── last 40 lines of $log ────"; tail -n 40 "$log"; echo "────"; fi
    fi
}

# Run a list of units, at most $1 at a time; results are judged as each one ends.
run_pool() {   # <jobs> <unit>...
    local max="$1" u id; shift
    local -a queue=("$@") running=()
    while [ ${#queue[@]} -gt 0 ] || [ ${#running[@]} -gt 0 ]; do
        while [ ${#queue[@]} -gt 0 ] && [ ${#running[@]} -lt "$max" ]; do
            start_unit "${queue[0]}"; running+=("${queue[0]}"); queue=("${queue[@]:1}")
        done
        local wrc=0 progressed=0
        wait -n 2>/dev/null || wrc=$?
        local -a still=()
        for u in "${running[@]}"; do
            id=$(printf '%s' "$u" | tr ':/' '._')
            if [ -e "$RUNSTATE/$id.done" ]; then finish_unit "$u"; progressed=1; else still+=("$u"); fi
        done
        running=("${still[@]}")
        # No child left to wait for, yet a unit never reported: its runner died. Say so, never hang.
        if [ "$wrc" = 127 ] && [ "$progressed" = 0 ] && [ ${#running[@]} -gt 0 ]; then
            for u in "${running[@]}"; do
                id=$(printf '%s' "$u" | tr ':/' '._'); echo "125 0" > "$RUNSTATE/$id.done"; finish_unit "$u"
            done
            running=()
        fi
    done
}

PAR=(); SER=()
for u in "${RUN[@]}"; do
    f=$(file_of "$u")
    if [ "$CI_MODE" = 1 ] && [ -n "${EXCLUDED[$f]+x}" ]; then note_excluded "$f"; continue; fi
    if [ -n "${SERIAL[$f]+x}" ]; then SER+=("$u"); else PAR+=("$u"); fi
done

echo "Running ${#RUN[@]} unit(s)${SHARD:+ (shard $SHARD)}, up to $JOBS at a time${MUTATION:+, with MUTATION=$MUTATION}; logs in $OUT/logs"
[ ${#PAR[@]} -eq 0 ] || run_pool "$JOBS" "${PAR[@]}"
# Files marked "# parallel: no" run alone, after everything else has finished.
[ ${#SER[@]} -eq 0 ] || run_pool 1 "${SER[@]}"
wait || true
rm -rf "$RUNSTATE"

ran=$(( ${#PAR[@]} + ${#SER[@]} ))
{
    echo "### ${SHARD:+Shard $SHARD: }$(( ran - failed )) / $ran passed${MUTATION:+ (MUTATION=$MUTATION)}"
    echo
    echo "| test | result | time | note |"
    echo "|---|---|---|---|"
    for k in $(printf '%s\n' "${!ROW[@]}" | LC_ALL=C sort); do echo "${ROW[$k]}"; done
} > "$OUT/summary.md"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$OUT/summary.md" >> "$GITHUB_STEP_SUMMARY"

echo
echo "Results: $RESULTS"
if [ "$failed" -gt 0 ]; then echo "❌ $failed of $ran failed"; exit 1; fi
echo "✅ all $ran passed"
