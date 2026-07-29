#!/usr/bin/env bash
# Cursor Agent CLI (`agent`) driver。
#
# 文档：`agent --help`（Cursor IDE 自带 CLI，headless 用 -p / --print）
# 历史存放：Cursor 对话不在 cwd-hash 路径下，本 driver 无法廉价探测 → 一律走 new。
# Busy 探测：tmux pane 里出现 thinking / running / spinner / esc to interrupt 等。
# 新起：agent -p --trust --force --output-format text [extra-flags] "<prompt>"
# 续接：fallback 到 new（`agent --continue -p` 未实测，TODO）
# 注入：-p 是 non-interactive print 模式，不支持 mid-session stdin 注入 →
#       agent_inject_prompt 杀 session 并 return 1，让 dispatch 走 Case B 重起。
#
# 配置开关：CURSOR_AGENT_EXTRA_FLAGS（按需追加 flag；默认已含 -p --trust --force）

agent_bin() { echo "agent"; }

agent_has_history() {
    # Cursor 不在 worktree cwd 下留可探测的历史路径；dispatch 始终用 agent_command_new。
    return 1
}

# busy 判据：关键字 + braille spinner 各帧。关键字通用，
# AGENT_BUSY_TAIL 保持默认 5 行的小窗口，别放宽。
AGENT_BUSY_RE='thinking|running|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|esc to interrupt'

agent_is_busy() {
    local sess="$1"
    session_alive "$sess" || return 1
    agent_pane_is_busy "$sess"
}

agent_inject_prompt() {
    local sess="$1"
    # -p 从 argv 读 prompt、不读 stdin；paste-buffer 注入会被吞掉。
    # 杀 session 让 dispatch-*-comment.sh Case A 失败后 fallback 到 Case B 重起。
    tmux kill-session -t "$sess" 2>/dev/null || true
    return 1
}

agent_command_new() {
    local cwd="$1"
    local name="$2"
    local prompt_file="$3"
    local model_arg
    model_arg="$(worker_model_arg)"
    printf 'agent -p --trust --force --output-format text %s %s "$(cat %s)"' \
        "${CURSOR_AGENT_EXTRA_FLAGS:-}" \
        "$model_arg" \
        "$prompt_file"
}

agent_command_resume() {
    # Cursor -p 是 non-interactive 一次性 print；`agent --continue -p` 未实测，
    # 先 fallback 到 new，避免项目级 override agent_has_history 时踩 surprise。
    agent_command_new "$@"
}
