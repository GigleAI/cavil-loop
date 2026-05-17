#!/usr/bin/env bash
# 看某个 worker session 的 pane 日志（dispatch 脚本通过 tmux pipe-pane 持续写入）。
#
# 用法：
#   scripts/session-log.sh <issue-N> [-f|--follow] [-c|--cat]
#
# 默认：打印日志文件绝对路径（方便 ls / less / 复制）。
#   -f / --follow   tail -F 跟随
#   -c / --cat      把整份日志倒到 stdout
#
# <issue-N> 可以是裸数字（issue 编号）或 PR fallback key（pr<N>）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --help / -h 在 source _lib.sh 之前先处理（不需要 config）
case "${1:-}" in
    -h|--help)
        sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
esac

# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

ISSUE="${1:?用法：session-log.sh <issue-N> [-f|--follow|-c|--cat]}"
MODE="path"
case "${2:-}" in
    "")                MODE="path" ;;
    -f|--follow)       MODE="follow" ;;
    -c|--cat)          MODE="cat" ;;
    *)
        echo "未知参数：$2（用 -f / -c / --help）" >&2
        exit 2
        ;;
esac

SESS="$(tmux_session_name "$ISSUE")"
LOG_PATH="$(session_log_path "$SESS")"

if [ -z "$LOG_PATH" ]; then
    echo "SESSION_LOG_DIR 已显式置空，pane 日志功能未启用" >&2
    echo "把它从 coding-agent.config 里去掉或设回 \$STATE_DIR/sessions 即可恢复" >&2
    exit 2
fi

case "$MODE" in
    path)
        echo "$LOG_PATH"
        if [ ! -f "$LOG_PATH" ]; then
            echo "（文件尚未存在；session 还没启动过或刚被启动）" >&2
        fi
        ;;
    cat)
        if [ ! -f "$LOG_PATH" ]; then
            echo "无日志：$LOG_PATH" >&2
            exit 1
        fi
        cat "$LOG_PATH"
        ;;
    follow)
        # tail -F：文件不存在时也会等待；session 重起 append 会被自动接上
        exec tail -n 200 -F "$LOG_PATH"
        ;;
esac
