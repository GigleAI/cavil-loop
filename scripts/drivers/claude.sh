#!/usr/bin/env bash
# Claude Code (claude CLI) driver。
#
# 文档：https://docs.claude.com/en/docs/claude-code
# 历史存放：~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
# Busy 探测：tmux pane footer 出现 "esc to interrupt" 时为 thinking / tool use 中
# 新起：claude -n <name> [extra-flags] "<prompt>"
# 续接：claude --continue [extra-flags] "<prompt>"
#
# 配置开关：CLAUDE_EXTRA_FLAGS（推荐 "--dangerously-skip-permissions"，否则卡权限弹窗）

agent_bin() { echo "claude"; }

agent_has_history() {
    local cwd="$1"
    local dir="$HOME/.claude/projects/$(encoded_cwd "$cwd")"
    [ -d "$dir" ] && compgen -G "$dir/*.jsonl" > /dev/null 2>&1
}

agent_is_busy() {
    local sess="$1"
    tmux has-session -t "$sess" 2>/dev/null || return 1
    tmux capture-pane -t "$sess" -p 2>/dev/null | grep -q "esc to interrupt"
}

agent_command_new() {
    local cwd="$1"   # 未直接用：tmux 已 -c "$cwd"，claude 自动 cwd
    local name="$2"
    local prompt_file="$3"
    printf 'claude -n %s %s "$(cat %s)"' \
        "$name" \
        "${CLAUDE_EXTRA_FLAGS:-}" \
        "$prompt_file"
}

agent_command_resume() {
    local cwd="$1"   # 同上
    local name="$2"  # 未用：claude --continue 自动用 cwd 最近会话
    local prompt_file="$3"
    printf 'claude --continue %s "$(cat %s)"' \
        "${CLAUDE_EXTRA_FLAGS:-}" \
        "$prompt_file"
}
