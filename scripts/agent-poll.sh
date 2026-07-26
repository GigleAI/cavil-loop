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

[ -f "$STATE_FILE" ] || echo '{"seen_comments":{},"seen_issue_comments":{},"seen_review_comments":{},"seen_reviews":{},"worker_models":{}}' > "$STATE_FILE"
# 老 state.json 缺新字段时补上（无破坏迁移；缺字段初始化为 {}）
for field in seen_issue_comments seen_review_comments seen_reviews worker_models; do
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
    pending_label="$(pending_label_for_model "$model")"
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

# ── 1. 新 issue 派工 ──
# 特定模型标签先扫；若同一 issue 同时有普通 + fable 标签，普通 pass 跳过，
# 防止 fable 因 busy / 并发上限排队时被默认模型抢先派工。
declare -A fable_issue_keys=()

dispatch_pending_issues() {
    local trigger_label="$1"
    local model="$2"
    local worker_agent="$3"
    local new_issues
    new_issues=$(gh issue list --repo "$REPO" --state open --label "$trigger_label" \
        --json number,title --jq '.[] | "\(.number)\t\(.title)"' 2>/dev/null || true)

    [ -n "$new_issues" ] || return 0

    while IFS=$'\t' read -r num title; do
        if [ "$trigger_label" = "$LABEL_PENDING_AGENT_FABLE" ]; then
            fable_issue_keys[$num]=1
        elif [ -n "${fable_issue_keys[$num]:-}" ]; then
            continue
        fi

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
                continue
            fi
            if ! reserve_slot "$num"; then
                log "issue #$num: 已达并发上限 max=${MAX_CONCURRENT_WORKERS:-1}，重派工排队等下一轮"
                continue
            fi
            log "dispatch issue-comment for #$num (agent=${worker_agent:-default}, model=${model:-default})"
            remember_worker_model "$num" "$model"
            if DISPATCH_PENDING_AGENT_LABEL="$trigger_label" DISPATCH_WORKER_AGENT="$worker_agent" WORKER_MODEL="$model" \
                bash "$SCRIPT_DIR/dispatch-issue-comment.sh" "$num" "$latest_id"; then
                tmp=$(mktemp)
                jq ".seen_issue_comments[\"$num\"] = $latest_id" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
            else
                log "issue-comment 派工 #$num 失败（comment cursor 不更新，下轮重试）"
            fi
            continue
        fi

        # 没 worktree / session → 全新 issue 第一次派工（走设计分析阶段）
        if ! reserve_slot "$num"; then
            log "已达并发上限 max=${MAX_CONCURRENT_WORKERS:-1}，issue #$num 排队等下一轮"
            continue
        fi
        log "dispatch new issue #$num: $title (agent=${worker_agent:-default}, model=${model:-default})"
        remember_worker_model "$num" "$model"
        if ! DISPATCH_PENDING_AGENT_LABEL="$trigger_label" DISPATCH_WORKER_AGENT="$worker_agent" WORKER_MODEL="$model" \
            bash "$SCRIPT_DIR/dispatch-new-issue.sh" "$num"; then
            log "派工 issue #$num 失败"
        fi
    done <<< "$new_issues"
}

dispatch_pending_issues "$LABEL_PENDING_AGENT_FABLE" "$FABLE_MODEL" "$FABLE_WORKER_AGENT"
dispatch_pending_issues "$LABEL_PENDING_AGENT_DEFAULT" "" ""

# ── 2. PR 评论派工 ──
# PR 上的「评论」其实有三种，存三个不同 endpoint，ID 序列也是独立的：
#   - /issues/N/comments  ← Conversation tab 的对话评论
#   - /pulls/N/comments   ← Files Changed 上 inline 的 review comments
#   - /pulls/N/reviews    ← 整次 review 提交（Approve/Request changes/Comment 的整体 body）
# 任意一个有新增就派工；state.json 里分三个字段各存最新 ID。
declare -A fable_pr_keys=()

dispatch_pending_prs() {
    local trigger_label="$1"
    local model="$2"
    local worker_agent="$3"
    local pending_prs
    pending_prs=$(gh pr list --repo "$REPO" --label "$trigger_label" \
        --json number,headRefName --jq '.[] | "\(.number)\t\(.headRefName)"' 2>/dev/null || true)

    [ -n "$pending_prs" ] || return 0

    while IFS=$'\t' read -r prnum branch; do
        if [ "$trigger_label" = "$LABEL_PENDING_AGENT_FABLE" ]; then
            fable_pr_keys[$prnum]=1
        elif [ -n "${fable_pr_keys[$prnum]:-}" ]; then
            continue
        fi

        # 算 session/worktree（PR 走 issue_n 链；standalone fallback PR 编号自己）
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
            continue
        fi
        if ! reserve_slot "$issue_n"; then
            log "PR #$prnum: 已达并发上限 max=${MAX_CONCURRENT_WORKERS:-1}，排队等下一轮"
            continue
        fi

        # Dispatch 触发条件（跟 §1 issue 派工一致）：label=pending/agent（已过滤）+ 不忙。
        # **不**依赖 comment id 变化——label 翻 pending/agent 本身就是 user 明确意图
        # 信号（可能是新评论 + 重标、可能是没新评论纯重派工恢复死掉的 worker）。
        # dispatch 后 daemon 在 § Case A/B 翻 label 到 doing/agent，下轮 daemon 不会
        # 再 trigger 同 PR（label 不是 pending/agent 了），不会死循环。
        log "dispatch PR #$prnum comment (agent=${worker_agent:-default}, model=${model:-default})"
        # 透传最大的 ID 给 dispatch（仅用于 prompt 文件命名去重，不参与语义）
        kick_id=$(printf '%s\n%s\n%s\n' "$latest_conv" "$latest_inline" "$latest_review" | sort -rn | head -1)
        remember_worker_model "$issue_n" "$model"
        if DISPATCH_PENDING_AGENT_LABEL="$trigger_label" DISPATCH_WORKER_AGENT="$worker_agent" WORKER_MODEL="$model" \
            bash "$SCRIPT_DIR/dispatch-pr-comment.sh" "$prnum" "$branch" "$kick_id"; then
            tmp=$(mktemp)
            jq ".seen_comments[\"$prnum\"] = $latest_conv | .seen_review_comments[\"$prnum\"] = $latest_inline | .seen_reviews[\"$prnum\"] = $latest_review" \
                "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
        else
            log "PR #$prnum 派工失败（comment cursors 不更新，下轮重试）"
        fi
    done <<< "$pending_prs"
}

dispatch_pending_prs "$LABEL_PENDING_AGENT_FABLE" "$FABLE_MODEL" "$FABLE_WORKER_AGENT"
dispatch_pending_prs "$LABEL_PENDING_AGENT_DEFAULT" "" ""

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
                log "  auto-cleanup PR #$prnum done"

                # PR：merge 完，PR 这件事真结束 → Done
                run_gh "auto-cleanup label PR #$prnum → Done" \
                    gh_label_flip "$prnum" \
                    --add "$LABEL_DONE" \
                    --remove "$LABEL_PENDING_HUMAN" "$LABEL_PENDING_AGENT_DEFAULT" "$LABEL_PENDING_AGENT_FABLE" "$LABEL_AGENT_DOING" || true

                # Issue：看实际状态决定怎么标
                # - CLOSED（PR body 是 Closes #N，GitHub auto-close）→ 加 Done（与 PR 同闭环）
                # - OPEN（PR body 是 Refs #N，长期 tracker 模式）→ 翻 pending/human（等你 triage 是否真完结）
                issue_state=$(gh issue view "$issue_n" --repo "$REPO" --json state --jq .state 2>/dev/null || echo "OPEN")
                if [ "$issue_state" = "CLOSED" ]; then
                    run_gh "auto-cleanup label issue #$issue_n → Done" \
                        gh_label_flip "$issue_n" \
                        --add "$LABEL_DONE" \
                        --remove "$LABEL_PENDING_PR" "$LABEL_PENDING_HUMAN" "$LABEL_PENDING_AGENT_DEFAULT" "$LABEL_PENDING_AGENT_FABLE" "$LABEL_AGENT_DOING" || true
                    log "  PR #$prnum → Done；issue #$issue_n CLOSED (Closes #N) → Done"
                else
                    run_gh "auto-cleanup label issue #$issue_n → pending/human" \
                        gh_label_flip "$issue_n" \
                        --add "$LABEL_PENDING_HUMAN" \
                        --remove "$LABEL_PENDING_PR" "$LABEL_PENDING_AGENT_DEFAULT" "$LABEL_PENDING_AGENT_FABLE" "$LABEL_AGENT_DOING" || true
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
                log "  auto-cleanup closed issue #$issnum done"
            else
                log "  auto-cleanup closed issue #$issnum 失败（busy/dirty），下轮重试"
            fi
        done <<< "$recent_closed"
    fi
fi

log "===== poll done ====="
