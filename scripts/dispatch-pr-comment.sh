#!/usr/bin/env bash
# PR 评论派工：找到对应 worker session 注入 prompt；session 没了就重建。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

PR="${1:?need PR number}"
BRANCH="${2:?need branch}"
LATEST_COMMENT_ID="${3:-0}"

ISSUE_N="$(pr_to_issue_num "$PR" "$BRANCH")"

# 防御性兜底：pr_to_issue_num 的第 3 层 fallback 是 PR 编号本身，理论上永远非空。
# 走到这条说明 gh API 完全挂了（连 PR 编号都拿不回来）—— 那时整个 daemon 都没法工作，
# 留 log 提示但仍软退场，避免 state 永远不推进卡死整个 loop。
if [ -z "$ISSUE_N" ]; then
    log "PR #$PR: pr_to_issue_num 返回空（异常状态——预期 fallback 到 PR 编号永远非空，可能 gh API 故障）"
    log "  → 翻 label 回 $LABEL_PENDING_HUMAN 防反复重试，手动检查后再 label"
    run_gh "label 翻转 (PR #$PR 兜底 pending/agent → pending/human)" \
        gh_label_flip "$PR" \
        --add "$LABEL_PENDING_HUMAN" \
        --remove "$LABEL_PENDING_AGENT" || true
    exit 0
fi

WORKTREE="$(worktree_path "$ISSUE_N")"
TMUX_SESSION="$(tmux_session_name "$ISSUE_N")"
WORKER_SESSION="$(worker_session_name "$ISSUE_N")"

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
完成后翻 label（REST，绕 read:org）：
  gh api -X POST "repos/$REPO/issues/$PR/labels" -f "labels[]=$LABEL_PENDING_HUMAN"
  gh api -X DELETE "repos/$REPO/issues/$PR/labels/\$(printf '%s' "$LABEL_PENDING_AGENT" | jq -sRr @uri)" || true
EOF
fi

flip_label() {
    # daemon dispatch 翻到 doing/agent；worker 完工时它自己翻成 pending/human
    run_gh "label 翻转 (PR #$PR pending/agent → $LABEL_AGENT_DOING)" \
        gh_label_flip "$PR" \
        --add "$LABEL_AGENT_DOING" \
        --remove "$LABEL_PENDING_AGENT" || true
}

# Case A: 现有 worker session
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "PR #$PR -> 注入 $TMUX_SESSION (agent=$WORKER_AGENT)"
    start_session_logging "$TMUX_SESSION"
    agent_inject_prompt "$TMUX_SESSION" "$PROMPT_FILE"
    flip_label
    exit 0
fi

# Case B: worktree 还在，session 没了 → 重起（有历史就 resume）
if [ -d "$WORKTREE" ]; then
    if agent_has_history "$WORKTREE"; then
        log "PR #$PR -> 在 $TMUX_SESSION 里 resume agent=$WORKER_AGENT 之前的会话"
        CMD="$(agent_command_resume "$WORKTREE" "$WORKER_SESSION" "$PROMPT_FILE")"
    else
        log "PR #$PR -> 从 worktree 起全新 $WORKER_AGENT session $TMUX_SESSION（cwd 无历史）"
        CMD="$(agent_command_new "$WORKTREE" "$WORKER_SESSION" "$PROMPT_FILE")"
    fi
    mapfile -d '' -t tmux_env < <(tmux_env_args)
    tmux new-session -d -s "$TMUX_SESSION" "${tmux_env[@]}" -c "$WORKTREE" "$CMD"
    start_session_logging "$TMUX_SESSION"
    flip_label
    exit 0
fi

# Case C: 全新重建 worktree（基于 PR head branch，不是 main）
#
# 用 `refs/pull/$PR/head` 拉 PR head——GitHub 把所有 PR（含来自 fork 的 external PR）的 head
# commit 都暴露在这个 ref 下。这条对 fork 透明，不需要额外 remote。
# 拉下来后存到本地命名分支 $BRANCH（跟 daemon-spawned PR 一致），worktree 基于它建。
log "PR #$PR -> 全新重建 worktree on $BRANCH (via refs/pull/$PR/head)"
cd "$PROJECT_ROOT"
git fetch origin "+refs/pull/$PR/head:refs/heads/$BRANCH" 2>&1 | tail -2
mkdir -p "$WORKTREE_BASE"
# 用本地刚拉好的分支建 worktree；如果分支已存在（再 dispatch），fetch 已经 force-update 到 PR head
git worktree add --force "$WORKTREE" "$BRANCH"

for rel in ${COPY_TO_WORKTREE:-}; do
    src="$PROJECT_ROOT/$rel"
    if [ -f "$src" ]; then
        mkdir -p "$WORKTREE/$(dirname "$rel")"
        cp "$src" "$WORKTREE/$rel"
    fi
done

[ -n "${WORKTREE_SETUP_CMD:-}" ] && [ "${WORKTREE_SETUP_CMD}" != ":" ] && \
    (cd "$WORKTREE" && eval "$WORKTREE_SETUP_CMD") || true

if agent_has_history "$WORKTREE"; then
    log "PR #$PR -> 重建 worktree，但本机仍有该 cwd 的 $WORKER_AGENT 历史 → resume"
    CMD="$(agent_command_resume "$WORKTREE" "$WORKER_SESSION" "$PROMPT_FILE")"
else
    CMD="$(agent_command_new "$WORKTREE" "$WORKER_SESSION" "$PROMPT_FILE")"
fi
mapfile -d '' -t tmux_env < <(tmux_env_args)
tmux new-session -d -s "$TMUX_SESSION" "${tmux_env[@]}" -c "$WORKTREE" "$CMD"
start_session_logging "$TMUX_SESSION"

flip_label
log "dispatch-pr-comment done: PR #$PR fresh worktree + session (agent=$WORKER_AGENT)"
