#!/usr/bin/env bash
# 主轮询：systemd user timer / cron 定时调起。one-shot 风格。
# 行为：
#   1. 看 GitHub 上有没有普通或模型专用 pending label 的 issue → 派工
#   2. 看这些 label 的 PR → 检查新 comment ID → 派工
#   3. 派工时立刻把触发 label 翻成 doing/agent，防止 daemon 自己 re-dispatch
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

STATE_FILE="$STATE_DIR/state.json"
LOCK_FILE="$STATE_DIR/poll.lock"

[ -f "$STATE_FILE" ] || echo '{"seen_comments":{},"seen_issue_comments":{},"seen_review_comments":{},"seen_reviews":{},"worker_models":{},"worker_trigger_labels":{}}' > "$STATE_FILE"
# 老 state.json 缺新字段时补上（无破坏迁移；缺字段初始化为 {}）
for field in seen_issue_comments seen_review_comments seen_reviews worker_models worker_trigger_labels; do
    if [ "$(jq -r "has(\"$field\")" "$STATE_FILE")" != "true" ]; then
        tmp=$(mktemp)
        jq ".$field = {}" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
    fi
done

# flock 防多个 tick 撞车（万一某次跑慢了 > POLL_INTERVAL_SECS）
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "上一轮还没跑完，跳过"
    exit 0
fi

log "===== poll start ====="

pending_label_for_model() {
    case "$1" in
        "$FABLE_MODEL"|fable) echo "$LABEL_PENDING_AGENT_FABLE" ;;
        *) echo "$LABEL_PENDING_AGENT_DEFAULT" ;;
    esac
}

remember_worker_model() {
    local issue_n="$1"
    local model="$2"
    local tmp
    tmp=$(mktemp)
    if [ -n "$model" ]; then
        jq --arg key "$issue_n" --arg model "$model" \
            '.worker_models[$key] = $model' "$STATE_FILE" > "$tmp"
    else
        jq --arg key "$issue_n" \
            'del(.worker_models[$key])' "$STATE_FILE" > "$tmp"
    fi
    mv "$tmp" "$STATE_FILE"
}

# 记住这次派工是被**哪个** pending label 触发的。self-heal 要靠它把死掉的 worker
# 送回原来那条队列——只按 model 反推是不够的：review 关卡用的是另一个 agent 而不是
# 另一个 model，光看 model 会把 review 阶段的活错误地打回 pending/agent 让 claude 重做。
remember_trigger_label() {
    local issue_n="$1" label="$2" tmp
    tmp=$(mktemp)
    if [ -n "$label" ]; then
        jq --arg k "$issue_n" --arg v "$label" '.worker_trigger_labels[$k] = $v' "$STATE_FILE" > "$tmp"
    else
        jq --arg k "$issue_n" 'del(.worker_trigger_labels[$k])' "$STATE_FILE" > "$tmp"
    fi
    mv "$tmp" "$STATE_FILE"
}

# ── 0. Zombie label self-heal ──
# label=doing/agent 但对应 tmux session 不存在 = 假阳性 active：worker 进程死掉时
# 没机会自己翻 label 回 pending/human（worker crash / tmux server 重启 / 手动 kill
# 等），daemon 后续看 label 仍当 active worker、撑满 max_concurrent。
# 这里在算 active 之前先扫一遍 doing/agent label 项，把 session 不存在的翻回
# 原触发模型的 pending label 并记录警告，让下一轮自动 fallback resume。
zombie_pr_data=$(gh pr list --repo "$REPO" --label "$LABEL_AGENT_DOING" \
    --json number,headRefName --jq '.[] | "\(.number)\t\(.headRefName)"' 2>/dev/null || true)
zombie_issue_nums=$(gh issue list --repo "$REPO" --state open --label "$LABEL_AGENT_DOING" \
    --json number --jq '.[] | .number' 2>/dev/null || true)

self_heal_one() {
    local kind="$1"   # "PR" / "issue"
    local n="$2"      # 真编号（PR 编号 or issue 编号）
    local issue_n="$3"   # 用来推 session name（PR 走 pr_to_issue_num 链；issue 自己）
    local sess
    sess="$(tmux_session_name "$issue_n")"
    if session_alive "$sess"; then
        selfheal_reset "$issue_n"   # 活着 → 清连续失败计数
        return 0                    # session 真活着，不是 zombie
    fi
    # session 死了：优先自动重新派工（翻回 pending/agent，下面的派工路径会 resume/fresh），
    # 只有连续自愈 SELFHEAL_MAX_RETRIES 次仍立刻死（多半是损坏会话）才转人工，避免无限重启烧 API。
    local tries cap=${SELFHEAL_MAX_RETRIES:-3}
    local model pending_label
    model=$(jq -r --arg key "$issue_n" '.worker_models[$key] // ""' "$STATE_FILE")
    # 优先用派工时记下的触发 label（review 关卡靠它才能送回 review 队列而不是打回 claude）；
    # 老条目没有这个字段时回落到按 model 反推。
    pending_label=$(jq -r --arg key "$issue_n" '.worker_trigger_labels[$key] // ""' "$STATE_FILE")
    [ -n "$pending_label" ] || pending_label="$(pending_label_for_model "$model")"
    tries=$(selfheal_bump "$issue_n")
    if [ "$tries" -le "$cap" ]; then
        log "🔄 self-heal: $kind #$n session=$sess 不存在 → 自动重新派工（第 $tries/$cap 次，model=${model:-default}，翻 $LABEL_AGENT_DOING → $pending_label）"
        run_gh "label 翻转 (self-heal $kind #$n doing/agent → pending/agent)" \
            gh_label_flip "$n" \
            --add "$pending_label" \
            --remove "$LABEL_AGENT_DOING" || true
    else
        log "⚠️ self-heal: $kind #$n 自动恢复 $((tries - 1)) 次仍死（疑似会话损坏）→ 转人工 $LABEL_PENDING_HUMAN"
        run_gh "label 翻转 (self-heal $kind #$n doing/agent → pending/human)" \
            gh_label_flip "$n" \
            --add "$LABEL_PENDING_HUMAN" \
            --remove "$LABEL_AGENT_DOING" || true
        selfheal_reset "$issue_n"   # 重置，人工重标 pending/agent 后重新计数
    fi
}

if [ -n "$zombie_pr_data" ]; then
    while IFS=$'\t' read -r pr branch; do
        n=$(pr_to_issue_num "$pr" "$branch")
        self_heal_one "PR" "$pr" "$n"
    done <<< "$zombie_pr_data"
fi
if [ -n "$zombie_issue_nums" ]; then
    while read -r issue_n; do
        [ -z "$issue_n" ] && continue
        # 跳过被 PR 关联过的（上面 PR pass 已处理同 session_name）
        # 简单做法：让 self_heal_one 内部用 has-session 兜底——已 self-heal 过的 session
        # 不存在但 label 已翻、issue 没在 zombie_issue_nums 里出现，这里只处理纯 issue 的
        self_heal_one "issue" "$issue_n" "$issue_n"
    done <<< "$zombie_issue_nums"
fi

# 计活的 worker：用 GitHub 上 doing/agent label 作真值（label 由 daemon dispatch 时贴、
# worker 完工时翻 pending/human；期间在 label 上就算 active）。busy 时把具体 issue/PR
# 编号也带在 log 里，方便看 max=1 撑住的是谁。
active_list=$(list_active_workers)
# 真·全局并发上限：active_keys 收所有在跑 worker 的 issue_n（每行第一个数字就是 key——
# "PR #123 ..."→123、"issue #45 (PR #46) ..."→45、"issue #45 ..."→45）。下面所有派工路径
# 都过 reserve_slot：同一 worker（key 已在集合）复用 slot 防自死锁；新 worker 满了排队。
declare -A active_keys=()
while IFS= read -r _aw_line; do
    [ -z "$_aw_line" ] && continue
    _aw_key=$(printf '%s' "$_aw_line" | grep -oE '[0-9]+' | head -1)
    if [ -n "$_aw_key" ]; then active_keys[$_aw_key]=1; fi
done <<< "$active_list"
active_workers=${#active_keys[@]}

# 返回 0=可派工（slot 已占或复用），1=已满需排队。用 if/fi 不用 `[ ] && return`
# 短路（避免 set -e 下 cond 为假把 status 1 漏给 caller）。
reserve_slot() {
    local key="$1"
    if [ -n "${active_keys[$key]:-}" ]; then
        return 0
    fi
    if [ "${#active_keys[@]}" -ge "${MAX_CONCURRENT_WORKERS:-1}" ]; then
        return 1
    fi
    active_keys[$key]=1
    return 0
}
if [ "$active_workers" -gt 0 ]; then
    active_summary=$(printf '%s' "$active_list" | paste -sd ',' - | sed 's/,/, /g')
    log "active workers (doing/agent): $active_workers (max=${MAX_CONCURRENT_WORKERS:-1}) — $active_summary"
else
    log "active workers (doing/agent): 0 (max=${MAX_CONCURRENT_WORKERS:-1})"
fi

# ── 1 & 2. 派工队列（issue + PR 合成一个池，排序后统一取工）──
# 待派工的条目常多于 MAX_CONCURRENT_WORKERS。以前是「按 label 分六趟扫，每趟内按
# GitHub 列表默认序（创建时间倒序）」——谁先被扫到谁抢到 slot，实际效果是**新建的活
# 优先**，那是列表顺序的副产品，不是设计。现在先把所有队列合成一个候选池，按三个键
# 排完再依次取工：
#
#   ① 优先级 label：PRIORITY_LABELS 里越靠前越优先；没打标签的等同**最后一档**
#      （所以平时什么都不用打，只在真着急时挂一个 priority/p0 插队）
#   ② 阶段：review 打回(0) < 续作(1) < 全新 issue(2)
#      在飞的活已经烧过 token、上下文还热，先收尾能更快腾出 slot；全新 issue 还没
#      开始，晚一轮没有沉没成本
#   ③ 等待时长：updatedAt 早的先派（久等的先）
#
# 只改**取工顺序**，不改取工条件：busy 不打断、并发上限、label 语义全部照旧。
# 同一条目同时挂多个触发 label 时按 fable > 默认 > review 取第一个（与改版前一致）。

# 候选行用 \x1f(US) 分隔而不是 TAB：TAB 属于 IFS whitespace，`read` 会把连续两个
# 折成一个，model / prompt_kind 这类**允许为空**的字段会整体错位。
US=$'\x1f'
QUEUE_ROWS=""
REVIEW_CAPPED=""
declare -A queued_keys=()

IFS=',' read -r -a _prio_labels <<< "${PRIORITY_LABELS:-}"
# 没打优先级标签的排在最后一档；列表只配了 1 个标签时，没打的排在它之后
if [ "${#_prio_labels[@]}" -gt 1 ]; then
    _prio_rank_default=$(( ${#_prio_labels[@]} - 1 ))
else
    _prio_rank_default=${#_prio_labels[@]}
fi

priority_rank() {
    local labels_csv=",$1," i l
    for (( i = 0; i < ${#_prio_labels[@]}; i++ )); do
        l="${_prio_labels[$i]}"
        [ -n "$l" ] || continue
        case "$labels_csv" in
            *",$l,"*) echo "$i"; return ;;
        esac
    done
    echo "$_prio_rank_default"
}

stage_rank() {
    local kind="$1" trigger_label="$2" num="$3" sess wt
    if [ -n "${LABEL_PENDING_REVIEW:-}" ] && [ "$trigger_label" = "$LABEL_PENDING_REVIEW" ]; then
        echo 0; return   # review 打回：离完工最近
    fi
    if [ "$kind" = "pr" ]; then
        echo 1; return   # PR 一定有分支/worktree，天然是续作
    fi
    sess="$(tmux_session_name "$num")"
    wt="$(worktree_path "$num")"
    if session_alive "$sess" || [ -d "$wt" ]; then echo 1; else echo 2; fi
}

# 结果直接追加到全局 QUEUE_ROWS（不走 $(...)——命令替换会开子 shell，queued_keys 去重表就丢了）
collect_queue_rows() {
    local kind="$1" trigger_label="$2" model="$3" worker_agent="$4" prompt_kind="$5"
    [ -n "$trigger_label" ] || return 0
    local raw num branch updated labels_csv title prio stage key
    if [ "$kind" = "issue" ]; then
        raw=$(gh issue list --repo "$REPO" --state open --label "$trigger_label" \
            --json number,title,labels,updatedAt \
            --jq '.[] | [(.number|tostring), "-", .updatedAt, ([.labels[].name]|join(",")), (.title|gsub("[\t\n]";" "))] | @tsv' 2>/dev/null || true)
    else
        raw=$(gh pr list --repo "$REPO" --label "$trigger_label" \
            --json number,title,labels,updatedAt,headRefName \
            --jq '.[] | [(.number|tostring), .headRefName, .updatedAt, ([.labels[].name]|join(",")), (.title|gsub("[\t\n]";" "))] | @tsv' 2>/dev/null || true)
    fi
    [ -n "$raw" ] || return 0
    while IFS=$'\t' read -r num branch updated labels_csv title; do
        [ -n "$num" ] || continue
        key="$kind:$num"
        [ -z "${queued_keys[$key]:-}" ] || continue
        queued_keys[$key]=1
        # review 轮次烧光的条目会**同时**挂着 pending/review + pending/human：留着
        # pending/review 是为了在看板上区分「审过了等人拍板」（只有 pending/human）和
        # 「轮次用尽等人介入」（两个都在）。后者不该再被派工——两个 agent 已经互相
        # 打回到上限了，daemon 再送进去就是继续烧 API。人手动摘掉 pending/human
        # （= 明确说「继续」）才重新入队。
        if [ "$trigger_label" = "${LABEL_PENDING_REVIEW:-}" ]; then
            case ",$labels_csv," in
                *",$LABEL_PENDING_HUMAN,"*)
                    REVIEW_CAPPED+=" ${kind}#${num}"
                    continue ;;
            esac
        fi
        prio=$(priority_rank "$labels_csv")
        stage=$(stage_rank "$kind" "$trigger_label" "$num")
        QUEUE_ROWS+="${prio}${US}${stage}${US}${updated}${US}${kind}${US}${num}${US}${branch}${US}${trigger_label}${US}${model}${US}${worker_agent}${US}${prompt_kind}${US}${title}"$'\n'
    done <<< "$raw"
}

dispatch_one_issue() {
    local num="$1" title="$2" trigger_label="$3" model="$4" worker_agent="$5" prompt_kind="$6"
    local sess wt latest_id tmp
    sess="$(tmux_session_name "$num")"
    wt="$(worktree_path "$num")"

    # 已有 session → 用户确认方案后标 pending/agent，走 issue-comment 派工。
    # pending/agent 是用户明确意图信号（包括勾选 checkbox、编辑 comment 等不产生新 comment ID 的操作），
    # 所以不依赖 comment ID 变化，只要 agent 不在忙就派工。
    if session_alive "$sess" || [ -d "$wt" ]; then
        latest_id=$(gh api --paginate "repos/$REPO/issues/$num/comments" --jq '.[-1].id // 0' 2>/dev/null || echo 0)
        log "issue #$num 已有 worktree/session (latest_id=$latest_id, agent=${worker_agent:-default}, model=${model:-default})"
        if session_alive "$sess" && agent_is_busy "$sess"; then
            log "issue #$num: agent 正在忙，跳过本轮"
            return 0
        fi
        if ! reserve_slot "$num"; then
            log "issue #$num: 已达并发上限 max=${MAX_CONCURRENT_WORKERS:-1}，重派工排队等下一轮"
            return 0
        fi
        log "dispatch issue-comment for #$num (agent=${worker_agent:-default}, model=${model:-default})"
        remember_worker_model "$num" "$model"
        remember_trigger_label "$num" "$trigger_label"
        if DISPATCH_PENDING_AGENT_LABEL="$trigger_label" DISPATCH_WORKER_AGENT="$worker_agent" WORKER_MODEL="$model" DISPATCH_PROMPT_KIND="$prompt_kind" \
            bash "$SCRIPT_DIR/dispatch-issue-comment.sh" "$num" "$latest_id"; then
            tmp=$(mktemp)
            jq ".seen_issue_comments[\"$num\"] = $latest_id" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
        else
            log "issue-comment 派工 #$num 失败（comment cursor 不更新，下轮重试）"
        fi
        return 0
    fi

    # 没 worktree / session → 全新 issue 第一次派工（走设计分析阶段）
    if ! reserve_slot "$num"; then
        log "已达并发上限 max=${MAX_CONCURRENT_WORKERS:-1}，issue #$num 排队等下一轮"
        return 0
    fi
    log "dispatch new issue #$num: $title (agent=${worker_agent:-default}, model=${model:-default})"
    remember_worker_model "$num" "$model"
    remember_trigger_label "$num" "$trigger_label"
    if ! DISPATCH_PENDING_AGENT_LABEL="$trigger_label" DISPATCH_WORKER_AGENT="$worker_agent" WORKER_MODEL="$model" DISPATCH_PROMPT_KIND="$prompt_kind" \
        bash "$SCRIPT_DIR/dispatch-new-issue.sh" "$num"; then
        log "派工 issue #$num 失败"
    fi
}

# PR 上的「评论」其实有三种，存三个不同 endpoint，ID 序列也是独立的：
#   - /issues/N/comments  ← Conversation tab 的对话评论
#   - /pulls/N/comments   ← Files Changed 上 inline 的 review comments
#   - /pulls/N/reviews    ← 整次 review 提交（Approve/Request changes/Comment 的整体 body）
# state.json 里分三个字段各存最新 ID。
dispatch_one_pr() {
    local prnum="$1" branch="$2" trigger_label="$3" model="$4" worker_agent="$5" prompt_kind="$6"
    local issue_n sess latest_conv latest_inline latest_review
    local seen_conv seen_inline seen_review kick_id tmp
    issue_n=$(pr_to_issue_num "$prnum" "$branch")
    sess="$(tmux_session_name "$issue_n")"

    # --paginate：gh api 默认只返第一页（per_page=30）。PR 评论 / inline review
    # 多到 30+ 时 .[-1] 就拿不到真正最新的，少 paginate daemon 看不见后面 7 条。
    # 实测 PR #105 撞过：37 条评论，第 31-37 漏掉 → seen 永远 == 老 latest。
    latest_conv=$(gh api --paginate "repos/$REPO/issues/$prnum/comments" --jq '.[-1].id // 0' 2>/dev/null || echo 0)
    latest_inline=$(gh api --paginate "repos/$REPO/pulls/$prnum/comments" --jq '.[-1].id // 0' 2>/dev/null || echo 0)
    latest_review=$(gh api --paginate "repos/$REPO/pulls/$prnum/reviews" --jq '.[-1].id // 0' 2>/dev/null || echo 0)
    seen_conv=$(jq -r ".seen_comments[\"$prnum\"] // 0" "$STATE_FILE")
    seen_inline=$(jq -r ".seen_review_comments[\"$prnum\"] // 0" "$STATE_FILE")
    seen_review=$(jq -r ".seen_reviews[\"$prnum\"] // 0" "$STATE_FILE")
    log "PR #$prnum: conv=$latest_conv/$seen_conv inline=$latest_inline/$seen_inline review=$latest_review/$seen_review agent=${worker_agent:-default} model=${model:-default}"

    # busy 时不打断（保护正在干活的 worker；新评论 / 重标 都等下一轮 idle）
    if session_alive "$sess" && agent_is_busy "$sess"; then
        log "PR #$prnum: agent 正在忙，跳过本轮"
        return 0
    fi
    if ! reserve_slot "$issue_n"; then
        log "PR #$prnum: 已达并发上限 max=${MAX_CONCURRENT_WORKERS:-1}，排队等下一轮"
        return 0
    fi

    # Dispatch 触发条件：label=pending/agent（已过滤）+ 不忙。
    # **不**依赖 comment id 变化——label 翻 pending/agent 本身就是 user 明确意图
    # 信号（可能是新评论 + 重标、可能是没新评论纯重派工恢复死掉的 worker）。
    # dispatch 后 daemon 在 § Case A/B 翻 label 到 doing/agent，下轮 daemon 不会
    # 再 trigger 同 PR（label 不是 pending/agent 了），不会死循环。
    log "dispatch PR #$prnum comment (agent=${worker_agent:-default}, model=${model:-default})"
    # 透传最大的 ID 给 dispatch（仅用于 prompt 文件命名去重，不参与语义）
    kick_id=$(printf '%s\n%s\n%s\n' "$latest_conv" "$latest_inline" "$latest_review" | sort -rn | head -1)
    remember_worker_model "$issue_n" "$model"
    remember_trigger_label "$issue_n" "$trigger_label"
    if DISPATCH_PENDING_AGENT_LABEL="$trigger_label" DISPATCH_WORKER_AGENT="$worker_agent" WORKER_MODEL="$model" DISPATCH_PROMPT_KIND="$prompt_kind" \
        bash "$SCRIPT_DIR/dispatch-pr-comment.sh" "$prnum" "$branch" "$kick_id"; then
        tmp=$(mktemp)
        jq ".seen_comments[\"$prnum\"] = $latest_conv | .seen_review_comments[\"$prnum\"] = $latest_inline | .seen_reviews[\"$prnum\"] = $latest_review" \
            "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
    else
        log "PR #$prnum 派工失败（comment cursors 不更新，下轮重试）"
    fi
}

# 收集顺序 = 同条目挂多个触发 label 时的取舍顺序（fable > 默认 > review），
# 与排序无关：排序只认上面那三个键。
collect_queue_rows issue "$LABEL_PENDING_AGENT_FABLE" "$FABLE_MODEL" "$FABLE_WORKER_AGENT" ""
collect_queue_rows issue "$LABEL_PENDING_AGENT_DEFAULT" "" "" ""
collect_queue_rows pr "$LABEL_PENDING_AGENT_FABLE" "$FABLE_MODEL" "$FABLE_WORKER_AGENT" ""
collect_queue_rows pr "$LABEL_PENDING_AGENT_DEFAULT" "" "" ""
# 交叉 review 关卡：用另一个 agent（默认 codex）+ review 专用模板。留空则整段跳过。
if [ -n "${LABEL_PENDING_REVIEW:-}" ]; then
    collect_queue_rows issue "$LABEL_PENDING_REVIEW" "$REVIEW_MODEL" "$REVIEW_WORKER_AGENT" "review"
    collect_queue_rows pr "$LABEL_PENDING_REVIEW" "$REVIEW_MODEL" "$REVIEW_WORKER_AGENT" "review"
fi

if [ -n "$REVIEW_CAPPED" ]; then
    log "review 轮次已用尽、挂着 $LABEL_PENDING_HUMAN 等人工（本轮不派工，摘掉该标签才恢复）:$REVIEW_CAPPED"
fi

QUEUE_SORTED=""
if [ -n "$QUEUE_ROWS" ]; then
    QUEUE_SORTED=$(printf '%s' "$QUEUE_ROWS" | sort -t"$US" -k1,1n -k2,2n -k3,3)
fi

if [ -n "$QUEUE_SORTED" ]; then
    # 队列顺序整行打出来：并发满时到底谁插了谁的队，只看这一行就够
    queue_summary=$(printf '%s\n' "$QUEUE_SORTED" | awk -v FS="$US" '
        { stage = ($2 == 0 ? "review打回" : ($2 == 1 ? "续作" : "全新"));
          printf "%s%s#%s(p%s,%s)", (NR > 1 ? " " : ""), ($4 == "pr" ? "PR" : "issue"), $5, $1, stage }')
    log "派工队列 $(printf '%s\n' "$QUEUE_SORTED" | wc -l) 项，按「优先级/阶段/等待」排：$queue_summary"

    while IFS="$US" read -r q_prio q_stage q_updated q_kind q_num q_branch q_label q_model q_agent q_kind_prompt q_title; do
        [ -n "${q_num:-}" ] || continue
        if [ "$q_kind" = "issue" ]; then
            dispatch_one_issue "$q_num" "$q_title" "$q_label" "$q_model" "$q_agent" "$q_kind_prompt"
        else
            dispatch_one_pr "$q_num" "$q_branch" "$q_label" "$q_model" "$q_agent" "$q_kind_prompt"
        fi
    done < <(printf '%s\n' "$QUEUE_SORTED")
fi

# ── 3. 自动 cleanup merged PRs ──
# 配 AUTO_CLEANUP_ON_MERGE=false 可关闭整段
if [ "${AUTO_CLEANUP_ON_MERGE:-true}" != "false" ]; then
    # Bootstrap：state.json 第一次出现这字段 = 把当前所有 merged PR 标已清，
    # 避免历史 PR 被乱清
    if [ "$(jq -r '.cleaned_prs // "MISSING"' "$STATE_FILE")" = "MISSING" ]; then
        initial=$(gh pr list --repo "$REPO" --state merged --limit 200 \
            --json number --jq '[.[].number]' 2>/dev/null || echo '[]')
        [ -z "$initial" ] && initial='[]'
        tmp=$(mktemp)
        jq ".cleaned_prs = $initial" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
        log "auto-cleanup bootstrap: 标记 $(echo "$initial" | jq length) 个历史 merged PR 为已清"
    fi

    recent_merged=$(gh pr list --repo "$REPO" --state merged --limit 30 \
        --json number,headRefName --jq '.[] | "\(.number)\t\(.headRefName)"' 2>/dev/null || true)

    if [ -n "$recent_merged" ]; then
        while IFS=$'\t' read -r prnum branch; do
            if jq -e ".cleaned_prs | index($prnum)" "$STATE_FILE" >/dev/null 2>&1; then
                continue
            fi
            NEW_MERGE_SEEN=1
            issue_n=$(pr_to_issue_num "$prnum" "$branch")
            # pr_to_issue_num fallback 链兜底到 PR 编号本身，理论上永不空
            if [ -z "$issue_n" ]; then
                log "auto-cleanup: PR #$prnum 无法 derive 工作编号（异常），标记为已清不再扫"
                tmp=$(mktemp)
                jq ".cleaned_prs += [$prnum]" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
                continue
            fi
            log "auto-cleanup PR #$prnum (issue #$issue_n) → cleanup-issue.sh --force"
            # PR 已合并，worktree 残留文件（构建产物、QR 码等）不需要保留，--force 强删。
            # 默认不删本地分支（保留 commit 历史可 checkout / git log）；
            # 远端分支 daemon 从来不动（GitHub auto-delete-branch-on-merge 由仓库设置控制）。
            # 想顺手删本地，用户手动 `cleanup-issue.sh <N> --delete-branch`。
            if bash "$SCRIPT_DIR/cleanup-issue.sh" "$issue_n" --force 2>&1; then
                tmp=$(mktemp)
                jq ".cleaned_prs += [$prnum]" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
                remember_worker_model "$issue_n" ""
                remember_trigger_label "$issue_n" ""
                log "  auto-cleanup PR #$prnum done"

                # PR：merge 完，PR 这件事真结束 → Done
                run_gh "auto-cleanup label PR #$prnum → Done" \
                    gh_label_flip "$prnum" \
                    --add "$LABEL_DONE" \
                    --remove "$LABEL_PENDING_HUMAN" "$LABEL_PENDING_AGENT_DEFAULT" "$LABEL_PENDING_AGENT_FABLE" "$LABEL_PENDING_REVIEW" "$LABEL_AGENT_DOING" || true

                # Issue：看实际状态决定怎么标
                # - CLOSED（PR body 是 Closes #N，GitHub auto-close）→ 加 Done（与 PR 同闭环）
                # - OPEN（PR body 是 Refs #N，长期 tracker 模式）→ 翻 pending/human（等你 triage 是否真完结）
                issue_state=$(gh issue view "$issue_n" --repo "$REPO" --json state --jq .state 2>/dev/null || echo "OPEN")
                if [ "$issue_state" = "CLOSED" ]; then
                    run_gh "auto-cleanup label issue #$issue_n → Done" \
                        gh_label_flip "$issue_n" \
                        --add "$LABEL_DONE" \
                        --remove "$LABEL_PENDING_PR" "$LABEL_PENDING_HUMAN" "$LABEL_PENDING_AGENT_DEFAULT" "$LABEL_PENDING_AGENT_FABLE" "$LABEL_PENDING_REVIEW" "$LABEL_AGENT_DOING" || true
                    log "  PR #$prnum → Done；issue #$issue_n CLOSED (Closes #N) → Done"
                else
                    run_gh "auto-cleanup label issue #$issue_n → pending/human" \
                        gh_label_flip "$issue_n" \
                        --add "$LABEL_PENDING_HUMAN" \
                        --remove "$LABEL_PENDING_PR" "$LABEL_PENDING_AGENT_DEFAULT" "$LABEL_PENDING_AGENT_FABLE" "$LABEL_PENDING_REVIEW" "$LABEL_AGENT_DOING" || true
                    log "  PR #$prnum → Done；issue #$issue_n OPEN (Refs #N) → pending/human"
                fi
            else
                log "  auto-cleanup PR #$prnum 失败（busy/dirty/hook 报错），下轮重试"
            fi
        done <<< "$recent_merged"
    fi

    # ── 3b. merge 钩子：新 merge → 刷新常驻「最新站」（GigleTutor-Web#516，Q1=A）──
    # 项目 config 里 LATEST_SITE_REFRESH=true 才启用；脚本自身幂等（HEAD 没变且
    # session 活着直接跳过），后台跑不阻塞轮询；build 失败保留旧 session。
    if [ -n "${NEW_MERGE_SEEN:-}" ] && [ "${LATEST_SITE_REFRESH:-false}" = "true" ]; then
        log "merge 钩子：检测到新 merged PR → 后台刷新最新站（log → $STATE_DIR/latest-site.log）"
        nohup bash "$SCRIPT_DIR/refresh-latest-site.sh" >> "$STATE_DIR/latest-site.log" 2>&1 &
    fi

    # ── 3c. PR closed 但没 merge → 摘掉 issue 上残留的 pending/PR ──
    # § 3 只走 merged 那条路。PR 被**关闭而非合并**（方案被推翻 / 拆成新 PR 重开 /
    # 作者放弃）时没有任何地方翻 label，issue 就一直挂着 pending/PR——列表上显示
    # 「工作已转 PR 跟踪」，而那个 PR 早就没了（GigleTutor-Web #64 / #274 / #336 即此）。
    #
    # 只动 label，不碰 worktree / 分支：PR 关掉不等于那些 commit 该删，很可能还要在
    # 新 PR 里捡回来。真正的清理仍归 § 4（issue 被 close 时）或用户手动 cleanup-issue.sh。
    #
    # 用 --search 而不是 --state closed：后者把 merged 也算作 closed，且按**创建**时间
    # 倒序——未合并的 PR 往往创建得早、关得晚，本机实测 5 个全排在第 141~180 名，
    # `--limit 30` 的窗口一个都扫不到，规则等于白写。is:unmerged + sort:updated-desc 才对。
    unmerged_prs=$(gh pr list --repo "$REPO" --search "is:closed is:unmerged sort:updated-desc" \
        --limit 30 --json number,headRefName --jq '.[] | "\(.number)\t\(.headRefName)"' 2>/dev/null || true)

    if [ -n "$unmerged_prs" ]; then
        # 还开着的 PR 各自对应的工作编号。懒加载：只有真有待处理项才多花这一次 API。
        open_worknums=""
        while IFS=$'\t' read -r prnum branch; do
            [ -z "$prnum" ] && continue
            if jq -e --argjson n "$prnum" '(.unmerged_prs_handled // []) | index($n)' "$STATE_FILE" >/dev/null 2>&1; then
                continue
            fi

            if [ -z "$open_worknums" ]; then
                while IFS=$'\t' read -r opr obr; do
                    [ -z "$opr" ] && continue
                    open_worknums="$open_worknums $(pr_to_issue_num "$opr" "$obr") "
                done < <(gh pr list --repo "$REPO" --state open --limit 100 \
                    --json number,headRefName --jq '.[] | "\(.number)\t\(.headRefName)"' 2>/dev/null || true)
                # 一个 open PR 都没有时也要置成非空，否则每轮循环都重新拉一次
                open_worknums="${open_worknums:- }"
            fi

            issue_n=$(pr_to_issue_num "$prnum" "$branch")
            # 走 /issues/N 而不是 gh issue view：这个 endpoint 同时覆盖 issue 和 PR，
            # standalone PR（pr_to_issue_num 兜底成 PR 编号自己）也查得到，不会 not found。
            issue_json=$(gh api "repos/$REPO/issues/$issue_n" --jq '{s: .state, l: [.labels[].name]}' 2>/dev/null || true)
            if [ -z "$issue_json" ]; then
                log "PR #$prnum (closed 未合并): 读 #$issue_n 失败，下轮重试"
                continue
            fi

            if printf '%s' "$issue_json" | jq -e --arg L "$LABEL_PENDING_PR" '.l | index($L)' >/dev/null 2>&1; then
                # 同一个 issue 完全可能「旧 PR 关了、新 PR 开着」，这时 pending/PR 属于
                # 新那个，摘了就把还在 review 的工作从看板上抹掉了。此处不标记已处理，
                # 等新 PR 有结果后的某一轮再重新判定。
                case "$open_worknums" in
                    *" $issue_n "*)
                        log "PR #$prnum closed 未合并，但 #$issue_n 还有别的 PR 开着 → 保留 $LABEL_PENDING_PR"
                        continue
                        ;;
                esac

                issue_state=$(printf '%s' "$issue_json" | jq -r '.s' | tr '[:upper:]' '[:lower:]')
                if [ "$issue_state" = "open" ]; then
                    # PR 没落地、issue 还开着 → 这事回到人手上决策
                    run_gh "PR #$prnum closed 未合并 → issue #$issue_n $LABEL_PENDING_PR → $LABEL_PENDING_HUMAN" \
                        gh_label_flip "$issue_n" \
                        --add "$LABEL_PENDING_HUMAN" \
                        --remove "$LABEL_PENDING_PR" || true
                    log "PR #$prnum closed 未合并 → issue #$issue_n OPEN，$LABEL_PENDING_PR → $LABEL_PENDING_HUMAN"
                else
                    # issue 早已 close，人已经处理完 → 只摘残留标签，不加任何 pending 态
                    run_gh "PR #$prnum closed 未合并 → issue #$issue_n 摘 $LABEL_PENDING_PR" \
                        gh_label_flip "$issue_n" \
                        --remove "$LABEL_PENDING_PR" || true
                    log "PR #$prnum closed 未合并 → issue #$issue_n 已 CLOSED，摘掉残留 $LABEL_PENDING_PR"
                fi
            fi

            tmp=$(mktemp)
            jq --argjson n "$prnum" '.unmerged_prs_handled = ((.unmerged_prs_handled // []) + [$n])' \
                "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
        done <<< "$unmerged_prs"
    fi

    # ── 4. 自动 cleanup 直接 close 的 issue（无关联 merged PR）──
    # § 3 通过 PR 反推 issue 清理；但有的 issue 不经 PR 直接被 close（duplicate / won't
    # fix / 决定不做了）—— § 3 看不到。这里扫最近 closed issue 兜底。
    # cleanup-issue.sh 是 idempotent（worktree / session 不存在就 skip），即便 § 3 已清
    # 过的 issue 这里再跑一次也无害。
    if [ "$(jq -r '.cleaned_issues // "MISSING"' "$STATE_FILE")" = "MISSING" ]; then
        initial=$(gh issue list --repo "$REPO" --state closed --limit 200 \
            --json number --jq '[.[].number]' 2>/dev/null || echo '[]')
        [ -z "$initial" ] && initial='[]'
        tmp=$(mktemp)
        jq ".cleaned_issues = $initial" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
        log "auto-cleanup bootstrap (closed issues): 标记 $(echo "$initial" | jq length) 个历史 closed issue 为已清"
    fi

    recent_closed=$(gh issue list --repo "$REPO" --state closed --limit 30 \
        --json number --jq '.[].number' 2>/dev/null || true)

    if [ -n "$recent_closed" ]; then
        while read -r issnum; do
            [ -z "$issnum" ] && continue
            if jq -e ".cleaned_issues | index($issnum)" "$STATE_FILE" >/dev/null 2>&1; then
                continue
            fi
            log "auto-cleanup closed issue #$issnum → cleanup-issue.sh --force"
            if bash "$SCRIPT_DIR/cleanup-issue.sh" "$issnum" --force 2>&1; then
                tmp=$(mktemp)
                jq ".cleaned_issues += [$issnum]" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
                remember_worker_model "$issnum" ""
                remember_trigger_label "$issnum" ""
                log "  auto-cleanup closed issue #$issnum done"
            else
                log "  auto-cleanup closed issue #$issnum 失败（busy/dirty），下轮重试"
            fi
        done <<< "$recent_closed"
    fi
fi

log "===== poll done ====="
