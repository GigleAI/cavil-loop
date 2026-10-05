#!/usr/bin/env bash
# preview 端口取模 + 端口归属（GigleAI/GigleTutor-Web#1009）的行为守卫。
#
# 跑法：bash tests/preview-port-ownership.test.sh
# 不碰真实 systemd / tailscale / 真实 conf：隔离 HOME + 假 systemctl / tailscale / sudo
# （记下每次调用），跑的是**真实的** preview-serve.sh / preview-unserve.sh 入口。
#
# 为什么要有这个文件：端口按 `issue % MODULO` 取模之后，#40 和 #1040 会算出同一个端口。
# 这时候出错**都不报错**——
#   · 注册不认主 → #1040 把 #40 的 conf 覆盖掉，#40 的预览链接悄悄指向别人的 worktree；
#   · 注销不认主 → 清理 #1040 顺手把 #40 的 socket / tailscale 路由拆掉；
#   · 没有锁 → 两个 issue 同时注册，各自「检查时没人」，后写的赢，登记和路由对不上；
#   · 没登记也解绑 → 端口上别人的（未登记）路由被按公式拆掉。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

export HOME="$SANDBOX/home"
CONF_DIR="$HOME/.config/coding-agent-work-loop/preview"
BIN="$SANDBOX/bin"
CALLS="$SANDBOX/calls"      # 所有外部写操作的流水
ROUTES="$SANDBOX/routes"    # 假 tailscale 当前挂着的路由（一行一个端口）
mkdir -p "$HOME/.config/systemd/user" "$BIN" "$SANDBOX/wt"
: > "$HOME/.config/systemd/user/coding-agent-preview@.socket"

mk_conf() {   # mk_conf <project> [MODULO]
    cat > "$SANDBOX/$1.config" <<CONF
REPO="acme/$1"
PROJECT_ROOT="$SANDBOX/project"
WORKTREE_BASE="$SANDBOX/wt"
STATE_DIR="$SANDBOX/state-$1"
TMUX_PREFIX="$1"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
PREVIEW_EXEC="node server.mjs"
PREVIEW_PORT_BASE=4000
PREVIEW_PORT_MODULO="${2:-}"
PREVIEW_TAILSCALE_SERVE=true
CONF
    mkdir -p "$SANDBOX/state-$1" "$SANDBOX/project"
}
mk_conf tutor 1000
mk_conf other ""

# ── 桩 ──
# SLOW=<秒>：让 systemctl 每次都睡一下，把临界区拉长，给并发用例制造竞争窗口。
cat > "$BIN/systemctl" <<'SH'
#!/usr/bin/env bash
[ -n "${SLOW:-}" ] && sleep "$SLOW"
case "$*" in *is-active*) echo inactive; exit 3;; esac
echo "systemctl $*" >> "$CALLS"
SH
cat > "$BIN/tailscale" <<'SH'
#!/usr/bin/env bash
if [ "$1 $2" = "serve status" ]; then
    while read -r p; do [ -n "$p" ] && echo "https://host.ts.net:$p (tailnet only)"; done < "$ROUTES"
    exit 0
fi
# 真正改路由的只走 sudo 那条；直接调 tailscale 写路由也记下来，方便抓越权。
echo "tailscale $*" >> "$CALLS"
SH
cat > "$BIN/sudo" <<'SH'
#!/usr/bin/env bash
[ "$1" = "-n" ] && shift
[ "$1" = "tailscale" ] || { echo "sudo $*" >> "$CALLS"; exit 1; }
shift
port=""; off=0
for a in "$@"; do
    case "$a" in --https=*) port="${a#--https=}";; off) off=1;; esac
done
if [ "$off" = 1 ]; then
    echo "OFF $port" >> "$CALLS"
    grep -vx "$port" "$ROUTES" > "$ROUTES.tmp" || true; mv "$ROUTES.tmp" "$ROUTES"
else
    echo "BIND $port" >> "$CALLS"
    grep -qx "$port" "$ROUTES" || echo "$port" >> "$ROUTES"
fi
SH
chmod +x "$BIN"/*
export PATH="$BIN:$PATH" CALLS ROUTES

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}
reset() { rm -rf "$CONF_DIR"; : > "$CALLS"; : > "$ROUTES"; rm -rf "$SANDBOX/wt"; mkdir -p "$SANDBOX/wt"; unset SLOW; }
wt() { mkdir -p "$SANDBOX/wt/issue-$1"; echo "$SANDBOX/wt/issue-$1"; }
serve()   { local p="$1"; shift; CODING_AGENT_CONFIG="$SANDBOX/$p.config" bash "$REPO_DIR/scripts/preview-serve.sh" "$@"; }
unserve() { local p="$1"; shift; CODING_AGENT_CONFIG="$SANDBOX/$p.config" bash "$REPO_DIR/scripts/preview-unserve.sh" "$@"; }
owner()   { [ -f "$CONF_DIR/$1.conf" ] || { echo "-"; return; }; ( source "$CONF_DIR/$1.conf"; echo "$PREVIEW_PROJECT|$PREVIEW_ISSUE|$PREVIEW_WORKTREE" ); }
calls_on() { grep -cE "(@$1\.| $1$)" "$CALLS" || true; }   # 某端口上的 unit / 路由写操作次数
route_on() { grep -cx "$1" "$ROUTES" || true; }

echo "【1】端口公式：配了 MODULO 才取模，没配保持 BASE + issue"
( export CODING_AGENT_CONFIG="$SANDBOX/tutor.config"; exec 2>/dev/null
  source "$REPO_DIR/scripts/_lib.sh"
  echo "$(preview_port 1009) $(preview_port 40) $(preview_port 1040) $(preview_port 999) $(preview_port 1000) $(preview_port 746)"
) > "$SANDBOX/out"
chk "tutor(MODULO=1000)：1009/40/1040/999/1000/746" "$(cat "$SANDBOX/out")" "4009 4040 4040 4999 4000 4746"
( export CODING_AGENT_CONFIG="$SANDBOX/other.config"; exec 2>/dev/null
  source "$REPO_DIR/scripts/_lib.sh"; echo "$(preview_port 1040) $(preview_port 40)" ) > "$SANDBOX/out"
chk "other(未配 MODULO)：1040/40 不取模" "$(cat "$SANDBOX/out")" "5040 4040"

echo "【2】注册：登记主人 = 项目 + 完整 issue + worktree，端口按取模算"
reset; W40="$(wt 40)"
serve tutor 40 > "$SANDBOX/out" 2>&1; rc=$?
chk "注册 #40 成功" "$rc" "0"
chk "登记在 4040，主人是 tutor #40" "$(owner 4040)" "tutor|40|$W40"
chk "tailscale 绑定了 4040" "$(route_on 4040)" "1"
chk "打印的 URL 用取模端口" "$(grep -c ':4040/' "$SANDBOX/out")" "1"

echo "【3】撞端口：#1040 注册被拒，报出占用方，#40 一点不动"
wt 1040 >/dev/null; : > "$CALLS"
serve tutor 1040 > "$SANDBOX/out" 2>&1; rc=$?
chk "注册 #1040 exit 2" "$rc" "2"
chk "报错里写了占用方 tutor #40" "$(grep -c 'tutor #40' "$SANDBOX/out")" "1"
chk "4040 的登记还是 #40" "$(owner 4040)" "tutor|40|$W40"
chk "4040 上零 unit / 路由写操作" "$(calls_on 4040)" "0"
chk "4040 路由还在" "$(route_on 4040)" "1"

echo "【4】按 issue 注销，但端口属于别人：exit 3，什么都不动"
: > "$CALLS"
unserve tutor --issue 1040 > "$SANDBOX/out" 2>&1; rc=$?
chk "注销 #1040 exit 3" "$rc" "3"
chk "4040 的登记还是 #40" "$(owner 4040)" "tutor|40|$W40"
chk "4040 上零写操作" "$(calls_on 4040)" "0"

echo "【5】按 issue 注销，端口没登记但挂着别人的路由：什么都不动"
echo 4041 >> "$ROUTES"; : > "$CALLS"
unserve tutor --issue 41 > "$SANDBOX/out" 2>&1; rc=$?
chk "注销未登记的 #41 exit 0（幂等）" "$rc" "0"
chk "4041 上零 off / stop" "$(calls_on 4041)" "0"
chk "4041 路由还在" "$(route_on 4041)" "1"

echo "【6】按端口 + 预期主人注销，预期不符：exit 3，不动"
: > "$CALLS"
unserve tutor --port 4040 --expect-issue 40 --expect-worktree "$SANDBOX/wt/elsewhere" > "$SANDBOX/out" 2>&1; rc=$?
chk "预期 worktree 不符 exit 3" "$rc" "3"
unserve tutor --port 4040 --expect-issue 1040 > "$SANDBOX/out" 2>&1; rc=$?
chk "预期 issue 不符 exit 3" "$rc" "3"
chk "4040 上零写操作" "$(calls_on 4040)" "0"
chk "4040 的登记还是 #40" "$(owner 4040)" "tutor|40|$W40"

echo "【7】旧的裸端口调用（过渡期兼容）：主人只从 cleanup 注入的 ISSUE / WORKTREE 取，缺了就不动"
# 项目 cleanup hook 升级前还在用 `preview-unserve.sh <port>`；cleanup-issue.sh 给 hook 注入了
# ISSUE / WORKTREE，这里拿它们当预期主人，照样认主。没有这两个 env = 不知道是谁在要 → 拒绝。
: > "$CALLS"
( unset ISSUE WORKTREE; unserve tutor 4040 ) > "$SANDBOX/out" 2>&1; rc=$?
chk "没有 ISSUE/WORKTREE env 的裸端口调用 exit 2" "$rc" "2"
ISSUE=1040 WORKTREE="$SANDBOX/wt/issue-1040" unserve tutor 4040 > "$SANDBOX/out" 2>&1; rc=$?
chk "env 指向别人（#1040）exit 3" "$rc" "3"
ISSUE=40 WORKTREE="" unserve tutor 4040 > "$SANDBOX/out" 2>&1; rc=$?
chk "WORKTREE 被 hook 清空（形状不符）exit 3" "$rc" "3"
chk "4040 上零写操作" "$(calls_on 4040)" "0"
chk "4040 的登记还是 #40" "$(owner 4040)" "tutor|40|$W40"

echo "【8】主人自己注销：停 unit、解路由、删登记"
: > "$CALLS"
unserve tutor --issue 40 > "$SANDBOX/out" 2>&1; rc=$?
chk "注销 #40 exit 0" "$rc" "0"
chk "4040 登记已删" "$(owner 4040)" "-"
chk "4040 路由已解" "$(route_on 4040)" "0"
chk "停了 socket" "$(grep -c 'stop coding-agent-preview@4040.socket' "$CALLS")" "1"
serve tutor 40 > /dev/null 2>&1
ISSUE=40 WORKTREE="$W40" unserve tutor 4040 > "$SANDBOX/out" 2>&1; rc=$?
chk "过渡期裸端口 + env 指向真主人：exit 0 并注销" "$rc|$(owner 4040)|$(route_on 4040)" "0|-|0"

echo "【9】跨项目：别的项目的同号 issue 不是同一个主人（没开取模的项目也一样）"
reset; wt 40 >/dev/null
serve other 40 > /dev/null 2>&1
chk "other #40 登记在 4040" "$(owner 4040 | cut -d'|' -f1,2)" "other|40"
: > "$CALLS"
serve tutor 40 > "$SANDBOX/out" 2>&1; rc=$?
chk "tutor #40 注册被拒 exit 2" "$rc" "2"
chk "登记仍是 other" "$(owner 4040 | cut -d'|' -f1)" "other"
unserve tutor --issue 40 > /dev/null 2>&1; rc=$?
chk "tutor 注销 #40 碰不到 other 的 exit 3" "$rc" "3"
chk "4040 上零写操作" "$(calls_on 4040)" "0"

echo "【10】并发注册：恰好一个成功，登记与路由的主人一致"
reset; wt 40 >/dev/null; wt 1040 >/dev/null
export SLOW=0.2
serve tutor 40   > "$SANDBOX/a" 2>&1 & pa=$!
serve tutor 1040 > "$SANDBOX/b" 2>&1 & pb=$!
wait "$pa"; ra=$?; wait "$pb"; rb=$?
unset SLOW
chk "两个退出码是 {0,2}" "$(printf '%s\n' "$ra" "$rb" | sort | tr '\n' ' ')" "0 2 "
if [ "$ra" = 0 ]; then want=40; else want=1040; fi
chk "登记主人 = 成功的那个 (#$want)" "$(owner 4040 | cut -d'|' -f2)" "$want"
chk "4040 只绑了一次" "$(grep -cx 'BIND 4040' "$CALLS")" "1"

echo "【11】注册与注销交错：结束时「有登记 ⇔ 有路由」"
reset; wt 40 >/dev/null; wt 1040 >/dev/null
serve tutor 40 > /dev/null 2>&1
export SLOW=0.2
unserve tutor --issue 40 > "$SANDBOX/a" 2>&1 & pa=$!
sleep 0.1
serve tutor 1040 > "$SANDBOX/b" 2>&1 & pb=$!
wait "$pa"; wait "$pb"; rb=$?
unset SLOW
o="$(owner 4040)"
if [ "$o" = "-" ]; then
    chk "无登记时也无路由" "$(route_on 4040)" "0"
else
    chk "登记在（#1040）时路由也在" "$(route_on 4040)" "1"
    chk "登记主人是 #1040" "$(echo "$o" | cut -d'|' -f2)" "1040"
fi
chk "最后一次路由操作与最终登记一致" \
    "$(grep -E '^(OFF|BIND) 4040$' "$CALLS" | tail -1)" \
    "$([ "$o" = "-" ] && echo 'OFF 4040' || echo 'BIND 4040')"

echo
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
