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

# compat_step_dir_patch <old root>: GitHub#599 added the ${CAVIL_STEP_DIR} placeholder to the base
# templates. Tests that render the *current* templates with the merge-base dispatch scripts (to show a
# switched-off feature changes nothing) would otherwise see the placeholder left unrendered by the old
# scripts and report a difference that has nothing to do with the feature under test. This gives the old
# dispatch scripts the same substitution the current ones make (the tree's own scripts/ — what
# _lib.sh picks when no managed entrypoints exist). A tree that already renders it is left alone, so the
# patch turns into a no-op once the merge-base contains GitHub#599.
compat_step_dir_patch() {
    local f
    for f in "$1"/scripts/dispatch-new-issue.sh "$1"/scripts/dispatch-issue-comment.sh "$1"/scripts/dispatch-pr-comment.sh; do
        [ -f "$f" ] || continue
        grep -q 'CAVIL_STEP_DIR' "$f" && continue
        sed -i 's#^\(        -e "s|\\${COMMENT_FOOTER_CMD}|$COMMENT_FOOTER_CMD|g" \\\)$#\1\n        -e "s|\\${CAVIL_STEP_DIR}|$_LIB_DIR|g" \\#' "$f"
        grep -q 'CAVIL_STEP_DIR' "$f" || { echo "compat_step_dir_patch: 没能给 $f 补上 \${CAVIL_STEP_DIR}" >&2; return 1; }
    done
    compat_feedback_fp_patch "$1"
}

# compat_feedback_fp_patch <old root>: the same for GitHub#614's ${FEEDBACK_FP_CMD} (the answer-record
# command in the issue / PR reply templates). The value is what the current _lib.sh gives when no
# managed entrypoints exist: the tree's own scripts/feedback-fingerprint.sh with the project config.
# Called by compat_step_dir_patch, so every test that already patches old trees gets it; a tree that
# already renders the placeholder is left alone.
compat_feedback_fp_patch() {
    local f line
    # shellcheck disable=SC2016  # written into the old script verbatim, expanded there
    line='        -e "s|\${FEEDBACK_FP_CMD}|bash '"'"'$_LIB_DIR/feedback-fingerprint.sh'"'"' --config '"'"'${CONFIG_FILE:-}'"'"'|g" \'
    for f in "$1"/scripts/dispatch-new-issue.sh "$1"/scripts/dispatch-issue-comment.sh "$1"/scripts/dispatch-pr-comment.sh; do
        [ -f "$f" ] || continue
        grep -q 'FEEDBACK_FP_CMD' "$f" && continue
        # literal match through ENVIRON: `-v` and regex escapes differ between mawk and gawk (gawk
        # turned `\$` into `$` and matched nothing on CI), ENVIRON values are taken as they are
        COMPAT_ADD="$line" COMPAT_AT='        -e "s|\${CAVIL_STEP_DIR}|' \
            awk '{ print } index($0, ENVIRON["COMPAT_AT"]) == 1 { print ENVIRON["COMPAT_ADD"] }' "$f" > "$f.compat" \
            && cat "$f.compat" > "$f" && rm -f "$f.compat"
        grep -q 'FEEDBACK_FP_CMD' "$f" || { echo "compat_feedback_fp_patch: 没能给 $f 补上 \${FEEDBACK_FP_CMD}" >&2; return 1; }
    done
}
