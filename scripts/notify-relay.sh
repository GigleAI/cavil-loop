#!/usr/bin/env bash
# 叫醒外部传话机器人（GitHub#95）：worker / reviewer 发完评论后跑它。
#
#   bash notify-relay.sh --config <项目配置> <issue 或 PR 编号>
#
# 模板里的「外部传话交接规则」段已带好 --config，worker 只补编号。
#
# 做的事：加等待传话标签 → 摘掉全部触发标签、doing/agent、pending/review → 机器人已是
# assignee 就先移掉 → 再指派（重新指派才会叫醒它）→ 读回核对。失败整体重试一次；仍失败
# 就交还维护者。
#
# 退出码：
#   0 叫醒成功（只说明标签和 assignee 改好了，不说明机器人已经转达）
#   2 前置检查拒绝，或功能没配全 —— 没发任何写请求，标签不动
#   3 叫醒失败，已交还维护者（条目上只剩 pending/human，没有等待标签）
#   4 交还也失败 —— 输出里是实际读回的标签；**不要**对外写「已交人」
#
# 不读评论内容，也不按评论去重：去重会把「刚发的这条汇报」当成已汇报，挡住首次叫醒。
#
# 写用 gh_write（与 worker 自己发评论是同一个身份），读用 gh。所有输出走 stdout：
# _lib.sh 顶部把 fd 2 永久指向了 /dev/null，worker 看不到 stderr。
set -euo pipefail

usage() { echo "用法: notify-relay.sh --config <项目配置> <issue 或 PR 编号>"; exit 2; }

CFG="" NUM=""
while [ $# -gt 0 ]; do
    case "$1" in
        --config) [ $# -ge 2 ] || usage; CFG="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) [ -z "$NUM" ] || usage; NUM="$1"; shift ;;
    esac
done
case "$NUM" in ''|*[!0-9]*) usage ;; esac
[ -z "$CFG" ] || export CODING_AGENT_CONFIG="$CFG"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

say() { printf '%s\n' "$*"; log "notify-relay #$NUM: $*" 2>/dev/null || true; }
reject() { say "❌ 拒绝叫醒（标签未改动）：$*"; exit 2; }

if ! relay_enabled; then
    reject "本项目没有配全外部传话功能，缺：$(relay_missing_settings)"
fi
trigger_labels_array

lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
# 逗号 / 空白分隔的名单里有没有这个账号（GitHub 登录名不区分大小写）
in_list() {
    local who x arr=()
    who="$(lc "$1")"
    read -ra arr <<< "$(printf '%s' "$2" | tr ',' ' ')"
    for x in ${arr[@]+"${arr[@]}"}; do [ "$(lc "$x")" = "$who" ] && return 0; done
    return 1
}

# 交接要摘掉的标签：全部触发标签 + doing/agent + pending/review（去空去重）
mapfile -t CLEAR_LABELS < <(printf '%s\n' "${TRIGGER_LABELS_ALL[@]}" "$LABEL_AGENT_DOING" "${LABEL_PENDING_REVIEW:-}" \
    | awk 'NF && !seen[$0]++')

# 现读条目：输出两行 —— 第一行 labels（\x1f 分隔），第二行 assignees（\x1f 分隔）
read_item() {
    gh api "repos/$REPO/issues/$1" \
        --jq '([.labels[].name] | join("\u001f")), ([.assignees[].login] | join("\u001f"))'
}

has_label() {   # <labels(\x1f)> <label>
    case $'\x1f'"$1"$'\x1f' in *$'\x1f'"$2"$'\x1f'*) return 0 ;; esac
    return 1
}
has_login() {   # <logins(\x1f)> <login>，不区分大小写
    local x
    while IFS= read -r x; do
        [ -n "$x" ] && [ "$(lc "$x")" = "$(lc "$2")" ] && return 0
    done < <(printf '%s\n' "$1" | tr '\037' '\n')
    return 1
}
show_labels() { printf '%s' "$1" | tr '\037' ',' | sed 's/,/, /g'; }

# 有没有维护者手打过 pending/human：打它的人既不在允许叫醒名单里，也不是机器人账号。
# 输出那个人的登录名；读不到事件 → return 2（调用方当「不知道」处理，拒绝）
maintainer_took_over() {
    local n="$1" actors a
    actors=$(gh api --paginate "repos/$REPO/issues/$n/events" \
        --jq ".[] | select(.event == \"labeled\" and .label.name == \"$LABEL_PENDING_HUMAN\") | (.actor.login // \"?\")") || return 2
    while IFS= read -r a; do
        [ -n "$a" ] || continue
        # 打标签的账号读不出来（已注销等）→ 当作不是我们的人，保守算维护者接手
        [ "$a" != "?" ] || { printf '(账号未知)'; return 0; }
        in_list "$a" "$RELAY_ALLOWED_ACTORS" && continue
        [ "$(lc "$a")" = "$(lc "$RELAY_BOT_ACCOUNT")" ] && continue
        printf '%s' "$a"; return 0
    done <<< "$actors"
    return 1
}

# ── 前置检查：任一条不过就拒绝，不发写请求 ──
ME=$(gh_write api user --jq .login 2>/dev/null) || ME=""
[ -n "$ME" ] || reject "读不到当前 GitHub 账号，无法核对是否允许叫醒"
in_list "$ME" "$RELAY_ALLOWED_ACTORS" || reject "当前账号 $ME 不在允许叫醒的名单里"

ITEM_JSON=$(gh api "repos/$REPO/issues/$NUM") || reject "读不到 #$NUM"
IS_PR=$(printf '%s' "$ITEM_JSON" | jq -r 'has("pull_request") and .pull_request != null')
[ "$(printf '%s' "$ITEM_JSON" | jq -r '.state')" = open ] || reject "#$NUM 不是打开状态"

ORIGIN="$NUM"
ORIGIN_JSON="$ITEM_JSON"
if [ "$IS_PR" = true ]; then
    # PR 的来源只认**分支名里的 issue 编号**（BRANCH_PREFIX + N，worker 为 issue 开 PR 时的固定命名）。
    # 不读 PR 正文：daemon 里已有两份从正文找 Closes #N 的实现（会话命名的 grep 按行、
    # 活跃 worker 列表的 jq 整段），两者对跨行写法判断本就不同；这里再接一份，要么复制规则，
    # 要么去改那两份——改了就动到没开传话功能的项目的派工编号（PR #96 复审三轮）。
    # 传话需求的 PR 都是 worker 从 issue 开的，分支名必然带编号，不读正文不丢场景。
    # 也不用 pr_to_issue_num：它找不到时兜底返回 PR 自己的编号，拿来核验会让没关联需求的 PR 放行。
    PR_JSON=$(gh api "repos/$REPO/pulls/$NUM") || reject "读不到 PR #$NUM"
    PR_BRANCH=$(printf '%s' "$PR_JSON" | jq -r '.head.ref // ""')
    ORIGIN=$(branch_to_issue_num "$PR_BRANCH")
    case "$ORIGIN" in ''|*[!0-9]*) reject "PR #$NUM 的分支名 ${PR_BRANCH:-?} 不带 issue 编号，认不出它来自哪个需求" ;; esac
    [ "$ORIGIN" != "$NUM" ] || reject "PR #$NUM 没有关联 issue（关联编号就是它自己）"
    ORIGIN_JSON=$(gh api "repos/$REPO/issues/$ORIGIN") || reject "读不到关联的 issue #$ORIGIN"
    [ "$(printf '%s' "$ORIGIN_JSON" | jq -r 'has("pull_request") and .pull_request != null')" = false ] \
        || reject "PR #$NUM 关联的 #$ORIGIN 是 PR，不是 issue"
fi
ORIGIN_AUTHOR=$(printf '%s' "$ORIGIN_JSON" | jq -r '.user.login // ""')
[ "$(lc "$ORIGIN_AUTHOR")" = "$(lc "$RELAY_BOT_ACCOUNT")" ] \
    || reject "#$ORIGIN 不是传话机器人提的需求（作者是 ${ORIGIN_AUTHOR:-未知}，不是 $RELAY_BOT_ACCOUNT）"
printf '%s' "$ORIGIN_JSON" | jq -e --arg m "$RELAY_ORIGIN_MARKER" '(.body // "") | contains($m)' >/dev/null \
    || reject "#$ORIGIN 正文里没有传话需求标记"

CUR_LABELS=$(printf '%s' "$ITEM_JSON" | jq -r '[.labels[].name] | join("\u001f")')
has_label "$CUR_LABELS" "$LABEL_PENDING_HUMAN" \
    && reject "#$NUM 挂着 $LABEL_PENDING_HUMAN（维护者在处理 / 复审轮次用尽），只交维护者"
for n in $(printf '%s\n%s\n' "$NUM" "$ORIGIN" | awk '!seen[$0]++'); do
    rc=0; who=$(maintainer_took_over "$n") || rc=$?
    case "$rc" in
        0) reject "#$n 曾由维护者 $who 手动标过 $LABEL_PENDING_HUMAN，之后只交维护者" ;;
        2) reject "读不到 #$n 的标签历史，无法确认维护者是否接手过" ;;
    esac
done

# ── 叫醒 ──
LAST_FAIL=""
wake_once() {
    local L enc state labels assignees
    gh_write api -X POST "repos/$REPO/issues/$NUM/labels" -f "labels[]=$LABEL_PENDING_RELAY" >/dev/null \
        || { LAST_FAIL="加等待标签失败"; return 1; }
    for L in "${CLEAR_LABELS[@]}"; do
        enc=$(printf '%s' "$L" | jq -sRr @uri)
        # 404 = 本来就不在；别的失败交给下面的读回核对
        gh_write api -X DELETE "repos/$REPO/issues/$NUM/labels/$enc" >/dev/null 2>&1 || true
    done
    state=$(read_item "$NUM") || { LAST_FAIL="读回失败"; return 1; }
    assignees=$(printf '%s\n' "$state" | sed -n 2p)
    if has_login "$assignees" "$RELAY_BOT_ACCOUNT"; then
        # 已经是 assignee 时直接再加不会通知它，必须先移掉
        gh_write api -X DELETE "repos/$REPO/issues/$NUM/assignees" -f "assignees[]=$RELAY_BOT_ACCOUNT" >/dev/null \
            || { LAST_FAIL="移除机器人 assignee 失败"; return 1; }
        # 移除要读回确认真的不在了：没移掉就再加，机器人不会收到通知，最后的读回也分辨不出来
        state=$(read_item "$NUM") || { LAST_FAIL="移除 assignee 后读回失败"; return 1; }
        assignees=$(printf '%s\n' "$state" | sed -n 2p)
        has_login "$assignees" "$RELAY_BOT_ACCOUNT" && { LAST_FAIL="移除机器人 assignee 没生效"; return 1; }
    fi
    gh_write api -X POST "repos/$REPO/issues/$NUM/assignees" -f "assignees[]=$RELAY_BOT_ACCOUNT" >/dev/null \
        || { LAST_FAIL="指派机器人失败"; return 1; }
    # 读回核对：等待标签在、要摘的一个都不在、机器人是 assignee
    state=$(read_item "$NUM") || { LAST_FAIL="读回失败"; return 1; }
    labels=$(printf '%s\n' "$state" | sed -n 1p)
    assignees=$(printf '%s\n' "$state" | sed -n 2p)
    has_label "$labels" "$LABEL_PENDING_RELAY" || { LAST_FAIL="读回没有等待标签（实际：$(show_labels "$labels")）"; return 1; }
    for L in "${CLEAR_LABELS[@]}"; do
        has_label "$labels" "$L" && { LAST_FAIL="读回仍有 $L（实际：$(show_labels "$labels")）"; return 1; }
    done
    has_login "$assignees" "$RELAY_BOT_ACCOUNT" || { LAST_FAIL="读回 assignee 里没有 $RELAY_BOT_ACCOUNT"; return 1; }
    return 0
}

# ── 交还维护者 ──
# 等待标签**最后**才摘：它在的时候 greedy 兜底和 self-heal 都不会碰这一条；先摘它，
# 中途失败就会露出一个「只剩触发标签 / 什么都没有」的状态。第 1–3 步失败 = 不摘等待
# 标签、不算交还成功；每一步都可以安全重跑。
handback() {
    local L enc state labels
    gh_write api -X POST "repos/$REPO/issues/$NUM/labels" -f "labels[]=$LABEL_PENDING_HUMAN" >/dev/null \
        || { LAST_FAIL="交还：加 $LABEL_PENDING_HUMAN 失败"; return 1; }
    for L in "${CLEAR_LABELS[@]}"; do
        enc=$(printf '%s' "$L" | jq -sRr @uri)
        gh_write api -X DELETE "repos/$REPO/issues/$NUM/labels/$enc" >/dev/null 2>&1 || true
    done
    state=$(read_item "$NUM") || { LAST_FAIL="交还：读回失败"; return 1; }
    labels=$(printf '%s\n' "$state" | sed -n 1p)
    has_label "$labels" "$LABEL_PENDING_HUMAN" || { LAST_FAIL="交还：读回没有 $LABEL_PENDING_HUMAN"; return 1; }
    for L in "${CLEAR_LABELS[@]}"; do
        has_label "$labels" "$L" && { LAST_FAIL="交还：读回仍有 $L"; return 1; }
    done
    enc=$(printf '%s' "$LABEL_PENDING_RELAY" | jq -sRr @uri)
    gh_write api -X DELETE "repos/$REPO/issues/$NUM/labels/$enc" >/dev/null 2>&1 || true
    state=$(read_item "$NUM") || { LAST_FAIL="交还：摘等待标签后读回失败"; return 1; }
    labels=$(printf '%s\n' "$state" | sed -n 1p)
    has_label "$labels" "$LABEL_PENDING_RELAY" && { LAST_FAIL="交还：等待标签没摘掉"; return 1; }
    return 0
}

if wake_once; then
    say "✅ 已叫醒 $RELAY_BOT_ACCOUNT（#$NUM 挂上 $LABEL_PENDING_RELAY 并重新指派）"
    exit 0
fi
say "叫醒第 1 次失败：$LAST_FAIL，整体重试一次"
if wake_once; then
    say "✅ 已叫醒 $RELAY_BOT_ACCOUNT（重试后成功）"
    exit 0
fi
WAKE_FAIL="$LAST_FAIL"
say "叫醒重试仍失败：$WAKE_FAIL → 交还维护者"
if handback; then
    say "⚠️ 叫醒失败（$WAKE_FAIL），已交还维护者：#$NUM 现在只挂 $LABEL_PENDING_HUMAN"
    exit 3
fi
FINAL=$(read_item "$NUM" 2>/dev/null | sed -n 1p) || FINAL=""
say "❌ 叫醒失败（$WAKE_FAIL），交还维护者也失败（$LAST_FAIL）。实际读回的标签：${FINAL:+$(show_labels "$FINAL")}${FINAL:-读不到}"
exit 4
