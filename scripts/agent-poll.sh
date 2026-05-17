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

[ -f "$STATE_FILE" ] || echo '{"seen_comments":{}}' > "$STATE_FILE"

# flock 防多个 tick 撞车（万一某次跑慢了 > POLL_INTERVAL_SECS）
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "上一轮还没跑完，跳过"
    exit 0
fi

log "===== poll start ====="

# 计活的 worker：只算 Claude 真正在 processing 的 session
# （tmux footer 含 "esc to interrupt" = busy；idle/已完成/dead = 不算）
active_workers=$(count_active_workers)
log "active workers (busy): $active_workers (max=${MAX_CONCURRENT_WORKERS})"

# ── 1. 新 issue 派工 ──
new_issues=$(gh issue list --repo "$REPO" --state open --label "$LABEL_PENDING_AGENT" \
    --json number,title --jq '.[] | "\(.number)\t\(.title)"' 2>/dev/null || true)

if [ -n "$new_issues" ]; then
    while IFS=$'\t' read -r num title; do
        # 已存在 worktree / session → 已派过，跳过
        if [ -d "$(worktree_path "$num")" ] || tmux has-session -t "$(tmux_session_name "$num")" 2>/dev/null; then
            log "issue #$num 已有 worktree/session，跳过派工"
            continue
        fi
        # 并发守卫
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
pending_prs=$(gh pr list --repo "$REPO" --label "$LABEL_PENDING_AGENT" \
    --json number,headRefName --jq '.[] | "\(.number)\t\(.headRefName)"' 2>/dev/null || true)

if [ -n "$pending_prs" ]; then
    while IFS=$'\t' read -r prnum branch; do
        latest_id=$(gh api "repos/$REPO/issues/$prnum/comments" --jq '.[-1].id // 0' 2>/dev/null || echo 0)
        last_seen=$(jq -r ".seen_comments[\"$prnum\"] // 0" "$STATE_FILE")
        log "PR #$prnum: latest=$latest_id last_seen=$last_seen"
        if [ "$latest_id" -gt "$last_seen" ]; then
            log "dispatch PR #$prnum comment"
            if bash "$SCRIPT_DIR/dispatch-pr-comment.sh" "$prnum" "$branch" "$latest_id"; then
                tmp=$(mktemp)
                jq ".seen_comments[\"$prnum\"] = $latest_id" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
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
            issue_n=$(branch_to_issue_num "$branch")
            if [ -z "$issue_n" ]; then
                log "auto-cleanup: PR #$prnum branch '$branch' 不符合 BRANCH_PREFIX，标记为已清不再扫"
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
            else
                log "  auto-cleanup PR #$prnum 失败（busy/dirty/hook 报错），下轮重试"
            fi
        done <<< "$recent_merged"
    fi
fi

log "===== poll done ====="
