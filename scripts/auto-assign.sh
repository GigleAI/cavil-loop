#!/usr/bin/env bash
# 新建的 issue / PR 没有 assignee 时，把「提出这个需求的人」设为 assignee（GitHub#690）。
#
# 由 agent-poll.sh 每轮末尾调一次（auto_assign_tick，_lib.sh），**独立子进程**：这里任何失败——
# 读不到、写不进、脚本自己出错——都不碰这一轮的派工、清理和退出码。
# Why a script of its own and not part of project-auto-add.sh: that one syncs board cards from an
# updated-time stream; this one walks issue numbers once each and writes assignees — different
# progress, different writes.
#
# ── 提出者怎么认（只在这里认，worker 提示词和客户端都不另写一套）──
#   只认真人账号：账号类型 User，且不是外部需求机器人（REQUESTER_BOT_ACCOUNT，GitHub#97 起不指派它）。
#   issue / PR 作者是真人、不是 loop 的写入账号 → 作者本人。
#   作者是写入账号：
#     PR    来源仓库是本仓库，对应 issue 用派工现成的前两步（分支名 branch_to_issue_num → 正文
#           pr_body_linked_issue）；**不用**第三步「当成 PR 自己的编号」的兜底。对上的是 PR、或就是它自己 → 没有。
#           对应 issue 的提出者按本表接着找。
#     issue 拆出的子项（split_parent_check：写入账号建的 + 有父 issue + 拆分标记指向它）→ 父 issue 的提出者。
#           不是子项 → 没有（daemon 的失败报告、agent 代开的 issue）。
#   往上最多找 3 层；超过 = 没有。
#   写入账号建的条目刚建好时还没挂父 issue / 正文还没写关联：建好不满 AA_YOUNG_SECS 时找不到来源算
#   「判不了」，过了才算「没有」。
#
# ── 三种结果分开（L36）──
#   找到 / 确定没有 / 判不了。判不了 = 任何一次读取失败、字段缺失：这一轮不写、不记，下一轮重来。
#   条目本身读回 404 / 410 而同一时刻仓库本身读得到 = 已不在（被删 / 转走）；其他错误都是判不了。
#
# ── 按编号续读（issue 与 PR 共用一套递增编号）──
#   $STATE_DIR/auto-assign.json：{"cursor": N, "done": {"<n>": "<结果>"}, "pending": {"<n>": 连续判不了的轮数}}
#   · 第一次运行：cursor = 当前最大编号，只记不处理（不回头补历史条目）
#   · 每轮按新建时间倒序分页读到编号 ≤ cursor 为止；任何一页失败 = 本轮什么都不处理、不推进
#   · 从小到大处理；有结果的记进 done，判不了的记进 pending（永不放弃，见下）
#   · cursor 只推进到「从 cursor 往上连续都有结果、而且建好已满 AA_SETTLE_SECS」的最后一个编号：
#     第一个判不了的挡在那里；刚建好的也先不越过（列表接口偶尔慢几秒才列出刚建的条目，越过去它的
#     编号就再也不会被读到）。读到的编号之间的空缺（被删 / 转走）不挡
#   · done / pending 只存 cursor 之后的编号；cursor 以前的永远不会再读，人删掉的指派也就不会被加回
#   · 一直判不了的永不放弃：满 AA_SLOW_AFTER 轮后改为每 AA_SLOW_EVERY 轮重试一次，日志只提醒一次
#
# ── 写前整条重算（L41）──
#   判定得出「找到」后，把整条判定重新读、重新算一遍，判定依据（条目编号 / 类型 / 开关状态 / 作者及类型 /
#   assignee 列表；PR 加最新提交 / 目标分支 / 来源仓库 / 分支名 / 正文关联编号；往上每一层的编号、作者、
#   父 issue 地址、拆分核对结果）两次逐字相同才写；不同、缺字段、读失败 → 不写、不记，下一轮从头判。
#   写用 gh_write（写入身份），读用轮询身份；写完读回：有这个人 = 已指派；读回成功没有这个人 = GitHub
#   不接受（例如没有仓库权限的外部账号），记「不可指派」写一行日志；读回失败 = 不记（下一轮会看到已有人）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec 8>&2
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"
exec 2>&8 8>&-

auto_assign_enabled || exit 0

AA_STATE="$STATE_DIR/auto-assign.json"
AA_PAGE=100
AA_MAX_PAGES=200          # 防御：分页死循环时当失败处理
AA_MAX_DEPTH=3
AA_YOUNG_SECS=600      # 写入账号建的条目，找不到来源先等这么久
AA_SETTLE_SECS=300    # 建好满这么久才让 cursor 越过它
AA_SLOW_AFTER=30
AA_SLOW_EVERY=10

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

aa_log() { log "自动指派：$*"; }
NOW=$(date +%s)

# ── 状态文件 ──
if [ -f "$AA_STATE" ]; then
    if ! jq -e 'type == "object" and (.cursor | type) == "number" and (.done | type) == "object" and (.pending | type) == "object"' \
            "$AA_STATE" >/dev/null 2>&1; then
        # 不覆盖：覆盖就等于把进度改成「现在」，停机期间新建的条目再也补不上。要人看一眼再删
        aa_log "⚠️ 状态文件 $AA_STATE 读不懂，本轮跳过；确认无用后删掉它，会从当前最大编号重新起算"
        exit 0
    fi
    cp "$AA_STATE" "$WORK/state.json"
else
    # 第一次：当前最大编号就是起点，这一轮不处理任何条目
    if ! top=$(gh api "repos/$REPO/issues?state=all&sort=created&direction=desc&per_page=1" --jq '[.[].number] | max // 0' 2>/dev/null) \
       || ! [[ "$top" =~ ^[0-9]+$ ]]; then
        aa_log "读不到本仓库最新的条目编号，下一轮再起算"
        exit 0
    fi
    jq -n --argjson c "$top" '{cursor: $c, done: {}, pending: {}}' > "$WORK/state.json"
    mv "$WORK/state.json" "$AA_STATE"
    aa_log "开始生效：编号 #$top 之后新建的 issue / PR 会自动指派提出者"
    exit 0
fi
CURSOR=$(jq -r '.cursor' "$WORK/state.json")

ME=$(write_identity_login)
if [ -z "$ME" ]; then
    aa_log "读不到 loop 的写入账号，分不清哪些条目是 agent 开的，本轮跳过"
    exit 0
fi
ME_LC=$(requester_bot_lc "$ME")
BOT_LC=$(requester_bot_lc "${REQUESTER_BOT_ACCOUNT:-}")

# ── 分页读到 cursor 为止 ──
: > "$WORK/list.jsonl"
page=1
while :; do
    if [ "$page" -gt "$AA_MAX_PAGES" ]; then aa_log "列表超过 $AA_MAX_PAGES 页还没读到上次的进度 #${CURSOR}，本轮跳过"; exit 0; fi
    if ! gh api "repos/$REPO/issues?state=all&sort=created&direction=desc&per_page=$AA_PAGE&page=$page" > "$WORK/page.json" 2>/dev/null \
       || ! jq -e 'type == "array" and all(.[]; (.number | type) == "number" and (.created_at | type) == "string")' "$WORK/page.json" >/dev/null 2>&1; then
        aa_log "读条目列表第 $page 页失败，本轮不处理，下一轮重读"
        exit 0
    fi
    jq -c --argjson c "$CURSOR" '.[] | select(.number > $c) | {number, created_at}' "$WORK/page.json" >> "$WORK/list.jsonl"
    n=$(jq 'length' "$WORK/page.json"); low=$(jq '[.[].number] | min // 0' "$WORK/page.json")
    if [ "$n" -lt "$AA_PAGE" ] || [ "$low" -le "$CURSOR" ]; then break; fi
    page=$((page + 1))
done
jq -s 'unique_by(.number) | sort_by(.number)' "$WORK/list.jsonl" > "$WORK/list.json"

# ── 读一个条目：0 = 读到（stdout JSON），1 = 判不了，2 = 已不在 ──
aa_get() {   # <仓库> <路径>
    local err="$WORK/err" out
    if out=$(gh api "repos/$1/$2" 2>"$err") && [ -n "$out" ] && printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1; then
        printf '%s' "$out"; return 0
    fi
    if grep -qE 'HTTP (404|410)' "$err" 2>/dev/null && gh api "repos/$1" --jq .full_name >/dev/null 2>&1; then
        return 2
    fi
    return 1
}

age_of() { jq -rn --arg t "$1" '($t | fromdateiso8601) as $c | (now | floor) - $c' 2>/dev/null || echo 0; }

# ── 判定：AA_RES = found|none|unknown|gone|closed|assigned_already；AA_WHO；AA_DOC = 判定依据 ──
# aa_resolve <仓库> <编号> <层数>：层数 0 = 要指派的条目本身
aa_resolve() {
    local repo="$1" num="$2" depth="$3" ij rc=0 author atype isPR state created pj linked ref sha hrepo base body \
          url prc=0
    if [ "$depth" -gt "$AA_MAX_DEPTH" ]; then AA_RES=none; AA_DOC+=$'\n'"depth>$AA_MAX_DEPTH"; return; fi
    ij=$(aa_get "$repo" "issues/$num") || rc=$?
    if [ "$rc" = 2 ]; then
        if [ "$depth" = 0 ]; then AA_RES=gone; else AA_RES=none; fi
        AA_DOC+=$'\n'"$repo#$num gone"; return
    fi
    [ "$rc" = 0 ] || { AA_RES=unknown; return; }
    if ! printf '%s' "$ij" | jq -e '(.number|type)=="number" and (.state|type)=="string" and (.user.login|type)=="string"
            and (.user.type|type)=="string" and (.assignees|type)=="array" and (.created_at|type)=="string"' >/dev/null 2>&1; then
        AA_RES=unknown; return
    fi
    author=$(printf '%s' "$ij" | jq -r '.user.login'); atype=$(printf '%s' "$ij" | jq -r '.user.type')
    isPR=$(printf '%s' "$ij" | jq -r 'if .pull_request then "pr" else "issue" end')
    state=$(printf '%s' "$ij" | jq -r '.state'); created=$(printf '%s' "$ij" | jq -r '.created_at')
    url=$(printf '%s' "$ij" | jq -r '.parent_issue_url // ""')
    AA_DOC+=$'\n'"$repo#$num $isPR state=$state author=$author/$atype parent=$url"
    if [ "$depth" = 0 ]; then
        AA_DOC+=" assignees=$(printf '%s' "$ij" | jq -c '[.assignees[].login] | sort')"
        [ "$state" = open ] || { AA_RES=closed; return; }
        if [ "$(printf '%s' "$ij" | jq '.assignees | length')" != 0 ]; then AA_RES=assigned_already; return; fi
    fi
    if [ "$atype" != User ] || { [ -n "$BOT_LC" ] && [ "$(requester_bot_lc "$author")" = "$BOT_LC" ]; }; then
        AA_RES=none; return
    fi
    if [ "$(requester_bot_lc "$author")" != "$ME_LC" ]; then AA_RES=found; AA_WHO="$author"; return; fi

    # 作者是写入账号：往上找来源
    if [ "$isPR" = pr ]; then
        if [ "$repo" != "$REPO" ]; then AA_RES=none; return; fi
        rc=0; pj=$(aa_get "$repo" "pulls/$num") || rc=$?
        [ "$rc" = 0 ] || { AA_RES=unknown; return; }
        if ! printf '%s' "$pj" | jq -e '(.head.ref|type)=="string" and (.head.sha|type)=="string" and (.base.ref|type)=="string"
                and (.head.repo == null or (.head.repo.full_name|type)=="string")' >/dev/null 2>&1; then
            AA_RES=unknown; return
        fi
        ref=$(printf '%s' "$pj" | jq -r '.head.ref'); sha=$(printf '%s' "$pj" | jq -r '.head.sha')
        hrepo=$(printf '%s' "$pj" | jq -r '.head.repo.full_name // ""'); base=$(printf '%s' "$pj" | jq -r '.base.ref')
        body=$(printf '%s' "$pj" | jq -r '.body // ""')
        linked="$(branch_to_issue_num "$ref")"
        [ -n "$linked" ] || linked=$(printf '%s' "$body" | pr_body_linked_issue)
        AA_DOC+=" head=$sha ref=$ref from=$hrepo base=$base linked=$linked"
        if [ "$(requester_bot_lc "$hrepo")" != "$(requester_bot_lc "$REPO")" ]; then AA_RES=none; return; fi
        if [ -z "$linked" ] || [ "$linked" = "$num" ]; then
            if [ "$(age_of "$created")" -lt "$AA_YOUNG_SECS" ]; then AA_RES=unknown; else AA_RES=none; fi
            return
        fi
        aa_resolve_source "$repo" "$linked" "$((depth + 1))"
        return
    fi
    split_parent_check "$num" "$ij" || prc=$?
    AA_DOC+=" split=$prc:$SPLIT_PARENT_REPO#$SPLIT_PARENT_NUM"
    case "$prc" in
        0) aa_resolve_source "$SPLIT_PARENT_REPO" "$SPLIT_PARENT_NUM" "$((depth + 1))" ;;
        2) AA_RES=unknown ;;
        *) if [ "$(age_of "$created")" -lt "$AA_YOUNG_SECS" ]; then AA_RES=unknown; else AA_RES=none; fi ;;
    esac
}
# 来源必须是 issue：对上的是 PR → 没有
aa_resolve_source() {   # <仓库> <编号> <层数>
    local rc=0 ij
    ij=$(aa_get "$1" "issues/$2") || rc=$?
    if [ "$rc" = 1 ]; then AA_RES=unknown; return; fi
    if [ "$rc" = 0 ] && printf '%s' "$ij" | jq -e '.pull_request' >/dev/null 2>&1; then
        AA_DOC+=$'\n'"$1#$2 is-pr"; AA_RES=none; return
    fi
    aa_resolve "$1" "$2" "$3"
}

judge() {   # <编号> → AA_RES / AA_WHO / AA_DOC
    AA_RES=unknown; AA_WHO=""; AA_DOC=""
    aa_resolve "$REPO" "$1" 0
}

# ── 逐条处理 ──
set_done()    { jq --arg n "$1" --arg v "$2" '.done[$n] = $v | del(.pending[$n])' "$WORK/state.json" > "$WORK/s.tmp" && mv "$WORK/s.tmp" "$WORK/state.json"; }
bump_pending() {   # <编号> → 新的连续轮数
    jq --arg n "$1" '.pending[$n] = ((.pending[$n] // 0) + 1)' "$WORK/state.json" > "$WORK/s.tmp" && mv "$WORK/s.tmp" "$WORK/state.json"
    jq -r --arg n "$1" '.pending[$n]' "$WORK/state.json"
}

while read -r num; do
    [ -n "$num" ] || continue
    jq -e --arg n "$num" '.done | has($n)' "$WORK/state.json" >/dev/null && continue
    tries=$(jq -r --arg n "$num" '.pending[$n] // 0' "$WORK/state.json")
    if [ "$tries" -ge "$AA_SLOW_AFTER" ] && [ $(( (tries - AA_SLOW_AFTER + 1) % AA_SLOW_EVERY )) != 0 ]; then
        bump_pending "$num" >/dev/null; continue   # 降频：这一轮不读
    fi
    judge "$num"
    if [ "$AA_RES" = found ]; then
        first_doc="$AA_DOC"; who="$AA_WHO"
        judge "$num"
        if [ "$AA_RES" != found ] || [ "$AA_WHO" != "$who" ] || [ "$AA_DOC" != "$first_doc" ]; then
            [ "$AA_RES" = unknown ] && t=$(bump_pending "$num") || t=""
            aa_log "#$num 写之前重读，判定依据变了或读不到，本轮不写"
            continue
        fi
        if ! gh_write api -X POST "repos/$REPO/issues/$num/assignees" -f "assignees[]=$who" >/dev/null 2>&1; then
            t=$(bump_pending "$num")
            aa_log "#$num 指派 @$who 的请求失败，下一轮重试"
            continue
        fi
        if ! back=$(gh api "repos/$REPO/issues/$num" --jq '[.assignees[].login] | map(ascii_downcase)' 2>/dev/null) || [ -z "$back" ]; then
            aa_log "#$num 已发出指派 @${who}，读回失败，下一轮再看"
            continue
        fi
        if printf '%s' "$back" | jq -e --arg w "$(requester_bot_lc "$who")" 'index($w) != null' >/dev/null 2>&1; then
            set_done "$num" assigned; aa_log "#$num 已指派给提出者 @$who"
        else
            set_done "$num" unassignable; aa_log "#$num 的提出者 @$who 不能被指派（GitHub 没有接受，可能没有仓库权限），不再重试"
        fi
        continue
    fi
    case "$AA_RES" in
        unknown)
            t=$(bump_pending "$num")
            [ "$t" != "$AA_SLOW_AFTER" ] || aa_log "⚠️ #$num 已连续 $t 轮判不了提出者（读取失败或来源还没写好），改为每 $AA_SLOW_EVERY 轮重试一次；不会放弃"
            ;;
        *) set_done "$num" "$AA_RES" ;;
    esac
done < <(jq -r '.[].number' "$WORK/list.json")

# ── 推进 cursor、清理记录 ──
jq --slurpfile list "$WORK/list.json" --argjson now "$NOW" --argjson settle "$AA_SETTLE_SECS" '
    . as $s
    | reduce $list[0][] as $it ({c: $s.cursor, stop: false};
        if .stop then .
        elif ($s.done | has($it.number | tostring)) and ($now - ($it.created_at | fromdateiso8601) >= $settle)
        then .c = $it.number
        else .stop = true end)
    | .c as $c
    | $s | .cursor = $c
    | .done |= with_entries(select((.key | tonumber) > $c))
    | .pending |= with_entries(select((.key | tonumber) > $c))
' "$WORK/state.json" > "$WORK/s.tmp"
mv "$WORK/s.tmp" "$WORK/state.json"
cp "$WORK/state.json" "$AA_STATE.tmp" && mv "$AA_STATE.tmp" "$AA_STATE"
