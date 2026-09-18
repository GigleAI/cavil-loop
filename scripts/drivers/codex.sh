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
# session_meta 在文件第一行，带 cwd 和 session_id（0.155.0 实测）。
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
        head -1 "$f" 2>/dev/null | grep -qF "\"cwd\":\"$cwd\"" || continue
        id="$(codex_rollout_id "$f")" || continue
        echo "$id"
    done
    # head 提前关掉管道时上游会吃到 SIGPIPE(141)，调用方又开着 pipefail，
    # 不显式收口的话「列会话」会变成一次派工失败。
    return 0
}

agent_session_exists() {
    local cwd="$1" id="$2"
    [ -n "$id" ] || return 1
    local d
    while IFS= read -r d; do
        if [ -n "$(find "$d" -name "rollout-*-${id}.jsonl" -type f -print -quit 2>/dev/null)" ]; then
            return 0
        fi
    done < <(codex_session_dirs)
    return 1
}

# codex 0.155.0 启动侧没有任何指定 session id / 名字的 flag（`codex --help` 全量核对过），
# 只有 `codex resume <id|name>` 能按 id 续。所以这里写空串，由 daemon 在起完 tmux 之后
# 用 agent_session_list 回捞本次真正用上的 id（实测落盘延迟约 0.5s）。
agent_session_new_id() { echo ""; }

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
    printf 'codex %s %s "$(cat %s)"' \
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
        printf 'codex resume %q %s %s "$(cat %s)"' \
            "$WORKER_SESSION_ID" \
            "${CODEX_EXTRA_FLAGS:-}" \
            "$model_arg" \
            "$prompt_file"
        return 0
    fi
    # tmux 已在目标 worktree cwd 中启动；--last 会按 cwd 续接最近会话并直接注入 prompt。
    printf 'codex resume --last %s %s "$(cat %s)"' \
        "${CODEX_EXTRA_FLAGS:-}" \
        "$model_arg" \
        "$prompt_file"
}
