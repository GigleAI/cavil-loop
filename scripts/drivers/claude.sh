#!/usr/bin/env bash
# Claude Code (claude CLI) driver。
#
# 文档：https://docs.claude.com/en/docs/claude-code
# 历史存放：~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
# Busy 探测：见下方 AGENT_BUSY_RE（认 spinner 行的形状，不认具体措辞）
# 新起：claude -n <name> [--session-id <uuid>] [extra-flags] [--model <model>] "<prompt>"
# 续接：claude --resume <uuid> | --continue [extra-flags] [--model <model>] "<prompt>"
#
# 配置开关：CLAUDE_EXTRA_FLAGS（推荐 "--dangerously-skip-permissions"，否则卡权限弹窗）

# 支持按 session id 隔离 worker / review 两个角色的会话（见 _common.sh 的契约）。
AGENT_SESSION_ISOLATION=1

agent_bin() { echo "claude"; }

# claude 的历史目录名 = cwd 绝对路径里**每一个非字母数字字符**都换成 '-'。
# 2026-09-18 在 claude 2.1.276 上实测：
#   /tmp/tmp.dkIFgXhOk6/wt/issue-7            -> -tmp-tmp-dkIFgXhOk6-wt-issue-7
#   /tmp/.../enc.test_dir.v1/sub dir          -> -tmp-...-enc-test-dir-v1-sub-dir
# 共享的 encoded_cwd 只换 '/'，对带 '.' '_' 空格的 worktree 路径会指到一个根本
# 不存在的目录 —— 于是「这个 cwd 有没有历史」永远答否，每次派工都新起一条会话，
# 上下文一声不响地丢掉。
claude_encoded_cwd() {
    printf %s "$1" | tr -c 'A-Za-z0-9' '-'
}

claude_session_dir() {
    echo "$HOME/.claude/projects/$(claude_encoded_cwd "$1")"
}

agent_has_history() {
    local cwd="$1"
    local dir
    dir="$(claude_session_dir "$cwd")"
    [ -d "$dir" ] && compgen -G "$dir/*.jsonl" > /dev/null 2>&1
}

# ── 会话隔离 ──
# claude 2.1.274 实测：
#   --session-id <uuid>  按指定 id 新建；**id 已存在会直接报错退出**，所以这里永远
#                        发随机 id，登记表才是权威，不去猜一个「算得出来」的 id。
#   --resume <uuid>      续那条；id 不存在报 No conversation found。
#   -n <name>            只是显示名，跟会话归属无关。
agent_session_new_id() {
    if command -v uuidgen > /dev/null 2>&1; then
        uuidgen | tr 'A-Z' 'a-z'
    elif [ -r /proc/sys/kernel/random/uuid ]; then
        cat /proc/sys/kernel/random/uuid
    else
        python3 -c 'import uuid; print(uuid.uuid4())'
    fi
}

agent_session_exists() {
    local cwd="$1" id="$2"
    [ -n "$id" ] && [ -f "$(claude_session_dir "$cwd")/${id}.jsonl" ]
}

# 历史文件名就是 session id；按 mtime 新→旧。
# （同目录下还有 memory/ 之类的子目录，所以只认 *.jsonl）
agent_session_list() {
    local cwd="$1" dir f
    dir="$(claude_session_dir "$cwd")"
    [ -d "$dir" ] || return 0
    compgen -G "$dir/*.jsonl" > /dev/null 2>&1 || return 0
    for f in $(ls -t "$dir"/*.jsonl 2>/dev/null); do
        basename "$f" .jsonl
    done
    return 0
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
    local model_arg flags
    model_arg="$(worker_model_arg)"
    flags="${CLAUDE_EXTRA_FLAGS:-}"
    # WORKER_SESSION_ID 由 agent_launch_command 设：钉住这条会话的 id，
    # 之后同角色再派工才认得回来（不钉的话只能靠「最近一条」猜，就会串角色）。
    # 拼进 flags 而不是单开一个 %s 槽位：没有 id 时命令行要跟改版前逐字节一致，
    # 免得下游按字符串比对的测试 / 日志因为多一个空格就对不上。
    if [ -n "${WORKER_SESSION_ID:-}" ]; then
        flags="$(printf -- '--session-id %q' "$WORKER_SESSION_ID") $flags"
    fi
    # name 含 / # 等需要 shell-quote（worker_session_name 现在用 GigleAI/repo#42 风格）
    printf 'claude -n %q %s %s "$(cat %s)"' \
        "$name" \
        "$flags" \
        "$model_arg" \
        "$prompt_file"
}

agent_command_resume() {
    local cwd="$1"   # 同上
    local name="$2"  # 未用：会话由 id / cwd 定位，不靠显示名
    local prompt_file="$3"
    local model_arg
    model_arg="$(worker_model_arg)"
    # 有 id 就续那一条。没有 id 只会出现在「本功能上线前留下的会话」这一种情况，
    # 那时才回落到 --continue（cwd 里最近的一条）。
    if [ -n "${WORKER_SESSION_ID:-}" ]; then
        printf 'claude --resume %q %s %s "$(cat %s)"' \
            "$WORKER_SESSION_ID" \
            "${CLAUDE_EXTRA_FLAGS:-}" \
            "$model_arg" \
            "$prompt_file"
        return 0
    fi
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
