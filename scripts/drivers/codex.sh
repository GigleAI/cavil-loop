#!/usr/bin/env bash
# Codex CLI (OpenAI codex) driver —— 首版适配，请按你本机 codex 版本核对后微调。
#
# 文档：https://github.com/openai/codex
#
# 历史存放：默认 ~/.codex/sessions/ 或 ~/.codex/history/ (随版本)
# Busy 探测：codex 在 thinking / running tool 时 footer 出现 "thinking" / "running"
# 新起：codex "<prompt>"
# 续接：codex resume                  (新版会列已有 session 选 latest)
#       codex --continue              (老版别名)
#
# 配置开关：CODEX_EXTRA_FLAGS

agent_bin() { echo "codex"; }

agent_has_history() {
    local cwd="$1"
    local dirs=(
        "${CODEX_HISTORY_DIRS:-}"
        "$HOME/.codex/sessions"
        "$HOME/.codex/history"
    )
    local d
    for d in "${dirs[@]}"; do
        [ -z "$d" ] && continue
        if [ -d "$d" ] && \
           (compgen -G "$d/*.json" > /dev/null 2>&1 || \
            compgen -G "$d/*.jsonl" > /dev/null 2>&1); then
            return 0
        fi
    done
    return 1
}

agent_is_busy() {
    local sess="$1"
    tmux has-session -t "$sess" 2>/dev/null || return 1
    tmux capture-pane -t "$sess" -p 2>/dev/null | \
        grep -qiE "thinking|running|esc to interrupt"
}

agent_command_new() {
    local cwd="$1"
    local name="$2"   # codex 没有 session 命名 flag；保留接口
    local prompt_file="$3"
    printf 'codex %s "$(cat %s)"' \
        "${CODEX_EXTRA_FLAGS:-}" \
        "$prompt_file"
}

agent_command_resume() {
    local cwd="$1"
    local name="$2"
    local prompt_file="$3"
    # codex 新版用 `codex resume`（无 prompt 参数，进入选 session 的 TUI）；
    # 老版用 `codex --continue "<prompt>"`。这里走老版语义；若装的是新版，
    # 改成调用 agent_command_new（不 resume，每次起新 session）更稳。
    printf 'codex --continue %s "$(cat %s)"' \
        "${CODEX_EXTRA_FLAGS:-}" \
        "$prompt_file"
}
