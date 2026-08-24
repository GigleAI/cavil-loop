#!/usr/bin/env bash
# 按需 preview（systemd socket 激活）的端到端守卫。
#
# 跑法：bash tests/preview-socket-activation.test.sh
# 依赖：systemd user manager + systemd-socket-proxyd + node。不碰网络、不调 gh，
# 用一次性端口 4931 / 后端 14931 和临时 worktree，跟真实项目的 preview 不相干。
#
# 为什么要有这个文件：这套链路的失败模式全是**静默**的——
#   · conf 值不加引号 → bash `source` 把 `PREVIEW_EXEC="node x.mjs"` 读成「带临时
#     环境变量执行 x.mjs」→ exit 127 → socket 反复重触发 → 撞 TriggerLimitBurst
#     进 failed 且不再激活。URL 从此死掉，而 `systemctl start` 是 no-op，看不出问题。
#   · 少了 ExecStartPost 就绪门 → proxy 在 node 还没 bind 完时就转发 → 首访稳定 502。
#     app 慢启动 300ms 就能踩到，本地手测偏偏经常撞不上。
#   · StopWhenUnneeded 掉了 → 闲置不回收，整个方案退化成「换种方式常驻」，
#     而它看起来完全正常。
# 三条都只能靠真起一遍 systemd 来断言。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

PORT=4931
BACKEND=14931
CONF_DIR="$HOME/.config/coding-agent-work-loop/preview"
CONF="$CONF_DIR/${PORT}.conf"
SANDBOX="$(mktemp -d)"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 $3，实得 $2)"; fail=$((fail+1)); fi
}

cleanup() {
    systemctl --user stop "coding-agent-preview@${PORT}.socket" \
        "coding-agent-preview@${PORT}.service" \
        "coding-agent-preview-app@${PORT}.service" 2>/dev/null
    systemctl --user reset-failed "coding-agent-preview@${PORT}.socket" \
        "coding-agent-preview@${PORT}.service" \
        "coding-agent-preview-app@${PORT}.service" 2>/dev/null
    rm -f "$CONF"
    rm -rf "$SANDBOX"
}
trap cleanup EXIT
cleanup

for dep in systemctl node; do
    command -v "$dep" >/dev/null 2>&1 || { echo "⏭  跳过：缺 $dep"; exit 0; }
done
[ -x /usr/lib/systemd/systemd-socket-proxyd ] || { echo "⏭  跳过：缺 systemd-socket-proxyd"; exit 0; }
systemctl --user show-unit-file coding-agent-preview@.socket >/dev/null 2>&1 \
    || [ -e "$HOME/.config/systemd/user/coding-agent-preview@.socket" ] \
    || { echo "⏭  跳过：preview unit 没装（先跑 setup.sh）"; exit 0; }

# 开头那次 cleanup 已经把 mktemp 建的 SANDBOX 删掉了（trap 和首次调用共用一个函数），
# 这里必须重建，否则下面的 heredoc 写不进去、假 app 根本不存在，测试会以一堆看不懂的
# 「首访拿到空响应」形式失败。
mkdir -p "$SANDBOX"

# 慢启动 400ms 的假 app：专门用来暴露「没有就绪门就首访 502」。
cat > "$SANDBOX/srv.mjs" <<'JS'
import http from 'node:http';
setTimeout(() => {
  http.createServer((_q, r) => r.end('ok')).listen(process.env.PORT, process.env.HOST);
}, 400);
JS

mkdir -p "$CONF_DIR"
cat > "$CONF" <<CONF
PREVIEW_PROJECT="previewtest"
PREVIEW_ISSUE="931"
PREVIEW_PORT="$PORT"
PREVIEW_BACKEND_PORT="$BACKEND"
PREVIEW_WORKTREE="$SANDBOX"
PREVIEW_EXEC="node srv.mjs"
PREVIEW_IDLE="5s"
PREVIEW_READY_TIMEOUT="30"
PATH="$PATH"
CONF

systemctl --user daemon-reload
systemctl --user start "coding-agent-preview@${PORT}.socket" 2>/dev/null

echo "【1】socket 起来了，但 app 还没起（这就是省下来的内存）"
chk "socket active"     "$(systemctl --user is-active "coding-agent-preview@${PORT}.socket")" "active"
chk "app 尚未启动"       "$(systemctl --user is-active "coding-agent-preview-app@${PORT}.service")" "inactive"
chk "公开端口已在监听"    "$(ss -tln 2>/dev/null | grep -cE "127.0.0.1:${PORT}\b")" "1"
chk "后端端口还没人听"    "$(ss -tln 2>/dev/null | grep -cE "127.0.0.1:${BACKEND}\b")" "0"

echo "【2】首次访问触发冷启动，且**第一个**请求就必须成功（就绪门）"
# 不重试、不 sleep：重试会把「首访 502」这个 bug 掩盖掉，那正是要拦的东西。
body="$(curl -s --max-time 30 "http://127.0.0.1:${PORT}/" 2>/dev/null)"
chk "首访拿到 app 响应"   "$body" "ok"
chk "app 已 active"      "$(systemctl --user is-active "coding-agent-preview-app@${PORT}.service")" "active"

echo "【3】闲置 5s 后 proxy 退出，app 被 StopWhenUnneeded 带走"
deadline=$(( $(date +%s) + 40 ))
while [ "$(systemctl --user is-active "coding-agent-preview-app@${PORT}.service")" = "active" ] \
      && [ "$(date +%s)" -lt "$deadline" ]; do sleep 1; done
chk "app 闲置后已停"      "$(systemctl --user is-active "coding-agent-preview-app@${PORT}.service")" "inactive"
chk "后端端口已释放"      "$(ss -tln 2>/dev/null | grep -cE "127.0.0.1:${BACKEND}\b")" "0"
chk "socket 仍在监听（URL 没死）" "$(systemctl --user is-active "coding-agent-preview@${PORT}.socket")" "active"

echo "【4】停用之后再访问，自动拉回来"
body2="$(curl -s --max-time 30 "http://127.0.0.1:${PORT}/" 2>/dev/null)"
chk "二次冷启动仍然可用"  "$body2" "ok"

echo
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
