#!/usr/bin/env bash
# 公共库：所有脚本通过 source _lib.sh 引入配置 + 工具函数。
# 调用方在脚本顶部：
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$SCRIPT_DIR/_lib.sh"
#
# 配置查找顺序：
#   1. $CODING_AGENT_CONFIG 环境变量（systemd 用 EnvironmentFile 注入）
#   2. 当前 cwd 向上找 coding-agent.config
#   3. 找不到 → fail
set -euo pipefail

find_config() {
    if [ -n "${CODING_AGENT_CONFIG:-}" ] && [ -f "$CODING_AGENT_CONFIG" ]; then
        echo "$CODING_AGENT_CONFIG"
        return
    fi
    local d="$PWD"
    while [ "$d" != "/" ]; do
        if [ -f "$d/coding-agent.config" ]; then
            echo "$d/coding-agent.config"
            return
        fi
        d="$(dirname "$d")"
    done
    echo ""
}

CONFIG_FILE="$(find_config)"
if [ -z "$CONFIG_FILE" ]; then
    echo "[coding-agent] ERROR: 找不到 coding-agent.config" >&2
    echo "  1) 在 host project 根放一份（参考 \$CLAUDE_PLUGIN_ROOT/coding-agent.config.example）" >&2
    echo "  2) 或 export CODING_AGENT_CONFIG=/path/to/config" >&2
    exit 2
fi
# shellcheck disable=SC1090
source "$CONFIG_FILE"

# 必填校验
: "${REPO:?REPO 未设}"
: "${PROJECT_ROOT:?PROJECT_ROOT 未设}"
: "${WORKTREE_BASE:?WORKTREE_BASE 未设}"
: "${STATE_DIR:?STATE_DIR 未设}"
: "${TMUX_PREFIX:?TMUX_PREFIX 未设}"
: "${BRANCH_PREFIX:?BRANCH_PREFIX 未设}"
: "${SESSION_NAME_PREFIX:?SESSION_NAME_PREFIX 未设}"
: "${LABEL_PENDING_AGENT:?LABEL_PENDING_AGENT 未设}"
: "${LABEL_PENDING_HUMAN:?LABEL_PENDING_HUMAN 未设}"
# 兼容老配置：未设时给默认值
LABEL_AGENT_DOING="${LABEL_AGENT_DOING:-doing/agent}"
LABEL_PENDING_PR="${LABEL_PENDING_PR:-pending/PR}"
LABEL_DONE="${LABEL_DONE:-Done}"
# Worker 写回 GitHub 的内容（issue / PR 评论、设计提案、PR body）用的语言。
# ISO 639-1 code. Default "en"。代码 / commit / 分支名仍按仓库惯例，不受影响。
OUTPUT_LANGUAGE="${OUTPUT_LANGUAGE:-en}"

# Worker agent CLI（claude / opencode / codex / 你自家 driver）。
# 默认 claude → 行为完全等同未引入 driver 抽象前。
WORKER_AGENT="${WORKER_AGENT:-claude}"

mkdir -p "$STATE_DIR"
LOG_FILE="$STATE_DIR/poll.log"

# Pane log 目录：tmux pipe-pane 把 worker session 的输出旁路到文件，
# 这样 tmux session 退出后还能 cat / less 回看历史。
# 默认 $STATE_DIR/sessions。在 coding-agent.config 里显式置空 (SESSION_LOG_DIR="") 即可关闭。
SESSION_LOG_DIR="${SESSION_LOG_DIR-$STATE_DIR/sessions}"

# Skill 目录（scripts/ 的父目录）。Claude Code 注入 $CLAUDE_PLUGIN_ROOT 时优先它。
SKILL_DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

log() {
    echo "[$(date -Iseconds)] [${TMUX_PREFIX}] $*" | tee -a "$LOG_FILE" >&2
}

branch_to_issue_num() {
    local branch="$1"
    local prefix_escaped
    prefix_escaped=$(printf '%s' "$BRANCH_PREFIX" | sed 's/[.[\*^$/]/\\&/g')
    if [[ "$branch" =~ ^${prefix_escaped}([0-9]+) ]]; then
        echo "${BASH_REMATCH[1]}"
    else
        echo ""
    fi
}

# 找一个 PR 对应的「工作编号 N」，用作 worktree / tmux / branch 命名标识。
# fallback 链（任何一步成功就返回）：
#   1. 分支名匹配 BRANCH_PREFIX → 拿数字（覆盖 daemon 自己派工出来的 PR）
#   2. PR body 找 Closes/Fixes/Resolves/Refs #N → 拿数字（外部贡献者 / 手开 PR 但绑 issue）
#   3. fallback 到 PR 编号本身（catch-all：unrelated meta PR / doc fix / external PR）
#
# 设计前提：GitHub 上 issue/PR 共用编号 namespace，第 3 步 fallback 不会跟某个 issue 撞 id。
# 跨平台（GitLab MR、Bitbucket 等）独立 namespace 的情况未来用 adapter 层隔离。
pr_to_issue_num() {
    local pr="$1"
    local branch="$2"
    local n

    # 1. 分支名
    n="$(branch_to_issue_num "$branch")"
    [ -n "$n" ] && { echo "$n"; return; }

    # 2. PR body 关键词
    n=$(gh pr view "$pr" --repo "$REPO" --json body --jq '.body // ""' 2>/dev/null \
        | grep -oiE '(close[sd]?|fix(es|ed)?|resolve[sd]?|refs?)[[:space:]]+#[0-9]+' \
        | head -1 \
        | grep -oE '[0-9]+' || true)
    [ -n "$n" ] && { echo "$n"; return; }

    # 3. fallback：PR 编号本身
    echo "$pr"
}

# 列出本项目的所有 worker session 名字（不含 dev server 或别的同前缀 session）。
# tmux ls 格式 "name: 1 windows ..."，awk -F: 取 field 1 后用 ^...$ 严格匹配。
list_worker_sessions() {
    tmux ls 2>/dev/null | awk -F: -v p="^${TMUX_PREFIX}-${SESSION_NAME_PREFIX}[0-9]+\$" '$1 ~ p {print $1}'
}

# 数活的 worker：用 GitHub 上 `doing/agent` 标签作真值——
# daemon dispatch 时立刻贴上、worker 完工时翻成 pending/human，
# 期间 label 没改 = 工作还在进行中。
#
# 老方案用 tmux capture-pane 找 "esc to interrupt" 字串判 busy，
# 但该字串只在 agent 正在 streaming token 那一瞬间出现——
# worker 在等 permission 弹窗 / 读文件 / tool 调用间隙时都没了，
# 导致 daemon 误以为 idle 又派下一个，破坏 MAX_CONCURRENT_WORKERS。
# label 是 workflow 层意图的表达，远比 pane 内省可靠。
count_active_workers() {
    local issues prs
    issues=$(gh issue list --repo "$REPO" --state open --label "$LABEL_AGENT_DOING" \
        --json number --jq 'length' 2>/dev/null || echo 0)
    prs=$(gh pr list --repo "$REPO" --label "$LABEL_AGENT_DOING" \
        --json number --jq 'length' 2>/dev/null || echo 0)
    echo $((issues + prs))
}

# 列出活的 worker：以 issue 为主显示，如果正在跑 PR（doing/agent on PR）就用括号补
# 上 PR 编号。同款 doing/agent 标签真值；给 log 用。
#
# 输出格式（每行一个 worker）：
#   issue #42              ← 只 issue doing/agent（设计阶段 / 实现阶段还没开 PR）
#   issue #51 (PR #56)     ← PR doing/agent 且通过 pr_to_issue_num 找得到关联 issue
#   PR #43                 ← PR doing/agent 但找不到关联 issue（standalone 元 PR / external PR）
list_active_workers() {
    local issue_nums pr_data
    issue_nums=$(gh issue list --repo "$REPO" --state open --label "$LABEL_AGENT_DOING" \
        --json number --jq '.[] | .number' 2>/dev/null || true)
    pr_data=$(gh pr list --repo "$REPO" --label "$LABEL_AGENT_DOING" \
        --json number,headRefName --jq '.[] | "\(.number)\t\(.headRefName)"' 2>/dev/null || true)

    local -A handled_issue=()
    local -a items=()
    local n pr branch

    # 先处理 PR：算 issue_n（用 pr_to_issue_num fallback 链）并合并显示
    if [ -n "$pr_data" ]; then
        while IFS=$'\t' read -r pr branch; do
            n=$(pr_to_issue_num "$pr" "$branch")
            if [ "$n" = "$pr" ]; then
                # standalone：fallback 到 PR 编号本身（无关联 issue / 外部 PR）
                items+=("PR #$pr")
            else
                items+=("issue #$n (PR #$pr)")
                handled_issue[$n]=1
            fi
        done <<< "$pr_data"
    fi

    # 再处理只 issue doing/agent（且没被任何 PR 关联到）的：单独显示
    if [ -n "$issue_nums" ]; then
        while read -r n; do
            [ -z "$n" ] && continue
            if [ -z "${handled_issue[$n]:-}" ]; then
                items+=("issue #$n")
            fi
        done <<< "$issue_nums"
    fi

    [ ${#items[@]} -gt 0 ] && printf '%s\n' "${items[@]}"
}

# 构造 tmux new-session 的 -e 参数，把 WORKER_PASS_ENV 列的 env 透传给 worker。
# tmux 默认不继承父 shell 的 env，必须显式 -e VAR=VALUE。
# 默认透传 GH_TOKEN（让 worker 里的 gh CLI 用正确的 PAT，而不是 fallback 到 gh auth 默认账号）。
# 列在 WORKER_PASS_ENV 但 env 里没设的变量，会 log warn（典型：手动跑 daemon 但
# 没 export GH_TOKEN —— 否则 worker 静默走 gh 默认 token，导致多账号下 403）。
tmux_env_args() {
    local vars="${WORKER_PASS_ENV:-GH_TOKEN}"
    for var in $vars; do
        local val
        eval "val=\${$var:-}"
        if [ -n "$val" ]; then
            printf -- '-e\0%s=%s\0' "$var" "$val"
        else
            # 写 stderr，agent-poll.sh 的 log 会捕获到
            echo "[coding-agent] WARN: WORKER_PASS_ENV 含 '$var' 但当前 env 没设；worker 不会拿到它。" >&2
            echo "[coding-agent]       手动跑 daemon 请先 export $var=...（systemd 路径自动从 EnvironmentFile 注入）" >&2
        fi
    done
}

tmux_session_name() {
    echo "${TMUX_PREFIX}-${SESSION_NAME_PREFIX}$1"
}

# Agent 侧 session display name（claude -n / opencode / codex 都用作 conversation
# 的 cosmetic 标签——出现在 /resume picker / 终端标题）。用 `<owner>/<repo>#<N>`
# 这个 GitHub idiomatic 短引用：在 worker pane 标题里一眼能定位 issue/PR，在
# GitHub 上引用 `#N` 自动 link。
#
# 注：display name 不参与历史定位（agent_has_history 走 cwd），改 name 不破坏
# 既有 conversation——老 worker --continue 仍能 resume，只是显示的 name 变了。
worker_session_name() {
    echo "${REPO}#$1"
}

worktree_path() {
    echo "${WORKTREE_BASE}/${SESSION_NAME_PREFIX}-$1"
}

branch_name() {
    echo "${BRANCH_PREFIX}$1"
}

# 给一个 tmux session 名拼出对应的 pane log 路径。
# SESSION_LOG_DIR 为空 → 返回空字符串，调用方据此跳过日志。
session_log_path() {
    local sess="$1"
    [ -z "${SESSION_LOG_DIR:-}" ] && { echo ""; return; }
    echo "$SESSION_LOG_DIR/${sess}.log"
}

# 在指定 tmux session 上开 pipe-pane，把 pane 输出 append 到日志文件。
# 使用 `pipe-pane -o`：已有 pipe 时不动，幂等；session 退出时 cat 见 EOF 自然结束。
# 调用方在 `tmux new-session -d` 之后（或重新注入之前）调用。
start_session_logging() {
    local sess="$1"
    local log_path
    log_path="$(session_log_path "$sess")"
    [ -z "$log_path" ] && return 0
    mkdir -p "$(dirname "$log_path")"
    {
        printf '\n===== %s session=%s opened =====\n' \
            "$(date -Iseconds)" "$sess"
    } >> "$log_path"
    tmux pipe-pane -o -t "$sess" "cat >> '$log_path'" 2>/dev/null || \
        log "  ⚠️ pipe-pane 失败：$sess → $log_path"
}

# 跑一条 gh / 任意命令；非 0 时把它的 stderr 拼到 log 里（不退出脚本）。
# 历史上脚本到处 `gh ... 2>/dev/null || log "失败"`，把真正报错全吞了，
# 出问题（如 PAT scope 不够）时只能复现一遍才看到原因——非常痛。
# 用法：run_gh "label 翻转" gh_label_flip "$ISSUE" --add foo --remove bar
run_gh() {
    local desc="$1"; shift
    local out
    if ! out=$("$@" 2>&1); then
        log "  ⚠️ ${desc}失败: $out"
        return 1
    fi
    return 0
}

# Label 翻转 helper：走 REST API 的 /issues/N/labels endpoint，绕过 `gh pr edit
# --add-label` 内部 GraphQL `updatePullRequest` mutation（它要 read:org scope
# 去查 login 字段——bot PAT 一般没这个 scope，调用直接 fail）。REST 路径只要
# repo scope 就能改 label，PR / issue 都通用（GitHub API 里 PR 是 issue 的子集）。
# 用法：gh_label_flip <pr_or_issue_number> [--add label1 [label2 ...]] [--remove label1 ...]
gh_label_flip() {
    local num="$1"; shift
    local mode=""
    local adds=() removes=()
    while [ $# -gt 0 ]; do
        case "$1" in
            --add) mode=add; shift;;
            --remove) mode=remove; shift;;
            *)
                if [ "$mode" = add ]; then adds+=("$1")
                elif [ "$mode" = remove ]; then removes+=("$1")
                fi
                shift
                ;;
        esac
    done

    # remove first（防短暂同时有新旧 label 的窗口）
    local L encoded
    for L in "${removes[@]}"; do
        encoded=$(printf '%s' "$L" | jq -sRr @uri)
        # 404 表示 label 已经不在了——视为成功（idempotent）
        gh api -X DELETE "repos/$REPO/issues/$num/labels/$encoded" >/dev/null 2>&1 || true
    done

    # add
    if [ ${#adds[@]} -gt 0 ]; then
        local args=()
        for L in "${adds[@]}"; do
            args+=(-f "labels[]=$L")
        done
        gh api -X POST "repos/$REPO/issues/$num/labels" "${args[@]}" >/dev/null 2>&1 || return 1
    fi
    return 0
}

# Prompt 模板查找顺序：
#   1. <project>/.agents/skills/coding-agent-work-loop/prompts/<name>.template.md   ← 新规范（推荐）
#   2. <project>/.agents/skills/coding-agent-workflow/prompts/<name>.template.md    ← 旧目录名（兼容；老 worktree/分支）
#   3. <project>/.coding-agent/prompts/<name>.template.md                           ← 更老路径（兼容）
#   4. <skill-dir>/prompts/<name>.template.md                                       ← skill 默认
find_prompt_template() {
    local name="$1"   # e.g. "new-issue" / "pr-comment"
    local candidates=(
        "$PROJECT_ROOT/.agents/skills/coding-agent-work-loop/prompts/${name}.template.md"
        "$PROJECT_ROOT/.agents/skills/coding-agent-workflow/prompts/${name}.template.md"
        "$PROJECT_ROOT/.coding-agent/prompts/${name}.template.md"
        "$SKILL_DIR/prompts/${name}.template.md"
    )
    for c in "${candidates[@]}"; do
        if [ -f "$c" ]; then
            echo "$c"
            return
        fi
    done
    echo ""
}

# ── 加载 driver（按 WORKER_AGENT）──
# 放在文件末尾，确保 _lib.sh 自己的函数都已定义；driver 注入的函数
# (agent_is_busy / agent_has_history / agent_command_new/resume) 之后被 dispatch
# 脚本 + cleanup-issue.sh 在执行时取到。
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/drivers/_common.sh"
source_driver "$WORKER_AGENT" || exit 2
