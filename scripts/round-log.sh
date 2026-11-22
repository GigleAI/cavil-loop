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
#                      人已接手；复审所审的那一版读取之后已被新的交付取代）→ 什么都没写；不翻标签，停下
#   4 RESULT=unknown   目标状态读不到 → 什么都没写；不翻标签，停下
#   5 RESULT=unreadable 评论读不全 → 什么都没写；照现在读评论失败的规则处理
#   6 RESULT=failed    该写的写不进去（另起也失败）→ 照现在发评论失败的做法处理
#   2 RESULT=rejected  这类交付不该进记录（交合并、交人等）/ 所审的交付是单独的评论且仍是最新 / 正文里有记录标记 → 什么都没写，照现在单独发
#  64 RESULT=usage     用法不对，含 PR 上缺 --basis / --base、复审缺 --of → 什么都没写；补齐参数重跑，补不齐就不发、不翻标签（不改成单独发）
# 「已过期 / 状态未知」若发生在改写请求已经发出之后，那次请求生效与否按事实保留：不撤回、不补写、不另起。
#
# show：本条（issue 或 PR 的对话评论）按单元排好，打印最新单元和它对应的完整版本；--all 打印全部单元。
#   退出码 0 = 读到了；4 = 最新一节的完整版本对不上（不给任何当前版本）；5 = 读不全；64 = 用法不对。
#   托管条目开了外部内容保护时不用它：受保护读取命令的输出末尾就带着同样的视图。
#
# ── Turning the round log off (GitHub#646); read before changing the「关掉」fold in docs/operations{,.zh}.md ──
# The setting is read at every call of post (off → RESULT=rejected before any other check) and of the guarded
# read outsider-read.sh (off → no split view, no delivery named); show ignores it; a session already running
# keeps the instructions it was dispatched with. So the docs promise no safe moment to turn it off: a label
# check cannot see an item queued for dispatch, or one being dispatched before it carries doing/agent — five
# review rounds on PR #652 found a new variant each time, and the maintainer chose (PR #652 Q1 = A) to state
# what can happen and how to dispatch a stopped item again. Do not bring back a "check, turn off, check again"
# procedure or a label-check command; do not add a prompt branch that posts separately when the view is
# missing (review round 4 on PR #652: it skips this script's staleness checks).
# Which dispatch was interrupted is read from the item's label history, never from its latest comment: a
# dispatch removes its trigger label and then adds doing/agent with the write account (flip_to_doing →
# gh_label_flip), so the label to put back is the one the loop account removed right before it added doing/agent
# — a first-round review whose delivery is only the PR description has no worker comment at all (PR #652 code
# review round 1). Only a dispatch that still stands counts: the last doing/agent event is "added" and by the loop
# account (named in the block — the person running it is not the loop), exactly one trigger label removed by it
# right before, no flow-label event after it, no pending/human now, and the item's labels read the same before
# and after the history. A maintainer doing the same two steps by hand, events with no account, a later
# hand-over, labels changing while reading — all UNKNOWN, and UNKNOWN changes nothing (round 2).
# The blocks behind <!-- round-log-check-ops / -off-ops / -on-ops:begin --> are run verbatim by
# tests/project-config.test.sh §9 (they trust only the settings script's RESULT= word, never its exit code: a save
# killed after the rename exits non-zero with the file written); <!-- round-log-redispatch-ops:begin --> is run
# verbatim by tests/round-log-redispatch.test.sh, which then puts the label back and runs a real poll round.
# Keep the two doc copies identical.
set -uo pipefail

# 用法不对（含 PR 上缺本次依据）≠ 拒收：拒收（2）是「这条照现在单独发」，用法不对（64）是「改好参数重跑，改不好就什么都不发」
usage() { echo "RESULT=usage"; echo "用法: round-log.sh --config <项目配置> post|show <编号> …" >&2; exit 64; }

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
        --jq '.[] | {id, author: (.user.login // ""), at: .created_at, updated: (.updated_at // .created_at), body: (.body // ""), url: (.html_url // "")}' \
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

# 一份 issue / PR 响应里的「还归不归这次派工」：打开、挂着派工中标签、没有交人 / 等前置 / 合并 / 转 PR 这类
# 别人已接手的标签。issue 响应和 PR 响应各自都要过这一关：两次读之间维护者可能关掉条目或改了标签，
# 只核对其中一份就会漏掉（PR #625 复审重派第 1、2 轮先后漏了 PR 的状态和标签）。
# 字段缺失、标签没名字、状态是没见过的词 → 读不懂（2），不当成「没有保护标签」
rl_flow_check() {   # <响应 JSON 文件> → 0 / 1（RL_WHY）/ 2
    local f="$1" st labels l
    st=$(jq -r 'if (.state | type) == "string" then .state else "" end' < "$f" 2>/dev/null) || return 2
    labels=$(jq -r 'if (.labels | type) == "array" and all(.labels[]; (.name | type) == "string" and .name != "")
                    then .labels[].name else error("labels") end' < "$f" 2>/dev/null) || return 2
    case "$st" in open) ;; closed) RL_WHY="已关闭"; return 1 ;; *) return 2 ;; esac
    grep -qxF -- "$LABEL_AGENT_DOING" <<<"$labels" || { RL_WHY="不再挂着 $LABEL_AGENT_DOING"; return 1; }
    for l in "$LABEL_PENDING_HUMAN" "$LABEL_PENDING_BLOCKED" "$LABEL_PENDING_MERGE" "$LABEL_PENDING_PR"; do
        [ -n "$l" ] && grep -qxF -- "$l" <<<"$labels" && { RL_WHY="带着 ${l}（已有人接手）"; return 1; }
    done
    return 0
}

# 每次写前都和「本次交付开始时确认的」提交、目标分支、来源仓库比：PR 上这三样由调用方给（--basis / --base，
# --source 不给 = 本仓库），缺了就不写——命令自己第一次读到的值不能当基准（交付开始后、调用之前改投就看不出来）。
# 最后一次读到的响应决定结果：PR 上最后读的是 PR 资源，issue 上读完关联 PR 列表后再读一次 issue
rl_target() {   # → 0 仍归这次派工 / 1 已变（RL_WHY）/ 2 读不到
    local rc merged base hrepo hsha prs
    RL_WHY=""
    gh api "repos/$REPO/issues/$NUM" > "$TMPD/t-issue.json" 2>/dev/null || return 2
    rc=0; rl_flow_check "$TMPD/t-issue.json" || rc=$?; [ "$rc" = 0 ] || return "$rc"
    if jq -e '.pull_request != null' < "$TMPD/t-issue.json" >/dev/null 2>&1; then
        gh api "repos/$REPO/pulls/$NUM" > "$TMPD/t-pr.json" 2>/dev/null || return 2
        # PR 响应同样整份核对：状态、派工中标签、保护标签（两次读之间可能变了）
        rc=0; rl_flow_check "$TMPD/t-pr.json" || rc=$?; [ "$rc" = 0 ] || return "$rc"
        merged=$(jq -r 'if (.merged | type) == "boolean" then .merged else "?" end' < "$TMPD/t-pr.json" 2>/dev/null) || return 2
        base=$(jq -r '.base.ref // ""' < "$TMPD/t-pr.json" 2>/dev/null) || return 2
        hrepo=$(jq -r '.head.repo.full_name // ""' < "$TMPD/t-pr.json" 2>/dev/null) || return 2
        hsha=$(jq -r '.head.sha // ""' < "$TMPD/t-pr.json" 2>/dev/null) || return 2
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
        # 读列表期间 issue 也可能被关掉或改了标签：最后再整份核对一次
        gh api "repos/$REPO/issues/$NUM" > "$TMPD/t-issue.json" 2>/dev/null || return 2
        rc=0; rl_flow_check "$TMPD/t-issue.json" || rc=$?; [ "$rc" = 0 ] || return "$rc"
        jq -e '.pull_request == null' < "$TMPD/t-issue.json" >/dev/null 2>&1 || return 2
    fi
    return 0
}

rl_gate() {   # 每一次写之前都跑；不通过就按结果收尾
    local rc=0
    rl_target || rc=$?
    case "$rc" in
        0) return 0 ;;
        1) finish 3 expired "目标已不归这次派工：$RL_WHY" ;;
        3) finish 64 usage "PR 上的交付必须给本次依据的提交和目标分支（--basis / --base）：补上重跑；不要改成单独发" ;;
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
    # 同一批 = 编号和每条的修改时间都一样（两次读之间有评论被改过，修改时间就不同）：写入计划用的原样正文和
    # 受保护读取判的作者 / 内容必须出自同一版本
    view_ids=$(printf '%s' "$OS_RES" | jq -r --arg s "$src" '[.view[]? | select(.src == $s) | "\(.id)@\(.updated // "")"] | sort | join(",")' 2>/dev/null) \
        || finish 5 unreadable "受保护读取的结果读不懂"
    raw_ids=$(jq -r '[.[] | "\(.id)@\(.updated // "")"] | sort | join(",")' < "$TMPD/c.json") || finish 5 unreadable "评论读不懂"
    [ "$view_ids" = "$raw_ids" ] || finish 5 unreadable "受保护读取和原样读取看到的评论不是同一批（编号或版本不同）"
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
case "$plan_rc" in
    0) ;;
    7) finish 3 expired "$(head -c 300 "$TMPD/plan.json")；不发、不翻标签" ;;
    # 评论区里已有的记录读不懂：分不清最新交付，和读评论失败一样处理——不改成单独发、不翻标签
    6) finish 5 unreadable "$(head -c 300 "$TMPD/plan.json")；什么都没写，照读评论失败的规则处理，不改成单独发" ;;
    8) finish 64 usage "$(head -c 300 "$TMPD/plan.json")；补上重跑，不要改成单独发" ;;
    # 只有「这一条本身不该进记录」才是拒收（3）；其余退出码（输入读不懂等）一律算读不全，不让它走单独发
    3) finish 2 rejected "$(head -c 300 "$TMPD/plan.json")；照现在单独发" ;;
    *) finish 5 unreadable "写入计划没算出来（退出码 ${plan_rc}）；什么都没写，照读评论失败的规则处理" ;;
esac
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
