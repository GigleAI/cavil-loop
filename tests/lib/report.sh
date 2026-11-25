# shellcheck shell=bash
# One machine-readable count line per test file (GitHub#212). Sourced by test files.
#
# Every tests/*.test.sh calls report_counts once, at its end, right before its final verdict:
#
#   report_counts "$pass" "$fail"
#
# It prints exactly one line, starting in column 0:
#
#   CAVIL_TEST_COUNTS v=2 regress_pass=N regress_fail=N compat_ran=N compat_skipped=N
#
#   regress_pass / regress_fail   the file's own assertion counters
#   compat_ran / compat_skipped   "same as before the change" comparisons that ran / were skipped as
#                                 byte-identical — from tests/lib/compat.sh (0 when not sourced)
#
# tests/run.sh reads it: a file that exits 0 without this line (it stopped early, or never got here)
# fails as "没汇报计数". It must run in the main shell (not inside $( )), after the last assertion.

# ── Kinds, the count line, `--kind` / `--quick` and the grouped summaries: rules moved from the root AGENTS.md (GitHub#658); read before changing ──
# Kinds, the count line, `--kind` / `--quick` and the grouped summaries (GitHub#212:
# `tests/run.sh`, `tests/lib/report.sh`, the `# kind:` header and the `report_counts` call in every
# file) → `tests/run.test.sh` (~30 s) plus `bash tests/run.sh --quick`; the smoke test →
# `tests/smoke.test.sh` (~6 s)
#

report_counts() {   # <regress pass> <regress fail>
    if [ $# -ne 2 ]; then
        echo "report_counts takes exactly two arguments (pass, fail), got $#" >&2
        return 2
    fi
    echo "CAVIL_TEST_COUNTS v=2 regress_pass=$1 regress_fail=$2 compat_ran=${COMPAT_RAN:-0} compat_skipped=${COMPAT_SKIPPED:-0}"
}
