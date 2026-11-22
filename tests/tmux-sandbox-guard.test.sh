#!/usr/bin/env bash
# kind: guard
# reads: repo
# 用真 tmux 的测试必须有自己的 tmux 服务（GitHub#647）——只读文本的检查。
#
# 跑法：bash tests/tmux-sandbox-guard.test.sh   （约 1 秒）
#
# 为什么要有：在本机默认 tmux 服务上建会话、会话名又写死的测试，两份同时跑会互相列出、
# 杀掉对方的会话（reap-finished-workers 在 w01 上 587 次红了 40 次）。规则和检查本身在
# tests/lib/tmux_guard.py；这里先用一张用例表证明检查分得清对错，再扫仓库里全部测试。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$TEST_DIR/lib/tmux_guard.py"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}
# case_from <名字> <期望 report|ok>，正文从 stdin 读
n=0
case_from() {
    n=$((n+1))
    local f="$T/case$n.test.sh" got
    cat > "$f"
    if python3 "$GUARD" "$f" >/dev/null 2>&1; then got=ok; else got=report; fi
    chk "$1" "$got" "$2"
}

echo "【1】要报的写法"
case_from "行首直接调用、没有隔离" report <<'EOF'
tmux new-session -d -s x 'sleep 3'
EOF
case_from "trap 字符串里的调用" report <<'EOF'
trap 'rm -rf "$TMP"; tmux kill-session -t "$S" 2>/dev/null' EXIT
EOF
case_from "\$( ) 里的调用" report <<'EOF'
for s in $(tmux ls -F '#{session_name}' 2>/dev/null); do :; done
EOF
case_from "&& 之后的调用" report <<'EOF'
true && tmux kill-server
EOF
case_from "if 后面的调用" report <<'EOF'
if tmux has-session -t x 2>/dev/null; then :; fi
EOF
case_from "timeout N 之后的调用" report <<'EOF'
timeout 5 tmux list-sessions
EOF
case_from "沙盒启动写在第一处调用之后" report <<'EOF'
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux new-session -d -s x 'sleep 3'
tmux_sandbox_start
EOF
case_from "载入了沙盒却没启动" report <<'EOF'
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
echo hi
EOF
case_from "有 export TMUX_TMPDIR= 但没清 TMUX" report <<'EOF'
export TMUX_TMPDIR="$D"
tmux new-session -d -s x 'sleep 3'
EOF
case_from "用沙盒的文件里 env -i 没带 TMUX_TMPDIR=" report <<'EOF'
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux_sandbox_start
env -i PATH="$PATH" bash -c 'tmux ls'
EOF
case_from "用沙盒的文件里 env -i 重置了 PATH（绕过包装）" report <<'EOF'
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux_sandbox_start
env -i PATH=/usr/bin:/bin TMUX_TMPDIR="$TMUX_TMPDIR" bash -c 'tmux ls'
EOF
case_from "env -i 的 PATH 用了单引号（字面量，不展开）" report <<'EOF'
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux_sandbox_start
env -i TMUX_TMPDIR="$TMUX_TMPDIR" PATH='$PATH' /bin/bash -c 'tmux ls'
EOF
case_from "env -i 的 PATH 在原值前面拼了别的目录" report <<'EOF'
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux_sandbox_start
env -i TMUX_TMPDIR="$TMUX_TMPDIR" PATH="/opt/bin:$PATH" bash -c 'tmux ls'
EOF
case_from "env -i 的 PATH 在原值后面拼了别的目录" report <<'EOF'
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux_sandbox_start
env -i TMUX_TMPDIR="$TMUX_TMPDIR" PATH="$PATH:/opt/bin" bash -c 'tmux ls'
EOF
case_from "续行写的 env -i 没带 TMUX_TMPDIR=" report <<'EOF'
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux_sandbox_start
env -i PATH="$PATH" \
    HOME="$H" bash -c 'tmux ls'
EOF
case_from "清理回调里删目录" report <<'EOF'
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux_sandbox_on_exit 'rm -rf "$TMP"'
tmux_sandbox_start
EOF
case_from "载入沙盒之前就 mktemp" report <<'EOF'
TMP=$(mktemp -d)
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux_sandbox_start
EOF
case_from "载入沙盒之后又自己设 EXIT trap" report <<'EOF'
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux_sandbox_start
trap 'rm -rf "$TMP"' EXIT
EOF
case_from "绝对路径直接调 tmux" report <<'EOF'
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux_sandbox_start
/usr/bin/tmux ls
EOF

echo "【2】不报的写法"
case_from "按规矩用沙盒" ok <<'EOF'
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux_sandbox_on_exit ': > "$OUT/hook-ran"'
tmux_sandbox_start
TMP=$(mktemp -d) || exit 1
tmux_sandbox_own_dir "$TMP"
tmux new-session -d -s x 'sleep 3'
env -i PATH="$PATH" TMUX_TMPDIR="$TMUX_TMPDIR" bash -c 'tmux ls'
env -i HOME="$H" PATH="$PATH" \
    TMUX_TMPDIR="$TMUX_TMPDIR" bash -c 'tmux ls'
env -i PATH="${PATH}" TMUX_TMPDIR="$TMUX_TMPDIR" bash -c 'tmux ls'
EOF
case_from "带 -S / -L 的调用" ok <<'EOF'
tmux -S "$SOCK" kill-server 2>/dev/null || true
tmux -L "$NAME" ls
EOF
case_from "写假 tmux、注释、断言标题和说明文字里的 tmux" ok <<'EOF'
# tmux new-session -d -s x 这行是注释
printf '#!/usr/bin/env bash\ncase "$1" in list-sessions|ls) echo x ;; esac\n' > "$BIN/tmux"
chk "tmux 调用逐条一致" "$a" "$b"
echo "  ⏭  跳过（本机没有 tmux）"
command -v tmux >/dev/null 2>&1
EOF
case_from "here-doc 正文里的 tmux" ok <<'EOF'
cat > "$BIN/fake" <<'SH'
tmux ls
SH
EOF
# 已经各用私有服务的测试：真实写法原样摘录（文件开头到第一处直接调用为止的一段）
for f in stuck-worker heavy-test token-redaction; do
    case_from "原样摘录：$f 的私有服务写法" ok < "$TEST_DIR/$f.test.sh"
done

echo "【3】改用沙盒的五个文件：拿掉沙盒那几行就该报"
for f in reap-finished-workers session-isolation poll-pace pending-human-conflict cavil-names; do
    case_from "$f 去掉沙盒后被拦下" report \
        < <(grep -v -e 'tmux-sandbox\.sh' -e 'tmux_sandbox_start' -e 'tmux_sandbox_on_exit' "$TEST_DIR/$f.test.sh")
done

echo "【4】env -i 的参数：守卫的判断对照真实子进程拿到的环境（PR #660 复审 #4）"
# 每行一个参数写法：期望守卫（ok / report）、期望子进程环境（same = PATH 和 TMUX_TMPDIR 都
# 原样拿到 / diff）、写法本身（{CMD} 处换成打印两个变量的命令）。守卫放行而子进程环境不对，
# 就是守卫漏了；守卫多报（写法效果对、但不是唯一认的那种）单独列出，判成要改写法。
# 外层 bash 带 --norc 且 stdin 接 /dev/null：stdin 是套接字时 bash 会去读 bashrc，改掉 PATH。
CMD="/bin/sh -c 'printf \"%s|%s\" \"\$PATH\" \"\$TMUX_TMPDIR\"'"
SB_PATH="$T/sb/bin:/usr/bin:/bin"; SB_DIR="$T/sb/s"
miss=0; m=0
env_case() {   # <名字> <守卫期望> <环境期望> <写法>
    local line="${4//\{CMD\}/$CMD}" f got env_got out
    m=$((m+1)); f="$T/env$m.test.sh"
    printf 'source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"\ntmux_sandbox_start\nenv -i %s\n' "$line" > "$f"
    if python3 "$GUARD" "$f" >/dev/null 2>&1; then got=ok; else got=report; fi
    out="$(env -i PATH="$SB_PATH" TMUX_TMPDIR="$SB_DIR" /bin/bash --norc --noprofile -c "env -i $line" 2>/dev/null </dev/null)"
    if [ "$out" = "$SB_PATH|$SB_DIR" ]; then env_got=same; else env_got=diff; fi
    chk "$1：守卫判 $2" "$got" "$2"
    chk "$1：子进程环境 $3" "$env_got" "$3"
    [ "$got" = ok ] && [ "$env_got" = diff ] && miss=$((miss+1))
    return 0
}
env_case "标准写法"                 ok     same 'PATH="$PATH" TMUX_TMPDIR="$TMUX_TMPDIR" {CMD}'
env_case "花括号写法、顺序反过来"   ok     same 'TMUX_TMPDIR="${TMUX_TMPDIR}" HOME=/h PATH="${PATH}" {CMD}'
env_case "续行"                     ok     same 'PATH="$PATH" \
    TMUX_TMPDIR="$TMUX_TMPDIR" {CMD}'
env_case "带 -u 选项"               ok     same '-u HOME PATH="$PATH" TMUX_TMPDIR="$TMUX_TMPDIR" {CMD}'
env_case "TMUX_TMPDIR= 空值"        report diff 'PATH="$PATH" TMUX_TMPDIR= {CMD}'
env_case "TMUX_TMPDIR=\"\" 空值"    report diff 'PATH="$PATH" TMUX_TMPDIR="" {CMD}'
env_case "正确的 PATH 只在注释里"   report diff 'PATH=/usr/bin:/bin TMUX_TMPDIR="$TMUX_TMPDIR" {CMD} # PATH="$PATH"'
env_case "正确的 TMUX_TMPDIR 只在注释里" report diff 'PATH="$PATH" {CMD} # TMUX_TMPDIR="$TMUX_TMPDIR"'
env_case "两样都写在命令名之后"     report diff '{CMD} PATH="$PATH" TMUX_TMPDIR="$TMUX_TMPDIR"'
env_case "单引号 PATH"              report diff "PATH='\$PATH' TMUX_TMPDIR=\"\$TMUX_TMPDIR\" {CMD}"
env_case "PATH 前面拼了目录"        report diff 'PATH="/opt/bin:$PATH" TMUX_TMPDIR="$TMUX_TMPDIR" {CMD}'
env_case "TMUX_TMPDIR 后面拼了路径" report diff 'PATH="$PATH" TMUX_TMPDIR="$TMUX_TMPDIR/x" {CMD}'
env_case "后面又赋了一次 PATH"      report diff 'PATH="$PATH" TMUX_TMPDIR="$TMUX_TMPDIR" PATH=/usr/bin:/bin {CMD}'
env_case "带引号的整词赋值盖掉前面" report diff 'PATH="$PATH" TMUX_TMPDIR="$TMUX_TMPDIR" "TMUX_TMPDIR=/x" {CMD}'
env_case "两个赋值粘在一起"         report diff 'PATH="$PATH"TMUX_TMPDIR="$TMUX_TMPDIR" {CMD}'
env_case "多报：不加引号"           report same 'PATH=$PATH TMUX_TMPDIR=$TMUX_TMPDIR {CMD}'
env_case "多报：带默认值"           report same 'PATH="$PATH" TMUX_TMPDIR="${TMUX_TMPDIR:-}" {CMD}'
chk "没有守卫放行、子进程环境却不对的写法" "$miss" "0"

echo "【5】仓库里全部测试文件"
out="$(cd "$TEST_DIR/.." && python3 "$GUARD" tests/*.test.sh 2>&1)"; rc=$?
[ -z "$out" ] || printf '%s\n' "$out" | sed 's/^/     /'
chk "仓库里没有一个测试在默认 tmux 服务上直接用 tmux" "$rc" "0"
scanned=$(cd "$TEST_DIR/.." && ls tests/*.test.sh | wc -l)
chk "扫到了测试文件（不是空跑）" "$([ "$scanned" -gt 50 ] && echo yes)" "yes"

echo
echo "通过 $pass / 失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
