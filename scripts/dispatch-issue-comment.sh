#!/usr/bin/env bash
# Issue 新评论派工：复用已有 worker session 注入 prompt；session 没了就在 worktree 上重起。
#
# 触发场景：用户在 issue 上 comment 完后又打 pending/agent，希望 agent 看新 comment。
# 与 dispatch-pr-comment.sh 平行；区别是这里读 issue（设计阶段）而不是 PR（实现阶段）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# 派工时要一并摘掉的全部触发 label（含 LABEL_PENDING_AGENT_EXTRA 里的多机标签）。
# 装配一次，下面五处 --remove 共用；漏掉任何一个都会让同一条活被反复重开。
trigger_labels_array

# 敏感 env（GH_TOKEN 等）不走 `-e VAR=值`——那会把值写进 tmux 的 argv，而
# /proc/<pid>/cmdline 全局可读。改成 0600 文件 + worker shell 内 $(cat) 读回。
# 校验放在**脚本顶部**而不是某条派工分支里：这个脚本有多条 spawn 路径
# （resume / fresh / 各种 worktree 状态），放分支里必然漏掉一条。
# 缺了就当场拒绝派工，而不是让 worker 起来之后撞 403 被 self-heal 反复重派。
require_secret_env || exit 1


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
# DISPATCH_PROMPT_KIND 由 agent-poll 按触发 label 指定（如 review 关卡用 "review"）；
# 不设就是本路径的默认模板。
TEMPLATE="$(compose_prompt_template "${DISPATCH_PROMPT_KIND:-issue-comment}")"
PROMPT_FILE="/tmp/cavil-loop-issue-$ISSUE-cmt-$LATEST_COMMENT_ID.md"
if [ -n "$TEMPLATE" ]; then
    sed \
        -e "s|\${ISSUE}|$ISSUE|g" \
        -e "s|\${REPO}|$REPO|g" \
        -e "s|\${WORKTREE}|$WORKTREE|g" \
        -e "s|\${BRANCH}|$BRANCH|g" \
        -e "s|\${LABEL_PENDING_AGENT}|$LABEL_PENDING_AGENT|g" \
        -e "s|\${LABEL_PENDING_HUMAN}|$LABEL_PENDING_HUMAN|g" \
        -e "s|\${LABEL_PENDING_AGENT_DEFAULT}|$LABEL_PENDING_AGENT_DEFAULT|g" \
        -e "s|\${LABEL_PENDING_REVIEW}|$LABEL_PENDING_REVIEW|g" \
        -e "s|\${LABEL_REVIEW_OR_HUMAN}|$LABEL_REVIEW_OR_HUMAN|g" \
        -e "s|\${LABEL_DESIGN_REVIEW_OR_HUMAN}|$LABEL_DESIGN_REVIEW_OR_HUMAN|g" \
        -e "s|\${DESIGN_REVIEW_NOTE}|$DESIGN_REVIEW_NOTE|g" \
        -e "s|\${REVIEW_MAX_ROUNDS}|$REVIEW_MAX_ROUNDS|g" \
        -e "s|\${LABEL_AGENT_DOING}|$LABEL_AGENT_DOING|g" \
        -e "s|\${LABEL_PENDING_PR}|$LABEL_PENDING_PR|g" \
        -e "s|\${OUTPUT_LANGUAGE}|$OUTPUT_LANGUAGE|g" \
        -e "s|\${PR_CREATED_HOOK}|$PR_CREATED_HOOK|g" \
        -e "s|\${TMUX_SESSION}|$TMUX_SESSION|g" \
        -e "s|\${PREVIEW_URL_HOST}|${PREVIEW_URL_HOST:-}|g" \
        -e "s|\${REVIEW_ASSET_BASE_URL}|${WEEKLY_REPORT_ASSET_ROOT_URL:-}|g" \
        -e "s|\${TASK_START_TS}|$(date '+%Y-%m-%d %H:%M:%S')|g" \
        -e "s|\${COMMENT_FOOTER}|$COMMENT_FOOTER|g" \
        -e "s|\${AGENT_TOKEN_USAGE_SCRIPT}|$AGENT_TOKEN_USAGE_SCRIPT|g" \
        -e "s|\${COMMENT_FOOTER_CMD}|$COMMENT_FOOTER_CMD|g" \
        -e "s|\${WORKER_AGENT}|$WORKER_AGENT|g" \
        -e "s|\${WORK_NUM}|$ISSUE|g" \
        "$TEMPLATE" > "$PROMPT_FILE"
    # 同时在进行的其他工作（GitHub#340）：清单是多行的、含别人写的标题，放在 sed 之后单独填
    concurrent_work_fill "$PROMPT_FILE" "$BRANCH" "$ISSUE" || true
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
    flip_to_doing "$ISSUE" "issue #$ISSUE pending/agent → doing/agent" || true
}

# fable 标签作用于本次实际 worker 进程；已有 session 的 worker/model/角色不同就不能
# 直接注入，需进入 Case B 用同一 cwd resume/fresh，并由 Claude driver 带上新模型。
# session 本身不删：Case B 的 worker_session_launch 在原窗格里换程序，attach 着的
# 终端不会被踢出 tmux（GitHub#197）。
REUSE_SESSION=0
if session_alive "$TMUX_SESSION"; then
    _match=0; tmux_session_matches_worker "$TMUX_SESSION" || _match=$?
    if [ "$_match" = 2 ]; then
        # 读不到 session 记的 agent / 模型 / 角色：既不能注入（可能是别的角色），也不能换程序
        # （可能停掉正在干活的 worker）。本轮不动，非 0 退出，标签不翻，下一轮再判。
        log "issue #$ISSUE -> 读不到 $TMUX_SESSION 记录的 worker / 模型 / 角色（tmux 查询失败），本轮不注入也不换程序"
        exit 1
    elif [ "$_match" = 0 ]; then
        REUSE_SESSION=1
    else
        log "issue #$ISSUE -> session worker/model/角色与请求不一致，原地换程序为 $WORKER_AGENT/${WORKER_MODEL:-default}（$WORKER_SESSION_ROLE）"
    fi
fi

# Case A: session 还活着且是同一个 worker → 注入 prompt
if [ "$REUSE_SESSION" = 1 ]; then
    log "issue #$ISSUE -> 注入现有 session $TMUX_SESSION (agent=$WORKER_AGENT)"
    configure_tmux_session_display "$TMUX_SESSION" "$issue_title"
    if inject_prompt_logged "$TMUX_SESSION" "$PROMPT_FILE"; then
        flip_label
        exit 0
    fi
    log "issue #$ISSUE -> 注入失败，fallback 在原 session 里重起程序 (agent=$WORKER_AGENT)"
    # 注入失败 = 程序不响应/僵尸：Case B 的 worker_session_launch 会先杀掉它再原地换新
fi

# Case B: worktree 还在，session 死了 → 重起 session（有历史就 resume）
if [ -d "$WORKTREE" ]; then
    tmux_env=()
    while IFS= read -r -d '' _tmux_e; do
        tmux_env+=("$_tmux_e")
    done < <(tmux_env_args)

    # B1: 按角色决定续哪条会话 / 起全新（见 _lib.sh 的 agent_session_plan）
    agent_session_plan "$ISSUE" "$WORKTREE" "$PROMPT_FILE"
    CMD="$(secret_env_prefix)$(agent_launch_command "$WORKTREE" "$WORKER_SESSION" "$PROMPT_FILE")"
    log "issue #$ISSUE -> 在 ${TMUX_SESSION} 里起 agent=$WORKER_AGENT 角色=$WORKER_SESSION_ROLE 会话（$AGENT_LAUNCH_KIND）"
    worker_session_launch "$TMUX_SESSION" "$WORKTREE" "$CMD" "${tmux_env[@]}"

    # B2: resume 可能续到异常 state（之前 worker 留下的 Rewind UI 等）然后立即退出
    #     → tmux session 立即关。等 2s 看是否还在，死了就降级成全新会话。
    if [ "$AGENT_LAUNCH_KIND" != "new" ]; then
        sleep 2
        _alive=0; worker_alive "$TMUX_SESSION" || _alive=$?
        if [ "$_alive" = 2 ]; then
            # 读不到程序是否还在：不退休会话记录、不重起（可能正在跑），本轮失败退出，下一轮再判
            log "issue #$ISSUE -> 读不到 $TMUX_SESSION 里的程序是否还在（tmux 查询失败），不降级、不重起"
            exit 1
        fi
        if [ "$_alive" = 1 ]; then
            log "issue #$ISSUE -> resume 启动后 2s 内 session 死了（可能 transcript state 异常），降级为全新 $WORKER_AGENT 会话（丢 conversation history、prompt 含 issue context 仍可工作）"
            agent_session_plan "$ISSUE" "$WORKTREE" "$PROMPT_FILE" 1
            CMD="$(secret_env_prefix)$(agent_launch_command "$WORKTREE" "$WORKER_SESSION" "$PROMPT_FILE")"
            worker_session_launch "$TMUX_SESSION" "$WORKTREE" "$CMD" "${tmux_env[@]}"
        fi
    fi

    # 卡在目录信任确认框上 = 起了也不会干活：截屏、杀会话、转人工（GitHub#108）
    agent_launch_trust_gate "$ISSUE" "$TMUX_SESSION" "$WORKTREE" || exit 0
    agent_session_register_launched "$ISSUE" "$WORKTREE" "$PROMPT_FILE"
    configure_tmux_session_display "$TMUX_SESSION" "$issue_title"
    start_session_logging "$TMUX_SESSION" 2>/dev/null || true
    flip_label
    exit 0
fi

# Case C: worktree 也没了 → 回到 dispatch-new-issue 走全新流程
log "issue #$ISSUE -> 无 worktree，fallback 走 dispatch-new-issue.sh"
# 工作目录都没了，旧 session 里的程序也跑不下去；新建流程要用同名 session，先收掉它
# 动用人的恢复指令的派工（GitHub#339）：收掉旧 session 也是对外动作，先过最后一次核对；
# 再把「这是恢复派工、已经核对过」交给接手的脚本。平时两句都什么都不做。
stuck_release_gate
if session_alive "$TMUX_SESSION"; then
    kill_session_procs "$TMUX_SESSION"
    tmux kill-session -t "=$TMUX_SESSION" 2>/dev/null || true
fi
stuck_release_reexport
exec bash "$SCRIPT_DIR/dispatch-new-issue.sh" "$ISSUE"
