#!/usr/bin/env bash
# 主轮询：systemd user timer / cron 定时调起。one-shot 风格。
# 行为：
#   1. 看 GitHub 上有没有 label=pending/agent 的 issue → 派工
#   2. 看 label=pending/agent 的 PR → 检查新 comment ID → 派工
#   3. 派工时立刻把 label 翻回 pending/human，防止 daemon 自己 re-dispatch
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

STATE_FILE="$STATE_DIR/state.json"
LOCK_FILE="$STATE_DIR/poll.lock"

[ -f "$STATE_FILE" ] || echo '{"seen_comments":{},"seen_issue_comments":{},"seen_review_comments":{},"seen_reviews":{}}' > "$STATE_FILE"
# 老 state.json 缺新字段时补上（无破坏迁移；缺字段初始化为 {}）
for field in seen_issue_comments seen_review_comments seen_reviews; do
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

# 计活的 worker：用 GitHub 上 doing/agent label 作真值（label 由 daemon dispatch 时贴、
# worker 完工时翻 pending/human；期间在 label 上就算 active）。busy 时把具体 issue/PR
# 编号也带在 log 里，方便看 max=1 撑住的是谁。
active_list=$(list_active_workers)
active_workers=$(printf '%s' "$active_list" | grep -c . || true)
if [ "$active_workers" -gt 0 ]; then
    active_summary=$(printf '%s' "$active_list" | paste -sd ',' - | sed 's/,/, /g')
    log "active workers (busy): $active_workers (max=${MAX_CONCURRENT_WORKERS}) — $active_summary"
else
    log "active workers (busy): 0 (max=${MAX_CONCURRENT_WORKERS})"
fi

# ── 1. 新 issue 派工 ──
new_issues=$(gh issue list --repo "$REPO" --state open --label "$LABEL_PENDING_AGENT" \
    --json number,title --jq '.[] | "\(.number)\t\(.title)"' 2>/dev/null || true)

if [ -n "$new_issues" ]; then
    while IFS=$'\t' read -r num title; do
        sess="$(tmux_session_name "$num")"
        wt="$(worktree_path "$num")"

        # 已有 session → 用户确认方案后标 pending/agent，走 issue-comment 派工。
        # pending/agent 是用户明确意图信号（包括勾选 checkbox、编辑 comment 等不产生新 comment ID 的操作），
        # 所以不依赖 comment ID 变化，只要 agent 不在忙就派工。
        if tmux has-session -t "$sess" 2>/dev/null || [ -d "$wt" ]; then
            latest_id=$(gh api --paginate "repos/$REPO/issues/$num/comments" --jq '.[-1].id // 0' 2>/dev/null || echo 0)
            log "issue #$num 已有 worktree/session (latest_id=$latest_id)"
            # agent 在忙就不打断（除非 pending/agent 是用户手动翻回来的）
            if tmux has-session -t "$sess" 2>/dev/null && agent_is_busy "$sess"; then
                log "issue #$num: agent 正在忙，跳过本轮"
                continue
            fi
            log "dispatch issue-comment for #$num"
            if bash "$SCRIPT_DIR/dispatch-issue-comment.sh" "$num" "$latest_id"; then
                tmp=$(mktemp)
                jq ".seen_issue_comments[\"$num\"] = $latest_id" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
            else
                log "issue-comment 派工 #$num 失败（state 不更新，下轮重试）"
            fi
            continue
        fi

        # 没 worktree / session → 全新 issue 第一次派工（走设计分析阶段）
        if [ "$active_workers" -ge "${MAX_CONCURRENT_WORKERS:-1}" ]; then
            log "已达并发上限，issue #$num 排队等下一轮"
            break
        fi
        log "dispatch new issue #$num: $title"
        if bash "$SCRIPT_DIR/dispatch-new-issue.sh" "$num"; then
            active_workers=$((active_workers + 1))
        else
            log "派工 issue #$num 失败"
        fi
    done <<< "$new_issues"
fi

# ── 2. PR 评论派工 ──
# PR 上的「评论」其实有三种，存三个不同 endpoint，ID 序列也是独立的：
#   - /issues/N/comments  ← Conversation tab 的对话评论
#   - /pulls/N/comments   ← Files Changed 上 inline 的 review comments
#   - /pulls/N/reviews    ← 整次 review 提交（Approve/Request changes/Comment 的整体 body）
# 任意一个有新增就派工；state.json 里分三个字段各存最新 ID。
pending_prs=$(gh pr list --repo "$REPO" --label "$LABEL_PENDING_AGENT" \
    --json number,headRefName --jq '.[] | "\(.number)\t\(.headRefName)"' 2>/dev/null || true)

if [ -n "$pending_prs" ]; then
    while IFS=$'\t' read -r prnum branch; do
        # --paginate：gh api 默认只返第一页（per_page=30）。PR 评论 / inline review
        # 多到 30+ 时 .[-1] 就拿不到真正最新的，daemon 误判 "无新评论" 永远不 dispatch。
        # 实测 PR #105 撞过：37 条评论，第 31-37 漏掉 → seen 永远 == 老 latest。
        latest_conv=$(gh api --paginate "repos/$REPO/issues/$prnum/comments" --jq '.[-1].id // 0' 2>/dev/null || echo 0)
        latest_inline=$(gh api --paginate "repos/$REPO/pulls/$prnum/comments" --jq '.[-1].id // 0' 2>/dev/null || echo 0)
        latest_review=$(gh api --paginate "repos/$REPO/pulls/$prnum/reviews" --jq '.[-1].id // 0' 2>/dev/null || echo 0)
        seen_conv=$(jq -r ".seen_comments[\"$prnum\"] // 0" "$STATE_FILE")
        seen_inline=$(jq -r ".seen_review_comments[\"$prnum\"] // 0" "$STATE_FILE")
        seen_review=$(jq -r ".seen_reviews[\"$prnum\"] // 0" "$STATE_FILE")
        log "PR #$prnum: conv=$latest_conv/$seen_conv inline=$latest_inline/$seen_inline review=$latest_review/$seen_review"
        if [ "$latest_conv" -gt "$seen_conv" ] || \
           [ "$latest_inline" -gt "$seen_inline" ] || \
           [ "$latest_review" -gt "$seen_review" ]; then
            log "dispatch PR #$prnum comment"
            # 透传最大的 ID 给 dispatch（仅用于 prompt 文件命名去重，不参与语义）
            kick_id=$(printf '%s\n%s\n%s\n' "$latest_conv" "$latest_inline" "$latest_review" | sort -rn | head -1)
            if bash "$SCRIPT_DIR/dispatch-pr-comment.sh" "$prnum" "$branch" "$kick_id"; then
                tmp=$(mktemp)
                jq ".seen_comments[\"$prnum\"] = $latest_conv | .seen_review_comments[\"$prnum\"] = $latest_inline | .seen_reviews[\"$prnum\"] = $latest_review" \
                    "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
            else
                log "PR #$prnum 派工失败（state 不更新，下轮重试）"
            fi
        fi
    done <<< "$pending_prs"
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
            issue_n=$(pr_to_issue_num "$prnum" "$branch")
            # pr_to_issue_num fallback 链兜底到 PR 编号本身，理论上永不空
            if [ -z "$issue_n" ]; then
                log "auto-cleanup: PR #$prnum 无法 derive 工作编号（异常），标记为已清不再扫"
                tmp=$(mktemp)
                jq ".cleaned_prs += [$prnum]" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
                continue
            fi
            log "auto-cleanup PR #$prnum (issue #$issue_n) → cleanup-issue.sh"
            # 默认不删本地分支（保留 commit 历史可 checkout / git log）；
            # 远端分支 daemon 从来不动（GitHub auto-delete-branch-on-merge 由仓库设置控制）。
            # 想顺手删本地，用户手动 `cleanup-issue.sh <N> --delete-branch`。
            if bash "$SCRIPT_DIR/cleanup-issue.sh" "$issue_n" 2>&1; then
                tmp=$(mktemp)
                jq ".cleaned_prs += [$prnum]" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
                log "  auto-cleanup PR #$prnum done"

                # PR：merge 完，PR 这件事真结束 → Done
                run_gh "auto-cleanup label PR #$prnum → Done" \
                    gh_label_flip "$prnum" \
                    --add "$LABEL_DONE" \
                    --remove "$LABEL_PENDING_HUMAN" "$LABEL_PENDING_AGENT" "$LABEL_AGENT_DOING" || true

                # Issue：看实际状态决定怎么标
                # - CLOSED（PR body 是 Closes #N，GitHub auto-close）→ 加 Done（与 PR 同闭环）
                # - OPEN（PR body 是 Refs #N，长期 tracker 模式）→ 翻 pending/human（等你 triage 是否真完结）
                issue_state=$(gh issue view "$issue_n" --repo "$REPO" --json state --jq .state 2>/dev/null || echo "OPEN")
                if [ "$issue_state" = "CLOSED" ]; then
                    run_gh "auto-cleanup label issue #$issue_n → Done" \
                        gh_label_flip "$issue_n" \
                        --add "$LABEL_DONE" \
                        --remove "$LABEL_PENDING_PR" "$LABEL_PENDING_HUMAN" "$LABEL_PENDING_AGENT" "$LABEL_AGENT_DOING" || true
                    log "  PR #$prnum → Done；issue #$issue_n CLOSED (Closes #N) → Done"
                else
                    run_gh "auto-cleanup label issue #$issue_n → pending/human" \
                        gh_label_flip "$issue_n" \
                        --add "$LABEL_PENDING_HUMAN" \
                        --remove "$LABEL_PENDING_PR" "$LABEL_PENDING_AGENT" "$LABEL_AGENT_DOING" || true
                    log "  PR #$prnum → Done；issue #$issue_n OPEN (Refs #N) → pending/human"
                fi
            else
                log "  auto-cleanup PR #$prnum 失败（busy/dirty/hook 报错），下轮重试"
            fi
        done <<< "$recent_merged"
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
            log "auto-cleanup closed issue #$issnum → cleanup-issue.sh"
            if bash "$SCRIPT_DIR/cleanup-issue.sh" "$issnum" 2>&1; then
                tmp=$(mktemp)
                jq ".cleaned_issues += [$issnum]" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
                log "  auto-cleanup closed issue #$issnum done"
            else
                log "  auto-cleanup closed issue #$issnum 失败（busy/dirty），下轮重试"
            fi
        done <<< "$recent_closed"
    fi
fi

log "===== poll done ====="
