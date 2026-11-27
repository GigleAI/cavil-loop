#!/usr/bin/env bash
# kind: unit
# source 了 scripts/_lib.sh 的脚本，stderr 还在、而且先过令牌脱敏（GitHub#739）。
#
# 跑法：bash tests/lib-stderr.test.sh
#
# 以前 _lib.sh 顶部写的是 `exec 9>&- 2>/dev/null`：不带命令的 exec 上的重定向永久生效，每个 source
# 它的脚本 stderr 从此是 /dev/null——拒绝派工的说明、set -e 下的报错全部无声消失。修好之后 stderr
# 会去 journal / launchd 的错误日志 / 终端，所以同时要求它先过 poll.log 用的那套脱敏。
# 每条都跑真脚本（source 真 _lib.sh 的子进程），断言调用方实际收到的字节。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1"; echo "     期望：[$3]"; echo "     实得：[$2]"; fail=$((fail+1)); fi
}

mkdir -p "$SANDBOX/h" "$SANDBOX/project" "$SANDBOX/bin"
CONF="$SANDBOX/project/cavil-loop.config"
{ cat "$REPO_DIR/cavil-loop.config.example"
  echo "REPO=example/none"
  echo "STATE_DIR=$SANDBOX/state"
  echo "WORKTREE_BASE=$SANDBOX/wt"
  echo "TMUX_PREFIX=stderrtest"
} > "$CONF"
TOKEN="ghp_abcdefghijklmnopqrstuvwxyz0123456789"
# 干净环境：不继承 worker 会话里的 GH_TOKEN / DISPATCH_* 等
run() {   # <脚本> [额外的 env 赋值...]
    local s="$1"; shift
    env -i HOME="$SANDBOX/h" PATH="${TEST_PATH:-/usr/bin:/bin}" LANG=C.UTF-8 \
        PROJECT_ROOT="$SANDBOX/project" CODING_AGENT_CONFIG="$CONF" "$@" bash "$s"
}
script() {   # <名字> <source 之后要跑的命令>
    printf 'set -euo pipefail\nsource %q\n%s\n' "$REPO_DIR/scripts/_lib.sh" "$2" > "$SANDBOX/$1.sh"
    printf '%s' "$SANDBOX/$1.sh"
}

echo "【1】stderr 到得了调用方"
s=$(script plain 'echo "to-stderr" >&2; echo "to-stdout"')
chk "stderr 和 stdout 都收到" "$(run "$s" 2>&1 | sort | tr '\n' ' ')" "to-stderr to-stdout "
chk "只收 stdout 时 stdout 不混进 stderr" "$(run "$s" 2>/dev/null)" "to-stdout"
chk "只收 stderr 时就是那一行" "$(run "$s" 2>&1 >/dev/null)" "to-stderr"
s=$(script unbound 'echo "${NO_SUCH_VAR_739}"')
chk "set -u 下的报错不再无声消失" "$(run "$s" 2>&1 | grep -c 'NO_SUCH_VAR_739')" "1"

echo "【2】fd 9（轮询锁）照旧被关掉"
s=$(script fd9 'if [ -e /proc/$$/fd/9 ]; then echo open; else echo closed; fi')
chk "source 之后 fd 9 已关" "$(run "$s" 9>"$SANDBOX/lock" 2>/dev/null)" "closed"

echo "【3】stderr 先过令牌脱敏"
s=$(script token "echo \"before $TOKEN after\" >&2")
got=$(run "$s" 2>&1)
chk "令牌原文不出现" "$(printf '%s' "$got" | grep -c "$TOKEN")" "0"
chk "前后文字还在、令牌换成了替换串" "$(printf '%s' "$got" | grep -c '^before REDACTED-[0-9a-f]*-* after$')" "1"
s=$(script logline "log \"log line $TOKEN\"")
got=$(run "$s" 2>&1)
chk "log() 的那一行到了 stderr、只一次" "$(printf '%s\n' "$got" | grep -c 'log line')" "1"
chk "log() 写进 stderr 的那行也没有令牌" "$(printf '%s' "$got" | grep -c "$TOKEN")" "0"
chk "log() 照旧写进 poll.log" "$(grep -c 'log line REDACTED' "$SANDBOX/state/poll.log")" "1"
# 子程序直接写 stderr（不经过 log()）也一样过滤
s=$(script child "bash -c 'echo \"child $TOKEN\" >&2'")
chk "子程序直接写的 stderr 也被替换" "$(run "$s" 2>&1 | grep -c "$TOKEN")" "0"

echo "【4】过滤程序不可用时宁丢不落原文，写的一方也不被打死"
printf '#!/bin/sh\nexit 3\n' > "$SANDBOX/bin/python3"; chmod +x "$SANDBOX/bin/python3"
s=$(script nopython "echo \"x $TOKEN\" >&2; i=0; while [ \$i -lt 200 ]; do echo \"line \$i\" >&2; i=\$((i+1)); done; echo done-stdout")
got=$(TEST_PATH="$SANDBOX/bin:/usr/bin:/bin" run "$s" 2>&1); rc=$?
chk "令牌原文不出现" "$(printf '%s' "$got" | grep -c "$TOKEN")" "0"
chk "留下一行替换失败的说明" "$(printf '%s' "$got" | grep -c '令牌替换失败（退出码 3），其余内容已丢弃')" "1"
chk "脚本照常跑完（没有被 SIGPIPE 打死）" "$rc $(printf '%s' "$got" | grep -c '^done-stdout$')" "0 1"

echo "【5】调用方 \$( … 2>&1 ) 按时返回"
# 过滤进程不能攥着原 stdout，否则 $(…) 要等它；正确地把 stderr 指走的后台子进程也不能拖住调用方
s=$(script bg 'sleep 20 >/dev/null 2>&1 & echo started')
t0=$(date +%s); got=$(run "$s" 2>&1); t1=$(date +%s)
chk "立刻返回（< 10 秒）、拿到输出" "$(( t1 - t0 < 10 )) $got" "1 started"

echo "【6】stderr 本来就是 /dev/null 时不起过滤进程"
# 过滤进程是本进程的孙子（进程替换的子 shell 再起 python）；按父子关系找，免得数到别的测试的
s=$(script devnull 'sleep 0.3; for c in $(pgrep -P $$); do pgrep -P "$c" -f "redact_tokens.py filter"; done | wc -l')
chk "stderr=/dev/null：没有过滤进程" "$(run "$s" 2>/dev/null)" "0"
chk "stderr 是管道：有一个过滤进程" "$(run "$s" 2>&1 | tail -1)" "1"

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
