#!/usr/bin/env bash
# PR 评论派工：找到对应 worker session 注入 prompt；session 没了就重建。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# 重测试排队开着时（GitHub#343），整个派工在条目锁里跑，和 cleanup-issue.sh 一先一后。锁按工作
# 编号（工作树 / 会话用的那个号），不是 PR 编号；算不出来就不拿锁，下面的兜底照旧处理。
if heavy_enabled; then
    _lock_n="$(pr_to_issue_num "${1:?need PR number}" "${2:?need branch}")"
    [ -z "$_lock_n" ] || item_lock_reexec "$_lock_n" "${BASH_SOURCE[0]}" "$@"
fi

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
    notify_bounced_to_human "$PR" \
        "daemon 解析不出这个 PR 对应的工作编号（多半是 GitHub API 当时异常）。" \
        "稍后直接把标签改回 \`$LABEL_PENDING_AGENT\` 重试；反复出现请查 daemon 机器上的 poll.log。"
    run_gh "label 翻转 (PR #$PR 兜底 pending/agent → pending/human)" \
        gh_label_flip "$PR" \
        --add "$LABEL_PENDING_HUMAN" \
        --remove "${TRIGGER_LABELS_ALL[@]}" || true
    exit 0
fi

# 定下这次启动的条目代数和启动编号（重测试排队，功能关着什么都不做）；注入现有会话时用不上
heavy_launch_prepare "$ISSUE_N" || exit 1

WORKTREE="$(worktree_path "$ISSUE_N")"
TMUX_SESSION="$(tmux_session_name "$ISSUE_N")"
WORKER_SESSION="$(worker_session_name "$ISSUE_N")"
issue_title="$(github_issue_title "$ISSUE_N" || true)"

# Prompt 模板
# DISPATCH_PROMPT_KIND 由 agent-poll 按触发 label 指定（如 review 关卡用 "review"）；
# 不设就是本路径的默认模板。
TEMPLATE="$(compose_prompt_template "${DISPATCH_PROMPT_KIND:-pr-comment}")"
PROMPT_FILE="$(prompt_file_path pr "$ISSUE_N" "$PR")"
prompt_dir_ensure || { log "派工 PR #$PR：建不出提示词目录 $(prompt_dir)，本轮不派工"; exit 1; }
if [ -n "$TEMPLATE" ]; then
    sed \
        -e "s|\${PR}|$PR|g" \
        -e "s|\${REPO}|$REPO|g" \
        -e "s|\${BRANCH}|$BRANCH|g" \
        -e "s|\${ISSUE_N}|$ISSUE_N|g" \
        -e "s|\${LABEL_PENDING_AGENT}|$LABEL_PENDING_AGENT|g" \
        -e "s|\${LABEL_PENDING_HUMAN}|$LABEL_PENDING_HUMAN|g" \
        -e "s|\${LABEL_PENDING_AGENT_DEFAULT}|$LABEL_PENDING_AGENT_DEFAULT|g" \
        -e "s|\${LABEL_PENDING_REVIEW}|$LABEL_PENDING_REVIEW|g" \
        -e "s|\${LABEL_REVIEW_OR_HUMAN}|$LABEL_REVIEW_OR_HUMAN|g" \
        -e "s|\${REVIEW_MAX_ROUNDS}|$REVIEW_MAX_ROUNDS|g" \
        -e "s|\${LABEL_AGENT_DOING}|$LABEL_AGENT_DOING|g" \
        -e "s|\${LABEL_PENDING_PR}|$LABEL_PENDING_PR|g" \
        -e "s|\${OUTPUT_LANGUAGE}|$OUTPUT_LANGUAGE|g" \
        -e "s|\${TMUX_SESSION}|$TMUX_SESSION|g" \
        -e "s|\${PREVIEW_URL_HOST}|${PREVIEW_URL_HOST:-}|g" \
        -e "s|\${REVIEW_ASSET_BASE_URL}|${WEEKLY_REPORT_ASSET_ROOT_URL:-}|g" \
        -e "s|\${TASK_START_TS}|$(date '+%Y-%m-%d %H:%M:%S')|g" \
        -e "s|\${COMMENT_FOOTER}|$COMMENT_FOOTER|g" \
        -e "s|\${AGENT_TOKEN_USAGE_SCRIPT}|$AGENT_TOKEN_USAGE_SCRIPT|g" \
        -e "s|\${COMMENT_FOOTER_CMD}|$COMMENT_FOOTER_CMD|g" \
        -e "s|\${WORKER_AGENT}|$WORKER_AGENT|g" \
        -e "s|\${WORK_NUM}|$ISSUE_N|g" \
        "$TEMPLATE" > "$PROMPT_FILE"
    # 同时在进行的其他工作（GitHub#340）：清单是多行的、含别人写的标题，放在 sed 之后单独填
    concurrent_work_fill "$PROMPT_FILE" "$BRANCH" "$ISSUE_N" "$PR" || true
else
    cat > "$PROMPT_FILE" <<EOF
PR #$PR 有新评论。三类反馈来源都要读（inline 行评论 \`gh pr view\` 看不到，必须单独拉，最易漏）：
- 对话评论：\`gh pr view $PR --repo $REPO --comments\`
- inline 代码行评论：\`gh api repos/$REPO/pulls/$PR/comments --paginate --jq '.[] | "[\(.user.login)] \(.path):\(.line) id=\(.id)\n  \(.body)"'\`
- review 总结：\`gh api repos/$REPO/pulls/$PR/reviews --paginate --jq '.[] | select(.body!="") | "[\(.user.login)] \(.state): \(.body)"'\`
按内容处理：
- 讨论 → gh pr comment 回答
- 改代码 → 改 + 测试 + commit + push + 对每条 inline 评论在其 thread 回复（\`gh api -X POST repos/$REPO/pulls/$PR/comments/<id>/replies -f body=...\`）
- 不明 → 反问
完成后翻 label（REST，绕 read:org）：
  gh api -X POST "repos/$REPO/issues/$PR/labels" -f "labels[]=$LABEL_PENDING_HUMAN"
  gh api -X DELETE "repos/$REPO/issues/$PR/labels/\$(printf '%s' "$LABEL_PENDING_AGENT" | jq -sRr @uri)" || true
EOF
fi

flip_label() {
    # daemon dispatch 翻到 doing/agent；worker 完工时它自己翻成 pending/human
    flip_to_doing "$PR" "PR #$PR pending/agent → $LABEL_AGENT_DOING" || true
}

# 标签要求的 worker/model/角色与现有 session 不一致时，不能走 stdin 注入；由
# Case B/C 的 new/resume 命令带上选择，conversation/worktree 仍按原 work number 续接。
# session 本身不删：Case B 的 worker_session_launch 在原窗格里换程序，attach 着的
# 终端不会被踢出 tmux（GitHub#197）。
REUSE_SESSION=0
if session_alive "$TMUX_SESSION"; then
    _match=0; tmux_session_matches_worker "$TMUX_SESSION" || _match=$?
    if [ "$_match" = 2 ]; then
        # 读不到 session 记的 agent / 模型 / 角色：既不能注入（可能是别的角色），也不能换程序
        # （可能停掉正在干活的 worker）。本轮不动，非 0 退出，标签不翻，下一轮再判。
        log "PR #$PR -> 读不到 $TMUX_SESSION 记录的 worker / 模型 / 角色（tmux 查询失败），本轮不注入也不换程序"
        exit 1
    elif [ "$_match" = 0 ]; then
        REUSE_SESSION=1
    else
        log "PR #$PR -> session worker/model/角色与请求不一致，原地换程序为 $WORKER_AGENT/${WORKER_MODEL:-default}（${WORKER_SESSION_ROLE}）"
    fi
fi

# Case A: 现有 worker session，且是同一个 worker
if [ "$REUSE_SESSION" = 1 ]; then
    log "PR #$PR -> 注入 $TMUX_SESSION (agent=$WORKER_AGENT)"
    configure_tmux_session_display "$TMUX_SESSION" "$issue_title"
    start_session_logging "$TMUX_SESSION"
    if inject_prompt_logged "$TMUX_SESSION" "$PROMPT_FILE"; then
        flip_label
        exit 0
    fi
    log "PR #$PR -> 注入失败，fallback 在原 session 里重起程序 (agent=$WORKER_AGENT)"
    # 注入失败 = 程序不响应/僵尸：Case B 的 worker_session_launch 会先杀掉它再原地换新
fi

# Case B: worktree 还在，session 没了 → 重起（有历史就 resume）
if [ -d "$WORKTREE" ]; then
    tmux_env=()
    while IFS= read -r -d '' _tmux_e; do
        tmux_env+=("$_tmux_e")
    done < <(tmux_env_args)

    # 按角色决定续哪条会话 / 起全新（见 _lib.sh 的 agent_session_plan）
    agent_session_plan "$ISSUE_N" "$WORKTREE" "$PROMPT_FILE"
    CMD="$(secret_env_prefix)$(agent_launch_command "$WORKTREE" "$WORKER_SESSION" "$PROMPT_FILE")"
    log "PR #$PR -> 在 $TMUX_SESSION 里起 agent=$WORKER_AGENT 角色=$WORKER_SESSION_ROLE 会话（${AGENT_LAUNCH_KIND}）"
    worker_session_launch "$TMUX_SESSION" "$WORKTREE" "$CMD" "${tmux_env[@]}"

    # resume 可能续到异常 state（之前 worker 留下的 Rewind UI 等）然后立即退出
    # → tmux session 立即关。等 2s 看是否还在，死了就降级成全新会话。
    if [ "$AGENT_LAUNCH_KIND" != "new" ]; then
        sleep 2
        _alive=0; worker_alive "$TMUX_SESSION" || _alive=$?
        if [ "$_alive" = 2 ]; then
            # 读不到程序是否还在：不退休会话记录、不重起（可能正在跑），本轮失败退出，下一轮再判
            log "PR #$PR -> 读不到 $TMUX_SESSION 里的程序是否还在（tmux 查询失败），不降级、不重起"
            exit 1
        fi
        if [ "$_alive" = 1 ]; then
            log "PR #$PR -> resume 启动后 2s 内 session 死了（可能 transcript state 异常），降级为全新 $WORKER_AGENT 会话（丢 conversation history、prompt 含 PR context 仍可工作）"
            agent_session_plan "$ISSUE_N" "$WORKTREE" "$PROMPT_FILE" 1
            CMD="$(secret_env_prefix)$(agent_launch_command "$WORKTREE" "$WORKER_SESSION" "$PROMPT_FILE")"
            worker_session_launch "$TMUX_SESSION" "$WORKTREE" "$CMD" "${tmux_env[@]}"
        fi
    fi

    # 卡在目录信任确认框上 = 起了也不会干活：截屏、杀会话、转人工（GitHub#108）
    heavy_launch_record "$TMUX_SESSION"   # 重测试排队：记下这次新起的 worker 进程
    agent_launch_trust_gate "$PR" "$TMUX_SESSION" "$WORKTREE" || exit 0
    agent_session_register_launched "$ISSUE_N" "$WORKTREE" "$PROMPT_FILE"
    configure_tmux_session_display "$TMUX_SESSION" "$issue_title"
    start_session_logging "$TMUX_SESSION"
    flip_label
    exit 0
fi

# Case C: 全新重建 worktree（基于 PR head branch，不是 main）
#
# 用 `refs/pull/$PR/head` 拉 PR head——GitHub 把所有 PR（含来自 fork 的 external PR）的 head
# commit 都暴露在这个 ref 下。这条对 fork 透明，不需要额外 remote。
# 拉下来后存到本地命名分支 ${BRANCH}（跟 daemon-spawned PR 一致），worktree 基于它建。
log "PR #$PR -> 全新重建 worktree on $BRANCH (via refs/pull/$PR/head)"
cd "$PROJECT_ROOT"

# 目标分支已经被**另一个** worktree 签出时，这条路是走不通的，而且两种走法都坏：
# fetch 会被 git 无条件拒绝（见 _lib.sh:branch_checked_out_elsewhere 的实测说明），
# 而下面那句 `git worktree add --force` 又会绕过保护、建出第二个签出同一分支的
# worktree —— 两个 worker 往一个分支上提交。所以在 fetch **之前**就挡住。
#
# 这类失败在占用者还在期间是确定性的，重试 100% 白费（每次派工都含一次真出网的
# sync_project_checkout），所以直接转人工，不进 agent-poll.sh 的重试计数通道。
# 写法跟本文件上面 pr_to_issue_num 返空时那段同款：翻 label + exit 0。
#
# 占用者是本项目的主 checkout 时（人在主 checkout 里开分支 → push → 交给 daemon），
# 提示要给 `switch` 而不是必然失败的 `worktree remove`；配置打开
# AUTO_RELEASE_MAIN_CHECKOUT=1 且确定零丢失时，daemon 自己切回 base 再往下走（GitHub#141）。
if find_branch_holder "$BRANCH" "$WORKTREE"; then
    BASE="${BASE_BRANCH:-main}"
    # 拿 PR 最新提交来比：只写 FETCH_HEAD，不写被占用的分支，git 不会拒绝。
    PR_HEAD_SHA=""
    if run_git "fetch PR #$PR head（比对占用者用，只写 FETCH_HEAD）" \
        git fetch origin "refs/pull/$PR/head"; then
        PR_HEAD_SHA=$(git rev-parse -q --verify "FETCH_HEAD^{commit}" 2>/dev/null || true)
    fi
    branch_holder_state "$BRANCH" "$PR_HEAD_SHA" "PR #$PR 的最新提交" "读不出 PR 的最新提交"
    HOLDER_WHO="$(branch_holder_who)"
    HOLDER_DIR="$BH_DIR"   # 下面切换后重查会清掉 BH_*，留言要用切换前的那个目录
    log "PR #$PR -> 分支 $BRANCH 已被${HOLDER_WHO} 签出（git 报的路径：${BH_RAW}）"
    log "  → 占用者现状：$BH_STATE_TEXT"

    RELEASED=0
    if [ "$AUTO_RELEASE_MAIN_CHECKOUT" = 1 ]; then
        if main_checkout_auto_release "$BRANCH" "$PR_HEAD_SHA"; then
            # 切完再查一次：确认分支真的空出来了，才往下 fetch / 建 worktree。
            if find_branch_holder "$BRANCH" "$WORKTREE"; then
                log "  → 已切换主 checkout，但分支仍被 $BH_DIR 签出，转人工"
                AUTO_RELEASE_REASON="切换后分支仍被 \`$BH_DIR\` 签出"
            else
                RELEASED=1
            fi
        fi
        [ "$RELEASED" = 1 ] || log "  → 不自动释放：$AUTO_RELEASE_REASON"
    fi

    if [ "$RELEASED" != 1 ]; then
        log "  → 拒绝重建 worktree（fetch 会被 git 拒绝；--force 建出来是两个 worktree 共用一个分支）"
        log "  → 翻 label 回 ${LABEL_PENDING_HUMAN}，不重试"
        reason="分支 \`$BRANCH\` 已被本机${HOLDER_WHO} 签出，daemon 没法为这个 PR 建工作目录——硬建会变成两个 worktree 往同一分支提交。占用者现状：${BH_STATE_TEXT}。"
        if [ "$AUTO_RELEASE_MAIN_CHECKOUT" = 1 ] && [ -n "${AUTO_RELEASE_REASON:-}" ]; then
            reason="$reason 没有自动切走它：${AUTO_RELEASE_REASON}。"
        fi
        notify_bounced_to_human "$PR" "$reason" "$(branch_holder_next_step "$BASE")"
        run_gh "label 翻转 (PR #$PR 分支被占用 → $LABEL_PENDING_HUMAN)" \
            gh_label_flip "$PR" \
            --add "$LABEL_PENDING_HUMAN" \
            --remove "${TRIGGER_LABELS_ALL[@]}" || true
        exit 0
    fi

    log "  → 已把主 checkout 从 $BRANCH 切回 ${BASE}（切换前干净、与 PR 最新提交一致）"
fi

# 本地分支要落到 PR 最新提交上，两条路写法不同：
#   · 平常（分支没被占）：强制 fetch，PR 上的就是准的；
#   · 刚自动让出主 checkout：**不能**再强制 fetch。检查之后、切换之前，人可能刚好在主
#     checkout 里往这个分支提交了一次（检查时一致不代表现在一致）——强制 fetch 会把那个
#     提交从分支上挤掉（复审实测）。这里用带旧值的 update-ref：git 加锁后核对分支仍是
#     检查时那个提交，才算数；对不上就原样留着分支、不派工、转人工。
#     核对通过之后主 checkout 已不在这个分支上，再有人改它（比如 branch -f）也只会被
#     接下来建的 worktree 带上，不会被覆盖。
if [ "${RELEASED:-0}" = 1 ]; then
    if ! cas_out=$(git update-ref "refs/heads/$BRANCH" "$PR_HEAD_SHA" "$PR_HEAD_SHA" 2>&1); then
        now_sha=$(git rev-parse -q --verify "refs/heads/$BRANCH^{commit}" 2>/dev/null || echo "读不出")
        log "PR #$PR -> 让出主 checkout 期间分支 $BRANCH 变了（检查时 ${PR_HEAD_SHA}，现在 ${now_sha}），不覆盖、不派工，转人工"
        log "  git: $(printf '%s' "$cas_out" | tr '\n' ' ' | head -c 300)"
        notify_bounced_to_human "$PR" \
            "daemon 已把本机主 checkout \`$HOLDER_DIR\` 从 \`$BRANCH\` 切回 \`$BASE\`，但就在检查和切换之间，分支 \`$BRANCH\` 多出了新提交（检查时是 \`$PR_HEAD_SHA\`，现在是 \`$now_sha\`）。daemon 没有覆盖它，也没有派工。" \
            "确认这些新提交是否要进 PR：要的话 push 到 PR 分支；不要的话自行处理。然后把标签改回 \`$LABEL_PENDING_AGENT\`。"
        run_gh "label 翻转 (PR #$PR 让出期间分支变化 → $LABEL_PENDING_HUMAN)" \
            gh_label_flip "$PR" \
            --add "$LABEL_PENDING_HUMAN" \
            --remove "${TRIGGER_LABELS_ALL[@]}" || true
        exit 0
    fi
    run_gh "说明主 checkout 已切回 (#$PR)" \
        gh_write api -X POST "repos/$REPO/issues/$PR/comments" \
        -f "body=$(printf 'ℹ️ 本机主 checkout `%s` 已从 `%s` 切回 `%s`，好为这个 PR 建工作目录。切换前没有未提交改动；切换后再次核对，分支仍停在 PR 最新提交 `%s`，没有丢任何东西。\n\n<sub>cavil-loop daemon @ %s 自动留言</sub>' \
            "$HOLDER_DIR" "$BRANCH" "$BASE" "$PR_HEAD_SHA" "$(hostname -s 2>/dev/null || hostname)")" || true
else
    run_git "fetch PR #$PR head → $BRANCH" \
        git fetch origin "+refs/pull/$PR/head:refs/heads/$BRANCH" || exit 1
fi
mkdir -p "$WORKTREE_BASE"
# 用本地分支建 worktree：平常路径上 fetch 已 force-update 到 PR head；让出路径上已核对过它就是 PR head。
# 让出路径不加 --force：核对之后若有人又在主 checkout 里签出了这个分支，--force 会建出第二个
# 签出同一分支的 worktree；不加时 git 直接拒绝，本轮派工失败、下轮重新判断，什么都不丢。
WT_FORCE=(--force)
[ "${RELEASED:-0}" = 1 ] && WT_FORCE=()
run_git "worktree add $WORKTREE ($BRANCH)" \
    git worktree add "${WT_FORCE[@]}" "$WORKTREE" "$BRANCH" || exit 1

for rel in ${COPY_TO_WORKTREE:-}; do
    src="$PROJECT_ROOT/$rel"
    if [ -f "$src" ]; then
        mkdir -p "$WORKTREE/$(dirname "$rel")"
        cp "$src" "$WORKTREE/$rel"
    fi
done

[ -n "${WORKTREE_SETUP_CMD:-}" ] && [ "${WORKTREE_SETUP_CMD}" != ":" ] && \
    (cd "$WORKTREE" && eval "$WORKTREE_SETUP_CMD") || true

agent_session_plan "$ISSUE_N" "$WORKTREE" "$PROMPT_FILE"
CMD="$(secret_env_prefix)$(agent_launch_command "$WORKTREE" "$WORKER_SESSION" "$PROMPT_FILE")"
log "PR #$PR -> 重建 worktree 后起 agent=$WORKER_AGENT 角色=$WORKER_SESSION_ROLE 会话（${AGENT_LAUNCH_KIND}）"
tmux_env=()
while IFS= read -r -d '' _tmux_e; do
    tmux_env+=("$_tmux_e")
done < <(tmux_env_args)
# 工作目录是重建出来的，旧 session 可能还在：照样原地换程序，不删 session（GitHub#197）
worker_session_launch "$TMUX_SESSION" "$WORKTREE" "$CMD" "${tmux_env[@]}"
# 卡在目录信任确认框上 = 起了也不会干活：截屏、杀会话、转人工（GitHub#108）
heavy_launch_record "$TMUX_SESSION"   # 重测试排队：记下这次新起的 worker 进程
agent_launch_trust_gate "$PR" "$TMUX_SESSION" "$WORKTREE" || exit 0
agent_session_register_launched "$ISSUE_N" "$WORKTREE" "$PROMPT_FILE"
configure_tmux_session_display "$TMUX_SESSION" "$issue_title"
start_session_logging "$TMUX_SESSION"

flip_label
log "dispatch-pr-comment done: PR #$PR fresh worktree + session (agent=$WORKER_AGENT)"
