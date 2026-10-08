#!/usr/bin/env bash
# Codex CLI (OpenAI codex) driver —— 首版适配，请按你本机 codex 版本核对后微调。
#
# 文档：https://github.com/openai/codex
#
# 历史存放：$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<uuid>.jsonl
#           （0.155.0 实测；老版本可能平铺在 sessions/ 或 history/ 下）
# Busy 探测：codex 在 thinking / running tool 时 footer 出现 "thinking" / "running"
# 新起：codex [--model <model>] "<prompt>"
# 续接：codex resume <session-id> | --last [--model <model>] "<prompt>"
#
# 配置开关：CODEX_EXTRA_FLAGS。未设置时默认跳过确认并关闭 Codex sandbox；
# 显式设为空字符串可关闭该默认值。

CODEX_EXTRA_FLAGS="${CODEX_EXTRA_FLAGS---dangerously-bypass-approvals-and-sandbox}"

# 支持按 session id 隔离 worker / review 两个角色的会话（见 _common.sh 的契约）。
AGENT_SESSION_ISOLATION=1

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

codex_session_dirs() {
    local home="${CODEX_HOME:-$HOME/.codex}"
    local d
    for d in ${CODEX_HISTORY_DIRS:-} "$home/sessions" "$home/history"; do
        [ -n "$d" ] && [ -d "$d" ] && echo "$d"
    done
}

# rollout 文件名尾部 36 个字符就是 session id（uuid）。
codex_rollout_id() {
    local b="${1##*/}"
    b="${b%.jsonl}"
    [ "${#b}" -ge 36 ] || return 1
    echo "${b: -36}"
}

# 这个 cwd 的会话 id，最近的在前。
#
# ⚠️ 必须按 cwd 过滤。改版前的 agent_has_history 只看「~/.codex 下有没有任何文件」，
# 于是任何一台跑过 codex 的机器都会被判成「本 worktree 有历史」→ 一律 resume --last，
# 而 --last 取的是这个 cwd 最近的一条，角色是谁全看运气。
#
# session_meta 在文件第一行，带 cwd 和 session_id（0.155.0 / 0.161.0 实测）。
# 路径里嵌了 ISO 时间戳，所以反向字典序 = 从新到旧，不依赖 GNU find 的 -printf。
# 只扫最近 CODEX_SESSION_SCAN_MAX 个：本机就有 1000+ 个 rollout，全扫一遍要读 1000 次
# 文件头，而我们要找的会话永远在最近几条里。
agent_session_list() {
    local cwd="$1"
    local max="${CODEX_SESSION_SCAN_MAX:-200}"
    local d f id
    while IFS= read -r d; do
        find "$d" -name 'rollout-*.jsonl' -type f 2>/dev/null
    done < <(codex_session_dirs) | sort -r | head -n "$max" | \
    while IFS= read -r f; do
        # 用 jq 解出 cwd 再精确比对，而不是在原始行上 grep 字符串。实测两者耗时一样
        # （200 个文件各 0.4s，开销全在 fork 上），但 grep 版依赖 codex 写紧凑 JSON：
        # 哪天它多打一个空格，cwd 过滤就静默失效——这个 PR 已经被「靠形状猜」坑够多次了。
        [ "$(head -1 "$f" 2>/dev/null | jq -r '.payload.cwd // empty' 2>/dev/null)" = "$cwd" ] \
            || continue
        id="$(codex_rollout_id "$f")" || continue
        echo "$id"
    done
    # head 提前关掉管道时上游会吃到 SIGPIPE(141)，调用方又开着 pipefail，
    # 不显式收口的话「列会话」会变成一次派工失败。
    return 0
}

# 给一个 session id 找到它的 rollout 文件路径（找不到就输出空）。
codex_rollout_path() {   # <session_id>
    local id="$1" d hit
    [ -n "$id" ] || return 0
    while IFS= read -r d; do
        # 用 `| head -1` 而不是 `-print -quit`：-quit 是 GNU find 的扩展，本机只有
        # Linux、没法验 macOS/BSD，而 head 关管道一样能让 find 早退，还到处都有。
        hit="$(find "$d" -name "rollout-*-${id}.jsonl" -type f 2>/dev/null | head -1)"
        if [ -n "$hit" ]; then
            echo "$hit"
            return 0
        fi
    done < <(codex_session_dirs)
    return 0
}

agent_session_exists() {
    local cwd="$1" id="$2"
    [ -n "$id" ] || return 1
    [ -n "$(codex_rollout_path "$id")" ]
}

# 本 driver 能举证「某条会话是不是本次启动建的」。
AGENT_SESSION_PROOF=1

# 证据：这条会话的**启动输入**里带着本次启动的标记（或与本次 prompt 完整一致）。
#
# 「启动输入」= 第一条 assistant 回复**之前**的所有 user 消息。0.161.0 在真实 rollout
# 上实测的事件顺序是：
#   session_meta → developer×3（skills / 多 agent 说明）→ user(AGENTS.md 指令, 30k 字)
#   → user(派工 prompt) → assistant → …
# 所以「第一条 user 消息」根本不是派工 prompt，而是仓库指令那条。
#
# 四件事都踩过，别再改回去：
#   1. 「本次启动后才出现的文件」**不是**证据。别的角色回捞超时之后，它那条会话的文件
#      可能比我们自己的先落盘，于是「新出现」就把别人的会话算成了我们的。
#   2. 不能只看第一条 user 消息。前面那条仓库指令没有我们的标记，于是正确的任务消息
#      还没被看到就先判了 false —— 自己的会话永远认不出来，每轮从零起。
#   3. 不能用 `jq … | head -1` 取文本。jq 把多行文本按行吐出来，只会拿到第一行；
#      这里的模板全是多行。改成在 jq 里把整条消息拼好再比。
#   4. 不能只比前缀。项目覆写的两个模板共享很长的开头时，别的角色的会话会被认成自己的。
#
# 边界也不能放宽成「整段对话里搜一遍」：标记如果只出现在后续追加的消息里（比如下一次
# 派工把 prompt 注入到同一条会话），那条会话并不是本次启动建的。只认第一条 assistant
# 之前的输入，这个边界在真实 rollout 上验证过。
agent_session_started_with() {   # <cwd> <session_id> <prompt_file>
    local id="$2" prompt_file="${3:-}"
    [ -n "$id" ] && [ -n "$prompt_file" ] && [ -f "$prompt_file" ] || return 1
    local f tag verdict
    f="$(codex_rollout_path "$id")"
    [ -n "$f" ] || return 1
    tag="$(agent_session_prompt_tag "$prompt_file")"
    verdict="$(jq -s -c --arg tag "$tag" --rawfile want "$prompt_file" '
        (map(.payload.role? == "assistant") | index(true)) as $stop
        | (if $stop == null then . else .[0:$stop] end)
        | map(select(.payload.role? == "user")
              | [.payload.content[]? | select(.type == "input_text") | .text] | join(""))
        | if ($tag | length) > 0
          then any(.[]; index($tag) != null)
          else any(.[]; (. | sub("\\s+$"; "")) == ($want | sub("\\s+$"; "")))
          end' "$f" 2>/dev/null)"
    [ "$verdict" = "true" ]
}

agent_has_history() {
    local cwd="$1"
    [ -n "$(agent_session_list "$cwd" | head -1)" ]
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
    # 有 id 就续那一条（实测 `codex resume <id>` 会把新一轮追加进同一个 rollout 文件）。
    # 没 id 只会出现在「本功能上线前留下的会话」这一种情况，那时才回落到 --last
    # ——它取的是这个 cwd 最近的一条，分不清角色。
    if [ -n "${WORKER_SESSION_ID:-}" ]; then
        printf 'codex resume %q %s %s %s "$(cat %s)"' \
            "$WORKER_SESSION_ID" \
            "$(codex_no_daemon_flag)" \
            "${CODEX_EXTRA_FLAGS:-}" \
            "$model_arg" \
            "$prompt_file"
        return 0
    fi
    # tmux 已在目标 worktree cwd 中启动；--last 会按 cwd 续接最近会话并直接注入 prompt。
    printf 'codex resume --last %s %s %s "$(cat %s)"' \
        "$(codex_no_daemon_flag)" \
        "${CODEX_EXTRA_FLAGS:-}" \
        "$model_arg" \
        "$prompt_file"
}
