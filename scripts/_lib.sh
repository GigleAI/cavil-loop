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
LABEL_AGENT_DOING="${LABEL_AGENT_DOING:-agent/doing}"
LABEL_PENDING_PR="${LABEL_PENDING_PR:-pending/PR}"
LABEL_DONE="${LABEL_DONE:-Done}"

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

# 判断一个 tmux session 里的 Claude 是不是正在「工作」（thinking / tool use 中）。
# Claude Code 处理时 footer 会出现 "esc to interrupt" 字样；idle 时（等用户输入）这行没了。
# 用这个区分「占用并发名额的活 worker」和「已经做完等用户反馈的 idle worker」。
is_session_busy() {
    local sess="$1"
    tmux has-session -t "$sess" 2>/dev/null || return 1
    tmux capture-pane -t "$sess" -p 2>/dev/null | grep -q "esc to interrupt"
}

# 列出本项目的所有 worker session 名字（不含 dev server 或别的同前缀 session）。
# tmux ls 格式 "name: 1 windows ..."，awk -F: 取 field 1 后用 ^...$ 严格匹配。
list_worker_sessions() {
    tmux ls 2>/dev/null | awk -F: -v p="^${TMUX_PREFIX}-${SESSION_NAME_PREFIX}[0-9]+\$" '$1 ~ p {print $1}'
}

# 数活的 worker：只算 Claude 真正在 processing 的 session，
# 不算 idle（已完成 / 等用户反馈）的，也不算 dead 的。
count_active_workers() {
    local n=0 sess
    while IFS= read -r sess; do
        [ -z "$sess" ] && continue
        is_session_busy "$sess" && n=$((n + 1))
    done < <(list_worker_sessions)
    echo "$n"
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

claude_session_name() {
    echo "${SESSION_NAME_PREFIX}$1"
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

# 判断一个 cwd（一般是 worktree 路径）下有没有 Claude Code 历史会话。
# Claude 把每个 project 的 session 存在 ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
# 其中 encoded-cwd = 把绝对路径里的 '/' 全替换成 '-'。
# 有历史就用 `claude --continue` resume；没历史就 `claude -n NAME` 全新起。
has_claude_session() {
    local cwd="$1"
    local encoded
    encoded="$(printf %s "$cwd" | tr / -)"
    local dir="$HOME/.claude/projects/$encoded"
    [ -d "$dir" ] && compgen -G "$dir/*.jsonl" > /dev/null 2>&1
}

# 构造 claude 启动命令：cwd 有历史 → `claude --continue`、没历史 → `claude -n NAME`。
# 用法：CLAUDE_INVOKE="$(claude_invoke "$WORKTREE" "$CLAUDE_SESSION")"
claude_invoke() {
    local cwd="$1"
    local name="$2"
    if has_claude_session "$cwd"; then
        echo "claude --continue ${CLAUDE_EXTRA_FLAGS:-}"
    else
        echo "claude -n $name ${CLAUDE_EXTRA_FLAGS:-}"
    fi
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
