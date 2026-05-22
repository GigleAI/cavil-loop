#!/usr/bin/env bash
# Cursor Agent CLI (`agent`) driver。
#
# 文档：`agent --help`（Cursor IDE 自带 CLI，headless 用 -p / --print）
# 历史存放：Cursor 对话不在 cwd-hash 路径下，本 driver 无法廉价探测 → 一律走 new。
# Busy 探测：tmux pane 里出现 thinking / running / spinner / esc to interrupt 等。
# 新起：agent -p --trust --force --output-format text [extra-flags] "<prompt>"
# 续接：agent --continue -p --trust --force --output-format text [extra-flags] "<prompt>"
#
# 配置开关：CURSOR_AGENT_EXTRA_FLAGS（按需追加 flag；默认已含 -p --trust --force）

agent_bin() { echo "agent"; }

agent_has_history() {
    # Cursor 不在 worktree cwd 下留可探测的历史路径；dispatch 始终用 agent_command_new。
    return 1
}

agent_is_busy() {
    local sess="$1"
    tmux has-session -t "$sess" 2>/dev/null || return 1
    tmux capture-pane -t "$sess" -p 2>/dev/null | \
        grep -qiE 'thinking|running|tool|generating|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|esc to interrupt'
}

agent_command_new() {
    local cwd="$1"
    local name="$2"
    local prompt_file="$3"
    printf 'agent -p --trust --force --output-format text %s "$(cat %s)"' \
        "${CURSOR_AGENT_EXTRA_FLAGS:-}" \
        "$prompt_file"
}

agent_command_resume() {
    local cwd="$1"
    local name="$2"
    local prompt_file="$3"
    printf 'agent --continue -p --trust --force --output-format text %s "$(cat %s)"' \
        "${CURSOR_AGENT_EXTRA_FLAGS:-}" \
        "$prompt_file"
}
