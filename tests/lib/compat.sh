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
# It compares exactly the two trees the comparison would run (`diff -r`, ignoring __pycache__); uncommitted and
# untracked edits count, because the working tree is what gets copied. Same → prints an indented
# "⏭ 同版本，对比已跳过：<what>" line (tests/run.sh lists those, it does not count them as passes)
# and returns 0. Different → returns 1. No cache across runs: every run decides afresh.
#
# compat_summary prints one line with both counts; call it before report_counts.

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

# ── 和改动前比轮询调用时，合并清理那一段的统一写法（GitHub#656）──
# ① 已合并列表的读取去掉：多读了几项（正文、合并时间…），而且 AUTO_CLEANUP_ON_MERGE=false 时现在也每轮读（合并后的
# 交接不随清理关掉），改动前那时不读；② 假 GitHub 没开列表时（不带 FAKE_GH_LISTS）
# 对列表一律原样答 `[]`，改动前的脚本按行读、把它当成编号为「[]」的 PR（读它的正文、给它打标签、记进已清理），
# 现在按 JSON 读、没有这个 PR——这些对「[]」的调用和记录与要比的功能无关，去掉。
# ③ 派工时换标签那一段（GitHub#700）：改动前是「交任务之后摘全部触发标签、再加 doing/agent」，现在是「交任务之前读
# 条目、加 doing/agent、只摘挂着的触发标签、再读回」。同一个条目上连在一起的这几种调用（单条读条目 / PR、加 doing/agent、
# 摘标签；有的假 gh 另记一行 `WRITE <方法> <路径>`）两边各折成一行 `claim <编号>` 再比；派工之后的标签结果仍由各测试比 labels.json，认领本身在 tests/dispatch-claim.test.sh 测
compat_claim_calls() {   # stdin：调用记录；stdout：统一后的调用记录
    python3 -c '
import re, sys
pat = re.compile(r"^(?:gh )?api (?:repos/[^/ ]+/[^/ ]+/(?:issues|pulls)/(\d+)|-X POST repos/[^/ ]+/[^/ ]+/issues/(\d+)/labels -f labels\[\]=doing/agent|-X DELETE repos/[^/ ]+/[^/ ]+/issues/(\d+)/labels/\S+)$|^WRITE (?:POST|DELETE) repos/[^/ ]+/[^/ ]+/issues/(\d+)/labels(?:/\S+)?$")
last = None
for line in sys.stdin:
    m = pat.match(line.rstrip("\n"))
    n = next((g for g in m.groups() if g), None) if m else None
    if n is None:
        last = None; sys.stdout.write(line); continue
    if n != last:
        print("claim " + n)
    last = n
'
}
compat_merge_calls() {   # stdin：调用记录；stdout：统一后的调用记录
    # 记录里命令名可以写也可以不写（有的假 gh 只记参数）
    { grep -vE '^(gh )?pr list --repo [^ ]+ --state merged |^(gh )?pr view \[\] |/issues/\[\]( |/|$)' || true; } | compat_claim_calls
}
# state.json 一侧：去掉「[]」那条假 PR（已清理列表里的、各重试队列里以「[]」为键的）；已清理列表是空的（只是首轮
# bootstrap 写下的）就整项去掉
COMPAT_MERGE_STATE_JQ='walk(if type == "object" then del(.["[]"]) else . end)
    | if has("cleaned_prs") then (.cleaned_prs |= map(select(type == "number")) | if .cleaned_prs == [] then del(.cleaned_prs) else . end) else . end'
# 托管合并之后的那一段（合并说明、合并后的交接）GitHub#656 起按新规则做，不再和改动前逐字节比（在
# tests/merge-followup.test.sh 测）。这几行之前的判定、合并请求本身照旧逐字节比：读到合并请求那一行就停
compat_cut_after_merge() {   # stdin：调用记录（可以是几轮拼在一起的）；stdout：到合并请求那一行为止
    awk '{ print } / -X PUT [^ ]*\/pulls\/[0-9]+\/merge( |$)/ { exit }'
}
# ── self-heal 看到会话活着时读会话上记的 agent（GitHub#744）──
# 没有这次启动的记录时，self-heal 要知道会话跑的 agent 支不支持「开工证据」，多读一次会话选项。
# 和改动前比 tmux 调用时把这一行去掉：判据本身在 tests/claude-bypass-launch.test.sh 测
compat_selfheal_tmux() {   # stdin：tmux 调用记录；stdout：去掉那一行
    grep -vE '^(tmux )?show-options -qv -t =[^ ]+: @worker_agent$' || true
}
# ── 起 worker 前的 agent 命令检查和退出码记录（GitHub#731）──
# 每次起程序之前多一次检查（读 shell 设置、起一个检查会话 / 窗口、等它的信号、收掉它），启动命令末尾多一段记退出码。
# 和改动前比 tmux 调用时把这些去掉：检查本身在 tests/agent-bin-check.test.sh 测。
# 窗格编号（%N）从头数，检查窗格占掉了号，一并换成同一个占位
compat_bincheck_tmux() {   # stdin：tmux 调用记录；stdout：统一后的记录
    # 记退出码前还要看一眼会话在不在（读它的 shell 设置）：去掉检查那几行后，连着两次一模一样的 has-session 只留一次
    python3 -c '
import re, sys
drop = re.compile(r"^(tmux )?(show-options -gv default-shell|new-session -d -s cavil-bincheck-|new-window -d -P -F #\{pane_id\} .*cavil-bin-check |wait-for (-S )?cavil-bincheck-|kill-session -t =cavil-bincheck-|kill-pane -t %[0-9]+$|show-options -qv -t =\S+ default-shell$)")
prev = None
for l in sys.stdin.read().splitlines():
    if drop.match(l):
        continue
    if l == prev and re.match(r"^(tmux )?has-session -t =\S+$", l):
        continue
    prev = l
    l = re.sub(r"; __cavil_rc=\$\?; printf .*; exit \$__cavil_rc", "", l)
    print(re.sub(r"%[0-9]+", "%N", l))
'
}
