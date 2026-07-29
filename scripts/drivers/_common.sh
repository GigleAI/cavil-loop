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

# 单次 dispatch 可通过 WORKER_MODEL 指定模型。返回 shell-quoted CLI 片段，
# 供支持 `--model` 的 driver 拼进 new / resume 命令；空值表示沿用 agent 默认模型。
worker_model_arg() {
    [ -n "${WORKER_MODEL:-}" ] || return 0
    printf -- '--model %q' "$WORKER_MODEL"
}

# ── busy 判据：单一来源 ──
# 以前 agent_is_busy（每个 driver 一份）和 default_inject_prompt 的状态机各写各的
# capture-pane，结果是 inject 那份写死了 claude 的关键字、对别的 driver 一律失效，
# 而且两边窗口大小能各自漂移。统一到这里，driver 只覆盖两个变量。
#
# ⚠️ capture-pane 收的是 **target-pane**，跟 target-session / target-window 语法不同：
# 它 **不支持** "=" 精确匹配前缀。写成 -t "=$sess" 在 tmux 3.4 上直接
# `can't find pane: =xxx` 恒失败 → 读到空串 → 状态机短路成恒 idle，
# 于是「注入后验证是否进 busy」永远不成立、每次派工都误判失败并杀掉活着的会话。
# 这里只能用裸 "$sess"。
AGENT_BUSY_RE="${AGENT_BUSY_RE:-esc to interrupt|…[[:space:]]*\([0-9]+[hms]}"
# 看 pane 末尾多少行。默认 5（footer 区，防 scrollback 历史误判）；
# 关键字越通用的 driver 越该保持小窗口，spinner 离底远的 driver 自行放大。
AGENT_BUSY_TAIL="${AGENT_BUSY_TAIL:-5}"

# pane 上出现「模态框」的特征。踩过的坑见 default_inject_prompt 第 1 步：
# 在 modal 里 paste 会灌进它的筛选框、Enter 的语义是「确认执行」而不是「提交 prompt」。
AGENT_MODAL_RE="${AGENT_MODAL_RE:-Esc to cancel|Enter to continue}"

agent_pane_tail() {
    tmux capture-pane -t "$1" -p 2>/dev/null | tail -"${AGENT_BUSY_TAIL}"
}

# 返回 0 = pane 呈现 busy 形态。不查 session 是否存在（调用方各自兜底）。
agent_pane_is_busy() {
    # -i：codex/opencode/cursor 原本就是 grep -qiE，保持不变；对 claude 那条无害
    agent_pane_tail "$1" | grep -qiE "$AGENT_BUSY_RE"
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
# 兜底：注入后等 + tail pane 看是否进 busy 状态（spinner 行在转 = prompt 真 submit，
# 判据见上方 AGENT_BUSY_RE）；没进 busy 就补 Enter，最多重试 N 次。
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

    # pane 四态：modal = 有模态框挡着（**绝不能 paste / Enter**）；busy = turn 在跑
    # （成功判据）；wait = compaction / stop hook 等分钟级中间态（别打扰）；
    # idle = 真闲着，可以清输入框然后灌 prompt。
    _inject_pane_state() {
        local t
        t=$(agent_pane_tail "$sess")
        # modal 判在最前：它比其余三种都更危险，误判成 idle 就会往弹窗里敲 Enter。
        if grep -qiE "$AGENT_MODAL_RE" <<<"$t"; then echo modal
        # wait 先于 busy 判：compaction 期间 spinner 同样在转，若先判 busy 会把
        # 「还在压缩、prompt 只是排队」误当成注入成功（c84e235 要修的正是这个）。
        elif grep -qiE "compacting|running stop hook" <<<"$t"; then echo wait
        elif grep -qiE "$AGENT_BUSY_RE" <<<"$t"; then echo busy
        else echo idle; fi
    }

    # 0. 若正处 compaction/stop-hook 中间态，先等它结束（默认最多 180s，可配）
    local max_wait="${INJECT_STATE_WAIT_SECS:-180}" waited=0 state
    while [ "$(_inject_pane_state)" = wait ] && [ "$waited" -lt "$max_wait" ]; do
        sleep 5; waited=$((waited + 5))
    done
    [ "$waited" -gt 0 ] && \
        echo "[default_inject_prompt] $sess 处于 compaction/stop-hook，等了 ${waited}s" >&2

    # 1. 退出挡路的 modal —— Escape 是安全的（实测对 idle pane 是 no-op）
    local mtries=0
    while [ "$(_inject_pane_state)" = modal ] && [ "$mtries" -lt 3 ]; do
        tmux send-keys -t "$sess" Escape
        sleep 0.5
        mtries=$((mtries + 1))
    done
    if [ "$(_inject_pane_state)" = modal ]; then
        echo "[default_inject_prompt] $sess 卡在 modal，Escape ${mtries} 次退不出 → 放弃注入，交给 fallback resume" >&2
        return 1
    fi

    # 1b. 清输入框 —— 仅当真 idle 时（busy 时按键会打断 thinking；wait 时会搅乱 compaction）
    #
    # ⚠️⚠️ 千万别用 C-u。历史上这里是 `send-keys C-u`，注释写着"清空输入框"——那是旧版
    # claude 的键位。**claude 2.1.220 把 Ctrl+U 绑成了 rewind / checkpoint 选择器**，
    # 按下去直接弹出「Enter to continue · Esc to cancel」的模态框。后果是整条注入链报废：
    # paste 灌进弹窗的筛选框、pane 永远等不到 spinner（状态机没判错，是我们把它推进去的）、
    # 5 次补 Enter 全喂给弹窗——而那里 Enter 的语义是「确认执行回滚」。tutor 上实测
    # 修好 busy 探测后失败率仍有 91%（10/11），根因就是这一个键。
    # 2026-07-29 在真 pane 上逐个试过：Escape 清不掉内容；C-w 只删一个词；
    # **C-a + C-k**（回行首 + 删到行尾）能清干净、空框重复按也安全、不弹任何窗。
    if [ "$(_inject_pane_state)" = idle ]; then
        tmux send-keys -t "$sess" C-a
        sleep 0.2
        tmux send-keys -t "$sess" C-k
        sleep 0.2
    fi

    # 2. paste prompt（bracketed paste 让 claude 当一段而不是逐行）
    buf=$(mktemp)
    cat "$prompt_file" > "$buf"
    tmux load-buffer -t "$sess" "$buf"
    rm -f "$buf"
    tmux paste-buffer -t "$sess" -p
    sleep 0.5   # 给 claude UI 处理 paste 的时间，防 Enter 抢跑

    # paste 本身也可能把 UI 带进 modal（内容被当成命令 / 筛选词）。发 Enter 前必须再确认一次：
    # 在 rewind 选择器里 Enter 是「确认回滚」，敲下去可能把 worker 已经做完的工作抹掉。
    if [ "$(_inject_pane_state)" = modal ]; then
        echo "[default_inject_prompt] $sess paste 后进入 modal，拒绝发 Enter（避免误触 rewind）→ 交给 fallback resume" >&2
        tmux send-keys -t "$sess" Escape
        return 1
    fi

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
            modal)
                # 补 Enter 的过程中弹窗跳出来了：立刻停手退出，绝不能继续敲。
                echo "[default_inject_prompt] WARN: $sess 补 Enter 期间出现 modal → 停止重试并 Escape 退出" >&2
                tmux send-keys -t "$sess" Escape
                break
                ;;
            idle)
                # 短 turn 的假阴性：prompt 提交出去了、claude 秒答完，等我们 2s 后第一次
                # 采样时 spinner 早没了 → 一路重试到放弃 → daemon 杀掉刚干完活的会话。
                # 判据：输入框空了 = prompt 已经离开输入框被 submit 掉（没提交上去的话
                # 内容还躺在 ❯ 那一行）。2026-07-29 实测，"请只回复 OK" 这种 4s 就跑完的
                # turn 正是这样被误判成失败的。
                # 两个坑都踩过，别改回去：
                #   1. 取**最后**一个 ❯。提交出去的消息在 pane 上同样以 ❯ 回显，
                #      grep -m1 会抓到那条回显（内容非空）而不是真正的输入框。
                #   2. 空输入框的占位是 **U+00A0 不换行空格**（字节 c2 a0），不是普通空格。
                #      C locale 下 [[:space:]] 不认它，不显式清掉就永远判「非空」。
                local _box
                _box=$(agent_pane_tail "$sess" | grep '❯' | tail -1 | sed 's/.*❯//; s/\xc2\xa0//g' | tr -d '[:space:]')
                if [ -z "$_box" ]; then
                    return 0
                fi
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
