#!/usr/bin/env bash
# 远程入口的开关与配对（GitHub#387）：让配对过的桌面客户端经 Tailscale 看 / 停启这台机器上的 daemon。
#
# 用法：
#   bash scripts/remote-access.sh pair              生成一个配对码（入口还没开就先打开；新码顶替旧码）
#   bash scripts/remote-access.sh pair-cancel       作废等待中的配对码
#   bash scripts/remote-access.sh enable [--port N] 打开入口：登记 Tailscale 转发 + 启动常驻服务
#   bash scripts/remote-access.sh status            入口开没开、转发在不在、配对了几台设备
#   bash scripts/remote-access.sh list [--machine]  列出已配对设备（--machine：给桌面客户端读的 DEVICE= 行）
#   bash scripts/remote-access.sh revoke <设备名或编号>   撤销一台设备（立刻生效）
#   bash scripts/remote-access.sh disable           关闭入口：停服务 + 撤掉转发（已配对设备清单保留）
#   bash scripts/remote-access.sh auto-restart      （轮询每轮调用，不给人用）代码更新后入口还在跑旧代码时重启它（GitHub#533）
#
# 默认是关的：不跑 enable / pair 就没有任何监听、没有任何转发。打开时：
#   · 常驻服务只监听 127.0.0.1:<端口>（默认 47387）；
#   · 对外只经 `tailscale serve`（HTTPS，仅本 Tailscale 网络）转给它——不开公网入口（funnel），
#     发现这个端口上开着公网入口就拒绝打开。
# 前提：这台机器的 Tailscale 已连上、所在网络开了 HTTPS 证书功能；登记转发需要管理员权限
# （当前用户是 Tailscale 的操作者，或 sudo 免密）。缺哪一条就报出来并停下，不留半开的入口。
#
# 每一步只认已知结果：Tailscale / 后台任务状态读不到时不当成「没开」，什么都不动。
# 退出码：0 = 成功；1 = 用法错误 / 没有这台设备；2 = 前提不满足或状态读不到，什么都没动；3 = 做了一半，输出里写明剩下什么。
# enable / disable / pair / pair-cancel / status 的最后一行固定是 RESULT=<...>。
# 给桌面客户端读的行（GitHub#387 简化配对）：status 另给 HOST= / PORT= / DEVICES=（数字，读不到是 unknown），
# pair 另给 HOST= / CODE= / EXPIRES=（失效时刻，秒）。HOST= 只在读到机器名时出现。
# status 在服务运行时另给 ENTRY_CODE=same|differs|unknown（入口在跑的代码和磁盘上的比，GitHub#533）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_names.sh
source "$SCRIPT_DIR/_names.sh"
# shellcheck source=_install.sh
source "$SCRIPT_DIR/_install.sh"

STATE="$CAVIL_REMOTE_ACCESS_HOME"
PY="$SCRIPT_DIR/remote-access/remote_access.py"
OS="$(uname -s 2>/dev/null || true)"

result() { echo "RESULT=$1"; exit "$2"; }
usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }

# 常驻服务启动的是「稳定入口」下的脚本（按版本部署时它是指向当前版本的软链），不是本次运行所在的版本目录：
# 版本目录会被清理，写死它的话入口过几天就起不来了。入口不存在（开发副本直接跑）才用脚本自己的位置。
stable_skill() {
    local link; link="$(cavil_skill_link)"
    if [ -f "$link/scripts/remote-access/remote_access.py" ]; then printf '%s\n' "$link"; else (cd "$SCRIPT_DIR/.." && pwd -P); fi
}

# ── 本功能自己的两份记录：三态读取 ──
# 「没有这份文件」和「文件在但读不了 / 读不懂」是两回事：前者是明确的「没有」，后者是「不知道」。
# 不知道本功能登记过哪些转发时，不能确认关闭、不能判断一条转发归谁、也不能覆盖这份记录——
# 所以每个命令先 state_load，bad 就停下（state_require），什么都不动。
#   $STATE/ports  本功能登记过转发的端口，一行一个（清单）。LEDGER=none|ok|bad，OWNED=(端口…)
#   $STATE/port   常驻服务现在用的端口，恰好一行。        PORT_STATE=none|ok|bad，CUR_PORT
valid_port() { [[ "$1" =~ ^[0-9]{4,5}$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]; }

state_load() {
    local line content
    LEDGER=none; OWNED=()
    if [ -e "$STATE/ports" ] || [ -L "$STATE/ports" ]; then
        if content="$(cat "$STATE/ports" 2>/dev/null)"; then
            LEDGER=ok
            while IFS= read -r line; do
                if valid_port "$line"; then OWNED+=("$line"); else LEDGER=bad; fi
            done < <(printf '%s\n' "$content" | sed '/^$/d')
        else
            LEDGER=bad
        fi
        [ "$LEDGER" = ok ] || OWNED=()
    fi
    PORT_STATE=none; CUR_PORT="$CAVIL_REMOTE_ACCESS_PORT"
    if [ -e "$STATE/port" ] || [ -L "$STATE/port" ]; then
        if content="$(cat "$STATE/port" 2>/dev/null)" && valid_port "$content"; then
            PORT_STATE=ok; CUR_PORT="$content"
        else
            PORT_STATE=bad
        fi
    fi
}

state_bad_message() {
    [ "$LEDGER" = bad ] && echo "读不懂本功能登记过哪些端口的记录：$STATE/ports（读不了，或有一行不是端口号）。"
    [ "$PORT_STATE" = bad ] && echo "读不懂常驻服务当前端口的记录：$STATE/port（读不了，或不是一个端口号）。"
    echo "不知道哪些转发是本功能的，所以什么都没动。处理办法：用 tailscale serve status 核对后，"
    echo "把 $STATE/ports 改成每行一个本功能登记过的端口（一个都没有就删掉这个文件），"
    echo "把 $STATE/port 改成当前端口（不确定就删掉，下次打开用默认端口或 --port 指定），再重跑。"
}

state_require() {   # 两份记录有一份读不懂就停下
    if [ "$LEDGER" = bad ] || [ "$PORT_STATE" = bad ]; then state_bad_message; result state_unknown 2; fi
}

need_cmds() {
    local c missing=""
    for c in python3 tailscale jq; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done
    if [ -n "$missing" ]; then
        echo "缺少程序：$missing —— 装好后再试，什么都没动"
        result missing_tools 2
    fi
}

# ── Tailscale：只认读得懂的输出 ──
# ts_identity：写 TS_HOST（这台机器的完整机器名，证书就是发给它的）。连不上 / 没开证书功能 → 说明原因并退出 2。
ts_identity() {
    local js
    if ! js="$(tailscale status --json 2>&1)" || ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$js"; then
        echo "读不到 Tailscale 的状态，什么都没动。读到的原文："
        printf '%s\n' "$js" | head -5 | sed 's/^/  /'
        result tailscale_unknown 2
    fi
    if [ "$(jq -r '.BackendState // ""' <<<"$js")" != Running ]; then
        echo "这台机器的 Tailscale 没有连上（状态：$(jq -r '.BackendState // "读不出"' <<<"$js")），什么都没动"
        result tailscale_down 2
    fi
    TS_HOST="$(jq -r '(.CertDomains // [])[0] // ""' <<<"$js")"
    if ! [[ "$TS_HOST" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.ts\.net$ ]]; then
        echo "这台机器所在的 Tailscale 网络没有开 HTTPS 证书功能（读不到证书域名），什么都没动。"
        echo "在 Tailscale 管理后台 DNS 页打开 MagicDNS 和 HTTPS Certificates 后再试。"
        result no_https 2
    fi
}

# ts_mapping <端口>：写 TS_MAP=ours|absent|other|funnel|unknown
#   ours   这个端口的 HTTPS 转发正指向 127.0.0.1:<端口>、没开公网入口，**而且这个端口登记在本功能名下**
#          （$STATE/ports）。只看形状不够：按需预览登记的转发也是「端口 → 本机同一端口」，认错了
#          就会在关闭时撤掉别人的转发
#   absent 这个端口上没有转发
# 调用前必须已经 state_load 且清单不是 bad（归属要查清单）。
#   other  这个端口上有别的转发（不是本功能的）
#   funnel 这个端口开着公网入口
#   unknown 读不到 / 读不懂
ts_mapping() {
    local p="$1" js
    TS_MAP=unknown
    js="$(tailscale serve status --json 2>/dev/null)" || return 0
    # 退出 0 却什么都没输出 = 没读到，不是「没有转发」（明确的空配置是 {}）
    [ -n "${js//[[:space:]]/}" ] || return 0
    TS_MAP="$(jq -r --arg hp "$TS_HOST:$p" --arg target "http://127.0.0.1:$p" '
        if type != "object" then "unknown"
        elif (.AllowFunnel // {})[$hp] == true then "funnel"
        else ((.Web // {})[$hp].Handlers // null) as $h
          | if $h == null then (if ((.TCP // {})[($hp | split(":") | last)] // null) == null then "absent" else "other" end)
            elif ($h | keys) == ["/"] and $h["/"].Proxy == $target then "ours"
            else "other" end
        end' <<<"$js" 2>/dev/null || echo unknown)"
    [ -n "$TS_MAP" ] || TS_MAP=unknown
    if [ "$TS_MAP" = ours ] && ! owns_port "$p"; then TS_MAP=other; fi
}

# ── 本功能登记过哪些端口的转发（$STATE/ports，一行一个）──
# 登记转发**之前**先记下，撤掉并读回确认之后才划掉：中途被打断时宁可多记一个（下次再核对），
# 不漏记一个（那条转发就没人撤了）。换端口、关闭都按这份清单收尾。
owns_port() { local q; for q in ${OWNED[@]+"${OWNED[@]}"}; do [ "$q" = "$1" ] && return 0; done; return 1; }
ledger_write() {   # 把 OWNED 原子地写回去；写不进去返回非 0（内存里的 OWNED 这时仍是想写的内容）
    mkdir -p "$STATE" 2>/dev/null && chmod 700 "$STATE" 2>/dev/null || return 1
    { [ ${#OWNED[@]} -eq 0 ] || printf '%s\n' "${OWNED[@]}"; } > "$STATE/ports.tmp" 2>/dev/null || return 1
    mv "$STATE/ports.tmp" "$STATE/ports" 2>/dev/null
}
own_add() { owns_port "$1" && return 0; OWNED+=("$1"); ledger_write; }
own_drop() {   # 划掉一个端口；写不进去记一笔 LEDGER_UNSAVED，由调用方在最后报「没做完」
    local q keep=()
    for q in ${OWNED[@]+"${OWNED[@]}"}; do [ "$q" = "$1" ] || keep+=("$q"); done
    OWNED=(${keep[@]+"${keep[@]}"})
    ledger_write || LEDGER_UNSAVED=1
}
LEDGER_UNSAVED=0

# release_port <端口>：撤掉本功能在这个端口上的转发。写 REL=
#   gone     已撤掉并读回确认（或本来就没有了），从清单划掉
#   foreign  端口上现在是别的转发 / 公网入口：不是本功能的了，不动它，从清单划掉
#   stuck    撤了但读回还在，留在清单里
#   unknown  读不到，什么都没动，留在清单里
release_port() {
    local p="$1"
    ts_mapping "$p"
    case "$TS_MAP" in
        unknown) REL=unknown; return 0 ;;
        absent)  own_drop "$p"; REL=gone; return 0 ;;
        other|funnel) own_drop "$p"; REL=foreign; return 0 ;;
    esac
    ts_serve "$p" off || true
    ts_mapping "$p"
    case "$TS_MAP" in
        absent) own_drop "$p"; REL=gone ;;
        unknown) REL=unknown ;;
        *) REL=stuck ;;
    esac
}

ts_serve() {   # <端口> on|off → 跑转发登记 / 撤销；先不带 sudo，不行再 sudo -n
    local p="$1" args
    if [ "$2" = on ]; then args=(serve --bg --https="$p" "http://127.0.0.1:$p"); else args=(serve --https="$p" off); fi
    TS_SERVE_OUT="$(tailscale "${args[@]}" 2>&1)" && return 0
    if command -v sudo >/dev/null 2>&1; then
        TS_SERVE_OUT="$TS_SERVE_OUT"$'\n'"$(sudo -n tailscale "${args[@]}" 2>&1)" && return 0
    fi
    return 1
}

# ── 常驻服务（后台任务）──
# svc_probe：写 SVC_STATE=running|stopped|unknown
svc_probe() {
    case "$OS" in
        Linux)
            cavil_systemd_probe "$CAVIL_REMOTE_ACCESS_UNIT"; SVC_STATE="$CAVIL_SCHED_STATE" ;;
        Darwin)
            cavil_launchd_probe "$CAVIL_REMOTE_ACCESS_LABEL"
            case "$CAVIL_SCHED_STATE" in loaded) SVC_STATE=running ;; unloaded) SVC_STATE=stopped ;; *) SVC_STATE=unknown ;; esac ;;
        *) SVC_STATE=unknown; CAVIL_SCHED_RAW="不支持的系统：${OS:-读不到}" ;;
    esac
}

svc_file() {
    case "$OS" in
        Linux)  printf '%s\n' "$HOME/.config/systemd/user/$CAVIL_REMOTE_ACCESS_UNIT" ;;
        Darwin) printf '%s\n' "$HOME/Library/LaunchAgents/$CAVIL_REMOTE_ACCESS_LABEL.plist" ;;
    esac
}

svc_install_and_start() {   # <端口>
    local p="$1" skill py file out
    skill="$(stable_skill)"; py="$(command -v python3)"; file="$(svc_file)"
    mkdir -p "$(dirname "$file")" "$STATE"; chmod 700 "$STATE"
    case "$OS" in
        Linux)
            cat > "$file" <<UNIT
[Unit]
Description=cavil-loop remote access (Tailscale only, GitHub#387)
Documentation=https://github.com/GigleAI/cavil-loop

[Service]
ExecStart=$py $skill/scripts/remote-access/remote_access.py serve --state $STATE --port $p --skill $skill
Environment="PATH=$PATH"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
            systemctl --user daemon-reload >/dev/null 2>&1 || true
            # 先停再起：端口或版本变了时，换上新写的那份
            systemctl --user stop "$CAVIL_REMOTE_ACCESS_UNIT" >/dev/null 2>&1 || true
            out="$(systemctl --user enable --now "$CAVIL_REMOTE_ACCESS_UNIT" 2>&1)" || true
            ;;
        Darwin)
            mkdir -p "$HOME/Library/Logs/cavil-loop"
            cat > "$file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$CAVIL_REMOTE_ACCESS_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$py</string>
        <string>$skill/scripts/remote-access/remote_access.py</string>
        <string>serve</string>
        <string>--state</string><string>$STATE</string>
        <string>--port</string><string>$p</string>
        <string>--skill</string><string>$skill</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>$PATH</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$HOME/Library/Logs/cavil-loop/remote-access.log</string>
    <key>StandardErrorPath</key><string>$HOME/Library/Logs/cavil-loop/remote-access.log</string>
</dict>
</plist>
PLIST
            launchctl bootout "gui/$(id -u)/$CAVIL_REMOTE_ACCESS_LABEL" >/dev/null 2>&1 || true
            out="$(launchctl bootstrap "gui/$(id -u)" "$file" 2>&1)" || true
            ;;
    esac
    SVC_OUT="${out:-}"
}

svc_stop_and_remove() {
    local file; file="$(svc_file)"
    case "$OS" in
        Linux)  SVC_OUT="$(systemctl --user disable --now "$CAVIL_REMOTE_ACCESS_UNIT" 2>&1)" || true ;;
        Darwin) SVC_OUT="$(launchctl bootout "gui/$(id -u)/$CAVIL_REMOTE_ACCESS_LABEL" 2>&1)" || true ;;
    esac
    svc_probe
    [ "$SVC_STATE" = stopped ] || return 1
    rm -f "$file"
    [ "$OS" = Linux ] && { systemctl --user daemon-reload >/dev/null 2>&1 || true; }
    return 0
}

DEVICE_N=unknown
device_count() {   # 「N 台」或「读不到」——清单读不懂时不报 0 台；数字同时留在 DEVICE_N（读不到 = unknown）
    local rows
    if rows="$(python3 "$PY" list --state "$STATE" 2>/dev/null)"; then
        DEVICE_N="$(printf '%s' "$rows" | grep -c . || true)"; echo "$DEVICE_N 台"
    else
        DEVICE_N=unknown; echo "读不到"
    fi
}

# ── 一把锁：改服务状态的命令依次来（GitHub#533）──
# enable、disable 和轮询的自动重启都要先拿它，整个「读状态 → 改服务 → 读回」过程不放。不然轮询刚读到
# 「在运行、代码不同」，人就关了入口，轮询再发的重启会把刚停的服务又起起来。锁跟着进程：持锁的进程怎么
# 退出（正常、被杀、崩溃），操作系统都会放掉它，不留死锁。fd 8 固定（macOS 的 bash 3.2 没有 {变量} 写法）。
SVC_LOCKED=0
svc_lock() {   # <等几秒> | now → 拿到返回 0
    [ "$SVC_LOCKED" = 1 ] && return 0
    { mkdir -p "$STATE" && chmod 700 "$STATE"; } 2>/dev/null || return 1
    exec 8>>"$STATE/svc.lock" 2>/dev/null || return 1
    if [ "$1" = now ]; then flock -n 8 || return 1; else flock -w "$1" 8 || return 1; fi
    SVC_LOCKED=1
}
svc_lock_or_stop() {   # enable / disable 用：最多等 60 秒，等不到就什么都不动
    if ! command -v flock >/dev/null 2>&1; then echo "缺少程序： flock —— 装好后再试，什么都没动"; result missing_tools 2; fi
    svc_lock 60 && return 0
    echo "另有操作正在改远程入口（等了 60 秒，或锁文件 $STATE/svc.lock 打不开），什么都没动；稍后重跑本命令"
    result busy 2
}

# unit_skill：服务登记里写的 skill 目录（--skill 那一项）——服务重启后跑的就是这个目录里的代码。
# 读不到（登记文件不在 / 读不了 / 没有这一项）返回非 0。给人的恢复步骤用的是同一个读法（docs/operations.md）。
unit_skill() {
    local file; file="$(svc_file)"
    [ -f "$file" ] && [ -r "$file" ] || return 1
    case "$OS" in
        Linux)  UNIT_SKILL="$(sed -n 's/.*--skill \([^ ]*\).*/\1/p' "$file" | head -1)" ;;
        Darwin) UNIT_SKILL="$(sed -n 's|.*<string>--skill</string><string>\([^<]*\)</string>.*|\1|p' "$file" | head -1)" ;;
        *) return 1 ;;
    esac
    [ -n "$UNIT_SKILL" ]
}

# code_info <skill 目录>：那份代码的 {level, fingerprint}（一行 JSON）；读不到返回非 0
code_info() {
    local js
    js="$(python3 "$1/scripts/remote-access/remote_access.py" code-info 2>/dev/null)" || return 1
    printf '%s' "$js" | jq -ce 'select(type == "object" and (.level | type == "number") and (.fingerprint | type == "string") and (.fingerprint | test("^[0-9a-f]{64}$"))) | {level, fingerprint}' 2>/dev/null
}

# entry_hello <端口>：正在跑的入口报的身份。写 ENTRY=ours（是本功能的入口）+ ENTRY_FP（没报 = none）+ ENTRY_LEVEL；
# 连不上 / 超时 / 回答认不出 → ENTRY=unknown。只问本机回环，不经 Tailscale。
entry_hello() {
    local js
    ENTRY=unknown; ENTRY_FP=""; ENTRY_LEVEL=""
    js="$(python3 - "$1" <<'PY' 2>/dev/null
import json, sys, urllib.request
with urllib.request.urlopen("http://127.0.0.1:%s/v1/hello" % sys.argv[1], timeout=3) as r:
    print(json.dumps(json.loads(r.read())))
PY
)" || return 0
    # 回答的**整个形状**必须是认得的两种之一，别的一律 unknown（PR #535 复审第 1、2 轮：只看个别字段时，
    # 畸形指纹、缺协议版本、不支持的协议版本都被当成了旧入口）：
    #   old = 恰好 {service, version}，service = cavil-loop-remote、version = 1——GitHub#533 之前的入口就这样回答
    #   new = 恰好 {service, version, level, fingerprint}，version = 1、level 非负整数、fingerprint 64 位十六进制
    local id
    id="$(printf '%s' "$js" | jq -r '
        if type != "object" or .service != "cavil-loop-remote" or (.version | type) != "number" or .version != 1 then "unknown"
        elif (keys == ["service", "version"]) then "old"
        elif (keys == ["fingerprint", "level", "service", "version"])
             and (.fingerprint | type) == "string" and (.fingerprint | test("^[0-9a-f]{64}$"))
             and (.level | type) == "number" and (.level | floor) == .level and .level >= 0
            then "new \(.level) \(.fingerprint)"
        else "unknown" end' 2>/dev/null)" || return 0
    case "$id" in
        old) ENTRY=ours; ENTRY_FP=none; ENTRY_LEVEL=none ;;
        new\ *) ENTRY=ours; read -r _ ENTRY_LEVEL ENTRY_FP <<<"$id" ;;
        *) ENTRY=unknown ;;
    esac
}

# ── 代码更新后的自动重启（GitHub#533）──
# 重启记录 $STATE/restart.json，只在持锁时读写，一份磁盘代码（按指纹）一条：
#   {fingerprint, tries（已发过几次重启）, next（这个时刻之前不再试，秒）, inflight（发重启前写 true）, last（上一次失败的原因）, logged（放弃后最后一次记日志的日期）}
# 发出重启请求不等于完成：只有回环上的入口报出与磁盘相同的指纹才算成功（然后删记录）。失败或结果不明
# 按 RESTART_BACKOFF 退避，同一份代码最多 RESTART_MAX 次；记录读不懂 = 不知道试过几次，不重启。
RESTART_MAX=5
RESTART_BACKOFF=(0 60 120 300 900)   # 第 N 次失败后等多少秒再试（N = 1..4；第 5 次失败后放弃）
ra_now() { if [[ "${CAVIL_REMOTE_FAKE_NOW:-}" =~ ^[0-9]+$ ]]; then echo "$CAVIL_REMOTE_FAKE_NOW"; else date +%s; fi; }
ra_log() { echo "远程入口：$*"; }

# restart_load：写 REC=none|ok|bad 和 REC_*（REC=ok 时）
restart_load() {
    local f="$STATE/restart.json" js
    REC=none; REC_FP=""; REC_TRIES=0; REC_NEXT=0; REC_INFLIGHT=false; REC_LAST=""; REC_LOGGED=""
    [ -e "$f" ] || [ -L "$f" ] || return 0
    if ! js="$(cat "$f" 2>/dev/null)" || ! printf '%s' "$js" | jq -e 'type == "object"
            and (.fingerprint | type == "string") and (.tries | type == "number") and (.tries >= 0)
            and (.next | type == "number") and (.inflight | type == "boolean")' >/dev/null 2>&1; then
        REC=bad; return 0
    fi
    REC=ok
    REC_FP="$(jq -r '.fingerprint' <<<"$js")"
    REC_TRIES="$(jq -r '.tries | floor' <<<"$js")"
    REC_NEXT="$(jq -r '.next | floor' <<<"$js")"
    REC_INFLIGHT="$(jq -r '.inflight' <<<"$js")"
    REC_LAST="$(jq -r '.last // "" | tostring' <<<"$js")"
    REC_LOGGED="$(jq -r '.logged // "" | tostring' <<<"$js")"
}
restart_save() {   # <指纹> <次数> <下次时刻> <inflight> <原因> [<logged>] → 写不进返回非 0
    jq -n --arg fp "$1" --argjson tries "$2" --argjson next "$3" --argjson inflight "$4" --arg last "$5" --arg logged "${6:-}" \
        '{fingerprint:$fp, tries:$tries, next:$next, inflight:$inflight, last:$last, logged:$logged}' > "$STATE/restart.json.tmp" 2>/dev/null \
        && mv "$STATE/restart.json.tmp" "$STATE/restart.json" 2>/dev/null
}
restart_failed() {   # <指纹> <次数> <原因>：记下失败和下次时刻
    local next=0
    if [ "$2" -lt "$RESTART_MAX" ]; then next=$(( $(ra_now) + ${RESTART_BACKOFF[$2]} )); fi
    restart_save "$1" "$2" "$next" false "$3" || ra_log "重启记录写不进（${STATE}/restart.json）"
    if [ "$2" -ge "$RESTART_MAX" ]; then
        ra_log "自动重启已失败 ${RESTART_MAX} 次（最后一次：${3}），不再自动重启；请在这台机器上手动重启：$(restart_hint)"
    else
        ra_log "重启没有换上新代码（第 $2 次，${3}），$(( ${RESTART_BACKOFF[$2]} / 60 )) 分钟后再试"
    fi
}
restart_hint() {
    case "$OS" in
        Linux)  echo "systemctl --user try-restart $CAVIL_REMOTE_ACCESS_UNIT" ;;
        Darwin) echo "launchctl kickstart -k gui/$(id -u)/$CAVIL_REMOTE_ACCESS_LABEL" ;;
    esac
}
# svc_restart：只重启**正在运行**的服务，停着的绝不启动（Linux try-restart；macOS kickstart -k 对已卸载的服务直接失败）
svc_restart() {
    case "$OS" in
        Linux)  SVC_OUT="$(systemctl --user try-restart "$CAVIL_REMOTE_ACCESS_UNIT" 2>&1)" ;;
        Darwin) SVC_OUT="$(launchctl kickstart -k "gui/$(id -u)/$CAVIL_REMOTE_ACCESS_LABEL" 2>&1)" ;;
        *) return 1 ;;
    esac
}
# 等入口换上磁盘上的代码（<指纹>），最多 CAVIL_REMOTE_VERIFY_SECS 秒（默认 10，测试可调到 1–60）
wait_new_code() {
    local secs="${CAVIL_REMOTE_VERIFY_SECS:-10}" i
    [[ "$secs" =~ ^[0-9]+$ ]] && [ "$secs" -ge 1 ] && [ "$secs" -le 60 ] || secs=10
    for ((i = 0; i < secs * 2; i++)); do
        entry_hello "$2"
        [ "$ENTRY" = ours ] && [ "$ENTRY_FP" = "$1" ] && return 0
        sleep 0.5
    done
    return 1
}

cmd_auto_restart() {
    case "$OS" in Linux|Darwin) ;; *) exit 0 ;; esac
    # 没开过远程入口（没有服务登记）：什么都不读，安静退出——绝大多数机器每轮走的是这一行
    [ -e "$(svc_file)" ] || exit 0
    local c
    for c in python3 jq flock; do command -v "$c" >/dev/null 2>&1 || { ra_log "缺少 ${c}，没法检查入口是不是新代码"; exit 0; }; done
    if ! svc_lock now; then ra_log "另有操作正在改远程入口（或锁文件打不开），这一轮不检查"; exit 0; fi
    # 拿到锁之后再读一遍：登记还在、端口记录在、服务在运行、入口确实跑着别的代码——缺一样都不动
    [ -e "$(svc_file)" ] || exit 0
    state_load
    if [ "$PORT_STATE" != ok ]; then
        [ "$PORT_STATE" = bad ] && ra_log "读不懂当前端口的记录（${STATE}/port），这一轮不检查"
        exit 0
    fi
    svc_probe
    case "$SVC_STATE" in
        running) ;;
        stopped) exit 0 ;;   # 人没开或关掉了：不替人打开
        *) ra_log "读不到常驻服务的状态，这一轮不检查"; exit 0 ;;
    esac
    if ! unit_skill; then ra_log "读不到服务登记里的 skill 目录（$(svc_file)），这一轮不检查"; exit 0; fi
    local disk disk_fp
    if ! disk="$(code_info "$UNIT_SKILL")"; then ra_log "读不到 ${UNIT_SKILL} 里入口代码的指纹，这一轮不检查"; exit 0; fi
    disk_fp="$(jq -r '.fingerprint' <<<"$disk")"
    entry_hello "$CUR_PORT"
    if [ "$ENTRY" != ours ]; then ra_log "本机端口 $CUR_PORT 上的入口没有回答（或回答认不出），这一轮不检查"; exit 0; fi
    restart_load
    if [ "$ENTRY_FP" = "$disk_fp" ]; then
        if [ "$REC" != none ]; then rm -f "$STATE/restart.json" 2>/dev/null || ra_log "重启记录删不掉（${STATE}/restart.json）"; fi
        exit 0
    fi
    # 入口跑着别的代码
    if [ "$REC" = bad ]; then
        ra_log "重启记录读不懂（${STATE}/restart.json），不知道试过几次，不重启；删掉这个文件即重新开始自动重启"
        exit 0
    fi
    local tries=0 now
    now="$(ra_now)"
    if [ "$REC" = ok ] && [ "$REC_FP" = "$disk_fp" ]; then
        tries="$REC_TRIES"
        if [ "$REC_INFLIGHT" = true ]; then
            # 上一次发了重启却没走到核对（轮询被中断）：按失败算
            restart_failed "$disk_fp" "$tries" "上一次重启没有做完（轮询中途被中断）"
            exit 0
        fi
        if [ "$tries" -ge "$RESTART_MAX" ]; then
            local today; today="$(date +%Y-%m-%d)"
            if [ "$REC_LOGGED" != "$today" ]; then
                ra_log "自动重启已失败 ${RESTART_MAX} 次（最后一次：${REC_LAST}），入口还在跑旧代码；请在这台机器上手动重启：$(restart_hint)"
                restart_save "$disk_fp" "$tries" 0 false "$REC_LAST" "$today" || true
            fi
            exit 0
        fi
        [ "$now" -ge "$REC_NEXT" ] || exit 0
    fi
    tries=$((tries + 1))
    # 先记下「进行中」：这一轮在重启中途被杀，下一轮也算这一次——次数才封得住顶
    if ! restart_save "$disk_fp" "$tries" 0 true ""; then
        ra_log "重启记录写不进（${STATE}/restart.json），不重启（否则次数没法封顶）"
        exit 0
    fi
    ra_log "入口在跑旧代码（入口 ${ENTRY_FP:0:12}，磁盘 ${disk_fp:0:12}），重启它（第 $tries 次）"
    if ! svc_restart; then
        restart_failed "$disk_fp" "$tries" "重启命令失败：$(printf '%s' "$SVC_OUT" | tr '\n' ' ' | cut -c1-200)"
        exit 0
    fi
    if wait_new_code "$disk_fp" "$CUR_PORT"; then
        rm -f "$STATE/restart.json" 2>/dev/null || ra_log "重启记录删不掉（${STATE}/restart.json）"
        ra_log "已重启，入口换上了磁盘上的代码（${disk_fp:0:12}）"
        exit 0
    fi
    svc_probe
    restart_failed "$disk_fp" "$tries" "重启后入口没有换上新代码（服务状态：${SVC_STATE}）"
    exit 0
}

# restart_status：给 status 用的几行（入口代码与磁盘代码、自动重启的状态）
restart_status() {
    local disk="" disk_fp="" disk_level=""
    if unit_skill && disk="$(code_info "$UNIT_SKILL")"; then
        disk_fp="$(jq -r '.fingerprint' <<<"$disk")"; disk_level="$(jq -r '.level' <<<"$disk")"
    fi
    entry_hello "$1"
    echo "入口代码：$( [ "$ENTRY" = ours ] && echo "级别 ${ENTRY_LEVEL}，指纹 ${ENTRY_FP:0:12}" || echo 读不到 )；磁盘上：$( [ -n "$disk_fp" ] && echo "级别 ${disk_level}，指纹 ${disk_fp:0:12}" || echo 读不到 )"
    if [ "$ENTRY" = ours ] && [ -n "$disk_fp" ]; then
        if [ "$ENTRY_FP" = "$disk_fp" ]; then echo "ENTRY_CODE=same"; else echo "入口在跑旧代码：轮询会自动重启它；要马上换，跑 $(restart_hint)"; echo "ENTRY_CODE=differs"; fi
    else
        echo "ENTRY_CODE=unknown"
    fi
    restart_load
    case "$REC" in
        bad) echo "自动重启记录读不懂（${STATE}/restart.json）：不会自动重启；删掉这个文件即重新开始" ;;
        ok)
            if [ "$REC_TRIES" -ge "$RESTART_MAX" ]; then
                echo "自动重启已失败 ${REC_TRIES} 次（最后一次：${REC_LAST}），不再自动重启；请手动重启：$(restart_hint)"
            elif [ "$REC_TRIES" -gt 0 ]; then
                echo "自动重启已试 ${REC_TRIES} 次没成功（最后一次：${REC_LAST:-进行中}），会再试"
            fi ;;
    esac
}

cmd_enable() {
    local p="" 
    while [ $# -gt 0 ]; do
        case "$1" in
            --port) p="${2:-}"; shift 2 || usage ;;
            *) usage ;;
        esac
    done
    case "$OS" in Linux|Darwin) ;; *) echo "不支持的系统：${OS:-读不到}，什么都没动"; result unsupported 2 ;; esac
    need_cmds
    svc_lock_or_stop
    state_load
    if [ -n "$p" ]; then
        if ! valid_port "$p"; then echo "端口要在 1024–65535 之间"; result bad_port 1; fi
        # 明说了端口：当前端口那份记录读不懂也不碍事（下面会重写它）；清单读不懂仍然不行
        [ "$PORT_STATE" = bad ] && PORT_STATE=none
    else
        p="$CUR_PORT"
    fi
    state_require
    ts_identity
    svc_probe
    if [ "$SVC_STATE" = unknown ]; then
        echo "读不到后台任务状态，什么都没动。读到的原文："
        printf '%s\n' "$CAVIL_SCHED_RAW" | sed 's/^/  /'
        result unknown 2
    fi
    ts_mapping "$p"
    case "$TS_MAP" in
        unknown) echo "读不到 Tailscale 现有的转发设置，什么都没动"; result tailscale_unknown 2 ;;
        funnel)  echo "端口 $p 上开着 Tailscale 的公网入口（funnel）。远程入口只许在本 Tailscale 网络内访问，什么都没动。"
                 echo "换一个端口：bash $0 enable --port <端口>"; result funnel 2 ;;
        other)   echo "端口 $p 上已经有别的 Tailscale 转发，什么都没动。换一个端口：bash $0 enable --port <端口>"; result port_taken 2 ;;
        absent)
            if ! own_add "$p"; then
                echo "记不下本功能要登记的端口（$STATE/ports 写不进去），所以没有登记转发，什么都没动"
                result state_unwritable 2
            fi
            if ! ts_serve "$p" on; then
                # 端口留在清单里：下面请人用管理员权限登记的，就是本功能的这一条，重跑时要认得它
                echo "登记 Tailscale 转发失败（需要管理员权限），入口没有打开。Tailscale 的原话："
                printf '%s\n' "$TS_SERVE_OUT" | sed 's/^/  /'
                echo "请先用管理员权限跑一次下面这条，再重跑本命令："
                echo "  sudo tailscale serve --bg --https=$p http://127.0.0.1:$p"
                result need_admin 2
            fi
            ts_mapping "$p"
            if [ "$TS_MAP" != ours ]; then
                echo "登记了转发，但读回的结果不对（${TS_MAP}）。入口没有打开。"
                release_port "$p"
                [ "$REL" = gone ] || [ "$REL" = foreign ] || echo "  没能确认撤掉（${REL}），请手动核对：tailscale serve status；撤掉用 sudo tailscale serve --https=$p off"
                result failed 3
            fi
            echo "✓ 已登记转发：https://$TS_HOST:$p → 127.0.0.1:${p}（仅本 Tailscale 网络）" ;;
        ours) echo "✓ 转发已在：https://$TS_HOST:$p → 127.0.0.1:${p}（仅本 Tailscale 网络）" ;;
    esac
    if ! { mkdir -p "$STATE" && chmod 700 "$STATE" && printf '%s\n' "$p" > "$STATE/port.tmp" && mv "$STATE/port.tmp" "$STATE/port"; } 2>/dev/null; then
        echo "记不下当前端口（$STATE/port 写不进去），入口没有打开。转发已登记并记在清单里，修好后重跑本命令，或用 disable 撤掉。"
        result failed 3
    fi
    printf '%s\n' "$TS_HOST" > "$STATE/host" 2>/dev/null || true
    svc_install_and_start "$p"
    svc_probe
    if [ "$SVC_STATE" != running ]; then
        echo "常驻服务没有起来（状态：${SVC_STATE}）。入口没有打开；转发已登记，可以直接重跑本命令，或用 disable 撤掉。"
        [ -n "${SVC_OUT:-}" ] && printf '%s\n' "$SVC_OUT" | sed 's/^/  /'
        result failed 3
    fi
    echo "✓ 常驻服务已启动"
    # 换过端口：把本功能以前登记的其他端口的转发撤掉
    local q left=""
    for q in ${OWNED[@]+"${OWNED[@]}"}; do
        [ "$q" = "$p" ] && continue
        release_port "$q"
        case "$REL" in
            gone)    echo "✓ 已撤掉以前端口 $q 上的转发" ;;
            foreign) echo "以前的端口 $q 上现在是别的转发，没有动它" ;;
            *)       echo "以前端口 $q 上的转发没能撤掉（${REL}）。请用管理员权限跑：sudo tailscale serve --https=$q off，再重跑本命令"; left="$left $q" ;;
        esac
    done
    echo "远程入口已打开：${TS_HOST}（端口 ${p}）。生成配对码：bash $0 pair"
    if [ "$LEDGER_UNSAVED" = 1 ]; then echo "端口清单没能写回（$STATE/ports），里面可能多记着已经撤掉的端口；修好权限后重跑本命令"; left="$left 清单"; fi
    if [ -n "$left" ]; then result partial 3; fi
    result enabled 0
}

cmd_disable() {
    case "$OS" in Linux|Darwin) ;; *) echo "不支持的系统：${OS:-读不到}，什么都没动"; result unsupported 2 ;; esac
    need_cmds
    svc_lock_or_stop
    # 先把要用的都读到：清单读不懂就不知道该撤哪些转发，这时不能停服务、不能报「已关闭」
    state_load
    [ "$PORT_STATE" = bad ] && PORT_STATE=none   # 关闭用不着当前端口那份记录
    state_require
    ts_identity
    svc_probe
    if [ "$SVC_STATE" = unknown ]; then
        echo "读不到后台任务状态，什么都没动。读到的原文："
        printf '%s\n' "$CAVIL_SCHED_RAW" | sed 's/^/  /'
        result unknown 2
    fi
    ts_mapping "$CAVIL_REMOTE_ACCESS_PORT"   # 只为确认转发设置读得到
    if [ "$TS_MAP" = unknown ]; then echo "读不到 Tailscale 现有的转发设置，什么都没动"; result tailscale_unknown 2; fi
    local left=0 q released=0
    if ! svc_stop_and_remove; then
        echo "常驻服务停不下来或确认不了（状态：${SVC_STATE}）"
        [ -n "${SVC_OUT:-}" ] && printf '%s\n' "$SVC_OUT" | sed 's/^/  /'
        left=1
    else
        echo "✓ 常驻服务已停止并移除"
    fi
    # 本功能登记过的每一个端口（换过端口时不止一个）都撤掉
    for q in ${OWNED[@]+"${OWNED[@]}"}; do
        release_port "$q"
        case "$REL" in
            gone)    echo "✓ 已撤掉转发（端口 ${q}）"; released=1 ;;
            foreign) echo "端口 $q 上现在是别的转发，没有动它" ;;
            *)       echo "转发没能撤掉（端口 ${q}，${REL}）。请用管理员权限跑：sudo tailscale serve --https=$q off，再重跑本命令"; left=1 ;;
        esac
    done
    [ "$released" = 1 ] || [ "$left" = 1 ] || echo "没有本功能登记的转发，没有动 Tailscale 的设置"
    rm -f "$STATE/pairing.json"
    if [ "$LEDGER_UNSAVED" = 1 ]; then echo "端口清单没能写回（$STATE/ports），里面还记着已经撤掉的端口；修好权限后重跑本命令"; left=1; fi
    if [ "$left" = 1 ]; then result partial 3; fi
    echo "远程入口已关闭。已配对设备清单保留（$(device_count)）；要一并清掉：逐台 bash $0 revoke <设备名>"
    result disabled 0
}

is_open() {   # 入口是不是完整开着（服务在跑 + 转发是本功能的）。调用前已 state_load 且不是 bad
    svc_probe
    [ "$SVC_STATE" = running ] || return 1
    ts_mapping "$CUR_PORT"
    [ "$TS_MAP" = ours ]
}

cmd_pair() {
    need_cmds
    state_load; state_require
    ts_identity
    if ! is_open; then
        echo "远程入口还没有打开，先打开："
        ( cmd_enable ) || exit $?
        ts_identity
        state_load; state_require
    fi
    local made code expires host
    made="$(python3 "$PY" pair-code --expiry --state "$STATE")" || { echo "配对码没能生成（写不进 ${STATE}）"; result failed 3; }
    code="$(sed -n 1p <<<"$made")"; expires="$(sed -n 2p <<<"$made")"
    host="$TS_HOST$( [ "$CUR_PORT" = "$CAVIL_REMOTE_ACCESS_PORT" ] || printf ':%s' "$CUR_PORT" )"
    echo
    echo "在客户端「设置 → 远程 daemon → 添加远程 daemon」里填："
    echo "  机器名：$host"
    echo "  配对码：${code:0:4} ${code:4:4}"
    echo "配对码 10 分钟内有效，只能用一次；连续输错 5 次作废；再生成一个会顶替这一个。"
    echo "HOST=$host"
    echo "CODE=$code"
    echo "EXPIRES=$expires"
    result code 0
}

cmd_pair_cancel() {
    command -v python3 >/dev/null 2>&1 || { echo "缺少程序：python3"; exit 2; }
    if python3 "$PY" pair-cancel --state "$STATE"; then
        echo "✓ 等待中的配对码已作废（没有的话什么都不用做）"; result cancelled 0
    fi
    echo "没能作废配对码（$STATE/pairing.json 删不掉）"; result failed 3
}

cmd_status() {
    need_cmds
    state_load
    svc_probe
    echo "常驻服务：$SVC_STATE"
    if [ "$LEDGER" = bad ] || [ "$PORT_STATE" = bad ]; then
        state_bad_message
        device_count >/dev/null
        echo "已配对设备：$( [ "$DEVICE_N" = unknown ] && echo 读不到 || echo "$DEVICE_N 台")"
        echo "DEVICES=$DEVICE_N"
        result unknown 0
    fi
    local p="$CUR_PORT"
    local js host=""
    if js="$(tailscale status --json 2>/dev/null)"; then host="$(jq -r '(.CertDomains // [])[0] // ""' <<<"$js" 2>/dev/null || true)"; fi
    if [ -n "$host" ]; then
        TS_HOST="$host"; ts_mapping "$p"
        echo "机器名：${host}（端口 ${p}）"
        echo "Tailscale 转发：$TS_MAP"
    else
        TS_MAP=unknown
        echo "Tailscale：读不到机器名（没连上，或没开 HTTPS 证书功能）"
    fi
    device_count >/dev/null
    echo "已配对设备：$( [ "$DEVICE_N" = unknown ] && echo 读不到 || echo "$DEVICE_N 台")"
    [ ${#OWNED[@]} -eq 0 ] || echo "本功能登记过转发的端口：${OWNED[*]}"
    [ "$SVC_STATE" != running ] || restart_status "$p"
    [ -z "$host" ] || echo "HOST=$host$( [ "$p" = "$CAVIL_REMOTE_ACCESS_PORT" ] || printf ':%s' "$p" )"
    echo "PORT=$p"
    echo "DEVICES=$DEVICE_N"
    if [ "$SVC_STATE" = running ] && [ "$TS_MAP" = ours ]; then result open 0; fi
    if [ "$SVC_STATE" = unknown ] || [ "$TS_MAP" = unknown ]; then result unknown 0; fi
    # 清单里还有别的端口没撤（换端口或关闭没做完）就不算关干净
    local q
    for q in ${OWNED[@]+"${OWNED[@]}"}; do
        [ "$q" = "$p" ] && continue
        ts_mapping "$q"
        case "$TS_MAP" in ours) echo "端口 $q 上还留着本功能的转发"; result partial 0 ;; unknown) result unknown 0 ;; esac
    done
    ts_mapping "$p"
    if [ "$SVC_STATE" = stopped ] && [ "$TS_MAP" = absent ]; then result closed 0; fi
    result partial 0
}

cmd_list() {
    command -v python3 >/dev/null 2>&1 || { echo "缺少程序：python3"; exit 2; }
    local rows
    if ! rows="$(python3 "$PY" list --state "$STATE")"; then echo "读不到已配对设备清单（$STATE/devices.json），不是「没有设备」"; exit 2; fi
    if [ "${1:-}" = --machine ]; then
        # 一台一行：DEVICE=<编号>\t<设备名>\t<Tailscale 设备>\t<配对时间>；最后一行 RESULT=ok（没有设备也是 ok，只有 RESULT 一行）
        [ -z "$rows" ] || printf '%s\n' "$rows" | sed 's/^/DEVICE=/'
        result ok 0
    fi
    if [ -z "$rows" ]; then echo "还没有配对过的设备"; return 0; fi
    printf '%s\t%s\t%s\t%s\n' 编号 设备名 Tailscale设备 配对时间
    printf '%s\n' "$rows"
}

cmd_revoke() {
    [ $# -eq 1 ] && [ -n "$1" ] || usage
    command -v python3 >/dev/null 2>&1 || { echo "缺少程序：python3"; exit 2; }
    local gone rc=0
    gone="$(python3 "$PY" revoke --state "$STATE" --target "$1")" || rc=$?
    case "$rc" in
        0) printf '%s\n' "$gone" | while IFS=$'\t' read -r id name; do echo "✓ 已撤销：${name}（${id}），它的钥匙从现在起无效"; done ;;
        1) echo "没有叫「$1」的已配对设备。现有设备：bash $0 list"; exit 1 ;;
        *) echo "读不到已配对设备清单（$STATE/devices.json），没有撤销任何设备"; exit 2 ;;
    esac
}

sub="${1:-}"; [ $# -gt 0 ] && shift
case "$sub" in
    enable)  cmd_enable "$@" ;;
    disable) cmd_disable ;;
    auto-restart) cmd_auto_restart ;;
    pair)    cmd_pair ;;
    pair-cancel) cmd_pair_cancel ;;
    status)  cmd_status ;;
    list)    cmd_list "$@" ;;
    revoke)  cmd_revoke "$@" ;;
    *)       usage ;;
esac
