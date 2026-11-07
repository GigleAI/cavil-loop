# shellcheck shell=bash
# One machine-readable count line per test file (GitHub#212). Sourced by test files.
#
# Every tests/*.test.sh calls report_counts once, at its end, right before its final verdict:
#
#   report_counts "$pass" "$fail"                      # most files
#   report_counts "$pass" "$fail" "$mut_ran" "$mut_fail"   # files that count their own
#                                                      # negative controls (ran / did not go red)
#
# It prints exactly one line, starting in column 0:
#
#   CAVIL_TEST_COUNTS v=1 regress_pass=N|- regress_fail=N|- compat_ran=N compat_skipped=N mut_ran=N mut_skipped=N mut_fail=N|-
#
#   regress_pass / regress_fail   the file's own assertion counters — regression only. With MUTATION=1
#                                 and at least one negative control counted, most files also add the
#                                 controls' verdicts (and the broken copies' assertions) into the same
#                                 counters, so the two cannot be told apart: both fields are then "-"
#                                 ("not counted separately in this mode"), never a mixed number. A file
#                                 whose first two arguments are regression-only in every mode (it saves
#                                 them before its negative controls start) sets REPORT_REGRESS_ONLY=1
#                                 before calling, and keeps its numbers.
#   compat_ran / compat_skipped   "same as before the change" comparisons that ran / were skipped as
#                                 byte-identical — from tests/lib/compat.sh (0 when not sourced)
#   mut_ran / mut_skipped         negative controls run / skipped — from tests/lib/mutation.sh's
#                                 counter (the same number mutation_summary prints); 0 when not sourced
#   mut_fail                      negative controls that did not go red, when the file counts them; "-"
#                                 when it does not
#
# tests/run.sh reads it: a file that exits 0 without this line (it stopped early, or never got here)
# fails as "没汇报计数"; so does a line whose negative-control count differs from the file's own
# "负对照：跳过 N 项" line. It must run in the main shell (not inside $( )), after the last assertion.

report_counts() {   # <regress pass> <regress fail> [mut ran] [mut fail]
    local rp="${1:-}" rf="${2:-}" total="${MUTATION_COUNT:-0}" mr ms mf="${4:--}"
    if [ "${MUTATION:-}" = 1 ]; then
        if [ "$total" != 0 ] && [ "${REPORT_REGRESS_ONLY:-}" != 1 ]; then rp="-"; rf="-"; fi
        mr="${3:-$total}"
        if [[ "$mr" =~ ^[0-9]+$ ]] && [[ "$total" =~ ^[0-9]+$ ]] && [ "$mr" -le "$total" ]; then ms=$((total - mr))
        else ms="?"; fi
    else
        mr=0; ms="$total"
    fi
    echo "CAVIL_TEST_COUNTS v=1 regress_pass=$rp regress_fail=$rf compat_ran=${COMPAT_RAN:-0} compat_skipped=${COMPAT_SKIPPED:-0} mut_ran=$mr mut_skipped=$ms mut_fail=$mf"
}
