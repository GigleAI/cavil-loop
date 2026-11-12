# shellcheck shell=bash
# 远程入口测试用的假 tailscale（GitHub#387）。由 tests/remote-access.test.sh source；
# client/test/support/remote-world.ts 也用同一份（经 bash -c 调 install_fake_tailscale）。
#
# install_fake_tailscale <目录>：在 <目录>/bin 写出 tailscale 和 sudo，状态放在 $FAKE_TS：
#   status --json          $FAKE_TS/backend（默认 Running）、$FAKE_TS/certdomain（默认 box.tailnet.ts.net；
#                          文件为空 = 没开证书功能）、$FAKE_TS/peers.json（别的设备，原样放进 Peer；没有 = 没有别的设备）。
#                          FAKE_TS_STATUS=fail → 连不上（stderr + 退出 1）；=garbage → 输出不是 JSON
#   serve status --json    $FAKE_TS/serve.json（没有 = {}）。FAKE_TS_SERVE_STATUS=fail → 退出 1；=blank → 退出 0 但什么都不输出
#   serve --bg --https=P T 往 serve.json 加一条；FAKE_TS_SERVE=deny → 「Access denied」退出 1；
#                          FAKE_TS_SERVE=lie → 报成功但什么都不加
#   serve --https=P off    删掉那一条；FAKE_TS_SERVE_OFF=stuck → 报成功但不删
#   whois --json IP        $FAKE_TS/whois/IP.json 原样输出；没有 → 「peer not found」退出 1；
#                          FAKE_TS_WHOIS=fail → 退出 1；=garbage → 输出不是 JSON
#   sudo                   默认要密码（退出 1）；FAKE_SUDO=ok → 照跑后面的命令，且假 tailscale 不再拒绝
# 每次调用记一行到 $FAKE_TS/calls（sudo 的记到 $FAKE_TS/sudo-calls）。

install_fake_tailscale() {
    local d="$1"
    mkdir -p "$d/bin"
    cat > "$d/bin/tailscale" <<'FAKE'
#!/usr/bin/env bash
S="${FAKE_TS:?}"; mkdir -p "$S/whois"
echo "$*" >> "$S/calls"
host() { if [ -e "$S/certdomain" ]; then cat "$S/certdomain"; else echo box.tailnet.ts.net; fi; }
serve_json() { if [ -s "$S/serve.json" ]; then cat "$S/serve.json"; else echo '{}'; fi; }
case "${1:-}" in
    status)
        [ "${FAKE_TS_STATUS:-}" = fail ] && { echo "failed to connect to local tailscaled; it doesn't appear to be running" >&2; exit 1; }
        [ "${FAKE_TS_STATUS:-}" = garbage ] && { echo "not json"; exit 0; }
        h="$(host)"
        peers='null'; [ -s "$S/peers.json" ] && peers="$(cat "$S/peers.json")"
        jq -n --arg b "$(cat "$S/backend" 2>/dev/null || echo Running)" --arg h "$h" --argjson p "$peers" \
            '{BackendState:$b, CertDomains:(if $h == "" then null else [$h] end), Self:{DNSName:($h + ".")}, Peer:$p}' ;;
    serve)
        shift
        if [ "${1:-}" = status ]; then
            [ "${FAKE_TS_SERVE_STATUS:-}" = fail ] && { echo "serve status unavailable" >&2; exit 1; }
            [ "${FAKE_TS_SERVE_STATUS:-}" = blank ] && exit 0
            serve_json; exit 0
        fi
        port=""; off=0; target=""
        for a in "$@"; do
            case "$a" in --https=*) port="${a#--https=}" ;; off) off=1 ;; --bg) ;; http://*) target="$a" ;; esac
        done
        hp="$(host):$port"
        if [ "$off" = 1 ]; then
            [ "${FAKE_TS_SERVE_OFF:-}" = stuck ] && exit 0
            serve_json | jq --arg hp "$hp" --arg p "$port" 'del(.Web[$hp]) | del(.TCP[$p])' > "$S/serve.json.tmp" && mv "$S/serve.json.tmp" "$S/serve.json"
            exit 0
        fi
        [ "${FAKE_TS_SERVE:-}" = deny ] && { echo "Access denied: serve config denied" >&2; echo "Use 'sudo tailscale serve --bg --https=$port $target'" >&2; exit 1; }
        [ "${FAKE_TS_SERVE:-}" = lie ] && exit 0
        serve_json | jq --arg hp "$hp" --arg p "$port" --arg t "$target" '.TCP[$p] = {HTTPS:true} | .Web[$hp] = {Handlers:{"/":{Proxy:$t}}}' > "$S/serve.json.tmp" && mv "$S/serve.json.tmp" "$S/serve.json"
        echo "Available within your tailnet: https://$hp/" ;;
    whois)
        case "${FAKE_TS_WHOIS:-}" in fail) echo "whois failed" >&2; exit 1 ;; garbage) echo "not json"; exit 0 ;; esac
        ip="${!#}"
        if [ -f "$S/whois/$ip.json" ]; then cat "$S/whois/$ip.json"; exit 0; fi
        echo "peer not found" >&2; exit 1 ;;
    *) exit 0 ;;
esac
FAKE
    # 假 sudo：测试绝不能碰到真的 sudo——有的机器给 tailscale 配了免密，真的会改掉本机的转发设置。
    # 默认「要密码」（退出 1）；FAKE_SUDO=ok → 以「管理员」身份跑后面的命令（假 tailscale 这时不再拒绝）。
    cat > "$d/bin/sudo" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "${FAKE_TS:?}/sudo-calls"
[ "${1:-}" = -n ] && shift
if [ "${FAKE_SUDO:-}" = ok ]; then FAKE_TS_SERVE="" exec "$@"; fi
echo "sudo: a password is required" >&2; exit 1
FAKE
    chmod +x "$d/bin/tailscale" "$d/bin/sudo"
}

# fake_ts_device <IP> <稳定编号> <设备名>：登记一台 Tailscale 设备
fake_ts_device() {
    mkdir -p "$FAKE_TS/whois"
    jq -n --arg id "$2" --arg n "$3" '{Node:{StableID:$id, ComputedName:$n, Name:($n + ".tailnet.ts.net.")}, UserProfile:{LoginName:"someone@example.invalid"}}' > "$FAKE_TS/whois/$1.json"
}
