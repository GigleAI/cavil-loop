#!/usr/bin/env bash
# 把本仓库的 issue / PR 自动加进配置的一个或多个 GitHub Project（GitHub#116）。
#
# 由 agent-poll.sh 每轮末尾调一次（project_auto_add_tick，_lib.sh），**独立子进程**：这里任何
# 失败——读不到、写不进、脚本自己出错——都不会碰到这一轮的派工、清理和退出码。
#
# 为什么要有：GitHub 免费版组织每个 Project 只能开 1 条「自动加入」规则、每条只盯 1 个仓库。
# 多个仓库汇总进同一个 Project 时只有一个能用自带规则；守护程序本来就每轮扫仓库，顺手加。
#
# ── 规格（issue #116，经维护者确认）──
#   加谁：开着的 issue / PR 全加；已关闭 / 已合并的只加「这个 Project 开启之后才新建的」。
#         开启前就已关闭的老条目不加（有人在下面评论也不加）；老条目重新打开 → 开着 → 加。
#   只加：不改字段、不移除；已经在 Project 里（含已归档卡片）的不发写请求。
#   每个 Project 三项状态（$STATE_DIR/project-auto-add.json，不进 state.json）：
#     enabled_at   第一次尝试同步时立刻写下，之后失败 / 重启 / 重试都不改
#     initial_done 首次全量完整成功后才写
#     last_sync    只在某一轮这个 Project 「读齐 + 写全成功」时推进到本轮开始时刻
#   首次全量：读全部开着的条目（不看更新时间）+ 「开启时间 − 10 分钟」之后有更新的条目。
#   增量：按更新时间倒序读到「上次成功同步时间 − 10 分钟」为止。
#
# ── 读取怎么共用、失败怎么隔离（方案复审第 1 轮的修订点）──
# 所有 Project 共用读取，读请求量不随 Project 个数翻倍；但**每个 Project 只按它自己需要的那段
# 判断读齐没有**——一个 Project 缺数据不能拖住另一个：
#   · 最近更新流（ri / rp 两段，issue 与 PR 各一）：倒序读，直到越过所有 Project 里最早的停止点。
#     记下「成功读到的最老一条的更新时间」：Project 的停止点早于它（或这段已经读完）就算读齐。
#     中途某页失败时，停止点已被前面成功页盖住的 Project 照常算齐。
#   · 全部开着的流（oi / op）：只在有 Project 处于首次全量时读，也只有它们依赖这段。
#   · 每一轮的一次请求里装着所有「还要往下读」的段 + 第一轮附带核对每个 Project 读身份看得见。
#     同一个请求失败只连累装在里面的段，GraphQL 局部错误按别名落到具体那一段。
#   · 条目挂的 Project 列表超过一页时补翻；补翻失败 = 这个条目「在不在里面」未知，只连累
#     以它为候选的 Project，并且不对它写。
#
# 读走 project_gh_graphql（读身份：PROJECT_GH_TOKEN，没配就是轮询账号），
# 写走 gh_write（写身份：WRITE_GH_TOKEN，没配就是轮询账号）。读身份看不见某个 Project 时，
# 它的卡片在条目上也看不见——每个条目都会被误判成「不在里面」、每轮写一遍。所以核对不过
# 的 Project 本轮不发任何写请求。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec 8>&2
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"
exec 2>&8 8>&-

PAA_STATE="$STATE_DIR/project-auto-add.json"
PAA_OVERLAP_SECS=600     # 规格里的「减 10 分钟」
PAA_PAGE=100             # 每页条目数（GraphQL 上限）
PAA_ITEM_PROJECTS=20     # 每个条目第一页带多少张卡片；更多时补翻
PAA_MAX_ROUNDS=500       # 防御：分页死循环时当失败处理

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

paa_warn() { log "⚠️ 自动加入 Project：$*"; }

# ── 状态文件：读 / 原子写 ──
if [ -f "$PAA_STATE" ]; then
    if ! jq -e 'type == "object"' "$PAA_STATE" >/dev/null 2>&1; then
        # 不覆盖：覆盖就会把每个 Project 的开启时间重置成现在，停机期间新建又关掉的条目就再也
        # 补不进去了。要人看一眼再删。
        paa_warn "状态文件 $PAA_STATE 不是合法 JSON，本轮跳过；确认无用后删掉它即可从头开始"
        exit 0
    fi
    cp "$PAA_STATE" "$WORK/state.json"
else
    echo '{}' > "$WORK/state.json"
fi
# ── 看板身份 = 「小写的组织或用户名/编号」──
# GitHub 的登录名不分大小写（organization(login:"GigleAI") 和 "gigleai" 是同一个组织），所以配置里
# 写 MyOrg/4 还是 myorg/4 都是同一个看板，状态也只能有一份：否则只改个大小写就会换来一个新的
# 「开启时间」，停机期间新建又关掉的条目就再也补不进去；同时写两种大小写还会对同一个看板写两遍。
# 已有状态里的键（可能按配置原文的大小写记的）读进来时先归一；同一个看板有多份时取最保守的合并：
# 最早的开启时间、最早的同步时间、全部都完成才算首次完成——宁可多读，不能漏条目。
paa_canon() { printf '%s/%s' "$(printf '%s' "${1%/*}" | tr 'A-Z' 'a-z')" "${1#*/}"; }
jq '.projects = ((.projects // {}) | to_entries
        | group_by(.key | ascii_downcase)
        | map({key: (.[0].key | ascii_downcase),
               value: (if length == 1 then .[0].value
                       else (map(.value)) as $v
                         | ($v | map(select(.project_id)) | first // {}) + {
                             enabled_at:   ([$v[].enabled_at | select(.)] | min),
                             initial_done: all($v[]; .initial_done == true),
                             last_sync:    ([$v[].last_sync | select(.)] | min)}
                         | with_entries(select(.value != null))
                       end)})
        | from_entries)' "$WORK/state.json" > "$WORK/state.tmp" && mv "$WORK/state.tmp" "$WORK/state.json"
paa_save() {
    local tmp
    tmp=$(mktemp "$PAA_STATE.XXXXXX")
    if jq '.' "$WORK/state.json" > "$tmp"; then mv "$tmp" "$PAA_STATE"; else rm -f "$tmp"; return 1; fi
}
paa_set() {   # <jq 过滤器> [jq 参数...]：改 $WORK/state.json
    local f="$1"; shift
    jq "$@" "$f" "$WORK/state.json" > "$WORK/state.tmp" && mv "$WORK/state.tmp" "$WORK/state.json"
}
paa_get() {   # <key> <field> → 值（没有就空）
    jq -r --arg k "$1" --arg f "$2" '.projects[$k][$f] // empty | tostring' "$WORK/state.json"
}
# 警告去重：守护程序每分钟一个新进程，同一条警告每轮都写会刷屏。内容变了或第一次出现才写。
paa_warn_once() {   # <key> <消息>
    local key="$1" msg="$2"
    if [ "$(paa_get "$key" last_warn)" != "$msg" ]; then
        paa_warn "${key}：$msg"
        paa_set '.projects[$k].last_warn = $m' --arg k "$key" --arg m "$msg"
    fi
}

iso_minus() { jq -rn --arg t "$1" --argjson s "$2" '($t | fromdateiso8601) - $s | todateiso8601'; }

T=$(date -u +%Y-%m-%dT%H:%M:%SZ)   # 本轮开始时刻（推进同步时间就推到它）

# ── 1. 解析配置 ──
# 每项「组织或用户名/编号」，空格或逗号分隔。格式不对的那项点名报出来（去重），其余照常。
KEYS=(); BAD=()
read -r -a _toks <<< "$(printf '%s' "${AUTO_ADD_PROJECTS:-}" | tr ',\t\n' '   ')"
for t in ${_toks[@]+"${_toks[@]}"}; do
    if [[ "$t" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?/[1-9][0-9]*$ ]]; then
        t=$(paa_canon "$t")
        case " ${KEYS[*]-} " in *" $t "*) ;; *) KEYS+=("$t") ;; esac
    else
        BAD+=("$t")
    fi
done
cfg_warn=""
[ "${#BAD[@]}" -eq 0 ] || cfg_warn="配置项 AUTO_ADD_PROJECTS 里这几项格式不对（应为「组织或用户名/编号」，如 myorg/4），已跳过：${BAD[*]}"
if [ "$(jq -r '.config_warn // ""' "$WORK/state.json")" != "$cfg_warn" ]; then
    [ -z "$cfg_warn" ] || paa_warn "$cfg_warn"
    paa_set '.config_warn = $m' --arg m "$cfg_warn"
fi
if [ "${#KEYS[@]}" -eq 0 ]; then paa_save || true; exit 0; fi

# ── 2. 开启时间：第一次尝试就落盘，之后永不改 ──
for k in "${KEYS[@]}"; do
    [ -n "$(paa_get "$k" enabled_at)" ] || paa_set '.projects[$k].enabled_at = $t' --arg k "$k" --arg t "$T"
done
paa_save || { paa_warn "写不进状态文件 ${PAA_STATE}，本轮跳过"; exit 0; }

# ── 3. 解析 Project 编号 → 内部 id（缓存进状态；核对不过时清掉，下一轮重解析）──
declare -A PID=() OK=() WHY=() CUT=() INITIAL=() PID_OWNER=()
for k in "${KEYS[@]}"; do
    OK[$k]=1; WHY[$k]=""
    pid=$(paa_get "$k" project_id)
    if [ -z "$pid" ]; then
        if out=$(PROJECT_OWNER="${k%/*}" PROJECT_NUMBER="${k#*/}" project_resolve 2> "$WORK/resolve.err"); then
            pid="${out%%$'\t'*}"
            paa_set '.projects[$k].project_id = $p' --arg k "$k" --arg p "$pid"
        else
            OK[$k]=0; WHY[$k]="读身份找不到这个 Project（编号不存在或没有读权限）：$(head -1 "$WORK/resolve.err" | cut -c1-200)"
            continue
        fi
    fi
    if ! [[ "$pid" =~ ^[A-Za-z0-9_=-]+$ ]]; then
        OK[$k]=0; WHY[$k]="缓存的 Project id 形状不对，已清掉，下一轮重解析"
        paa_set 'del(.projects[$k].project_id)' --arg k "$k"
        continue
    fi
    # 两个不同写法落到同一个看板（大小写之外的别名，例如组织改了名）：只同步第一个，免得同一个
    # 看板一轮写两遍
    if [ -n "${PID_OWNER[$pid]:-}" ]; then
        OK[$k]=0; WHY[$k]="和 ${PID_OWNER[$pid]} 是同一个 Project，已跳过"
        continue
    fi
    PID_OWNER[$pid]="$k"
    PID[$k]="$pid"
    if [ "$(paa_get "$k" initial_done)" = true ] && [ -n "$(paa_get "$k" last_sync)" ]; then
        INITIAL[$k]=0; CUT[$k]=$(iso_minus "$(paa_get "$k" last_sync)" "$PAA_OVERLAP_SECS")
    else
        INITIAL[$k]=1; CUT[$k]=$(iso_minus "$(paa_get "$k" enabled_at)" "$PAA_OVERLAP_SECS")
    fi
done

ACTIVE=()
for k in "${KEYS[@]}"; do [ "${OK[$k]}" = 1 ] && ACTIVE+=("$k"); done

# ── 4. 共用读取 ──
# 段：ri / rp = 最近更新流（issue / PR），oi / op = 全部开着的流。
declare -A SEG_ON=() SEG_AFTER=() SEG_DONE=() SEG_FAIL=() SEG_OLDEST=() SEG_PAGES=()
SEGS=(ri rp oi op)
need_open=0; C_MIN=""
for k in ${ACTIVE[@]+"${ACTIVE[@]}"}; do
    [ "${INITIAL[$k]}" = 1 ] && need_open=1
    if [ -z "$C_MIN" ] || [[ "${CUT[$k]}" < "$C_MIN" ]]; then C_MIN="${CUT[$k]}"; fi
done
for s in "${SEGS[@]}"; do SEG_ON[$s]=0; SEG_AFTER[$s]=""; SEG_DONE[$s]=0; SEG_FAIL[$s]=0; SEG_OLDEST[$s]=""; SEG_PAGES[$s]=0; done
if [ "${#ACTIVE[@]}" -gt 0 ]; then
    SEG_ON[ri]=1; SEG_ON[rp]=1
    [ "$need_open" = 1 ] && { SEG_ON[oi]=1; SEG_ON[op]=1; }
fi
: > "$WORK/items.jsonl"
declare -A VERIFIED=()

ITEM_FIELDS="id number state createdAt updatedAt projectItems(first:$PAA_ITEM_PROJECTS){ pageInfo{ hasNextPage endCursor } nodes{ project{ id } } }"
seg_expr() {   # <段> → GraphQL 片段
    local s="$1" conn order states="" after=""
    case "$s" in ri|oi) conn=issues ;; *) conn=pullRequests ;; esac
    case "$s" in
        r*) order="orderBy:{field:UPDATED_AT,direction:DESC}" ;;
        o*) order="orderBy:{field:CREATED_AT,direction:ASC}"; states="states:OPEN," ;;
    esac
    [ -z "${SEG_AFTER[$s]}" ] || after="after:$(jq -rn --arg a "${SEG_AFTER[$s]}" '$a | @json'),"
    printf '%s: %s(first:%s, %s %s %s){ pageInfo{ hasNextPage endCursor } nodes{ %s } }' \
        "$s" "$conn" "$PAA_PAGE" "$states" "$after" "$order" "$ITEM_FIELDS"
}

round=0
while :; do
    live=()
    for s in "${SEGS[@]}"; do [ "${SEG_ON[$s]}" = 1 ] && live+=("$s"); done
    [ "${#live[@]}" -gt 0 ] || break
    round=$((round + 1))
    if [ "$round" -gt "$PAA_MAX_ROUNDS" ]; then
        for s in "${live[@]}"; do SEG_ON[$s]=0; SEG_FAIL[$s]=1; done
        break
    fi
    body=""
    for s in "${live[@]}"; do body+=" $(seg_expr "$s")"; done
    verify=""
    if [ "$round" = 1 ]; then
        i=0
        for k in "${ACTIVE[@]}"; do
            verify+=" v$i: node(id:$(jq -rn --arg p "${PID[$k]}" '$p | @json')){ ... on ProjectV2 { id } }"
            i=$((i + 1))
        done
    fi
    q="query(\$o:String!,\$r:String!){ # cavil-loop project-auto-add read
 repository(owner:\$o,name:\$r){$body }$verify }"
    rc=0
    resp=$(project_gh_graphql -f o="${REPO%%/*}" -f r="${REPO##*/}" -f query="$q" 2> "$WORK/read.err") || rc=$?
    # gh 遇到 GraphQL 错误时退出码非 0，但完整的响应（含 data 里没出错的部分）照样打到 stdout。
    # 所以按别名逐段判：data 里有这一段、且没有落在这一段上的错误，才算这一页读到了。
    printf '%s' "$resp" | jq -e 'type == "object"' >/dev/null 2>&1 || resp='{}'
    readerr=$(head -1 "$WORK/read.err" 2>/dev/null | cut -c1-200)
    [ -n "$readerr" ] || readerr="退出码 $rc"
    if [ "$round" = 1 ]; then
        i=0
        for k in "${ACTIVE[@]}"; do
            got=$(printf '%s' "$resp" | jq -r --arg a "v$i" '.data[$a].id // empty')
            if [ "$got" = "${PID[$k]}" ]; then
                VERIFIED[$k]=1
            elif printf '%s' "$resp" | jq -e --arg a "v$i" 'has("data") and (.data | has($a))' >/dev/null 2>&1; then
                # 请求本身成功、这个 id 却解析不出来：读身份看不见它了，或者 Project 被删了重建。
                # 清掉缓存，下一轮重解析（那时会给出具体原因）。
                VERIFIED[$k]=0; WHY[$k]="读身份看不见缓存的 Project（已删除或被收回权限），下一轮重新按编号解析"
                paa_set 'del(.projects[$k].project_id)' --arg k "$k"
            else
                VERIFIED[$k]=0; WHY[$k]="读取失败：$readerr"
            fi
            i=$((i + 1))
        done
    fi
    for s in "${live[@]}"; do
        if ! printf '%s' "$resp" | jq -e --arg a "$s" '
                (.data.repository[$a].nodes | type == "array")
                and ([.errors[]? | select((.path // [])[1] == $a)] | length == 0)' >/dev/null 2>&1; then
            SEG_ON[$s]=0; SEG_FAIL[$s]=1
            WHY_SEG="读取失败：$readerr"
            continue
        fi
        SEG_PAGES[$s]=$((SEG_PAGES[$s] + 1))
        kind=issue; case "$s" in rp|op) kind=pr ;; esac
        printf '%s' "$resp" | jq -c --arg a "$s" --arg kind "$kind" '
            .data.repository[$a].nodes[] | {id, number, kind: $kind, state, createdAt, updatedAt,
              projects: [.projectItems.nodes[]?.project.id],
              more: (.projectItems.pageInfo.hasNextPage // false),
              cursor: (.projectItems.pageInfo.endCursor // "")}' >> "$WORK/items.jsonl"
        oldest=$(printf '%s' "$resp" | jq -r --arg a "$s" '[.data.repository[$a].nodes[].updatedAt] | last // empty')
        [ -z "$oldest" ] || SEG_OLDEST[$s]="$oldest"
        nxt=$(printf '%s' "$resp" | jq -r --arg a "$s" '.data.repository[$a].pageInfo.hasNextPage // false')
        if [ "$nxt" != true ]; then
            SEG_ON[$s]=0; SEG_DONE[$s]=1
        else
            SEG_AFTER[$s]=$(printf '%s' "$resp" | jq -r --arg a "$s" '.data.repository[$a].pageInfo.endCursor // empty')
            if [ -z "${SEG_AFTER[$s]}" ]; then SEG_ON[$s]=0; SEG_FAIL[$s]=1; continue; fi
            # 最近更新流越过了所有 Project 里最早的停止点就停（全部开着的流要读完）
            case "$s" in
                r*) if [ -n "$oldest" ] && [[ "$oldest" < "$C_MIN" ]]; then SEG_ON[$s]=0; fi ;;
            esac
        fi
    done
done

# 同一个条目可能在两条流里各出现一次：按 id 合并
jq -s 'group_by(.id) | map(.[0] + {projects: (map(.projects[]) | unique), more: all(.[]; .more)})' \
    "$WORK/items.jsonl" > "$WORK/items.json"

# ── 5. 条目挂的 Project 超过一页：补翻 ──
# 失败 = 这个条目「在不在某个 Project 里」未知，记 unknown；下面只连累以它为候选的 Project。
jq -c '.[] | select(.more) | {id, cursor}' "$WORK/items.json" > "$WORK/more.jsonl"
: > "$WORK/extra.jsonl"
while IFS= read -r row; do
    [ -n "$row" ] || continue
    iid=$(printf '%s' "$row" | jq -r .id); cur=$(printf '%s' "$row" | jq -r .cursor)
    ids=(); unknown=0; n=0
    while :; do
        n=$((n + 1)); [ "$n" -le "$PAA_MAX_ROUNDS" ] || { unknown=1; break; }
        rc=0
        r=$(project_gh_graphql -f id="$iid" -f after="$cur" -f query='query($id:ID!,$after:String!){ # cavil-loop project-auto-add item-projects
 node(id:$id){ ... on Issue { projectItems(first:100, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ project{ id } } } }
 ... on PullRequest { projectItems(first:100, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ project{ id } } } } } }' 2>/dev/null) || rc=$?
        if [ "$rc" != 0 ] || ! printf '%s' "$r" | jq -e '.data.node.projectItems.nodes | type == "array"' >/dev/null 2>&1; then
            unknown=1; break
        fi
        while IFS= read -r p; do [ -n "$p" ] && ids+=("$p"); done < <(printf '%s' "$r" | jq -r '.data.node.projectItems.nodes[]?.project.id')
        [ "$(printf '%s' "$r" | jq -r '.data.node.projectItems.pageInfo.hasNextPage // false')" = true ] || break
        cur=$(printf '%s' "$r" | jq -r '.data.node.projectItems.pageInfo.endCursor // empty')
        [ -n "$cur" ] || { unknown=1; break; }
    done
    jq -cn --arg id "$iid" --argjson u "$unknown" '{id: $id, unknown: ($u == 1), projects: $ARGS.positional}' \
        --args ${ids[@]+"${ids[@]}"} >> "$WORK/extra.jsonl"
done < "$WORK/more.jsonl"
jq --slurpfile x "$WORK/extra.jsonl" '
    ($x | map({key: .id, value: .}) | from_entries) as $e
    | map(. + (if $e[.id] then {projects: ((.projects + $e[.id].projects) | unique), unknown: $e[.id].unknown}
               else {unknown: false} end))' "$WORK/items.json" > "$WORK/items2.json"

# ── 6. 逐个 Project：判读齐、挑候选、写、推进 ──
covered() {   # <段> <停止点>：这一段对这个停止点算不算读齐
    local s="$1" cut="$2"
    [ "${SEG_DONE[$s]}" = 1 ] && return 0
    [ -n "${SEG_OLDEST[$s]}" ] && [[ "${SEG_OLDEST[$s]}" < "$cut" ]]
}
for k in "${KEYS[@]}"; do
    if [ "${OK[$k]}" != 1 ]; then paa_warn_once "$k" "${WHY[$k]}"; continue; fi
    if [ "${VERIFIED[$k]:-0}" != 1 ]; then
        paa_warn_once "$k" "${WHY[$k]:-读取失败}，本轮不写"; continue
    fi
    pid="${PID[$k]}"; enabled=$(paa_get "$k" enabled_at)
    read_ok=1
    covered ri "${CUT[$k]}" && covered rp "${CUT[$k]}" || read_ok=0
    if [ "${INITIAL[$k]}" = 1 ]; then
        [ "${SEG_DONE[oi]}" = 1 ] && [ "${SEG_DONE[op]}" = 1 ] || read_ok=0
    fi
    # 候选只看**这个 Project 自己的范围**，不因为别的 Project 多读了数据就扩大：
    #   · 首次全量：全部开着的 + 停止点之后有更新的（开着的，或开启之后才新建的已关闭 / 已合并）
    #   · 增量：只有停止点之后有更新的（同上）
    # 后一条要紧：新加 B 触发了「全部开着的」读取时，A 不能顺手把这批老条目也补进去——人从 A
    # 里手动拿掉的老卡片会被它塞回来。（停止点之后有更新的条目照样会被加回：停止点是上次同步
    # 减 10 分钟，所以刚同步过的条目在这 10 分钟重叠窗口里被人拿掉，下一轮还会补回一次。）
    # 已在里面的不写。
    jq -c --arg p "$pid" --arg en "$enabled" --arg cut "${CUT[$k]}" --arg ini "${INITIAL[$k]}" '
        [.[] | select(($ini == "1" and .state == "OPEN")
                      or (.updatedAt >= $cut and (.state == "OPEN" or .createdAt > $en)))
             | select((.projects | index($p)) == null)]
        | sort_by(.kind, .number) | .[]' "$WORK/items2.json" > "$WORK/todo.jsonl"
    added=0; write_err=""; unknown_n=0
    while IFS= read -r it; do
        [ -n "$it" ] || continue
        if [ "$(printf '%s' "$it" | jq -r .unknown)" = true ]; then unknown_n=$((unknown_n + 1)); continue; fi
        cid=$(printf '%s' "$it" | jq -r .id)
        rc=0
        r=$(gh_write api graphql -f p="$pid" -f c="$cid" -f query='mutation($p:ID!,$c:ID!){ # cavil-loop project-auto-add write
 addProjectV2ItemById(input:{projectId:$p, contentId:$c}){ item{ id } } }' 2> "$WORK/write.err") || rc=$?
        if [ "$rc" = 0 ] && [ -n "$(printf '%s' "$r" | jq -r '.data.addProjectV2ItemById.item.id // empty' 2>/dev/null)" ]; then
            added=$((added + 1))
        else
            # 第一笔写失败就停：权限不够时剩下的也一定失败，没必要每轮把整张表都打一遍
            write_err="$(printf '%s' "$it" | jq -r '"\(.kind) #\(.number)"') 加不进去：$(head -1 "$WORK/write.err" 2>/dev/null | cut -c1-200)"
            [ -n "${write_err##*：}" ] || write_err="${write_err}退出码 $rc"
            break
        fi
    done < "$WORK/todo.jsonl"
    [ "$added" = 0 ] || log "自动加入 Project：$k 已加入 $added 条"
    if [ "$read_ok" = 1 ] && [ -z "$write_err" ] && [ "$unknown_n" = 0 ]; then
        paa_set '.projects[$k].last_sync = $t | .projects[$k].initial_done = true | del(.projects[$k].last_warn)' \
            --arg k "$k" --arg t "$T"
        [ "${INITIAL[$k]}" = 1 ] && log "自动加入 Project：$k 首次全量完成"
    else
        why=""
        [ "$read_ok" = 1 ] || why="${WHY_SEG:-读取失败}（这个 Project 需要的条目没读全）"
        [ -z "$write_err" ] || why="${why:+${why}；}写入失败（写身份需要能写这个 Project）：$write_err"
        [ "$unknown_n" = 0 ] || why="${why:+${why}；}$unknown_n 个条目挂的 Project 列表没读全"
        paa_warn_once "$k" "${why}，同步时间不推进，下一轮重试"
    fi
done
paa_save || paa_warn "写不进状态文件 $PAA_STATE"
exit 0
