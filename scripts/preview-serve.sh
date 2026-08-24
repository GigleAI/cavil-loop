#!/usr/bin/env bash
# 注册并起一个按需 preview（systemd socket 激活）。
#
# 用法：
#   bash scripts/preview-serve.sh <issue-number>          注册 + 起监听，打印 URL
#   bash scripts/preview-serve.sh <issue-number> --warm   顺便立刻把 app 拉起来（预热）
#   bash scripts/preview-serve.sh <issue-number> --restart 重新 build 之后用：停掉旧进程，
#                                                         让下次访问加载新产物
#   bash scripts/preview-serve.sh --list                  列出本项目所有已注册 preview
#
# 跟旧的「tmux 起一个常驻 node」相比，变化只有一处：**进程闲置 PREVIEW_IDLE 后自己退出**，
# 下次有人访问那个端口时由 systemd 重新拉起（冷启 ~1s，dist 已经 build 好，不重新 build）。
# URL 本身永远有效 —— 监听的是 .socket，不是 app 进程。
#
# 前置：setup.sh 装过 coding-agent-preview*@ 三个 unit。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

PREVIEW_PORT_BASE="${PREVIEW_PORT_BASE:-4000}"
PREVIEW_BACKEND_OFFSET="${PREVIEW_BACKEND_OFFSET:-10000}"
PREVIEW_IDLE="${PREVIEW_IDLE:-30min}"
PREVIEW_EXEC="${PREVIEW_EXEC:-}"
PREVIEW_READY_TIMEOUT="${PREVIEW_READY_TIMEOUT:-90}"
PREVIEW_TAILSCALE_SERVE="${PREVIEW_TAILSCALE_SERVE:-false}"
PREVIEW_URL_HOST="${PREVIEW_URL_HOST:-}"

CONF_DIR="$HOME/.config/coding-agent-work-loop/preview"
UNIT_DIR="$HOME/.config/systemd/user"

# ── --list ──
if [ "${1:-}" = "--list" ]; then
    shopt -s nullglob
    found=0
    for f in "$CONF_DIR"/*.conf; do
        # shellcheck disable=SC1090
        ( source "$f"
          [ "${PREVIEW_PROJECT:-}" = "$TMUX_PREFIX" ] || exit 0
          state=$(systemctl --user is-active "coding-agent-preview-app@${PREVIEW_PORT}.service" 2>/dev/null || true)
          printf 'issue #%-5s :%-6s %-10s %s\n' \
              "$PREVIEW_ISSUE" "$PREVIEW_PORT" "${state:-unknown}" "$PREVIEW_WORKTREE" )
        found=1
    done
    [ "$found" = 0 ] && echo "（$TMUX_PREFIX 没有已注册的 preview）"
    exit 0
fi

ISSUE="${1:?need issue number（或 --list）}"
shift || true
WARM=0
RESTART=0
for arg in "$@"; do
    case "$arg" in
        --warm) WARM=1 ;;
        --restart) RESTART=1 ;;
        *) echo "unknown flag: $arg" >&2; exit 2 ;;
    esac
done

[ -n "$PREVIEW_EXEC" ] || {
    echo "❌ coding-agent.config 没配 PREVIEW_EXEC —— 不知道该怎么起这个项目的 preview server。" >&2
    echo "   例：PREVIEW_EXEC=\"node server/index.mjs\"（进程需读 \$PORT / \$HOST 环境变量）" >&2
    exit 2
}

PORT=$((PREVIEW_PORT_BASE + ISSUE))
BACKEND_PORT=$((PORT + PREVIEW_BACKEND_OFFSET))
WORKTREE="$(worktree_path "$ISSUE")"

[ -d "$WORKTREE" ] || { echo "❌ worktree 不存在：$WORKTREE" >&2; exit 2; }
[ -f "$UNIT_DIR/coding-agent-preview@.socket" ] || {
    echo "❌ 没装 preview unit（$UNIT_DIR/coding-agent-preview@.socket）。先跑 setup.sh。" >&2
    exit 2
}

# ── 写 per-port conf ──
# 三个 unit 都 EnvironmentFile 这一个文件；端口算术只在这里做一次，
# unit / run / wait 谁都不再自己算，避免 offset 改了漏改一处。
mkdir -p "$CONF_DIR"
CONF="$CONF_DIR/${PORT}.conf"
umask 077
# ⚠️ 值一律加双引号。这个文件有两个读者，容忍度不一样：
#   · systemd EnvironmentFile —— 整行右侧都算 value，不加引号也对
#   · preview-run.sh / preview-wait.sh 的 bash `source` —— 不加引号，
#     `PREVIEW_EXEC=node srv.mjs` 会被解析成「带临时环境变量执行 srv.mjs」，
#     报 `srv.mjs: command not found` 后 exit 127，socket 反复重试直到撞
#     trigger limit 熄火。带空格的 PREVIEW_EXEC（几乎必然带空格）每次都踩。
# systemd 侧认这对引号并会剥掉，两边都满足。
cat > "$CONF" <<EOF
# 由 preview-serve.sh 生成，别手改（下次注册会覆盖）
PREVIEW_PROJECT="$TMUX_PREFIX"
PREVIEW_ISSUE="$ISSUE"
PREVIEW_PORT="$PORT"
PREVIEW_BACKEND_PORT="$BACKEND_PORT"
PREVIEW_WORKTREE="$WORKTREE"
PREVIEW_EXEC="$PREVIEW_EXEC"
PREVIEW_IDLE="$PREVIEW_IDLE"
PREVIEW_READY_TIMEOUT="$PREVIEW_READY_TIMEOUT"
PATH="$PATH"
EOF

# ── 起监听 ──
# start 而不是 enable：preview 是随 issue 生灭的临时物，不该在重启后自动复活
# （worktree 那时多半已经被 cleanup 删了）。重启后要用就再跑一次本脚本。
systemctl --user daemon-reload
# reset-failed 不能省：app 起不来时 socket 会连续重触发，撞上 TriggerLimitBurst 后
# 整个 socket 进 failed 且**不再接受激活**——URL 从此静默变死，且 `start` 是 no-op。
# 修完配置重跑本脚本就该能恢复，所以先清 failed 状态再 start。
systemctl --user reset-failed \
    "coding-agent-preview@${PORT}.socket" \
    "coding-agent-preview@${PORT}.service" \
    "coding-agent-preview-app@${PORT}.service" 2>/dev/null || true
systemctl --user start "coding-agent-preview@${PORT}.socket"

# 改完代码要让 preview 反映新产物：正式 server 不热更新，进程得换一个。
# 只 stop 不 start —— socket 还在监听，下次访问自然拉起新的（要立刻生效就配 --warm）。
# 注意先 stop app 会连带把 proxy 拽下来（proxy Requires app），这正是想要的。
if [ "$RESTART" = 1 ]; then
    systemctl --user stop "coding-agent-preview-app@${PORT}.service" 2>/dev/null || true
fi

if [ "$WARM" = 1 ]; then
    systemctl --user start "coding-agent-preview-app@${PORT}.service"
fi

# ── tailscale serve 绑定（可选）──
if [ "$PREVIEW_TAILSCALE_SERVE" = "true" ]; then
    if command -v tailscale >/dev/null 2>&1; then
        if ! sudo -n tailscale serve --bg --https="$PORT" "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
            echo "  ⚠️ tailscale serve 绑定失败（sudo -n / 权限？）——本地 http://127.0.0.1:$PORT 仍可用" >&2
        fi
    else
        echo "  ⚠️ 没有 tailscale 命令，跳过反代绑定" >&2
    fi
fi

if [ -n "$PREVIEW_URL_HOST" ]; then
    echo "https://${PREVIEW_URL_HOST}:${PORT}/"
else
    echo "http://127.0.0.1:${PORT}/"
fi
echo "  issue #$ISSUE · 闲置 $PREVIEW_IDLE 自动停 · 再次访问自动拉起（无需重跑本脚本）" >&2
