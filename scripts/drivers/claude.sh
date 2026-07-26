#!/usr/bin/env bash
# Claude Code (claude CLI) driver。
#
# 文档：https://docs.claude.com/en/docs/claude-code
# 历史存放：~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
# Busy 探测：tmux pane footer 出现 "esc to interrupt" 时为 thinking / tool use 中
# 新起：claude -n <name> [extra-flags] [--model <model>] "<prompt>"
# 续接：claude --continue [extra-flags] [--model <model>] "<prompt>"
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
    session_alive "$sess" || return 1
    # 只看 pane 最后 5 行（footer + 最近 status），避免 scrollback 历史误判：
    # claude 之前 busy 期间打印的 "esc to interrupt" 字串保留在可视 pane 里，
    # grep 整个 pane 会把历史也当 busy。
    tmux capture-pane -t "$sess" -p 2>/dev/null | tail -5 | grep -q "esc to interrupt"
}

agent_command_new() {
    local cwd="$1"   # 未直接用：tmux 已 -c "$cwd"，claude 自动 cwd
    local name="$2"
    local prompt_file="$3"
    local model_arg
    model_arg="$(worker_model_arg)"
    # name 含 / # 等需要 shell-quote（worker_session_name 现在用 GigleAI/repo#42 风格）
    printf 'claude -n %q %s %s "$(cat %s)"' \
        "$name" \
        "${CLAUDE_EXTRA_FLAGS:-}" \
        "$model_arg" \
        "$prompt_file"
}

agent_command_resume() {
    local cwd="$1"   # 同上
    local name="$2"  # 未用：claude --continue 自动用 cwd 最近会话
    local prompt_file="$3"
    local model_arg
    model_arg="$(worker_model_arg)"
    printf 'claude --continue %s %s "$(cat %s)"' \
        "${CLAUDE_EXTRA_FLAGS:-}" \
        "$model_arg" \
        "$prompt_file"
}
