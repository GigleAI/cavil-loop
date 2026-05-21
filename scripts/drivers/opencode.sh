#!/usr/bin/env bash
# OpenCode (sst/opencode) driver —— 首版适配，请按你本机 opencode 版本核对后微调。
#
# 文档：https://opencode.ai/docs/
# 上游：https://github.com/sst/opencode
#
# 历史存放：默认 ~/.local/share/opencode/storage/session/<cwd-hash>/ (随版本可能在
#   ~/.config/opencode/ 或 $XDG_DATA_HOME 下)。本 driver 探测三个常见路径。
# Busy 探测：opencode TUI 在 thinking 时 footer 显示 "thinking" / "esc"；用宽松匹配。
# 新起：opencode "<prompt>"            (启动 TUI 并以该行为首条用户输入)
# 续接：opencode --continue "<prompt>" (若装的版本支持)
#
# 配置开关：OPENCODE_EXTRA_FLAGS

agent_bin() { echo "opencode"; }

# 工作目录归属在 opencode 历史里通常按 cwd 路径哈希命名；这里直接检查全局 session 目录
# 下是否有任何 jsonl/json，作为粗略 "用过 opencode" 信号。各版本目录差异由调用者
# 通过 $OPENCODE_HISTORY_DIRS 覆盖。
agent_has_history() {
    local cwd="$1"
    local enc
    enc="$(encoded_cwd "$cwd")"
    local dirs=(
        "${OPENCODE_HISTORY_DIRS:-}"
        "$HOME/.local/share/opencode/project/$enc"
        "$HOME/.local/share/opencode/storage/session"
        "$HOME/.config/opencode/session"
    )
    local d
    for d in "${dirs[@]}"; do
        [ -z "$d" ] && continue
        if [ -d "$d" ] && \
           compgen -G "$d/*.json" > /dev/null 2>&1 || \
           compgen -G "$d/*.jsonl" > /dev/null 2>&1; then
            return 0
        fi
    done
    return 1
}

agent_is_busy() {
    local sess="$1"
    tmux has-session -t "$sess" 2>/dev/null || return 1
    # opencode TUI 在 thinking / tool-use 中 footer 通常含下列任一关键字
    tmux capture-pane -t "$sess" -p 2>/dev/null | \
        grep -qiE "thinking|working|esc to interrupt|stop"
}

agent_command_new() {
    local cwd="$1"
    local name="$2"  # opencode 暂无类似 claude -n 的 session 命名 flag；预留参数兼容接口
    local prompt_file="$3"
    printf 'opencode %s "$(cat %s)"' \
        "${OPENCODE_EXTRA_FLAGS:-}" \
        "$prompt_file"
}

agent_command_resume() {
    local cwd="$1"
    local name="$2"
    local prompt_file="$3"
    # 部分 opencode 版本支持 --continue；不支持时该 flag 会被忽略或报错，
    # 走 inject_prompt 路径反而更稳。如本机版本不支持，把下面改成 agent_command_new。
    printf 'opencode --continue %s "$(cat %s)"' \
        "${OPENCODE_EXTRA_FLAGS:-}" \
        "$prompt_file"
}
