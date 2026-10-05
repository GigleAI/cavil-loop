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
# FAIL_WRITE=<正则>：匹配的写操作记为 FAILED 并返回 1（模拟写接口失败）；
# 报错文本取 FAIL_MSG（默认 502；设成 404 模拟「标签本来就不在」）。
FIX="$SANDBOX/fix"; CALLS="$SANDBOX/calls"; mkdir -p "$FIX"; : > "$CALLS"
fx_key() { printf '%s' "$1" | sed 's|?.*||; s|/|_|g'; }
set_json() { printf '%s' "$2" > "$FIX/$(fx_key "$1").json"; rm -f "$FIX/$(fx_key "$1").err"; }
set_err()  { printf '%s' "$2" > "$FIX/$(fx_key "$1").err"; rm -f "$FIX/$(fx_key "$1").json"; }
reset_fx() { rm -f "$FIX"/*; : > "$CALLS"; echo '{}' > "$STATE_DIR/state.json"; _WRITE_LOGIN_CACHE=""; FAIL_WRITE=""; FAIL_MSG=""; }
FAIL_WRITE=""

gh() {
    if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
        local n="$3" bf="" a
        for a in "$@"; do [ "${prev:-}" = "--body-file" ] && bf="$a"; prev="$a"; done
        if [ -n "$FAIL_WRITE" ] && [[ "COMMENT $n" =~ $FAIL_WRITE ]]; then
            echo "FAILED COMMENT $n" >> "$CALLS"; echo 'gh: Server Error (HTTP 502)' >&2; return 1
        fi
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
        if [ -n "$FAIL_WRITE" ] && [[ "$method $path ${args[*]:-}" =~ $FAIL_WRITE ]]; then
            printf 'FAILED %s %s %s\n' "$method" "$path" "${args[*]:-}" >> "$CALLS"
            echo "${FAIL_MSG:-gh: Server Error (HTTP 502)}" >&2; return 1
        fi
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
set_parent() {  # <父号> <state> <父 issue 自己记的子项总数，空 = 字段缺失>
    local j; j=$(issue_json "$1" luosky 'p' "$2")
    [ -n "$3" ] && j=$(printf '%s' "$j" | jq -c --argjson t "$3" '. + {sub_issues_summary: {total: $t}}')
    set_json "$R/issues/$1" "$j"
}
rollup_setup() {  # 父 #50 open，子项 51/52 的状态由参数给
    reset_fx
    set_json "$R/issues/51/parent" "$(issue_json 50 luosky 'p')"
    set_json "$R/issues/52/parent" "$(issue_json 50 luosky 'p')"
    set_parent 50 "${3:-open}" 2
    set_json "$R/issues/51" "$(issue_json 51 bot 'c' closed)"
    set_json "$R/issues/52" "$(issue_json 52 bot 'c' closed)"
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
set_json "$R/issues/53" "$(issue_json 53 bot 'c' closed)"
set_json "$R/issues/50/sub_issues" '[{"number":51,"state":"closed"},{"number":52,"state":"closed"},{"number":53,"state":"closed"}]'
set_parent 50 open 3
sub_issue_rollup 53 >/dev/null 2>&1
chk "子项数 2→3 → 再汇总" "$(comments)" "2"
chk "state 更新为 3" "$(jq -r '.split_rollups["50"]' "$STATE_DIR/state.json")" "3"

echo "【5】查不到 ≠ 全完成：任何一步出错都不动，并返回「下轮再试」"
rc_of() { sub_issue_rollup "$1" >/dev/null 2>&1; echo $?; }
rollup_setup closed closed
set_err "$R/issues/51/parent" 'gh: Server Error (HTTP 502)'
chk "父 issue 接口 502 → 返回 1（重试）" "$(rc_of 51)" "1"
chk "… 不动" "$(comments)$(flipped)" "00"

rollup_setup closed closed
set_err "$R/issues/50/sub_issues" 'gh: Server Error (HTTP 502)'
chk "子项列表 502 → 返回 1" "$(rc_of 51)" "1"
chk "… 不动" "$(comments)$(flipped)" "00"

rollup_setup closed closed
set_json "$R/issues/50/sub_issues" '[]'
chk "子项列表为空（接口未刷新）→ 返回 1，不能把 0/0 当全完成" "$(rc_of 51)" "1"
chk "… 不动" "$(comments)$(flipped)" "00"

rollup_setup closed closed
set_err "$R/issues/50" 'gh: Server Error (HTTP 502)'
chk "父 issue 状态读不到 → 返回 1" "$(rc_of 51)" "1"
chk "… 不动" "$(comments)$(flipped)" "00"

rollup_setup closed closed closed
chk "父 issue 已关闭 → 返回 0（定论，出队）" "$(rc_of 51)" "0"
chk "… 不动" "$(comments)$(flipped)" "00"

rollup_setup closed open
chk "兄弟还开着 → 返回 0（定论：等下一个子 PR 合并时再看）" "$(rc_of 51)" "0"

echo "【5a】列表不齐：先核齐，再判「全关」"
rollup_setup closed closed
set_json "$R/issues/50/sub_issues" '[{"number":52,"state":"closed"}]'
chk "列表非空但漏了当前子项 #51 → 返回 1" "$(rc_of 51)" "1"
chk "… 不评论、不翻 label" "$(comments)$(flipped)" "00"
set_json "$R/issues/50/sub_issues" '[{"number":51,"state":"closed"},{"number":52,"state":"closed"}]'
chk "列表恢复后重试 → 汇总" "$(rc_of 51; comments; flipped)" "$(printf '0\n1\n1')"
chk "再调一次不重复评论" "$(rc_of 51; comments)" "$(printf '0\n1')"

rollup_setup closed closed
set_parent 50 open 3
chk "列表有当前子项，但漏了别的兄弟（2 项 vs 父记 3 项）→ 返回 1" "$(rc_of 51)" "1"
chk "… 不评论、不翻 label" "$(comments)$(flipped)" "00"

rollup_setup closed closed
set_parent 50 open ""
chk "父 issue 没给子项总数（核不了）→ 返回 1，不放行" "$(rc_of 51)" "1"
chk "… 不评论、不翻 label" "$(comments)$(flipped)" "00"

echo "【5a-2】子项自己的状态由汇总亲自读（merge 钩子读失败会兜底成 OPEN）"
rollup_setup closed closed
set_err "$R/issues/51" 'gh: Server Error (HTTP 502)'
chk "子项状态读取 502 → 返回 1（留队）" "$(rc_of 51)" "1"
chk "… 不动" "$(comments)$(flipped)" "00"
set_json "$R/issues/51" "$(issue_json 51 bot 'c' closed)"
chk "下轮恢复为 CLOSED → 汇总一次" "$(rc_of 51; comments; flipped)" "$(printf '0\n1\n1')"
rollup_setup closed closed
set_json "$R/issues/51" "$(issue_json 51 bot 'c' open)"
chk "有父但子项还开着 → 返回 1，不汇总" "$(rc_of 51; comments)" "$(printf '1\n0')"

echo "【5b】写失败：评论和翻 label 分开记进度，重试不重复评论"
rollup_setup closed closed
FAIL_WRITE="^POST $R/issues/50/labels"
chk "评论成功、翻 label 失败 → 返回 1" "$(rc_of 51)" "1"
chk "… 评论已发 1 次" "$(comments)" "1"
chk "… 没记成「已完成」" "$(jq -r '.split_rollups["50"] // "none"' "$STATE_DIR/state.json")" "none"
chk "… 记下「评论已发」" "$(jq -r '.split_rollup_commented["50"]' "$STATE_DIR/state.json")" "2"
FAIL_WRITE=""
chk "接口恢复后重试 → 返回 0" "$(rc_of 51)" "0"
chk "… 补翻了 label" "$(flipped)" "1"
chk "… 没有重复评论" "$(comments)" "1"
chk "… 记成已完成" "$(jq -r '.split_rollups["50"]' "$STATE_DIR/state.json")" "2"

rollup_setup closed closed
FAIL_WRITE="^COMMENT 50"
chk "评论失败 → 返回 1" "$(rc_of 51)" "1"
chk "… 没翻 label（先有评论说明，再翻 label）" "$(flipped)" "0"
chk "… 没记「评论已发」" "$(jq -r '.split_rollup_commented["50"] // "none"' "$STATE_DIR/state.json")" "none"
FAIL_WRITE=""
chk "恢复后重试 → 评论 + 翻 label 各一次" "$(rc_of 51; comments; flipped)" "$(printf '0\n1\n1')"

echo "【5b-2】摘旧标签失败：不能记完成，下轮只补摘、不重复评论"
unpr() { grep -c "^DELETE $R/issues/50/labels/pending%2FPR" "$CALLS"; }
rollup_setup closed closed
FAIL_WRITE="^DELETE $R/issues/50/labels/pending%2FPR"
chk "评论 + 加 pending/human 成功、摘 pending/PR 502 → 返回 1" "$(rc_of 51)" "1"
chk "… 没记成「已完成」" "$(jq -r '.split_rollups["50"] // "none"' "$STATE_DIR/state.json")" "none"
chk "… 评论已发 1 次" "$(comments)" "1"
FAIL_WRITE=""
chk "接口恢复后重试 → 返回 0" "$(rc_of 51)" "0"
chk "… 补摘了 pending/PR" "$(unpr)" "1"
chk "… 没有重复评论" "$(comments)" "1"
chk "… 记成已完成" "$(jq -r '.split_rollups["50"]' "$STATE_DIR/state.json")" "2"

rollup_setup closed closed
FAIL_WRITE="^DELETE $R/issues/50/labels/"; FAIL_MSG='gh: Label does not exist (HTTP 404)'
chk "要摘的标签本来就不在（404）→ 算成功，返回 0" "$(rc_of 51)" "0"
chk "… 记成已完成" "$(jq -r '.split_rollups["50"]' "$STATE_DIR/state.json")" "2"
FAIL_WRITE=""; FAIL_MSG=""

echo "【5c】重试队列：merge 钩子只入队，每轮清队"
q() { jq -r --arg s "$1" '.split_rollup_queue[$s] // "gone"' "$STATE_DIR/state.json"; }
rollup_setup closed closed
set_err "$R/issues/50/sub_issues" 'gh: Server Error (HTTP 502)'
sub_issue_rollup_enqueue 51 "$STATE_DIR/state.json"
chk "入队后次数为 0" "$(q 51)" "0"
sub_issue_rollup_drain "$STATE_DIR/state.json" >/dev/null 2>&1
chk "第一轮 502 → 仍在队里，次数 1" "$(q 51)" "1"
chk "… 没评论" "$(comments)" "0"
set_json "$R/issues/50/sub_issues" '[{"number":51,"state":"closed"},{"number":52,"state":"closed"}]'
sub_issue_rollup_drain "$STATE_DIR/state.json" >/dev/null 2>&1
chk "下一轮恢复 → 出队" "$(q 51)" "gone"
chk "… 汇总完成（评论 + 翻 label）" "$(comments)$(flipped)" "11"
sub_issue_rollup_enqueue 51 "$STATE_DIR/state.json"
sub_issue_rollup_enqueue 52 "$STATE_DIR/state.json"
sub_issue_rollup_drain "$STATE_DIR/state.json" >/dev/null 2>&1
chk "同一父 issue 的两个子项同轮入队 → 都出队、不重复汇总" "$(q 51)$(q 52)$(comments)$(flipped)" "gonegone11"

rollup_setup closed closed
set_err "$R/issues/51/parent" 'gh: Forbidden (HTTP 403)'
sub_issue_rollup_enqueue 51 "$STATE_DIR/state.json"
for _ in 1 2 3; do SUB_ISSUE_ROLLUP_MAX_TRIES=3 sub_issue_rollup_drain "$STATE_DIR/state.json" >/dev/null 2>&1; done
chk "持续报错到上限（3）→ 放弃出队，不无限重试" "$(q 51)" "gone"

reset_fx
set_err "$R/issues/60/parent" "$NOPARENT"
sub_issue_rollup_enqueue 60 "$STATE_DIR/state.json"
sub_issue_rollup_drain "$STATE_DIR/state.json" >/dev/null 2>&1
chk "没有父的普通 issue → 一轮就出队、没有任何写" "$(q 60)$(wc -l < "$CALLS" | tr -d ' ')" "gone0"

echo "【5d】合并后子 issue 自己的标签：读不到状态就不写，下轮再判（与父 issue 汇总同轮协作）"
SF="$STATE_DIR/state.json"
lq() { jq -r --arg s "$1" '.merged_label_queue[$s].tries // "gone"' "$SF"; }
done51()  { grep -c "^POST $R/issues/51/labels labels\[\]=Done" "$CALLS"; }
human51() { grep -c "^POST $R/issues/51/labels labels\[\]=pending/human" "$CALLS"; }
merge_tick() {  # 模拟 merge 钩子里对「子 issue #51 的 PR #61 刚合并」做的事 + 本轮清队
    if ! merged_issue_label 51 61 >/dev/null 2>&1; then merged_label_enqueue 51 61 "$SF" >/dev/null 2>&1; fi
    sub_issue_rollup_enqueue 51 "$SF"
    merged_label_drain "$SF" >/dev/null 2>&1; sub_issue_rollup_drain "$SF" >/dev/null 2>&1
}
next_tick() { merged_label_drain "$SF" >/dev/null 2>&1; sub_issue_rollup_drain "$SF" >/dev/null 2>&1; }

rollup_setup closed closed
set_err "$R/issues/51" 'gh: Server Error (HTTP 502)'
merge_tick
chk "第 1 轮读子 issue 状态 502 → 不打 Done 也不打 pending/human" "$(done51)$(human51)" "00"
chk "… 进标签重试队列" "$(lq 51)" "1"
chk "… 父 issue 也没汇总" "$(comments)" "0"
set_json "$R/issues/51" "$(issue_json 51 bot 'c' closed)"
next_tick
chk "第 2 轮恢复为 CLOSED → 子 issue 打 Done" "$(done51)$(human51)" "10"
chk "… 出标签队列" "$(lq 51)" "gone"
chk "… 父 issue 汇总且只一次" "$(comments)$(flipped)" "11"
next_tick
chk "第 3 轮什么都不再发生" "$(done51)$(comments)" "11"

rollup_setup closed closed
set_json "$R/issues/51" "$(issue_json 51 bot 'c' open)"
chk "状态确认 OPEN（Refs PR）→ 返回 0，打 pending/human，不打 Done" "$(merged_issue_label 51 61 >/dev/null 2>&1; echo $?; done51; human51)" "$(printf '0\n0\n1')"

rollup_setup closed closed
FAIL_WRITE="^POST $R/issues/51/labels"
chk "加 Done 失败 → 返回 1（留队）" "$(merged_issue_label 51 61 >/dev/null 2>&1; echo $?)" "1"
FAIL_WRITE=""

rollup_setup closed closed
set_err "$R/issues/51" 'gh: Forbidden (HTTP 403)'
merged_label_enqueue 51 61 "$SF" >/dev/null 2>&1
for _ in 1 2 3; do SUB_ISSUE_ROLLUP_MAX_TRIES=3 merged_label_drain "$SF" >/dev/null 2>&1; done
chk "标签队列持续失败到上限 → 放弃出队" "$(lq 51)" "gone"

echo "【6】负对照：普通 issue（没有父）行为不变"
reset_fx
set_err "$R/issues/60/parent" "$NOPARENT"
sub_issue_rollup 60 >/dev/null 2>&1
chk "没有父 issue → 没有任何写操作" "$(wc -l < "$CALLS" | tr -d ' ')" "0"
chk "… state 不新增字段" "$(jq -c . "$STATE_DIR/state.json")" "{}"

echo "【7】接线：merge 钩子与派工脚本真的调用了它们"
chk "agent-poll.sh 汇总入队是无条件的（与 if 同级缩进，不在任何状态分支里）" \
    "$(grep -E '^ {16}sub_issue_rollup_enqueue "\$issue_n"' "$REPO_DIR/scripts/agent-poll.sh" | wc -l | tr -d ' ')" "1"
chk "merge 钩子不再把「读不到状态」兜底成 OPEN" \
    "$(grep -c 'echo "OPEN"' "$REPO_DIR/scripts/agent-poll.sh")" "0"
chk "merge 钩子用 merged_issue_label，失败即入标签队列" \
    "$(grep -A1 'if ! merged_issue_label "\$issue_n"' "$REPO_DIR/scripts/agent-poll.sh" | grep -c 'merged_label_enqueue')" "1"
chk "每轮先清标签队列、再清汇总队列" \
    "$(awk '/merged_label_drain "\$STATE_FILE"/{a=NR} /sub_issue_rollup_drain "\$STATE_FILE"/{b=NR} END{print (a && b && a<b) ? "ok" : "bad"}' "$REPO_DIR/scripts/agent-poll.sh")" "ok"
chk "… 且 CLOSED 分支里不再有另一次入队" \
    "$(grep -c 'sub_issue_rollup_enqueue "\$issue_n"' "$REPO_DIR/scripts/agent-poll.sh")" "1"
chk "agent-poll.sh 在 merged 循环之外每轮清队" \
    "$(awk '/done <<< "\$recent_merged"/{f=1} f' "$REPO_DIR/scripts/agent-poll.sh" | grep -c 'sub_issue_rollup_drain "\$STATE_FILE"')" "1"
chk "state 迁移循环含四个新字段" \
    "$(grep -c '^for field in .* split_rollups split_rollup_commented split_rollup_queue merged_label_queue; do' "$REPO_DIR/scripts/agent-poll.sh")" "1"
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
