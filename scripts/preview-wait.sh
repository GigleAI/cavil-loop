#!/usr/bin/env bash
# coding-agent-preview-app@<port>.service 的 ExecStartPost 就绪门。
#
# 轮询后端端口直到能 accept。ExecStartPost 返回前 start job 不算完成，
# 于是 After=app 的 proxy 不会在 node 还没 bind 时就开始转发（那样首访必 502）。
#
# 参数：$1 = 公开端口（= systemd instance name）
set -euo pipefail

PORT="${1:?need public port}"
CONF="$HOME/.config/coding-agent-work-loop/preview/${PORT}.conf"
# shellcheck disable=SC1090
source "$CONF"

BACKEND="${PREVIEW_BACKEND_PORT:?conf 缺 PREVIEW_BACKEND_PORT}"
DEADLINE=$(( $(date +%s) + ${PREVIEW_READY_TIMEOUT:-90} ))

# 用 bash 的 /dev/tcp 而不是 ss/curl：不依赖外部命令，且判的是「真能建连」
# 而非「端口出现在 listen 表里」——后者在 backlog 满 / 半初始化时会给假阳性。
while :; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$BACKEND") 2>/dev/null; then
        exec 3<&- 2>/dev/null || true
        exit 0
    fi
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        echo "preview :$PORT 后端 127.0.0.1:$BACKEND 在 ${PREVIEW_READY_TIMEOUT:-90}s 内没起来" >&2
        exit 1
    fi
    sleep 0.5
done
