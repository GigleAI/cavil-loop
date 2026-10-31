#!/usr/bin/env bash
# 叫醒外部需求机器人（GitHub#95 / #97）：worker / reviewer 发完评论后跑它。
#
#   bash notify-requester-bot.sh --config <项目配置> <issue 或 PR 编号>
#
# 模板里的「外部需求机器人交接规则」段已带好 --config，worker 只补编号。
# 早期的入口名 notify-relay.sh 仍可用（转发到这里）。
#
# 做的事（GitHub#100）：加等待标签 → 摘掉全部触发标签、doing/agent、pending/review → 读回核对
# → 确认成功后调一次 webhook（配了才发）。issue 和 PR 做法相同，不再指派机器人、不再请求它
# review：机器人收不到那些事件，实际全靠它自己的定时扫描；webhook 一到它就来全量拉取挂着
# 等待标签的条目。失败整体重试一次；仍失败就交还维护者。
#
# 退出码：
#   0 叫醒成功（只说明标签改好了；webhook 成败只记一行、不影响退出码；不说明机器人已经转达）
#   2 前置检查拒绝，或功能没配全 —— 没发任何写请求，标签不动
#   3 叫醒失败，已交还维护者（条目上只剩 pending/human，没有等待标签）
#   4 交还也失败 —— 输出里是实际读回的标签；**不要**对外写「已交人」
# 只有退出码 0 的那一个出口会调 webhook：2 / 3 / 4 时交接都还没确认成功。
#
# 不读评论内容，也不按评论去重：去重会把「刚发的这条汇报」当成已汇报，挡住首次叫醒。
#
# 写用 gh_write（与 worker 自己发评论是同一个身份），读用 gh。所有输出走 stdout：
# _lib.sh 顶部把 fd 2 永久指向了 /dev/null，worker 看不到 stderr。
set -euo pipefail

usage() { echo "用法: notify-requester-bot.sh --config <项目配置> <issue 或 PR 编号>"; exit 2; }

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

say() { printf '%s\n' "$*"; log "notify-requester-bot #$NUM: $*" 2>/dev/null || true; }
reject() { say "❌ 拒绝叫醒（标签未改动）：$*"; exit 2; }

if ! requester_bot_enabled; then
    reject "本项目没有配全外部需求机器人功能，缺：$(requester_bot_missing_settings)（早期的 RELAY_* 名字也认）"
fi
[ -z "$REQUESTER_BOT_NAME_CONFLICTS" ] || say "⚠️ 配置里新旧名字同时填了且不一样：$REQUESTER_BOT_NAME_CONFLICTS"
trigger_labels_array

lc() { requester_bot_lc "$1"; }

# 交接要摘掉的标签：全部触发标签 + doing/agent + pending/review（去空去重）
mapfile -t CLEAR_LABELS < <(printf '%s\n' "${TRIGGER_LABELS_ALL[@]}" "$LABEL_AGENT_DOING" "${LABEL_PENDING_REVIEW:-}" \
    | awk 'NF && !seen[$0]++')

# 现读条目的标签（\x1f 分隔）
read_item() {
    gh api "repos/$REPO/issues/$1" --jq '[.labels[].name] | join("\u001f")'
}

has_label() {   # <labels(\x1f)> <label>
    case $'\x1f'"$1"$'\x1f' in *$'\x1f'"$2"$'\x1f'*) return 0 ;; esac
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
        requester_bot_actor_allowed "$a" && continue
        [ "$(lc "$a")" = "$(lc "$REQUESTER_BOT_ACCOUNT")" ] && continue
        printf '%s' "$a"; return 0
    done <<< "$actors"
    return 1
}

# ── 前置检查：任一条不过就拒绝，不发写请求 ──
# 账号资格：和合并后通知同一关（_lib.sh 的 requester_bot_check_actor）
requester_bot_check_actor || reject "$REQUESTER_BOT_REASON"

ITEM_JSON=$(gh api "repos/$REPO/issues/$NUM") || reject "读不到 #$NUM"
IS_PR=$(printf '%s' "$ITEM_JSON" | jq -r 'has("pull_request") and .pull_request != null')
ITEM_KIND=issue; [ "$IS_PR" != true ] || ITEM_KIND=pr
[ "$(printf '%s' "$ITEM_JSON" | jq -r '.state')" = open ] || reject "#$NUM 不是打开状态"

# 是不是机器人提的需求：和合并后通知共用同一个判定（_lib.sh 的 requester_bot_item_origin）。
# 这里「判不了」和「明确不是」一样拒绝。
requester_bot_item_origin "$NUM" "$ITEM_JSON" || reject "$REQUESTER_BOT_REASON"
ORIGIN="$REQUESTER_BOT_ORIGIN"

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
    local L enc labels
    gh_write api -X POST "repos/$REPO/issues/$NUM/labels" -f "labels[]=$LABEL_PENDING_REQUESTER_BOT" >/dev/null \
        || { LAST_FAIL="加等待标签失败"; return 1; }
    for L in "${CLEAR_LABELS[@]}"; do
        enc=$(printf '%s' "$L" | jq -sRr @uri)
        # 404 = 本来就不在；别的失败交给下面的读回核对
        gh_write api -X DELETE "repos/$REPO/issues/$NUM/labels/$enc" >/dev/null 2>&1 || true
    done
    # 读回核对：等待标签在、要摘的一个都不在
    labels=$(read_item "$NUM") || { LAST_FAIL="读回失败"; return 1; }
    has_label "$labels" "$LABEL_PENDING_REQUESTER_BOT" || { LAST_FAIL="读回没有等待标签（实际：$(show_labels "$labels")）"; return 1; }
    for L in "${CLEAR_LABELS[@]}"; do
        has_label "$labels" "$L" && { LAST_FAIL="读回仍有 $L（实际：$(show_labels "$labels")）"; return 1; }
    done
    return 0
}

# ── 交还维护者 ──
# 等待标签**最后**才摘：它在的时候 greedy 兜底和 self-heal 都不会碰这一条；先摘它，
# 中途失败就会露出一个「只剩触发标签 / 什么都没有」的状态。第 1–3 步失败 = 不摘等待
# 标签、不算交还成功。每一步都可以安全重跑。
handback() {
    local L enc labels
    gh_write api -X POST "repos/$REPO/issues/$NUM/labels" -f "labels[]=$LABEL_PENDING_HUMAN" >/dev/null \
        || { LAST_FAIL="交还：加 $LABEL_PENDING_HUMAN 失败"; return 1; }
    for L in "${CLEAR_LABELS[@]}"; do
        enc=$(printf '%s' "$L" | jq -sRr @uri)
        gh_write api -X DELETE "repos/$REPO/issues/$NUM/labels/$enc" >/dev/null 2>&1 || true
    done
    labels=$(read_item "$NUM") || { LAST_FAIL="交还：读回失败"; return 1; }
    has_label "$labels" "$LABEL_PENDING_HUMAN" || { LAST_FAIL="交还：读回没有 $LABEL_PENDING_HUMAN"; return 1; }
    for L in "${CLEAR_LABELS[@]}"; do
        has_label "$labels" "$L" && { LAST_FAIL="交还：读回仍有 $L"; return 1; }
    done
    enc=$(printf '%s' "$LABEL_PENDING_REQUESTER_BOT" | jq -sRr @uri)
    gh_write api -X DELETE "repos/$REPO/issues/$NUM/labels/$enc" >/dev/null 2>&1 || true
    labels=$(read_item "$NUM") || { LAST_FAIL="交还：摘等待标签后读回失败"; return 1; }
    has_label "$labels" "$LABEL_PENDING_REQUESTER_BOT" && { LAST_FAIL="交还：等待标签没摘掉"; return 1; }
    return 0
}

WOKE=""
if wake_once; then
    WOKE="#$NUM 挂上 $LABEL_PENDING_REQUESTER_BOT"
else
    say "叫醒第 1 次失败：$LAST_FAIL，整体重试一次"
    if wake_once; then WOKE="重试后成功，#$NUM 挂上 $LABEL_PENDING_REQUESTER_BOT"; fi
fi
# 唯一的成功出口：交接已读回确认，才通知 webhook
if [ -n "$WOKE" ]; then
    say "✅ 已叫醒 $REQUESTER_BOT_ACCOUNT（$WOKE）"
    requester_bot_webhook_notify "$NUM" "$ITEM_KIND"
    [ -z "$REQUESTER_BOT_WEBHOOK_RESULT" ] || say "$REQUESTER_BOT_WEBHOOK_RESULT"
    exit 0
fi
WAKE_FAIL="$LAST_FAIL"
say "叫醒重试仍失败：$WAKE_FAIL → 交还维护者"
if handback; then
    say "⚠️ 叫醒失败（$WAKE_FAIL），已交还维护者：#$NUM 现在只挂 $LABEL_PENDING_HUMAN"
    exit 3
fi
FINAL=$(read_item "$NUM" 2>/dev/null) || FINAL=""
say "❌ 叫醒失败（$WAKE_FAIL），交还维护者也失败（$LAST_FAIL）。实际读回的标签：${FINAL:+$(show_labels "$FINAL")}${FINAL:-读不到}"
exit 4
