#!/usr/bin/env bash
# 注销一个 preview：停 socket + proxy + app，解 tailscale 路由，删 conf。
#
# 用法：
#   bash scripts/preview-unserve.sh --issue <issue-number>
#   bash scripts/preview-unserve.sh <port>            直接给端口（cleanup hook 兜底用）
#
# 幂等：没注册过 / 已经停了都算成功，cleanup 路径上不会因为它失败而中断。
set -euo pipefail

CONF_DIR="$HOME/.config/coding-agent-work-loop/preview"

if [ "${1:-}" = "--issue" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck source=_lib.sh
    source "$SCRIPT_DIR/_lib.sh"
    ISSUE="${2:?need issue number}"
    PORT=$(( ${PREVIEW_PORT_BASE:-4000} + ISSUE ))
else
    PORT="${1:?need port（或 --issue <N>）}"
fi

# 停的顺序：socket 先停，掐掉新连接触发重启的可能；再停 proxy，
# app 靠 StopWhenUnneeded 自己跟着走（显式再停一次是兜底，幂等无害）。
systemctl --user stop "coding-agent-preview@${PORT}.socket"     2>/dev/null || true
systemctl --user stop "coding-agent-preview@${PORT}.service"    2>/dev/null || true
systemctl --user stop "coding-agent-preview-app@${PORT}.service" 2>/dev/null || true

if command -v tailscale >/dev/null 2>&1; then
    if tailscale serve status 2>/dev/null | grep -q ":${PORT}\b"; then
        # 解不掉无所谓：target 已死的路由自动 504，没有 leakage 风险。
        sudo -n tailscale serve --https="$PORT" off >/dev/null 2>&1 \
            || echo "  ⚠️ tailscale serve off :$PORT 失败（路由留着无害，target 已死会自动 504）" >&2
    fi
fi

rm -f "$CONF_DIR/${PORT}.conf"
echo "preview :$PORT 已注销"
