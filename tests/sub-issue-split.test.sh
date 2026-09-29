#!/usr/bin/env bash
# sub-issue 拆分（issue #43）的行为守卫：`split_parent_of` / `sub_issue_rollup`。
#
# 跑法：bash tests/sub-issue-split.test.sh
# 不碰网络、不读真实 config：自造临时 config + 假 `gh`（按 REST 路径回放 JSON，--jq 用真 jq 执行）。
#
# 为什么要有这个文件：这两个函数错了**都不报错**——
#   · split_parent_of 放得太宽 → 任何人开个带注释的 issue 就能让 worker 跳过人工确认直接写代码；
#     收得太紧 → 子项永远先出方案，人要把同一件事确认两次。
#   · sub_issue_rollup 把「查不到」当成「全完成」→ 父 issue 被提前翻回人工；
#     不幂等 → 同一轮合并两个子 PR 时父 issue 收到两条汇总。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

SANDBOX=$(mktemp -d)
TMP_CONF="$SANDBOX/coding-agent.config"
cat > "$TMP_CONF" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$SANDBOX/project"
WORKTREE_BASE="$SANDBOX/wt"
STATE_DIR="$SANDBOX/state"
TMUX_PREFIX="subtest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
CONF
mkdir -p "$SANDBOX/state" "$SANDBOX/project" "$SANDBOX/wt"
trap 'rm -rf "$SANDBOX"' EXIT

export CODING_AGENT_CONFIG="$TMP_CONF"
# _lib.sh 顶部的 `exec ... 2>/dev/null` 会永久吞掉 stderr；source 前后存还 fd 2。
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

# ── 假 gh ──
# FIX/<路径 / 换成 _>.json = 该 GET 端点的响应体；FIX/<...>.err = 以该内容报错（stderr + rc=1）。
# 所有写操作（-X POST/DELETE、issue comment）记到 $CALLS，不回放。
FIX="$SANDBOX/fix"; CALLS="$SANDBOX/calls"; mkdir -p "$FIX"; : > "$CALLS"
fx_key() { printf '%s' "$1" | sed 's|?.*||; s|/|_|g'; }
set_json() { printf '%s' "$2" > "$FIX/$(fx_key "$1").json"; rm -f "$FIX/$(fx_key "$1").err"; }
set_err()  { printf '%s' "$2" > "$FIX/$(fx_key "$1").err"; rm -f "$FIX/$(fx_key "$1").json"; }
reset_fx() { rm -f "$FIX"/*; : > "$CALLS"; echo '{}' > "$STATE_DIR/state.json"; _WRITE_LOGIN_CACHE=""; }

gh() {
    if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
        local n="$3" bf="" a
        for a in "$@"; do [ "${prev:-}" = "--body-file" ] && bf="$a"; prev="$a"; done
        printf 'COMMENT %s %s\n' "$n" "$(tr '\n' ' ' < "$bf")" >> "$CALLS"
        return 0
    fi
    [ "$1" = "api" ] || return 1
    shift
    local method=GET path="" jqx="" args=()
    while [ $# -gt 0 ]; do
        case "$1" in
            -X) method="$2"; shift 2;;
            --jq) jqx="$2"; shift 2;;
            --paginate) shift;;
            -f|-F) args+=("$2"); shift 2;;
            *) path="$1"; shift;;
        esac
    done
    if [ "$method" != GET ]; then
        printf '%s %s %s\n' "$method" "$path" "${args[*]:-}" >> "$CALLS"
        return 0
    fi
    local k; k=$(fx_key "$path")
    if [ -f "$FIX/$k.err" ]; then cat "$FIX/$k.err" >&2; return 1; fi
    [ -f "$FIX/$k.json" ] || { echo "gh: unexpected GET $path (HTTP 599)" >&2; return 1; }
    if [ -n "$jqx" ]; then jq -r "$jqx" "$FIX/$k.json"; else cat "$FIX/$k.json"; fi
}

R="repos/acme/widget"
issue_json() {  # <number> <author> <body> [state] [repo]
    jq -cn --argjson n "$1" --arg u "$2" --arg b "$3" --arg s "${4:-open}" --arg r "${5:-acme/widget}" \
        '{number:$n, user:{login:$u}, body:$b, state:$s, repository_url:("https://api.github.com/repos/" + $r)}'
}
NOPARENT='gh: No parent issue found (HTTP 404)'

echo "【1】split_parent_of：三项核对全过才认"
reset_fx
set_json user '{"login":"bot"}'
set_json "$R/issues/51/parent" "$(issue_json 50 luosky 'parent')"
set_json "$R/issues/51" "$(issue_json 51 bot $'范围…\n\n<!-- agent-split-from: #50 -->')"
chk "合法子项 → 父号" "$(split_parent_of 51)" "50"

set_json "$R/issues/51" "$(issue_json 51 mallory $'x\n<!-- agent-split-from: #50 -->')"
chk "作者不是 bot → 空" "$(split_parent_of 51)" ""

set_json "$R/issues/51" "$(issue_json 51 bot 'no marker here')"
chk "没有标记 → 空" "$(split_parent_of 51)" ""

set_json "$R/issues/51" "$(issue_json 51 bot '<!-- agent-split-from: #49 -->')"
chk "标记指向别的父 issue → 空" "$(split_parent_of 51)" ""

set_json "$R/issues/51" "$(issue_json 51 bot '<!-- agent-split-from: #500 -->')"
chk "标记是父号的前缀扩展（#500 ≠ #50）→ 空" "$(split_parent_of 51)" ""

set_json "$R/issues/51" "$(issue_json 51 bot '<!-- agent-split-from: #50 -->')"
set_err "$R/issues/51/parent" "$NOPARENT"
chk "GitHub 上没有父子关系（只有标记）→ 空" "$(split_parent_of 51)" ""

set_err "$R/issues/51/parent" 'gh: Server Error (HTTP 502)'
chk "父 issue 接口出错 → 空（回落设计轮）" "$(split_parent_of 51)" ""

set_json "$R/issues/51/parent" "$(issue_json 50 luosky 'p' open other/repo)"
chk "父 issue 在别的仓库 → 空" "$(split_parent_of 51)" ""

set_json "$R/issues/51/parent" "$(issue_json 50 luosky 'p')"
_WRITE_LOGIN_CACHE=""; set_err user 'gh: Bad credentials (HTTP 401)'
chk "查不到写身份 → 空" "$(split_parent_of 51)" ""

echo "【2】sub_issue_rollup：只有子项全关才汇总"
rollup_setup() {  # 父 #50 open，子项 51/52 的状态由参数给
    reset_fx
    set_json "$R/issues/51/parent" "$(issue_json 50 luosky 'p')"
    set_json "$R/issues/52/parent" "$(issue_json 50 luosky 'p')"
    set_json "$R/issues/50" "$(issue_json 50 luosky 'p' "${3:-open}")"
    set_json "$R/issues/50/sub_issues" "[{\"number\":51,\"state\":\"$1\"},{\"number\":52,\"state\":\"$2\"}]"
}
comments() { grep -c '^COMMENT 50 ' "$CALLS"; }
flipped()  { grep -c "^POST $R/issues/50/labels labels\[\]=pending/human" "$CALLS"; }

rollup_setup closed open
sub_issue_rollup 51 >/dev/null 2>&1
chk "兄弟 #52 还开着 → 不评论" "$(comments)" "0"
chk "兄弟 #52 还开着 → 不翻 label" "$(flipped)" "0"

rollup_setup open closed
sub_issue_rollup 51 >/dev/null 2>&1
chk "列表里自己还显示 open（接口未刷新），其余全关 → 汇总" "$(comments)" "1"
chk "… 父 issue 翻 pending/human" "$(flipped)" "1"
chk "… 摘掉 pending/PR" "$(grep -c "^DELETE $R/issues/50/labels/pending%2FPR" "$CALLS")" "1"
chk "… 评论列出全部子项" "$(grep -c '#51 .*#52' "$CALLS")" "1"
chk "… 没有关闭父 issue" "$(grep -c 'state' "$CALLS")" "0"
chk "… state 记下子项数" "$(jq -r '.split_rollups["50"]' "$STATE_DIR/state.json")" "2"

echo "【3】幂等：同一轮两个子 PR 都合并，只汇总一次"
sub_issue_rollup 52 >/dev/null 2>&1
chk "第二次调用不再评论" "$(comments)" "1"
chk "第二次调用不再翻 label" "$(flipped)" "1"

echo "【4】父 issue 后来又挂了新子项 → 全关时再汇总一次"
set_json "$R/issues/53/parent" "$(issue_json 50 luosky 'p')"
set_json "$R/issues/50/sub_issues" '[{"number":51,"state":"closed"},{"number":52,"state":"closed"},{"number":53,"state":"closed"}]'
sub_issue_rollup 53 >/dev/null 2>&1
chk "子项数 2→3 → 再汇总" "$(comments)" "2"
chk "state 更新为 3" "$(jq -r '.split_rollups["50"]' "$STATE_DIR/state.json")" "3"

echo "【5】查不到 ≠ 全完成：任何一步出错都不动"
rollup_setup closed closed
set_err "$R/issues/51/parent" 'gh: Server Error (HTTP 502)'
sub_issue_rollup 51 >/dev/null 2>&1
chk "父 issue 接口 502 → 不动" "$(comments)$(flipped)" "00"

rollup_setup closed closed
set_err "$R/issues/50/sub_issues" 'gh: Server Error (HTTP 502)'
sub_issue_rollup 51 >/dev/null 2>&1
chk "子项列表 502 → 不动" "$(comments)$(flipped)" "00"

rollup_setup closed closed
set_json "$R/issues/50/sub_issues" '[]'
sub_issue_rollup 51 >/dev/null 2>&1
chk "子项列表为空 → 不动（不能把 0/0 当全完成）" "$(comments)$(flipped)" "00"

rollup_setup closed closed
set_err "$R/issues/50" 'gh: Server Error (HTTP 502)'
sub_issue_rollup 51 >/dev/null 2>&1
chk "父 issue 状态读不到 → 不动" "$(comments)$(flipped)" "00"

rollup_setup closed closed closed
sub_issue_rollup 51 >/dev/null 2>&1
chk "父 issue 已关闭 → 不动" "$(comments)$(flipped)" "00"

echo "【6】负对照：普通 issue（没有父）行为不变"
reset_fx
set_err "$R/issues/60/parent" "$NOPARENT"
sub_issue_rollup 60 >/dev/null 2>&1
chk "没有父 issue → 没有任何写操作" "$(wc -l < "$CALLS" | tr -d ' ')" "0"
chk "… state 不新增字段" "$(jq -c . "$STATE_DIR/state.json")" "{}"

echo "【7】接线：merge 钩子与派工脚本真的调用了它们"
chk "agent-poll.sh 在 CLOSED 分支调用 sub_issue_rollup" \
    "$(awk '/issue_state" = "CLOSED"/,/else/' "$REPO_DIR/scripts/agent-poll.sh" | grep -c 'sub_issue_rollup "\$issue_n"')" "1"
chk "state 迁移循环含 split_rollups" \
    "$(grep -c '^for field in .* split_rollups; do' "$REPO_DIR/scripts/agent-poll.sh")" "1"
chk "dispatch-new-issue.sh 调用 split_parent_of" \
    "$(grep -c 'split_parent_of "\$ISSUE"' "$REPO_DIR/scripts/dispatch-new-issue.sh")" "1"

echo "【8】子项 prompt 的占位符都会被 dispatch-new-issue.sh 渲染"
# 子项走的是 issue-comment + sub-issue 两份模板，但渲染它们的是 new-issue 的 sed 列表；
# 漏一个占位，worker 就会拿到字面的 \${XXX}（比如 PR_CREATED_HOOK 没渲染 → 钩子路径是字面串）。
rendered=$(grep -oE 's\|\\\$\{[A-Z_]+\}' "$REPO_DIR/scripts/dispatch-new-issue.sh" | sed 's/^s|\\\$//' | sort -u)
missing=""
for ph in $(cat "$REPO_DIR/prompts/issue-comment.template.md" "$REPO_DIR/prompts/sub-issue.template.md" | grep -oE '\$\{[A-Z_]+\}' | sed 's/^\$//' | sort -u); do
    printf '%s\n' "$rendered" | grep -qxF "$ph" || missing="$missing $ph"
done
chk "没有漏渲染的占位符" "${missing:-无}" "无"

echo
echo "通过 $pass，失败 $fail"
[ "$fail" = 0 ]
