#!/usr/bin/env bash
# kind: install
# reads: repo
# 远程入口在代码更新后自动重启（GitHub#533）。
#
# 远程入口是常驻进程，代码在启动时读进内存；部署 / 更新只换磁盘上的文件。每轮轮询
# （scripts/poll-entry.sh → scripts/remote-access.sh auto-restart）比一次「入口在跑的代码」和
# 「磁盘上的代码」，有证据不一样才重启。
#
# 全部在假 HOME 下跑真实脚本和真实服务进程；服务管理器是会真的起停进程的假 systemctl / launchctl
# （tests/fixtures/remote-access-svc-fakes.sh），所以「重启后换没换上新代码」是读回来的，不是假设的。
# 「旧代码」是固定提交 9e7f628c（GitHub#533 之前）的入口脚本。
#
#   1. 旧进程 + 新磁盘代码：一轮轮询重启它、换上新代码、记录清掉；再一轮不动。也走一遍真的 poll-entry.sh
#   2. 新代码之间换版本：同样重启
#   3. 读不准就不动：服务停着 / 服务状态读不到 / 入口不回答 / 登记缺失 / 没开过远程入口
#   4. 重启失败与恢复：命令失败 → 退避；进程没换新 → 算失败；中途被杀 → 算一次；正好 5 次后放弃；
#      放弃后手动重启 / 磁盘代码再变 → 重新开始；记录读不懂 / 写不进 → 不重启
#   5. 和开 / 关共用一把锁：关闭停在半路时检查不动手；检查停在半路时关闭等它；持锁进程被 kill -9 后锁立刻可拿
#   6. 停止信号到来时有一次保存在途：做完、带签名的回答发出后才退出
#   7. 状态里的两行
#   8. macOS：同一套规则（kickstart）
#   9. 文档里给人的恢复命令按字面跑：三种 skill 目录名 + 开发副本，Linux / macOS；没开远程入口、登记缺失时的样子
#
#   bash tests/remote-access-restart.test.sh
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=fixtures/install-fakes.sh
source "$REPO_DIR/tests/fixtures/install-fakes.sh"
# shellcheck source=fixtures/remote-access-fakes.sh
source "$REPO_DIR/tests/fixtures/remote-access-fakes.sh"
# shellcheck source=fixtures/remote-access-svc-fakes.sh
source "$REPO_DIR/tests/fixtures/remote-access-svc-fakes.sh"
OLD_COMMIT=9e7f628c
SANDBOX="$(mktemp -d)"
export TZ=UTC

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1"; echo "     期望：[$3]"; echo "     实得：[$2]"; fail=$((fail+1)); fi
}
chk_has() {
    case "$2" in *"$3"*) echo "  ✅ $1"; pass=$((pass+1)) ;;
        *) echo "  ❌ $1（没找到 [$3]）"; printf '%s\n' "$2" | head -30 | sed 's/^/     | /'; fail=$((fail+1)) ;; esac
}
chk_lacks() {
    case "$2" in *"$3"*) echo "  ❌ $1（不该出现 [$3]）"; printf '%s\n' "$2" | head -30 | sed 's/^/     | /'; fail=$((fail+1)) ;;
        *) echo "  ✅ $1"; pass=$((pass+1)) ;; esac
}

FK="$SANDBOX/fakes"; install_fakes "$FK"; install_fake_tailscale "$FK"
LV="$SANDBOX/live"; install_live_svc_fakes "$LV"
H="$SANDBOX/h"
export FAKE_TS="$SANDBOX/ts" FAKE_SVC="$SANDBOX/svc"
SYS_PATH="/usr/bin:/bin"
RA_STATE="$H/.local/state/cavil-loop/remote-access"
UNIT=cavil-loop-remote.service
LABEL=dev.luosky.cavil-loop.remote
LINK="$H/.agents/skills/cavil-loop"

# 清理：停掉所有由假服务管理器起的入口进程
stop_all() {
    local f p
    for f in "$FAKE_SVC"/*.pid; do
        [ -f "$f" ] || continue
        p="$(cat "$f")"; [ -n "$p" ] && kill -KILL "$p" 2>/dev/null
        rm -f "$f"
    done
}
trap 'stop_all; rm -rf "$SANDBOX"' EXIT

# ── 几份 skill：新代码（当前工作树）、旧代码（固定提交的入口脚本）、另一份新代码（指纹不同）──
tree_from_repo() {   # <目标目录>
    mkdir -p "$1"
    (cd "$REPO_DIR" && git ls-files -co --exclude-standard -z -- scripts setup.sh cavil-loop.config.example) \
        | (cd "$REPO_DIR" && xargs -0 -I{} cp --parents -P {} "$1/" 2>/dev/null)
}
NEW="$SANDBOX/trees/new"; tree_from_repo "$NEW"
OLD="$SANDBOX/trees/old"; tree_from_repo "$OLD"
if ! git -C "$REPO_DIR" show "$OLD_COMMIT:scripts/remote-access/remote_access.py" > "$OLD/scripts/remote-access/remote_access.py" 2>/dev/null; then
    echo "  ❌ 夹具：取不到固定提交 $OLD_COMMIT 的入口脚本（浅克隆？）"; fail=$((fail+1))
fi
NEW2="$SANDBOX/trees/new2"; tree_from_repo "$NEW2"
printf '\n# 另一份新代码（GitHub#533 测试）：内容不同，指纹也不同\n' >> "$NEW2/scripts/remote-access/remote_access.py"
fp_of() { python3 "$1/scripts/remote-access/remote_access.py" code-info | jq -r .fingerprint; }
FP_NEW="$(fp_of "$NEW")"; FP_NEW2="$(fp_of "$NEW2")"
chk "夹具：两份新代码的指纹不同、旧代码没有 code-info" "$([ "$FP_NEW" != "$FP_NEW2" ] && echo differ) $(python3 "$OLD/scripts/remote-access/remote_access.py" code-info >/dev/null 2>&1 && echo old-has || echo old-lacks)" "differ old-lacks"

# 空环境：只给 HOME、PATH 和假工具要的状态目录
in_env() {   # <os> [VAR=值 ...] -- <命令...>
    local os="$1"; shift
    local extra=()
    while [ "$1" != -- ]; do extra+=("$1"); shift; done
    shift
    env -i HOME="$H" PATH="$LV/bin:$FK/bin:$SYS_PATH" TZ=UTC FAKE_UNAME="$os" \
        FAKE_TS="$FAKE_TS" FAKE_SVC="$FAKE_SVC" ${extra[@]+"${extra[@]}"} "$@"
}
ra() {   # <os> [VAR=值 ...] -- <remote-access.sh 的参数...>：跑稳定入口下的那份；输出在 $out，退出码在 $rc
    local pre=()
    while [ "$1" != -- ]; do pre+=("$1"); shift; done
    shift
    rc=0; out="$(in_env "${pre[@]}" -- bash "$LINK/scripts/remote-access.sh" "$@" 2>&1)" || rc=$?
}
use_tree() { mkdir -p "$(dirname "$LINK")"; ln -sfn "$1" "$LINK"; }
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
fresh_world() {
    stop_all
    rm -rf "$H" "$FAKE_TS" "$FAKE_SVC"; mkdir -p "$H" "$FAKE_TS" "$FAKE_SVC"
}
running_fp() {   # 回环上的入口报的指纹（没报 = none；不回答 = down）
    python3 - "$PORT" <<'PY' 2>/dev/null || echo down
import json, sys, urllib.request
d = json.loads(urllib.request.urlopen("http://127.0.0.1:%s/v1/hello" % sys.argv[1], timeout=2).read())
print(d.get("fingerprint", "none"))
PY
}
restarts() { grep -cE "^(--user try-restart|kickstart)" "$FAKE_SVC/calls" 2>/dev/null || true; }
rec() { jq -c '{tries, inflight}' "$RA_STATE/restart.json" 2>/dev/null || echo none; }
rec_next() { jq -r .next "$RA_STATE/restart.json" 2>/dev/null; }
open_with() {   # <os> <tree>：以这份代码打开远程入口
    use_tree "$2"
    PORT="$(free_port)"
    ra "$1" -- enable --port "$PORT"
    [ "$rc" = 0 ] || { echo "  ❌ 夹具：enable 没成功"; printf '%s\n' "$out" | tail -8 | sed 's/^/     | /'; fail=$((fail+1)); }
}
T0=2000000000

echo "── 1. 旧进程 + 新磁盘代码：一轮重启、换上新代码 ──"
fresh_world
open_with Linux "$OLD"
chk "夹具：入口在跑旧代码（不报指纹）" "$(running_fp)" none
use_tree "$NEW"
ra Linux CAVIL_REMOTE_FAKE_NOW=$T0 -- auto-restart
chk "重启了一次" "$(restarts)" 1
chk "入口换上了磁盘上的代码" "$(running_fp)" "$FP_NEW"
chk "成功后重启记录清掉" "$(rec)" none
chk_has "日志写明重启和结果" "$out" "已重启，入口换上了磁盘上的代码"
ra Linux CAVIL_REMOTE_FAKE_NOW=$T0 -- auto-restart
chk "再一轮：代码一致，不重启" "$(restarts)" 1
chk "代码一致时什么都不说" "$out" ""

echo "   真的 poll-entry.sh 也走到这一步"
fresh_world
open_with Linux "$OLD"
use_tree "$NEW"
in_env Linux -- bash "$LINK/scripts/poll-entry.sh" > "$SANDBOX/poll.out" 2>&1
chk "轮询入口：重启了一次、入口换上新代码" "$(restarts) $(running_fp)" "1 $FP_NEW"
chk_has "轮询入口：日志带 [cavil-loop] 前缀" "$(cat "$SANDBOX/poll.out")" "[cavil-loop] 远程入口：已重启"

echo "── 2. 新代码之间换版本 ──"
use_tree "$NEW2"
ra Linux CAVIL_REMOTE_FAKE_NOW=$T0 -- auto-restart
chk "换成另一份新代码：重启、换上它" "$(restarts) $(running_fp)" "2 $FP_NEW2"

echo "── 3. 读不准就不动 ──"
fresh_world
open_with Linux "$OLD"; use_tree "$NEW"
ra Linux FAKE_SVC_MODE=fail -- auto-restart
chk "服务状态读不到：不重启" "$(restarts) $(running_fp)" "0 none"
chk_has "服务状态读不到：记一行" "$out" "读不到常驻服务的状态"
echo 1 > "$RA_STATE/port.real"; cp "$RA_STATE/port" "$RA_STATE/port.real"; free_port > "$RA_STATE/port"
ra Linux -- auto-restart
chk "端口上的入口不回答：不重启" "$(restarts) $(rec)" "0 none"
chk_has "端口上的入口不回答：记一行" "$out" "没有回答"
cp "$RA_STATE/port.real" "$RA_STATE/port"
echo garbage > "$RA_STATE/port"
ra Linux -- auto-restart
chk "端口记录读不懂：不重启" "$(restarts)" 0
cp "$RA_STATE/port.real" "$RA_STATE/port"
cp "$H/.config/systemd/user/$UNIT" "$SANDBOX/unit.keep"
sed -i 's/ --skill [^ ]*//' "$H/.config/systemd/user/$UNIT"
ra Linux -- auto-restart
chk "服务登记里没有 skill 目录：不重启" "$(restarts)" 0
chk_has "服务登记里没有 skill 目录：记一行" "$out" "读不到服务登记里的 skill 目录"
cp "$SANDBOX/unit.keep" "$H/.config/systemd/user/$UNIT"
in_env Linux -- systemctl --user stop "$UNIT"
ra Linux -- auto-restart
chk "服务停着：不重启、不启动、不说话" "$(restarts) $(in_env Linux -- systemctl --user is-active "$UNIT") [$out]" "0 inactive []"
fresh_world; use_tree "$NEW"
ra Linux -- auto-restart
chk "没开过远程入口：什么都不调、不说话" "$(cat "$FAKE_SVC/calls" 2>/dev/null | wc -l) [$out] $([ -e "$RA_STATE" ] && echo state)" "0 [] "

echo "   入口报了身份字段、但认不出：证明不了是旧代码，不重启（PR #535 复审第 1 轮）"
ORIG_ID='return {"level": API_LEVEL, "fingerprint": sha256_hex(f.read())}'
grep -qF "$ORIG_ID" "$NEW/scripts/remote-access/remote_access.py" || { echo "  ❌ 夹具：入口脚本里找不到身份那一行"; fail=$((fail+1)); }
bad_tree() {   # <名字> <替换成的 return 语句>：只改正在跑的入口报的身份，其余同新代码
    local t="$SANDBOX/trees/bad-$1"; rm -rf "$t"; tree_from_repo "$t"
    python3 - "$t/scripts/remote-access/remote_access.py" "$ORIG_ID" "$2" <<'PY'
import sys
p, a, b = sys.argv[1:]
s = open(p).read(); assert a in s; open(p, "w").write(s.replace(a, b))
PY
    echo "$t"
}
for v in 'num|return {"level": API_LEVEL, "fingerprint": 123}' \
         'empty|return {"level": API_LEVEL, "fingerprint": ""}' \
         'nothex|return {"level": API_LEVEL, "fingerprint": "z" * 64}' \
         'nolevel|return {"fingerprint": sha256_hex(f.read())}' \
         'nofp|return {"level": API_LEVEL}' \
         'strlevel|return {"level": "2", "fingerprint": sha256_hex(f.read())}'; do
    name="${v%%|*}"; ret="${v#*|}"
    fresh_world
    tree="$(bad_tree "$name" "$ret")"
    # 入口自己的 code-info 也会读出这个坏身份，所以起入口用坏代码、检查时磁盘换回新代码
    open_with Linux "$tree"; use_tree "$NEW"
    ra Linux CAVIL_REMOTE_FAKE_NOW=$T0 -- auto-restart
    chk "身份字段认不出（${name}）：不重启、不记重启次数" "$(restarts) $(rec)" "0 none"
    chk_has "身份字段认不出（${name}）：记一行「认不出」" "$out" "回答认不出"
    ra Linux -- status
    chk_has "身份字段认不出（${name}）：状态显示判断不了" "$out" "ENTRY_CODE=unknown"
done

echo "── 4. 重启失败与恢复 ──"
fresh_world
open_with Linux "$OLD"; use_tree "$NEW"
ra Linux FAKE_SVC_RESTART=fail CAVIL_REMOTE_FAKE_NOW=$T0 -- auto-restart
chk "重启命令失败：记第 1 次、不在进行中" "$(restarts) $(rec)" '1 {"tries":1,"inflight":false}'
chk "重启命令失败：1 分钟后再试" "$(rec_next)" "$((T0 + 60))"
chk_has "重启命令失败：日志写明原因和下次时间" "$out" "1 分钟后再试"
ra Linux CAVIL_REMOTE_FAKE_NOW=$((T0 + 59)) -- auto-restart
chk "没到时间：不重试" "$(restarts)" 1
ra Linux CAVIL_REMOTE_FAKE_NOW=$((T0 + 60)) -- auto-restart
chk "到时间、服务管理器恢复：这次成功、记录清掉" "$(restarts) $(running_fp) $(rec)" "2 $FP_NEW none"

fresh_world
open_with Linux "$OLD"; use_tree "$NEW"
ra Linux FAKE_SVC_RESTART=noop CAVIL_REMOTE_VERIFY_SECS=1 CAVIL_REMOTE_FAKE_NOW=$T0 -- auto-restart
chk "重启报成功但进程没换新：算失败" "$(restarts) $(running_fp) $(rec)" '1 none {"tries":1,"inflight":false}'
chk_has "进程没换新：日志写明" "$out" "重启后入口没有换上新代码"

# 轮询在「进行中」写下之后、核对之前被杀：下一轮按失败算，不立刻再发
jq '.tries = 2 | .inflight = true' "$RA_STATE/restart.json" > "$RA_STATE/r.tmp" && mv "$RA_STATE/r.tmp" "$RA_STATE/restart.json"
ra Linux CAVIL_REMOTE_FAKE_NOW=$((T0 + 1000)) -- auto-restart
chk "上一次中途被中断：按失败算（第 2 次），这一轮不发重启" "$(restarts) $(rec)" '1 {"tries":2,"inflight":false}'
chk "中途被中断：2 分钟后再试" "$(rec_next)" "$((T0 + 1000 + 120))"
chk_has "中途被中断：日志写明" "$out" "上一次重启没有做完"

# 持续失败：同一份代码累计正好 5 次后放弃（已记了 2 次：上面真发的 1 次 + 中途被中断的 1 次）
r0="$(restarts)"; t=$((T0 + 5000))
for i in 1 2 3 4 5 6 7 8; do
    ra Linux FAKE_SVC_RESTART=fail CAVIL_REMOTE_FAKE_NOW=$t -- auto-restart
    t=$((t + 1000))
done
chk "持续失败：之后只再发了 3 次重启（累计 5 次）" "$(( $(restarts) - r0 ))" 3
chk "持续失败：记录停在 5 次" "$(rec)" '{"tries":5,"inflight":false}'
ra Linux CAVIL_REMOTE_FAKE_NOW=$((t + 99999)) -- auto-restart
chk "放弃后：时间再往后、服务管理器恢复了，也不再自动重启" "$(( $(restarts) - r0 )) $(running_fp)" "3 none"
ra Linux -- status
chk_has "放弃后：状态写明失败次数和手动重启命令" "$out" "自动重启已失败 5 次"
chk_has "放弃后：状态给出手动重启命令" "$out" "systemctl --user try-restart $UNIT"
# 放弃后人手动重启 → 下一轮清记录
in_env Linux -- systemctl --user try-restart "$UNIT"
ra Linux -- auto-restart
chk "放弃后人手动重启：下一轮看到一致、记录清掉" "$(running_fp) $(rec)" "$FP_NEW none"

# 放弃后磁盘代码又变了：新记录、重新开始
fresh_world
open_with Linux "$OLD"; use_tree "$NEW"
for i in 1 2 3 4 5; do ra Linux FAKE_SVC_RESTART=fail CAVIL_REMOTE_FAKE_NOW=$((T0 + i * 1000)) -- auto-restart; done
chk "夹具：已放弃" "$(rec)" '{"tries":5,"inflight":false}'
use_tree "$NEW2"
ra Linux CAVIL_REMOTE_FAKE_NOW=$((T0 + 9000)) -- auto-restart
chk "磁盘代码再变：重新开始、这次成功" "$(restarts) $(running_fp) $(rec)" "6 $FP_NEW2 none"

# 记录读不懂 / 写不进：不重启
fresh_world
open_with Linux "$OLD"; use_tree "$NEW"
echo '{broken' > "$RA_STATE/restart.json"
ra Linux -- auto-restart
chk "重启记录读不懂：不重启" "$(restarts) $(running_fp)" "0 none"
chk_has "重启记录读不懂：说明删掉文件即重新开始" "$out" "删掉这个文件即重新开始自动重启"
rm -f "$RA_STATE/restart.json"
mkdir "$RA_STATE/restart.json.tmp"   # 记录的临时文件写不进
ra Linux -- auto-restart
rmdir "$RA_STATE/restart.json.tmp"
chk "重启记录写不进：不重启" "$(restarts) $(running_fp)" "0 none"
chk_has "重启记录写不进：说明原因" "$out" "不重启（否则次数没法封顶）"

echo "── 5. 和开 / 关共用一把锁 ──"
# 5a. 关闭停在「服务已停、登记还没删」：检查拿不到锁、不动手；放开后关闭照常完成
fresh_world
open_with Linux "$OLD"; use_tree "$NEW"
rm -f "$FAKE_SVC"/hold.*
in_env Linux FAKE_SVC_HOLD=after-stop -- bash "$LINK/scripts/remote-access.sh" disable > "$SANDBOX/disable.out" 2>&1 &
dpid=$!
for i in $(seq 1 100); do [ -e "$FAKE_SVC/hold.after-stop.reached" ] && break; sleep 0.1; done
chk "夹具：关闭停在半路（服务已停、登记还在）" "$([ -e "$FAKE_SVC/hold.after-stop.reached" ] && echo held) $(in_env Linux -- systemctl --user is-active "$UNIT") $([ -e "$H/.config/systemd/user/$UNIT" ] && echo unit)" "held inactive unit"
ra Linux -- auto-restart
chk "关闭进行中：检查拿不到锁，不发重启" "$(restarts)" 0
chk_has "关闭进行中：检查记一行" "$out" "另有操作正在改远程入口"
: > "$FAKE_SVC/hold.after-stop.go"; wait "$dpid"
chk "放开后关闭照常完成" "$(tail -1 "$SANDBOX/disable.out")" "RESULT=disabled"
chk "最终：服务没在跑、登记已删、转发已撤" "$(in_env Linux -- systemctl --user is-active "$UNIT") $([ -e "$H/.config/systemd/user/$UNIT" ] && echo unit) $(jq -c '.Web // {}' "$FAKE_TS/serve.json")" "inactive  {}"
ra Linux -- auto-restart
chk "关闭之后再检查：不启动" "$(restarts) $(in_env Linux -- systemctl --user is-active "$UNIT")" "0 inactive"

# 5b. 检查先拿到锁、停在重启之前：关闭等它做完，再照常关
fresh_world
open_with Linux "$OLD"; use_tree "$NEW"
rm -f "$FAKE_SVC"/hold.*
in_env Linux FAKE_SVC_HOLD=before-restart CAVIL_REMOTE_FAKE_NOW=$T0 -- bash "$LINK/scripts/remote-access.sh" auto-restart > "$SANDBOX/check.out" 2>&1 &
cpid=$!
for i in $(seq 1 100); do [ -e "$FAKE_SVC/hold.before-restart.reached" ] && break; sleep 0.1; done
in_env Linux -- bash "$LINK/scripts/remote-access.sh" disable > "$SANDBOX/disable.out" 2>&1 &
dpid=$!
sleep 1
chk "检查持锁时：关闭在等，还没停服务" "$(kill -0 "$dpid" 2>/dev/null && echo waiting) $(in_env Linux -- systemctl --user is-active "$UNIT")" "waiting active"
: > "$FAKE_SVC/hold.before-restart.go"; wait "$cpid"; wait "$dpid"
chk "检查做完后关闭照常完成" "$(tail -1 "$SANDBOX/disable.out")" "RESULT=disabled"
chk "最终：服务没在跑、登记已删、转发已撤" "$(in_env Linux -- systemctl --user is-active "$UNIT") $([ -e "$H/.config/systemd/user/$UNIT" ] && echo unit) $(jq -c '.Web // {}' "$FAKE_TS/serve.json")" "inactive  {}"

# 5c. 持锁进程被 kill -9：锁立刻可拿
fresh_world
open_with Linux "$OLD"; use_tree "$NEW"
rm -f "$FAKE_SVC"/hold.*
in_env Linux FAKE_SVC_HOLD=before-restart -- bash "$LINK/scripts/remote-access.sh" auto-restart > /dev/null 2>&1 &
kpid=$!
for i in $(seq 1 100); do [ -e "$FAKE_SVC/hold.before-restart.reached" ] && break; sleep 0.1; done
killtree() { local c; for c in $(pgrep -P "$1"); do killtree "$c"; done; kill -KILL "$1" 2>/dev/null; }
killtree "$kpid"; wait "$kpid" 2>/dev/null
chk "夹具：记录停在「进行中」" "$(rec)" '{"tries":1,"inflight":true}'
ra Linux CAVIL_REMOTE_FAKE_NOW=$T0 -- auto-restart
chk "持锁进程被 kill -9 后：下一次检查拿得到锁（按上次中断算失败）" "$(rec)" '{"tries":1,"inflight":false}'
t1=$(date +%s); ra Linux -- disable; t2=$(date +%s)
chk "持锁进程被 kill -9 后：关闭不用等" "$(tail -1 <<<"$out") $(( t2 - t1 < 10 ))" "RESULT=disabled 1"

echo "── 6. 停止信号到来时有一次保存在途 ──"
fresh_world
SLOW="$SANDBOX/trees/slow"; rm -rf "$SLOW"; tree_from_repo "$SLOW"
REV="$(printf '%064d' 7)"
cat > "$SLOW/scripts/project-config.sh" <<EOF
#!/usr/bin/env bash
# 测试替身：get 给一个可改项；set 慢慢做完再给结果
case "\$1" in
    get) echo '{"version":1,"state":"ok","rev":"$REV","fields":[{"name":"MAX_CONCURRENT_WORKERS","mode":"edit","editable":true}]}' ;;
    set) cat > /dev/null; sleep 3; echo "RESULT=saved" ;;
esac
EOF
open_with Linux "$SLOW"
fake_ts_device 100.64.0.7 nMAC1 test-mac
code="$(in_env Linux -- python3 "$LINK/scripts/remote-access/remote_access.py" pair-code --state "$RA_STATE")"
paired="$(python3 "$REPO_DIR/tests/fixtures/remote-access-client.py" --port "$PORT" pair "$code")"
DEV="$(jq -r .body.id <<<"$paired")"; KEY="$(jq -r .body.key <<<"$paired")"
chk "夹具：配对成功" "$(jq -r .status <<<"$paired")" 200
pid_before="$(cat "$FAKE_SVC/$UNIT.pid")"
python3 "$REPO_DIR/tests/fixtures/remote-access-client.py" --port "$PORT" call POST /v1/projects/widget/config --id "$DEV" --key "$KEY" \
    --body "{\"rev\":\"$REV\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"3\"}}" > "$SANDBOX/save.out" 2>&1 &
spid=$!
sleep 1
in_env Linux -- systemctl --user try-restart "$UNIT"
wait "$spid"
chk "在途的保存做完了，回答带签名" "$(jq -c '[.status, .signed, .body.result]' "$SANDBOX/save.out")" '[200,true,"saved"]'
chk "旧进程退出、新进程起来了" "$(kill -0 "$pid_before" 2>/dev/null && echo old-alive) $([ "$(cat "$FAKE_SVC/$UNIT.pid")" != "$pid_before" ] && echo new) $(running_fp | cut -c1-12)" " new ${FP_NEW:0:12}"

echo "── 7. 状态里的两行 ──"
fresh_world
open_with Linux "$OLD"; use_tree "$NEW"
ra Linux -- status
chk_has "入口在跑旧代码：状态说出来" "$out" "入口在跑旧代码"
chk_has "入口在跑旧代码：ENTRY_CODE=differs" "$out" "ENTRY_CODE=differs"
chk "最后一行还是 RESULT=" "$(tail -1 <<<"$out" | cut -d= -f1)" RESULT
ra Linux -- auto-restart
ra Linux -- status
chk_has "重启之后：ENTRY_CODE=same" "$out" "ENTRY_CODE=same"

echo "── 8. macOS：同一套规则 ──"
fresh_world
open_with Darwin "$OLD"; use_tree "$NEW"
chk "夹具：macOS 上入口在跑旧代码" "$(running_fp)" none
ra Darwin CAVIL_REMOTE_FAKE_NOW=$T0 -- auto-restart
chk "macOS：kickstart 重启、换上新代码、记录清掉" "$(restarts) $(running_fp) $(rec)" "1 $FP_NEW none"
use_tree "$NEW2"
ra Darwin FAKE_SVC_RESTART=fail CAVIL_REMOTE_FAKE_NOW=$T0 -- auto-restart
chk "macOS：重启失败也记下、按退避" "$(rec) $(rec_next)" "{\"tries\":1,\"inflight\":false} $((T0 + 60))"
ra Darwin -- disable
ra Darwin -- auto-restart
chk "macOS：关闭之后不启动" "$(in_env Darwin -- launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo loaded || echo gone)" gone

echo "── 9. 文档里给人的恢复命令，按字面跑 ──"
doc_block() {   # <文档> <标记> → 代码块里的命令
    awk -v b="<!-- $2:begin -->" -v e="<!-- $2:end -->" '$0==b{on=1;next} $0==e{on=0} on' "$REPO_DIR/docs/$1" | sed '/^```/d'
}
for m in remote-restart-linux remote-restart-mac; do
    chk "中英两份文档里的「${m}」一字不差" "$(doc_block operations.zh.md "$m")" "$(doc_block operations.md "$m")"
    chk "文档里有「${m}」这一块" "$([ -n "$(doc_block operations.md "$m")" ] && echo yes)" yes
done
doc_block operations.md remote-restart-linux > "$SANDBOX/linux.sh"
doc_block operations.md remote-restart-mac > "$SANDBOX/mac.sh"
# 三种 skill 目录名（新名字、两代旧名字）+ 开发副本：服务登记里记的是哪个，文档的命令就读出哪个
for name in cavil-loop coding-agent-work-loop coding-agent-workflow dev; do
    fresh_world
    if [ "$name" = dev ]; then
        skill="$SANDBOX/dev-checkout"; rm -rf "$skill"; tree_from_repo "$skill"; git -C "$skill" init -q -b main
    else
        skill="$H/.agents/skills/$name"; mkdir -p "$(dirname "$skill")"; ln -sfn "$OLD" "$skill"
    fi
    PORT="$(free_port)"
    rc=0; out="$(in_env Linux -- bash "$skill/scripts/remote-access.sh" enable --port "$PORT" 2>&1)" || rc=$?
    [ "$rc" = 0 ] || { echo "  ❌ 夹具：${name} 下 enable 没成功"; fail=$((fail+1)); }
    rc=0; out="$(in_env Linux -- bash "$SANDBOX/linux.sh" 2>&1)" || rc=$?
    chk "${name}：文档命令重启成功（打印 active）" "$(sed -n 1p <<<"$out")" active
    got="$(sed -n 2p <<<"$out")"
    chk "${name}：文档命令读出的 skill 目录就是服务登记里那个" "$got" "$(sed -n 's/.*--skill \([^ ]*\).*/\1/p' "$H/.config/systemd/user/$UNIT")"
    chk "${name}：那个目录里有入口脚本" "$([ -f "$got/scripts/remote-access/remote_access.py" ] && echo yes)" yes
    if [ "$name" = dev ]; then
        chk "开发副本：目录里有 .git（文档说照 git pull）" "$([ -d "$got/.git" ] && echo yes)" yes
    else
        chk "${name}：没有 .git（文档说托管安装会自动更新）" "$([ -d "$got/.git" ] && echo yes || echo no)" no
    fi
done
# 没开远程入口 / 登记缺失
fresh_world
rc=0; out="$(in_env Linux -- bash "$SANDBOX/linux.sh" 2>&1)" || rc=$?
chk_has "Linux 没开远程入口：重启那条报找不到服务" "$out" "not found"
chk "Linux 没开远程入口：读目录那条什么都不打印" "$(grep -c '^/' <<<"$out")" 0
# macOS
fresh_world
open_with Darwin "$OLD"
rc=0; out="$(in_env Darwin -- bash "$SANDBOX/mac.sh" 2>&1)" || rc=$?
chk_has "macOS：文档命令重启成功（打印 state = running）" "$(sed -n 1p <<<"$out")" "state = running"
chk "macOS：文档命令读出的 skill 目录就是服务登记里那个" "$(sed -n 2p <<<"$out")" "$LINK"
in_env Darwin -- bash "$LINK/scripts/remote-access.sh" disable >/dev/null 2>&1
rc=0; out="$(in_env Darwin -- bash "$SANDBOX/mac.sh" 2>&1)" || rc=$?
chk_has "macOS 远程入口已关：重启那条报找不到服务、不会把它打开" "$out" "Could not find service"
chk "macOS 远程入口已关：读目录那条什么都不打印" "$(grep -c '^/' <<<"$out")" 0
chk "macOS 远程入口已关：没有被打开" "$(in_env Darwin -- launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo loaded || echo gone)" gone

echo
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ] && { echo "全部通过（$pass 项）"; exit 0; }
echo "失败 $fail 项（通过 $pass 项）"; exit 1
