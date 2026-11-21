#!/usr/bin/env bash
# 往返记录（GitHub#610）：一段 agent ↔ agent 的来回（交方案 / 交 PR → 复审 → 修订 → ……）只占一条评论。
# 只在本项目开了 ENABLE_ROUND_LOG 时用（派工说明里会写）。记录格式和拆单元规则只在 round_log.py 里。
#
#   bash round-log.sh --config <项目配置> post <编号> --role worker|review --to <翻到的标签> --body <文件>
#                     [--full <文件>] [--of <所审的节>] [--basis <本次交付依据的 PR 提交>]
#   bash round-log.sh --config <项目配置> show <编号> [--all]
#
# post 的结果写在最后一行 RESULT=…，退出码与它一一对应（agent 只照这张表做）：
#   0 RESULT=written   已写入（MODE=append 追加到现有记录 / new 新开一条 / fallback 改写不成、另起一条完整的新记录）
#                      → 照现在的指令翻标签
#   3 RESULT=expired   目标已不归这次派工（关了 / 合并了 / 换了目标分支或来源 / 有了不是本次依据的提交 /
#                      人已接手）→ 什么都没写；不翻标签，停下
#   4 RESULT=unknown   目标状态读不到 → 什么都没写；不翻标签，停下
#   5 RESULT=unreadable 评论读不全 → 什么都没写；照现在读评论失败的规则处理
#   6 RESULT=failed    该写的写不进去（另起也失败）→ 照现在发评论失败的做法处理
#   2 RESULT=rejected  用法不对 / 这类交付不该进记录（交合并、交人等）/ 正文里有记录标记 → 什么都没写，照现在单独发
# 「已过期 / 状态未知」若发生在改写请求已经发出之后，那次请求生效与否按事实保留：不撤回、不补写、不另起。
#
# show：本条（issue 或 PR 的对话评论）按单元排好，打印最新单元和它对应的完整版本；--all 打印全部单元。
#   退出码 0 = 读到了；4 = 最新一节的完整版本对不上（不给任何当前版本）；5 = 读不全；2 = 用法不对。
#   托管条目开了外部内容保护时不用它：受保护读取命令的输出末尾就带着同样的视图。
set -uo pipefail

usage() { echo "RESULT=rejected"; echo "用法: round-log.sh --config <项目配置> post|show <编号> …" >&2; exit 2; }

CFG=""
[ "${1:-}" = --config ] && { CFG="${2:-}"; shift 2 || usage; }
[ -z "$CFG" ] || export CODING_AGENT_CONFIG="$CFG"
CMD="${1:-}"; shift || usage
NUM="${1:-}"; shift || usage
case "$NUM" in ''|*[!0-9]*) usage ;; esac

ROLE="" TO="" BODY_F="" FULL_F="" OF="" BASIS="" BASE="" SOURCE="" ALL=0
while [ $# -gt 0 ]; do
    case "$1" in
        --role) ROLE="${2:-}"; shift 2 || usage ;;
        --to) TO="${2:-}"; shift 2 || usage ;;
        --body) BODY_F="${2:-}"; shift 2 || usage ;;
        --full) FULL_F="${2:-}"; shift 2 || usage ;;
        --of) OF="${2:-}"; shift 2 || usage ;;
        --basis) BASIS="${2:-}"; shift 2 || usage ;;
        --base) BASE="${2:-}"; shift 2 || usage ;;
        --source) SOURCE="${2:-}"; shift 2 || usage ;;
        --all) ALL=1; shift ;;
        *) usage ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"
RL_PY="$SCRIPT_DIR/round_log.py"

TMPD="$(mktemp -d)" || { echo "RESULT=failed"; exit 6; }
trap 'rm -rf "$TMPD"' EXIT

finish() {   # <退出码> <RESULT> [说明]
    [ -z "${3:-}" ] || echo "$3"
    echo "RESULT=$2"
    log "round-log #${NUM} ${CMD}：$2${3:+（$3）}" 2>/dev/null || true
    exit "$1"
}

# 本条的全部对话评论（分页读全），整理成 round_log.py 要的形状。读不全 → return 1
rl_read_comments() {   # <输出文件>
    local raw="$TMPD/raw.jsonl"
    gh api --paginate "repos/$REPO/issues/$NUM/comments" \
        --jq '.[] | {id, author: (.user.login // ""), at: .created_at, body: (.body // ""), url: (.html_url // "")}' \
        > "$raw" 2>/dev/null || return 1
    jq -cs '.' < "$raw" > "$1" 2>/dev/null || return 1
}

# ── show ──────────────────────────────────────────────────────────────────────
if [ "$CMD" = show ]; then
    [ -z "$ROLE$TO$BODY_F$FULL_F$OF$BASIS$BASE$SOURCE" ] || usage
    # 开了外部内容保护的项目一律走受保护读取（同 outsider-read.sh），文字用它展示的那一份
    if outsider_guard_on; then
        rc=0; outsider_scan "$NUM" read || rc=$?
        [ "$rc" = 0 ] || finish 5 unreadable "受保护读取没读全：${OS_WHY:-原因没记下}"
        rc=0
        if [ "$ALL" = 1 ]; then round_log_view_from_scan --all || rc=$?; else round_log_view_from_scan || rc=$?; fi
        exit "$rc"
    fi
    me=$(write_identity_login)
    [ -n "$me" ] || finish 5 unreadable "读不到 loop 写评论账号是谁"
    rl_read_comments "$TMPD/c.json" || finish 5 unreadable "评论读不全"
    rc=0
    jq -c --arg me "$me" --argjson all "$ALL" '{comments: ., trusted_login: $me, all: ($all == 1)}' < "$TMPD/c.json" \
        | python3 "$RL_PY" show || rc=$?
    exit "$rc"
fi
[ "$CMD" = post ] || usage

# ── post ──────────────────────────────────────────────────────────────────────
case "$ROLE" in worker|review) ;; *) usage ;; esac
[ -n "$BODY_F" ] && [ -f "$BODY_F" ] || usage
[ -z "$FULL_F" ] || [ -f "$FULL_F" ] || usage
round_log_enabled || finish 2 rejected "本项目没开往返记录（ENABLE_ROUND_LOG），照现在单独发评论"
# 只有交给 agent 的交付进记录：交复审、交回 worker。交合并（daemon 只认派复审之后新建的评论里的测试记录）、
# 交人、等前置、转 PR 跟踪一律照现在单独发
to_ok=0
[ -n "$LABEL_PENDING_REVIEW" ] && [ "$TO" = "$LABEL_PENDING_REVIEW" ] && to_ok=1
case "$TO" in "$LABEL_PENDING_AGENT_DEFAULT"|"$LABEL_PENDING_AGENT_DEFAULT"/*) to_ok=1 ;; esac
for bad in "$LABEL_PENDING_MERGE" "$LABEL_PENDING_HUMAN" "$LABEL_PENDING_BLOCKED" "$LABEL_PENDING_PR"; do
    [ -n "$bad" ] && [ "$TO" = "$bad" ] && to_ok=0
done
[ "$to_ok" = 1 ] || finish 2 rejected "发完要翻到「${TO}」的评论不进往返记录，照现在单独发"

me=$(write_identity_login)
[ -n "$me" ] || finish 4 unknown "读不到 loop 写评论账号是谁"

# 每次写前都和「本次交付开始时确认的」提交、目标分支、来源仓库比：PR 上这三样由调用方给（--basis / --base，
# --source 不给 = 本仓库），缺了就不写——命令自己第一次读到的值不能当基准（交付开始后、调用之前改投就看不出来）
rl_target() {   # → 0 仍归这次派工 / 1 已变（RL_WHY）/ 2 读不到
    local it labels pj st merged base hrepo hsha prs
    RL_WHY=""
    it=$(gh api "repos/$REPO/issues/$NUM" 2>/dev/null) || return 2
    st=$(printf '%s' "$it" | jq -r '.state // ""' 2>/dev/null) || return 2
    labels=$(printf '%s' "$it" | jq -r '[.labels[]? | (.name // empty)] | .[]' 2>/dev/null) || return 2
    case "$st" in open) ;; closed) RL_WHY="已关闭"; return 1 ;; *) return 2 ;; esac
    grep -qxF -- "$LABEL_AGENT_DOING" <<<"$labels" || { RL_WHY="不再挂着 $LABEL_AGENT_DOING"; return 1; }
    for l in "$LABEL_PENDING_HUMAN" "$LABEL_PENDING_BLOCKED"; do
        [ -n "$l" ] && grep -qxF -- "$l" <<<"$labels" && { RL_WHY="带着 ${l}（已有人接手）"; return 1; }
    done
    if printf '%s' "$it" | jq -e '.pull_request != null' >/dev/null 2>&1; then
        pj=$(gh api "repos/$REPO/pulls/$NUM" 2>/dev/null) || return 2
        merged=$(printf '%s' "$pj" | jq -r 'if (.merged | type) == "boolean" then .merged else "?" end' 2>/dev/null) || return 2
        base=$(printf '%s' "$pj" | jq -r '.base.ref // ""' 2>/dev/null) || return 2
        hrepo=$(printf '%s' "$pj" | jq -r '.head.repo.full_name // ""' 2>/dev/null) || return 2
        hsha=$(printf '%s' "$pj" | jq -r '.head.sha // ""' 2>/dev/null) || return 2
        [ "$merged" != "?" ] && [ -n "$base" ] && [ -n "$hrepo" ] && [ -n "$hsha" ] || return 2
        [ "$merged" = false ] || { RL_WHY="已合并"; return 1; }
        RL_KIND=pr
        [ -n "$BASIS" ] && [ -n "$BASE" ] || return 3
        [ "$base" = "$BASE" ] || { RL_WHY="目标分支变了"; return 1; }
        [ "$hrepo" = "${SOURCE:-$REPO}" ] || { RL_WHY="来源仓库变了"; return 1; }
        [ "$hsha" = "$BASIS" ] || { RL_WHY="PR 有了不是本次依据的新提交"; return 1; }
    else
        RL_KIND=issue
        # 方案阶段：这条 issue 还没有打开的工作分支 PR
        prs=$(gh api "repos/$REPO/pulls?state=open&head=${REPO%%/*}:$(branch_name "$NUM")" --jq 'length' 2>/dev/null) || return 2
        case "$prs" in ''|*[!0-9]*) return 2 ;; esac
        [ "$prs" = 0 ] || { RL_WHY="已经有了关联 PR"; return 1; }
    fi
    return 0
}

rl_gate() {   # 每一次写之前都跑；不通过就按结果收尾
    local rc=0
    rl_target || rc=$?
    case "$rc" in
        0) return 0 ;;
        1) finish 3 expired "目标已不归这次派工：$RL_WHY" ;;
        3) finish 2 rejected "PR 上的交付要给本次依据的提交和目标分支（--basis / --base），照现在单独发" ;;
        *) finish 4 unknown "目标状态读不到" ;;
    esac
}

rl_gate
rl_read_comments "$TMPD/c.json" || finish 5 unreadable "评论读不全"
# 开了外部内容保护的项目：写入路径和读取命令用同一次受保护读取（outsider_scan）。它读不全就不写；
# 它认出的评论要和上面原样读到的是同一批，往返记录也只认它判为 loop 账号写的那条
if outsider_guard_on; then
    rc=0; outsider_scan "$NUM" read || rc=$?
    [ "$rc" = 0 ] || finish 5 unreadable "受保护读取没读全：${OS_WHY:-原因没记下}"
    src=issue-comment; [ "${OS_TARGET_KIND:-issue}" != pr ] || src=pr-comment
    view_ids=$(printf '%s' "$OS_RES" | jq -r --arg s "$src" '[.view[]? | select(.src == $s) | .id | tostring] | sort | join(",")' 2>/dev/null) \
        || finish 5 unreadable "受保护读取的结果读不懂"
    raw_ids=$(jq -r '[.[].id | tostring] | sort | join(",")' < "$TMPD/c.json") || finish 5 unreadable "评论读不懂"
    [ "$view_ids" = "$raw_ids" ] || finish 5 unreadable "受保护读取和原样读取看到的评论不是同一批"
    printf '%s' "$OS_RES" | jq -c --arg s "$src" '[.view[]? | select(.src == $s) | {key: (.id | tostring), value: .trusted}] | from_entries' \
        > "$TMPD/trust.json" || finish 5 unreadable "受保护读取的结果读不懂"
    jq -c --slurpfile t "$TMPD/trust.json" 'map(. + {trusted: ($t[0][(.id | tostring)] // false)})' < "$TMPD/c.json" > "$TMPD/c2.json" \
        && mv "$TMPD/c2.json" "$TMPD/c.json" || finish 5 unreadable "整理不了评论"
fi

SEC=$(od -An -N6 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
[ "${#SEC}" = 12 ] || finish 6 failed "生成不了节编号"
AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
plan_rc=0
jq -c --arg me "$me" --arg role "$ROLE" --arg of "$OF" --arg sec "$SEC" --arg at "$AT" \
    --rawfile body "$BODY_F" --rawfile full "${FULL_F:-/dev/null}" --argjson hasfull "$([ -n "$FULL_F" ] && echo true || echo false)" \
    '{comments: ., trusted_login: $me, role: $role, body: $body, full: (if $hasfull then $full else null end),
      of: (if $of == "" then null else $of end), sec: $sec, at: $at}' < "$TMPD/c.json" > "$TMPD/in.json" \
    || finish 6 failed "整理不了输入"
python3 "$RL_PY" plan < "$TMPD/in.json" > "$TMPD/plan.json" || plan_rc=$?
if [ "$plan_rc" != 0 ]; then
    finish 2 rejected "$(head -c 300 "$TMPD/plan.json")；照现在单独发"
fi
mode=$(jq -r '.mode' < "$TMPD/plan.json") || finish 6 failed "写入计划读不懂"
jq -c '{body: .new_body}' < "$TMPD/plan.json" > "$TMPD/new.json" || finish 6 failed "写入计划读不懂"

rl_post_new() {   # <MODE 名>
    local out url
    rl_gate
    out=$(gh_write api -X POST "repos/$REPO/issues/$NUM/comments" --input "$TMPD/new.json" 2>/dev/null) \
        || finish 6 failed "发不出新的往返记录"
    url=$(printf '%s' "$out" | jq -r '.html_url // empty' 2>/dev/null)
    [ -n "$url" ] || finish 6 failed "发新的往返记录后没拿到它的地址（可能已经发出，照发评论失败处理）"
    echo "MODE=$1"
    echo "URL=$url"
    echo "SECTION=$SEC"
    finish 0 written
}

if [ "$mode" = append ]; then
    cid=$(jq -r '.comment_id' < "$TMPD/plan.json")
    jq -c '{body: .append_body}' < "$TMPD/plan.json" > "$TMPD/app.json" || finish 6 failed "写入计划读不懂"
    rl_gate
    if out=$(gh_write api -X PATCH "repos/$REPO/issues/comments/$cid" --input "$TMPD/app.json" 2>/dev/null) \
       && [ "$(printf '%s' "$out" | jq -r '.id // empty' 2>/dev/null)" = "$cid" ]; then
        echo "MODE=append"
        echo "URL=$(printf '%s' "$out" | jq -r '.html_url // empty')"
        echo "SECTION=$SEC"
        finish 0 written
    fi
    # 改写明确失败、超时、回答看不懂：另起一条完整的新记录（节编号不变，读取和统计只算一份）。
    # 另起之前再核对一次；不通过就停下，已经发出的那次改写不撤回
    log "round-log #${NUM}：改写评论 ${cid} 没成，另起一条新记录" 2>/dev/null || true
    rl_post_new fallback
fi
rl_post_new new
