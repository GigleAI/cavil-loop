# shellcheck shell=bash
# "Same as before the change?" comparisons, shared (GitHub#211). Sourced by test files.
#
# Several tests run the scripts as they were at the merge-base next to the current ones and require
# identical results (feature switched off → byte-identical GitHub calls / state / prompts). When the
# two trees being compared are byte-identical, that comparison can only come out equal: running the
# old side is pure cost. compat_skip decides that once, from the files themselves:
#
#   if ! compat_skip "<what is compared>" <old root> <new root> <subdir>...; then
#       … run old and new, chk that they match …
#   fi
#
# It compares exactly the two trees the comparison would run (`diff -r`, ignoring __pycache__), so a
# negative control that hands in a broken copy is never "same" and always runs; uncommitted and
# untracked edits count, because the working tree is what gets copied. Same → prints an indented
# "⏭ 同版本，对比已跳过：<what>" line (tests/run.sh lists those, it does not count them as passes)
# and returns 0. Different → returns 1. No cache across runs: every run decides afresh.
#
# compat_summary prints one line with both counts; call it next to mutation_summary.

COMPAT_RAN=0
COMPAT_SKIPPED=0

compat_same() {   # <old root> <new root> <subdir>...
    local old="$1" new="$2" d; shift 2
    [ $# -gt 0 ] || return 1
    for d in "$@"; do
        [ -e "$old/$d" ] && [ -e "$new/$d" ] || return 1
        diff -rq -x __pycache__ "$old/$d" "$new/$d" >/dev/null 2>&1 || return 1
    done
}

compat_skip() {   # <label> <old root> <new root> <subdir>...
    local label="$1"; shift
    if compat_same "$@"; then
        COMPAT_SKIPPED=$((COMPAT_SKIPPED + 1))
        [ "${QUIET:-0}" = 1 ] || echo "  ⏭ 同版本，对比已跳过：$label"
        return 0
    fi
    COMPAT_RAN=$((COMPAT_RAN + 1))
    return 1
}

compat_summary() {
    echo "改动前对拍：跑了 $COMPAT_RAN 组，同版本跳过 $COMPAT_SKIPPED 组（跳过的不算通过）"
}
