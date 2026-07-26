#!/usr/bin/env bash
# Issue 新评论派工：复用已有 worker session 注入 prompt；session 没了就在 worktree 上重起。
#
# 触发场景：用户在 issue 上 comment 完后又打 pending/agent，希望 agent 看新 comment。
# 与 dispatch-pr-comment.sh 平行；区别是这里读 issue（设计阶段）而不是 PR（实现阶段）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# 派工前先把主 checkout 同步到 origin/<base>：模板 / 项目脚本防 stale（GigleTutor-Web#516）
sync_project_checkout

ISSUE="${1:?need issue number}"
LATEST_COMMENT_ID="${2:-0}"

WORKTREE="$(worktree_path "$ISSUE")"
TMUX_SESSION="$(tmux_session_name "$ISSUE")"
WORKER_SESSION="$(worker_session_name "$ISSUE")"
BRANCH="$(branch_name "$ISSUE")"
issue_title="$(github_issue_title "$ISSUE" || true)"

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
        -e "s|\${OUTPUT_LANGUAGE}|$OUTPUT_LANGUAGE|g" \
        -e "s|\${PR_CREATED_HOOK}|$PR_CREATED_HOOK|g" \
        -e "s|\${TMUX_SESSION}|$TMUX_SESSION|g" \
        -e "s|\${TASK_START_TS}|$(date '+%Y-%m-%d %H:%M:%S')|g" \
        -e "s|\${COMMENT_FOOTER}|$COMMENT_FOOTER|g" \
        -e "s|\${AGENT_TOKEN_USAGE_SCRIPT}|$AGENT_TOKEN_USAGE_SCRIPT|g" \
        "$TEMPLATE" > "$PROMPT_FILE"
else
    cat > "$PROMPT_FILE" <<EOF
Issue #$ISSUE 有新评论。读 \`gh issue view $ISSUE --repo $REPO --comments\` 看最新一段，按内容判断：
- 用户确认方案 → 进入开发阶段（实现 / 测试 / commit + push / 开 PR / Closes #$ISSUE）
- 用户要求改方案 → 修订设计、重发 issue comment、idle
- 不明确 → 反问 + idle
完成后翻 label（REST，绕 read:org）：
  gh api -X POST "repos/$REPO/issues/$ISSUE/labels" -f "labels[]=$LABEL_PENDING_HUMAN"
  gh api -X DELETE "repos/$REPO/issues/$ISSUE/labels/\$(printf '%s' "$LABEL_AGENT_DOING" | jq -sRr @uri)" || true
EOF
fi

flip_label() {
    run_gh "label 翻转 (issue #$ISSUE pending/agent → doing/agent)" \
        gh_label_flip "$ISSUE" \
        --add "$LABEL_AGENT_DOING" \
        --remove "$LABEL_PENDING_AGENT_DEFAULT" "$LABEL_PENDING_AGENT_FABLE" || true
}

# fable 标签作用于本次实际 worker 进程；已有 session 的 worker/model 不同就不能
# 直接注入，需进入 Case B 用同一 cwd resume/fresh，并由 Claude driver 带上新模型。
if session_alive "$TMUX_SESSION" && ! tmux_session_matches_worker "$TMUX_SESSION"; then
    log "issue #$ISSUE -> session worker/model 与请求不一致，重启切换为 $WORKER_AGENT/${WORKER_MODEL:-default}"
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
fi

# Case A: session 还活着 → 注入 prompt
if session_alive "$TMUX_SESSION"; then
    log "issue #$ISSUE -> 注入现有 session $TMUX_SESSION (agent=$WORKER_AGENT)"
    configure_tmux_session_display "$TMUX_SESSION" "$issue_title"
    if agent_inject_prompt "$TMUX_SESSION" "$PROMPT_FILE"; then
        flip_label
        exit 0
    fi
    log "issue #$ISSUE -> 注入失败，fallback 重起 session (agent=$WORKER_AGENT)"
    # 注入失败 = session 不响应/僵尸，要 kill 才能 new-session 同名（否则 duplicate name 报错）
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
fi

# Case B: worktree 还在，session 死了 → 重起 session（有历史就 resume）
if [ -d "$WORKTREE" ]; then
    tmux_env=()
    while IFS= read -r -d '' _tmux_e; do
        tmux_env+=("$_tmux_e")
    done < <(tmux_env_args)

    # B1: 先试 resume（如有历史）
    used_resume=0
    if agent_has_history "$WORKTREE"; then
        log "issue #$ISSUE -> 在 ${TMUX_SESSION} 里 resume agent=$WORKER_AGENT 之前的会话"
        CMD="$(agent_command_resume "$WORKTREE" "$WORKER_SESSION" "$PROMPT_FILE")"
        tmux new-session -d -s "$TMUX_SESSION" "${tmux_env[@]}" -c "$WORKTREE" "$CMD"
        used_resume=1
        # claude --continue 可能 resume 到异常 state（之前 worker 留下的 Rewind UI 等）
        # 然后立即异常退出 → tmux session 立即关。等 2s 看是否还在
        sleep 2
    fi

    # B2: 没历史 or resume 起来后立即死 → 降级 fresh new（claude -n）
    if ! session_alive "$TMUX_SESSION"; then
        if [ "$used_resume" = 1 ]; then
            log "issue #$ISSUE -> resume 启动后 2s 内 session 死了（可能 transcript state 异常），降级 fresh $WORKER_AGENT session（丢 conversation history、prompt 含 issue context 仍可工作）"
        else
            log "issue #$ISSUE -> 从 worktree 起全新 $WORKER_AGENT session ${TMUX_SESSION}（cwd 无历史）"
        fi
        CMD="$(agent_command_new "$WORKTREE" "$WORKER_SESSION" "$PROMPT_FILE")"
        tmux new-session -d -s "$TMUX_SESSION" "${tmux_env[@]}" -c "$WORKTREE" "$CMD"
    fi

    configure_tmux_session_display "$TMUX_SESSION" "$issue_title"
    start_session_logging "$TMUX_SESSION" 2>/dev/null || true
    flip_label
    exit 0
fi

# Case C: worktree 也没了 → 回到 dispatch-new-issue 走全新流程
log "issue #$ISSUE -> 无 worktree，fallback 走 dispatch-new-issue.sh"
exec bash "$SCRIPT_DIR/dispatch-new-issue.sh" "$ISSUE"
