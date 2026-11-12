#!/usr/bin/env bash
# 清理 codex 已有环境快照里的 GitHub 令牌（GitHub#342）。人工运行，daemon 不会自动调它。
#
# 背景：codex 每次启动把整份环境变量（含 GH_TOKEN）写进 ~/.codex/shell_snapshots/*.sh，
# 之后执行命令时读回。升级后 daemon 起的 codex worker 不再写快照（见 drivers/codex.sh），
# 但以前写下的还在。正在跑的 codex 还会读自己的快照——这时把令牌换掉，它后面的 gh 就全用
# 假令牌了。所以本脚本只在「本机当前用户没有任何 codex 进程」时才动手：
#   · 进程清单读不到、读出来是空的 → 拒绝（读不到不等于没有）
#   · 有 codex 进程 → 列出来、拒绝，一个文件都不动
#
# 用法：
#   bash scripts/redact-snapshots.sh            # 检查 + 替换
#   bash scripts/redact-snapshots.sh --check    # 只检查、只数，不改文件
#
# 替换方式和 daemon 的其他脱敏一样：令牌换成等长的 REDACTED-<指纹>，不删文件、不留备份。
# 退出码：0 = 完成（或 --check 时没有 codex 进程）；1 = 拒绝执行或出错。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_ONLY=0
case "${1:-}" in
    --check) CHECK_ONLY=1 ;;
    "") ;;
    *) echo "用法：bash scripts/redact-snapshots.sh [--check]" >&2; exit 1 ;;
esac

SNAP_DIR="${CODEX_HOME:-$HOME/.codex}/shell_snapshots"

# 本用户的 codex 进程（每行「进程号 命令行」）。读不到时返回 2。
# 认法偏宽：命令行前三个词里，有哪个的文件名是 codex / codex.js / codex-xxx 就算——
# 认多了只是拒绝执行，认少了才会出事。
codex_processes() {
    local out
    out="$(ps -u "$(id -u)" -o pid= -o args= 2>/dev/null)" || return 2
    [ -n "$out" ] || return 2
    printf '%s\n' "$out" | awk '{
        hit = 0
        for (i = 2; i <= NF && i <= 4; i++) {
            n = split($i, parts, "/"); base = parts[n]
            if (base == "codex" || base == "codex.js" || base ~ /^codex-/) hit = 1
        }
        if (hit) print
    }'
}

refuse_if_running() {
    local procs rc=0
    procs="$(codex_processes)" || rc=$?
    if [ "$rc" != 0 ]; then
        echo "❌ 读不到本机的进程清单（ps 失败或没有输出），无法确认 codex 是否在跑，没有改任何文件。" >&2
        exit 1
    fi
    if [ -n "$procs" ]; then
        echo "❌ 本机还有 codex 进程在跑，没有改任何文件。它们停掉以后再运行本脚本：" >&2
        printf '%s\n' "$procs" | cut -c1-160 | sed 's/^/     /' >&2
        exit 1
    fi
}

if [ ! -d "$SNAP_DIR" ]; then
    echo "没有快照目录 ${SNAP_DIR}，不需要清理。"
    exit 0
fi

refuse_if_running

files=()
while IFS= read -r f; do
    [ -n "$f" ] && files+=("$f")
done < <(find "$SNAP_DIR" -maxdepth 1 -type f -name '*.sh' 2>/dev/null | sort)

if [ "${#files[@]}" -eq 0 ]; then
    echo "$SNAP_DIR 里没有快照文件，不需要清理。"
    exit 0
fi

if [ "$CHECK_ONLY" = 1 ]; then
    echo "没有 codex 进程在跑；$SNAP_DIR 里有 ${#files[@]} 个快照文件。去掉 --check 再运行即可替换。"
    exit 0
fi

out="$(python3 "$SCRIPT_DIR/redact_tokens.py" files "${files[@]}")" || {
    echo "❌ 替换过程出错，部分文件可能没处理：$out" >&2
    exit 1
}
# 替换期间如果有 codex 起来了，它读到的可能是换过的快照：说出来，由人决定要不要重启它
late="$(codex_processes)" || late=""
changed="$(printf '%s' "$out" | sed -n 's/.* changed=\([0-9]*\) .*/\1/p')"
replaced="$(printf '%s' "$out" | sed -n 's/.* replaced=\([0-9]*\) .*/\1/p')"
echo "完成：${#files[@]} 个快照文件，其中 ${changed:-0} 个含令牌，共替换 ${replaced:-0} 处（指纹 ${out##*fingerprints=}）。"
if [ -n "$late" ]; then
    echo "⚠️ 替换期间有 codex 进程启动了，它可能读到已替换的旧快照；它的 gh 命令报认证错误时重启它：" >&2
    printf '%s\n' "$late" | cut -c1-160 | sed 's/^/     /' >&2
fi
exit 0
