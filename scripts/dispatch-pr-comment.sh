#!/usr/bin/env bash
# PR 评论派工：找到对应 worker session 注入 prompt；session 没了就重建。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

PR="${1:?need PR number}"
BRANCH="${2:?need branch}"
LATEST_COMMENT_ID="${3:-0}"

ISSUE_N="$(branch_to_issue_num "$BRANCH")"
[ -z "$ISSUE_N" ] && ISSUE_N="pr$PR"

WORKTREE="$(worktree_path "$ISSUE_N")"
TMUX_SESSION="$(tmux_session_name "$ISSUE_N")"
CLAUDE_SESSION="$(claude_session_name "$ISSUE_N")"

# Prompt 模板
TEMPLATE="$(find_prompt_template "pr-comment")"
PROMPT_FILE="/tmp/coding-agent-pr-$PR-prompt.md"
if [ -n "$TEMPLATE" ]; then
    sed \
        -e "s|\${PR}|$PR|g" \
        -e "s|\${REPO}|$REPO|g" \
        -e "s|\${BRANCH}|$BRANCH|g" \
        -e "s|\${ISSUE_N}|$ISSUE_N|g" \
        -e "s|\${LABEL_PENDING_AGENT}|$LABEL_PENDING_AGENT|g" \
        -e "s|\${LABEL_PENDING_HUMAN}|$LABEL_PENDING_HUMAN|g" \
        "$TEMPLATE" > "$PROMPT_FILE"
else
    cat > "$PROMPT_FILE" <<EOF
PR #$PR 有新评论。读 \`gh pr view $PR --repo $REPO --comments\`，按内容处理：
- 讨论 → gh pr comment 回答
- 改代码 → 改 + 测试 + commit + push + 评论
- 不明 → 反问
完成后 gh pr edit $PR --add-label $LABEL_PENDING_HUMAN --remove-label $LABEL_PENDING_AGENT
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
    gh pr edit "$PR" --repo "$REPO" \
        --add-label "$LABEL_PENDING_HUMAN" \
        --remove-label "$LABEL_PENDING_AGENT" 2>/dev/null || true
}

# Case A: 现有 worker session
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "PR #$PR -> 注入 $TMUX_SESSION"
    start_session_logging "$TMUX_SESSION"
    inject_to_session "$TMUX_SESSION"
    flip_label
    exit 0
fi

# Case B: worktree 还在，session 没了
if [ -d "$WORKTREE" ]; then
    log "PR #$PR -> 从 worktree 重起 session $TMUX_SESSION"
    mapfile -d '' -t tmux_env < <(tmux_env_args)
    tmux new-session -d -s "$TMUX_SESSION" "${tmux_env[@]}" -c "$WORKTREE" \
        "claude -n $CLAUDE_SESSION ${CLAUDE_EXTRA_FLAGS:-} \"\$(cat $PROMPT_FILE)\""
    start_session_logging "$TMUX_SESSION"
    flip_label
    exit 0
fi

# Case C: 全新重建 worktree（基于 PR head branch，不是 main）
log "PR #$PR -> 全新重建 worktree on $BRANCH"
cd "$PROJECT_ROOT"
git fetch origin "$BRANCH"
mkdir -p "$WORKTREE_BASE"
git worktree add "$WORKTREE" "$BRANCH"

for rel in ${COPY_TO_WORKTREE:-}; do
    src="$PROJECT_ROOT/$rel"
    if [ -f "$src" ]; then
        mkdir -p "$WORKTREE/$(dirname "$rel")"
        cp "$src" "$WORKTREE/$rel"
    fi
done

[ -n "${WORKTREE_SETUP_CMD:-}" ] && [ "${WORKTREE_SETUP_CMD}" != ":" ] && \
    (cd "$WORKTREE" && eval "$WORKTREE_SETUP_CMD") || true

mapfile -d '' -t tmux_env < <(tmux_env_args)
tmux new-session -d -s "$TMUX_SESSION" "${tmux_env[@]}" -c "$WORKTREE" \
    "claude -n $CLAUDE_SESSION ${CLAUDE_EXTRA_FLAGS:-} \"\$(cat $PROMPT_FILE)\""
start_session_logging "$TMUX_SESSION"

flip_label
log "dispatch-pr-comment done: PR #$PR fresh worktree + session"
