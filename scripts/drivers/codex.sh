#!/usr/bin/env bash
# Codex CLI (OpenAI codex) driver —— 首版适配，请按你本机 codex 版本核对后微调。
#
# 文档：https://github.com/openai/codex
#
# 历史存放：默认 ~/.codex/sessions/ 或 ~/.codex/history/ (随版本)
# Busy 探测：codex 在 thinking / running tool 时 footer 出现 "thinking" / "running"
# 新起：codex [--model <model>] "<prompt>"
# 续接：codex resume --last [--model <model>] "<prompt>"
#
# 配置开关：CODEX_EXTRA_FLAGS。未设置时默认跳过确认并关闭 Codex sandbox；
# 显式设为空字符串可关闭该默认值。

CODEX_EXTRA_FLAGS="${CODEX_EXTRA_FLAGS---dangerously-bypass-approvals-and-sandbox}"

agent_bin() { echo "codex"; }

# 新版 codex（实测 0.159）的 TUI 默认连一个全机共享的 app-server daemon，工具调用的 shell
# 在 **daemon 的进程环境**里跑，而不是 worker 自己的。daemon 由本机第一个起来的 codex 拉起——
# 常常是人手开的那个——于是 worker 的 GH_TOKEN / GH_TOKEN_FILE 全被丢掉，换成那个人的旧环境
# （tutor #981：review worker 的 gh 全用了已封号 luosky-bot 的 token，403 suspended）。
# 支持这个 flag 就一律 --no-daemon；老版本没有这个 flag 也就没有 daemon，传了反而报错。
codex_no_daemon_flag() {
    codex --help 2>/dev/null | grep -q -- '--no-daemon' && echo "--no-daemon"
    return 0
}

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

# busy 判据。关键字比 claude 那套通用得多（"running" 正文里也常出现），
# 所以 AGENT_BUSY_TAIL 保持默认 5 行的小窗口，别放宽。
AGENT_BUSY_RE='thinking|running|esc to interrupt'

agent_is_busy() {
    local sess="$1"
    session_alive "$sess" || return 1
    agent_pane_is_busy "$sess"
}

agent_command_new() {
    local cwd="$1"
    local name="$2"   # codex 没有 session 命名 flag；保留接口
    local prompt_file="$3"
    local model_arg
    model_arg="$(worker_model_arg)"
    printf 'codex %s %s %s "$(cat %s)"' \
        "$(codex_no_daemon_flag)" \
        "${CODEX_EXTRA_FLAGS:-}" \
        "$model_arg" \
        "$prompt_file"
}

agent_command_resume() {
    local cwd="$1"
    local name="$2"
    local prompt_file="$3"
    local model_arg
    model_arg="$(worker_model_arg)"
    # tmux 已在目标 worktree cwd 中启动；--last 会按 cwd 续接最近会话并直接注入 prompt。
    printf 'codex resume --last %s %s %s "$(cat %s)"' \
        "$(codex_no_daemon_flag)" \
        "${CODEX_EXTRA_FLAGS:-}" \
        "$model_arg" \
        "$prompt_file"
}
