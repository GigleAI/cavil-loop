#!/usr/bin/env bash
# worker 程序退出后、窗格关闭前，存下窗格的最后一屏（GitHub#738）。
#
# 用法（只由 _lib.sh 的 agent_exit_wrap 包进启动命令里调用，跑在 worker 窗格自己的 shell 里）：
#   agent-exit-screen.sh <这次启动的记号> <退出码记录路径> [会话日志路径；空 = 本项目关了会话日志]
#
# 为什么在这里抓：程序一退出，tmux 窗口就跟着关，之后谁都抓不到；而「会话不在 = worker 死了」是
# 自动恢复依赖的约定，不能为了抓屏让窗口留着。记退出码的那层壳正好跑在程序退出之后、窗口关闭之前。
#
# 写三样，都带这次启动的记号（daemon 只认记号对得上的，旧记录一律当不知道）：
#   <记录>.screen   第一行记号，后面是去掉令牌、去掉空行的最后一屏（只给识别规则读，不发到 GitHub）
#   <记录>.saved    「<记号> <结果>」，结果是下面之一——交人评论只按它说「存没存下」：
#     saved          最后一屏已追加进会话日志（写完读回核对文件确实变长了）
#     log-off        本项目关了会话日志：只存了 .screen
#     failed capture 抓屏失败（不在 tmux 里、tmux 调不起来）
#     failed redact  去令牌失败：什么都不留，宁可没有，不落原文
#     failed store   .screen 写不进
#     failed write   会话日志写不进
# 这个脚本自己出任何错都不影响程序的退出码（包装里 stdout / stderr 都丢掉，退出码另记）。
set -u

tok="${1:-}" rec="${2:-}" log="${3:-}"
[ -n "$tok" ] && [ -n "$rec" ] || exit 0
py="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/redact_tokens.py"

res="failed capture"
raw="" clean=""
done_() {
    printf '%s %s\n' "$tok" "$res" > "$rec.saved.tmp" 2>/dev/null && mv -f "$rec.saved.tmp" "$rec.saved" 2>/dev/null
    rm -f "$raw" "$clean" "$rec.screen.tmp" "$rec.saved.tmp" 2>/dev/null
    exit 0
}
raw="$(mktemp 2>/dev/null)" && clean="$(mktemp 2>/dev/null)" || done_

if [ -z "${TMUX_PANE:-}" ] || ! tmux capture-pane -J -p -t "$TMUX_PANE" -S -60 > "$raw" 2>/dev/null; then
    done_
fi
# 每一次都过替换脚本（不像 redact_pipe 那样先看有没有令牌前缀）：这里不在乎多起一次 python
if ! python3 "$py" filter < "$raw" > "$clean" 2>/dev/null; then
    res="failed redact"; done_
fi
: > "$raw"   # 原文不再需要
if ! { printf '%s\n' "$tok"; sed '/^[[:space:]]*$/d' "$clean"; } > "$rec.screen.tmp" 2>/dev/null || ! mv -f "$rec.screen.tmp" "$rec.screen" 2>/dev/null; then
    res="failed store"; done_
fi
if [ -z "$log" ]; then
    res="log-off"; done_
fi
res="failed write"
mkdir -p "$(dirname "$log")" 2>/dev/null
before=0
[ -e "$log" ] && { before="$(wc -c < "$log" 2>/dev/null | tr -d '[:space:]')" || done_; }
{
    printf '\n===== %s 程序退出（记号 %s），最后一屏 =====\n' "$(date -Iseconds)" "$tok"
    sed '/^[[:space:]]*$/d' "$clean"
} >> "$log" 2>/dev/null || done_
after="$(wc -c < "$log" 2>/dev/null | tr -d '[:space:]')" || done_
[[ "$before" =~ ^[0-9]+$ && "$after" =~ ^[0-9]+$ ]] && [ "$after" -gt "$before" ] && res=saved
done_
