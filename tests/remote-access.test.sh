#!/usr/bin/env bash
# kind: install
# reads: repo
# 远程入口（GitHub#387）：开关与配对脚本、常驻服务、daemon 侧的停 / 启脚本。
#
# 全部在假 HOME + 假 systemctl / launchctl / uname / tailscale 下跑**真实**脚本和真实服务进程；
# 请求由一份照文档协议独立写的参考客户端发出（tests/fixtures/remote-access-client.py，不 import 服务端）。
# 断言的是落盘文件、调度器与转发状态、服务的回复——不读源码文本。
#
#   1. 默认是关的；前提不满足（Tailscale 没连上 / 没开证书 / 没权限登记转发 / 端口开着公网入口 /
#      后台任务状态读不到）时什么都不留
#   2. 打开：转发登记、服务文件、后台任务；重复打开不重复登记
#   3. 来访者不是查得到的 Tailscale 设备 → 拒绝（每条旁边有一条「是的话就通过」）
#   4. 配对码：没生成 / 输错 / 过期 / 错满 5 次 / 用过，都换不到钥匙；正确的换到
#   5. 签名请求：读状态、签名不对、重放、时间不对、换了设备、服务重启后的旧请求
#   6. 停 / 启：只在状态对得上时执行，执行后读回；读不到不动；macOS 一侧同一套规则
#   7. 日志最后 200 行
#  7b. 项目配置（GitHub#530）：读 / 改，只放行此刻可改的项；格式不合规的读写脚本都不调用，只读项只读不写
#   8. 撤销：命令行撤销、客户端自己撤销（回复带签名），之后旧钥匙被拒
#   9. 关闭：读不到不动；停服务 + 撤转发，设备清单保留
#  10. 文档里写给人照做的命令，按字面在空环境跑通
#
#   bash tests/remote-access.test.sh
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=fixtures/install-fakes.sh
source "$REPO_DIR/tests/fixtures/install-fakes.sh"
# shellcheck source=fixtures/remote-access-fakes.sh
source "$REPO_DIR/tests/fixtures/remote-access-fakes.sh"
SANDBOX="$(mktemp -d)"
SERVER_PID=""
stop_server() { if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; fi; }
trap 'stop_server; rm -rf "$SANDBOX"' EXIT
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
H="$SANDBOX/h"; HOST="$SANDBOX/p/widget"
export FAKE_SD="$SANDBOX/sd" FAKE_LD="$SANDBOX/ld" FAKE_TS="$SANDBOX/ts"
SYS_PATH="/usr/bin:/bin"
RA_STATE="$H/.local/state/cavil-loop/remote-access"
UNIT=cavil-loop-remote.service
TIMER=cavil-loop-poll@widget.timer

# skill 副本做成 git 仓库（Linux 上 setup.sh 会从它发布受管 release，需要 origin）
SKILL="$SANDBOX/skill"
make_skill() {
    mkdir -p "$SKILL"; git init -q --bare "$SKILL.git"
    (cd "$REPO_DIR" && git ls-files -co --exclude-standard -z -- . ':!client' ':!docs' ':!tests') \
        | (cd "$REPO_DIR" && xargs -0 -I{} cp --parents -P {} "$SKILL/" 2>/dev/null)
    git -C "$SKILL" init -q -b main
    git -C "$SKILL" add -A >/dev/null
    git -C "$SKILL" -c user.email=t@example.invalid -c user.name=t commit -qm snapshot
    git -C "$SKILL" remote add origin "$SKILL.git"; git -C "$SKILL" push -q -u origin main 2>/dev/null
}
make_skill

# 空环境：只给 HOME、PATH 和假工具要的状态目录；再加调用方给的 VAR=值
in_env() {   # <os> [VAR=值 ...] -- <命令...>
    local os="$1"; shift
    local extra=()
    while [ "$1" != -- ]; do extra+=("$1"); shift; done
    shift
    env -i HOME="$H" PATH="$FK/bin:$FK/agents-claude:$SYS_PATH" TZ=UTC FAKE_UNAME="$os" \
        FAKE_SD="$FAKE_SD" FAKE_LD="$FAKE_LD" FAKE_TS="$FAKE_TS" ${extra[@]+"${extra[@]}"} "$@"
}
ra() {   # <os> [VAR=值 ...] -- <remote-access.sh 的参数...>；输出在 $out，退出码在 $rc
    local pre=()
    while [ "$1" != -- ]; do pre+=("$1"); shift; done
    shift
    rc=0; out="$(in_env "${pre[@]}" -- bash "$SKILL/scripts/remote-access.sh" "$@" 2>&1)" || rc=$?
}

fresh_world() {
    stop_server
    rm -rf "$H" "$SANDBOX/p" "$FAKE_SD" "$FAKE_LD" "$FAKE_TS"; mkdir -p "$H" "$SANDBOX/p" "$FAKE_SD" "$FAKE_LD" "$FAKE_TS"
    git init -q -b main "$HOST"; git -C "$HOST" -c user.email=t@x -c user.name=t commit -q --allow-empty -m init
}
connect_project() {   # <os>
    in_env "$1" -- bash "$SKILL/setup.sh" --yes "$HOST" < /dev/null > "$SANDBOX/setup.out" 2>&1 \
        || { echo "  ❌ 夹具：setup.sh 没能接上项目"; tail -20 "$SANDBOX/setup.out"; fail=$((fail+1)); }
}
sd_calls() { grep -cE "$1" "$FAKE_SD/calls" 2>/dev/null || true; }
ts_calls() { grep -cE "$1" "$FAKE_TS/calls" 2>/dev/null || true; }
mapping() { jq -c '.Web // {}' "$FAKE_TS/serve.json" 2>/dev/null || echo '{}'; }
PORT=47387

echo "── 1. 默认是关的；前提不满足时什么都不留 ──"
fresh_world
ra Linux -- status
chk "没打开过：状态是 closed" "$rc $(tail -1 <<<"$out")" "0 RESULT=closed"
chk "没打开过：没有服务文件、没有转发" "$([ -e "$H/.config/systemd/user/$UNIT" ] && echo unit) $(mapping)" " {}"

nothing_left() {   # <标题>
    chk "$1：没有服务文件、没有转发、后台任务没启动" \
        "$([ -e "$H/.config/systemd/user/$UNIT" ] && echo unit) $(mapping) $(cat "$FAKE_SD/$UNIT.active" 2>/dev/null)" " {} "
}
echo Stopped > "$FAKE_TS/backend"
ra Linux -- enable
chk "Tailscale 没连上：退出 2" "$rc $(tail -1 <<<"$out")" "2 RESULT=tailscale_down"
nothing_left "Tailscale 没连上"
rm -f "$FAKE_TS/backend"
ra Linux FAKE_TS_STATUS=fail -- enable
chk "Tailscale 状态读不到：退出 2，不当成没连上也不当成连上了" "$rc $(tail -1 <<<"$out")" "2 RESULT=tailscale_unknown"
nothing_left "Tailscale 状态读不到"
: > "$FAKE_TS/certdomain"
ra Linux -- enable
chk "没开 HTTPS 证书功能：退出 2" "$rc $(tail -1 <<<"$out")" "2 RESULT=no_https"
nothing_left "没开证书功能"
rm -f "$FAKE_TS/certdomain"
ra Linux FAKE_TS_SERVE=deny -- enable
chk "没权限登记转发：退出 2" "$rc $(tail -1 <<<"$out")" "2 RESULT=need_admin"
chk_has "没权限登记转发：给出要人跑的那条命令" "$out" "sudo tailscale serve --bg --https=$PORT http://127.0.0.1:$PORT"
nothing_left "没权限登记转发"
chk "没权限登记转发：试过一次 sudo（免密的话就不用人动手）" "$(grep -c '^-n tailscale serve --bg' "$FAKE_TS/sudo-calls")" 1
ra Linux FAKE_TS_SERVE=lie -- enable
chk "登记报成功但读回没有：退出 3，不启动服务" "$rc $(tail -1 <<<"$out")" "3 RESULT=failed"
nothing_left "登记读回不对"
ra Linux FAKE_TS_SERVE_STATUS=fail -- enable
chk "现有转发读不到：退出 2" "$rc $(tail -1 <<<"$out")" "2 RESULT=tailscale_unknown"
chk "现有转发读不到：没有去登记转发" "$(ts_calls '^serve --bg')" 2   # 只有上面 deny / lie 那两次
n_reads="$(ts_calls '^serve status')"
ra Linux FAKE_TS_SERVE_STATUS=blank -- enable
chk "转发查询退出 0 但没有输出：算读不到，退出 2" "$rc $(tail -1 <<<"$out")" "2 RESULT=tailscale_unknown"
chk "转发查询没有输出：确实查过，但没有登记、也没有撤销" "$(( $(ts_calls '^serve status') > n_reads )) $(ts_calls '^serve --bg') $(ts_calls '^serve --https=[0-9]+ off')" "1 2 0"
jq -n --arg hp "box.tailnet.ts.net:$PORT" '{AllowFunnel:{($hp):true}}' > "$FAKE_TS/serve.json"
ra Linux -- enable
chk "端口上开着公网入口：退出 2" "$rc $(tail -1 <<<"$out")" "2 RESULT=funnel"
chk "端口上开着公网入口：没有去登记转发" "$(ts_calls '^serve --bg')" 2
jq -n --arg hp "box.tailnet.ts.net:$PORT" --arg p "$PORT" '{TCP:{($p):{HTTPS:true}}, Web:{($hp):{Handlers:{"/":{Proxy:"http://127.0.0.1:3000"}}}}}' > "$FAKE_TS/serve.json"
ra Linux -- enable
chk "端口上已有别的转发：退出 2，不覆盖" "$rc $(tail -1 <<<"$out") $(jq -r '.Web[].Handlers["/"].Proxy' "$FAKE_TS/serve.json")" "2 RESULT=port_taken http://127.0.0.1:3000"
rm -f "$FAKE_TS/serve.json"
ra Linux FAKE_SD_MODE=fail -- enable
chk "后台任务状态读不到：退出 2" "$rc $(tail -1 <<<"$out")" "2 RESULT=unknown"
chk "后台任务状态读不到：没有去登记转发" "$(ts_calls '^serve --bg') $(mapping)" "2 {}"
ra Linux -- enable --port 80
chk "端口不合规：退出 1" "$rc $(tail -1 <<<"$out")" "1 RESULT=bad_port"
# 端口上已有一条形状一样（端口 → 本机同一端口）、但不是本功能登记的转发——按需预览登记的就长这样
fresh_world
jq -n --arg hp "box.tailnet.ts.net:$PORT" --arg p "$PORT" '{TCP:{($p):{HTTPS:true}}, Web:{($hp):{Handlers:{"/":{Proxy:("http://127.0.0.1:" + $p)}}}}}' > "$FAKE_TS/serve.json"
ra Linux -- enable
chk "同形状但不是本功能登记的转发：不接管，退出 2" "$rc $(tail -1 <<<"$out") $(mapping | jq length) $([ -e "$H/.config/systemd/user/$UNIT" ] && echo unit)" "2 RESULT=port_taken 1 "
ra Linux -- disable
chk "…关闭时也不撤它" "$(mapping | jq length) $(ts_calls 'off$')" "1 0"
# 没权限 → 人照提示用管理员权限登记 → 重跑：认得这一条是本功能的，关闭时撤掉
fresh_world
ra Linux FAKE_TS_SERVE=deny -- enable
in_env Linux -- tailscale serve --bg --https="$PORT" "http://127.0.0.1:$PORT" >/dev/null
ra Linux FAKE_TS_SERVE=deny -- enable
chk "没权限 → 人照提示登记 → 重跑：打开成功" "$rc $(tail -1 <<<"$out")" "0 RESULT=enabled"
ra Linux -- disable
chk "…关闭时撤掉这条转发" "$rc $(tail -1 <<<"$out") $(mapping)" "0 RESULT=disabled {}"

echo "── 2. 打开 ──"
fresh_world
ra Linux -- enable
chk "打开成功" "$rc $(tail -1 <<<"$out")" "0 RESULT=enabled"
chk "转发：这个端口 → 本机回环同一端口" "$(mapping)" "{\"box.tailnet.ts.net:$PORT\":{\"Handlers\":{\"/\":{\"Proxy\":\"http://127.0.0.1:$PORT\"}}}}"
unit_file="$H/.config/systemd/user/$UNIT"
chk_has "服务文件：启动的是服务程序，带状态目录、端口、skill 目录" "$(cat "$unit_file" 2>/dev/null)" \
    "scripts/remote-access/remote_access.py serve --state $RA_STATE --port $PORT --skill $SKILL"
chk "后台任务：已启用、在跑" "$(cat "$FAKE_SD/$UNIT.enabled") $(cat "$FAKE_SD/$UNIT.active")" "enabled active"
chk "状态目录只有本人能进" "$(stat -c %a "$RA_STATE")" 700
ra Linux -- status
chk "状态：open" "$(tail -1 <<<"$out")" "RESULT=open"
ra Linux -- enable
chk "再打开一次：成功，不重复登记转发" "$rc $(tail -1 <<<"$out") $(ts_calls '^serve --bg')" "0 RESULT=enabled 1"
# 换端口：新端口打开，旧端口上本功能的转发撤掉，别的功能的转发不动；之后关闭，一条都不剩
jq --arg hp "box.tailnet.ts.net:3000" '.TCP["3000"] = {HTTPS:true} | .Web[$hp] = {Handlers:{"/":{Proxy:"http://127.0.0.1:3000"}}}' "$FAKE_TS/serve.json" > "$FAKE_TS/s.tmp" && mv "$FAKE_TS/s.tmp" "$FAKE_TS/serve.json"
web_keys() { jq -r '.Web // {} | keys | join(",")' "$FAKE_TS/serve.json"; }
ra Linux FAKE_TS_SERVE_OFF=stuck -- enable --port 47999
chk "换端口但旧端口的转发撤不掉：退出 3，如实说还剩哪个端口" "$rc $(tail -1 <<<"$out") $(web_keys)" \
    "3 RESULT=partial box.tailnet.ts.net:3000,box.tailnet.ts.net:47387,box.tailnet.ts.net:47999"
chk_has "…给出要人跑的命令" "$out" "sudo tailscale serve --https=47387 off"
ra Linux -- enable --port 47999
chk "重跑：旧端口的转发撤掉了，新端口在，别的功能的转发没动，服务文件是新端口" "$rc $(tail -1 <<<"$out") $(web_keys) $(grep -c -- '--port 47999 ' "$unit_file")" \
    "0 RESULT=enabled box.tailnet.ts.net:3000,box.tailnet.ts.net:47999 1"
ra Linux -- enable --port 47387
ra Linux -- enable --port 48111
chk "再换两次端口：只剩最后一个端口和别的功能的转发" "$rc $(web_keys)" "0 box.tailnet.ts.net:3000,box.tailnet.ts.net:48111"
ra Linux -- disable
chk "默认端口打开 → 换端口 → 关闭：本功能的转发全部撤掉，别的功能的转发还在" "$rc $(tail -1 <<<"$out") $(web_keys) $(cat "$RA_STATE/ports" | wc -l)" \
    "0 RESULT=disabled box.tailnet.ts.net:3000 0"
ra Linux -- status
chk "…关闭后状态是 closed（下次打开仍用最后那个端口）" "$(tail -1 <<<"$out") $(cat "$RA_STATE/port")" "RESULT=closed 48111"
fresh_world
ra Linux FAKE_TS_SERVE=deny FAKE_SUDO=ok -- enable
chk "自己没权限但 sudo 免密：经 sudo 登记成功" "$rc $(tail -1 <<<"$out") $(mapping | jq length)" "0 RESULT=enabled 1"
# macOS：服务文件是 launchd 的
fresh_world
ra Darwin -- enable
plist="$H/Library/LaunchAgents/dev.luosky.cavil-loop.remote.plist"
chk "macOS 打开成功，launchd 已加载这份文件" "$rc $(tail -1 <<<"$out") $(cat "$FAKE_LD/dev.luosky.cavil-loop.remote.path" 2>/dev/null)" "0 RESULT=enabled $plist"
chk "macOS 服务文件是合法 plist，启动的是服务程序" \
    "$(python3 -c 'import plistlib,sys; a=plistlib.load(open(sys.argv[1],"rb"))["ProgramArguments"]; print(a[1].split("/")[-1], a[2], a[5], a[6])' "$plist" 2>&1)" \
    "remote_access.py serve --port $PORT"
ra Darwin -- disable
chk "macOS 关闭：已卸载、文件已删、转发已撤" "$rc $(tail -1 <<<"$out") $([ -e "$plist" ] && echo file) $(mapping)" "0 RESULT=disabled  {}"

# ── 起一个真的服务进程，后面几组都对着它发请求 ──
fresh_world
connect_project Linux
fake_ts_device 100.64.0.7 nMAC1 test-mac
fake_ts_device 100.64.0.9 nOTHER other-box
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
start_server() {   # [VAR=值 ...]：服务进程的额外环境。直接起（不经函数后台），$! 才是服务进程本身
    env -i HOME="$H" PATH="$FK/bin:$FK/agents-claude:$SYS_PATH" TZ=UTC FAKE_UNAME=Linux \
        FAKE_SD="$FAKE_SD" FAKE_LD="$FAKE_LD" FAKE_TS="$FAKE_TS" "$@" \
        python3 "$SKILL/scripts/remote-access/remote_access.py" serve --state "$RA_STATE" --port "$PORT" --skill "$SKILL" \
        >>"$SANDBOX/server.log" 2>&1 &
    SERVER_PID=$!
    local i
    for i in $(seq 1 80); do
        python3 -c 'import sys,urllib.request; urllib.request.urlopen("http://127.0.0.1:%s/v1/hello" % sys.argv[1], timeout=1)' "$PORT" 2>/dev/null && return 0
        sleep 0.1
    done
    echo "  ❌ 夹具：服务没起来"; tail -5 "$SANDBOX/server.log"; fail=$((fail+1))
}
start_server
cl() { python3 "$REPO_DIR/tests/fixtures/remote-access-client.py" --port "$PORT" "$@"; }
pair_code() { in_env Linux -- python3 "$SKILL/scripts/remote-access/remote_access.py" pair-code --state "$RA_STATE"; }
st_err() { jq -r '"\(.status) \(.body.error // "-")"'; }

echo "── 3. 来访者不是查得到的 Tailscale 设备 → 拒绝 ──"
CODE="$(pair_code)"
chk "没有来访地址" "$(cl --no-xff pair "$CODE" | st_err)" "403 not_tailscale"
chk "来访地址是公网地址" "$(cl --xff 8.8.8.8 pair "$CODE" | st_err)" "403 not_tailscale"
chk "来访地址是局域网地址" "$(cl --xff 192.168.1.5 pair "$CODE" | st_err)" "403 not_tailscale"
chk "来访地址不止一个" "$(cl --xff '100.64.0.7, 100.64.0.9' pair "$CODE" | st_err)" "403 not_tailscale"
chk "地址在 Tailscale 段内，但本机 Tailscale 查不到这台设备" "$(cl --xff 100.64.0.99 pair "$CODE" | st_err)" "403 unknown_device"
chk "带公网入口标记" "$(cl --funnel pair "$CODE" | st_err)" "403 funnel"
stop_server
start_server FAKE_TS_WHOIS=fail
chk "查询设备身份的命令失败：拒绝，不当成匿名放行" "$(cl pair "$CODE" | st_err)" "403 unknown_device"
stop_server; start_server FAKE_TS_WHOIS=garbage
chk "查询设备身份的输出读不懂：拒绝" "$(cl pair "$CODE" | st_err)" "403 unknown_device"
stop_server; start_server
chk "以上都没有消耗配对码的错误次数" "$(jq -r .tries "$RA_STATE/pairing.json")" 0
resp="$(cl pair "$CODE" my-mac)"
chk "查得到的 Tailscale 设备 + 正确配对码：配对成功" "$(jq -r '"\(.status) \(.body.version) \(.body.name) \(.body.key | length)"' <<<"$resp")" "200 1 my-mac 64"
ID="$(jq -r .body.id <<<"$resp")"; KEY="$(jq -r .body.key <<<"$resp")"

echo "── 4. 配对码 ──"
chk "用过的配对码不能再用" "$(cl pair "$CODE" | st_err)" "403 pairing_closed"
chk "没生成过配对码时兑换" "$(cl pair 00000000 | st_err)" "403 pairing_closed"
CODE2="$(pair_code)"
wrong="$(printf '%08d' $(( (10#$CODE2 + 1) % 100000000 )))"
chk "输错" "$(cl pair "$wrong" | st_err)" "403 pairing_wrong"
chk "输错一次后，正确的仍可用（带空格的写法也认）" "$(cl pair "${CODE2:0:4} ${CODE2:4:4}" second | jq -r .status)" 200
CODE3="$(pair_code)"
wrong="$(printf '%08d' $(( (10#$CODE3 + 1) % 100000000 )))"
for _ in 1 2 3 4; do cl pair "$wrong" >/dev/null; done
chk "第 5 次输错：作废" "$(cl pair "$wrong" | st_err)" "403 pairing_locked"
chk "作废后正确的也换不到" "$(cl pair "$CODE3" | st_err)" "403 pairing_closed"
CODE4="$(pair_code)"
jq '.expires = 1' "$RA_STATE/pairing.json" > "$RA_STATE/p.tmp" && mv "$RA_STATE/p.tmp" "$RA_STATE/pairing.json"
chk "过期" "$(cl pair "$CODE4" | st_err)" "403 pairing_expired"
chk "配对码文件里没有明文、只本人可读" "$(pair_code >/dev/null; grep -c '"hash"' "$RA_STATE/pairing.json") $(stat -c %a "$RA_STATE/pairing.json") $(stat -c %a "$RA_STATE/devices.json")" "1 600 600"
ra Linux -- list
chk_has "列出已配对设备" "$out" "my-mac"
chk "已配对两台" "$(jq length "$RA_STATE/devices.json")" 2

echo "── 5. 签名请求 ──"
call() { cl call "$@" --id "$ID" --key "$KEY"; }
resp="$(call GET /v1/status)"
chk "读状态：成功，回复的签名验得过" "$(jq -r '"\(.status) \(.signed)"' <<<"$resp")" "200 true"
chk "读状态：就是状态脚本的输出（项目、后台任务状态）" "$(jq -r '.body.status | "\(.version) \(.projects[0].key) \(.projects[0].scheduler.state)"' <<<"$resp")" "1 widget running"
chk "读状态：和本机直接跑状态脚本逐字段一致" \
    "$(jq -cS '.body.status | del(.projects[].last_poll)' <<<"$resp")" \
    "$(in_env Linux -- bash "$SKILL/scripts/install-status.sh" | jq -cS 'del(.projects[].last_poll)')"
chk "签名不对" "$(call GET /v1/status --bad-sig | st_err)" "403 signature"
chk "钥匙不对" "$(cl call GET /v1/status --id "$ID" --key "$(printf 'ab%.0s' $(seq 32))" | st_err)" "403 signature"
chk "没配对过的设备编号" "$(cl call GET /v1/status --id deadbeefdeadbeef --key "$KEY" | st_err)" "401 revoked"
N="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
chk "同一个请求第一次：成功" "$(call GET /v1/status --nonce "$N" | jq -r .status)" 200
chk "同一个请求再发一次：拒绝" "$(call GET /v1/status --nonce "$N" | st_err)" "403 replay"
chk "时间差太多（旧）" "$(call GET /v1/status --time $(( $(date +%s) - 600 )) | st_err)" "403 clock"
chk "时间差太多（新）" "$(call GET /v1/status --time $(( $(date +%s) + 600 )) | st_err)" "403 clock"
chk "钥匙被拿到另一台 Tailscale 设备上用" "$(cl --xff 100.64.0.9 call GET /v1/status --id "$ID" --key "$KEY" | st_err)" "403 device_mismatch"
chk "签名的是别的路径" "$(call GET /v1/nothing | st_err)" "404 not_found"
# 重启前后重放：客户端的钟快 60 秒（在允许的 120 秒之内），所以重启后这个请求的时间仍然「合法」
N2="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"; T2=$(( $(date +%s) + 60 ))
chk "钟快 60 秒的请求：接受" "$(call GET /v1/status --nonce "$N2" --time "$T2" | jq -r .status)" 200
chk "不重启，原样重发：拒绝" "$(call GET /v1/status --nonce "$N2" --time "$T2" | st_err)" "403 replay"
stop_server; start_server
chk "服务重启后，原样重发：仍然拒绝" "$(call GET /v1/status --nonce "$N2" --time "$T2" | st_err)" "403 replay"
chk "重启后新签的请求（同样钟快 60 秒）：成功" "$(call GET /v1/status --time "$T2" | jq -r .status)" 200
chk "已处理请求的记录只本人可读" "$(stat -c %a "$RA_STATE/nonces.json")" 600
# 记录读不懂：不知道重启前处理过什么，这段时间一律不接受签名请求
stop_server; cp "$RA_STATE/nonces.json" "$SANDBOX/nonces.keep"; echo '{broken' > "$RA_STATE/nonces.json"; start_server
resp="$(call GET /v1/status)"
chk "已处理请求的记录读不懂：不接受签名请求（回复带签名），不当成「都没处理过」" "$(jq -r '"\(.status) \(.body.error) \(.signed)"' <<<"$resp")" "503 not_ready true"
chk "…重放的那个请求同样不被接受" "$(call GET /v1/status --nonce "$N2" --time "$T2" | jq -r .status)" 503
stop_server; cp "$SANDBOX/nonces.keep" "$RA_STATE/nonces.json"; start_server
chk "记录恢复后：新请求成功，旧请求仍被拒" "$(call GET /v1/status | jq -r .status) $(call GET /v1/status --nonce "$N2" --time "$T2" | st_err)" "200 403 replay"

echo "── 6. 停 / 启 ──"
: > "$FAKE_SD/calls"
resp="$(call POST /v1/projects/widget/stop)"
chk "停：成功，读回已停，回复带签名" "$(jq -r '"\(.status) \(.body.result) \(.body.state) \(.signed)"' <<<"$resp")" "200 ok stopped true"
chk "停：后台任务确实停了，只发了一条停的命令" "$(cat "$FAKE_SD/$TIMER.active") $(sd_calls " stop $TIMER\$")" "inactive 1"
resp="$(call POST /v1/projects/widget/stop)"
chk "已停时再停：拒绝，没有再发命令" "$(jq -r '"\(.body.result) \(.body.state)"' <<<"$resp") $(sd_calls " stop $TIMER\$")" "refused stopped 1"
chk_has "已停时再停：说明原因" "$(jq -r .body.output <<<"$resp")" "现在的后台任务状态是「已停」"
resp="$(call POST /v1/projects/widget/start)"
chk "启：成功，读回在跑" "$(jq -r '"\(.body.result) \(.body.state)"' <<<"$resp") $(cat "$FAKE_SD/$TIMER.active") $(sd_calls " start $TIMER\$")" "ok running active 1"
resp="$(call POST /v1/projects/nosuch/stop)"
chk "没有这个项目：not_found，没有发任何停 / 启命令" "$(jq -r .body.result <<<"$resp") $(sd_calls ' (stop|start) ')" "not_found 2"
chk "项目名不合规：不认这个请求" "$(call POST '/v1/projects/wid%20get/stop' | st_err)" "404 not_found"
# 状态读不到：重启服务让它带着「systemctl 连不上」的环境
stop_server
start_server FAKE_SD_MODE=fail
: > "$FAKE_SD/calls"
resp="$(call POST /v1/projects/widget/stop)"
chk "后台任务状态读不到：拒绝，状态报读不到，没有发停的命令" "$(jq -r '"\(.body.result) \(.body.state)"' <<<"$resp") $(sd_calls " stop ")" "refused unknown 0"
chk "读不到之前确实读了状态" "$(( $(sd_calls ' show ') > 0 ))" 1
stop_server
# 停了但读回不对
start_server FAKE_SD_STUCK=1
resp="$(call POST /v1/projects/widget/stop)"
chk "发了停的命令但读回仍在跑：failed，状态如实报在跑" "$(jq -r '"\(.body.result) \(.body.state)"' <<<"$resp")" "failed running"
stop_server; start_server
# 脚本本身：macOS 一侧同一套规则
ps_run() { rc=0; out="$(in_env "$1" -- bash "$SKILL/scripts/project-service.sh" widget "$2" 2>&1)" || rc=$?; }
fresh_macos() { rm -rf "$H/.config" "$H/Library" "$FAKE_LD"; mkdir -p "$FAKE_LD"; connect_project Darwin; : > "$FAKE_LD/calls"; }
LABEL=dev.luosky.cavil-loop.widget
fresh_macos
ps_run Darwin start
chk "macOS 在跑时启：拒绝，没有调 launchctl 加载" "$rc $(tail -1 <<<"$out") $(grep -c '^bootstrap' "$FAKE_LD/calls")" "2 RESULT=refused 0"
ps_run Darwin stop
chk "macOS 停：成功，已卸载" "$rc $(tail -2 <<<"$out" | tr '\n' ' ') $([ -e "$FAKE_LD/$LABEL.path" ] && echo loaded)" "0 STATE=stopped RESULT=ok  "
ps_run Darwin start
chk "macOS 启：成功，加载的是这个项目的配置文件" "$rc $(tail -1 <<<"$out") $(cat "$FAKE_LD/$LABEL.path")" "0 RESULT=ok $H/Library/LaunchAgents/$LABEL.plist"
ps_run Darwin stop; mv "$H/Library/LaunchAgents/$LABEL.plist" "$SANDBOX/kept.plist"; : > "$FAKE_LD/calls"
ps_run Darwin start
chk "macOS 配置文件不在：拒绝，没有调 launchctl 加载" "$rc $(tail -1 <<<"$out") $(grep -c '^bootstrap' "$FAKE_LD/calls")" "2 RESULT=refused 0"
rc=0; out="$(in_env Darwin FAKE_LD_PRINT=fail -- bash "$SKILL/scripts/project-service.sh" widget stop 2>&1)" || rc=$?
chk "macOS 状态读不到：拒绝" "$rc $(tail -2 <<<"$out" | tr '\n' ' ')" "2 STATE=unknown RESULT=refused "
rc=0; out="$(in_env Linux -- bash "$SKILL/scripts/project-service.sh" widget restart 2>&1)" || rc=$?
chk "不认识的操作：退出 1" "$rc $(tail -1 <<<"$out")" "1 RESULT=refused"

echo "── 7. 日志 ──"
fresh_world; connect_project Linux
fake_ts_device 100.64.0.7 nMAC1 test-mac
start_server
resp="$(cl pair "$(pair_code)" my-mac)"; ID="$(jq -r .body.id <<<"$resp")"; KEY="$(jq -r .body.key <<<"$resp")"
STATE_DIR="$(in_env Linux -- bash "$SKILL/scripts/install-status.sh" | jq -r '.projects[0].state_dir')"
rm -f "$STATE_DIR/poll.log"
resp="$(call GET /v1/projects/widget/log)"
chk "还没有日志：如实说没有，不报错" "$(jq -r '"\(.status) \(.body.exists) \(.body.text | length)"' <<<"$resp")" "200 false 0"
mkdir -p "$STATE_DIR"; seq 1 450 | sed 's/^/[widget] line /' > "$STATE_DIR/poll.log"
resp="$(call GET /v1/projects/widget/log)"
chk "日志：最后 200 行，回复带签名" "$(jq -r '"\(.status) \(.signed) \(.body.text | split("\n") | length) \(.body.text | split("\n") | first) / \(.body.text | split("\n") | last)"' <<<"$resp")" \
    "200 true 200 [widget] line 251 / [widget] line 450"
chk "别的项目的日志：没有这个项目" "$(call GET /v1/projects/nosuch/log | st_err)" "404 no_project"

echo "── 7b. 项目配置（GitHub#530）──"
# 真脚本前面套一层只记调用的替身：每次调用记一行「get」或「set」，原样转给真脚本。
# 有 $SANDBOX/pcfg-crash 时，set 不转给真脚本、直接退出 1（没有 RESULT 行 = 「被杀 / 半途退出」）。
PCFG="$SKILL/scripts/project-config.sh"; PCFG_CALLS="$SANDBOX/pcfg.calls"
mv "$PCFG" "$SKILL/scripts/project-config.real.sh"
cat > "$PCFG" <<EOF
#!/usr/bin/env bash
echo "\$1" >> "$PCFG_CALLS"
if [ "\$1" = set ] && [ -e "$SANDBOX/pcfg-crash" ]; then cat >/dev/null; exit 1; fi
exec bash "\$(dirname "\$0")/project-config.real.sh" "\$@"
EOF
pcfg_calls() { printf 'get=%s set=%s' "$(grep -cx get "$PCFG_CALLS" 2>/dev/null || true)" "$(grep -cx set "$PCFG_CALLS" 2>/dev/null || true)"; }
CFG_FILE="$(in_env Linux -- bash "$SKILL/scripts/install-status.sh" | jq -r '.projects[0].config')"
cfg_hash() { sha256sum "$CFG_FILE" | cut -d' ' -f1; }

: > "$PCFG_CALLS"
resp="$(call GET /v1/projects/widget/config)"
chk "读配置：成功，回复带签名，读脚本调用 1 次、写脚本 0 次" "$(jq -r '"\(.status) \(.signed) \(.body.result)"' <<<"$resp") $(pcfg_calls)" "200 true ok get=1 set=0"
chk "读配置：就是在那台机器上直接执行读脚本的输出（逐字段）" \
    "$(jq -cS .body.config <<<"$resp")" "$(in_env Linux -- bash "$SKILL/scripts/project-config.real.sh" get widget | jq -cS .)"
REV="$(jq -r .body.config.rev <<<"$resp")"
chk "读配置：给出指纹、并发数是可改项" "$(jq -r '[(.body.config.rev | length | tostring), (.body.config.fields[] | select(.name=="MAX_CONCURRENT_WORKERS") | "\(.mode) \(.editable)")] | join(" ")' <<<"$resp")" "64 edit true"
chk "读配置：别的项目 → not_found" "$(call GET /v1/projects/nosuch/config | jq -r '"\(.status) \(.body.result)"')" "200 not_found"

save() {   # <请求体> → 回复；调用前清空脚本调用记录
    : > "$PCFG_CALLS"; call POST /v1/projects/widget/config --body "$1"
}
before="$(cfg_hash)"
# 格式不合规：读、写脚本都不调用，配置文件不动
for bad in \
    "{\"rev\":\"$REV\",\"values\":{\"max_workers\":\"2\"}}" \
    "{\"rev\":\"$REV\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"\$(id)\"}}" \
    "{\"rev\":\"$REV\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"2 3\"}}" \
    "{\"rev\":\"$REV\",\"values\":{\"MAX_CONCURRENT_WORKERS\":2}}" \
    "{\"rev\":\"$REV\",\"values\":{}}" \
    "{\"rev\":\"abc\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"2\"}}" \
    "{\"values\":{\"MAX_CONCURRENT_WORKERS\":\"2\"}}" \
    "not json" \
    "[1]"; do
    resp="$(save "$bad")"
    chk "格式不合规（$bad）：拒绝，读 0 次、写 0 次" "$(jq -r '"\(.status) \(.signed) \(.body.result)"' <<<"$resp") $(pcfg_calls)" "200 true refused get=0 set=0"
done
: > "$PCFG_CALLS"
chk "项目名不合规：不认这个请求，脚本没调用" "$(call POST '/v1/projects/wid%20get/config' --body "{\"rev\":\"$REV\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"2\"}}" | st_err) $(pcfg_calls)" "404 not_found get=0 set=0"
# 格式合规、但此刻只读的设置：先读一次才知道，写脚本不调用
resp="$(save "{\"rev\":\"$REV\",\"values\":{\"LABEL_AUTOPILOT\":\"autopilot\"}}")"
chk "只显示的设置：拒绝，读 1 次、写 0 次" "$(jq -r .body.result <<<"$resp") $(pcfg_calls)" "refused get=1 set=0"
chk_has "只显示的设置：说明原因" "$(jq -r .body.output <<<"$resp")" "LABEL_AUTOPILOT 不是能在这里改的配置项"
resp="$(save "{\"rev\":\"$REV\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"3\",\"WORKTREE_BASE\":\"/tmp\"}}")"
chk "一项可改、一项没登记（目录）：整个拒绝，写 0 次" "$(jq -r .body.result <<<"$resp") $(pcfg_calls)" "refused get=1 set=0"
fake_ts_device 100.64.0.9 nOTHER other-box; : > "$PCFG_CALLS"
resp="$(cl --xff 100.64.0.9 call POST /v1/projects/widget/config --id "$ID" --key "$KEY" --body "{\"rev\":\"$REV\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"3\"}}")"
chk "钥匙被拿到另一台设备上：拒绝，脚本没调用" "$(st_err <<<"$resp") $(pcfg_calls)" "403 device_mismatch get=0 set=0"
: > "$PCFG_CALLS"
chk "签名不对：拒绝，脚本没调用" "$(call POST /v1/projects/widget/config --bad-sig --body "{\"rev\":\"$REV\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"3\"}}" | st_err) $(pcfg_calls)" "403 signature get=0 set=0"
chk "到这里配置文件一个字节都没动" "$(cfg_hash)" "$before"

# 合法保存（对照）
cp "$CFG_FILE" "$SANDBOX/cfg.before"
NS="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
: > "$PCFG_CALLS"
resp="$(call POST /v1/projects/widget/config --nonce "$NS" --body "{\"rev\":\"$REV\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"3\"}}")"
chk "合法保存：saved，回复带签名，读 1 次、写 1 次" "$(jq -r '"\(.status) \(.signed) \(.body.result)"' <<<"$resp") $(pcfg_calls)" "200 true saved get=1 set=1"
chk "合法保存：回复里列出改了什么" "$(jq -r '.body.detail.changes[] | "\(.name) \(.new)"' <<<"$resp")" "MAX_CONCURRENT_WORKERS 3"
chk "合法保存：配置文件只多 / 改了这一行，其余逐字节不动" \
    "$(diff "$SANDBOX/cfg.before" "$CFG_FILE" | grep '^[<>]' | grep -v '^[<>] MAX_CONCURRENT_WORKERS=' | wc -l) $(grep -c '^MAX_CONCURRENT_WORKERS=3$' "$CFG_FILE")" "0 1"
chk "合法保存：在那台机器上重新加载，daemon 读到的就是 3" \
    "$(in_env Linux -- bash "$SKILL/scripts/project-config.real.sh" get widget | jq -r '.fields[] | select(.name=="MAX_CONCURRENT_WORKERS") | .value')" 3
: > "$PCFG_CALLS"
chk "同一个保存请求重放：拒绝，脚本没调用" \
    "$(call POST /v1/projects/widget/config --nonce "$NS" --body "{\"rev\":\"$REV\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"3\"}}" | st_err) $(pcfg_calls)" "403 replay get=0 set=0"
after="$(cfg_hash)"
resp="$(save "{\"rev\":\"$REV\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"4\"}}")"
chk "旧指纹（文件读取后已被改过）：写脚本自己拒绝 changed，文件不动" "$(jq -r .body.result <<<"$resp") $(pcfg_calls) $([ "$(cfg_hash)" = "$after" ] && echo same)" "changed get=1 set=1 same"
REV2="$(call GET /v1/projects/widget/config | jq -r .body.config.rev)"
resp="$(save "{\"rev\":\"$REV2\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"3\"}}")"
chk "值没变：unchanged" "$(jq -r .body.result <<<"$resp")" "unchanged"
resp="$(save "{\"rev\":\"$REV2\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"99\"}}")"
chk "超出范围：写脚本按类型拒绝 invalid" "$(jq -r .body.result <<<"$resp") $(pcfg_calls)" "invalid get=1 set=1"
touch "$SANDBOX/pcfg-crash"
resp="$(save "{\"rev\":\"$REV2\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"2\"}}")"
chk "写脚本没给出最终结果：unconfirmed（不说已保存、也不说没写）" "$(jq -r '"\(.signed) \(.body.result)"' <<<"$resp") $(pcfg_calls)" "true unconfirmed get=1 set=1"
rm -f "$SANDBOX/pcfg-crash"
resp="$(cl call POST /v1/projects/nosuch/config --id "$ID" --key "$KEY" --body "{\"rev\":\"$REV2\",\"values\":{\"MAX_CONCURRENT_WORKERS\":\"2\"}}")"
chk "别的项目：保存前读不到，拒绝" "$(jq -r .body.result <<<"$resp")" "refused"

# 请求体规则和客户端后端是同一条：两边读同一张样例表（客户端那边在 daemon_config.rs 的测试里）
shape="$(python3 - "$SKILL/scripts/remote-access/remote_access.py" "$REPO_DIR/tests/fixtures/config-request-shapes.json" <<'PY'
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("ra", sys.argv[1]); ra = importlib.util.module_from_spec(spec); spec.loader.exec_module(ra)
t = json.load(open(sys.argv[2], encoding="utf-8"))
rev, name, val = "a" * 64, "MAX_CONCURRENT_WORKERS", "2"
wrong, n = [], 0
for kind, make in (("settings", lambda v: (rev, {v: val})), ("values", lambda v: (rev, {name: v})), ("revs", lambda v: (v, {name: val}))):
    for want, lst in ((True, "ok"), (False, "bad")):
        for v in t[kind][lst]:
            n += 1
            if (ra.config_request_problem(*make(v)) is None) != want:
                wrong.append("%s %r" % (kind, v))
print(n, wrong)
PY
)"
chk "远程入口对样例表的判断：全部对（客户端后端读同一张表）" "$(cut -d' ' -f2- <<<"$shape")" "[]"
chk "样例表确实读到了" "$(( $(cut -d' ' -f1 <<<"$shape") > 30 ))" 1
rm -f "$PCFG"; mv "$SKILL/scripts/project-config.real.sh" "$PCFG"

echo "── 8. 撤销 ──"
resp2="$(cl pair "$(pair_code)" second-mac)"; ID2="$(jq -r .body.id <<<"$resp2")"; KEY2="$(jq -r .body.key <<<"$resp2")"
chk "撤销前第二台能读状态" "$(cl call GET /v1/status --id "$ID2" --key "$KEY2" | jq -r .status)" 200
ra Linux -- revoke second-mac
chk_has "命令行按设备名撤销" "$rc $out" "0 ✓ 已撤销：second-mac"
chk "撤销后立刻被拒" "$(cl call GET /v1/status --id "$ID2" --key "$KEY2" | st_err)" "401 revoked"
chk "没撤销的那台不受影响" "$(call GET /v1/status | jq -r .status)" 200
ra Linux -- revoke nobody
chk "撤销不存在的设备：退出 1" "$rc" 1
resp="$(call POST /v1/unpair)"
chk "客户端自己撤销：成功，回复带签名（对面凭它确认真撤了）" "$(jq -r '"\(.status) \(.body.result) \(.signed)"' <<<"$resp")" "200 revoked true"
chk "自己撤销后：设备清单里没有它了，旧钥匙被拒" "$(jq length "$RA_STATE/devices.json") $(call GET /v1/status | st_err)" "0 401 revoked"

echo "── 9. 关闭 ──"
fresh_world
ra Linux -- pair
chk_has "pair：入口没开时先打开，再给出机器名和配对码" "$rc $out" "机器名：box.tailnet.ts.net"
chk "pair：最后一行是 RESULT=code，配对码是 8 位数字" "$(tail -1 <<<"$out") $(grep -cE '配对码：[0-9]{4} [0-9]{4}$' <<<"$out")" "RESULT=code 1"
chk "pair 之后入口是开着的" "$(cat "$FAKE_SD/$UNIT.active") $(mapping | jq 'length')" "active 1"
# 给桌面客户端读的行（GitHub#387 简化配对）：和给人看的那几行说的是同一件事
code_shown="$(grep -oE '配对码：[0-9]{4} [0-9]{4}$' <<<"$out" | tr -dc 0-9)"
exp="$(sed -n 's/^EXPIRES=//p' <<<"$out")"; now_s="$(date +%s)"
chk "pair：CODE= 就是给人看的那个码，HOST= 就是那台机器名，EXPIRES= 在 10 分钟后" \
    "$(sed -n 's/^CODE=//p' <<<"$out") $(sed -n 's/^HOST=//p' <<<"$out") $(( exp >= now_s + 590 && exp <= now_s + 610 ))" "$code_shown box.tailnet.ts.net 1"
chk "pair：等待中的码只有一个，失效时刻和 EXPIRES= 一致" "$(jq -r .expires "$RA_STATE/pairing.json")" "$exp"
ra Linux -- pair-cancel
chk "pair-cancel：成功，等待中的码删掉了" "$rc $(tail -1 <<<"$out") $([ -e "$RA_STATE/pairing.json" ] && echo still)" "0 RESULT=cancelled "
ra Linux -- pair-cancel
chk "pair-cancel：没有等待中的码也算成功" "$rc $(tail -1 <<<"$out")" "0 RESULT=cancelled"
ra Linux -- status
chk "status：给客户端读的行（机器名、端口、配对台数）" "$(grep -E '^(HOST|PORT|DEVICES)=' <<<"$out" | tr '\n' ' ')$(tail -1 <<<"$out")" "HOST=box.tailnet.ts.net PORT=47387 DEVICES=0 RESULT=open"
ra Linux -- list --machine
chk "list --machine：没有设备时只有 RESULT=ok" "$rc $out" "0 RESULT=ok"
jq -n '[{id:"0123456789abcdef", name:"MacBook", node:"n1", node_name:"macbook", key:"00", paired_at:1}]' > "$RA_STATE/devices.json"
ra Linux -- list --machine
chk "list --machine：一台一行 DEVICE=编号<tab>设备名<tab>Tailscale 设备<tab>时间" "$rc $(head -1 <<<"$out" | cut -f1-3 | tr '\t' '|') $(tail -1 <<<"$out")" "0 DEVICE=0123456789abcdef|MacBook|macbook RESULT=ok"
ra Linux -- status
chk "status：配对台数跟着清单走" "$(sed -n 's/^DEVICES=//p' <<<"$out")" 1
echo '{not json' > "$RA_STATE/devices.json"
ra Linux -- status
chk "status：设备清单读不懂时 DEVICES=unknown，不是 0" "$(sed -n 's/^DEVICES=//p' <<<"$out") $(grep -c '已配对设备：读不到' <<<"$out")" "unknown 1"
ra Linux -- list --machine
chk "list --machine：清单读不懂时退出 2，没有 RESULT=ok" "$rc $(grep -c 'RESULT=ok' <<<"$out")" "2 0"
rm -f "$RA_STATE/devices.json"
jq -n '[{id:"aa", name:"kept-mac", node:"n1", node_name:"kept", key:"00", paired_at:1}]' > "$RA_STATE/devices.json"
ra Linux FAKE_SD_MODE=fail -- disable
chk "关闭时后台任务状态读不到：退出 2，转发和服务文件都还在" "$rc $(tail -1 <<<"$out") $(mapping | jq 'length') $([ -e "$H/.config/systemd/user/$UNIT" ] && echo unit)" "2 RESULT=unknown 1 unit"
ra Linux FAKE_TS_SERVE_STATUS=fail -- disable
chk "关闭时转发设置读不到：退出 2，什么都没动" "$rc $(tail -1 <<<"$out") $(cat "$FAKE_SD/$UNIT.active")" "2 RESULT=tailscale_unknown active"
n_reads="$(ts_calls '^serve status')"
ra Linux FAKE_TS_SERVE_STATUS=blank -- disable
chk "关闭时转发查询没有输出：退出 2，服务还在跑、转发没动、没有发撤销" "$rc $(tail -1 <<<"$out") $(cat "$FAKE_SD/$UNIT.active") $(mapping | jq length) $(ts_calls 'off$') $(( $(ts_calls '^serve status') > n_reads ))" \
    "2 RESULT=tailscale_unknown active 1 0 1"
n_bg="$(ts_calls '^serve --bg')"
ra Linux FAKE_TS_SERVE_STATUS=blank -- pair
chk "生成配对码时转发查询没有输出：退出 2，不给配对码、不登记转发" "$rc $(tail -1 <<<"$out") $(grep -c '配对码：' <<<"$out") $(ts_calls '^serve --bg')" "2 RESULT=tailscale_unknown 0 $n_bg"
ra Linux FAKE_TS_SERVE_OFF=stuck -- disable
chk "转发撤不掉：退出 3，如实说还剩什么" "$rc $(tail -1 <<<"$out")" "3 RESULT=partial"
chk_has "转发撤不掉：给出要人跑的命令" "$out" "sudo tailscale serve --https=47387 off"
ra Linux -- disable
chk "关闭：成功" "$rc $(tail -1 <<<"$out")" "0 RESULT=disabled"
chk "关闭后：服务停了、不再自启、服务文件删了、转发撤了、等待中的配对码清了" \
    "$(cat "$FAKE_SD/$UNIT.active") $(cat "$FAKE_SD/$UNIT.enabled") $([ -e "$H/.config/systemd/user/$UNIT" ] && echo unit) $(mapping) $([ -e "$RA_STATE/pairing.json" ] && echo code)" \
    "inactive disabled  {} "
chk "关闭后：已配对设备清单保留" "$(jq -r '.[0].name' "$RA_STATE/devices.json")" kept-mac
ra Linux -- status
chk "关闭后状态：closed" "$(tail -1 <<<"$out")" "RESULT=closed"

echo "── 9b. 本功能自己的记录读不懂：不是「没有」，每个命令都停下、什么都不动 ──"
# 起点：默认端口打开过、换到 47999（清单里只剩 47999），旁边有一条别的功能的转发
ledger_world() {
    fresh_world
    jq -n '{TCP:{"3000":{HTTPS:true}}, Web:{"box.tailnet.ts.net:3000":{Handlers:{"/":{Proxy:"http://127.0.0.1:3000"}}}}}' > "$FAKE_TS/serve.json"
    ra Linux -- enable; ra Linux -- enable --port 47999
    : > "$FAKE_TS/calls"
}
web_keys() { jq -r '.Web // {} | keys | join(",")' "$FAKE_TS/serve.json"; }
writes() { ts_calls '^serve --(bg|https)'; }
BOTH="box.tailnet.ts.net:3000,box.tailnet.ts.net:47999"
ledger_world
chk "起点：清单里是 47999，转发是它和别的功能那条" "$(cat "$RA_STATE/ports") $(web_keys)" "47999 $BOTH"
# 两种读不懂：内容不是端口号；位置上是个目录（谁都读不了，不依赖运行测试的账号有没有权限）
break_ledger() {   # <corrupt|unreadable|mixed>
    rm -rf "$RA_STATE/ports"
    case "$1" in
        corrupt)    echo corrupted > "$RA_STATE/ports" ;;
        unreadable) mkdir "$RA_STATE/ports" ;;
        mixed)      printf '47999\nnot-a-port\n' > "$RA_STATE/ports" ;;   # 有一行认得、有一行不认得：整份都不算数
    esac
}
ledger_sig() { if [ -d "$RA_STATE/ports" ]; then echo DIR; else cat "$RA_STATE/ports"; fi; }
for kind in corrupt unreadable mixed; do
    break_ledger "$kind"; before="$(ledger_sig)"; : > "$FAKE_TS/calls"
    for cmd in "disable" "enable" "enable --port 48222" "pair"; do
        # shellcheck disable=SC2086
        ra Linux -- $cmd
        chk "清单读不懂（$kind）时 $cmd：退出 2，RESULT=state_unknown" "$rc $(tail -1 <<<"$out")" "2 RESULT=state_unknown"
    done
    chk "…（$kind）四个命令之后：服务还在跑、转发原样、没有任何登记 / 撤销、清单没被覆盖" \
        "$(cat "$FAKE_SD/$UNIT.active") $(web_keys) $(writes) $(ledger_sig)" "active $BOTH 0 $before"
    chk_has "…（$kind）说明是哪份记录、怎么处理" "$out" "$RA_STATE/ports"
    ra Linux -- status
    chk "…（$kind）状态：unknown，不报 closed 也不报 open" "$rc $(tail -1 <<<"$out")" "0 RESULT=unknown"
done
# 修好清单后重新关闭：成功，本功能的转发撤掉，别的功能的还在
rm -rf "$RA_STATE/ports"; echo 47999 > "$RA_STATE/ports"
ra Linux -- disable
chk "清单修好后再关闭：成功，本功能的转发撤掉，别的功能的转发还在" "$rc $(tail -1 <<<"$out") $(web_keys)" "0 RESULT=disabled box.tailnet.ts.net:3000"
ra Linux -- status
chk "…状态：closed" "$(tail -1 <<<"$out")" "RESULT=closed"

# 明确的「没有记录」和「空清单」是另一回事：照常关闭，不动别人的转发
ledger_world; ra Linux -- disable
: > "$RA_STATE/ports"
ra Linux -- disable
chk "空清单：照常关闭（没有本功能的转发要撤），不动别的转发" "$rc $(tail -1 <<<"$out") $(web_keys)" "0 RESULT=disabled box.tailnet.ts.net:3000"
rm -f "$RA_STATE/ports"
ra Linux -- disable
chk "没有清单文件：同上" "$rc $(tail -1 <<<"$out") $(web_keys)" "0 RESULT=disabled box.tailnet.ts.net:3000"
ra Linux -- enable
chk "…之后照常能打开" "$rc $(tail -1 <<<"$out") $(cat "$RA_STATE/ports")" "0 RESULT=enabled 47999"

# 当前端口那份记录读不懂：不带 --port 的打开和生成配对码停下；带 --port 的打开、关闭不受影响
ledger_world
echo garbage > "$RA_STATE/port"; : > "$FAKE_TS/calls"
ra Linux -- enable
chk "当前端口记录读不懂时 enable（没说端口）：退出 2，不退回默认端口去登记" "$rc $(tail -1 <<<"$out") $(writes)" "2 RESULT=state_unknown 0"
ra Linux -- pair
chk "…pair：退出 2，不给配对码" "$rc $(tail -1 <<<"$out") $(grep -c '配对码：' <<<"$out")" "2 RESULT=state_unknown 0"
ra Linux -- status
chk "…status：unknown" "$(tail -1 <<<"$out")" "RESULT=unknown"
ra Linux -- enable --port 47999
chk "…enable --port（明说端口）：成功，记录重写" "$rc $(tail -1 <<<"$out") $(cat "$RA_STATE/port")" "0 RESULT=enabled 47999"
echo garbage > "$RA_STATE/port"
ra Linux -- disable
chk "…关闭用不着这份记录：成功，本功能的转发撤掉" "$rc $(tail -1 <<<"$out") $(web_keys)" "0 RESULT=disabled box.tailnet.ts.net:3000"

# 清单写不进去
fresh_world; mkdir -p "$RA_STATE/ports.tmp"
ra Linux -- enable
chk "登记前清单写不进去：退出 2，没有登记转发、没有起服务" "$rc $(tail -1 <<<"$out") $(writes) $(cat "$FAKE_SD/$UNIT.active" 2>/dev/null)" "2 RESULT=state_unwritable 0 "
rmdir "$RA_STATE/ports.tmp"
ra Linux -- enable
chk "修好后打开成功" "$rc $(tail -1 <<<"$out")" "0 RESULT=enabled"
mkdir "$RA_STATE/ports.tmp"
ra Linux -- disable
chk "关闭时转发撤掉了、但清单写不回去：退出 3，不报已关闭" "$rc $(tail -1 <<<"$out") $(mapping) $(cat "$RA_STATE/ports")" "3 RESULT=partial {} 47387"
chk_has "…说明还差什么" "$out" "端口清单没能写回"
rmdir "$RA_STATE/ports.tmp"
ra Linux -- disable
chk "修好后再关闭：成功，清单清空" "$rc $(tail -1 <<<"$out") $(wc -l < "$RA_STATE/ports")" "0 RESULT=disabled 0"

# 已配对设备清单读不懂：不报「0 台」「没有设备」
fresh_world; ra Linux -- enable
echo '{broken' > "$RA_STATE/devices.json"
ra Linux -- status
chk_has "设备清单读不懂时 status：写「读不到」" "$out" "已配对设备：读不到"
chk_lacks "…不写 0 台" "$out" "0 台"
ra Linux -- list
chk "…list：退出 2，不说「还没有配对过的设备」" "$rc $(grep -c '还没有配对过' <<<"$out")" "2 0"
ra Linux -- revoke someone
chk "…revoke：退出 2（不是「没有这台设备」的 1），文件没被改写" "$rc $(cat "$RA_STATE/devices.json")" "2 {broken"

echo "── 10. 文档里的命令按字面跑通 ──"
doc_block() {
    awk -v b="<!-- $2:begin -->" -v e="<!-- $2:end -->" '$0==b{f=1;next} $0==e{f=0} f' "$REPO_DIR/docs/$1" \
        | awk '/^```bash$/{f=1;next} /^```$/{f=0} f'
}
doc_block operations.md remote-access-ops > "$SANDBOX/doc.sh"
chk "中英两份文档里的命令一字不差" "$(doc_block operations.zh.md remote-access-ops)" "$(cat "$SANDBOX/doc.sh")"
chk "命令块非空" "$(grep -c . "$SANDBOX/doc.sh" | awk '{print ($1>3)}')" 1
fresh_world; mkdir -p "$H/.agents/skills"; ln -s "$SKILL" "$H/.agents/skills/cavil-loop"
ra Linux -- enable
chk "装在稳定入口下时：服务文件指向稳定入口（不是软链背后的某个版本目录）" \
    "$rc $(grep -c "^ExecStart=.* $H/.agents/skills/cavil-loop/scripts/remote-access/remote_access.py serve " "$H/.config/systemd/user/$UNIT")" "0 1"
ra Linux -- disable
jq -n '[{id:"aa11", name:"MacBook-Pro", node:"n1", node_name:"macbook-pro", key:"00", paired_at:1}]' > "$SANDBOX/dev.json"
mkdir -p "$RA_STATE" && cp "$SANDBOX/dev.json" "$RA_STATE/devices.json"
rc=0; out="$(env -i HOME="$H" PATH="$FK/bin:$SYS_PATH" FAKE_UNAME=Linux FAKE_SD="$FAKE_SD" FAKE_LD="$FAKE_LD" FAKE_TS="$FAKE_TS" bash -euo pipefail "$SANDBOX/doc.sh" 2>&1)" || rc=$?
chk "打开 → 配对码 → 状态 → 列出 → 撤销 → 关闭：空环境下跑完、退出 0" "$rc" 0
chk_has "文档流程：给出了配对码" "$out" "配对码："
chk_has "文档流程：状态是开着的" "$out" "RESULT=open"
chk_has "文档流程：撤销了那台设备" "$out" "✓ 已撤销：MacBook-Pro"
chk "文档流程：最后一行是关闭成功" "$(tail -1 <<<"$out")" "RESULT=disabled"
chk "文档流程跑完：没有服务文件、没有转发、设备已撤销" "$([ -e "$H/.config/systemd/user/$UNIT" ] && echo unit) $(mapping) $(jq length "$RA_STATE/devices.json")" " {} 0"

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
