#!/usr/bin/env bash
# drivers/_template.sh —— 复制成 drivers/<your-agent>.sh 后填空即可。
# 加新 driver 完整指南：docs/drivers.md。
#
# 三件事必查：
#   1. 你的 agent CLI 在哪里存历史会话（决定 agent_has_history）
#   2. agent 处理中时 tmux pane 出现什么稳定关键字（决定 agent_is_busy）
#   3. 新起 / 续接的命令行格式（决定 agent_command_new / agent_command_resume）
#
# 注意：agent_command_* 输出的是 **shell 命令字符串**（不是数组），
# 会被 tmux shell eval；prompt 用 "$(cat <prompt_file>)" 延迟展开，安全省事。

agent_bin() { echo "your-agent-cli"; }

agent_has_history() {
    local cwd="$1"
    # 例：[ -d "$HOME/.your-agent/projects/$(encoded_cwd "$cwd")" ]
    return 1
}

agent_is_busy() {
    local sess="$1"
    tmux has-session -t "$sess" 2>/dev/null || return 1
    # 例：tmux capture-pane -t "$sess" -p | grep -q "your busy keyword"
    return 1
}

agent_command_new() {
    local cwd="$1"
    local name="$2"
    local prompt_file="$3"
    printf 'your-agent-cli %s "$(cat %s)"' \
        "${YOUR_AGENT_EXTRA_FLAGS:-}" \
        "$prompt_file"
}

agent_command_resume() {
    local cwd="$1"
    local name="$2"
    local prompt_file="$3"
    # 没 resume 概念就直接 fallback 到 new：
    # agent_command_new "$@"; return
    printf 'your-agent-cli --resume %s "$(cat %s)"' \
        "${YOUR_AGENT_EXTRA_FLAGS:-}" \
        "$prompt_file"
}

# 可选：tmux paste-buffer 不适配你的 agent 时覆盖
# agent_inject_prompt() {
#     local sess="$1" prompt_file="$2"
#     ...
# }
