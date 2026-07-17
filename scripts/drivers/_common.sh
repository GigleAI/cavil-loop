#!/usr/bin/env bash
# drivers/_common.sh —— driver 加载器 + 给所有 driver 复用的工具函数。
# 由 _lib.sh source 进来；同时被 setup.sh 用于探测 worker 二进制名。

# ── Driver 接口契约 ──
# 每个 scripts/drivers/<name>.sh 必须实现下列五个函数：
#
#   agent_bin
#     stdout 写本 driver 对应的 CLI 可执行名。setup.sh 用它做 `command -v` 检查依赖、
#     以及把 worker 二进制所在目录拼进 systemd EnvironmentFile 的 PATH。
#
#   agent_has_history <cwd>
#     检查 cwd 是否有本 agent 的历史会话。返回 0 = 有；非 0 = 无。
#     dispatch 据此选 new vs resume 命令。
#
#   agent_is_busy <tmux_session>
#     检查 tmux session 里的 agent 是否正在 thinking / tool use。
#     返回 0 = busy；非 0 = idle / dead。
#     daemon 的并发计数现在用 GitHub doing/agent label 真值（见 _lib.sh:list_active_workers）
#     不依赖这个；agent_is_busy 仍被 cleanup-issue.sh 用——cleanup 前确认 worker 不在跑。
#
#   agent_command_new <cwd> <session_name> <prompt_file>
#     stdout 写一行 shell 命令字符串：在 cwd 起一个全新 session，
#     启动时把 prompt_file 内容作为初始 prompt 喂进 agent。
#     该字符串会作为 `tmux new-session -d -s <ts> -c <cwd> "<cmd>"` 的命令参数被 tmux
#     shell 求值，所以可放 `"$(cat $prompt_file)"` 之类的延迟展开。
#
#   agent_command_resume <cwd> <session_name> <prompt_file>
#     stdout 写一行 shell 命令字符串：在 cwd 续接已有会话，并注入新一段 prompt。
#     某些 agent 没有 resume 概念 → driver 可让该函数 fallback 到 agent_command_new。
#
# 可选 override：
#
#   agent_inject_prompt <tmux_session> <prompt_file>
#     向已运行的 session 注入新一段 prompt（用户在 issue/PR comment 后 daemon 调起）。
#     默认实现 `default_inject_prompt`：tmux load-buffer + paste-buffer -p + Enter。
#     对大多数 chat-REPL CLI 通用；个别 agent 需 slash-command 切模式可在 driver 里重写。

# ── 通用工具：encoded cwd ──
# Claude / OpenCode 都把 cwd 绝对路径里的 '/' 换成 '-' 作为本地历史目录名。
encoded_cwd() {
    printf %s "$1" | tr / -
}

# ── 默认 prompt 注入 ──
# 三阶段：dismiss 残留 modal → paste prompt + Enter → verify-and-retry
# 避免之前常踩的"prompt 进了输入框但没 submit、worker 卡 doing/agent 假在跑"。
#
# 失败模式有几种：
#   1. claude 弹了 rate-session "How is Claude doing this session?" modal，Enter 被弹窗吃 dismiss
#   2. claude permission prompt / approval popup 接 Enter
#   3. claude 刚启动还没 ready，paste 进了但 Enter 时机不对
#   4. paste 还在处理（bracketed-paste 进度），Enter 抢跑
#
# 兜底：注入后等 + tail pane 看是否进 busy 状态（footer 出现 "esc to interrupt"
# 表明 claude 在 streaming token = prompt 真 submit）；没进 busy 就补 Enter，最多
# 重试 N 次。
#
# 5. ⚠️ 自动 compaction / stop hook：worker 跑完超长 turn 后 context 顶满，
#    此刻恰是派工高峰。compaction 是分钟级阻塞操作——期间 footer 没有
#    "esc to interrupt"、Enter 只能排队、Escape 还会把 compaction 取消掉。
#    所以引入第三种 pane 状态 wait：检测到就"干等"（不发 Escape 不补 Enter），
#    等它消化完再走正常流程；只有真 idle 才快速失败。
default_inject_prompt() {
    local sess="$1"
    local prompt_file="$2"
    local buf

    # pane 三态：busy = turn 在跑（成功判据）；wait = compaction / stop hook 等
    # 分钟级中间态（别打扰）；idle = 真闲着（可以 Escape/Enter）。
    _inject_pane_state() {
        local t
        t=$(tmux capture-pane -t "=$sess" -p 2>/dev/null | tail -5)
        if grep -q "esc to interrupt" <<<"$t"; then echo busy
        elif grep -qiE "compacting|running stop hook" <<<"$t"; then echo wait
        else echo idle; fi
    }

    # 0. 若正处 compaction/stop-hook 中间态，先等它结束（默认最多 180s，可配）
    local max_wait="${INJECT_STATE_WAIT_SECS:-180}" waited=0 state
    while [ "$(_inject_pane_state)" = wait ] && [ "$waited" -lt "$max_wait" ]; do
        sleep 5; waited=$((waited + 5))
    done
    [ "$waited" -gt 0 ] && \
        echo "[default_inject_prompt] $sess 处于 compaction/stop-hook，等了 ${waited}s" >&2

    # 1. dismiss 可能拦着的 modal + 清输入框 —— 仅当真 idle 时
    #    （busy 时 Escape 会中断 thinking；wait 时 Escape 会取消 compaction）
    if [ "$(_inject_pane_state)" = idle ]; then
        tmux send-keys -t "$sess" Escape
        sleep 0.2
        tmux send-keys -t "$sess" Escape   # 第二下兜底 nested modal
        sleep 0.2
        # C-u 清空输入框：防 placeholder（claude idle 时偶尔留 advisory 字串如
        # "<suggestion skipped: awaiting ...>" 显示在输入框、撑住后续 Enter 不 submit）
        # 或上次注入残留 paste 没成功的内容
        tmux send-keys -t "$sess" C-u
        sleep 0.2
    fi

    # 2. paste prompt（bracketed paste 让 claude 当一段而不是逐行）
    buf=$(mktemp)
    cat "$prompt_file" > "$buf"
    tmux load-buffer -t "$sess" "$buf"
    rm -f "$buf"
    tmux paste-buffer -t "$sess" -p
    sleep 0.5   # 给 claude UI 处理 paste 的时间，防 Enter 抢跑

    tmux send-keys -t "$sess" Enter

    # 3. verify：busy = 成功；wait = submit 触发了 pre-turn compaction，干等
    #    （消化完排队的 prompt 会自动开跑）；idle = 没 submit 上，补 Enter 最多 5 次
    local retries=0
    waited=0
    while :; do
        sleep 2
        state="$(_inject_pane_state)"
        case "$state" in
            busy) return 0 ;;
            wait)
                waited=$((waited + 2))
                if [ "$waited" -ge "$max_wait" ]; then
                    echo "[default_inject_prompt] WARN: $sess compaction 等待超 ${max_wait}s 未结束" >&2
                    break
                fi
                ;;
            idle)
                retries=$((retries + 1))
                [ "$retries" -ge 5 ] && break
                # 没进 busy → prompt 还卡输入框 / Enter 被某个 modal 吃了 → 补 Enter
                tmux send-keys -t "$sess" Enter
                ;;
        esac
    done

    echo "[default_inject_prompt] WARN: $sess 仍未进 busy（idle 重试 $retries 次）；prompt 可能仍卡输入框" >&2
    echo "[default_inject_prompt]       手动检查：tmux capture-pane -t $sess -p | tail -20" >&2
    return 1
}

# ── 加载 driver ──
# 查找顺序（高 → 低）：
#   1. $PROJECT_ROOT/.agents/skills/coding-agent-work-loop/drivers/<name>.sh  ← 项目自定义
#   2. <skill>/scripts/drivers/<name>.sh                                     ← 内置
# 项目级 override 让用户不 fork 整个 skill 也能加自家 driver。
source_driver() {
    local name="$1"
    local self_dir
    self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local candidates=(
        "${PROJECT_ROOT:-}/.agents/skills/coding-agent-work-loop/drivers/${name}.sh"
        "${self_dir}/${name}.sh"
    )
    local d
    for d in "${candidates[@]}"; do
        if [ -f "$d" ]; then
            # shellcheck disable=SC1090
            source "$d"
            # driver 没自己 override 注入 → 用默认
            if ! declare -f agent_inject_prompt > /dev/null; then
                agent_inject_prompt() { default_inject_prompt "$@"; }
            fi
            # 强制校验必填函数都在
            local fn
            for fn in agent_bin agent_has_history agent_is_busy \
                      agent_command_new agent_command_resume; do
                if ! declare -f "$fn" > /dev/null; then
                    echo "[coding-agent] ERROR: driver '$name' 缺少函数 $fn ($d)" >&2
                    return 1
                fi
            done
            return 0
        fi
    done
    echo "[coding-agent] ERROR: 找不到 driver '$name'" >&2
    echo "  内置 driver 在 $self_dir/" >&2
    echo "  项目级 driver 路径：\$PROJECT_ROOT/.agents/skills/coding-agent-work-loop/drivers/<name>.sh" >&2
    return 1
}
