#!/usr/bin/env bash
# One entry point for the self-contained tests in tests/ — the same script runs
# locally and in CI (.github/workflows/tests.yml, GitHub#117).
#
#   bash tests/run.sh                    run every tests/*.test.sh, in order
#   bash tests/run.sh NAME...            run only these (NAME = file name without .test.sh)
#   bash tests/run.sh --ci               skip what tests/ci-exclude.txt lists (CI machines
#                                        lack what those need; the reason is in the file)
#   bash tests/run.sh --shard K/N        run only the K-th of N shards (implies nothing
#                                        about --ci; CI passes both)
#   bash tests/run.sh --list [--shard K/N] [--ci]
#                                        print "<shard> <name>" (shard 1 without --shard)
#   bash tests/run.sh --verify DIR --ci  read every results.tsv under DIR (one per shard)
#                                        and pass only if each expected test passed once
#   --out DIR                            where results.tsv and logs/<name>.log go
#                                        (default: a fresh temp dir, printed at the end)
#
# MUTATION=1 is passed through untouched: each test file reads it itself.
#
# Verdicts per file:
#   pass      exit 0
#   fail      exit != 0
#   timeout   still running after RUN_TEST_TIMEOUT seconds (default 900) — a failure
#   skipped   exit 0 but printed a line starting with "⏭" in column 0 — the file's
#             convention for "skipped the whole file". A failure unless the file is in
#             ci-exclude.txt: a test that silently skips itself would otherwise look
#             green forever after CI loses one of its dependencies. An indented "⏭"
#             is one group inside a file that otherwise ran; it is listed, not judged.
#   excluded  not run (--ci, listed in ci-exclude.txt)
#
# Shards: files sorted by reference time in ci-weights.txt (unknown files count as
# DEFAULT_WEIGHT seconds), heaviest first, each into the currently lightest shard
# (ties: lower shard number; equal weights: name order). Every shard job computes the
# same split from the same checkout, so they never overlap or miss a file — and
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

CI_MODE=0; LIST=0; SHARD=""; OUT=""; VERIFY=""; NAMES=()
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
        -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        -*) die "unknown option $1" ;;
        *) NAMES+=("${1%.test.sh}") ;;
    esac
    shift
done

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

# The set a run is about: everything, minus the exclusions under --ci.
selected() {
    local n
    for n in "${ALL[@]}"; do
        if [ "$CI_MODE" = 1 ] && [ -n "${EXCLUDED[$n]+x}" ]; then continue; fi
        printf '%s\n' "$n"
    done
}

# "<shard> <name>" for every selected file, in name order.
assign() {
    local n
    for n in $(selected); do printf '%s %s\n' "${WEIGHT[$n]:-$DEFAULT_WEIGHT}" "$n"; done \
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

# ── --verify: did every expected test pass exactly once across the shards? ─────
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

# ── which files this run executes ──────────────────────────────────────────────
if [ ${#NAMES[@]} -gt 0 ]; then
    for n in "${NAMES[@]}"; do [ -e "$TESTS_DIR/$n.test.sh" ] || die "no test named $n"; done
    RUN=("${NAMES[@]}")
else
    mapfile -t RUN < <(assign | awk -v k="$SHARD_K" '$1 == k { print $2 }')
fi

if [ -z "$OUT" ]; then OUT=$(mktemp -d "${TMPDIR:-/tmp}/cavil-tests.XXXXXX"); fi
mkdir -p "$OUT/logs"
RESULTS="$OUT/results.tsv"; : > "$RESULTS"

TIMEOUT_CMD=(); command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD=(timeout "$TIMEOUT_SECS")

failed=0; rows=()
note_excluded() {  # $1 name
    printf '%s\texcluded\t0\t%s\n' "$1" "${EXCLUDED[$1]}" >> "$RESULTS"
    rows+=("| \`$1\` | ⏭ excluded | – | ${EXCLUDED[$1]} |")
}
if [ "$CI_MODE" = 1 ] && [ -z "$SHARD" ] && [ ${#NAMES[@]} -eq 0 ]; then
    for n in $(printf '%s\n' "${!EXCLUDED[@]}" | LC_ALL=C sort); do note_excluded "$n"; done
fi

echo "Running ${#RUN[@]} test file(s)${SHARD:+ (shard $SHARD)}${MUTATION:+ with MUTATION=$MUTATION}; logs in $OUT/logs"
for n in "${RUN[@]}"; do
    if [ "$CI_MODE" = 1 ] && [ -n "${EXCLUDED[$n]+x}" ]; then note_excluded "$n"; continue; fi
    log="$OUT/logs/$n.log"
    t0=$(date +%s)
    set +e
    (cd "$REPO_DIR" && "${TIMEOUT_CMD[@]}" bash "$TESTS_DIR/$n.test.sh") > "$log" 2>&1 < /dev/null
    rc=$?
    set -e
    secs=$(( $(date +%s) - t0 ))
    note=""
    groups=$(grep -cE '^[[:space:]]+⏭' "$log" || true)
    [ "$groups" -gt 0 ] && note="$groups group(s) skipped inside the file"
    if [ "$rc" -eq 124 ] && [ ${#TIMEOUT_CMD[@]} -gt 0 ]; then
        status=timeout; note="no result after ${TIMEOUT_SECS}s"
    elif [ "$rc" -ne 0 ]; then
        status=fail; note="exit $rc"
    elif grep -qE '^⏭' "$log"; then
        if [ -n "${EXCLUDED[$n]+x}" ]; then
            status=skipped-ok; note="skipped itself; excluded on CI: ${EXCLUDED[$n]}"
        else
            status=skipped; note="skipped the whole file: $(grep -m1 -E '^⏭' "$log")"
        fi
    else
        status=pass
    fi
    printf '%s\t%s\t%s\t%s\n' "$n" "$status" "$secs" "$note" >> "$RESULTS"
    case "$status" in pass|skipped-ok) mark="✅" ;; *) mark="❌"; failed=$((failed+1)) ;; esac
    rows+=("| \`$n\` | $mark $status | ${secs}s | $note |")

    if [ "$GHA" = 1 ]; then
        echo "::group::$mark $n ($status, ${secs}s)"; cat "$log"; echo "::endgroup::"
        if [ "$mark" = "❌" ]; then
            echo "::error title=$n $status::tests/$n.test.sh: $status${note:+ — $note}"
            echo "──── full output of $n ────"; cat "$log"; echo "──── end of $n ────"
        fi
    else
        printf '%s %-34s %-10s %4ss %s\n' "$mark" "$n" "$status" "$secs" "$note"
        if [ "$mark" = "❌" ]; then echo "──── last 40 lines of $log ────"; tail -n 40 "$log"; echo "────"; fi
    fi
done

{
    echo "### ${SHARD:+Shard $SHARD: }$(( ${#RUN[@]} - failed )) / ${#RUN[@]} passed${MUTATION:+ (MUTATION=$MUTATION)}"
    echo
    echo "| test | result | time | note |"
    echo "|---|---|---|---|"
    for r in "${rows[@]}"; do echo "$r"; done
} > "$OUT/summary.md"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$OUT/summary.md" >> "$GITHUB_STEP_SUMMARY"

echo
echo "Results: $RESULTS"
if [ "$failed" -gt 0 ]; then echo "❌ $failed of ${#RUN[@]} failed"; exit 1; fi
echo "✅ all ${#RUN[@]} passed"
