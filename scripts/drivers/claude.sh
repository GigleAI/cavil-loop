#!/usr/bin/env bash
# Claude Code (claude CLI) driver。
#
# 文档：https://docs.claude.com/en/docs/claude-code
# 历史存放：~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
# Busy 探测：见下方 AGENT_BUSY_RE（认 spinner 行的形状，不认具体措辞）
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

# busy 判据。2026-07-29 实测 claude 2.1.220：
#   ✻ Waddling… (22m 31s · ↓ 30.4k tokens)     纯 thinking
#   * Wrangling… (20m 21s · ↓ 16.3k tokens)    glyph 不固定（✻ ✽ ✶ ✢ *，别指望它）
#   ⎿  Running… (4m 33s · timeout 10m)         工具执行中
# 老版本才是 "(5s · esc to interrupt)"——那个字串在 2.1.x 的 pane 里**整屏 0 命中**，
# 于是 busy 探测自 2026-07-10 起再没成功过一次（poll.log 里「agent 正在忙」最后
# 出现就是那天）。所以改认「省略号 + 括号 + 时长」这个跨版本稳定的形状，
# 同时保留旧字串向后兼容。
AGENT_BUSY_RE='esc to interrupt|…[[:space:]]*\([0-9]+[hms]'
# spinner 实测稳定落在倒数第 8 行（下面还有输入框 + 两行 footer），老的 tail -5
# 刚好够不着。给到 20 留余量；idle pane 整屏 0 命中，放宽不会引入误判。
AGENT_BUSY_TAIL=20

agent_is_busy() {
    local sess="$1"
    session_alive "$sess" || return 1
    agent_pane_is_busy "$sess"
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
