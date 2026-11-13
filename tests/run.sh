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
#   bash tests/run.sh --kind unit,guard  run only files of these kinds (see "Kinds" below);
#                                        combines with --ci / --shard / --list / --verify
#   bash tests/run.sh --quick            = --kind smoke,unit,guard,meta (the fast ones)
#   bash tests/run.sh --list [--shard K/N] [--ci]
#                                        print "<shard> <unit>" (shard 1 without --shard)
#   bash tests/run.sh --verify DIR --ci  read every results.tsv under DIR (one per shard)
#                                        and pass only if each expected unit passed once
#   bash tests/run.sh --tally DIR...     add up the count lines of every results.tsv under DIR...
#                                        (no "exactly once" rule; the nightly negative-controls run uses it for
#                                        the autopilot jobs, whose parts run in six jobs)
#   --out DIR                            where results.tsv and logs/<unit>.log go
#                                        (default: a fresh temp dir, printed at the end)
#   --changed-from REF                   run only what this change can affect (GitHub#495; PR runs
#                                        in CI pass it, see "Changed-file selection" below); combines
#                                        with --ci / --shard / --list / --verify / --kind
#
# Changed-file selection (GitHub#495). With --changed-from REF the change is "every file that differs
# between git merge-base REF HEAD and HEAD" — the whole branch, never just its last commit. When every
# such file is a leaf file the run keeps only:
#   · every unit of the kinds guard, smoke and meta;
#   · every file that declares "# reads: repo" (it scans the whole tree, so it cannot name what it reads);
#   · every changed test file that still exists;
#   · every file whose text names a changed leaf file (see leaf_keys).
# Leaf files: anything under docs/; any *.md outside prompts/ and .agents/ (those are dispatch templates);
# tests/<name>.test.sh. One other file in the change — a script, a template, the config example, tests/lib,
# a fixture, a workflow — means the full run. So does anything that cannot be read: no merge-base, a diff
# that fails, an empty diff. The selection is written to selection.txt next to results.tsv, and --verify
# given the same REF recomputes it and requires every shard to have recorded exactly that.
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
# Kinds (GitHub#212). Every file declares exactly one, in its header:
#     # kind: unit | e2e | install | guard | smoke | meta
# (unit regression / end to end through the real poller or dispatch / local install & migration /
# consistency guard / smoke / tests of the test tooling). A file with none, two, or an unknown one
# stops every mode with exit 2 — a new file cannot slip in unclassified.
#
# Count line (GitHub#212). Every file ends by calling report_counts (tests/lib/report.sh), which prints
#     CAVIL_TEST_COUNTS v=1 regress_pass=N|- regress_fail=N|- compat_ran=N compat_skipped=N mut_ran=N mut_skipped=N mut_fail=N|-
# A unit that exits 0 is still a failure when that line is missing ("没汇报计数" — it stopped early
# or never got to the end), printed more than once, malformed, reports failed assertions, or carries
# a negative-control count different from the file's own "负对照：跳过 N 项" / "本次跑了 N 项" line.
# Summaries group by kind, with regression and negative controls in separate columns. Under MUTATION=1
# most files cannot keep the two apart (their negative controls bump the same counters), so they report
# regression as "-": the summaries list those units as "not counted separately", never add them in.
#
# Verdicts per unit:
#   pass      exit 0 and a valid count line
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

KINDS_ALL="unit e2e install guard smoke meta"
QUICK_KINDS="smoke,unit,guard,meta"
kind_label() {
    case "$1" in
        unit) echo "单元回归" ;; e2e) echo "端到端" ;; install) echo "本机安装 / 迁移" ;;
        guard) echo "一致性守卫" ;; smoke) echo "冒烟" ;; meta) echo "测试框架自测" ;; *) echo "?" ;;
    esac
}

default_jobs() {
    local n
    n=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 2)
    [[ "$n" =~ ^[0-9]+$ ]] || n=2
    n=$((n / 2)); [ "$n" -ge 1 ] || n=1; [ "$n" -le 8 ] || n=8
    echo "$n"
}

ORIG_ARGS="$*"
CI_MODE=0; LIST=0; SHARD=""; OUT=""; VERIFY=""; NAMES=(); JOBS=""; KIND_OPT=""; QUICK=0; TALLY=0
CHANGED_FROM=""; CHANGED_SET=0
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
        --kind) [ $# -ge 2 ] || die "--kind needs a list, e.g. unit,guard"; KIND_OPT="$2"; shift ;;
        --kind=*) KIND_OPT="${1#--kind=}" ;;
        --quick) QUICK=1 ;;
        --tally) TALLY=1 ;;
        --changed-from) [ $# -ge 2 ] || die "--changed-from needs a git ref"; CHANGED_FROM="$2"; CHANGED_SET=1; shift ;;
        --changed-from=*) CHANGED_FROM="${1#--changed-from=}"; CHANGED_SET=1 ;;
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

# Which kinds this run is about (empty = all).
if [ "$QUICK" = 1 ]; then
    [ -z "$KIND_OPT" ] || die "--quick and --kind don't mix (--quick is --kind $QUICK_KINDS)"
    KIND_OPT="$QUICK_KINDS"
fi
declare -A WANT_KIND=()
if [ -n "$KIND_OPT" ]; then
    IFS=',' read -r -a _ks <<< "$KIND_OPT"
    for k in "${_ks[@]}"; do
        k="${k// /}"; [ -n "$k" ] || continue
        case " $KINDS_ALL " in *" $k "*) WANT_KIND[$k]=1 ;; *) die "--kind: unknown kind [$k] (kinds: $KINDS_ALL)" ;; esac
    done
    [ ${#WANT_KIND[@]} -gt 0 ] || die "--kind: empty list"
    [ "$TALLY" = 0 ] || die "--tally adds up what is there; --kind / --quick don't apply"
fi

SHARD_K=1; SHARD_N=1
if [ -n "$SHARD" ]; then
    [[ "$SHARD" =~ ^([0-9]+)/([0-9]+)$ ]] || die "--shard wants K/N, got [$SHARD]"
    SHARD_K=${BASH_REMATCH[1]}; SHARD_N=${BASH_REMATCH[2]}
    [ "$SHARD_N" -ge 1 ] && [ "$SHARD_K" -ge 1 ] && [ "$SHARD_K" -le "$SHARD_N" ] \
        || die "--shard $SHARD out of range"
    [ ${#NAMES[@]} -eq 0 ] || die "--shard and explicit test names don't mix"
fi
[ ${#WANT_KIND[@]} -eq 0 ] || [ ${#NAMES[@]} -eq 0 ] || die "--kind / --quick and explicit test names don't mix"
if [ "$CHANGED_SET" = 1 ]; then
    [ -n "$CHANGED_FROM" ] || die "--changed-from needs a git ref"
    [ ${#NAMES[@]} -eq 0 ] || die "--changed-from and explicit test names don't mix"
    [ "$TALLY" = 0 ] || die "--tally adds up what is there; --changed-from doesn't apply"
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
declare -A PARTS=() SERIAL=() KIND=() READS_REPO=()
for n in "${ALL[@]}"; do
    kl=$(grep -cE '^# kind:' "$TESTS_DIR/$n.test.sh" || true)
    [ "$kl" -eq 1 ] || die "$n.test.sh: needs exactly one '# kind: <kind>' header line, found $kl (kinds: $KINDS_ALL)"
    k=$(sed -n 's/^# kind: *\([^ ]*\) *$/\1/p' "$TESTS_DIR/$n.test.sh")
    case " $KINDS_ALL " in *" ${k:-?} "*) ;; *) die "$n.test.sh: unknown kind in '$(grep -E '^# kind:' "$TESTS_DIR/$n.test.sh")' (kinds: $KINDS_ALL)" ;; esac
    KIND[$n]="$k"
    p=$(sed -n 's/^# parts: *\([0-9][0-9]*\) *$/\1/p' "$TESTS_DIR/$n.test.sh" | head -1)
    [ -z "$p" ] || [ "$p" -ge 1 ] || die "$n.test.sh: '# parts: $p' must be at least 1"
    PARTS[$n]="${p:-1}"
    grep -qE '^# parallel: no *$' "$TESTS_DIR/$n.test.sh" && SERIAL[$n]=1
    # "# reads: repo" — scans the whole tree, so a change to any leaf file may matter to it (GitHub#495)
    rl=$(grep -cE '^# reads:' "$TESTS_DIR/$n.test.sh" || true)
    if [ "$rl" -gt 0 ]; then
        grep -qxE '# reads: repo *' "$TESTS_DIR/$n.test.sh" && [ "$rl" -eq 1 ] \
            || die "$n.test.sh: the only '# reads:' header there is is exactly one '# reads: repo' line"
        READS_REPO[$n]=1
    fi
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

# ── changed-file selection (GitHub#495) ───────────────────────────────────────
# CHANGE_MODE: "" (no --changed-from) / full / partial. CHANGE_WHY says why, CHANGE_BASE is the merge-base.
# Every failure to read the change ends in "full": never fewer tests because something could not be read.
CHANGE_MODE=""; CHANGE_WHY=""; CHANGE_BASE=""; CHANGED_FILES=()
declare -A CHANGE_KEEP=()
is_leaf() {   # <repo-relative path> → 0 when a change to it alone does not need the full run
    case "$1" in
        prompts/*|.agents/*) return 1 ;;
        docs/*) return 0 ;;
        tests/*/*) return 1 ;;
        tests/*.test.sh) return 0 ;;
        *.md) return 0 ;;
    esac
    return 1
}
leaf_keys() {   # <path> → the strings whose presence in a test file means it reads that file
    local p="$1" s b
    printf '%s\n' "$p"
    case "$p" in
        *.md)   # docs/operations.zh.md → docs/operations, operations.md, operations.zh.md, operations{
            s="${p%.md}"; s="${s%.zh}"; b="${s##*/}"
            printf '%s\n' "$s" "$b.md" "$b.zh.md" "$b{" ;;
        tests/*.test.sh) printf '%s\n' "${p#tests/}" ;;
    esac
    # deeper than one directory: the directory itself, for a test that reads all of it (docs/images/…)
    case "$p" in */*/*) printf '%s/\n' "${p%/*}" ;; esac
}
change_full() { CHANGE_MODE=full; CHANGE_WHY="$1"; }
compute_change() {
    local top here out p f k
    if ! top=$(git -C "$REPO_DIR" rev-parse --show-toplevel 2>/dev/null) || [ -z "$top" ]; then
        change_full "not a git checkout: $REPO_DIR"; return
    fi
    here=$(cd "$REPO_DIR" && pwd -P); top=$(cd "$top" && pwd -P)
    [ "$here" = "$top" ] || { change_full "$REPO_DIR is not the top of its git checkout"; return; }
    if ! CHANGE_BASE=$(git -C "$REPO_DIR" merge-base "$CHANGED_FROM" HEAD 2>/dev/null) \
        || ! [[ "$CHANGE_BASE" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
        CHANGE_BASE=""; change_full "no merge-base between $CHANGED_FROM and HEAD"; return
    fi
    # --no-renames: a rename lists both names, so the old one is judged too
    out=$(mktemp "${TMPDIR:-/tmp}/run-changed.XXXXXX") || { change_full "no temp file for the diff"; return; }
    if ! git -C "$REPO_DIR" diff --name-only --no-renames -z "$CHANGE_BASE" HEAD > "$out" 2>/dev/null; then
        rm -f "$out"; change_full "git diff $CHANGE_BASE HEAD failed"; return
    fi
    mapfile -d '' -t CHANGED_FILES < "$out"; rm -f "$out"
    [ ${#CHANGED_FILES[@]} -gt 0 ] || { change_full "no file differs from the merge-base"; return; }
    for p in "${CHANGED_FILES[@]}"; do
        is_leaf "$p" || { change_full "$p is not a docs / test-file-only change"; return; }
    done
    CHANGE_MODE=partial; CHANGE_WHY="only docs / test files changed (${#CHANGED_FILES[@]} file(s))"
    local -a keys=()
    for p in "${CHANGED_FILES[@]}"; do
        mapfile -t -O "${#keys[@]}" keys < <(leaf_keys "$p")
        case "$p" in tests/*.test.sh) f="${p#tests/}"; f="${f%.test.sh}"; [ -n "${PARTS[$f]+x}" ] && CHANGE_KEEP[$f]=1 ;; esac
    done
    for f in "${ALL[@]}"; do
        case "${KIND[$f]}" in guard|smoke|meta) CHANGE_KEEP[$f]=1; continue ;; esac
        [ -z "${READS_REPO[$f]+x}" ] || { CHANGE_KEEP[$f]=1; continue; }
        for k in "${keys[@]}"; do
            if grep -qF -- "$k" "$TESTS_DIR/$f.test.sh"; then CHANGE_KEEP[$f]=1; break; fi
        done
    done
}
[ "$CHANGED_SET" = 0 ] || compute_change

# The set a run is about: every unit, minus the exclusions under --ci (and, with --changed-from on a
# docs / test-file-only change, minus what that change cannot reach).
selected() {
    local n
    for n in "${ALL[@]}"; do
        if [ "$CI_MODE" = 1 ] && [ -n "${EXCLUDED[$n]+x}" ]; then continue; fi
        if [ ${#WANT_KIND[@]} -gt 0 ] && [ -z "${WANT_KIND[${KIND[$n]}]+x}" ]; then continue; fi
        if [ "$CHANGE_MODE" = partial ] && [ -z "${CHANGE_KEEP[$n]+x}" ]; then continue; fi
        units_of "$n"
    done
}
# What a shard records and --verify recomputes: the base, the mode and every selected unit.
selection_record() {
    printf 'base %s\nmode %s\n' "${CHANGE_BASE:--}" "$CHANGE_MODE"
    selected | sed 's/^/unit /'
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

# ── counts (GitHub#212) ────────────────────────────────────────────────────────
# results.tsv columns: unit status secs note kind regress_pass regress_fail compat_ran compat_skipped
# mut_ran mut_skipped mut_fail ("-" in every field where a unit has no count line; mut_ran is always a
# number when it has one, so that is the field that tells them apart — regression alone may be "-"). The note can be empty, so the
# file is always split on single tabs (awk -F'\t' / to_us), never with `read`'s whitespace IFS.
NOCOUNTS="-	-	-	-	-	-	-"
to_us() { awk -F'\t' -v OFS=$'\x1f' '{ $1 = $1; print }' "$@"; }

# Parse one log's count line → "rp<TAB>rf<TAB>cr<TAB>cs<TAB>mr<TAB>ms<TAB>mf" on stdout, or a reason
# on stderr with return 1 (0 lines / several / malformed).
COUNT_RE='^CAVIL_TEST_COUNTS v=1 regress_pass=([0-9]+|-) regress_fail=([0-9]+|-) compat_ran=([0-9]+) compat_skipped=([0-9]+) mut_ran=([0-9]+) mut_skipped=([0-9]+) mut_fail=([0-9]+|-)$'
parse_counts() {   # <log>
    local n line
    n=$(grep -c '^CAVIL_TEST_COUNTS' "$1" || true)
    if [ "$n" -eq 0 ]; then echo "没汇报计数 (no CAVIL_TEST_COUNTS line: stopped early, or never reached report_counts)" >&2; return 1; fi
    if [ "$n" -gt 1 ]; then echo "count line printed $n times (report_counts must run once)" >&2; return 1; fi
    line=$(grep '^CAVIL_TEST_COUNTS' "$1")
    if ! [[ "$line" =~ $COUNT_RE ]]; then echo "malformed count line: $line" >&2; return 1; fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" \
        "${BASH_REMATCH[4]}" "${BASH_REMATCH[5]}" "${BASH_REMATCH[6]}" "${BASH_REMATCH[7]}"
}

# Markdown: one row per kind plus a total, then the negative-control section.
# stdin: rows "unit status kind rp rf cr cs mr ms mf", tab-separated.
counts_report() {
    local labels="" k
    for k in $KINDS_ALL; do labels+="$(kind_label "$k")|"; done
    awk -F'\t' -v kinds="$KINDS_ALL" -v labels="$labels" '
        BEGIN { split(labels, L, "|"); nk = split(kinds, K, " "); for (i = 1; i <= nk; i++) LBL[K[i]] = L[i] }
        { k = $3; units[k]++; U++
          if ($8 == "-") { nocount[k]++; NC++ } else {
              if ($4 == "-") { mixed[k]++; MX++ } else { rp[k] += $4; rf[k] += $5; RP += $4; RF += $5 }
              cr[k] += $6; cs[k] += $7; mr[k] += $8; ms[k] += $9
              CR += $6; CS += $7; MR += $8; MS += $9
              if ($10 == "-") MFU++; else MF += $10 }
          if ($2 != "pass" && $2 != "skipped-ok" && $2 != "excluded") bad[++nb] = $1 " (" $2 ")" }
        function row(name, u, a, b, c, d, e, f, n, x,   note) {
            note = (n ? n " 个没有计数" : "")
            if (x) note = note (note ? "；" : "") x " 个负对照模式下不单列回归"
            printf "| %s | %d | %d / %d | %d / %d | %d / %d | %s |\n", name, u, a, b, c, d, e, f, note }
        END {
            print "| 类型 | 单位 | 回归（通过 / 失败） | 其中改动前对拍（跑 / 同版本跳过，组） | 负对照（跑 / 跳过） | 说明 |"
            print "|---|---|---|---|---|---|"
            for (i = 1; i <= nk; i++) { k = K[i]; if (!(k in units)) continue
                row("`" k "` " LBL[k], units[k], rp[k], rf[k], cr[k], cs[k], mr[k], ms[k], nocount[k], mixed[k]) }
            for (k in units) { known = 0; for (i = 1; i <= nk; i++) if (K[i] == k) known = 1
                if (!known) row("`" k "`", units[k], rp[k], rf[k], cr[k], cs[k], mr[k], ms[k], nocount[k], mixed[k]) }
            row("**合计**", U, RP, RF, CR, CS, MR, MS, NC, MX)
            print ""
            printf "**回归 %d 项 / 负对照 %d 项**", RP + RF, MR + MS
            if (MX) printf "（回归只计 %d 个单位：另 %d 个在负对照模式下与负对照共用计数，不单列）", U - NC - MX, MX
            if (MR > 0) {
                printf "（负对照本次跑了 %d 项、跳过 %d 项）\n\n", MR, MS
                printf "负对照：跑了 %d 项；没变红 %d 项", MR, MF
                if (MFU) printf "（另有 %d 个单位不单独统计这一项，看下面的失败单位）", MFU
                print ""
            } else printf "（负对照本次一项没跑：只在每晚负对照运行或 MUTATION=1 时跑）\n"
            if (nb) { print ""; print "没通过的单位："; for (i = 1; i <= nb; i++) print "- ❌ `" bad[i] "`" }
        }'
}

change_note() {   # one line for humans, on stderr in --list (stdout stays "<shard> <unit>")
    [ -z "$CHANGE_MODE" ] || echo "changed-from $CHANGED_FROM: $CHANGE_MODE — $CHANGE_WHY"
}
if [ "$LIST" = 1 ]; then
    change_note >&2
    if [ -n "$SHARD" ]; then assign | awk -v k="$SHARD_K" '$1 == k'; else assign; fi
    exit 0
fi

GHA=0; [ "${GITHUB_ACTIONS:-}" = true ] && GHA=1

# ── --tally: add up the count lines found, nothing else ────────────────────────
if [ "$TALLY" = 1 ]; then
    [ ${#NAMES[@]} -gt 0 ] || die "--tally needs at least one directory"
    rows=$(mktemp "${TMPDIR:-/tmp}/run-tally.XXXXXX")
    for d in "${NAMES[@]}"; do
        [ -d "$d" ] || { echo "run.sh --tally: no directory $d (counted as nothing)" >&2; continue; }
        while IFS= read -r -d '' rf; do
            awk -F'\t' -v OFS='\t' '$1 != "" && $2 != "excluded" {
                k = ($5 == "" ? "?" : $5); print $1, $2, k, ($6 == "" ? "-" : $6), $7, $8, $9, $10, $11, $12 }' "$rf"
        done < <(find "$d" -name results.tsv -type f -print0)
    done > "$rows"
    { echo "## 负对照汇总：$(wc -l < "$rows" | tr -d ' ') 个结果（${NAMES[*]}）"; echo; counts_report < "$rows"; } > "$rows.md"
    cat "$rows.md"
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$rows.md" >> "$GITHUB_STEP_SUMMARY"
    rm -f "$rows" "$rows.md"
    exit 0
fi

# ── --verify: did every expected unit pass exactly once across the shards? ─────
if [ -n "$VERIFY" ]; then
    [ -d "$VERIFY" ] || die "--verify: no directory $VERIFY"
    declare -A SEEN=() STATUS=() SECS=() CNT=()
    bad=0; problems=()
    while IFS= read -r -d '' rf; do
        while IFS=$'\x1f' read -r name status secs _note _kind rp rf_ cr cs mr ms mf _rest; do
            [ -n "$name" ] || continue
            [ "$status" = excluded ] && continue
            SEEN[$name]=$(( ${SEEN[$name]:-0} + 1 ))
            STATUS[$name]="$status"; SECS[$name]="$secs"
            if [[ "${mr:-}" =~ ^[0-9]+$ ]]; then CNT[$name]="$rp	$rf_	$cr	$cs	$mr	$ms	$mf"; else CNT[$name]="$NOCOUNTS"; fi
        done < <(to_us "$rf")
    done < <(find "$VERIFY" -name results.tsv -type f -print0)
    # Selections (GitHub#495): one selection.txt next to every results.tsv, all identical, and equal to
    # what this --verify computes from the same --changed-from. A selection that narrows the set may only
    # count when this --verify was told the base too — otherwise "fewer tests ran" could never be checked.
    nres=0; nsel=0; sel_want=$(selection_record)
    while IFS= read -r -d '' rf; do
        nres=$((nres + 1)); sf="$(dirname "$rf")/selection.txt"
        if [ -f "$sf" ]; then
            nsel=$((nsel + 1))
            if [ "$CHANGED_SET" = 0 ]; then
                problems+=("${sf#"$VERIFY"/}: a shard ran with --changed-from, but --verify was not given it"); bad=1
            elif [ "$(cat "$sf")" != "$sel_want" ]; then
                problems+=("${sf#"$VERIFY"/}: recorded selection differs from the one computed here ($CHANGE_MODE)"); bad=1
            fi
        elif [ "$CHANGED_SET" = 1 ]; then
            problems+=("$(dirname "${rf#"$VERIFY"/}"): no selection.txt (the shard did not run with --changed-from)"); bad=1
        fi
    done < <(find "$VERIFY" -name results.tsv -type f -print0)
    declare -A EXPECT=()
    for n in $(selected); do EXPECT[$n]=1; done
    for n in $(selected); do
        c=${SEEN[$n]:-0}
        if [ "$c" -eq 0 ]; then problems+=("$n: no result (no shard ran it)"); bad=1
        elif [ "$c" -gt 1 ]; then problems+=("$n: ran $c times"); bad=1
        elif [ "${STATUS[$n]:-}" != pass ]; then problems+=("$n: ${STATUS[$n]}"); bad=1
        elif [ "${CNT[$n]}" = "$NOCOUNTS" ]; then problems+=("$n: passed but its result has no counts"); bad=1
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
        if [ -n "$CHANGE_MODE" ]; then
            if [ "$CHANGE_MODE" = partial ]; then echo "Selection: **only what this change can reach** — $CHANGE_WHY. Full run on main, in the release gate and nightly."
            else echo "Selection: full run — $CHANGE_WHY"; fi
            echo
        fi
        if [ ${#problems[@]} -gt 0 ]; then
            for p in "${problems[@]}"; do echo "- ❌ $p"; done; echo
        fi
        for n in $(selected); do
            [ "${SEEN[$n]:-0}" -ge 1 ] || continue
            printf '%s\t%s\t%s\t%s\n' "$n" "${STATUS[$n]}" "${KIND[$(file_of "$n")]}" "${CNT[$n]}"
        done | counts_report
        echo
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
rm -f "$OUT/selection.txt"
[ -z "$CHANGE_MODE" ] || selection_record > "$OUT/selection.txt"
RUNSTATE="$OUT/.running"; rm -rf "$RUNSTATE"; mkdir -p "$RUNSTATE"

TIMEOUT_CMD=(); command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD=(timeout "$TIMEOUT_SECS")

failed=0; declare -A ROW=()
note_excluded() {  # $1 name
    printf '%s\texcluded\t0\t%s\t%s\t%s\n' "$1" "${EXCLUDED[$1]}" "${KIND[$1]}" "$NOCOUNTS" >> "$RESULTS"
    ROW[$1]="| \`$1\` | ⏭ excluded | – | – | ${EXCLUDED[$1]} |"
}
if [ "$CI_MODE" = 1 ] && [ -z "$SHARD" ] && [ ${#NAMES[@]} -eq 0 ]; then
    for n in $(printf '%s\n' "${!EXCLUDED[@]}" | LC_ALL=C sort); do note_excluded "$n"; done
fi

log_of() { printf '%s/logs/%s.log' "$OUT" "$(printf '%s' "$1" | tr ':/' '._')"; }

# A passing unit's count line must agree with itself and with the file's own summary lines.
count_problems() {   # <log> <counts> → prints the problem and returns 1, or returns 0
    local rp rf cr cs mr ms mf said
    IFS=$'\t' read -r rp rf cr cs mr ms mf <<< "$2"
    if [ "$rf" != "-" ] && [ "$rf" -gt 0 ]; then echo "exit 0, but the count line reports $rf failed assertion(s)"; return 1; fi
    said=$(sed -n 's/^负对照：跳过 \([0-9][0-9]*\) 项.*/\1/p' "$1" | tail -1)
    if [ -n "$said" ] && [ "$said" != "$ms" ]; then
        echo "count line says $ms negative control(s) skipped, the file printed 负对照：跳过 $said 项"; return 1
    fi
    said=$(sed -n 's/^负对照：本次跑了 \([0-9][0-9]*\) 项.*/\1/p' "$1" | tail -1)
    if [ -n "$said" ] && [ "$ms" != "?" ] && [ "$said" != "$((mr + ms))" ]; then
        echo "count line says $((mr + ms)) negative control(s), the file printed 负对照：本次跑了 $said 项"; return 1
    fi
    return 0
}
counts_brief() {   # <counts> → "回归 12/0 · 负对照 跳过 3" for the per-unit line
    local rp rf cr cs mr ms mf
    IFS=$'\t' read -r rp rf cr cs mr ms mf <<< "$1"
    [ "$mr" != "-" ] || { echo "–"; return; }
    local out="回归 $rp/$rf"
    [ "$rp" != "-" ] || out="回归 不单列"
    [ $((cr + cs)) -eq 0 ] || out+=" · 对拍 $cr/$cs"
    if [ "$mr" -gt 0 ]; then out+=" · 负对照 跑 $mr${ms:+/跳过 $ms}"; elif [ "$ms" != 0 ]; then out+=" · 负对照 跳过 $ms"; fi
    echo "$out"
}

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
    # The count line: required for a pass; read (when there) for every other verdict, for the summary.
    local counts why
    counts="$NOCOUNTS"
    case "$status" in
        skipped|skipped-ok) ;;
        *)
            if counts=$(parse_counts "$log" 2>"$RUNSTATE/$id.why"); then
                [ "$status" != pass ] || why=$(count_problems "$log" "$counts") || { status=fail; note="$why"; }
            else
                counts="$NOCOUNTS"
                [ "$status" != pass ] || { status=fail; note="$(cat "$RUNSTATE/$id.why")"; }
            fi ;;
    esac
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$u" "$status" "$secs" "$note" "${KIND[$f]}" "$counts" >> "$RESULTS"
    case "$status" in pass|skipped-ok) mark="✅" ;; *) mark="❌"; failed=$((failed+1)) ;; esac
    local cshow; cshow=$(counts_brief "$counts")
    ROW[$u]="| \`$u\` | $mark $status | ${secs}s | $cshow | $note |"

    if [ "$GHA" = 1 ]; then
        echo "::group::$mark $u ($status, ${secs}s)"; cat "$log"; echo "::endgroup::"
        if [ "$mark" = "❌" ]; then
            echo "::error title=$u $status::tests/$f.test.sh${u#"$f"}: $status${note:+ — $note}"
            echo "──── full output of $u ────"; cat "$log"; echo "──── end of $u ────"
        fi
    else
        printf '%s %-34s %-10s %4ss  %-30s %s\n' "$mark" "$u" "$status" "$secs" "$cshow" "$note"
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

# ── run record for the comment footer's test time (GitHub#244) ─────────────────
# Each run gets an id, printed in its own output (`cavil-test-run id=…`) whether or not the record
# below could be written, plus a start and an end line in a local JSONL file with the same id. The
# footer's test-time command links an agent's `bash tests/run.sh` to its record only by that id —
# never by "a run started around the same time in the same directory". The end line carries the
# start time too, so a lost start line costs nothing. Writing is best effort: a failure never changes
# this run's result, it only adds `log=failed` to the printed line.
# Nested runs (a test that runs this script again: CAVIL_TEST_RUN_ID inherited, or a fixture tests
# dir via RUN_TESTS_DIR) record nothing and print nothing, unless CAVIL_TEST_RUNS_LOG names a log.
RUN_REC=""
if [ -z "${CAVIL_TEST_RUN_ID:-}" ] && { [ -z "${RUN_TESTS_DIR:-}" ] || [ -n "${CAVIL_TEST_RUNS_LOG:-}" ]; }; then
    RUN_REC="${CAVIL_TEST_RUNS_LOG:-${XDG_STATE_HOME:-$HOME/.local/state}/cavil-loop/test-runs.jsonl}"
    CAVIL_TEST_RUN_ID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || printf '%s-%s-%s' "$(date +%s)" "$$" "$RANDOM")
    CAVIL_TEST_RUN_ID="${CAVIL_TEST_RUN_ID//[^A-Za-z0-9._-]/}"
    export CAVIL_TEST_RUN_ID
    RUN_WT=$(git -C "$REPO_DIR" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$REPO_DIR")
    run_now() {   # epoch seconds with milliseconds where date can (GNU); whole seconds elsewhere
        local t; t=$(date +%s.%3N 2>/dev/null)
        [[ "$t" =~ ^[0-9]+\.[0-9]{3}$ ]] || t=$(date +%s)
        printf '%s' "$t"
    }
    RUN_T0=$(run_now)
    run_record() {   # <jq filter> [jq args...] → append one line; 0 = written
        local line
        line=$(jq -nc --arg id "$CAVIL_TEST_RUN_ID" --arg wt "$RUN_WT" --argjson t0 "$RUN_T0" \
            --argjson t "$(run_now)" "$@") || return 1
        mkdir -p "$(dirname "$RUN_REC")" 2>/dev/null
        { printf '%s\n' "$line" >> "$RUN_REC"; } 2>/dev/null
    }
    run_record_end() {   # trap: the exit status is passed through untouched
        local rc=$?
        run_record --argjson exit "$rc" --argjson units "${ran:-0}" --argjson failed "${failed:-0}" \
            '{ev:"end",id:$id,wt:$wt,t0:$t0,t:$t,exit:$exit,units:$units,failed:$failed}' || true
        exit "$rc"
    }
    if run_record --arg args "$ORIG_ARGS" '{ev:"start",id:$id,wt:$wt,t:$t0,args:$args}'; then
        echo "cavil-test-run id=$CAVIL_TEST_RUN_ID"
    else
        echo "cavil-test-run id=$CAVIL_TEST_RUN_ID log=failed"
    fi
    trap run_record_end EXIT
fi

change_note
echo "Running ${#RUN[@]} unit(s)${SHARD:+ (shard $SHARD)}, up to $JOBS at a time${MUTATION:+, with MUTATION=$MUTATION}; logs in $OUT/logs"
[ ${#PAR[@]} -eq 0 ] || run_pool "$JOBS" "${PAR[@]}"
# Files marked "# parallel: no" run alone, after everything else has finished.
[ ${#SER[@]} -eq 0 ] || run_pool 1 "${SER[@]}"
wait || true
rm -rf "$RUNSTATE"

ran=$(( ${#PAR[@]} + ${#SER[@]} ))
{
    echo "### ${SHARD:+Shard $SHARD: }$(( ran - failed )) / $ran passed${MUTATION:+ (MUTATION=$MUTATION)}${KIND_OPT:+ (kinds: $KIND_OPT)}"
    echo
    awk -F'\t' -v OFS='\t' '$2 != "excluded" { print $1, $2, $5, $6, $7, $8, $9, $10, $11, $12 }' "$RESULTS" | counts_report
    for kk in $KINDS_ALL; do
        keys=$(for k in "${!ROW[@]}"; do if [ "${KIND[$(file_of "$k")]}" = "$kk" ]; then printf '%s\n' "$k"; fi; done | LC_ALL=C sort)
        [ -n "$keys" ] || continue
        echo
        echo "#### \`$kk\` $(kind_label "$kk")"
        echo
        echo "| test | result | time | counts | note |"
        echo "|---|---|---|---|---|"
        for k in $keys; do echo "${ROW[$k]}"; done
    done
} > "$OUT/summary.md"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$OUT/summary.md" >> "$GITHUB_STEP_SUMMARY"

echo
# The per-kind table in the terminal too (the per-unit lines are above).
awk -F'\t' -v OFS='\t' '$2 != "excluded" { print $1, $2, $5, $6, $7, $8, $9, $10, $11, $12 }' "$RESULTS" | counts_report
echo
echo "Results: $RESULTS"
if [ "$failed" -gt 0 ]; then echo "❌ $failed of $ran failed"; exit 1; fi
echo "✅ all $ran passed"
