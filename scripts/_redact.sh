#!/usr/bin/env bash
# 令牌脱敏的 shell 入口（GitHub#342）。匹配规则全在 redact_tokens.py，这里只管「怎么接」。
#
# daemon 往 poll.log / 窗格历史里追加任何「不是自己写死的文字」之前，都先过这里：
#   命令输出 | redact_pipe   | tee -a "$LOG_FILE"      # 小段文字（日志行、截屏、钩子输出）
#   redact_stream < 旧日志  >> 新日志                   # 整个文件，边读边写
# 两个都保证：替换脚本起不来 / 中途出错时，不把原文写出去，只留一行说明。
#
# 由 _lib.sh 和 migrate-legacy.sh source（后者不加载项目配置，所以单独成文件）。

_REDACT_PY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/redact_tokens.py"

# stdin → stdout。先整段读进来：里面没有令牌前缀（绝大多数情况）就原样写出，不起 python。
# 输出为空时什么都不写；非空时以一个换行结束。
redact_pipe() {
    local data out rc=0
    data="$(cat)"
    [ -n "$data" ] || return 0
    case "$data" in
        *gh[pousr]_*|*github_pat_*)
            out="$(printf '%s' "$data" | python3 "$_REDACT_PY" filter 2>/dev/null)" || rc=$?
            if [ "$rc" != 0 ]; then
                printf '[令牌替换失败（退出码 %s），这段输出已丢弃，共 %s 字节]\n' "$rc" "${#data}"
            else
                printf '%s\n' "$out"
            fi ;;
        *) printf '%s\n' "$data" ;;
    esac
    return 0
}

# stdin → stdout，边读边写（大文件用）。出错时已经写出的部分是替换过的，剩下的丢弃。
redact_stream() {
    local rc=0 n
    python3 "$_REDACT_PY" filter 2>/dev/null || rc=$?
    if [ "$rc" != 0 ]; then
        n="$(wc -c 2>/dev/null | tr -d '[:space:]')"
        printf '[令牌替换失败（退出码 %s），其余内容已丢弃，至少 %s 字节]\n' "$rc" "${n:-0}"
    fi
    return 0
}

# 窗格历史的实时过滤：tmux pipe-pane 用的命令串。过滤进程起不来 / 退出后，后面的窗格输出
# 就不再进历史文件——宁可缺记录，不落原文。
redact_pane_pipe_cmd() {   # <日志路径>
    printf "exec python3 '%s' filter >> '%s'" "$_REDACT_PY" "$1"
}
