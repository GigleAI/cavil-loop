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

# Branch 不符合约定时（如旧仓库里 feature/getuser-to-getsession 这种非数字命名）
# 无法 derive 出唯一 issue_n / 也无法另开 worktree（原 branch 通常已在别处被 checkout）。
# 优雅退场：翻 label 回 pending/human + 0 退出，让 daemon 把 state 推进、不再重试。
if [ -z "$ISSUE_N" ]; then
    log "PR #$PR: branch '$BRANCH' 不符合 BRANCH_PREFIX '$BRANCH_PREFIX'，daemon 无法自动派工"
    log "  → 翻 label 回 $LABEL_PENDING_HUMAN 防反复重试；手动处理或 rename 分支为 ${BRANCH_PREFIX}<N> 后再 label"
    run_gh "label 翻转 (PR #$PR 兜底 pending/agent → pending/human)" \
        gh pr edit "$PR" --repo "$REPO" \
        --add-label "$LABEL_PENDING_HUMAN" \
        --remove-label "$LABEL_PENDING_AGENT" || true
    exit 0
fi

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
        -e "s|\${LABEL_AGENT_DOING}|$LABEL_AGENT_DOING|g" \
        -e "s|\${LABEL_PENDING_PR}|$LABEL_PENDING_PR|g" \
        -e "s|\${OUTPUT_LANGUAGE}|$OUTPUT_LANGUAGE|g" \
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
    # daemon dispatch 翻到 agent/doing；worker 完工时它自己翻成 pending/human
    run_gh "label 翻转 (PR #$PR pending/agent → agent/doing)" \
        gh pr edit "$PR" --repo "$REPO" \
        --add-label "$LABEL_AGENT_DOING" \
        --remove-label "$LABEL_PENDING_AGENT" || true
}

# Case A: 现有 worker session
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "PR #$PR -> 注入 $TMUX_SESSION"
    start_session_logging "$TMUX_SESSION"
    inject_to_session "$TMUX_SESSION"
    flip_label
    exit 0
fi

# Case B: worktree 还在，session 没了 → 重起（有历史就 resume）
if [ -d "$WORKTREE" ]; then
    CLAUDE_INVOKE="$(claude_invoke "$WORKTREE" "$CLAUDE_SESSION")"
    if has_claude_session "$WORKTREE"; then
        log "PR #$PR -> 在 $TMUX_SESSION 里 claude --continue 之前的会话"
    else
        log "PR #$PR -> 从 worktree 起全新 claude session $TMUX_SESSION（cwd 无历史）"
    fi
    mapfile -d '' -t tmux_env < <(tmux_env_args)
    tmux new-session -d -s "$TMUX_SESSION" "${tmux_env[@]}" -c "$WORKTREE" \
        "$CLAUDE_INVOKE \"\$(cat $PROMPT_FILE)\""
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

CLAUDE_INVOKE="$(claude_invoke "$WORKTREE" "$CLAUDE_SESSION")"
if has_claude_session "$WORKTREE"; then
    log "PR #$PR -> 重建 worktree，但 ~/.claude 里还有该 cwd 的历史，claude --continue"
fi
mapfile -d '' -t tmux_env < <(tmux_env_args)
tmux new-session -d -s "$TMUX_SESSION" "${tmux_env[@]}" -c "$WORKTREE" \
    "$CLAUDE_INVOKE \"\$(cat $PROMPT_FILE)\""
start_session_logging "$TMUX_SESSION"

flip_label
log "dispatch-pr-comment done: PR #$PR fresh worktree + session"
