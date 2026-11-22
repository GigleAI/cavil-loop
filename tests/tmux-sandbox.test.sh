#!/usr/bin/env bash
# kind: unit
# tests/lib/tmux-sandbox.sh 的启动和收尾（GitHub#647）。
#
# 跑法：bash tests/tmux-sandbox.test.sh   （约 30 秒；有几种情况要等 SIGTERM 的 2 秒）
# 依赖：tmux、python3 ≥ 3.9、Linux。不碰本机默认 tmux 服务：每个场景都是一个小脚本，
# 在 env -i 的干净环境里真的载入共用脚本、真的起 tmux 服务，跑完核对服务和窗格进程
# 是不是真没了、临时目录删没删、退出码对不对。
#
# 收尾是尽力清理（维护者在 #647 选的）：这里测的是能看到的情况都收得掉、看到残留就报，
# 不测「扫描途中被过继的进程」那种已接受的漏网。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$TEST_DIR/lib/tmux-sandbox.sh"
T="$(mktemp -d)"
OUTER_SOCK="$T/outer.sock"
trap 'tmux -S "$OUTER_SOCK" kill-server 2>/dev/null; [ -n "${KEEP_T:-}" ] || rm -rf "$T"' EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

if ! command -v tmux >/dev/null 2>&1; then
    echo "⏭ 本机没有 tmux，整个文件跳过"
    report_counts 0 0
    exit 0
fi

mkdir -p "$T/home" "$T/fakebin"
REAL_TMUX="$(command -v tmux)"
REAL_PY="$(command -v python3)"

# 进程还活着（僵尸算死）
alive() {
    local st
    st=$(sed -e 's/.*) //' -e 's/ .*//' "/proc/$1/stat" 2>/dev/null) || { echo no; return; }
    [ -n "$st" ] && [ "$st" != Z ] && echo yes || echo no
}
alive_all() {   # <文件里每行一个进程号> → 还活着的个数
    local p c=0
    [ -s "$1" ] || { echo none; return; }
    while read -r p; do [ -n "$p" ] && [ "$(alive "$p")" = yes ] && c=$((c+1)); done < "$1"
    echo "$c"
}

# run_case <名字> [PATH 前缀]：正文从 stdin 读，前面自动加上载入共用脚本那两行。
# 结果：$T/<名字>.out（stdout+stderr）、$T/<名字>.d（场景自己写的事实）、CASE_RC。
run_case() {
    local name="$1" pre="${2:-}"
    mkdir -p "$T/$name.d"
    { printf 'set -uo pipefail\nOUT=%q\nsource %q\n' "$T/$name.d" "$LIB"; cat; } > "$T/$name.sh"
    ( cd "$T" && env -i HOME="$T/home" PATH="${pre:+$pre:}$PATH" LANG=C.UTF-8 \
        ${CASE_TMUX:+TMUX="$CASE_TMUX"} bash "$T/$name.sh" ) > "$T/$name.out" 2>&1
    CASE_RC=$?
}
sandbox_dir_of() { sed -n 's|.*TMUX_TMPDIR=\(/tmp/cvtmx\.[A-Za-z0-9]*\)/s.*|\1|p' "$T/$1.out" | head -1; }

echo "【1】正常：一个服务，收尾关掉它、删目录，退出码不变"
run_case normal <<'EOF'
tmux_sandbox_start
echo "TMUX_TMPDIR=$TMUX_TMPDIR"
tmux new-session -d -s reaptest-issue901 'sleep 300'
tmux display-message -p -t '=reaptest-issue901:' '#{pid}' > "$OUT/servers"
echo CASE-RAN
EOF
chk "退出码 0" "$CASE_RC" "0"
chk "用例跑了" "$(grep -c CASE-RAN "$T/normal.out")" "1"
chk "服务进程已不存在" "$(alive_all "$T/normal.d/servers")" "0"
d=$(sandbox_dir_of normal)
chk "临时目录已删" "$([ -n "$d" ] && [ ! -e "$d" ] && echo yes)" "yes"
chk "汇总：1 个业务会话、1 个服务" "$(grep -c '成功建出 1 个业务会话，起过 1 个服务，全部已退出' "$T/normal.out")" "1"

echo "【2】外层 TMUX 指向别的服务：不碰它，同名会话也不碰"
"$REAL_TMUX" -S "$OUTER_SOCK" -f /dev/null new-session -d -s reaptest-issue901 'sleep 300'
"$REAL_TMUX" -S "$OUTER_SOCK" new-session -d -s sentinel 'sleep 300'
outer_pid=$("$REAL_TMUX" -S "$OUTER_SOCK" display-message -p -t '=sentinel:' '#{pid}')
CASE_TMUX="$OUTER_SOCK,$outer_pid,0" run_case outer <<'EOF'
tmux_sandbox_start
tmux new-session -d -s reaptest-issue901 'sleep 300'
tmux ls -F '#{session_name}' | sort > "$OUT/seen"
for s in $(tmux ls -F '#{session_name}' | grep '^reaptest-'); do tmux kill-session -t "=$s"; done
EOF
chk "退出码 0" "$CASE_RC" "0"
chk "测试里只看得到自己的会话" "$(tr '\n' ' ' < "$T/outer.d/seen")" "cavil-sandbox-keep reaptest-issue901 "
chk "外层同名会话还在" "$(tmux -S "$OUTER_SOCK" has-session -t '=reaptest-issue901' 2>/dev/null && echo yes)" "yes"
chk "外层普通会话还在" "$(tmux -S "$OUTER_SOCK" has-session -t '=sentinel' 2>/dev/null && echo yes)" "yes"

echo "【3】中途重开（允许），重开后 socket 被挪走也照样收掉；重开不读用户配置"
printf 'set -g @marker leaked\n' > "$T/home/.tmux.conf"
run_case restart <<'EOF'
tmux_sandbox_start
echo "TMUX_TMPDIR=$TMUX_TMPDIR"
tmux show-options -gv @marker > "$OUT/marker1" 2>&1
tmux display-message -p -t '=cavil-sandbox-keep:' '#{pid}' >> "$OUT/servers"
tmux kill-server; sleep 0.3
tmux new-session -d -s a 'sleep 300'
tmux display-message -p -t '=a:' '#{pid}' >> "$OUT/servers"
tmux show-options -gv @marker > "$OUT/marker2" 2>&1
mv "$TMUX_TMPDIR/tmux-$(id -u)/default" "$OUT/moved.sock"
tmux new-session -d -s b 'sleep 300'
tmux display-message -p -t '=b:' '#{pid}' >> "$OUT/servers"
EOF
rm -f "$T/home/.tmux.conf"
chk "退出码 0" "$CASE_RC" "0"
chk "起过 3 个服务" "$(sort -u "$T/restart.d/servers" | wc -l)" "3"
chk "3 个服务（含 socket 被挪走的那个）都已不存在" "$(alive_all "$T/restart.d/servers")" "0"
chk "第一次起服务没读用户配置" "$(grep -c leaked "$T/restart.d/marker1")" "0"
chk "重开的服务也没读用户配置" "$(grep -c leaked "$T/restart.d/marker2")" "0"
d=$(sandbox_dir_of restart)
chk "临时目录已删" "$([ -n "$d" ] && [ ! -e "$d" ] && echo yes)" "yes"

echo "【4】忽略挂断信号的窗格程序，在测试回收它之前就收尾 → 收尾后已不存在"
run_case hup <<'EOF'
tmux_sandbox_start
tmux new-session -d -s reaptest-issue906 'trap "" HUP; while :; do sleep 1; done'
sleep 0.5
tmux list-panes -t '=reaptest-issue906' -F '#{pane_pid}' > "$OUT/pane"
EOF
chk "退出码 0" "$CASE_RC" "0"
chk "窗格程序已不存在" "$(alive_all "$T/hup.d/pane")" "0"
chk "收尾结束过被过继来的窗格进程" "$(grep -cE '结束了 [1-9][0-9]* 个进程' "$T/hup.out")" "1"

echo "【5】关门：收尾开始后还在调 tmux 的后台任务被拒绝，起不了新服务"
run_case gate <<'EOF'
tmux_sandbox_start
( trap '' TERM
  while :; do
      tmux new-session -d -s "late$RANDOM" 'sleep 300' 2>> "$OUT/late.err" \
          && tmux display-message -p '#{pid}' >> "$OUT/servers" 2>/dev/null
      sleep 0.1
  done ) &
sleep 0.5
EOF
chk "退出码 0" "$CASE_RC" "0"
chk "后台任务的调用被拒绝过" "$([ "$(grep -c '已关闭' "$T/gate.d/late.err" 2>/dev/null)" -gt 0 ] && echo yes)" "yes"
chk "服务进程都已不存在" "$(alive_all "$T/gate.d/servers")" "0"

echo "【6】清理回调：资源还没建出来就退出 → 什么也不删，沙盒照样收尾，原退出码保留"
run_case early <<'EOF'
tmux_sandbox_on_exit '[ -z "${X:-}" ] || rm -rf "$X"'
tmux_sandbox_start
exit 3
X=$(mktemp -d)
EOF
chk "原退出码 3" "$CASE_RC" "3"
chk "没有清理失败" "$(grep -c '清理失败' "$T/early.out")" "0"
chk "沙盒收尾照样执行" "$(grep -c '全部已退出' "$T/early.out")" "1"

echo "【7】清理回调触发 shell 致命错误（读未赋值变量、exit 1）→ 后面的清理和沙盒收尾照样执行"
run_case fatal <<'EOF'
tmux_sandbox_on_exit 'set -u; : "$NOT_SET_ANYWHERE"'
tmux_sandbox_on_exit 'exit 1'
tmux_sandbox_on_exit ': > "$OUT/third-ran"'
tmux_sandbox_start
tmux display-message -p -t '=cavil-sandbox-keep:' '#{pid}' > "$OUT/servers"
EOF
chk "原来是 0 → 有清理失败所以是 1" "$CASE_RC" "1"
chk "两条清理失败都记下了" "$(grep -c '清理失败' "$T/fatal.out")" "2"
chk "第三个回调照样执行" "$([ -e "$T/fatal.d/third-ran" ] && echo yes)" "yes"
chk "服务进程已不存在" "$(alive_all "$T/fatal.d/servers")" "0"
chk "沙盒收尾照样执行" "$(grep -c '全部已退出' "$T/fatal.out")" "1"
run_case fatal_rc <<'EOF'
tmux_sandbox_on_exit 'exit 1'
tmux_sandbox_start
exit 5
EOF
chk "用例本来就红：保留原退出码 5" "$CASE_RC" "5"

echo "【8】启动建到一半报错（服务已起、保活会话那步失败）→ 不跑用例，退出处理照样执行"
cat > "$T/fakebin/tmux" <<EOF
#!/usr/bin/env bash
case " \$* " in
    *" cavil-sandbox-keep "*)
        "$REAL_TMUX" -f /dev/null new-session -d -s half 'sleep 300'
        "$REAL_TMUX" display-message -p -t '=half:' '#{pid}' > "$T/half.d/servers"
        exit 1 ;;
esac
exec "$REAL_TMUX" "\$@"
EOF
chmod +x "$T/fakebin/tmux"
mkdir -p "$T/half.d"
run_case half "$T/fakebin" <<'EOF'
tmux_sandbox_on_exit ': > "$OUT/hook-ran"'
tmux_sandbox_start
echo CASE-RAN
EOF
rm -f "$T/fakebin/tmux"
chk "以失败退出" "$CASE_RC" "1"
chk "用例没跑" "$(grep -c CASE-RAN "$T/half.out")" "0"
chk "已登记的清理执行了" "$([ -e "$T/half.d/hook-ran" ] && echo yes)" "yes"
chk "起了一半的服务也收掉了" "$(alive_all "$T/half.d/servers")" "0"

echo "【9】设收养人失败 → 什么都没建，不跑用例，以失败退出"
cat > "$T/fakebin/python3" <<EOF
#!/usr/bin/env bash
case "\$*" in *PR_SET_CHILD_SUBREAPER*) exit 1 ;; esac
exec "$REAL_PY" "\$@"
EOF
chmod +x "$T/fakebin/python3"
run_case noreaper "$T/fakebin" <<'EOF'
tmux_sandbox_start
echo CASE-RAN
EOF
rm -f "$T/fakebin/python3"
chk "以失败退出" "$([ "$CASE_RC" -ne 0 ] && echo yes)" "yes"
chk "用例没跑" "$(grep -c CASE-RAN "$T/noreaper.out")" "0"

echo "【10】读进程清单出错 → 保留目录，整个文件以失败退出"
cat > "$T/fakebin/python3" <<EOF
#!/usr/bin/env bash
case "\$*" in *tmux_sandbox_reap.py*) echo "读进程清单出错：模拟"; exit 2 ;; esac
exec "$REAL_PY" "\$@"
EOF
chmod +x "$T/fakebin/python3"
run_case readfail "$T/fakebin" <<'EOF'
tmux_sandbox_start
echo "TMUX_TMPDIR=$TMUX_TMPDIR"
EOF
rm -f "$T/fakebin/python3"
chk "以失败退出" "$CASE_RC" "1"
chk "报了没能确认" "$(grep -c '没能确认本次运行的进程都已退出' "$T/readfail.out")" "1"
d=$(sandbox_dir_of readfail)
chk "临时目录保留着" "$([ -n "$d" ] && [ -d "$d" ] && echo yes)" "yes"
[ -n "$d" ] && rm -rf "$d"

echo
echo "通过 $pass / 失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
