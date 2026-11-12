#!/usr/bin/env bash
# kind: e2e
# 重测试排队在**真实的 systemd 用户实例**上的那一半（GitHub#343）。
#
# 跑法：bash tests/heavy-test-systemd.test.sh        （约 20 秒）
# 依赖：Linux + cgroup v2 + 正在运行的 systemd 用户实例（`systemctl --user` 可用）、git、flock。
#       GitHub 托管的 runner 没有用户实例，所以这份登记在 tests/ci-exclude.txt 里，只在本机跑。
#
# tests/heavy-test.test.sh 用替身验证决策；替身按环境变量认「分组成员」，证明不了真实分组的
# 成员语义。这里验的正是那一部分：
#   · 子进程关掉继承的全部描述符、脱离进程组、包装命令被强杀——它仍在原来的分组里，下一套仍在等
#   · 停一个分组：组里所有进程（含脱离进程组的）都结束，组外的进程不受影响
#   · 测试正常结束：留下的后台子进程被结束，分组消失
#   · 真实清理入口：别的条目占着排队、本条目的测试在排队 → 先停后删，别的条目照常跑完
#   · 文档里「查看 / 手动停一套」的命令原样可用
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

if [ -z "${HEAVY_SD_CLEAN_ENV:-}" ]; then
    exec env -i HEAVY_SD_CLEAN_ENV=1 HOME="$HOME" PATH="$PATH" LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}" \
        XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
        ${DBUS_SESSION_BUS_ADDRESS:+DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS"} \
        ${KEEP_SANDBOX:+KEEP_SANDBOX="$KEEP_SANDBOX"} bash "${BASH_SOURCE[0]}" "$@"
fi

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

if [ "$(uname -s)" != Linux ] || [ ! -f /sys/fs/cgroup/cgroup.controllers ] \
   || ! command -v systemd-run > /dev/null 2>&1 || ! systemctl --user show-environment > /dev/null 2>&1; then
    echo "⏭ 没有可用的 systemd 用户实例（或不是 Linux / cgroup v2），整份跳过"; exit 0
fi
for dep in git flock; do
    if ! command -v "$dep" > /dev/null 2>&1; then echo "⏭ 本机没有 $dep，整份跳过"; exit 0; fi
done

TMP=$(mktemp -d); TMP="$(cd "$TMP" && pwd -P)"
TMUX_DIR=$(mktemp -d /tmp/hs.XXXX); export TMUX_TMPDIR="$TMUX_DIR"     # 清理脚本查 tmux 会话：给它一个空的私有 server 目录
HH="$TMP/home"; mkdir -p "$HH"
M="$TMP/marks"; W="$TMP/w"; mkdir -p "$M" "$W"
RUNS="$HH/.local/state/cavil-loop/heavy-test/runs"; mkdir -p "$RUNS"
UNITS_SEEN="$TMP/units"; : > "$UNITS_SEEN"

cleanup() {
    local u
    # 只停本测试建的分组（名字从自己的运行记录里记下来的）
    sort -u "$UNITS_SEEN" | while IFS= read -r u; do [ -n "$u" ] && systemctl --user stop "$u" > /dev/null 2>&1; done
    [ -n "${OUTSIDE:-}" ] && kill "$OUTSIDE" 2>/dev/null
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
wait_for() { local i n=$(( $1 * 10 )); shift; for ((i = 0; i < n; i++)); do "$@" && return 0; sleep 0.1; done; return 1; }
pid_gone() { ! kill -0 "$1" 2>/dev/null; }

HT="$REPO_DIR/scripts/heavy-test.sh"
hw_bg() {   # <名字> [变量=值…] -- <命令…>
    local name="$1"; shift
    local envs=()
    while [ "$1" != -- ]; do envs+=("$1"); shift; done
    shift
    env HOME="$HH" CAVIL_HEAVY_PRINT_SECS=1 "${envs[@]}" bash "$HT" -- "$@" > "$W/$name.out" 2>&1 < /dev/null &
    HW_PID=$!
}
hw() { env HOME="$HH" bash "$HT" "$@"; }
job() { printf 'date +%%s%%N > %q; sleep %s; date +%%s%%N > %q; exit %s' "$M/$1.start" "$2" "$M/$1.end" "${3:-0}"; }
started() { [ -s "$M/$1.start" ]; }
ended() { [ -s "$M/$1.end" ]; }
rec_of() { grep -l -- "$1" "$RUNS"/* 2>/dev/null | head -1; }
field() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1; }
unit_of() { local r; r="$(rec_of "$1")"; field "$r" unit | tee -a "$UNITS_SEEN"; }
in_unit() { grep -q "/$2\$" "/proc/$1/cgroup" 2>/dev/null; }     # <pid> <分组名>
unit_state() { systemctl --user show "$1" -p LoadState -p ActiveState 2>/dev/null | tr '\n' ' '; }
unit_gone() { case "$(unit_state "$1")" in *LoadState=not-found*|*ActiveState=inactive*) return 0 ;; esac; return 1; }
no_overlap() {
    local as ae bs be
    as=$(cat "$M/$1.start"); ae=$(cat "$M/$1.end"); bs=$(cat "$M/$2.start"); be=$(cat "$M/$2.end")
    [ "$ae" -le "$bs" ] || [ "$be" -le "$as" ]
}
# 一个「逃跑」的子进程：新会话、关掉继承来的全部描述符，再睡着
ESCAPEE='setsid bash -c '\''for fd in /proc/$$/fd/*; do n=${fd##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-" 2>/dev/null; done; exec sleep 300 < /dev/null > /dev/null 2>&1'\'' & echo $! > '

sleep 600 & OUTSIDE=$!

echo "── 1. 子进程关掉描述符、脱离进程组，包装命令被强杀：它还在分组里，下一套继续等 ──"
hw_bg x -- bash -c "echo \$\$ > '$M/x.main'; $ESCAPEE'$M/x.esc'; date +%s%N > '$M/x.start'; sleep 300"
px=$HW_PID
wait_for 10 started x || bad "第一套没启动"
wait_for 5 test -s "$M/x.esc"
ux="$(unit_of x.esc)"; rx="$(rec_of x.esc)"; esc="$(cat "$M/x.esc")"
yes_ "测试进程在自己的分组里" in_unit "$(cat "$M/x.main")" "$ux"
kill -KILL "$px" "$(field "$rx" pid)" "$(cat "$M/x.main")" 2>/dev/null; wait "$px" 2>/dev/null
sleep 0.5
yes_ "逃跑的子进程还活着" kill -0 "$esc"
yes_ "它脱离了原来的进程组" test "$(ps -o pgid= -p "$esc" | tr -d ' ')" != "$(ps -o pgid= -p $$ | tr -d ' ')"
yes_ "但仍在原来的分组里" in_unit "$esc" "$ux"
no_ "分组没有消失" unit_gone "$ux"
hw_bg b -- bash -c "$(job b 0.5)"; pb=$HW_PID
sleep 3
no_ "下一套没有启动" started b
yes_ "上一套的记录还在" test -f "$rx"
yes_ "下一套打印了在等谁" grep -q "还有进程在运行" "$W/b.out"
kill -KILL "$esc" 2>/dev/null
wait "$pb"; rc=$?
chk "那个子进程退出后，下一套跑完" "$rc" 0
yes_ "下一套确实跑到了结束" ended b
yes_ "上一套的分组消失了" unit_gone "$ux"
no_ "上一套的记录被删" test -f "$rx"

echo "── 2. 停一个分组：组里全部进程结束（含脱离进程组的），组外的不受影响 ──"
rm -f "$M"/*
hw_bg a -- bash -c "echo \$\$ > '$M/a.main'; $ESCAPEE'$M/a.esc'; date +%s%N > '$M/a.start'; sleep 300"
pa=$HW_PID
wait_for 10 started a || bad "没启动"
wait_for 5 test -s "$M/a.esc"
ua="$(unit_of a.esc)"; ra="$(rec_of a.esc)"; esc="$(cat "$M/a.esc")"; main="$(cat "$M/a.main")"
hw --stop "${ra##*/}" > "$W/stop.out" 2>&1; rc=$?
chk "--stop 成功" "$rc" 0
wait "$pa"; rc=$?
chk "被停的那套以 143 退出" "$rc" 143
yes_ "测试主进程结束了" pid_gone "$main"
yes_ "脱离进程组的子进程也结束了" pid_gone "$esc"
yes_ "分组消失了" unit_gone "$ua"
yes_ "分组外的进程还在" kill -0 "$OUTSIDE"
no_ "记录被删" test -f "$ra"

echo "── 3. 测试正常结束：留下的后台子进程被结束，分组消失，退出码原样返回 ──"
rm -f "$M"/*
hw_bg a -- bash -c "$ESCAPEE'$M/a.esc'; $(job a 0.5 7)"
pa=$HW_PID
wait_for 10 started a || bad "没启动"
ua="$(unit_of "$M/a.start")"
wait "$pa"; rc=$?
chk "退出码是测试自己的" "$rc" 7
yes_ "留下的后台子进程被结束" wait_for 15 pid_gone "$(cat "$M/a.esc")"
yes_ "分组消失了" wait_for 5 unit_gone "$ua"
chk "没有留下运行记录" "$(ls "$RUNS" | wc -l)" 0

echo "── 4. 给分组加的 systemd 属性生效 ──"
rm -f "$M"/*
hw_bg a CAVIL_HEAVY_SCOPE_PROPERTIES="MemoryMax=1G" -- bash -c "$(job a 2)"; pa=$HW_PID
wait_for 10 started a || bad "没启动"
ua="$(unit_of "$M/a.start")"
chk "MemoryMax 设上了" "$(systemctl --user show "$ua" -p MemoryMax --value 2>/dev/null)" 1073741824
wait "$pa"

echo "── 5. 真实清理入口：别的条目占着排队、本条目的测试在排队 → 先停后删 ──"
rm -f "$M"/*
gq() { git -c user.email=t@example.invalid -c user.name=t "$@" >/dev/null 2>&1; }
N=987344
D="$TMP/proj-root"; mkdir -p "$D/state" "$D/logs"
gq init -q --bare -b main "$D/up.git"
gq clone -q "$D/up.git" "$D/seed"
(cd "$D/seed" && echo x > f && gq add f && gq commit -qm init && gq push -q origin HEAD:main)
gq clone -q "$D/up.git" "$D/proj"
WT="$D/wt/issue-$N"
gq -C "$D/proj" worktree add -q "$WT" -b "feature/issue-$N"
cat > "$D/config" <<CONF
REPO="example/none"
PROJECT_ROOT="$D/proj"
WORKTREE_BASE="$D/wt"
STATE_DIR="$D/state"
SESSION_LOG_DIR="$D/logs"
TMUX_PREFIX="hstest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
WORKER_AGENT="claude"
GH_TOKEN="fake-token-for-test"
HEAVY_TEST_COMMANDS="bash tests/run.sh"
CONF
hw_bg other CAVIL_HEAVY_ITEM=777 CAVIL_HEAVY_GEN=0 CAVIL_HEAVY_STATE_DIR="$D/state" CAVIL_HEAVY_PROJECT=example/none -- bash -c "$(job other 8)"
po=$HW_PID
wait_for 10 started other || bad "别的条目的测试没启动"
uo="$(unit_of "$M/other.start")"
hw_bg mine CAVIL_HEAVY_ITEM="$N" CAVIL_HEAVY_GEN=0 CAVIL_HEAVY_STATE_DIR="$D/state" CAVIL_HEAVY_PROJECT=example/none -- bash -c "$(job mine 1)"
pm=$HW_PID
wait_for 10 rec_of "$M/mine.start" > /dev/null || bad "本条目的测试没登记"
rm_="$(rec_of "$M/mine.start")"; um="$(unit_of "$M/mine.start")"
chk "本条目的测试在排队" "$(field "$rm_" state)" queued
no_ "它的分组此刻存在" unit_gone "$um"
(cd "$D/proj" && HOME="$HH" CODING_AGENT_CONFIG="$D/config" timeout 120 bash "$REPO_DIR/scripts/cleanup-issue.sh" "$N" --force) > "$D/cleanup.out" 2>&1; rc=$?
chk "清理成功" "$rc" 0
chk "代数加了一" "$(cat "$D/state/item-gen/$N" 2>/dev/null)" 1
no_ "工作树被删了" test -d "$WT"
yes_ "本条目的分组消失了" unit_gone "$um"
no_ "本条目的记录被删" test -f "$rm_"
yes_ "日志里先停测试、后删工作树" awk '/停掉条目 #'"$N"' 的重测试/ { s = NR } /removing worktree/ { r = NR } END { exit !(s > 0 && r > s) }' "$D/state/poll.log"
no_ "别的条目的分组没被动" unit_gone "$uo"
wait "$pm" 2>/dev/null
wait "$po"; rc=$?
chk "别的条目的测试正常跑完" "$rc" 0
yes_ "别的条目的测试跑到了结束" ended other
no_ "本条目排队中的测试从没启动过" started mine

echo "── 6. 文档里「查看谁在占、手动停一套」的命令：两份一致，干净环境原样执行；别的条目占着排队时只停自己那一套 ──"
extract() { awk '/<!-- heavy-test-ops:begin -->/ { on = 1; next } /<!-- heavy-test-ops:end -->/ { on = 0 } on && !/^```/' "$1"; }
extract "$REPO_DIR/docs/operations.md" > "$TMP/ops.en.sh"
extract "$REPO_DIR/docs/operations.zh.md" > "$TMP/ops.zh.sh"
yes_ "文档里有这段命令" test -s "$TMP/ops.zh.sh"
yes_ "中英两份的命令一致" cmp -s "$TMP/ops.en.sh" "$TMP/ops.zh.sh"
DH="$TMP/dochome"; mkdir -p "$DH/.agents/skills"
ln -s "$REPO_DIR" "$DH/.agents/skills/cavil-loop"
DRUNS="$DH/.local/state/cavil-loop/heavy-test/runs"
doc_units() { sed -n 's/^\([0-9a-f]\{32\}\)  .*/cavil-heavy-\1.scope/p' "$1" >> "$UNITS_SEEN"; }
# 6a. 没有别的运行：只给 HOME、PATH 和找用户实例要的 XDG_RUNTIME_DIR，命令一个字不改
env -i HOME="$DH" PATH="$PATH" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" bash "$TMP/ops.zh.sh" > "$TMP/ops.out" 2>&1
doc_units "$TMP/ops.out"
mine="$(sed -n 's/^\([0-9a-f]\{32\}\)  [a-z]*  分组:active  手动运行（sleep 120）.*/\1/p' "$TMP/ops.out" | head -1)"
yes_ "--list 列出了那一套" test -n "$mine"
yes_ "--stop 停的是它" grep -qx "已停：$mine" "$TMP/ops.out"
yes_ "停完再列：没有登记着的重测试" grep -q "没有登记着的重测试" "$TMP/ops.out"
chk "没有留下运行记录" "$(ls "$DRUNS" 2>/dev/null | wc -l)" 0
# 6b. 别的项目的一套先占着排队：文档那一套排在后面，停的必须是它自己
env HOME="$DH" CAVIL_HEAVY_ITEM=777 CAVIL_HEAVY_GEN=0 CAVIL_HEAVY_STATE_DIR="$D/state" CAVIL_HEAVY_PROJECT=example/another \
    bash "$HT" -- bash -c "$(job docother 300)" > "$W/docother.out" 2>&1 < /dev/null &
po=$!
wait_for 10 started docother || bad "别的项目的测试没启动"
ro="$(grep -l -- "$M/docother.start" "$DRUNS"/* | head -1)"; uo="$(field "$ro" unit)"; echo "$uo" >> "$UNITS_SEEN"
env -i HOME="$DH" PATH="$PATH" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" bash "$TMP/ops.zh.sh" > "$TMP/ops2.out" 2>&1
doc_units "$TMP/ops2.out"
yes_ "--list 里别的项目那套在运行" grep -Eq "^${ro##*/}  running  分组:active  example/another #777" "$TMP/ops2.out"
mine="$(sed -n 's/^\([0-9a-f]\{32\}\)  queued  分组:active  手动运行（sleep 120）.*/\1/p' "$TMP/ops2.out" | head -1)"
yes_ "--list 里文档自己那套在排队" test -n "$mine"
yes_ "停掉的是文档自己那一套" grep -qx "已停：$mine" "$TMP/ops2.out"
yes_ "文档那套的分组消失了" unit_gone "cavil-heavy-$mine.scope"
no_ "别的项目的分组没被动" unit_gone "$uo"
yes_ "别的项目的记录还在" test -f "$ro"
env HOME="$DH" bash "$HT" --stop "${ro##*/}" > /dev/null 2>&1
wait "$po" 2>/dev/null

echo "── 7. 用户实例这一次没问到（上一套的包装命令被强杀、测试还在真实分组里）：不降级、不启动 ──"
hw_bg prev7 -- bash -c "echo \$\$ > '$M/prev7.main'; date +%s%N > '$M/prev7.start'; sleep 300"
px=$HW_PID
wait_for 10 started prev7 || bad "上一套没启动"
rx="$(rec_of prev7.main)"; ux="$(unit_of prev7.main)"
kill -KILL "$px" "$(field "$rx" pid)" 2>/dev/null; wait "$px" 2>/dev/null
yes_ "上一套的测试还在分组里" in_unit "$(cat "$M/prev7.main")" "$ux"
# 只让「问用户实例」这一次失败，别的 systemctl / systemd-run 调用都交给真的
SHIM="$TMP/shim"; mkdir -p "$SHIM"
REAL_SYSTEMCTL="$(command -v systemctl)"
cat > "$SHIM/systemctl" <<SH
#!/usr/bin/env bash
case "\$*" in *show-environment*) [ ! -e "$TMP/env-fail" ] || exit 1 ;; esac
exec "$REAL_SYSTEMCTL" "\$@"
SH
chmod +x "$SHIM/systemctl"
touch "$TMP/env-fail"
env HOME="$HH" PATH="$SHIM:$PATH" bash "$HT" -- bash -c "$(job next7 0.3)" > "$W/next7.out" 2>&1; rc=$?
chk "退出码 70" "$rc" 70
no_ "没有启动" started next7
no_ "没有走降级" grep -q "只排队这条命令本身" "$W/next7.out"
yes_ "上一套的测试没被打扰" kill -0 "$(cat "$M/prev7.main")"
mv "$TMP/env-fail" "$TMP/env-fail.off"
env HOME="$HH" PATH="$SHIM:$PATH" CAVIL_HEAVY_PRINT_SECS=1 bash "$HT" -- bash -c "$(job next7 0.3)" > "$W/next7.out" 2>&1 &
pb=$!
sleep 3
no_ "恢复后：上一套还在跑，仍不启动" started next7
kill -KILL "$(cat "$M/prev7.main")" 2>/dev/null
wait "$pb"; rc=$?
chk "恢复后：上一套结束才跑完" "$rc" 0
yes_ "确实跑到了结束" ended next7

echo "── 8. 上一套的运行记录读不到（包装命令被强杀、测试还在真实分组里）：不启动；恢复可读后仍等它结束 ──"
hw_bg prev8 -- bash -c "echo \$\$ > '$M/prev8.main'; date +%s%N > '$M/prev8.start'; sleep 300"
px=$HW_PID
wait_for 10 started prev8 || bad "上一套没启动"
rx="$(rec_of prev8.main)"; ux="$(unit_of prev8.main)"
kill -KILL "$px" "$(field "$rx" pid)" 2>/dev/null; wait "$px" 2>/dev/null
if [ "$(id -u)" = 0 ]; then mv "$rx" "$rx.keep"; echo garbage > "$rx"; else chmod 000 "$rx"; fi
hw_bg next8 -- bash -c "$(job next8 0.3)"; pb=$HW_PID
sleep 3
no_ "下一套没有启动" started next8
yes_ "那条记录还在" test -e "$rx"
yes_ "上一套的测试还在分组里" in_unit "$(cat "$M/prev8.main")" "$ux"
yes_ "下一套说了是哪条记录读不出来" grep -q "运行记录读不出来或内容不认识" "$W/next8.out"
if [ "$(id -u)" = 0 ]; then mv -f "$rx.keep" "$rx"; else chmod 600 "$rx"; fi
sleep 2
no_ "记录恢复可读、上一套还在跑：仍不启动" started next8
kill -KILL "$(cat "$M/prev8.main")" 2>/dev/null
wait "$pb"; rc=$?
chk "上一套结束后下一套跑完" "$rc" 0
yes_ "确实跑到了结束" ended next8
no_ "上一套的记录随后被删" test -e "$rx"

echo "── 9. 真实清理入口：本条目测试的运行记录缺了项目状态目录那一行 → 不删工作树；补回后先停后删 ──"
N9=987345
WT9="$D/wt/issue-$N9"
gq -C "$D/proj" worktree add -q "$WT9" -b "feature/issue-$N9"
hw_bg own9 CAVIL_HEAVY_ITEM="$N9" CAVIL_HEAVY_GEN=0 CAVIL_HEAVY_STATE_DIR="$D/state" CAVIL_HEAVY_PROJECT=example/none -- bash -c "echo \$\$ > '$M/own9.main'; date +%s%N > '$M/own9.start'; sleep 300"
p9=$HW_PID
wait_for 10 started own9 || bad "本条目的测试没启动"
r9="$(rec_of own9.main)"; u9="$(unit_of own9.main)"
cp -p "$r9" "$TMP/r9.bak"
sed -i '/^statedir=/d' "$r9"
(cd "$D/proj" && HOME="$HH" CODING_AGENT_CONFIG="$D/config" timeout 120 bash "$REPO_DIR/scripts/cleanup-issue.sh" "$N9" --force) > "$D/cleanup9.out" 2>&1; rc=$?
yes_ "清理非 0 退出" test "$rc" -ne 0
yes_ "工作树保留" test -d "$WT9"
yes_ "测试还在分组里（没被停，也没被丢下不管就删目录）" in_unit "$(cat "$M/own9.main")" "$u9"
yes_ "那条记录还在" test -e "$r9"
cp -p "$TMP/r9.bak" "$r9"
(cd "$D/proj" && HOME="$HH" CODING_AGENT_CONFIG="$D/config" timeout 120 bash "$REPO_DIR/scripts/cleanup-issue.sh" "$N9" --force) > "$D/cleanup9.out" 2>&1; rc=$?
chk "记录补回后清理成功" "$rc" 0
yes_ "测试被停了" pid_gone "$(cat "$M/own9.main")"
yes_ "分组消失了" unit_gone "$u9"
no_ "工作树删了" test -d "$WT9"
wait "$p9" 2>/dev/null

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
