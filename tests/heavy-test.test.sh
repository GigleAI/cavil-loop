#!/usr/bin/env bash
# kind: e2e
# 重测试整机排队 + 条目结束时清掉它的测试（GitHub#343）。
#
# 跑法：bash tests/heavy-test.test.sh        （约 1.5 分钟，2026-11-12 本机实测 89 秒）
# 依赖：tmux（3.0+）、git、flock、Linux 的 /proc。
#
# 真跑 scripts/heavy-test.sh、两个派工脚本、cleanup-issue.sh 和真 tmux（私有 socket，不碰本机
# 跑着 worker 的默认 server）。systemd 是替身：`systemd-run` 给进程打上一个环境变量当「分组
# 成员」，`systemctl` 按这个变量回答「分组在不在 / 停下这个分组」，并能按开关注入查询失败、
# 停止失败、卡住不返回。替身只用来验证**决策**——谁登记、谁等、谁被停、什么时候删工作树。
# 「进程逃不出分组」「整组停止」这些真实分组的成员语义由 tests/heavy-test-systemd.test.sh 在
# 真实的 systemd 用户实例上验证（那一份不进 CI）。
#
# 守的几件事，错了都不报错，只会悄悄两套叠着跑、或删掉正在用的工作树：
#   · 上一套的分组没空之前，下一套不启动——包装命令被强杀、查询失败时也一样
#   · 清理：先把条目的代数加一，再停本条目排队中 / 运行中的测试，确认分组消失后才删工作树
#   · 清理之前起的 worker 再来登记 / 再轮到 → 不启动；清理之后重新派工的 worker 照常跑
#   · 派工和清理拿同一把条目锁，一先一后
#   · worker 进程结束后，它起的测试被每轮检查停掉；worker 还在 / 认不清 → 不停
#   · 没配重测试命令的项目：提示词、GitHub 调用、状态文件和改动前一样
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

# 干净环境重跑自己：worker 会话里带着真 GH_TOKEN / TMUX / CAVIL_HEAVY_* 等，漏进来会让被测脚本
# 读到真值，或者让 tmux 命令连到外层 server。
if [ -z "${HEAVY_TEST_CLEAN_ENV:-}" ]; then
    exec env -i HEAVY_TEST_CLEAN_ENV=1 HOME="$HOME" PATH="$PATH" LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}" \
        ${KEEP_SANDBOX:+KEEP_SANDBOX="$KEEP_SANDBOX"} bash "${BASH_SOURCE[0]}" "$@"
fi

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/compat.sh
source "$TEST_DIR/lib/compat.sh"
# shellcheck source=lib/prompt-files.sh
source "$TEST_DIR/lib/prompt-files.sh"

for dep in tmux git flock; do
    if ! command -v "$dep" > /dev/null 2>&1; then echo "⏭ 本机没有 $dep，整份跳过"; exit 0; fi
done
if [ ! -r /proc/self/environ ]; then echo "⏭ 没有 /proc，整份跳过"; exit 0; fi

TMP=$(mktemp -d); TMP="$(cd "$TMP" && pwd -P)"
TMUX_DIR=$(mktemp -d /tmp/hv.XXXX)     # socket 路径有长度上限，单独放一个短目录
export TMUX_TMPDIR="$TMUX_DIR"
SOCK="$TMUX_DIR/tmux-$(id -u)/default"
mkdir -p "$(dirname "$SOCK")"; chmod 700 "$(dirname "$SOCK")"
REAL_TMUX="$(command -v tmux)"
T() { timeout 10 "$REAL_TMUX" -S "$SOCK" "$@"; }
FAKE="$TMP/fake"; CTL="$TMP/ctl"; FAKEBIN="$TMP/fakebin"; M="$TMP/marks"
mkdir -p "$FAKE" "$CTL" "$FAKEBIN" "$M"

# 本测试起的进程都带这个标记，收尾时只按它找（不按名字杀：别的 worktree 也在跑同名进程）
export HV_TEST_TAG="hvtest-$$-$RANDOM"
tagged_pids() { grep -lzx "HV_TEST_TAG=$HV_TEST_TAG" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3 | grep -vx "$$" || true; }
cleanup() {
    timeout 10 "$REAL_TMUX" -S "$SOCK" kill-server 2>/dev/null || true
    local p; for p in $(tagged_pids); do kill -KILL "$p" 2>/dev/null || true; done
    [ -n "${KEEP_SANDBOX:-}" ] && { echo "SANDBOX=$TMP"; return 0; }
    rm -rf "$TMP" "$TMUX_DIR"
}
trap cleanup EXIT

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 [$3]，实得 [$2]）"; fi; }
yes_() { if "${@:2}"; then ok "$1"; else bad "$1"; fi; }
no_()  { if "${@:2}"; then bad "$1"; else ok "$1"; fi; }
wait_for() {   # <最多几秒> <命令…>：等到命令成功
    local i n=$(( $1 * 10 )); shift
    for ((i = 0; i < n; i++)); do "$@" && return 0; sleep 0.1; done
    return 1
}
pid_gone() { ! kill -0 "$1" 2>/dev/null; }

# ── systemd 替身 ─────────────────────────────────────────────────────────────
# 分组成员 = 环境里带 FAKE_UNIT=<分组名> 的进程（子进程自动继承，脱离进程组也还带着）。
cat > "$FAKEBIN/systemd-run" <<SH
#!/usr/bin/env bash
unit=""
while [ \$# -gt 0 ]; do
    case "\$1" in
        --unit=*) unit="\${1#--unit=}"; shift ;;
        -p) echo "\$2" >> "$FAKE/props"; shift 2 ;;
        --) shift; break ;;
        *) shift ;;
    esac
done
echo "run \$unit" >> "$FAKE/calls"
[ ! -e "$FAKE/run-fail" ] || { echo "Failed to start transient scope unit" >&2; exit 1; }
cg="0::/fake.slice/\$unit"
[ ! -e "$FAKE/wrong-cgroup" ] || cg="0::/fake.slice/some-other.scope"
export FAKE_UNIT="\$unit" CAVIL_HEAVY_CGROUP_OVERRIDE="\$cg"
exec "\$@"
SH
cat > "$FAKEBIN/systemctl" <<SH
#!/usr/bin/env bash
# 从分组里被调用时（包装命令收尾时自己停自己）先换一个不带成员标记的进程：替身和它起的
# 子进程不能算进分组成员里，否则它数的是自己、杀的也是自己
if [ -n "\${FAKE_UNIT:-}" ]; then exec env -u FAKE_UNIT -u CAVIL_HEAVY_CGROUP_OVERRIDE "\$0" "\$@"; fi
members() { grep -lzx "FAKE_UNIT=\$1" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3 | grep -vx "\$\$" || true; }
[ "\${1:-}" = --user ] && shift
case "\${1:-}" in
    show-environment)
        echo "env" >> "$FAKE/calls"
        [ ! -e "$FAKE/env-fail" ] || exit 1
        exit 0 ;;
    show)
        echo "show \$2" >> "$FAKE/calls"
        [ ! -e "$FAKE/show-fail" ] || exit 1
        # show-fail-after 里写 N：从立起这个开关算起，前 N 次查询照常回答，之后的都失败
        if [ -e "$FAKE/show-fail-after" ]; then
            c=\$(( \$(cat "$FAKE/show-count" 2>/dev/null || echo 0) + 1 )); echo "\$c" > "$FAKE/show-count"
            [ "\$c" -le "\$(cat "$FAKE/show-fail-after")" ] || exit 1
        fi
        [ ! -e "$FAKE/show-junk" ] || { echo "LoadState=masked"; echo "ActiveState=maintenance"; exit 0; }
        [ ! -e "$FAKE/show-empty" ] || exit 0
        if [ -n "\$(members "\$2")" ]; then echo "LoadState=loaded"; echo "ActiveState=active"
        else echo "LoadState=not-found"; echo "ActiveState=inactive"; fi
        exit 0 ;;
    stop)
        shift; noblock=0
        [ "\${1:-}" = --no-block ] && { noblock=1; shift; }
        unit="\$1"
        # 记下「停的那一刻工作树还在不在」：清理必须先停后删
        echo "stop \$unit wt=\$( [ -d "\$(cat "$FAKE/watch-dir" 2>/dev/null || echo /nonexistent)" ] && echo present || echo absent )" >> "$FAKE/calls"
        while [ -e "$FAKE/stop-hold" ]; do sleep 0.1; done
        [ ! -e "$FAKE/stop-fail" ] || exit 1
        doit() {
            local p i
            for p in \$(members "\$unit"); do kill -TERM "\$p" 2>/dev/null; done
            for ((i = 0; i < 20; i++)); do [ -z "\$(members "\$unit")" ] && return 0; sleep 0.1; done
            for p in \$(members "\$unit"); do kill -KILL "\$p" 2>/dev/null; done
        }
        if [ "\$noblock" = 1 ]; then ( doit ) > /dev/null 2>&1 < /dev/null & else doit; fi
        exit 0 ;;
esac
exit 0
SH
chmod +x "$FAKEBIN"/*
calls() { local n; n="$(grep -c "^$1" "$FAKE/calls" 2>/dev/null)"; echo "${n:-0}"; }
members() { grep -lzx "FAKE_UNIT=$1" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3 || true; }
faults_off() { rm -f "$FAKE"/show-fail "$FAKE"/show-junk "$FAKE"/show-empty "$FAKE"/stop-fail "$FAKE"/stop-hold "$FAKE"/run-fail "$FAKE"/wrong-cgroup "$FAKE"/env-fail "$FAKE"/show-fail-after "$FAKE"/show-count; }
fail_after() { faults_off; echo "$1" > "$FAKE/show-fail-after"; }

export PATH="$FAKEBIN:$PATH"
NEW="$REPO_DIR"

# ═════════════════════════════════════════════════════════════════════════════
# 第一部分：排队命令本身
# ═════════════════════════════════════════════════════════════════════════════
HH="$TMP/home1"; mkdir -p "$HH"
RUNS="$HH/.local/state/cavil-loop/heavy-test/runs"
QLOCK="$HH/.local/state/cavil-loop/heavy-test.lock"
mkdir -p "$RUNS"
SD="$TMP/pstate"; mkdir -p "$SD"        # 一个「项目状态目录」，给带条目归属的运行用
W="$TMP/w"; mkdir -p "$W"

# 后台跑一套：hw_bg <名字> [变量=值…] -- <命令…>；输出在 $W/<名字>.out，进程号在 HW_PID
hw_bg() {
    local name="$1"; shift
    local envs=()
    while [ "$1" != -- ]; do envs+=("$1"); shift; done
    shift
    env HOME="$HH" CAVIL_HEAVY_MODE=full CAVIL_HEAVY_PRINT_SECS=1 "${envs[@]}" \
        bash "$NEW/scripts/heavy-test.sh" -- "$@" > "$W/$name.out" 2>&1 < /dev/null &
    HW_PID=$!
}
hw() { env HOME="$HH" CAVIL_HEAVY_MODE=full CAVIL_HEAVY_PRINT_SECS=1 bash "$NEW/scripts/heavy-test.sh" "$@"; }
# 被排队的「测试」：记下开始 / 结束的时刻。job <名字> <秒数> [退出码]
job() { printf 'date +%%s%%N > %q; sleep %s; date +%%s%%N > %q; exit %s' "$M/$1.start" "$2" "$M/$1.end" "${3:-0}"; }
started() { [ -s "$M/$1.start" ]; }
ended() { [ -s "$M/$1.end" ]; }
rec_of() { grep -l -- "$1" "$RUNS"/* 2>/dev/null | head -1; }      # 命令里带这个字样的运行记录
field() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1; }
no_overlap() {   # <甲> <乙>：两套的执行区间不相交
    local as ae bs be
    as=$(cat "$M/$1.start"); ae=$(cat "$M/$1.end"); bs=$(cat "$M/$2.start"); be=$(cat "$M/$2.end")
    [ "$ae" -le "$bs" ] || [ "$be" -le "$as" ]
}
reset1() { rm -f "$M"/* "$W"/* "$RUNS"/* "$FAKE/calls"; faults_off; rm -rf "$SD"/*; }
hold_queue() {   # 测试自己攥住排队锁（模拟「前面有人」），放开用 release_queue
    ( exec 7<>"$QLOCK"; flock 7; while [ -e "$CTL/qhold" ]; do sleep 0.1; done ) &
    QHOLD_PID=$!
}

echo "── 1. 两套同时请求：一次一套，等的那套看得到在等谁；退出码原样返回 ──"
reset1
hw_bg a CAVIL_HEAVY_ITEM=5 CAVIL_HEAVY_GEN=0 CAVIL_HEAVY_STATE_DIR="$SD" CAVIL_HEAVY_PROJECT=example/p -- bash -c "$(job a 3 3)"
pa=$HW_PID
wait_for 5 started a || bad "第一套没启动"
hw_bg b -- bash -c "$(job b 1)"
pb=$HW_PID
sleep 1.5
no_ "第一套还在跑时第二套没有启动" started b
wait "$pa"; rca=$?; wait "$pb"; rcb=$?
chk "第一套的退出码原样返回" "$rca" 3
chk "第二套的退出码原样返回" "$rcb" 0
yes_ "两套都跑完了" ended b
yes_ "两套的执行区间不重叠" no_overlap a b
yes_ "等的那套打印了在等哪个项目、哪个条目" grep -q "排队中：上一套重测试 example/p #5" "$W/b.out"
chk "跑完后没有留下运行记录" "$(ls "$RUNS" | wc -l)" 0
chk "每套都建了自己的分组" "$(calls run)" 2

echo "── 2. 第一套已登记、还没拿到排队锁时停住：第二套可以先跑，但两套不重叠 ──"
reset1
touch "$CTL/qhold"; hold_queue
hw_bg a -- bash -c "$(job a 1)"
pa=$HW_PID
wait_for 5 rec_of "$M/a.start" > /dev/null || bad "第一套没登记"
ra="$(rec_of "$M/a.start")"
chk "排队时记录是「排队中」" "$(field "$ra" state)" queued
ua="$(field "$ra" unit)"
# 把第一套整个冻住（内层和它正在等锁的子进程，都还没拿到锁）
for p in $(members "$ua"); do kill -STOP "$p" 2>/dev/null; done
rm -f "$CTL/qhold"; wait "$QHOLD_PID" 2>/dev/null
hw_bg b -- bash -c "$(job b 1)"
pb=$HW_PID
wait "$pb"
yes_ "第二套先跑完了（排队中的记录不挡人）" ended b
no_ "被冻住的第一套没有启动" started a
for p in $(members "$ua"); do kill -CONT "$p" 2>/dev/null; done
wait "$pa"
yes_ "第一套随后也跑完了" ended a
yes_ "两套的执行区间不重叠" no_overlap a b

echo "── 3. 上一套的包装命令被强杀、测试还在跑：已拿到锁的也不启动，等它的分组清空 ──"
reset1
hw_bg x -- bash -c "echo \$\$ > '$M/x.main'; sleep 300 & echo \$! > '$M/x.sleeper'; date +%s%N > '$M/x.start'; sleep 300"
px=$HW_PID
wait_for 5 started x || bad "上一套没启动"
rx="$(rec_of x.sleeper)"; ux="$(field "$rx" unit)"
kill -KILL "$px" "$(field "$rx" pid)" "$(cat "$M/x.main")" 2>/dev/null     # 包装命令和测试主进程都没了，只剩后台子进程
wait "$px" 2>/dev/null
hw_bg a -- bash -c "$(job a 1)"; pa=$HW_PID
sleep 0.5
hw_bg b -- bash -c "$(job b 1)"; pb=$HW_PID
sleep 2.5
no_ "上一套的分组里还有进程：第一个排队者没有启动" started a
no_ "第二个排队者也没有启动" started b
yes_ "上一套的记录还在（没被当成已结束删掉）" test -f "$rx"
chk "没有人去停上一套（没有归属就只等）" "$(calls stop)" 0
yes_ "排队者打印了上一套还有进程在运行" grep -q "还有进程在运行" "$W/a.out"
kill -KILL "$(cat "$M/x.sleeper")" 2>/dev/null
wait "$pa"; wait "$pb"
yes_ "上一套的最后一个进程退出后，两个排队者依次跑完" ended b
yes_ "它们的执行区间不重叠" no_overlap a b
no_ "上一套的记录在分组清空后被删掉" test -f "$rx"

echo "── 4. 排队中的包装命令被强杀：分组消失后记录被删，不挡后面的 ──"
reset1
touch "$CTL/qhold"; hold_queue
hw_bg a -- bash -c "$(job a 1)"; pa=$HW_PID
wait_for 5 rec_of "$M/a.start" > /dev/null || bad "没登记"
ra="$(rec_of "$M/a.start")"
kill -KILL "$pa" "$(field "$ra" pid)" 2>/dev/null; wait "$pa" 2>/dev/null
for p in $(members "$(field "$ra" unit)"); do kill -KILL "$p" 2>/dev/null; done    # 内层正在跑的 flock 子进程
rm -f "$CTL/qhold"; wait "$QHOLD_PID" 2>/dev/null
hw_bg b -- bash -c "$(job b 0.3)"; pb=$HW_PID
wait "$pb"
yes_ "后面那套照常跑完" ended b
no_ "被杀的那套没有启动过" started a
no_ "它的记录被删掉了" test -f "$ra"

echo "── 5. 分组状态查不到 / 不认识：当作还在跑——不删记录、不放行、不停任何分组 ──"
for fault in show-fail show-junk show-empty; do
    reset1
    id="$(printf '%032x' $RANDOM)"
    printf 'state=running\nunit=cavil-heavy-%s.scope\nstatedir=/nonexistent/q\nproject=example/q\nitem=9\ngen=0\nlaunch=\npid=1\nsince=%s\ncmd=old run\n' "$id" "$(date +%s)" > "$RUNS/$id"
    touch "$FAKE/$fault"
    hw_bg b -- bash -c "$(job b 0.3)"; pb=$HW_PID
    sleep 2.5
    no_ "$fault：没有启动" started b
    yes_ "$fault：那条记录还在" test -f "$RUNS/$id"
    chk "$fault：没有停任何分组" "$(calls stop)" 0
    yes_ "$fault：确实查过分组状态" test "$(calls show)" -gt 0
    faults_off
    wait "$pb"
    yes_ "$fault：查询恢复、确认分组不存在后启动" ended b
    no_ "$fault：那条记录随后被删" test -f "$RUNS/$id"
done

echo "── 5b. 上一套的运行记录读不到 / 内容不认识：不能当它没在跑——不启动、不删记录；它结束后才启动 ──"
# 把一条记录弄坏的几种办法；每种都记下原样，之后能恢复
spoil() {   # <办法> <记录文件>
    cp -p "$2" "$TMP/rec.bak"
    case "$1" in
        unreadable) chmod 000 "$2" ;;
        garbage) echo "not a record at all" > "$2" ;;
        empty) : > "$2" ;;
        bad-state) sed -i 's/^state=.*/state=finished/' "$2" ;;
        no-state) sed -i '/^state=/d' "$2" ;;
        wrong-unit) sed -i 's/^unit=.*/unit=cavil-heavy-00000000000000000000000000000000.scope/' "$2" ;;
        no-*) sed -i "/^${1#no-}=/d" "$2" ;;                      # 整行没了（不是写成空）
        blank-*) sed -i "s|^${1#blank-}=.*|${1#blank-}=|" "$2" ;;  # 这一行在，值是空
        dup-*) sed -n "/^${1#dup-}=/p" "$2" >> "$2" ;;             # 同一个字段出现两次
    esac
}
unspoil() { chmod 600 "$1" 2>/dev/null; cp -p "$TMP/rec.bak" "$1"; }
WAYS="garbage empty bad-state no-state wrong-unit"
[ "$(id -u)" = 0 ] || WAYS="unreadable $WAYS"       # root 读得了权限 000 的文件，那一种测不出东西
for way in $WAYS; do
    reset1
    hw_bg x -- bash -c "echo \$\$ > '$M/x.main'; date +%s%N > '$M/x.start'; sleep 300"
    px=$HW_PID
    wait_for 5 started x || bad "$way：上一套没启动"
    rx="$(rec_of x.main)"; ux="$(field "$rx" unit)"
    kill -KILL "$px" "$(field "$rx" pid)" 2>/dev/null; wait "$px" 2>/dev/null      # 包装命令没了，排队锁放了，测试还在
    spoil "$way" "$rx"
    hw_bg b -- bash -c "$(job b 0.3)"; pb=$HW_PID
    sleep 2.5
    no_ "$way：下一套没有启动" started b
    yes_ "$way：那条记录还在" test -e "$rx"
    yes_ "$way：上一套的测试没被打扰" kill -0 "$(cat "$M/x.main")"
    chk "$way：没有停任何分组" "$(calls stop)" 0
    yes_ "$way：确实按文件名查过它的分组" grep -q "^show $ux" "$FAKE/calls"
    yes_ "$way：说了是哪条记录读不出来" grep -q "运行记录读不出来或内容不认识" "$W/b.out"
    hw --list > "$W/list.out" 2>&1
    yes_ "$way：--list 里它标着读不到" grep -q "^${rx##*/}  读不到  分组:active" "$W/list.out"
    unspoil "$rx"
    sleep 2
    no_ "$way：记录恢复可读、上一套还在跑：仍不启动" started b
    kill -KILL "$(cat "$M/x.main")" 2>/dev/null
    wait "$pb"; rc=$?
    chk "$way：上一套结束后下一套跑完" "$rc" 0
    yes_ "$way：确实跑到了结束" ended b
    no_ "$way：上一套的记录随后被删" test -e "$rx"
done
# 记录读不到、但它的分组已经确认消失：这条运行了结了，删掉记录、照常放行
reset1
id="$(printf '%032x' 4242)"; echo "garbage" > "$RUNS/$id"
hw_bg b -- bash -c "$(job b 0.2)"; wait "$HW_PID"; rc=$?
chk "读不到的记录、分组已消失：下一套照常跑完" "$rc" 0
no_ "那条记录被删" test -e "$RUNS/$id"
# 读不到的记录也能按编号手动停
reset1
hw_bg x -- bash -c "echo \$\$ > '$M/x.main'; date +%s%N > '$M/x.start'; sleep 300"; px=$HW_PID
wait_for 5 started x || bad "没启动"
rx="$(rec_of x.main)"
echo "garbage" > "$rx"
hw --stop "${rx##*/}" > "$W/stop.out" 2>&1; rc=$?
chk "读不到的记录：--stop 按编号照样停得掉" "$rc" 0
yes_ "测试被停了" wait_for 5 pid_gone "$(cat "$M/x.main")"
no_ "记录被删" test -e "$rx"
wait "$px" 2>/dev/null

echo "── 5c. 运行记录逐字段核对：十个字段缺哪一行都算读不到；归属三项要么全有要么全空 ──"
L=0123456789abcdef0123456789abcdef
mystart="$(bash -c 'source "$1/scripts/_heavy.sh"; heavy_proc_start "$2"' _ "$NEW" "$$")"
load_rc() { bash -c 'source "$1/scripts/_heavy.sh"; heavy_run_load "$2"; echo $?' _ "$NEW" "$1"; }
reset1
# 两条真记录：一条有条目归属，一条是手动运行——都由真的排队命令写出来
printf 'pid=%s\nstart=%s\n' "$$" "$mystart" > "$TMP/launch.tmp"; mkdir -p "$SD/worker-launch"; cp "$TMP/launch.tmp" "$SD/worker-launch/$L"
hw_bg own CAVIL_HEAVY_ITEM=5 CAVIL_HEAVY_GEN=0 CAVIL_HEAVY_LAUNCH="$L" CAVIL_HEAVY_STATE_DIR="$SD" CAVIL_HEAVY_PROJECT=example/p -- bash -c "$(job own 300)"; pown=$HW_PID
wait_for 5 started own || bad "有归属的那套没启动"
rown="$(rec_of "$M/own.start")"
cp "$rown" "$TMP/own.rec"; hw --stop "${rown##*/}" > /dev/null 2>&1; wait "$pown" 2>/dev/null
hw_bg man -- bash -c "$(job man 300)"; pman=$HW_PID
wait_for 5 started man || bad "手动的那套没启动"
rman="$(rec_of "$M/man.start")"
cp "$rman" "$TMP/man.rec"; hw --stop "${rman##*/}" > /dev/null 2>&1; wait "$pman" 2>/dev/null
mkdir -p "$TMP/lt"
try_rec() {   # <own|man> <办法> → 读取结果
    local src="$TMP/$1.rec" id; id="$( [ "$1" = own ] && echo "${rown##*/}" || echo "${rman##*/}" )"
    cp "$src" "$TMP/lt/$id"
    [ "$2" = intact ] || { spoil "$2" "$TMP/lt/$id"; }
    load_rc "$TMP/lt/$id"
}
chk "真的有归属记录：读得到" "$(try_rec own intact)" 0
chk "真的手动运行记录：读得到" "$(try_rec man intact)" 0
chk "手动运行记录里归属四项都写着空" "$(grep -cxE '(statedir|item|gen|launch)=' "$TMP/man.rec")" 4
for fld in state unit statedir project item gen launch pid since cmd; do
    chk "有归属的记录缺 $fld 这一行：读不到" "$(try_rec own "no-$fld")" 2
    chk "手动运行的记录缺 $fld 这一行：读不到（不能推断成手动运行）" "$(try_rec man "no-$fld")" 2
done
for fld in statedir item gen; do
    chk "有归属的记录把 $fld 写成空（归属只剩一部分）：读不到" "$(try_rec own "blank-$fld")" 2
done
chk "有归属的记录把启动编号写成空：仍读得到（派工时可以没拿到启动编号）" "$(try_rec own blank-launch)" 0
chk "项目名、命令写成空：仍读得到（只用于显示）" "$(try_rec own blank-project)$(try_rec own blank-cmd)" 00
for fld in state statedir item pid; do
    chk "$fld 出现两次：读不到" "$(try_rec own "dup-$fld")" 2
done
chk "pid 不是数字：读不到" "$(cp "$TMP/own.rec" "$TMP/lt/${rown##*/}"; sed -i 's/^pid=.*/pid=abc/' "$TMP/lt/${rown##*/}"; load_rc "$TMP/lt/${rown##*/}")" 2
chk "项目状态目录不是绝对路径：读不到" "$(cp "$TMP/own.rec" "$TMP/lt/${rown##*/}"; sed -i 's/^statedir=.*/statedir=relative\/dir/' "$TMP/lt/${rown##*/}"; load_rc "$TMP/lt/${rown##*/}")" 2
chk "手动运行却带着启动编号：读不到" "$(cp "$TMP/man.rec" "$TMP/lt/${rman##*/}"; sed -i "s/^launch=.*/launch=$L/" "$TMP/lt/${rman##*/}"; load_rc "$TMP/lt/${rman##*/}")" 2
chk "文件不在：算已经了结" "$(load_rc "$TMP/lt/does-not-exist")" 1
# 排队命令这一头：环境里的归属只给了一部分，不能悄悄当成手动运行
reset1
env HOME="$HH" CAVIL_HEAVY_MODE=full CAVIL_HEAVY_ITEM=5 CAVIL_HEAVY_STATE_DIR="$SD" bash "$NEW/scripts/heavy-test.sh" -- bash -c "$(job part 0.1)" > "$W/part.out" 2>&1; rc=$?
chk "环境里有条目号、没有代数：退出码 76" "$rc" 76
no_ "没有启动" started part
chk "没有登记" "$(ls "$RUNS" | wc -l)" 0
env HOME="$HH" CAVIL_HEAVY_MODE=full CAVIL_HEAVY_ITEM=5 CAVIL_HEAVY_GEN=0 CAVIL_HEAVY_STATE_DIR=relative bash "$NEW/scripts/heavy-test.sh" -- bash -c "$(job part2 0.1)" > "$W/part2.out" 2>&1; rc=$?
chk "项目状态目录不是绝对路径：退出码 76" "$rc" 76
no_ "没有启动" started part2

echo "── 6. 测试退出时留下后台子进程：收尾把整个分组停掉；分组外的进程不受影响 ──"
reset1
sleep 300 & outside=$!
hw_bg a -- bash -c "setsid sleep 300 & echo \$! > '$M/a.left'; $(job a 0.3 4)"; pa=$HW_PID
wait "$pa"; rc=$?
chk "退出码仍是测试自己的" "$rc" 4
yes_ "留下的后台子进程（已脱离进程组）被结束" wait_for 5 pid_gone "$(cat "$M/a.left")"
yes_ "分组外的进程还在" kill -0 "$outside"
chk "没有留下运行记录" "$(ls "$RUNS" | wc -l)" 0
kill "$outside" 2>/dev/null

echo "── 7. 排队上限、建不出分组、不在预期分组里 ──"
reset1
touch "$CTL/qhold"; hold_queue
hw_bg a CAVIL_HEAVY_LOCK_WAIT=2 -- bash -c "$(job a 0.3)"; pa=$HW_PID
wait "$pa"; rc=$?
chk "排队超过上限退出码 75" "$rc" 75
no_ "没有启动" started a
chk "放弃后没有留下记录" "$(ls "$RUNS" | wc -l)" 0
rm -f "$CTL/qhold"; wait "$QHOLD_PID" 2>/dev/null
touch "$FAKE/run-fail"
hw -- bash -c "$(job c 0.1)" > "$W/c.out" 2>&1; rc=$?
chk "建不出分组：退出码 70" "$rc" 70
no_ "建不出分组：没有跑命令（不悄悄降级）" started c
yes_ "建不出分组：说了原因" grep -q "建不出这次运行的进程分组" "$W/c.out"
faults_off; touch "$FAKE/wrong-cgroup"
hw -- bash -c "$(job d 0.1)" > "$W/d.out" 2>&1; rc=$?
chk "不在预期分组里：退出码 70" "$rc" 70
no_ "不在预期分组里：没有跑命令" started d
chk "不在预期分组里：没有登记" "$(ls "$RUNS" | wc -l)" 0
faults_off

echo "── 8. 条目代数和 worker 是否还在：对不上 / 读不出就不启动 ──"
reset1
item_env=(CAVIL_HEAVY_ITEM=5 CAVIL_HEAVY_GEN=0 CAVIL_HEAVY_STATE_DIR="$SD" CAVIL_HEAVY_PROJECT=example/p)
run_item() {   # <名字> [多出来的变量…]：前台跑一套带条目归属的，返回退出码
    local name="$1"; shift
    env HOME="$HH" CAVIL_HEAVY_MODE=full "${item_env[@]}" "$@" bash "$NEW/scripts/heavy-test.sh" -- bash -c "$(job "$name" 0.1)" > "$W/$name.out" 2>&1
}
run_item g0; chk "代数一致：照常跑" "$?" 0
yes_ "代数一致：确实跑了" ended g0
mkdir -p "$SD/item-gen"; echo 1 > "$SD/item-gen/5"
run_item g1; chk "条目被清理过（代数变了）：退出码 76" "$?" 76
no_ "代数变了：没有启动" started g1
chk "代数变了：没有登记" "$(ls "$RUNS" | wc -l)" 0
echo oops > "$SD/item-gen/5"
run_item g2; chk "代数读不出：退出码 76" "$?" 76
no_ "代数读不出：没有启动" started g2
rm -f "$SD/item-gen/5"
mkdir -p "$SD/worker-launch"
printf 'pid=%s\nstart=%s\n' "$$" "$mystart" > "$SD/worker-launch/$L"
run_item l1 CAVIL_HEAVY_LAUNCH="$L"; chk "起它的 worker 还在：照常跑" "$?" 0
yes_ "worker 还在：确实跑了" ended l1
printf 'pid=%s\nstart=%s\n' "$$" 1 > "$SD/worker-launch/$L"
run_item l2 CAVIL_HEAVY_LAUNCH="$L"; chk "进程号被别的进程复用（启动时间不同）：退出码 76" "$?" 76
no_ "进程号被复用：没有启动" started l2
sleep 0.01 & deadpid=$!; wait "$deadpid"
printf 'pid=%s\nstart=%s\n' "$deadpid" 1 > "$SD/worker-launch/$L"
run_item l3 CAVIL_HEAVY_LAUNCH="$L"; chk "worker 已结束：退出码 76" "$?" 76
no_ "worker 已结束：没有启动" started l3
echo garbage > "$SD/worker-launch/$L"
run_item l4 CAVIL_HEAVY_LAUNCH="$L"; chk "启动记录读不出：退出码 76" "$?" 76
no_ "启动记录读不出：没有启动" started l4
printf 'pid=pending\nstart=\n' > "$SD/worker-launch/$L"
run_item l5 CAVIL_HEAVY_LAUNCH="$L"; chk "登记了启动、进程号还没读到：照常跑" "$?" 0
yes_ "进程号待定：确实跑了" ended l5
printf 'pid=%s\nstart=%s\nended=1\n' "$$" "$mystart" > "$SD/worker-launch/$L"
run_item l6 CAVIL_HEAVY_LAUNCH="$L"; chk "记录上盖了「已结束」（就算那个进程号现在有进程）：退出码 76" "$?" 76
no_ "盖了已结束：没有启动" started l6
mv "$SD/worker-launch/$L" "$SD/worker-launch/moved-away"
run_item l7 CAVIL_HEAVY_LAUNCH="$L"; chk "找不到这次启动的记录：退出码 76" "$?" 76
no_ "没有记录：没有启动" started l7
yes_ "没有记录：说了原因" grep -q "找不到起这套测试的那次 worker 启动的记录" "$W/l7.out"

echo "── 9. 没有 systemd 用户实例：只排队包装命令本身，说明降级，不登记 ──"
reset1
env HOME="$HH" CAVIL_HEAVY_MODE=degraded bash "$NEW/scripts/heavy-test.sh" -- bash -c "$(job a 1 5)" > "$W/a.out" 2>&1 &
pa=$!
wait_for 5 started a || bad "没启动"
env HOME="$HH" CAVIL_HEAVY_MODE=degraded bash "$NEW/scripts/heavy-test.sh" -- bash -c "$(job b 0.3)" > "$W/b.out" 2>&1 &
pb=$!
wait "$pa"; rc=$?; wait "$pb"
chk "降级：退出码原样返回" "$rc" 5
yes_ "降级：两套仍然不重叠" no_overlap a b
yes_ "降级：打印了降级说明" grep -q "只排队这条命令本身" "$W/a.out"
chk "降级：没有建分组" "$(calls run)" 0
chk "降级：没有登记" "$(ls "$RUNS" | wc -l)" 0
# 降级模式看不了分组：还留着登记着的运行时不能当它们不存在
id="$(printf '%032x' 77)"
printf 'state=running\nunit=cavil-heavy-%s.scope\nstatedir=\nproject=\nitem=\ngen=\nlaunch=\npid=1\nsince=%s\ncmd=old run\n' "$id" "$(date +%s)" > "$RUNS/$id"
env HOME="$HH" CAVIL_HEAVY_MODE=degraded bash "$NEW/scripts/heavy-test.sh" -- bash -c "$(job c 0.1)" > "$W/c.out" 2>&1; rc=$?
chk "降级但还有登记着的运行：退出码 70" "$rc" 70
no_ "降级但还有登记着的运行：没有启动" started c
yes_ "那条记录还在" test -f "$RUNS/$id"

echo "── 9b. systemd 用户实例这一次没问到：不是「不支持」——不降级、不启动；恢复后等上一套结束才启动 ──"
reset1
# 上一套：包装命令被强杀，排队锁已经放了，测试还在分组里跑
hw_bg x -- bash -c "echo \$\$ > '$M/x.main'; date +%s%N > '$M/x.start'; sleep 300"
px=$HW_PID
wait_for 5 started x || bad "上一套没启动"
rx="$(rec_of x.main)"
kill -KILL "$px" "$(field "$rx" pid)" 2>/dev/null; wait "$px" 2>/dev/null
yes_ "上一套的测试还活着" kill -0 "$(cat "$M/x.main")"
yes_ "排队锁此刻没人拿着" flock -n "$QLOCK" true
touch "$FAKE/env-fail"; : > "$FAKE/calls"
env HOME="$HH" CAVIL_HEAVY_MODE=probe bash "$NEW/scripts/heavy-test.sh" -- bash -c "$(job b 0.3)" > "$W/b.out" 2>&1; rc=$?
chk "没问到用户实例：退出码 70" "$rc" 70
no_ "没问到用户实例：没有启动" started b
no_ "没问到用户实例：没有走降级" grep -q "只排队这条命令本身" "$W/b.out"
yes_ "没问到用户实例：说了原因" grep -q "没能问到 systemd 用户实例" "$W/b.out"
chk "确实问过一次、没有建分组" "$(calls env) $(calls run)" "1 0"
yes_ "上一套的测试没被打扰" kill -0 "$(cat "$M/x.main")"
faults_off
env HOME="$HH" CAVIL_HEAVY_MODE=probe CAVIL_HEAVY_PRINT_SECS=1 bash "$NEW/scripts/heavy-test.sh" -- bash -c "$(job b 0.3)" > "$W/b.out" 2>&1 &
pb=$!
sleep 2.5
no_ "恢复后：上一套还在跑，仍不启动" started b
kill -KILL "$(cat "$M/x.main")" 2>/dev/null
wait "$pb"; rc=$?
chk "恢复后：上一套结束才跑完" "$rc" 0
yes_ "恢复后：确实跑到了结束" ended b

echo "── 10. 查看谁在跑、手动停一套 ──"
reset1
hw_bg a CAVIL_HEAVY_ITEM=5 CAVIL_HEAVY_GEN=0 CAVIL_HEAVY_STATE_DIR="$SD" CAVIL_HEAVY_PROJECT=example/p -- bash -c "$(job a 300)"; pa=$HW_PID
wait_for 5 started a || bad "没启动"
ra="$(rec_of "$M/a.start")"; ida="${ra##*/}"
hw --list > "$W/list.out" 2>&1
yes_ "--list 列出这套：编号、运行中、项目和条目" grep -q "^$ida  running  分组:active  example/p #5" "$W/list.out"
hw --stop "$ida" > "$W/stop.out" 2>&1; rc=$?
chk "--stop 成功" "$rc" 0
wait "$pa"; rc=$?
chk "被停的那套以 143 退出" "$rc" 143
no_ "被停的测试没有跑到结束" ended a
no_ "记录被删" test -f "$ra"
hw --list > "$W/list.out" 2>&1
yes_ "--list 这时说没有登记着的重测试" grep -q "没有登记着的重测试" "$W/list.out"

# ═════════════════════════════════════════════════════════════════════════════
# 第二部分：派工、清理、每轮检查
# ═════════════════════════════════════════════════════════════════════════════
# 假 gh：$CTL/gh-hold 在的时候卡住不返回（模拟派工进行到一半）
cat > "$FAKEBIN/gh" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CTL/gh.log"
while [ -e "$CTL/gh-hold" ]; do sleep 0.1; done
case "\$*" in *title*) echo "测试标题"; exit 0 ;; esac
echo "{}"
SH
# 假 agent：不在 tmux 里（driver 探版本之类）立刻退出；在 tmux 里记一行然后睡着
cat > "$FAKEBIN/claude" <<SH
#!/usr/bin/env bash
[ -n "\${TMUX:-}" ] || exit 0
trap '' HUP
echo "claude \$\$" >> "$CTL/runs"
exec sleep 600
SH
cat > "$FAKEBIN/tmux" <<SH
#!/usr/bin/env bash
exec "$REAL_TMUX" "\$@"
SH
chmod +x "$FAKEBIN"/*

gq() { git -c user.email=t@example.invalid -c user.name=t "$@" >/dev/null 2>&1; }
G="$TMP/git"; mkdir -p "$G"
gq init -q --bare -b main "$G/up.git"
gq clone -q "$G/up.git" "$G/seed"
(cd "$G/seed" && echo x > f && gq add f && gq commit -qm init && gq push -q origin HEAD:main)
# 编号取真实 issue 用不到的大数，避开本机真实派工的编号（提示词写在各场景自己的状态目录里）
N=987343
SESS="hvtest-issue$N"

# 一个场景一套独立目录。setup2 <名字> [多出来的配置行…]
setup2() {
    D="$TMP/sc.$1"; shift
    rm -rf "$D"; mkdir -p "$D/state" "$D/logs" "$D/home"
    gq clone -q "$G/up.git" "$D/proj"
    WT="$D/wt/issue-$N"
    gq -C "$D/proj" worktree add -q "$WT" -b "feature/issue-$N"
    cat > "$D/config" <<CONF
REPO="example/none"
PROJECT_ROOT="$D/proj"
WORKTREE_BASE="$D/wt"
STATE_DIR="$D/state"
SESSION_LOG_DIR="$D/logs"
TMUX_PREFIX="hvtest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
WORKER_AGENT="claude"
AGENT_TRUST_PROMPT_WAIT_SECS=1
AGENT_SESSION_CAPTURE_SECS=1
REAP_KILL_GRACE_SECS=3
GH_TOKEN="fake-token-for-test"
CONF
    local line; for line in "$@"; do printf '%s\n' "$line" >> "$D/config"; done
    : > "$CTL/runs"; : > "$CTL/gh.log"; rm -f "$CTL/gh-hold" "$CTL/hook-hold" "$FAKE/calls"; faults_off
    echo "$WT" > "$FAKE/watch-dir"
    T kill-server 2>/dev/null
    T new-session -d -s keep "sleep 600"
    RUNS="$D/home/.local/state/cavil-loop/heavy-test/runs"; mkdir -p "$RUNS"
    rm -f "$M"/* "$W"/*
}
ON='HEAVY_TEST_COMMANDS="bash tests/run.sh"'
# 跑一次派工。<skill 目录> <issue|pr>；输出在 $D/dispatch.out
dispatch() {
    (cd "$D/proj" && HOME="$D/home" CODING_AGENT_CONFIG="$D/config" DISPATCH_WORKER_AGENT=claude DISPATCH_PROMPT_KIND="" \
        timeout 120 bash -c '
            if [ "$1" = issue ]; then exec bash "$2/scripts/dispatch-issue-comment.sh" '"$N"' 0
            else exec bash "$2/scripts/dispatch-pr-comment.sh" '"$N"' feature/issue-'"$N"' 0; fi' _ "$2" "$1") \
        > "$D/dispatch.out" 2>&1
}
cleanup_item() {   # <skill 目录> [参数…]；输出在 $D/cleanup.out
    local R="$1"; shift
    (cd "$D/proj" && HOME="$D/home" CODING_AGENT_CONFIG="$D/config" timeout 120 bash "$R/scripts/cleanup-issue.sh" "$N" "$@") > "$D/cleanup.out" 2>&1
}
sweep() {   # 每轮检查那一步（agent-poll.sh 的 0c），用项目配置加载真的公共库来跑
    (cd "$D/proj" && HOME="$D/home" CODING_AGENT_CONFIG="$D/config" timeout 60 bash -c 'source "$1/scripts/_lib.sh"; heavy_sweep_tick' _ "$NEW") > "$D/sweep.out" 2>&1
}
pane_pid() { T list-panes -s -t "=$SESS:" -F '#{pane_pid}' 2>/dev/null | head -1; }
worker_env() { tr '\0' '\n' < "/proc/$(pane_pid)/environ" 2>/dev/null | grep '^CAVIL_HEAVY_' || true; }
wenv() { worker_env | sed -n "s/^$1=//p"; }
# 以这个 worker 的身份跑一套：hw2_bg <名字> <秒数>
hw2_bg() {
    local envs=() line
    while IFS= read -r line; do [ -n "$line" ] && envs+=("$line"); done < <(worker_env)
    env HOME="$D/home" CAVIL_HEAVY_MODE=full CAVIL_HEAVY_PRINT_SECS=1 "${envs[@]}" \
        bash "$NEW/scripts/heavy-test.sh" -- bash -c "$(job "$1" "$2")" > "$W/$1.out" 2>&1 < /dev/null &
    HW_PID=$!
}
gen_now() { cat "$D/state/item-gen/$N" 2>/dev/null || echo 0; }
gen_is() { [ "$(gen_now)" = "$1" ]; }
lock_free() { flock -n "$D/state/item-locks/$N.lock" true 2>/dev/null; }
state_files() { (cd "$D/state" && find . -type f | grep -v -e 'poll.log' -e '^./prompt-composed' | sort); }

echo "── 11. 派工（issue 评论入口）：worker 带着条目、代数、启动编号；记下了启动；锁用完就放 ──"
setup2 on "$ON"
dispatch "$NEW" issue; rc=$?
chk "派工成功" "$rc" 0
yes_ "worker 起来了" wait_for 5 test -s "$CTL/runs"
chk "worker 环境里有条目号" "$(wenv CAVIL_HEAVY_ITEM)" "$N"
chk "worker 环境里的代数是 0（没清理过）" "$(wenv CAVIL_HEAVY_GEN)" 0
chk "worker 环境里有项目状态目录" "$(wenv CAVIL_HEAVY_STATE_DIR)" "$D/state"
L1="$(wenv CAVIL_HEAVY_LAUNCH)"
yes_ "worker 环境里有启动编号" test -n "$L1"
chk "启动记录里是 worker 窗格的进程号" "$(field "$D/state/worker-launch/$L1" pid)" "$(pane_pid)"
yes_ "派工结束后条目锁是空闲的（worker 还活着）" lock_free
PROMPT="$(prompt_file_of "$NEW" "$D/state" cmt "$N" 0)"
LINE="$(grep -m1 -E '^bash [^ ]*/scripts/heavy-test\.sh -- bash tests/run\.sh$' "$PROMPT")"
chk "提示词里写了排队命令的整行写法" "$LINE" "bash $NEW/scripts/heavy-test.sh -- bash tests/run.sh"
# 用量 footer 认测试命令的那份规则，拿提示词里这一行原样去认：必须还是「整套测试」，否则测试时间会悄悄少算
kind_of() { python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import test_time; k = test_time.classify(sys.argv[2]); print("suite" if k["suite"] else "adhoc" if k["adhoc"] else "none")' "$NEW/scripts/drivers/token-usage" "$1"; }
chk "这一行在用量 footer 里仍算一次整套测试" "$(kind_of "$LINE")" suite
chk "套着排队命令单跑一个文件：仍算单跑" "$(kind_of "bash $NEW/scripts/heavy-test.sh -- bash tests/smoke.test.sh")" adhoc
chk "排队命令的 --list 不算测试" "$(kind_of "bash $NEW/scripts/heavy-test.sh --list")" none
no_ "条目锁的标记没有漏进 worker 的环境" grep -qz "CAVIL_ITEM_LOCK_HELD" "/proc/$(pane_pid)/environ"

echo "── 12. 再来一条评论、注入现有会话：不算新启动，启动编号不变 ──"
dispatch "$NEW" issue
chk "worker 没有被重起" "$(wc -l < "$CTL/runs")" 1
chk "启动编号没变" "$(wenv CAVIL_HEAVY_LAUNCH)" "$L1"
chk "启动记录仍只有一份" "$(ls "$D/state/worker-launch" | wc -l)" 1

echo "── 13. 每轮检查：worker 还在不停；worker 结束后停掉它起的测试；认不清不停 ──"
hw2_bg t1 300; p1=$HW_PID
wait_for 5 started t1 || bad "worker 的测试没启动"
r1="$(rec_of "$M/t1.start")"; u1="$(field "$r1" unit)"
chk "运行记录里记着启动编号" "$(field "$r1" launch)" "$L1"
sweep
yes_ "worker 还在：测试没被停" test -n "$(members "$u1")"
chk "worker 还在：没有停任何分组" "$(calls stop)" 0
yes_ "worker 还在：确实查过这套的分组" grep -q "show $u1" "$FAKE/calls"
cp "$D/state/worker-launch/$L1" "$TMP/launch.bak"; echo garbage > "$D/state/worker-launch/$L1"
wp="$(pane_pid)"; T kill-session -t "=$SESS"; kill -KILL "$wp" 2>/dev/null; kill -KILL "$(awk '{print $2}' "$CTL/runs")" 2>/dev/null
wait_for 5 pid_gone "$wp"
sweep
yes_ "启动记录读不出：不停（就算 worker 其实已经没了）" test -n "$(members "$u1")"
cp "$TMP/launch.bak" "$D/state/worker-launch/$L1"
no_ "tmux 会话已经不在了" T has-session -t "=$SESS"
sweep
yes_ "worker 进程结束、会话也没了：下一轮把它的测试停掉" wait_for 5 test -z "$(members "$u1")"
no_ "记录被删" test -f "$r1"
yes_ "日志里写了停的是哪个条目的" grep -q "停掉遗留的重测试.*条目 #$N" "$D/state/poll.log"
wait "$p1" 2>/dev/null
no_ "被停的测试没有跑到结束" ended t1
sweep
yes_ "已结束的启动记录没有被删" test -f "$D/state/worker-launch/$L1"
chk "而是盖上了「已结束」" "$(field "$D/state/worker-launch/$L1" ended)" 1
# 跨轮：那个 worker 留下的迟到请求（同一个启动编号、同一代）在这一轮检查之后才来排队
env HOME="$D/home" CAVIL_HEAVY_MODE=full CAVIL_HEAVY_ITEM="$N" CAVIL_HEAVY_GEN=0 CAVIL_HEAVY_LAUNCH="$L1" CAVIL_HEAVY_STATE_DIR="$D/state" \
    bash "$NEW/scripts/heavy-test.sh" -- bash -c "$(job late1 0.1)" > "$W/late1.out" 2>&1; rc=$?
chk "已结束的 worker 的迟到请求：退出码 76" "$rc" 76
no_ "迟到请求没有启动" started late1
sweep; sweep
env HOME="$D/home" CAVIL_HEAVY_MODE=full CAVIL_HEAVY_ITEM="$N" CAVIL_HEAVY_GEN=0 CAVIL_HEAVY_LAUNCH="$L1" CAVIL_HEAVY_STATE_DIR="$D/state" \
    bash "$NEW/scripts/heavy-test.sh" -- bash -c "$(job late2 0.1)" > "$W/late2.out" 2>&1; rc=$?
chk "再过两轮检查之后再来：仍是 76" "$rc" 76
no_ "仍然没有启动" started late2
# 同一条目重新派工（没有清理过，还是第 0 代）：新 worker 的测试照常跑
dispatch "$NEW" issue
yes_ "重新派工起了新 worker" wait_for 5 test "$(wc -l < "$CTL/runs")" -ge 2
L2="$(wenv CAVIL_HEAVY_LAUNCH)"
yes_ "新 worker 是另一个启动编号" test -n "$L2" -a "$L2" != "$L1"
hw2_bg fresh 0.3; wait "$HW_PID"; rc=$?
chk "新 worker 的测试正常跑完" "$rc" 0
yes_ "它确实跑到了结束" ended fresh

echo "── 13b. 每轮检查：先读到「运行中」、停之前再读时查询失败 → 不发停止请求；恢复后停掉 ──"
hw2_bg t2 300; p2=$HW_PID
wait_for 5 started t2 || bad "测试没启动"
r2="$(rec_of "$M/t2.start")"; u2="$(field "$r2" unit)"
wp="$(pane_pid)"; T kill-session -t "=$SESS"; kill -KILL "$wp" 2>/dev/null; kill -KILL $(awk '{print $2}' "$CTL/runs") 2>/dev/null
wait_for 5 pid_gone "$wp"
: > "$FAKE/calls"; fail_after 1
sweep
chk "第二次查询失败：没有发停止请求" "$(calls stop)" 0
chk "确实查了两次（第一次读到运行中，第二次失败）" "$(calls "show $u2")" 2
yes_ "测试还在" test -n "$(members "$u2")"
yes_ "记录还在" test -f "$r2"
faults_off
sweep
yes_ "查询恢复后的一轮把它停掉" wait_for 5 test -z "$(members "$u2")"
wait "$p2" 2>/dev/null

echo "── 14. 清理：别的条目占着排队、本条目的测试在排队 → 先停后删，别的条目不受影响 ──"
setup2 clean "$ON"
dispatch "$NEW" issue
wait_for 5 test -s "$CTL/runs"
env HOME="$D/home" CAVIL_HEAVY_MODE=full CAVIL_HEAVY_ITEM=777 CAVIL_HEAVY_GEN=0 CAVIL_HEAVY_STATE_DIR="$D/state" CAVIL_HEAVY_PROJECT=example/none \
    bash "$NEW/scripts/heavy-test.sh" -- bash -c "$(job other 6)" > "$W/other.out" 2>&1 < /dev/null &
po=$!
wait_for 5 started other || bad "别的条目的测试没启动"
hw2_bg mine 1; pm=$HW_PID
wait_for 5 rec_of "$M/mine.start" > /dev/null || bad "本条目的测试没登记"
rm_="$(rec_of "$M/mine.start")"; um="$(field "$rm_" unit)"
chk "本条目的测试在排队" "$(field "$rm_" state)" queued
cleanup_item "$NEW" --force; rc=$?
chk "清理成功" "$rc" 0
chk "代数加了一" "$(gen_now)" 1
no_ "工作树被删了" test -d "$WT"
yes_ "停本条目分组的那一刻工作树还在（先停后删）" grep -q "^stop $um wt=present" "$FAKE/calls"
chk "只停了本条目的那一个分组" "$(calls stop)" 1
no_ "本条目的分组里没有进程了" test -n "$(members "$um")"
no_ "本条目的记录被删" test -f "$rm_"
wait "$pm" 2>/dev/null
wait "$po"; rc=$?
chk "别的条目的测试正常跑完" "$rc" 0
yes_ "别的条目的测试跑到了结束" ended other
no_ "本条目排队中的测试从没启动过" started mine

echo "── 15. 清理之前起的 worker 再来排队：代数对不上，不启动 ──"
env HOME="$D/home" CAVIL_HEAVY_MODE=full CAVIL_HEAVY_ITEM="$N" CAVIL_HEAVY_GEN=0 CAVIL_HEAVY_STATE_DIR="$D/state" \
    bash "$NEW/scripts/heavy-test.sh" -- bash -c "$(job late 0.1)" > "$W/late.out" 2>&1; rc=$?
chk "退出码 76" "$rc" 76
no_ "没有启动" started late
yes_ "说了原因" grep -q "已被清理过" "$W/late.out"

echo "── 16. 清理时测试停不掉 / 状态查不清：保留工作树，非 0 退出；恢复后重试成功 ──"
for fault in stop-fail show-fail show-junk show-fail-after; do
    setup2 "f-$fault" "$ON" "HEAVY_STOP_WAIT_SECS=3"
    dispatch "$NEW" issue
    wait_for 5 test -s "$CTL/runs"
    hw2_bg t 300; pt=$HW_PID
    wait_for 5 started t || bad "$fault：测试没启动"
    rt="$(rec_of "$M/t.start")"; ut="$(field "$rt" unit)"
    # show-fail-after：清理先读到「运行中」，停之前的那一次再读失败
    if [ "$fault" = show-fail-after ]; then fail_after 1; else touch "$FAKE/$fault"; fi
    cleanup_item "$NEW" --force; rc=$?
    if [ "$fault" = show-fail-after ]; then
        chk "$fault：没有发停止请求" "$(calls stop)" 0
        yes_ "$fault：确实读过两次以上" test "$(calls "show $ut")" -ge 2
    fi
    yes_ "$fault：清理非 0 退出" test "$rc" -ne 0
    yes_ "$fault：工作树保留" test -d "$WT"
    yes_ "$fault：运行记录保留" test -f "$rt"
    yes_ "$fault：测试还在" test -n "$(members "$ut")"
    yes_ "$fault：说了工作树保留的原因" grep -q "重测试没能确认停掉，工作树保留" "$D/cleanup.out"
    faults_off
    cleanup_item "$NEW" --force; rc=$?
    chk "$fault：恢复后再清理成功" "$rc" 0
    no_ "$fault：这次工作树删了" test -d "$WT"
    no_ "$fault：测试停了" test -n "$(members "$ut")"
    wait "$pt" 2>/dev/null
done

echo "── 16b. 清理 / 每轮检查碰到读不到的运行记录：不停它，也不能当它不存在去删工作树 ──"
for way in garbage bad-state wrong-unit no-statedir no-item blank-statedir no-gen; do
    setup2 "bad-$way" "$ON" "HEAVY_STOP_WAIT_SECS=3"
    dispatch "$NEW" issue
    wait_for 5 test -s "$CTL/runs"
    hw2_bg t 300; pt=$HW_PID
    wait_for 5 started t || bad "$way：测试没启动"
    rt="$(rec_of "$M/t.start")"; ut="$(field "$rt" unit)"
    # 另一个项目的一套（记录完整）：本条目的测试起来之后才登记，之后的清理和每轮检查都不该碰它
    oid="$(printf '%032x' 9090)"
    env FAKE_UNIT="cavil-heavy-$oid.scope" sleep 300 & other=$!
    printf 'state=running\nunit=cavil-heavy-%s.scope\nstatedir=/nonexistent/other\nproject=example/other\nitem=%s\ngen=0\nlaunch=\npid=1\nsince=%s\ncmd=other\n' "$oid" "$N" "$(date +%s)" > "$RUNS/$oid"
    spoil "$way" "$rt"
    sweep
    chk "$way：每轮检查没有停它" "$(calls stop)" 0
    yes_ "$way：每轮检查在日志里说了这条记录" grep -q "读不出来或内容不认识.*${rt##*/}" "$D/state/poll.log"
    yes_ "$way：每轮检查确实查过它的分组" grep -q "^show $ut" "$FAKE/calls"
    cleanup_item "$NEW" --force; rc=$?
    yes_ "$way：清理非 0 退出" test "$rc" -ne 0
    yes_ "$way：工作树保留" test -d "$WT"
    yes_ "$way：记录还在" test -e "$rt"
    yes_ "$way：测试还在" test -n "$(members "$ut")"
    chk "$way：清理也没有停它（不知道是谁的）" "$(calls stop)" 0
    yes_ "$way：说了原因" grep -q "重测试没能确认停掉，工作树保留" "$D/cleanup.out"
    unspoil "$rt"
    cleanup_item "$NEW" --force; rc=$?
    chk "$way：记录恢复后再清理成功" "$rc" 0
    no_ "$way：这次工作树删了" test -d "$WT"
    no_ "$way：测试停了" test -n "$(members "$ut")"
    chk "$way：恢复后只停了本条目那一个分组" "$(grep '^stop ' "$FAKE/calls" | cut -d' ' -f2 | sort -u)" "$ut"
    yes_ "$way：另一个项目同号条目的那套始终没被碰" kill -0 "$other"
    yes_ "$way：它的记录还在" test -f "$RUNS/$oid"
    kill -KILL "$other" 2>/dev/null; wait "$other" 2>/dev/null
    wait "$pt" 2>/dev/null
done
# 功能没开、也没清理过的项目，状态目录里只有一条读不到的记录（可能是这个条目的）：清理不能照旧直接删
setup2 bad-off "HEAVY_STOP_WAIT_SECS=3"
id="$(printf '%032x' 5151)"; echo garbage > "$RUNS/$id"
env FAKE_UNIT="cavil-heavy-$id.scope" sleep 300 & stray=$!
cleanup_item "$NEW" --force; rc=$?
yes_ "功能没开但有读不到的记录、它的分组还在：清理非 0 退出" test "$rc" -ne 0
yes_ "工作树保留" test -d "$WT"
kill -KILL "$stray" 2>/dev/null; wait "$stray" 2>/dev/null
cleanup_item "$NEW" --force; rc=$?
chk "那个分组消失后再清理成功" "$rc" 0
no_ "工作树删了" test -d "$WT"
no_ "读不到的那条记录被删" test -e "$RUNS/$id"

echo "── 17. 派工进行到一半时来了清理：清理等派工做完，才轮到它 ──"
setup2 race1 "$ON"
T kill-session -t "=$SESS" 2>/dev/null
touch "$CTL/gh-hold"
dispatch "$NEW" issue & pd=$!
wait_for 10 test -s "$CTL/gh.log" || bad "派工没走到读 GitHub 那一步"
cleanup_item "$NEW" --force & pc=$!
sleep 2
yes_ "派工没做完时，清理还在等" kill -0 "$pc"
yes_ "这期间工作树还在" test -d "$WT"
chk "这期间代数没动" "$(gen_now)" 0
chk "这期间 worker 还没起" "$(wc -l < "$CTL/runs")" 0
rm -f "$CTL/gh-hold"
wait "$pd"; rcd=$?; wait "$pc"; rcc=$?
chk "派工完成" "$rcd" 0
chk "worker 是派工起的那一次" "$(wc -l < "$CTL/runs")" 1
chk "清理随后完成" "$rcc" 0
chk "清理把代数加到 1" "$(gen_now)" 1
no_ "清理最后删了工作树" test -d "$WT"
chk "清理把本条目以前的启动记录删了（代数已变，用不上了）" "$(ls "$D/state/worker-launch" 2>/dev/null | wc -l)" 0

echo "── 18. 清理进行到一半时来了派工：派工等清理做完，拿新代数重新起，新测试照常跑 ──"
for where in hook stop; do
    setup2 "race2-$where" "$ON" "CLEANUP_HOOK=\"$TMP/hook.sh\""
    printf '#!/usr/bin/env bash\nwhile [ -e "%s/hook-hold" ]; do sleep 0.1; done\n' "$CTL" > "$TMP/hook.sh"
    dispatch "$NEW" issue
    wait_for 5 test -s "$CTL/runs"
    hw2_bg old 300; pold=$HW_PID
    wait_for 5 started old || bad "$where：旧测试没启动"
    uold="$(field "$(rec_of "$M/old.start")" unit)"
    if [ "$where" = hook ]; then touch "$CTL/hook-hold"; else touch "$FAKE/stop-hold"; fi
    cleanup_item "$NEW" --force & pc=$!
    if [ "$where" = hook ]; then
        wait_for 10 gen_is 1 || bad "$where：清理没走到代数加一"
    else
        wait_for 10 grep -q "^stop $uold" "$FAKE/calls" || bad "$where：清理没走到停分组"
    fi
    n_before="$(wc -l < "$CTL/runs")"
    dispatch "$NEW" issue & pd=$!
    sleep 2
    yes_ "$where：清理没做完时，派工还在等" kill -0 "$pd"
    chk "$where：这期间没有新起 worker" "$(wc -l < "$CTL/runs")" "$n_before"
    rm -f "$CTL/hook-hold" "$FAKE/stop-hold"
    wait "$pc"; rcc=$?; wait "$pd"; rcd=$?
    chk "$where：清理完成" "$rcc" 0
    chk "$where：派工随后完成" "$rcd" 0
    no_ "$where：旧测试被停了" test -n "$(members "$uold")"
    wait "$pold" 2>/dev/null
    yes_ "$where：派工重建了工作树" test -d "$WT"
    yes_ "$where：新 worker 起来了" wait_for 5 test "$(wc -l < "$CTL/runs")" -gt "$n_before"
    chk "$where：新 worker 带的是清理之后的代数" "$(wenv CAVIL_HEAVY_GEN)" 1
    chk "$where：启动记录只剩新 worker 这一份，记的是新代数" "$(ls "$D/state/worker-launch" | wc -l) $(field "$D/state/worker-launch/$(wenv CAVIL_HEAVY_LAUNCH)" gen)" "1 1"
    n_stop="$(calls stop)"
    hw2_bg new 0.5; pn=$HW_PID
    wait "$pn"; rc=$?
    chk "$where：新 worker 的测试正常跑完" "$rc" 0
    yes_ "$where：它确实跑到了结束" ended new
    T kill-session -t "=$SESS" 2>/dev/null
done

echo "── 19. PR 评论入口：同一把条目锁、同样带上条目归属 ──"
setup2 pr "$ON" "HEAVY_TEST_LOCK_WAIT=7" 'HEAVY_TEST_SCOPE_PROPERTIES="MemoryMax=6G CPUWeight=50"'
T kill-session -t "=$SESS" 2>/dev/null
dispatch "$NEW" pr; rc=$?
chk "派工成功" "$rc" 0
yes_ "worker 起来了" wait_for 5 test -s "$CTL/runs"
chk "worker 环境里有条目号（工作编号）" "$(wenv CAVIL_HEAVY_ITEM)" "$N"
yes_ "记下了这次启动" test -f "$D/state/worker-launch/$(wenv CAVIL_HEAVY_LAUNCH)"
chk "配置里的排队上限传到了 worker" "$(wenv CAVIL_HEAVY_LOCK_WAIT)" 7
chk "配置里的分组属性传到了 worker" "$(wenv CAVIL_HEAVY_SCOPE_PROPERTIES)" "MemoryMax=6G CPUWeight=50"
rm -f "$FAKE/props"
hw2_bg p 0.2; wait "$HW_PID"
chk "分组属性逐条交给了 systemd-run（自带的停止超时在前）" "$(tr '\n' ' ' < "$FAKE/props")" "TimeoutStopSec=10s MemoryMax=6G CPUWeight=50 "
yes_ "派工结束后条目锁是空闲的" lock_free

echo "── 20. 功能后来关掉：还登记着的测试，清理时照样先停后删 ──"
setup2 off-later "$ON"
dispatch "$NEW" issue
wait_for 5 test -s "$CTL/runs"
hw2_bg t 300; pt=$HW_PID
wait_for 5 started t || bad "测试没启动"
ut="$(field "$(rec_of "$M/t.start")" unit)"
sed -i '/^HEAVY_TEST_COMMANDS=/d' "$D/config"
cleanup_item "$NEW" --force; rc=$?
chk "清理成功" "$rc" 0
yes_ "停的那一刻工作树还在" grep -q "^stop $ut wt=present" "$FAKE/calls"
no_ "测试被停了" test -n "$(members "$ut")"
no_ "工作树删了" test -d "$WT"
wait "$pt" 2>/dev/null

echo "── 21. 没配重测试命令：和改动前一样 ──"
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
OLD="$TMP/old"; mkdir -p "$OLD" "$TMP/newcopy"
git -C "$REPO_DIR" archive "$BASE_REV" scripts | tar -x -C "$OLD"
cp -r "$REPO_DIR/prompts" "$OLD/"
cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$TMP/newcopy/"
# 旧脚本还写 /tmp 下的固定提示词文件名时，改到本次运行自己的目录（GitHub#396）
prompt_tree_isolate "$OLD" "$TMP/old-prompts" || { echo "❌ 改动前的派工脚本认不出提示词写在哪"; exit 1; }
# 一种写法跑一遍：派工（issue / PR 入口）→ 清理。记下提示词、GitHub 调用、状态文件名、worker 环境
run_off() {   # <根> <输出目录> [多出来的配置行…]
    local root="$1" out="$2" k; shift 2
    rm -rf "$out"; mkdir -p "$out"
    for k in issue pr; do
        setup2 "off-$k" "$@"
        prompt_files_clear "$root" "$D/state"
        T kill-session -t "=$SESS" 2>/dev/null
        dispatch "$root" "$k"; echo "rc=$?" > "$out/$k.rc"
        wait_for 5 test -s "$CTL/runs"
        if [ "$k" = issue ]; then cp "$(prompt_file_of "$root" "$D/state" cmt "$N" 0)" "$out/$k.md" 2>/dev/null
        else cp "$(prompt_file_of "$root" "$D/state" pr "$N")" "$out/$k.md" 2>/dev/null; fi
        # 只抹掉三样必然不同的东西：场景目录、被测脚本所在的根、footer 命令里的开始时刻
        sed -e "s|$D|<D>|g" -e "s|$root|<R>|g" -e 's|--start "[^"]*"|--start "<T>"|' "$out/$k.md" > "$out/$k.md.n" 2>/dev/null
        worker_env > "$out/$k.env"
        hw_alive="$(wc -l < "$CTL/runs")"; echo "workers=$hw_alive" >> "$out/$k.rc"
        cleanup_item "$root" --force; echo "cleanup=$? wt=$( [ -d "$WT" ] && echo present || echo absent )" >> "$out/$k.rc"
        cp "$CTL/gh.log" "$out/$k.gh"
        state_files > "$out/$k.files"
    done
}
if ! compat_skip "没配重测试命令时派工、清理与改动前" "$OLD" "$TMP/newcopy" scripts prompts; then
    run_off "$OLD" "$TMP/off-old"
    for v in "不写这一行:" "写成空值:HEAVY_TEST_COMMANDS=\"\"" "只有空白:HEAVY_TEST_COMMANDS=\"  \""; do
        what="${v%%:*}"; line="${v#*:}"
        if [ -n "$line" ]; then run_off "$TMP/newcopy" "$TMP/off-new" "$line"; else run_off "$TMP/newcopy" "$TMP/off-new"; fi
        for k in issue pr; do
            yes_ "$what / $k：写出了提示词" test -s "$TMP/off-new/$k.md.n"
            yes_ "$what / $k：提示词与改动前逐字相同" cmp -s "$TMP/off-old/$k.md.n" "$TMP/off-new/$k.md.n"
            yes_ "$what / $k：GitHub 调用与改动前相同" cmp -s "$TMP/off-old/$k.gh" "$TMP/off-new/$k.gh"
            yes_ "$what / $k：派工、worker 数、清理结果与改动前相同" cmp -s "$TMP/off-old/$k.rc" "$TMP/off-new/$k.rc"
            yes_ "$what / $k：状态目录里的文件与改动前相同（没有锁、代数、启动记录）" cmp -s "$TMP/off-old/$k.files" "$TMP/off-new/$k.files"
            chk "$what / $k：worker 环境里没有多出变量" "$(cat "$TMP/off-new/$k.env")" ""
            yes_ "$what / $k：确实起了 worker、清了工作树" grep -q "workers=1" "$TMP/off-new/$k.rc"
        done
    done
fi

echo "── 23. 真跑一轮 agent-poll.sh：worker 已结束的测试被这一轮停掉，worker 还在的不动 ──"
PW="$TMP/poll"; mkdir -p "$PW/state/worker-launch" "$PW/wt" "$PW/gh" "$PW/bin" "$PW/home"
bash "$TEST_DIR/lib/fake_gh_client.sh" install "$PW/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
gq clone -q "$G/up.git" "$PW/project"
cat > "$PW/config" <<CONF
REPO="example/sm"
PROJECT_ROOT="$PW/project"
WORKTREE_BASE="$PW/wt"
STATE_DIR="$PW/state"
TMUX_PREFIX="hvpoll"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
LABEL_DONE="Done"
POST_MERGE_RETROSPECTIVE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
WORKER_SECRET_ENV=""
GH_TOKEN="fake-token-for-test"
CONF
chmod 600 "$PW/config"
for f in events perms items labels comments; do echo '{}' > "$PW/gh/$f.json"; done
echo loop-bot > "$PW/gh/me"
echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$PW/state/state.json"
PRUNS="$PW/home/.local/state/cavil-loop/heavy-test/runs"; mkdir -p "$PRUNS"
# 两套登记着的测试：一套的 worker 已经结束，一套的 worker 还在（拿本测试自己的进程当 worker）
mk_run() {   # <运行编号> <启动编号> <worker 进程号> <它的启动时间>
    env FAKE_UNIT="cavil-heavy-$1.scope" sleep 300 &
    printf 'pid=%s\nstart=%s\n' "$3" "$4" > "$PW/state/worker-launch/$2"
    printf 'state=running\nunit=cavil-heavy-%s.scope\nstatedir=%s\nproject=example/sm\nitem=42\ngen=0\nlaunch=%s\npid=1\nsince=%s\ncmd=bash tests/run.sh\n' \
        "$1" "$PW/state" "$2" "$(date +%s)" > "$PRUNS/$1"
}
sleep 0.01 & gonepid=$!; wait "$gonepid"
ID_DEAD=$(printf '%032x' 1); ID_LIVE=$(printf '%032x' 2)
mk_run "$ID_DEAD" "$(printf '%032x' 11)" "$gonepid" 1; s_dead=$!
mk_run "$ID_LIVE" "$(printf '%032x' 12)" "$$" "$mystart"; s_live=$!
rm -f "$FAKE/calls"; faults_off
(cd "$PW/project" && env HOME="$PW/home" PATH="$PW/bin:$PATH" FAKE_GH_DIR="$PW/gh" FAKE_GH_LISTS=1 FAKE_GH_REPO=example/sm \
    CODING_AGENT_CONFIG="$PW/config" timeout 120 bash "$NEW/scripts/agent-poll.sh") > "$PW/poll.out" 2>&1
yes_ "这一轮确实读了 GitHub（不是开头就退出）" test -s "$PW/gh/calls.log"
yes_ "worker 已结束的那套被停掉" wait_for 5 pid_gone "$s_dead"
no_ "它的记录被删" test -f "$PRUNS/$ID_DEAD"
yes_ "轮询日志里写了这件事" grep -q "起它的 worker 已结束，停掉遗留的重测试" "$PW/state/poll.log"
yes_ "worker 还在的那套没被动" kill -0 "$s_live"
yes_ "它的记录还在" test -f "$PRUNS/$ID_LIVE"
chk "只停了一个分组" "$(calls stop)" 1
kill "$s_live" 2>/dev/null

echo "── 22. 文档里「查看谁在占、手动停一套」的命令：两份一致；别的条目占着排队时只停自己那一套 ──"
extract() { awk '/<!-- heavy-test-ops:begin -->/ { on = 1; next } /<!-- heavy-test-ops:end -->/ { on = 0 } on && !/^```/' "$1"; }
extract "$REPO_DIR/docs/operations.md" > "$TMP/ops.en.sh"
extract "$REPO_DIR/docs/operations.zh.md" > "$TMP/ops.zh.sh"
yes_ "文档里有这段命令" test -s "$TMP/ops.zh.sh"
yes_ "中英两份的命令一致" cmp -s "$TMP/ops.en.sh" "$TMP/ops.zh.sh"
faults_off; : > "$FAKE/calls"
DH="$TMP/dochome"; mkdir -p "$DH/.agents/skills"
ln -s "$REPO_DIR" "$DH/.agents/skills/cavil-loop"
DRUNS="$DH/.local/state/cavil-loop/heavy-test/runs"
# 别的项目的一套先占着排队：文档里那一套只能排在它后面
env HOME="$DH" CAVIL_HEAVY_MODE=probe CAVIL_HEAVY_ITEM=777 CAVIL_HEAVY_GEN=0 CAVIL_HEAVY_STATE_DIR="$SD" CAVIL_HEAVY_PROJECT=example/another \
    bash "$NEW/scripts/heavy-test.sh" -- bash -c "$(job docother 300)" > "$W/docother.out" 2>&1 < /dev/null &
po=$!
wait_for 5 started docother || bad "别的项目的测试没启动"
ro="$(grep -l -- "$M/docother.start" "$DRUNS"/* | head -1)"; uo="$(field "$ro" unit)"
# 命令一个字不改。环境里只多一样：CAVIL_HEAVY_MODE=probe，让包装命令去问替身而不是看这台机器有没有
# 真的用户实例（CI 的机器没有）；不带任何变量的原样执行在 heavy-test-systemd 那份里
env -i HOME="$DH" PATH="$PATH" HV_TEST_TAG="$HV_TEST_TAG" CAVIL_HEAVY_MODE=probe bash "$TMP/ops.zh.sh" > "$TMP/ops.out" 2>&1
yes_ "--list 里别的项目那套在运行" grep -Eq "^${ro##*/}  running  分组:active  example/another #777" "$TMP/ops.out"
mine="$(sed -n 's/^\([0-9a-f]\{32\}\)  queued  分组:active  手动运行（sleep 120）.*/\1/p' "$TMP/ops.out" | head -1)"
yes_ "--list 里文档自己那套在排队" test -n "$mine"
yes_ "停掉的是文档自己那一套" grep -qx "已停：$mine" "$TMP/ops.out"
chk "只发了一次停止请求，停的是自己的分组" "$(grep '^stop ' "$FAKE/calls" | cut -d' ' -f2)" "cavil-heavy-$mine.scope"
yes_ "别的项目的测试还在跑" test -n "$(members "$uo")"
yes_ "别的项目的记录还在" test -f "$ro"
chk "三次 --list 行里：别的项目那套出现两次，文档那套只在停之前出现一次" "$(grep -c "^${ro##*/} " "$TMP/ops.out") $(grep -c "^$mine " "$TMP/ops.out")" "2 1"
chk "文档自己那套没有留下记录" "$(ls "$DRUNS" | grep -c "$mine")" 0
env HOME="$DH" CAVIL_HEAVY_MODE=probe bash "$NEW/scripts/heavy-test.sh" --stop "${ro##*/}" > /dev/null 2>&1
wait "$po" 2>/dev/null

echo
compat_summary
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
