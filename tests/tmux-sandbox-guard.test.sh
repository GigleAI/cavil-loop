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
tmux_sandbox_on_exit '[ -z "${TMP:-}" ] || rm -rf "$TMP"'
tmux_sandbox_start
TMP=$(mktemp -d)
tmux new-session -d -s x 'sleep 3'
env -i PATH="$PATH" TMUX_TMPDIR="$TMUX_TMPDIR" bash -c 'tmux ls'
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

echo "【4】仓库里全部测试文件"
out="$(cd "$TEST_DIR/.." && python3 "$GUARD" tests/*.test.sh 2>&1)"; rc=$?
[ -z "$out" ] || printf '%s\n' "$out" | sed 's/^/     /'
chk "仓库里没有一个测试在默认 tmux 服务上直接用 tmux" "$rc" "0"
scanned=$(cd "$TEST_DIR/.." && ls tests/*.test.sh | wc -l)
chk "扫到了测试文件（不是空跑）" "$([ "$scanned" -gt 50 ] && echo yes)" "yes"

echo
echo "通过 $pass / 失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
