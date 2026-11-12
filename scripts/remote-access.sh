#!/usr/bin/env bash
# 远程入口的开关与配对（GitHub#387）：让配对过的桌面客户端经 Tailscale 看 / 停启这台机器上的 daemon。
#
# 用法：
#   bash scripts/remote-access.sh pair              生成一个配对码（入口还没开就先打开）
#   bash scripts/remote-access.sh enable [--port N] 打开入口：登记 Tailscale 转发 + 启动常驻服务
#   bash scripts/remote-access.sh status            入口开没开、转发在不在、配对了几台设备
#   bash scripts/remote-access.sh list              列出已配对设备
#   bash scripts/remote-access.sh revoke <设备名或编号>   撤销一台设备（立刻生效）
#   bash scripts/remote-access.sh disable           关闭入口：停服务 + 撤掉转发（已配对设备清单保留）
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
# enable / disable / pair / status 的最后一行固定是 RESULT=<...>。
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
usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }

# 常驻服务启动的是「稳定入口」下的脚本（按版本部署时它是指向当前版本的软链），不是本次运行所在的版本目录：
# 版本目录会被清理，写死它的话入口过几天就起不来了。入口不存在（开发副本直接跑）才用脚本自己的位置。
stable_skill() {
    local link; link="$(cavil_skill_link)"
    if [ -f "$link/scripts/remote-access/remote_access.py" ]; then printf '%s\n' "$link"; else (cd "$SCRIPT_DIR/.." && pwd -P); fi
}

port() {
    local p=""
    [ -f "$STATE/port" ] && p="$(tr -cd '0-9' < "$STATE/port" 2>/dev/null || true)"
    printf '%s\n' "${p:-$CAVIL_REMOTE_ACCESS_PORT}"
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
#   ours   这个端口的 HTTPS 转发正指向 127.0.0.1:<端口>，且没开公网入口
#   absent 这个端口上没有转发
#   other  这个端口上有别的转发（不是本功能的）
#   funnel 这个端口开着公网入口
#   unknown 读不到 / 读不懂
ts_mapping() {
    local p="$1" js
    TS_MAP=unknown
    js="$(tailscale serve status --json 2>/dev/null)" || return 0
    [ -n "$js" ] || js='{}'
    TS_MAP="$(jq -r --arg hp "$TS_HOST:$p" --arg target "http://127.0.0.1:$p" '
        if type != "object" then "unknown"
        elif (.AllowFunnel // {})[$hp] == true then "funnel"
        else ((.Web // {})[$hp].Handlers // null) as $h
          | if $h == null then (if ((.TCP // {})[($hp | split(":") | last)] // null) == null then "absent" else "other" end)
            elif ($h | keys) == ["/"] and $h["/"].Proxy == $target then "ours"
            else "other" end
        end' <<<"$js" 2>/dev/null || echo unknown)"
    [ -n "$TS_MAP" ] || TS_MAP=unknown
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
Environment=PATH=$PATH
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

device_count() { python3 "$PY" list --state "$STATE" 2>/dev/null | grep -c . || true; }

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
    if [ -n "$p" ]; then
        if ! [[ "$p" =~ ^[0-9]{2,5}$ ]] || [ "$p" -lt 1024 ] || [ "$p" -gt 65535 ]; then echo "端口要在 1024–65535 之间"; result bad_port 1; fi
    else
        p="$(port)"
    fi
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
            if ! ts_serve "$p" on; then
                echo "登记 Tailscale 转发失败（需要管理员权限），什么都没动。Tailscale 的原话："
                printf '%s\n' "$TS_SERVE_OUT" | sed 's/^/  /'
                echo "请先用管理员权限跑一次下面这条，再重跑本命令："
                echo "  sudo tailscale serve --bg --https=$p http://127.0.0.1:$p"
                result need_admin 2
            fi
            ts_mapping "$p"
            if [ "$TS_MAP" != ours ]; then
                echo "登记了转发，但读回的结果不对（$TS_MAP）。已尝试撤掉，入口没有打开。"
                ts_serve "$p" off || echo "  撤不掉，请手动跑：sudo tailscale serve --https=$p off"
                result failed 3
            fi
            echo "✓ 已登记转发：https://$TS_HOST:$p → 127.0.0.1:$p（仅本 Tailscale 网络）" ;;
        ours) echo "✓ 转发已在：https://$TS_HOST:$p → 127.0.0.1:$p（仅本 Tailscale 网络）" ;;
    esac
    mkdir -p "$STATE"; chmod 700 "$STATE"
    printf '%s\n' "$p" > "$STATE/port"; printf '%s\n' "$TS_HOST" > "$STATE/host"
    svc_install_and_start "$p"
    svc_probe
    if [ "$SVC_STATE" != running ]; then
        echo "常驻服务没有起来（状态：$SVC_STATE）。入口没有打开；转发已登记，可以直接重跑本命令，或用 disable 撤掉。"
        [ -n "${SVC_OUT:-}" ] && printf '%s\n' "$SVC_OUT" | sed 's/^/  /'
        result failed 3
    fi
    echo "✓ 常驻服务已启动"
    echo "远程入口已打开：$TS_HOST（端口 $p）。生成配对码：bash $0 pair"
    result enabled 0
}

cmd_disable() {
    case "$OS" in Linux|Darwin) ;; *) echo "不支持的系统：${OS:-读不到}，什么都没动"; result unsupported 2 ;; esac
    need_cmds
    local p; p="$(port)"
    ts_identity
    svc_probe
    if [ "$SVC_STATE" = unknown ]; then
        echo "读不到后台任务状态，什么都没动。读到的原文："
        printf '%s\n' "$CAVIL_SCHED_RAW" | sed 's/^/  /'
        result unknown 2
    fi
    ts_mapping "$p"
    if [ "$TS_MAP" = unknown ]; then echo "读不到 Tailscale 现有的转发设置，什么都没动"; result tailscale_unknown 2; fi
    local left=0
    if ! svc_stop_and_remove; then
        echo "常驻服务停不下来或确认不了（状态：$SVC_STATE）"
        [ -n "${SVC_OUT:-}" ] && printf '%s\n' "$SVC_OUT" | sed 's/^/  /'
        left=1
    else
        echo "✓ 常驻服务已停止并移除"
    fi
    if [ "$TS_MAP" = ours ]; then
        ts_serve "$p" off || true
        ts_mapping "$p"
        if [ "$TS_MAP" = absent ]; then
            echo "✓ 已撤掉转发（端口 $p）"
        else
            echo "转发没能撤掉（现在读到：$TS_MAP）。请用管理员权限跑：sudo tailscale serve --https=$p off"
            left=1
        fi
    else
        echo "端口 $p 上没有本功能的转发（读到：$TS_MAP），没有动 Tailscale 的设置"
    fi
    rm -f "$STATE/pairing.json"
    if [ "$left" = 1 ]; then result partial 3; fi
    echo "远程入口已关闭。已配对设备清单保留（$(device_count) 台）；要一并清掉：逐台 bash $0 revoke <设备名>"
    result disabled 0
}

is_open() {   # 入口是不是完整开着（服务在跑 + 转发是本功能的）；读不到算没开着，但不据此改任何东西
    local p; p="$(port)"
    svc_probe
    [ "$SVC_STATE" = running ] || return 1
    ts_mapping "$p"
    [ "$TS_MAP" = ours ]
}

cmd_pair() {
    need_cmds
    ts_identity
    if ! is_open; then
        echo "远程入口还没有打开，先打开："
        ( cmd_enable ) || exit $?
        ts_identity
    fi
    local code
    code="$(python3 "$PY" pair-code --state "$STATE")"
    echo
    echo "在客户端「设置 → 远程 daemon → 添加远程 daemon」里填："
    echo "  机器名：$TS_HOST$( [ "$(port)" = "$CAVIL_REMOTE_ACCESS_PORT" ] || printf ':%s' "$(port)" )"
    echo "  配对码：${code:0:4} ${code:4:4}"
    echo "配对码 10 分钟内有效，只能用一次；连续输错 5 次作废。"
    result code 0
}

cmd_status() {
    need_cmds
    local p; p="$(port)"
    svc_probe
    echo "常驻服务：$SVC_STATE"
    local js host=""
    if js="$(tailscale status --json 2>/dev/null)"; then host="$(jq -r '(.CertDomains // [])[0] // ""' <<<"$js" 2>/dev/null || true)"; fi
    if [ -n "$host" ]; then
        TS_HOST="$host"; ts_mapping "$p"
        echo "机器名：$host（端口 $p）"
        echo "Tailscale 转发：$TS_MAP"
    else
        TS_MAP=unknown
        echo "Tailscale：读不到机器名（没连上，或没开 HTTPS 证书功能）"
    fi
    echo "已配对设备：$(device_count) 台"
    if [ "$SVC_STATE" = running ] && [ "$TS_MAP" = ours ]; then result open 0; fi
    if [ "$SVC_STATE" = unknown ] || [ "$TS_MAP" = unknown ]; then result unknown 0; fi
    if [ "$SVC_STATE" = stopped ] && [ "$TS_MAP" = absent ]; then result closed 0; fi
    result partial 0
}

cmd_list() {
    command -v python3 >/dev/null 2>&1 || { echo "缺少程序：python3"; exit 2; }
    local rows
    rows="$(python3 "$PY" list --state "$STATE")"
    if [ -z "$rows" ]; then echo "还没有配对过的设备"; return 0; fi
    printf '%s\t%s\t%s\t%s\n' 编号 设备名 Tailscale设备 配对时间
    printf '%s\n' "$rows"
}

cmd_revoke() {
    [ $# -eq 1 ] && [ -n "$1" ] || usage
    command -v python3 >/dev/null 2>&1 || { echo "缺少程序：python3"; exit 2; }
    local gone
    if gone="$(python3 "$PY" revoke --state "$STATE" --target "$1")"; then
        printf '%s\n' "$gone" | while IFS=$'\t' read -r id name; do echo "✓ 已撤销：$name（$id），它的钥匙从现在起无效"; done
    else
        echo "没有叫「$1」的已配对设备。现有设备：bash $0 list"
        exit 1
    fi
}

sub="${1:-}"; [ $# -gt 0 ] && shift
case "$sub" in
    enable)  cmd_enable "$@" ;;
    disable) cmd_disable ;;
    pair)    cmd_pair ;;
    status)  cmd_status ;;
    list)    cmd_list ;;
    revoke)  cmd_revoke "$@" ;;
    *)       usage ;;
esac
