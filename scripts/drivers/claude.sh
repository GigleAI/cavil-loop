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

# ── 可选 hook：预先信任目录 ──
# worker 第一次在一个 claude 没见过的目录里起会话时，会弹：
#   "Quick safety check: Is this a project you created or one you trust?"
# **`--dangerously-skip-permissions` 不绕过它**（2.1.273 实测）。后果比秒退更难查：
# session 活着、dispatch 的秒退探测放行、issue 照常翻成 doing/agent，
# 但 worker 就挂在弹窗上一动不动——看日志一切正常，非 attach 进去不可能发现。
#
# 信任记录在 ~/.claude.json 的 projects["<绝对路径>"].hasTrustDialogAccepted。
# 子目录从祖先继承，所以只写「仓库根 + worktree base」两条就够，每个 issue 的
# worktree 不用单独加（2026-09-16 在 luosky/ai-hub 上实测：issue-1 的 worktree
# 自己没有条目，照样跑起来了）。
agent_trust_paths() {
    local cfg="${CLAUDE_JSON_PATH:-$HOME/.claude.json}"
    [ "$#" -gt 0 ] || return 0

    # 已经全信任就一个字节都不写。这个文件是活着的 claude 进程在用的，
    # 每多改写一次就多一次跟它抢写、把它刚写的东西盖掉的机会。
    local p need=0
    for p in "$@"; do
        jq -e --arg p "$p" '.projects[$p].hasTrustDialogAccepted == true' \
            "$cfg" >/dev/null 2>&1 || need=1
    done
    [ "$need" = 1 ] || return 0

    [ -f "$cfg" ] || echo '{}' > "$cfg"

    local paths_json tmp
    paths_json="$(printf '%s\n' "$@" | jq -Rn '[inputs]')" || return 1
    # tmp 跟 cfg 同目录：mv 才是同文件系统内的原子替换，不会半截文件落地
    tmp="$(mktemp "${cfg}.XXXXXX")" || return 1
    if jq --argjson paths "$paths_json" '
            reduce $paths[] as $p (.;
                .projects[$p].hasTrustDialogAccepted = true
              | .projects[$p].allowedTools = (.projects[$p].allowedTools // [])
            )' "$cfg" > "$tmp" \
       && jq -e 'has("projects")' "$tmp" >/dev/null 2>&1; then
        mv "$tmp" "$cfg"
        return 0
    fi
    # 读不动 / 不是合法 JSON：原文件一个字节都不动，宁可让人去点那个弹窗
    rm -f "$tmp"
    echo "[claude driver] WARN: 写不了 $cfg，worker 首次进新目录可能卡 trust 弹窗" >&2
    return 1
}
