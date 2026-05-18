#!/usr/bin/env bash
# Issue 新评论派工：复用已有 worker session 注入 prompt；session 没了就在 worktree 上重起。
#
# 触发场景：用户在 issue 上 comment 完后又打 pending/agent，希望 agent 看新 comment。
# 与 dispatch-pr-comment.sh 平行；区别是这里读 issue（设计阶段）而不是 PR（实现阶段）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

ISSUE="${1:?need issue number}"
LATEST_COMMENT_ID="${2:-0}"

WORKTREE="$(worktree_path "$ISSUE")"
TMUX_SESSION="$(tmux_session_name "$ISSUE")"
CLAUDE_SESSION="$(claude_session_name "$ISSUE")"
BRANCH="$(branch_name "$ISSUE")"

# 渲染 issue-comment prompt
TEMPLATE="$(find_prompt_template "issue-comment")"
PROMPT_FILE="/tmp/coding-agent-issue-$ISSUE-cmt-$LATEST_COMMENT_ID.md"
if [ -n "$TEMPLATE" ]; then
    sed \
        -e "s|\${ISSUE}|$ISSUE|g" \
        -e "s|\${REPO}|$REPO|g" \
        -e "s|\${WORKTREE}|$WORKTREE|g" \
        -e "s|\${BRANCH}|$BRANCH|g" \
        -e "s|\${LABEL_PENDING_AGENT}|$LABEL_PENDING_AGENT|g" \
        -e "s|\${LABEL_PENDING_HUMAN}|$LABEL_PENDING_HUMAN|g" \
        -e "s|\${LABEL_AGENT_DOING}|$LABEL_AGENT_DOING|g" \
        -e "s|\${LABEL_PENDING_PR}|$LABEL_PENDING_PR|g" \
        "$TEMPLATE" > "$PROMPT_FILE"
else
    cat > "$PROMPT_FILE" <<EOF
Issue #$ISSUE 有新评论。读 \`gh issue view $ISSUE --repo $REPO --comments\` 看最新一段，按内容判断：
- 用户确认方案 → 进入开发阶段（实现 / 测试 / commit + push / 开 PR / Closes #$ISSUE）
- 用户要求改方案 → 修订设计、重发 issue comment、idle
- 不明确 → 反问 + idle
完成后翻 label：gh issue edit $ISSUE --add-label $LABEL_PENDING_HUMAN --remove-label $LABEL_AGENT_DOING
EOF
fi

inject_to_session() {
    local sess="$1"
    local buf
    buf=$(mktemp)
    cat "$PROMPT_FILE" > "$buf"
    tmux load-buffer -t "$sess" "$buf"
    rm "$buf"
    tmux paste-buffer -t "$sess" -p
    tmux send-keys -t "$sess" Enter
}

flip_label() {
    gh issue edit "$ISSUE" --repo "$REPO" \
        --add-label "$LABEL_AGENT_DOING" \
        --remove-label "$LABEL_PENDING_AGENT" 2>/dev/null || true
}

# Case A: session 还活着 → 注入 prompt
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "issue #$ISSUE -> 注入现有 session $TMUX_SESSION"
    inject_to_session "$TMUX_SESSION"
    flip_label
    exit 0
fi

# Case B: worktree 还在，session 死了 → 重起 session
if [ -d "$WORKTREE" ]; then
    log "issue #$ISSUE -> 从 worktree 重起 session $TMUX_SESSION"
    mapfile -d '' -t tmux_env < <(tmux_env_args)
    tmux new-session -d -s "$TMUX_SESSION" "${tmux_env[@]}" -c "$WORKTREE" \
        "claude -n $CLAUDE_SESSION ${CLAUDE_EXTRA_FLAGS:-} \"\$(cat $PROMPT_FILE)\""
    start_session_logging "$TMUX_SESSION" 2>/dev/null || true
    flip_label
    exit 0
fi

# Case C: worktree 也没了 → 回到 dispatch-new-issue 走全新流程
log "issue #$ISSUE -> 无 worktree，fallback 走 dispatch-new-issue.sh"
exec bash "$SCRIPT_DIR/dispatch-new-issue.sh" "$ISSUE"
