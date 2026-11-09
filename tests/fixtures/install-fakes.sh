# shellcheck shell=bash
# 安装脚本测试用的假调度器 / 假系统工具（GitHub#313）。由 tests/install-scripts.test.sh source。
#
# install_fakes <目录>：在 <目录> 下写出
#   uname      -s 报 $FAKE_UNAME（默认 Linux），其余参数交给真 uname
#   gh         auth status 的退出码 = $FAKE_GH_AUTH（默认 0）；repo view 报 $FAKE_GH_REPO（默认 acme/widget）；
#              建标签、列 issue / PR 都成功、返回空
#   systemctl  有状态：$FAKE_SD/<unit>.active / .enabled。FAKE_SD_MODE=fail → 连不上（stderr + 退出 1）；
#              =empty → 什么都不输出、退出 0；FAKE_SD_STUCK=1 → disable / stop 不生效
#   launchctl  有状态：$FAKE_LD/<label>.path（加载的是哪个文件）+ .content（加载那一刻的内容）。
#              FAKE_LD_PRINT=fail|empty；FAKE_LD_BOOTSTRAP=fail（一律失败）；
#              FAKE_LD_REJECT=<字符串>（文件里有它就加载失败）；FAKE_LD_BOOTOUT=stuck（卸载不生效）。
#              每次调用记一行到 $FAKE_LD/calls
#   plutil     -lint 用 python plistlib 真解析；FAKE_PLUTIL_FAIL=1 → 一律不过
#   tmux       什么都不做
# 每个 agent 程序放在各自的目录：<目录>/agents-<名字>/<程序>，测试按场景拼 PATH。

install_fakes() {
    local d="$1"
    mkdir -p "$d/bin"
    cat > "$d/bin/uname" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = -s ] && [ $# -eq 1 ]; then echo "${FAKE_UNAME:-Linux}"; exit 0; fi
if [ -x /usr/bin/uname ]; then exec /usr/bin/uname "$@"; else exec /bin/uname "$@"; fi
EOF
    cat > "$d/bin/gh" <<'EOF'
#!/usr/bin/env bash
case "$*" in
    "auth status"*) exit "${FAKE_GH_AUTH:-0}" ;;
    "label create"*) exit 0 ;;
    "repo view"*) echo "${FAKE_GH_REPO:-acme/widget}"; exit 0 ;;
    *"pr list"*|*"issue list"*) echo ""; exit 0 ;;
esac
echo '[]'
EOF
    cat > "$d/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
S="${FAKE_SD:?}"; mkdir -p "$S"
echo "$*" >> "$S/calls"
case "${FAKE_SD_MODE:-}" in
    fail) echo "Failed to connect to bus: No medium found" >&2; exit 1 ;;
    empty) exit 0 ;;
esac
[ "${1:-}" = --user ] && shift
cmd="${1:-}"; shift || true
now=0; props=(); value=0; units=()
while [ $# -gt 0 ]; do
    case "$1" in
        --now) now=1 ;;
        --value) value=1 ;;
        -p) props+=("$2"); shift ;;
        --property=*) IFS=, read -ra _p <<< "${1#--property=}"; props+=("${_p[@]}") ;;
        -*) ;;
        *) units+=("$1") ;;
    esac
    shift
done
u="${units[0]:-}"
act() { cat "$S/$1.active" 2>/dev/null || echo inactive; }
ena() { cat "$S/$1.enabled" 2>/dev/null || echo disabled; }
case "$cmd" in
    daemon-reload) exit 0 ;;
    enable) echo enabled > "$S/$u.enabled"; [ "$now" = 1 ] && echo active > "$S/$u.active"; exit 0 ;;
    start) echo active > "$S/$u.active"; exit 0 ;;
    disable)
        [ "${FAKE_SD_STUCK:-}" = 1 ] && exit 0
        echo disabled > "$S/$u.enabled"; [ "$now" = 1 ] && echo inactive > "$S/$u.active"; exit 0 ;;
    stop) [ "${FAKE_SD_STUCK:-}" = 1 ] || echo inactive > "$S/$u.active"; exit 0 ;;
    is-active) a="$(act "$u")"; echo "$a"; [ "$a" = active ] ;;
    is-enabled) e="$(ena "$u")"; echo "$e"; [ "$e" = enabled ] ;;
    show)
        for p in "${props[@]}"; do
            case "$p" in
                ActiveState) v="$(act "$u")" ;;
                UnitFileState) v="$(ena "$u")" ;;
                Result) v=success ;;
                *) v="" ;;
            esac
            if [ "$value" = 1 ]; then echo "$v"; else echo "$p=$v"; fi
        done ;;
    *) exit 0 ;;
esac
EOF
    cat > "$d/bin/launchctl" <<'EOF'
#!/usr/bin/env bash
S="${FAKE_LD:?}"; mkdir -p "$S"
echo "$*" >> "$S/calls"
label_of() { python3 -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["Label"])' "$1" 2>/dev/null; }
case "${1:-}" in
    print)
        case "${FAKE_LD_PRINT:-}" in
            fail) echo "Bad request." >&2; echo "Could not print domain: 5: Input/output error" >&2; exit 5 ;;
            empty) exit 0 ;;
        esac
        l="${2##*/}"
        if [ -f "$S/$l.path" ]; then
            printf '%s = {\n\tactive count = 0\n\tpath = %s\n\tstate = not running\n}\n' "$2" "$(cat "$S/$l.path")"
            exit 0
        fi
        echo "Could not find service \"$l\" in domain for port" >&2; exit 113 ;;
    bootstrap)
        f="$3"
        if [ "${FAKE_LD_BOOTSTRAP:-}" = fail ] || { [ -n "${FAKE_LD_REJECT:-}" ] && grep -qF "$FAKE_LD_REJECT" "$f"; }; then
            echo "Bootstrap failed: 5: Input/output error" >&2; exit 5
        fi
        l="$(label_of "$f")" || { echo "Bootstrap failed: 109: Invalid property list" >&2; exit 109; }
        [ -f "$S/$l.path" ] && { echo "Bootstrap failed: 37: Operation already in progress" >&2; exit 37; }
        printf '%s' "$f" > "$S/$l.path"; cp "$f" "$S/$l.content"; exit 0 ;;
    bootout)
        l="${2##*/}"
        [ -f "$S/$l.path" ] || { echo "Boot-out failed: 3: No such process" >&2; exit 3; }
        [ "${FAKE_LD_BOOTOUT:-}" = stuck ] && exit 0
        rm -f "$S/$l.path" "$S/$l.content"; exit 0 ;;
    kickstart) exit 0 ;;
esac
exit 0
EOF
    cat > "$d/bin/plutil" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = -lint ] || exit 0
[ "${FAKE_PLUTIL_FAIL:-}" = 1 ] && { echo "$2: fake lint failure"; exit 1; }
python3 -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "$2" 2>/dev/null \
    && { echo "$2: OK"; exit 0; }
echo "$2: invalid"; exit 1
EOF
    printf '#!/usr/bin/env bash\nexit 0\n' > "$d/bin/tmux"
    local a
    for a in claude codex; do
        mkdir -p "$d/agents-$a"
        printf '#!/usr/bin/env bash\nexit 0\n' > "$d/agents-$a/$a"
    done
    chmod +x "$d"/bin/* "$d"/agents-*/*
}
