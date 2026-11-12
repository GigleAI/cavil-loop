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

# 「维护者」= 既不在允许叫醒名单里、也不是机器人账号的人。账号读不出（已注销等）不算数，
# 由调用方决定往哪边偏。打标签和解除用的是同一个判定。
is_maintainer() {   # <login>
    [ -n "$1" ] && [ "$1" != "?" ] || return 1
    requester_bot_actor_allowed "$1" && return 1
    [ "$(lc "$1")" = "$(lc "$REQUESTER_BOT_ACCOUNT")" ] && return 1
    return 0
}

# 维护者的暂停现在是否还有效（GitHub#106）：按事件编号从小到大读 labeled / unlabeled，
#   · 维护者手打 pending/human（账号读不出也保守地算）→ 进入暂停，记下是谁
#   · 暂停中出现**维护者**摘掉 pending/human，或打上任一触发标签（pending/agent 及其变体、
#     pending/review）→ 暂停解除。机器人 / worker / 读不出的账号摘标签都不算解除
# 再次暂停就重新进入，所以结论只取决于最后一次暂停之后发生了什么。
# 输出仍在暂停中的那次是谁打的；读不到事件、或事件缺编号 → return 2（调用方当「不知道」，拒绝）。
# 排序在拿全所有页之后做：--paginate 下 --jq 是逐页执行的，页内排序管不到跨页。
maintainer_took_over() {
    local n="$1" rows sorted id ev label actor paused="" L resume
    rows=$(gh api --paginate "repos/$REPO/issues/$n/events" \
        --jq '.[] | select(.event == "labeled" or .event == "unlabeled")
              | [(.id // "" | tostring), .event, (.label.name // ""), (.actor.login // "?")] | @tsv') || return 2
    rows=$(printf '%s\n' "$rows" | awk -F'\t' 'NF' ) || return 2
    [ -z "$rows" ] && return 1
    # 没有编号就排不了序：不猜，当「不知道」
    printf '%s\n' "$rows" | awk -F'\t' '$1 !~ /^[0-9]+$/ { bad=1 } END { exit bad }' || return 2
    # 排序单独一步、退出码在这里查：放进 `done < <(...)` 的进程替换里，sort 失败只会让循环
    # 读到空输入，paused 为空 → 误判「没有暂停」而放行。行数对不上同样当「不知道」。
    sorted=$(printf '%s\n' "$rows" | sort -t$'\t' -k1,1n) || return 2
    [ "$(printf '%s\n' "$sorted" | grep -c .)" = "$(printf '%s\n' "$rows" | grep -c .)" ] || return 2
    while IFS=$'\t' read -r id ev label actor; do
        if [ "$ev" = labeled ] && [ "$label" = "$LABEL_PENDING_HUMAN" ]; then
            if [ "$actor" = "?" ]; then paused="(账号未知)"
            elif is_maintainer "$actor"; then paused="$actor"; fi
            continue
        fi
        [ -n "$paused" ] && is_maintainer "$actor" || continue
        resume=""
        if [ "$ev" = unlabeled ] && [ "$label" = "$LABEL_PENDING_HUMAN" ]; then resume=1
        elif [ "$ev" = labeled ]; then
            for L in "${TRIGGER_LABELS_ALL[@]}"; do [ "$label" = "$L" ] && resume=1; done
        fi
        [ -z "$resume" ] || paused=""
    done <<< "$sorted"
    [ -n "$paused" ] || return 1
    printf '%s' "$paused"; return 0
}

# ── 前置检查：任一条不过就拒绝，不发写请求 ──
# 账号资格：和合并后通知同一关（_lib.sh 的 requester_bot_check_actor）
requester_bot_check_actor || reject "$REQUESTER_BOT_REASON"

ITEM_JSON=$(gh api "repos/$REPO/issues/$NUM") || reject "读不到 #$NUM"
IS_PR=$(printf '%s' "$ITEM_JSON" | jq -r 'has("pull_request") and .pull_request != null')
ITEM_KIND=issue; [ "$IS_PR" != true ] || ITEM_KIND=pr
[ "$(printf '%s' "$ITEM_JSON" | jq -r '.state')" = open ] || reject "#$NUM 不是打开状态"

# 是不是机器人提的需求：和合并后通知共用同一个判定（_lib.sh 的 requester_bot_item_origin）。
# 这里「判不了」和「明确不是」一样拒绝——除非项目打开了「非机器人条目也可叫醒」（GitHub#133）：
# 那时「关联确定、但不是机器人提的」和「PR 确定没有关联」两类改走 MODE=any；
# 「判不了」（读失败、关联有歧义、关联的是 PR）不管开关一律拒绝。
MODE=bot
ORIGIN_RC=0; requester_bot_item_origin "$NUM" "$ITEM_JSON" || ORIGIN_RC=$?
if [ "$ORIGIN_RC" = 0 ]; then
    ORIGIN="$REQUESTER_BOT_ORIGIN"
elif [ "$ORIGIN_RC" = 1 ] && requester_bot_wake_any_item \
     && { [ "$REQUESTER_BOT_ORIGIN_CLASS" = linked-other ] || [ "$REQUESTER_BOT_ORIGIN_CLASS" = none ]; }; then
    MODE=any
    # 关联确定时两边都查维护者接手；确定没有关联时只查条目本身
    ORIGIN="${REQUESTER_BOT_LINKED:-$NUM}"
else
    reject "$REQUESTER_BOT_REASON"
fi

CUR_LABELS=$(printf '%s' "$ITEM_JSON" | jq -r '[.labels[].name] | join("\u001f")')
has_label "$CUR_LABELS" "$LABEL_PENDING_HUMAN" \
    && reject "#$NUM 挂着 ${LABEL_PENDING_HUMAN}（维护者在处理 / 复审轮次用尽），只交维护者"
for n in $(printf '%s\n%s\n' "$NUM" "$ORIGIN" | awk '!seen[$0]++'); do
    rc=0; who=$(maintainer_took_over "$n") || rc=$?
    case "$rc" in
        0) reject "#$n 由维护者 $who 手动标过 ${LABEL_PENDING_HUMAN}、之后没有维护者解除（摘掉它或重新打触发标签），只交维护者" ;;
        2) reject "读不到 #$n 的标签历史，无法确认维护者是否接手过" ;;
    esac
done

# ── 非机器人条目：交接评论（GitHub#133，规则见 docs/requester-bot*.md「交接协议」）──
# 本账号在条目上编号最大的那条评论就是交接评论 C，里面要恰好一行转交标记。脚本**不编辑 C**
# （评论编辑接口没有条件写入，整段写回会覆盖别人同时做的修改）：挂上等待标签后另发一条叫醒记录，
# 写明这次挂标签的事件编号、C 的编号和 C 的正文指纹；机器人按事件编号找到叫醒记录，再回到 C 核对指纹。
HANDOFF_PY="$SCRIPT_DIR/requester_bot_handoff.py"
TMPD=""
# 本账号在该条目上编号最大的评论编号（大小写不敏感比账号）。给了 C 的编号时，跳过本账号为 C
# 发的叫醒记录（这次运行里重试前发出的那条）。读失败 return 1，没有输出空
my_latest_comment() {   # [跳过为这条评论发的叫醒记录]
    local rows me id who b64 max="" body
    me=$(lc "$REQUESTER_BOT_ME")
    rows=$(gh api --paginate "repos/$REPO/issues/$NUM/comments" \
        --jq '.[] | [(.id // "" | tostring), (.user.login // ""), ((.body // "") | @base64)] | @tsv') || return 1
    while IFS=$'\t' read -r id who b64; do
        [[ "$id" =~ ^[0-9]+$ ]] && [ "$(lc "$who")" = "$me" ] || continue
        if [ -n "${1:-}" ]; then
            body=$(printf '%s' "$b64" | base64 -d 2>/dev/null) || return 1
            [[ "$body" == *"<!-- requester-bot-wake: event="*" comment=$1 sha256="* ]] && continue
        fi
        [ -n "$max" ] && [ "$id" -le "$max" ] || max="$id"
    done <<< "$rows"
    printf '%s' "$max"
}
# 读一条评论的正文到文件；作者必须是本账号、必须属于本条目。读失败 return 1，对不上 return 2
read_comment() {   # <评论编号> <输出文件>
    local j
    j=$(gh api "repos/$REPO/issues/comments/$1") || return 1
    printf '%s' "$j" | jq -e --arg me "$(lc "$REQUESTER_BOT_ME")" --arg n "/issues/$NUM" \
        '((.user.login // "") | ascii_downcase) == $me and ((.issue_url // "") | endswith($n))' >/dev/null || return 2
    printf '%s' "$j" | jq -j '.body // ""' > "$2"
}
if [ "$MODE" = any ]; then
    TMPD=$(mktemp -d); trap 'rm -rf "$TMPD"' EXIT
    C_ID=$(my_latest_comment) || reject "读不到 #$NUM 的评论，无法核对交接评论"
    [ -n "$C_ID" ] || reject "#$NUM 上没有本账号（${REQUESTER_BOT_ME}）发的评论：非机器人条目要先发一条写明转给谁的交接评论"
    rc=0; read_comment "$C_ID" "$TMPD/c0" || rc=$?
    [ "$rc" = 0 ] || reject "读不到交接评论 ${C_ID}（或它不属于 #$NUM / 不是本账号发的）"
    rc=0; TARGET=$(python3 "$HANDOFF_PY" check "$TMPD/c0") || rc=$?
    # 叫醒成功后本账号最新的一条是叫醒记录（没有转交标记），所以复用旧交接评论也落在这里
    [ "$rc" = 0 ] || reject "本账号在 #$NUM 上最新的评论 $C_ID 不是合格的交接评论：${TARGET:-转交标记核对失败}（要单独一行 <!-- requester-bot-forward-to: <对象> -->；一条交接评论只能叫醒一次，再叫醒要先发新的）"
    python3 "$HANDOFF_PY" normalize "$TMPD/c0" > "$TMPD/b0" || reject "交接评论 $C_ID 读取失败"
    C_FP=$(python3 "$HANDOFF_PY" fingerprint "$TMPD/c0") || reject "交接评论 $C_ID 算指纹失败"
fi

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
        has_label "$labels" "$L" && { LAST_FAIL="读回仍有 ${L}（实际：$(show_labels "$labels")）"; return 1; }
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

# ── 非机器人条目的叫醒（GitHub#133）──
# 一次尝试 = 先摘后挂等待标签（保证产生一个新的挂标签事件）→ 读回 → 找本次事件 E →
# 重读 C → 发叫醒记录 → 读回叫醒记录 → 再读一次 C。
# 返回 0 成功；1 可以重试（读写失败、读回不符、事件不是恰好一个）；
#      2 不重试、直接交还（C 被删 / 被改 / 已不是本账号最新评论，超过时限）
# 时限从开始叫醒算，默认 300 秒：机器人在「挂了标签、还没有对应的叫醒记录」时判「准备中」，留的余量是 30 分钟。
WAKE_DEADLINE_SECS="${REQUESTER_BOT_WAKE_DEADLINE_SECS:-300}"
case "$WAKE_DEADLINE_SECS" in ''|*[!0-9]*) WAKE_DEADLINE_SECS=300 ;; esac
WAKE_START=$(date +%s)
E_ID=""; R_ID=""
past_deadline() { [ $(( $(date +%s) - WAKE_START )) -ge "$WAKE_DEADLINE_SECS" ]; }
max_event_id() {
    local rows
    rows=$(gh api --paginate "repos/$REPO/issues/$NUM/events" --jq '.[] | (.id // "" | tostring)') || return 1
    printf '%s\n' "$rows" | awk 'NF { if ($1 !~ /^[0-9]+$/) bad = 1; else if ($1 + 0 > m + 0) m = $1 } END { if (bad) exit 1; print m + 0 }'
}
# M 之后本账号挂等待标签的事件：恰好一个就输出它
new_wait_event() {   # <M>
    local rows
    rows=$(gh api --paginate "repos/$REPO/issues/$NUM/events" \
        --jq '.[] | select(.event == "labeled") | [(.id // "" | tostring), (.label.name // ""), (.actor.login // "")] | @tsv') || return 1
    printf '%s\n' "$rows" | awk -F'\t' -v m="$1" -v l="$LABEL_PENDING_REQUESTER_BOT" -v me="$(lc "$REQUESTER_BOT_ME")" \
        'NF && $1 ~ /^[0-9]+$/ && $1 + 0 > m + 0 && $2 == l && tolower($3) == me { n++; e = $1 } END { if (n == 1) print e; else print "count=" n + 0 }'
}
# 重读 C：仍在、仍是本账号最新评论（这次运行发的叫醒记录不算）、规范化正文 = B0。
# 0 好；1 读失败（可重试）；2 对不上（不重试）
recheck_c() {
    local cur rc=0
    cur=$(my_latest_comment "$C_ID") || { LAST_FAIL="重读评论列表失败"; return 1; }
    [ "$cur" = "$C_ID" ] || { LAST_FAIL="交接评论 $C_ID 已不在或已不是本账号最新的评论（现在是 ${cur:-无}）"; return 2; }
    read_comment "$C_ID" "$TMPD/cr" || rc=$?
    [ "$rc" = 0 ] || { LAST_FAIL="重读交接评论 $C_ID 失败"; [ "$rc" = 1 ] && return 1; return 2; }
    python3 "$HANDOFF_PY" normalize "$TMPD/cr" > "$TMPD/cr.norm" 2>/dev/null \
        && cmp -s "$TMPD/cr.norm" "$TMPD/b0" || { LAST_FAIL="交接评论 $C_ID 的内容和核对时不一样（被改过）"; return 2; }
    return 0
}
wake_any_once() {
    local m enc e rc rid
    m=$(max_event_id) || { LAST_FAIL="读不到标签事件"; return 1; }
    has_label "$(read_item "$NUM" 2>/dev/null || true)" "$LABEL_PENDING_REQUESTER_BOT" && {
        enc=$(printf '%s' "$LABEL_PENDING_REQUESTER_BOT" | jq -sRr @uri)
        gh_write api -X DELETE "repos/$REPO/issues/$NUM/labels/$enc" >/dev/null 2>&1 || true
    }
    wake_once || return 1
    e=$(new_wait_event "$m") || { LAST_FAIL="读不到挂标签事件"; return 1; }
    case "$e" in ''|count=*) LAST_FAIL="本账号这次挂等待标签的事件不是恰好一个（${e:-count=0}）"; return 1 ;; esac
    E_ID="$e"
    rc=0; recheck_c || rc=$?
    [ "$rc" = 0 ] || return "$rc"
    if past_deadline; then LAST_FAIL="超过 ${WAKE_DEADLINE_SECS} 秒还没发出叫醒记录，不再发"; return 2; fi
    python3 "$HANDOFF_PY" receipt "$E_ID" "$C_ID" "$C_FP" "$TARGET" > "$TMPD/receipt.md" \
        && jq -n --rawfile b "$TMPD/receipt.md" '{body: $b}' > "$TMPD/receipt.json" || { LAST_FAIL="生成叫醒记录失败"; return 1; }
    rid=$(gh_write api -X POST "repos/$REPO/issues/$NUM/comments" --input "$TMPD/receipt.json" --jq '.id') \
        || { LAST_FAIL="发叫醒记录失败"; return 1; }
    [[ "$rid" =~ ^[0-9]+$ ]] || { LAST_FAIL="发叫醒记录后没拿到评论编号"; return 1; }
    R_ID="$rid"
    # 读回叫醒记录：三项都对上才算发出去了
    rc=0; read_comment "$R_ID" "$TMPD/rr" || rc=$?
    [ "$rc" = 0 ] || { LAST_FAIL="读回叫醒记录失败"; return 1; }
    python3 "$HANDOFF_PY" verify "$TMPD/rr" "$E_ID" "$C_ID" "$C_FP" >/dev/null \
        || { LAST_FAIL="读回的叫醒记录编号 / 指纹不对"; return 1; }
    # 发记录的同时 C 被改过：机器人会判「出错」交人，这边也不报成功
    rc=0; recheck_c || rc=$?
    [ "$rc" = 0 ] || return "$rc"
    return 0
}
WOKE=""
if [ "$MODE" = any ]; then
    rc=0; wake_any_once || rc=$?
    if [ "$rc" = 0 ]; then
        WOKE="#$NUM 挂上 ${LABEL_PENDING_REQUESTER_BOT}；交接评论 ${C_ID}，挂标签事件 ${E_ID}，叫醒记录 ${R_ID}，转给：$TARGET"
    elif [ "$rc" = 1 ]; then
        say "叫醒第 1 次失败：${LAST_FAIL}，整体重试一次"
        rc=0; wake_any_once || rc=$?
        [ "$rc" != 0 ] || WOKE="重试后成功，#$NUM 挂上 ${LABEL_PENDING_REQUESTER_BOT}；交接评论 ${C_ID}，挂标签事件 ${E_ID}，叫醒记录 ${R_ID}，转给：$TARGET"
    fi
    [ "$rc" != 2 ] || NO_RETRY=1
elif wake_once; then
    WOKE="#$NUM 挂上 $LABEL_PENDING_REQUESTER_BOT"
else
    say "叫醒第 1 次失败：${LAST_FAIL}，整体重试一次"
    if wake_once; then WOKE="重试后成功，#$NUM 挂上 $LABEL_PENDING_REQUESTER_BOT"; fi
fi
# 唯一的成功出口：交接已读回确认，才通知 webhook
if [ -n "$WOKE" ]; then
    say "✅ 已叫醒 ${REQUESTER_BOT_ACCOUNT}（${WOKE}）"
    requester_bot_webhook_notify "$NUM" "$ITEM_KIND"
    [ -z "$REQUESTER_BOT_WEBHOOK_RESULT" ] || say "$REQUESTER_BOT_WEBHOOK_RESULT"
    exit 0
fi
WAKE_FAIL="$LAST_FAIL"
if [ -n "${NO_RETRY:-}" ]; then
    say "叫醒失败：${WAKE_FAIL}（这种情况不重试）→ 交还维护者"
else
    say "叫醒重试仍失败：$WAKE_FAIL → 交还维护者"
fi
if handback; then
    say "⚠️ 叫醒失败（${WAKE_FAIL}），已交还维护者：#$NUM 现在只挂 $LABEL_PENDING_HUMAN"
    exit 3
fi
FINAL=$(read_item "$NUM" 2>/dev/null) || FINAL=""
say "❌ 叫醒失败（${WAKE_FAIL}），交还维护者也失败（${LAST_FAIL}）。实际读回的标签：${FINAL:+$(show_labels "$FINAL")}${FINAL:-读不到}"
exit 4
