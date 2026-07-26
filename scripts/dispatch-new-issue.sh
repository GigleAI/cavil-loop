#!/usr/bin/env bash
# 新 issue 派工：建 worktree、起 worker agent session、立刻把 label 翻回 agent/doing。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# 派工前先把主 checkout 同步到 origin/<base>：模板 / 项目脚本防 stale（GigleTutor-Web#516）
sync_project_checkout

ISSUE="${1:?need issue number}"

WORKTREE="$(worktree_path "$ISSUE")"
TMUX_SESSION="$(tmux_session_name "$ISSUE")"
WORKER_SESSION="$(worker_session_name "$ISSUE")"
BRANCH="$(branch_name "$ISSUE")"
PROMPT_FILE="/tmp/coding-agent-issue-$ISSUE-prompt.md"

# 1. 建 worktree
bash "$SCRIPT_DIR/create-worktree.sh" "$ISSUE" main

# 2. 拉 issue 信息
issue_title="$(github_issue_title "$ISSUE")"

# 3. 写 prompt（用模板 + 占位）
TEMPLATE="$(find_prompt_template "new-issue")"
if [ -n "$TEMPLATE" ]; then
    sed \
        -e "s|\${ISSUE}|$ISSUE|g" \
        -e "s|\${REPO}|$REPO|g" \
        -e "s|\${TITLE}|${issue_title//|/\\|}|g" \
        -e "s|\${WORKTREE}|$WORKTREE|g" \
        -e "s|\${BRANCH}|$BRANCH|g" \
        -e "s|\${LABEL_PENDING_AGENT}|$LABEL_PENDING_AGENT|g" \
        -e "s|\${LABEL_PENDING_HUMAN}|$LABEL_PENDING_HUMAN|g" \
        -e "s|\${LABEL_AGENT_DOING}|$LABEL_AGENT_DOING|g" \
        -e "s|\${LABEL_PENDING_PR}|$LABEL_PENDING_PR|g" \
        -e "s|\${OUTPUT_LANGUAGE}|$OUTPUT_LANGUAGE|g" \
        -e "s|\${TMUX_SESSION}|$TMUX_SESSION|g" \
        -e "s|\${TASK_START_TS}|$(date '+%Y-%m-%d %H:%M:%S')|g" \
        -e "s|\${COMMENT_FOOTER}|$COMMENT_FOOTER|g" \
        -e "s|\${AGENT_TOKEN_USAGE_SCRIPT}|$AGENT_TOKEN_USAGE_SCRIPT|g" \
        "$TEMPLATE" > "$PROMPT_FILE"
else
    # 兜底：内联 minimal prompt
    cat > "$PROMPT_FILE" <<EOF
你正在处理 GitHub issue #$ISSUE（仓库 $REPO，标题：${issue_title}）。
工作目录 $WORKTREE  分支 $BRANCH。
读 issue → 实现 → 测试通过 → commit + push → gh pr create --base main (body 含 "Closes #$ISSUE")
拿到 PR 编号 <P> 后翻 label（走 REST 避免 bot PAT 缺 read:org 的 GraphQL 调用挂）：
  gh api -X POST "repos/$REPO/issues/<P>/labels" -f "labels[]=$LABEL_PENDING_HUMAN"
  gh api -X POST "repos/$REPO/issues/$ISSUE/labels" -f "labels[]=$LABEL_PENDING_HUMAN"
  gh api -X DELETE "repos/$REPO/issues/$ISSUE/labels/\$(printf '%s' "$LABEL_PENDING_AGENT" | jq -sRr @uri)" || true
最后回一句 "PR #<P> 已开" 停 idle。
EOF
fi

# 4. 起 tmux + worker agent（用 -e 显式传 GH_TOKEN 等 env，因为 tmux 默认不继承）
#    新 issue 一律走 agent_command_new（worktree 刚建，无历史）。
log "spawn $TMUX_SESSION in $WORKTREE (agent=$WORKER_AGENT)"
CMD="$(agent_command_new "$WORKTREE" "$WORKER_SESSION" "$PROMPT_FILE")"
tmux_env=()
while IFS= read -r -d '' _tmux_e; do
    tmux_env+=("$_tmux_e")
done < <(tmux_env_args)
# remain-on-exit 用 `\;` 链在同一次 tmux 调用里设上：worker 秒退时 pane 留尸，
# verify_fresh_session 才 capture 得到死因。隔语句再设会被亚毫秒级秒退抢跑（race）。
tmux new-session -d -s "$TMUX_SESSION" "${tmux_env[@]}" -c "$WORKTREE" "$CMD" \
    \; set-option -w -t "$TMUX_SESSION" remain-on-exit on

# 4.4 给 tmux session 写入 GitHub issue 标题，并让 prefix+s 列表显示它
configure_tmux_session_display "$TMUX_SESSION" "$issue_title"

# 4.5 pane 输出旁路到日志文件，session 退出后仍可回看
start_session_logging "$TMUX_SESSION"

# 4.6 探活：fresh 路径没有 has-session-based fallback，worker 偶发秒退时
#     必须就地 capture 死因（否则 pipe-pane 一挂日志全空），并保持 label 干净
#     —— 没活起来就不翻 doing/agent，留在 pending/agent 等下轮重试，避免假"进行中"。
if ! verify_fresh_session "$TMUX_SESSION"; then
    log "dispatch-new-issue: #$ISSUE worker 秒退 → 翻 $LABEL_PENDING_AGENT 回 $LABEL_PENDING_HUMAN（死因见上方 capture，偶发的话重标 pending/agent 即可重试）"
    run_gh "label 翻转 (issue #$ISSUE 秒退 pending/agent → pending/human)" \
        gh_label_flip "$ISSUE" \
        --add "$LABEL_PENDING_HUMAN" \
        --remove "$LABEL_PENDING_AGENT_DEFAULT" "$LABEL_PENDING_AGENT_FABLE5" "$LABEL_AGENT_DOING" || true
    exit 1
fi

# 5. 立即翻 label 到 doing/agent（worker 完工时它会自己翻成 pending/human）
run_gh "label 翻转 (issue #$ISSUE pending/agent → doing/agent)" \
    gh_label_flip "$ISSUE" \
    --add "$LABEL_AGENT_DOING" \
    --remove "$LABEL_PENDING_AGENT_DEFAULT" "$LABEL_PENDING_AGENT_FABLE5" || true

log "dispatch-new-issue done: #$ISSUE -> $TMUX_SESSION"
