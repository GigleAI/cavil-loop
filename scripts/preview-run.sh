#!/usr/bin/env bash
# coding-agent-preview-app@<port>.service 的 ExecStart wrapper。
#
# 存在的唯一理由：unit 文件里 `WorkingDirectory=` 不展开 ${VAR}，而每个 preview 的
# worktree 路径只有注册时才知道。顺手把「app 必须听后端端口而不是公开端口」这条
# 也固定在这里，免得每个项目的 PREVIEW_EXEC 各写各的。
#
# 参数：$1 = 公开端口（= systemd instance name）
set -euo pipefail

PORT="${1:?need public port}"
CONF="$HOME/.config/coding-agent-work-loop/preview/${PORT}.conf"

[ -f "$CONF" ] || { echo "preview conf 不存在：$CONF（先跑 preview-serve.sh <issue>）" >&2; exit 2; }
# shellcheck disable=SC1090
source "$CONF"

: "${PREVIEW_WORKTREE:?conf 缺 PREVIEW_WORKTREE}"
: "${PREVIEW_BACKEND_PORT:?conf 缺 PREVIEW_BACKEND_PORT}"
: "${PREVIEW_EXEC:?conf 缺 PREVIEW_EXEC}"

# worktree 可能已被 cleanup 删掉（issue close 了但 socket 还没注销）。
# 这里直接失败，比 cd 失败后在 / 下起一个乱七八糟的 server 好。
[ -d "$PREVIEW_WORKTREE" ] || {
    echo "worktree 不存在：$PREVIEW_WORKTREE —— 该 preview 已过期，跑 preview-unserve.sh $PORT 注销" >&2
    exit 3
}
cd "$PREVIEW_WORKTREE"

# app 听 **后端**端口：公开端口被 .socket 占着，app 再 bind 会 EADDRINUSE。
# HOST 锁 127.0.0.1，对外只经 proxy / tailscale serve。
exec env PORT="$PREVIEW_BACKEND_PORT" HOST=127.0.0.1 sh -c "exec $PREVIEW_EXEC"
