#!/usr/bin/env bash
# 改名前注册的预览搬到新单元（GigleAI/cavil-loop#75）的守卫。
#
# 跑法：bash tests/preview-legacy-adopt.test.sh   （十几秒）
# 隔离 HOME + 假 systemctl（每个单元的状态记成文件，可按单元名注入 start / stop 失败）+ 假 curl
# + 假 journalctl，跑**真实的** preview-serve.sh / migrate-legacy.sh / poll-entry.sh。
# 不碰真实 systemd / tailscale / 网络。
#
# 假 systemctl 跟真实旧单元一样「看路径」：旧 app 单元的 ExecStart 写死在旧技能入口下，
# 旧入口不在时 start 它就失败——这正是 issue 里 502 的成因。
#
# 为什么必须有这个文件：这里的错**都不报错**——
#   · 旧入口删了、旧单元还在 → 预览全部 502，注册脚本照样打印地址、退出码 0；
#   · 搬到一半失败 → 旧登记已经不在旧目录，下一轮再也不会处理这个端口；
#   · 冲突或失败的端口还在，旧入口却被删掉 → 本来还能用的旧预览也一起坏掉；
#   · 已经迁完的机器 → 轮询入口不再调迁移，坏掉的旧预览永远没人修。
# 每个关键断言都拿改动前的代码（BASE_COMMIT）跑同一场景做负对照，必须变红。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
BASE_COMMIT="d41ee75"   # 本 issue 动手之前的 main
PREV_COMMIT="b7369b9"   # PR #79 第 1 轮复审打回的那版（查不到单元状态时照样收尾）

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

FAKEBIN="$TMP/bin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/systemctl" <<'SH'
#!/usr/bin/env bash
[ "$1" = --user ] && shift
printf '%s\n' "$*" >> "$SCTL/calls"
# 用户服务管理器连不上：所有命令只在 stderr 报错、stdout 空、退出 1（真实 systemctl 的样子）。
# bus-down-on-stop：第一次 stop 时才断开（模拟「停旧单元的半路上连不上了」）。
[ "$1" = stop ] && [ -e "$SCTL/bus-down-on-stop" ] && { rm -f "$SCTL/bus-down-on-stop"; : > "$SCTL/bus-down"; }
if [ -e "$SCTL/bus-down" ]; then
    echo "Failed to connect to user scope bus via local transport: Connection refused" >&2
    exit 1
fi
cmd="$1"; shift
quiet=0; units=()
for a in "$@"; do case "$a" in --quiet) quiet=1 ;; -*) ;; *) units+=("$a") ;; esac; done
st() { cat "$SCTL/state/$1" 2>/dev/null || echo inactive; }
runnable() {   # 单元的 ExecStart 指向的脚本在不在（见 systemd/*-preview-app@.service）
    case "$1" in
        coding-agent-preview-app@*) [ -e "$HOME/.agents/skills/coding-agent-work-loop/scripts/preview-run.sh" ] ;;
        cavil-loop-preview-app@*)   [ -e "$HOME/.agents/skills/cavil-loop/scripts/preview-run.sh" ] ;;
        *) true ;;
    esac
}
case "$cmd" in
    is-active) s="$(st "${units[0]}")"; [ "$quiet" = 1 ] || echo "$s"; [ "$s" = active ] && exit 0; exit 3 ;;
    start) rc=0
        for u in "${units[@]}"; do
            if [ -e "$SCTL/fail-start/$u" ] || ! runnable "$u"; then echo failed > "$SCTL/state/$u"; rc=1; continue; fi
            echo active > "$SCTL/state/$u"
        done; exit $rc ;;
    stop) rc=0
        for u in "${units[@]}"; do
            [ -e "$SCTL/fail-stop/$u" ] && { rc=1; continue; }
            rm -f "$SCTL/state/$u"
        done; exit $rc ;;
    reset-failed) for u in "${units[@]}"; do [ "$(st "$u")" = failed ] && rm -f "$SCTL/state/$u"; done ;;
esac
exit 0
SH
cat > "$FAKEBIN/curl" <<'SH'
#!/usr/bin/env bash
# $SCTL/curl：一个状态码，或 fail（连不上）
c="$(cat "$SCTL/curl" 2>/dev/null || echo fail)"
[ "$c" = fail ] && { printf '000'; exit 7; }
printf '%s' "$c"
SH
cat > "$FAKEBIN/journalctl" <<'SH'
#!/usr/bin/env bash
echo "fake journal for $*"
SH
cat > "$FAKEBIN/gh" <<'SH'
#!/usr/bin/env bash
exit 1
SH
cat > "$FAKEBIN/tmux" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$FAKEBIN"/*

# mkhome <dir> <legacy_link: yes|no>：一台「旧项目都已迁完」的机器。新技能入口指向 <code>，
# 新旧预览单元模板都装着；旧技能入口按参数决定在不在（no = 更早一版迁移已经把它删了）。
mkhome() {
    local w="$1" legacy="$2" code="$3"
    local h="$w/home"
    mkdir -p "$h/.config/systemd/user" "$h/.agents/skills" "$h/.config/coding-agent-work-loop/preview" \
             "$h/.config/cavil-loop/preview" "$w/sctl/state" "$w/sctl/fail-start" "$w/sctl/fail-stop" \
             "$w/wt/issue-40" "$w/wt/issue-41" "$w/project"
    ln -s "$code" "$h/.agents/skills/cavil-loop"
    [ "$legacy" = yes ] && ln -s "$code" "$h/.agents/skills/coding-agent-work-loop"
    local u
    for u in coding-agent-preview@.socket coding-agent-preview@.service coding-agent-preview-app@.service \
             cavil-loop-preview@.socket cavil-loop-preview@.service cavil-loop-preview-app@.service; do
        : > "$h/.config/systemd/user/$u"
    done
    : > "$w/sctl/calls"
    cat > "$w/widget.config" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$w/project"
WORKTREE_BASE="$w/wt"
STATE_DIR="$w/state"
TMUX_PREFIX="widget"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
PREVIEW_EXEC="node server.mjs"
PREVIEW_PORT_BASE=4000
CONF
    mkdir -p "$w/state"
}
# oldreg <dir> <port> [project] [issue]：一份改名前的旧登记
oldreg() {
    local w="$1" port="$2" proj="${3:-widget}" issue="${4:-$(( $2 - 4000 ))}"
    printf 'PREVIEW_PROJECT="%s"\nPREVIEW_ISSUE="%s"\nPREVIEW_PORT="%s"\nPREVIEW_BACKEND_PORT="%s"\nPREVIEW_WORKTREE="%s"\nPREVIEW_EXEC="node server.mjs"\n' \
        "$proj" "$issue" "$port" "$((port + 10000))" "$w/wt/issue-$issue" \
        > "$w/home/.config/coding-agent-work-loop/preview/$port.conf"
}
newreg() {
    local w="$1" port="$2" proj="$3" issue="$4"
    printf 'PREVIEW_PROJECT="%s"\nPREVIEW_ISSUE="%s"\nPREVIEW_PORT="%s"\nPREVIEW_WORKTREE="%s"\n' \
        "$proj" "$issue" "$port" "$w/wt/issue-$issue" > "$w/home/.config/cavil-loop/preview/$port.conf"
}
state() { cat "$1/sctl/state/$2" 2>/dev/null || echo inactive; }
setstate() { echo "$3" > "$1/sctl/state/$2"; }
has_old() { [ -f "$1/home/.config/coding-agent-work-loop/preview/$2.conf" ] && echo yes || echo no; }
has_new() { [ -f "$1/home/.config/cavil-loop/preview/$2.conf" ] && echo yes || echo no; }
backed()  { ls "$1/home/.config/cavil-loop/migration/preview-legacy/$2.conf.adopted-"* >/dev/null 2>&1 && echo yes || echo no; }
legacy_link() { [ -L "$1/home/.agents/skills/coding-agent-work-loop" ] && echo kept || echo gone; }

serve() {   # serve <dir> <code> <args…>：stdout 写进 <dir>/out，stderr 进 <dir>/err，打印退出码
    local w="$1" code="$2"; shift 2
    env -u CODING_AGENT_RELEASE_ROOT HOME="$w/home" PATH="$FAKEBIN:$PATH" SCTL="$w/sctl" \
        CODING_AGENT_CONFIG="$w/widget.config" bash "$code/scripts/preview-serve.sh" "$@" >"$w/out" 2>"$w/err"
    echo $?
}
migrate() {   # migrate <dir> <code>
    local w="$1" code="$2"
    env -u CAVIL_SYSTEMD_USER_DIR HOME="$w/home" PATH="$FAKEBIN:$PATH" SCTL="$w/sctl" \
        bash "$code/scripts/migrate-legacy.sh" --all >>"$w/mig.out" 2>>"$w/mig.err"
}
url_in() { grep -c 'http://127.0.0.1:' "$1/out"; }

# ─────────────────────────────────────────────────────────────────────────────
# 场景 S1：issue 原样——旧入口已删，旧单元在 failed，worker 重跑 --restart --warm
scenario_issue() {   # <code> <dir>：输出 键=值
    local code="$1" w="$2"
    mkhome "$w" no "$REPO_DIR"
    oldreg "$w" 4040
    setstate "$w" coding-agent-preview@4040.socket failed
    echo 200 > "$w/sctl/curl"
    echo "rc=$(serve "$w" "$code" 40 --restart --warm)"
    echo "url=$(url_in "$w")"
    echo "old=$(has_old "$w" 4040)"
    echo "new=$(has_new "$w" 4040)"
    echo "backed=$(backed "$w" 4040)"
    echo "new_sock=$(state "$w" cavil-loop-preview@4040.socket)"
    echo "new_app=$(state "$w" cavil-loop-preview-app@4040.service)"
    echo "old_sock=$(state "$w" coding-agent-preview@4040.socket)"
}
# 场景 S1b：同上，但新单元的 app 也起不来
scenario_issue_newfail() {
    local code="$1" w="$2"
    mkhome "$w" no "$REPO_DIR"
    oldreg "$w" 4040
    setstate "$w" coding-agent-preview@4040.socket failed
    : > "$w/sctl/fail-start/cavil-loop-preview-app@4040.service"
    : > "$w/sctl/fail-start/coding-agent-preview-app@4040.service"
    echo 200 > "$w/sctl/curl"
    echo "rc=$(serve "$w" "$code" 40 --restart --warm)"
    echo "url=$(url_in "$w")"
    echo "log_shown=$(grep -c 'fake journal' "$w/err")"
}
# 场景 S2：预热请求的结果决定给不给地址（全新注册，走新单元）
scenario_probe() {   # <code> <dir> <curl 结果>
    local code="$1" w="$2"
    mkhome "$w" yes "$REPO_DIR"
    echo "$3" > "$w/sctl/curl"
    echo "rc=$(serve "$w" "$code" 41 --warm)"
    echo "url=$(url_in "$w")"
}
# 场景 S9：已迁完的机器、旧入口早被删、旧登记还在 → 经真实轮询入口，这一轮就搬
scenario_poll_entry() {
    local code="$1" w="$2"
    mkhome "$w" no "$code"
    oldreg "$w" 4040; oldreg "$w" 4041
    setstate "$w" coding-agent-preview@4040.socket failed
    env -u CAVIL_SKILL_LINK -u CAVIL_DEPLOY_ROOT -u CAVIL_DEPLOY_CONF -u CODING_AGENT_RELEASE_ROOT -u CODING_AGENT_CONFIG \
        HOME="$w/home" PATH="$FAKEBIN:$PATH" SCTL="$w/sctl" \
        timeout 60 bash "$code/scripts/poll-entry.sh" >/dev/null 2>&1
    echo "old_left=$(ls "$w/home/.config/coding-agent-work-loop/preview/" | grep -c '\.conf$')"
    echo "sock_4040=$(state "$w" cavil-loop-preview@4040.socket)"
    echo "sock_4041=$(state "$w" cavil-loop-preview@4041.socket)"
}
expect() { sed -n "s/^$2=//p" "$1" | head -1; }

echo "【1】issue 原场景：旧入口已删、旧单元起不来，worker 重跑注册 --restart --warm"
scenario_issue "$REPO_DIR" "$TMP/s1" > "$TMP/s1.res"; R="$TMP/s1.res"
chk "退出码 0（搬到新单元后起来了）"     "$(expect "$R" rc)" "0"
chk "打印了地址"                         "$(expect "$R" url)" "1"
chk "旧登记离开旧目录、原件进备份"       "$(expect "$R" old)|$(expect "$R" backed)" "no|yes"
chk "新目录有登记"                       "$(expect "$R" new)" "yes"
chk "新监听在听、新 app 起来了"          "$(expect "$R" new_sock)|$(expect "$R" new_app)" "active|active"
chk "旧监听不再挂着 failed"              "$(expect "$R" old_sock)" "inactive"

echo "【1b】新单元也起不来：非零退出、标准输出里没有地址、把单元日志打出来"
scenario_issue_newfail "$REPO_DIR" "$TMP/s1b" > "$TMP/s1b.res"; R="$TMP/s1b.res"
chk "非零退出"          "$([ "$(expect "$R" rc)" != 0 ] && echo nonzero || echo zero)" "nonzero"
chk "没打印地址"        "$(expect "$R" url)" "0"
chk "打出了单元日志"    "$([ "$(expect "$R" log_shown)" -ge 1 ] && echo yes || echo no)" "yes"

echo "【2】预热请求：拿不到 2xx/3xx 就不给地址"
for c in 502 fail 200 302; do
    scenario_probe "$REPO_DIR" "$TMP/s2-$c" "$c" > "$TMP/s2-$c.res"
done
chk "502 → 非零、无地址"    "$(expect "$TMP/s2-502.res" rc)|$(expect "$TMP/s2-502.res" url)" "1|0"
chk "连不上 → 非零、无地址" "$(expect "$TMP/s2-fail.res" rc)|$(expect "$TMP/s2-fail.res" url)" "1|0"
chk "200 → 0、有地址"       "$(expect "$TMP/s2-200.res" rc)|$(expect "$TMP/s2-200.res" url)" "0|1"
chk "302 → 0、有地址"       "$(expect "$TMP/s2-302.res" rc)|$(expect "$TMP/s2-302.res" url)" "0|1"
mkhome "$TMP/s2-nowarm" yes "$REPO_DIR"
serve "$TMP/s2-nowarm" "$REPO_DIR" 41 >/dev/null
chk "不带 --warm：给地址，但写明尚未实际访问验证" \
    "$(url_in "$TMP/s2-nowarm")|$(grep -c '尚未实际访问验证' "$TMP/s2-nowarm/err")" "1|1"
chk "不带 --warm：监听起不来同样不给地址" \
    "$(W="$TMP/s2-sockfail"; mkhome "$W" yes "$REPO_DIR"; : > "$W/sctl/fail-start/cavil-loop-preview@4041.socket"; echo "$(serve "$W" "$REPO_DIR" 41)|$(url_in "$W")")" "1|0"

# ─────────────────────────────────────────────────────────────────────────────
echo "【3】迁移：停旧单元失败 → 两份登记都在、旧入口保留；修好后下一轮搬完"
W="$TMP/s3"; mkhome "$W" yes "$REPO_DIR"; oldreg "$W" 4050
setstate "$W" coding-agent-preview@4050.socket active
: > "$W/sctl/fail-stop/coding-agent-preview@4050.socket"
migrate "$W" "$REPO_DIR"
chk "第 1 轮：旧登记仍在、新目录有副本"   "$(has_old "$W" 4050)|$(has_new "$W" 4050)" "yes|yes"
chk "第 1 轮：旧入口保留"                 "$(legacy_link "$W")" "kept"
chk "第 1 轮：旧监听照常在听"             "$(state "$W" coding-agent-preview@4050.socket)" "active"
chk "第 1 轮：迁移日志写了原因"           "$(grep -c ':4050 旧单元 coding-agent-preview@4050.socket 停不下来' "$W/home/.local/state/cavil-loop/migrate.log")" "1"
rm -f "$W/sctl/fail-stop/coding-agent-preview@4050.socket"
migrate "$W" "$REPO_DIR"
chk "第 2 轮：搬完（旧登记进备份、新监听在听）" \
    "$(has_old "$W" 4050)|$(backed "$W" 4050)|$(state "$W" cavil-loop-preview@4050.socket)" "no|yes|active"
chk "第 2 轮：旧入口删掉了"               "$(legacy_link "$W")" "gone"

echo "【4】迁移：起新监听失败 → 两份登记都在、旧入口保留、旧监听被拉回；下一轮搬完"
W="$TMP/s4"; mkhome "$W" yes "$REPO_DIR"; oldreg "$W" 4050
setstate "$W" coding-agent-preview@4050.socket active
: > "$W/sctl/fail-start/cavil-loop-preview@4050.socket"
migrate "$W" "$REPO_DIR"
chk "第 1 轮：两份登记都在"     "$(has_old "$W" 4050)|$(has_new "$W" 4050)" "yes|yes"
chk "第 1 轮：旧入口保留"       "$(legacy_link "$W")" "kept"
chk "第 1 轮：旧监听被拉回"     "$(state "$W" coding-agent-preview@4050.socket)" "active"
rm -f "$W/sctl/fail-start/cavil-loop-preview@4050.socket"
migrate "$W" "$REPO_DIR"
chk "第 2 轮：搬完、旧入口删掉" \
    "$(has_old "$W" 4050)|$(state "$W" cavil-loop-preview@4050.socket)|$(state "$W" coding-agent-preview@4050.socket)|$(legacy_link "$W")" \
    "no|active|inactive|gone"

echo "【5】迁移：旧监听已停、旧 app 停不下来时中断 → 下一轮按第一次记的原状起新监听"
W="$TMP/s5"; mkhome "$W" yes "$REPO_DIR"; oldreg "$W" 4050
setstate "$W" coding-agent-preview@4050.socket active
setstate "$W" coding-agent-preview-app@4050.service active
: > "$W/sctl/fail-stop/coding-agent-preview-app@4050.service"
migrate "$W" "$REPO_DIR"
chk "第 1 轮：旧监听已停、搬到一半（两份登记）" \
    "$(state "$W" coding-agent-preview@4050.socket)|$(has_old "$W" 4050)|$(has_new "$W" 4050)" "inactive|yes|yes"
rm -f "$W/sctl/fail-stop/coding-agent-preview-app@4050.service"
migrate "$W" "$REPO_DIR"
chk "第 2 轮：新监听起来了（没按此刻已停的旧监听判成「原本不开」）" \
    "$(state "$W" cavil-loop-preview@4050.socket)|$(has_old "$W" 4050)" "active|no"
chk "原状记录收尾时清掉" "$([ -e "$W/home/.config/cavil-loop/migration/preview-4050.listen" ] && echo left || echo gone)" "gone"

echo "【6】迁移：原本没在听的旧登记 → 搬完新监听也不开，重跑依旧不开"
W="$TMP/s6"; mkhome "$W" yes "$REPO_DIR"; oldreg "$W" 4050
migrate "$W" "$REPO_DIR"; migrate "$W" "$REPO_DIR"
chk "登记搬完、新监听没开" "$(has_old "$W" 4050)|$(has_new "$W" 4050)|$(state "$W" cavil-loop-preview@4050.socket)" "no|yes|inactive"
chk "从头到尾没 start 过新监听" "$(grep -c '^start cavil-loop-preview@4050.socket' "$W/sctl/calls")" "0"

echo "【7】迁移：冲突端口（新旧主人不同）遇上收尾 → 两份都不动、旧入口保留、别的端口照搬"
W="$TMP/s7"; mkhome "$W" yes "$REPO_DIR"; oldreg "$W" 4050; oldreg "$W" 4051
newreg "$W" 4050 other 50
setstate "$W" coding-agent-preview@4050.socket active
setstate "$W" coding-agent-preview@4051.socket active
cp "$W/home/.config/coding-agent-work-loop/preview/4050.conf" "$TMP/s7-old.orig"
cp "$W/home/.config/cavil-loop/preview/4050.conf" "$TMP/s7-new.orig"
migrate "$W" "$REPO_DIR"; migrate "$W" "$REPO_DIR"
chk "冲突的两份登记逐字节不变" \
    "$(cmp -s "$TMP/s7-old.orig" "$W/home/.config/coding-agent-work-loop/preview/4050.conf" && cmp -s "$TMP/s7-new.orig" "$W/home/.config/cavil-loop/preview/4050.conf" && echo same)" "same"
chk "冲突端口的旧监听照常在听"   "$(state "$W" coding-agent-preview@4050.socket)" "active"
chk "旧入口保留"                 "$(legacy_link "$W")" "kept"
chk "不冲突的 4051 照常搬完"     "$(has_old "$W" 4051)|$(state "$W" cavil-loop-preview@4051.socket)" "no|active"
chk "冲突在日志里两轮只记一次"   "$(grep -c ':4050 新旧两个登记目录各有一份、主人不同' "$W/home/.local/state/cavil-loop/migrate.log")" "1"

echo "【7b】冲突处理脚本：留哪份都在新单元上收尾；最后一个冲突处理完、旧入口被删之后，选错了照样能换回来"
# 跑真实的 scripts/preview-resolve-conflict.sh，路径和运维文档里写的一样（经新技能入口），
# env -i 起一个干净环境、不预先导出任何变量——文档里的命令就是这一条进程，没有跨 shell 的东西
resolve() {   # <dir> <args…>：输出写进 <dir>/resolve.out，打印退出码
    local w="$1"; shift
    env -i HOME="$w/home" PATH="$FAKEBIN:/usr/bin:/bin" SCTL="$w/sctl" \
        bash "$w/home/.agents/skills/cavil-loop/scripts/preview-resolve-conflict.sh" "$@" >"$w/resolve.out" 2>&1
    echo $?
}
backup_of() { sed -n 's/^备份：//p' "$1/resolve.out" | head -1; }
for keep in old new; do
    W="$TMP/s7b-$keep"; mkhome "$W" yes "$REPO_DIR"; oldreg "$W" 4050; newreg "$W" 4050 other 50
    setstate "$W" coding-agent-preview@4050.socket active
    [ "$keep" = new ] && setstate "$W" cavil-loop-preview@4050.socket failed
    migrate "$W" "$REPO_DIR"
    chk "keep=$keep：只看不动（两份登记、旧入口都在）" \
        "$(resolve "$W" 4050)|$(grep -c '这是冲突' "$W/resolve.out")|$(has_old "$W" 4050)|$(has_new "$W" 4050)" "0|1|yes|yes"
    chk "keep=$keep：处理成功" "$(resolve "$W" 4050 --keep "$keep")" "0"
    B="$(backup_of "$W")"
    want_owner="$([ "$keep" = old ] && echo widget || echo other)"
    chk "keep=$keep：只剩留下那份、跑在新单元上、旧监听已停" \
        "$(has_old "$W" 4050)|$(grep -c "^PREVIEW_PROJECT=\"$want_owner\"" "$W/home/.config/cavil-loop/preview/4050.conf")|$(state "$W" cavil-loop-preview@4050.socket)|$(state "$W" coding-agent-preview@4050.socket)" \
        "no|1|active|inactive"
    chk "keep=$keep：两份原件都在备份里" "$(cd "$B" 2>/dev/null && ls old.conf new.conf | wc -l)" "2"
    # 最后一个冲突处理完 → 下一轮迁移收尾、删掉旧入口
    migrate "$W" "$REPO_DIR"
    chk "keep=$keep：下一轮迁移收尾，旧入口删掉" "$(legacy_link "$W")" "gone"
    # 人打开页面发现选错了 → 换成另一份。旧入口已经不在，换完照样在新单元上跑得起来
    other_owner="$([ "$keep" = old ] && echo other || echo widget)"
    chk "keep=$keep：选错了换回来成功" "$(resolve "$W" 4050 --swap "$B")" "0"
    chk "keep=$keep：换回后是另一份的登记、新监听在听、新 app 起得来" \
        "$(grep -c "^PREVIEW_PROJECT=\"$other_owner\"" "$W/home/.config/cavil-loop/preview/4050.conf")|$(state "$W" cavil-loop-preview@4050.socket)|$(SCTL="$W/sctl" HOME="$W/home" PATH="$FAKEBIN:$PATH" systemctl --user start cavil-loop-preview-app@4050.service; echo $?)" \
        "1|active|0"
    chk "keep=$keep：换回后没有再冒出冲突，旧登记目录仍空" "$(has_old "$W" 4050)" "no"
done
W="$TMP/s7e"; mkhome "$W" yes "$REPO_DIR"; oldreg "$W" 4050
chk "不是冲突时 --keep 一个字节都不动" "$(resolve "$W" 4050 --keep new)|$(has_old "$W" 4050)|$(has_new "$W" 4050)" "2|yes|no"
W="$TMP/s7f"; mkhome "$W" yes "$REPO_DIR"; oldreg "$W" 4050; newreg "$W" 4050 other 50
setstate "$W" coding-agent-preview@4050.socket active
: > "$W/sctl/fail-stop/coding-agent-preview@4050.socket"
chk "要去掉那侧的单元停不下来 → 失败、哪份登记都没移走" \
    "$(resolve "$W" 4050 --keep new)|$(has_old "$W" 4050)|$(has_new "$W" 4050)" "1|yes|yes"

# 冲突处理脚本拿的那把端口锁真挡得住迁移：用一个**能搬**的端口，人拿着锁时迁移等不到、一个字节都不动
W="$TMP/s7d"; mkhome "$W" yes "$REPO_DIR"; oldreg "$W" 4050
setstate "$W" coding-agent-preview@4050.socket active
HOME="$W/home" bash -c 'flock ~/.config/coding-agent-work-loop/preview/.port-4050.lock sleep 4' &
sleep 0.5
PREVIEW_LOCK_TIMEOUT=1 migrate "$W" "$REPO_DIR"
chk "人拿着端口锁时，迁移不动这个端口、旧入口保留" \
    "$(has_old "$W" 4050)|$(has_new "$W" 4050)|$(state "$W" coding-agent-preview@4050.socket)|$(legacy_link "$W")" "yes|no|active|kept"
wait
migrate "$W" "$REPO_DIR"
chk "放锁后下一轮照常搬完" "$(has_old "$W" 4050)|$(state "$W" cavil-loop-preview@4050.socket)" "no|active"
chk "对照：preview-unserve.sh 确实处理不了冲突（不放开跨主人删除）" \
    "$(W="$TMP/s7c"; mkhome "$W" yes "$REPO_DIR"; oldreg "$W" 4050; newreg "$W" 4050 other 50; mkdir -p "$W/wt/issue-50"
       env -u CODING_AGENT_RELEASE_ROOT HOME="$W/home" PATH="$FAKEBIN:$PATH" SCTL="$W/sctl" CODING_AGENT_CONFIG="$W/widget.config" \
           bash "$REPO_DIR/scripts/preview-unserve.sh" --issue 50 >/dev/null 2>&1; echo "$?|$(has_old "$W" 4050)|$(has_new "$W" 4050)")" "3|yes|yes"

echo "【8】迁移：全部搬完 → 删旧入口；再跑一轮什么都不变；轮询入口不再需要调迁移"
W="$TMP/s8"; mkhome "$W" yes "$REPO_DIR"; oldreg "$W" 4050; oldreg "$W" 4051
setstate "$W" coding-agent-preview@4050.socket active
migrate "$W" "$REPO_DIR"
chk "旧入口删掉了、旧登记目录清空" \
    "$(legacy_link "$W")|$(ls "$W/home/.config/coding-agent-work-loop/preview/" | grep -c '\.conf$')" "gone|0"
snap() { (cd "$W" && find home sctl/state -type f -o -type l | sort | while read -r f; do printf '%s %s\n' "$f" "$(md5sum < "$f" 2>/dev/null | cut -c1-8)"; done); }
snap > "$TMP/s8.a"
migrate "$W" "$REPO_DIR"
snap > "$TMP/s8.b"
chk "再跑一轮，HOME 与单元状态逐字节不变" "$(diff "$TMP/s8.a" "$TMP/s8.b" >/dev/null && echo same || diff "$TMP/s8.a" "$TMP/s8.b" | head -3)" "same"
chk "没有剩下的迁移活了（轮询入口据此不再调迁移）" \
    "$(HOME="$W/home" bash -c 'source "$1/scripts/_names.sh"; cavil_legacy_leftovers && echo pending || echo none' _ "$REPO_DIR")" "none"

echo "【9】经真实轮询入口：已迁完、旧入口早被删、旧登记还在 → 这一轮就搬完"
scenario_poll_entry "$REPO_DIR" "$TMP/s9" > "$TMP/s9.res"; R="$TMP/s9.res"
chk "旧登记目录清空"                     "$(expect "$R" old_left)" "0"
chk "原本该开的 4040 由新监听接手"       "$(expect "$R" sock_4040)" "active"
chk "原本没开的 4041 保持不开"           "$(expect "$R" sock_4041)" "inactive"

# 场景 S10：查不到单元状态（用户服务管理器连不上）时一步都不能当成功
scenario_bus_down() {   # <code> <dir> <from_start|on_stop>：输出 键=值
    local code="$1" w="$2" when="$3"
    mkhome "$w" yes "$REPO_DIR"; oldreg "$w" 4050
    if [ "$when" = from_start ]; then
        setstate "$w" coding-agent-preview@4050.socket active
        : > "$w/sctl/bus-down"
    else
        # 原状记成「不开」（监听没在听），但旧 app 还在跑（比如被 --warm 拉起后监听被停了）：
        # 这时不会起新监听来暴露问题，停没停只能靠查状态判断
        setstate "$w" coding-agent-preview-app@4050.service active
        : > "$w/sctl/bus-down-on-stop"
    fi
    migrate "$w" "$code"
    echo "r1_old=$(has_old "$w" 4050)"
    echo "r1_link=$(legacy_link "$w")"
    echo "r1_old_sock=$(state "$w" coding-agent-preview@4050.socket)"
    echo "r1_old_app=$(state "$w" coding-agent-preview-app@4050.service)"
    echo "r1_backed=$(backed "$w" 4050)"
    rm -f "$w/sctl/bus-down"
    migrate "$w" "$code"
    echo "r2_old=$(has_old "$w" 4050)"
    echo "r2_new_sock=$(state "$w" cavil-loop-preview@4050.socket)"
    echo "r2_old_app=$(state "$w" coding-agent-preview-app@4050.service)"
    echo "r2_link=$(legacy_link "$w")"
}

echo "【10】查不到单元状态：一开始就连不上 → 什么都不收、旧入口保留；恢复后下一轮按旧监听原本在听来搬"
scenario_bus_down "$REPO_DIR" "$TMP/s10a" from_start > "$TMP/s10a.res"; R="$TMP/s10a.res"
chk "第 1 轮：旧登记还在、没进备份"   "$(expect "$R" r1_old)|$(expect "$R" r1_backed)" "yes|no"
chk "第 1 轮：旧入口保留"             "$(expect "$R" r1_link)" "kept"
chk "第 1 轮：旧监听照常在听"         "$(expect "$R" r1_old_sock)" "active"
chk "第 1 轮：没把「查不到」记成原本不开"     "$([ -e "$TMP/s10a/home/.config/cavil-loop/migration/preview-4050.listen" ] && cat "$TMP/s10a/home/.config/cavil-loop/migration/preview-4050.listen" || echo none)" "none"
chk "第 1 轮：日志写明查不到状态"     "$(grep -c ':4050 查不到旧监听的状态' "$TMP/s10a/home/.local/state/cavil-loop/migrate.log")" "1"
chk "第 2 轮：新监听接手、旧登记收走、旧入口删掉"     "$(expect "$R" r2_new_sock)|$(expect "$R" r2_old)|$(expect "$R" r2_link)" "active|no|gone"

echo "【10b】查不到单元状态：停旧单元的半路上连不上（旧 app 其实还在跑）→ 不收尾；恢复后下一轮搬完"
scenario_bus_down "$REPO_DIR" "$TMP/s10b" on_stop > "$TMP/s10b.res"; R="$TMP/s10b.res"
chk "第 1 轮：旧登记还在、没进备份、旧入口保留" \
    "$(expect "$R" r1_old)|$(expect "$R" r1_backed)|$(expect "$R" r1_link)" "yes|no|kept"
chk "第 1 轮：旧 app 仍在跑（停的那一下没成）" "$(expect "$R" r1_old_app)" "active"
chk "第 1 轮：日志写明查不到旧单元停没停" "$(grep -c ':4050 查不到旧单元 .* 停没停' "$TMP/s10b/home/.local/state/cavil-loop/migrate.log")" "1"
chk "第 2 轮：旧 app 停掉、旧登记收走、按原状不开新监听、旧入口删掉" \
    "$(expect "$R" r2_old_app)|$(expect "$R" r2_old)|$(expect "$R" r2_new_sock)|$(expect "$R" r2_link)" "inactive|no|inactive|gone"

# ─────────────────────────────────────────────────────────────────────────────
echo "【负对照】改动前的代码（$BASE_COMMIT）跑同一场景，必须变红"
BASE="$TMP/code-base"; mkdir -p "$BASE"
if git -C "$REPO_DIR" archive "$BASE_COMMIT" 2>/dev/null | tar -x -C "$BASE" 2>/dev/null; then
    scenario_issue "$BASE" "$TMP/b1" > "$TMP/b1.res"
    chk "issue 原场景：旧代码起不来却退出 0、打印地址（复现 issue）" \
        "$(expect "$TMP/b1.res" rc)|$(expect "$TMP/b1.res" url)|$(expect "$TMP/b1.res" new_app)" "0|1|inactive"
    scenario_issue_newfail "$BASE" "$TMP/b1b" > "$TMP/b1b.res"
    chk "起不来时旧代码仍打印地址" "$(expect "$TMP/b1b.res" url)" "1"
    scenario_probe "$BASE" "$TMP/b2" 502 > "$TMP/b2.res"
    chk "预热拿到 502 旧代码仍打印地址" "$(expect "$TMP/b2.res" url)" "1"
    scenario_poll_entry "$BASE" "$TMP/b9" > "$TMP/b9.res"
    chk "已迁完的机器上旧代码不再搬旧预览" "$(expect "$TMP/b9.res" old_left)" "2"
else
    echo "  ⚠️ 取不到 $BASE_COMMIT（浅克隆？），跳过负对照"
fi

echo "【负对照】PR #79 第 1 轮复审打回的那版（$PREV_COMMIT）：查不到状态时照样收尾，必须变红"
PREV="$TMP/code-prev"; mkdir -p "$PREV"
if git -C "$REPO_DIR" archive "$PREV_COMMIT" 2>/dev/null | tar -x -C "$PREV" 2>/dev/null; then
    for when in from_start on_stop; do
        scenario_bus_down "$PREV" "$TMP/p10-$when" "$when" > "$TMP/p10-$when.res"
        chk "上一版（$when）第 1 轮就收走旧登记或删了旧入口（实得 $(expect "$TMP/p10-$when.res" r1_old)|$(expect "$TMP/p10-$when.res" r1_link)）" \
            "$([ "$(expect "$TMP/p10-$when.res" r1_old)|$(expect "$TMP/p10-$when.res" r1_link)" != "yes|kept" ] && echo red || echo green)" "red"
    done
else
    echo "  ⚠️ 取不到 $PREV_COMMIT（浅克隆？），跳过负对照"
fi

echo
echo "通过 $pass，失败 $fail"
[ "$fail" = 0 ]
