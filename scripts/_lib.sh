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

mkdir -p "$STATE_DIR"
LOG_FILE="$STATE_DIR/poll.log"

# Skill 目录（scripts/ 的父目录）。Claude Code 注入 $CLAUDE_PLUGIN_ROOT 时优先它。
SKILL_DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

log() {
    echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE" >&2
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
tmux_env_args() {
    local vars="${WORKER_PASS_ENV:-GH_TOKEN}"
    for var in $vars; do
        local val
        eval "val=\${$var:-}"
        if [ -n "$val" ]; then
            printf -- '-e\0%s=%s\0' "$var" "$val"
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

# Prompt 模板查找：先 host project 覆盖，再 skill 默认
find_prompt_template() {
    local name="$1"   # e.g. "new-issue" / "pr-comment"
    local override="$PROJECT_ROOT/.coding-agent/prompts/${name}.template.md"
    if [ -f "$override" ]; then
        echo "$override"
    elif [ -f "$SKILL_DIR/prompts/${name}.template.md" ]; then
        echo "$SKILL_DIR/prompts/${name}.template.md"
    else
        echo ""
    fi
}
