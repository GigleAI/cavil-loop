# shellcheck shell=bash
# 会真的起停进程的假服务管理器（GitHub#533），给 tests/remote-access-restart.test.sh 用。
#
# tests/fixtures/install-fakes.sh 里的假 systemctl / launchctl 只记状态、不跑进程；这里的两个照
# 服务登记文件真的把常驻服务起起来、停下来，「重启后入口有没有换上新代码」才测得出来。
#
# install_live_svc_fakes <目录>：在 <目录>/bin 写出 systemctl 和 launchctl，状态放在 $FAKE_SVC：
#   systemctl --user  daemon-reload / enable [--now] / disable [--now] / start / stop / try-restart /
#                     is-active / show -p ActiveState --value / cat。服务登记 = $HOME/.config/systemd/user/<unit>，
#                     按它的 ExecStart 起进程，pid 在 $FAKE_SVC/<unit>.pid；进程活着 = active。
#                     try-restart 只重启正在运行的（照 systemd 手册：停着的什么都不做，退出 0）。
#   launchctl         bootstrap gui/<uid> <plist> / bootout gui/<uid>/<label> / kickstart -k gui/<uid>/<label> /
#                     print gui/<uid>/<label>。按 plist 的 ProgramArguments 起进程；没加载的服务 print / kickstart
#                     报「Could not find service」退出 113（照 launchd 的行为：kickstart 不会加载服务）。
# 起出来的进程关掉 3 以上的文件描述符（真的服务管理器起的进程不继承调用方的任何描述符，锁也就不会被带走）。
# 测试用的开关：
#   FAKE_SVC_RESTART=fail   try-restart / kickstart 报错退出 1，什么都不做
#   FAKE_SVC_RESTART=noop   try-restart / kickstart 报成功，但进程不换
#   FAKE_SVC_HOLD=<名字>    在 <名字> 这一步停住：写 $FAKE_SVC/hold.<名字>.reached，等 $FAKE_SVC/hold.<名字>.go 出现
#                           （after-stop：disable / stop 停完进程之后；before-restart：try-restart / kickstart 动手之前）
#   FAKE_SVC_MODE=fail      连不上（stderr + 退出 1）
# 每次调用记一行到 $FAKE_SVC/calls。

install_live_svc_fakes() {
    local d="$1"
    mkdir -p "$d/bin"
    cat > "$d/bin/fake-svc-lib" <<'EOF'
# 两个假服务管理器共用：起 / 停 / 判活
S="${FAKE_SVC:?}"; mkdir -p "$S"
alive() { local p; p="$(cat "$S/$1.pid" 2>/dev/null)" && [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
launch() {   # <名字> <程序> <参数...>
    local n="$1"; shift
    # 不继承调用方的描述符：只留 0/1/2，日志进 $S/<名字>.log
    ( exec </dev/null >>"$S/$n.log" 2>&1
      for fd in $(ls /proc/self/fd 2>/dev/null); do [ "$fd" -gt 2 ] && eval "exec $fd>&-" 2>/dev/null; done
      exec setsid "$@" ) &
    echo $! > "$S/$n.pid"
    local i; for i in $(seq 1 50); do grep -q '监听' "$S/$n.log" 2>/dev/null && [ "$(grep -c '监听' "$S/$n.log")" -ge "$(cat "$S/$n.starts" 2>/dev/null || echo 0)" ] && break; sleep 0.1; done
}
halt() {   # <名字>：发停止信号，等进程退出
    local p i
    p="$(cat "$S/$1.pid" 2>/dev/null)" || return 0
    [ -n "$p" ] || return 0
    kill -TERM "$p" 2>/dev/null || { rm -f "$S/$1.pid"; return 0; }
    for i in $(seq 1 400); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$p" 2>/dev/null && kill -KILL "$p" 2>/dev/null
    rm -f "$S/$1.pid"
}
hold() {   # <这一步的名字>
    [ "${FAKE_SVC_HOLD:-}" = "$1" ] || return 0
    : > "$S/hold.$1.reached"
    local i; for i in $(seq 1 600); do [ -e "$S/hold.$1.go" ] && return 0; sleep 0.1; done
}
EOF
    cat > "$d/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
. "$(dirname "$0")/fake-svc-lib"
echo "$*" >> "$S/calls"
[ "${FAKE_SVC_MODE:-}" = fail ] && { echo "Failed to connect to bus: No medium found" >&2; exit 1; }
[ "${1:-}" = --user ] && shift
cmd="${1:-}"; shift || true
now=0; value=0; units=()
while [ $# -gt 0 ]; do
    case "$1" in --now) now=1 ;; --value) value=1 ;; -p|--property) shift ;; --property=*) ;; -*) ;; *) units+=("$1") ;; esac
    shift
done
u="${units[0]:-}"
file="$HOME/.config/systemd/user/$u"
start_unit() {
    alive "$u" && return 0
    [ -f "$file" ] || { echo "Unit $u not found." >&2; return 5; }
    local line; line="$(sed -n 's/^ExecStart=//p' "$file" | head -1)"
    local argv; read -ra argv <<< "$line"
    echo $(( $(cat "$S/$u.starts" 2>/dev/null || echo 0) + 1 )) > "$S/$u.starts"
    launch "$u" "${argv[@]}"
}
state() { if alive "$u"; then echo active; else echo inactive; fi; }
case "$cmd" in
    daemon-reload) exit 0 ;;
    enable) echo enabled > "$S/$u.enabled"; [ "$now" = 1 ] && start_unit; exit 0 ;;
    start) start_unit; exit $? ;;
    disable) echo disabled > "$S/$u.enabled"; [ "$now" = 1 ] && { halt "$u"; hold after-stop; }; exit 0 ;;
    stop) halt "$u"; hold after-stop; exit 0 ;;
    try-restart)
        [ -f "$file" ] || { echo "Failed to try-restart $u: Unit $u not found." >&2; exit 5; }
        hold before-restart
        case "${FAKE_SVC_RESTART:-}" in fail) echo "Job for $u failed." >&2; exit 1 ;; noop) exit 0 ;; esac
        alive "$u" || exit 0
        halt "$u"; start_unit; exit $? ;;
    is-active) a="$(state)"; echo "$a"; [ "$a" = active ] ;;
    show) if [ "$value" = 1 ]; then state; else echo "ActiveState=$(state)"; fi ;;
    cat) [ -f "$file" ] || { echo "No files found for $u." >&2; exit 1; }; echo "# $file"; cat "$file" ;;
    *) exit 0 ;;
esac
EOF
    cat > "$d/bin/launchctl" <<'EOF'
#!/usr/bin/env bash
. "$(dirname "$0")/fake-svc-lib"
echo "$*" >> "$S/calls"
[ "${FAKE_SVC_MODE:-}" = fail ] && { echo "Could not print domain: 5: Input/output error" >&2; exit 5; }
args_of() { python3 -c 'import plistlib,sys; print("\n".join(plistlib.load(open(sys.argv[1],"rb"))["ProgramArguments"]))' "$1"; }
label_of() { python3 -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["Label"])' "$1" 2>/dev/null; }
missing() { echo "Could not find service \"$1\" in domain for port" >&2; exit 113; }
start_label() {   # <label>
    local f argv=(); f="$(cat "$S/$1.plist")"
    while IFS= read -r a; do argv+=("$a"); done < <(args_of "$f")
    echo $(( $(cat "$S/$1.starts" 2>/dev/null || echo 0) + 1 )) > "$S/$1.starts"
    launch "$1" "${argv[@]}"
}
case "${1:-}" in
    print)
        l="${2##*/}"; [ -f "$S/$l.plist" ] || missing "$l"
        if alive "$l"; then st=running; else st="not running"; fi
        printf '%s = {\n\tactive count = 1\n\tpath = %s\n\tstate = %s\n}\n' "$2" "$(cat "$S/$l.plist")" "$st" ;;
    bootstrap)
        f="$3"; l="$(label_of "$f")" || { echo "Bootstrap failed: 109: Invalid property list" >&2; exit 109; }
        [ -f "$S/$l.plist" ] && { echo "Bootstrap failed: 37: Operation already in progress" >&2; exit 37; }
        printf '%s' "$f" > "$S/$l.plist"; start_label "$l"; exit 0 ;;
    bootout)
        l="${2##*/}"; [ -f "$S/$l.plist" ] || { echo "Boot-out failed: 3: No such process" >&2; exit 3; }
        halt "$l"; rm -f "$S/$l.plist"; hold after-stop; exit 0 ;;
    kickstart)
        t="${!#}"; l="${t##*/}"
        hold before-restart
        [ -f "$S/$l.plist" ] || missing "$l"
        case "${FAKE_SVC_RESTART:-}" in fail) echo "Could not kickstart service: 5: Input/output error" >&2; exit 1 ;; noop) exit 0 ;; esac
        halt "$l"; start_label "$l"; exit 0 ;;
esac
exit 0
EOF
    chmod +x "$d/bin/systemctl" "$d/bin/launchctl"
}
