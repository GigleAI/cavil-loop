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
    session_alive "$sess" || return 1
    # 例：tmux capture-pane -t "$sess" -p | grep -q "your busy keyword"
    return 1
}

agent_command_new() {
    local cwd="$1"
    local name="$2"
    local prompt_file="$3"
    local model_arg
    model_arg="$(worker_model_arg)"
    # 注：worker_session_name 用 `<owner>/<repo>#<N>` 格式，含 / # —— 如果你的 agent
    # 支持 session display name flag（claude -n / opencode --name 等），用 `%q`
    # printf format 做 shell-quote。下面示例假设 agent 没这个 flag：
    printf 'your-agent-cli %s %s "$(cat %q)"' \
        "${YOUR_AGENT_EXTRA_FLAGS:-}" \
        "$model_arg" \
        "$prompt_file"
}

agent_command_resume() {
    local cwd="$1"
    local name="$2"
    local prompt_file="$3"
    local model_arg
    model_arg="$(worker_model_arg)"
    # 没 resume 概念就直接 fallback 到 new：
    # agent_command_new "$@"; return
    printf 'your-agent-cli --resume %s %s "$(cat %q)"' \
        "${YOUR_AGENT_EXTRA_FLAGS:-}" \
        "$model_arg" \
        "$prompt_file"
}

# 可选：tmux paste-buffer 不适配你的 agent 时覆盖
# agent_inject_prompt() {
#     local sess="$1" prompt_file="$2"
#     ...
# }

# 可选：你的 agent 进新目录要先确认「信不信这个目录」时实现这三样（契约见 _common.sh「目录信任」）。
# setup.sh 部署时、每次派工起会话前都会调，免得 worker 挂在那个确认框上（不实现就会被跳过）。
# 先拿真 CLI 实测它在 git worktree / 子模块里到底认哪个目录——别假设「子目录继承上级」。
# 确认框的结构（照真机截屏写，见 _common.sh「目录信任」）：标题、整行的「信任」选项、最后一行的底栏
# AGENT_TRUST_PROMPT_TITLE='…'
# AGENT_TRUST_PROMPT_OPTION_RE='^[[:space:]]*…[[:space:]]*$'
# AGENT_TRUST_PROMPT_FOOTER_RE='^[[:space:]]*…[[:space:]]*$'
# agent_trust_key() {      # <dir> → 本 agent 实际按哪个目录判断信任
#     trust_physical_dir "$1"
# }
# agent_trust_paths() {    # <key>... ；必须幂等，写文件走共享锁
#     trust_config_locked_update "<配置文件>" _my_render _my_verify "$@"
# }
