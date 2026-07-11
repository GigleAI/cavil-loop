#!/usr/bin/env bash
# 常驻「最新站」刷新（GigleTutor-Web#516，Q1=A：挂 merge 钩子）。
#
# agent-poll.sh § 3 检测到新 merged PR 时后台调用（需项目 config 里
# LATEST_SITE_REFRESH=true）；也可手动执行做首次拉起 / 强制刷新。
#
# 行为：
#   1. sync_project_checkout：fetch + （base 分支且干净时）ff-only 拉主 checkout 到最新
#   2. HEAD == 上次已构建 commit 且常驻 session 还活着 → 跳过（幂等，重复触发零成本）
#   3. 否则 build → 重启常驻 tmux session（单进程正式 server：dist 前端 + /api 同源）
#
# 可选项目 config（都有缺省）：
#   LATEST_SITE_PORT=3000                      # 监听 127.0.0.1:<PORT>（tailscale serve 根域名已指向它）
#   LATEST_SITE_SESSION="${TMUX_PREFIX}-latest"
#   LATEST_SITE_BUILD_CMD="npm run build"
#   LATEST_SITE_SERVER_CMD="node server/index.mjs"
#
# 用法：
#   bash scripts/refresh-latest-site.sh          # 平时（merge 钩子 / 手动）
#   FORCE=1 bash scripts/refresh-latest-site.sh  # 忽略 commit 戳强制重建
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

PORT="${LATEST_SITE_PORT:-3000}"
SESSION="${LATEST_SITE_SESSION:-${TMUX_PREFIX:-proj}-latest}"
BUILD_CMD="${LATEST_SITE_BUILD_CMD:-npm run build}"
SERVER_CMD="${LATEST_SITE_SERVER_CMD:-node server/index.mjs}"
STAMP="$STATE_DIR/latest-site-commit"
BUILD_LOG="$STATE_DIR/latest-site-build.log"

sync_project_checkout

head=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo "")
if [ -z "$head" ]; then
    log "refresh-latest-site: 读不到 $PROJECT_ROOT HEAD，放弃"
    exit 1
fi
built=$(cat "$STAMP" 2>/dev/null || echo "")

if [ "${FORCE:-0}" != "1" ] && [ "$head" = "$built" ] && tmux has-session -t "$SESSION" 2>/dev/null; then
    log "refresh-latest-site: HEAD($head) 已构建且 $SESSION 存活，跳过"
    exit 0
fi

log "refresh-latest-site: 构建 $head（上次 ${built:-无}），build log → $BUILD_LOG"
if ! ( cd "$PROJECT_ROOT" && eval "$BUILD_CMD" ) >> "$BUILD_LOG" 2>&1; then
    log "refresh-latest-site: ❌ build 失败（见 $BUILD_LOG 尾部），保留旧 session 不动"
    exit 1
fi

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -c "$PROJECT_ROOT" \
    "PORT=$PORT HOST=127.0.0.1 exec $SERVER_CMD"

# 等端口起来（最多 30s），起不来算失败并把 pane 尾巴倒进 log
# 用 curl 探测而非 ss（macOS launchd 主机没有 ss，保持脚本跨平台）
for _ in $(seq 1 30); do
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then
        echo "$head" > "$STAMP"
        log "refresh-latest-site: ✅ $SESSION @ http://127.0.0.1:$PORT （$head）"
        exit 0
    fi
    sleep 1
done
log "refresh-latest-site: ❌ server 30s 未监听 :$PORT，pane 尾巴："
tmux capture-pane -t "$SESSION" -p 2>/dev/null | tail -5 | while IFS= read -r l; do log "  | $l"; done
exit 1
