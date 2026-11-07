#!/usr/bin/env bash
# 换 worker / 换复审时不把 attach 着的终端踢出 tmux（GitHub#197）。
#
# 跑法：bash tests/session-switch-keeps-client.test.sh            （默认回归，约 30 秒）
#       MUTATION=1 bash tests/session-switch-keeps-client.test.sh （另跑 4 条负对照，约 2 分钟）
# 依赖：tmux（3.0+）、git、jq。
#
# 真跑两个派工脚本（issue 评论、PR 评论），真 tmux——但开在**私有 socket** 上，绝不碰本机
# 跑着 worker 的默认 server。挂着的终端用 tmux 控制模式客户端（`tmux -C attach`）模拟：
# 不需要伪终端，被踢出时它会收到 `%exit`。每个后台客户端都套 timeout，结束时 kill-server。
# （不要改用 `script -qfc "tmux attach"`：没人读输出时它会无限堆内存，实测拖垮过整机。）
#
# 这条错了不会报错：派工照常成功、worker 照常干活，只有挂着看的人被踢出去。所以断言的是
# 「客户端还挂在这个 session 上、没收到退出事件」，外加三条容易一起改坏的语义：
#   · 旧程序不理挂断信号（真 claude 就这样）——换程序后它必须已经不在，不能变孤儿
#   · 新程序秒退——session 必须消失（daemon 靠「session 不在」判 worker 死）
#   · 新程序跑一阵自然退出——session 也必须消失（「退出后保留窗格」得关回去）
set -uo pipefail

# 干净环境重跑自己：worker 会话里本来就带着真 GH_TOKEN / TMUX 等，漏进来会让被测脚本
# 读到真值，或者让 tmux 命令连到外层 server。
if [ -z "${KEEPCLIENT_TEST_CLEAN_ENV:-}" ]; then
    keep=(KEEPCLIENT_TEST_CLEAN_ENV=1 HOME="$HOME" PATH="$PATH" LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}")
    [ -n "${MUTATION:-}" ] && keep+=(MUTATION="$MUTATION")
    exec env -i "${keep[@]}" bash "${BASH_SOURCE[0]}" "$@"
fi

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"

if ! command -v tmux > /dev/null 2>&1; then
    echo "⏭ 本机没有 tmux，整份跳过"; exit 0
fi

TMP=$(mktemp -d); TMP="$(cd "$TMP" && pwd -P)"
# socket 路径有长度上限，单独放一个短目录
TMUX_DIR=$(mktemp -d /tmp/kc.XXXX)
export TMUX_TMPDIR="$TMUX_DIR"
SOCK="$TMUX_DIR/tmux-$(id -u)/default"
mkdir -p "$(dirname "$SOCK")"; chmod 700 "$(dirname "$SOCK")"
T() { timeout 10 tmux -S "$SOCK" "$@"; }
cleanup() {
    # 显式 -S：就算 TMUX_TMPDIR 没生效也不会去关本机默认 server
    timeout 10 tmux -S "$SOCK" kill-server 2>/dev/null || true
    [ -f "$TMP/clients.pids" ] && xargs -r kill 2>/dev/null < "$TMP/clients.pids"
    [ -n "${KEEP_SANDBOX:-}" ] && { echo "SANDBOX=$TMP"; return 0; }
    rm -rf "$TMP" "$TMUX_DIR"
}
trap cleanup EXIT

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }

# ── 假命令 ───────────────────────────────────────────────────────────────────
FAKEBIN="$TMP/fakebin"; CTL="$TMP/ctl"; mkdir -p "$FAKEBIN" "$CTL"
cat > "$FAKEBIN/gh" <<'SH'
#!/usr/bin/env bash
case "$*" in
    *title*) echo "测试标题"; exit 0 ;;
esac
echo "{}"
SH
# 假 agent：不在 tmux 里（driver 探版本之类）立刻退出；在 tmux 里就像 claude 一样**不理
# SIGHUP**，打一行标记后睡 $CTL/secs 秒（默认 120）。
for a in claude codex; do
    cat > "$FAKEBIN/$a" <<SH
#!/usr/bin/env bash
[ -n "\${TMUX:-}" ] || exit 0
trap '' HUP
secs=\$(cat "$CTL/secs" 2>/dev/null || echo 120)
echo "AGENT-RUN $a pid=\$\$ cwd=\$(pwd -P) token=\${GH_TOKEN:-none}"
echo "$a \$\$" >> "$CTL/runs"
exec sleep "\$secs"
SH
done
cat > "$FAKEBIN/systemctl" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$FAKEBIN"/*
export PATH="$FAKEBIN:$PATH"

# ── 真 git：bare origin + 主 checkout + 一条 worktree ─────────────────────────
gq() { git -c user.email=t@example.invalid -c user.name=t "$@" >/dev/null 2>&1; }
G="$TMP/git"; mkdir -p "$G"
gq init -q --bare -b main "$G/up.git"
gq clone -q "$G/up.git" "$G/seed"
(cd "$G/seed" && echo x > f && gq add f && gq commit -qm init && gq push -q origin HEAD:main)
N=77
SESS="kctest-issue$N"

# 一个场景一套独立目录。$1 = 被测 skill 目录
setup_scenario() {
    D="$TMP/sc.$1"; rm -rf "$D"; mkdir -p "$D/state" "$D/logs" "$D/home"
    gq clone -q "$G/up.git" "$D/proj"
    WT="$D/wt/issue-$N"
    gq -C "$D/proj" worktree add -q "$WT" -b "feature/issue-$N"
    cat > "$D/config" <<CONF
REPO="example/none"
PROJECT_ROOT="$D/proj"
WORKTREE_BASE="$D/wt"
STATE_DIR="$D/state"
SESSION_LOG_DIR="$D/logs"
TMUX_PREFIX="kctest"
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
    : > "$CTL/runs"; rm -f "$CTL/secs"
    T kill-server 2>/dev/null
    # 另一个 session 撑着 server：被删的 session 不是最后一个时客户端照样被踢，这才是现场
    T new-session -d -s keep "sleep 600"
}

# 跑一次派工。$1 = skill 目录，$2 = issue|pr，$3 = agent，$4 = 角色（worker|review）
dispatch() {
    local R="$1" kind="$2" agent="$3" role="$4" pk
    pk=""; [ "$role" = review ] && pk=review
    (cd "$D/proj" && HOME="$D/home" CODING_AGENT_CONFIG="$D/config" \
        DISPATCH_WORKER_AGENT="$agent" DISPATCH_PROMPT_KIND="$pk" \
        timeout 120 bash -c '
            if [ "$1" = issue ]; then exec bash "$2/scripts/dispatch-issue-comment.sh" '"$N"' 0
            else exec bash "$2/scripts/dispatch-pr-comment.sh" '"$N"' feature/issue-'"$N"' 0; fi' _ "$kind" "$R") \
        > "$D/dispatch.out" 2>&1
}

# 挂一个控制模式客户端到 $SESS；输出写到 $D/client.out
attach_client() {
    # 整个子 shell 的输出都要重定向：否则 sleep 继承调用方的管道，读的那头要等 90 秒才见 EOF
    ( sleep 90 | timeout 90 tmux -S "$SOCK" -C attach -t "=$SESS" > "$D/client.out" 2>&1 ) > /dev/null 2>&1 < /dev/null &
    echo $! >> "$TMP/clients.pids"
    local i
    for ((i = 0; i < 30; i++)); do
        [ -n "$(T list-clients -t "=$SESS" -F x 2>/dev/null)" ] && return 0
        sleep 0.1
    done
    return 1
}
client_attached() { [ -n "$(T list-clients -t "=$SESS" -F x 2>/dev/null)" ]; }
last_pid() { awk -v a="$1" '$1 == a { p = $2 } END { print p }' "$CTL/runs"; }
wait_runs() {   # 等第 $1 次启动打出标记
    local i
    for ((i = 0; i < 50; i++)); do
        [ "$(wc -l < "$CTL/runs")" -ge "$1" ] && return 0
        sleep 0.1
    done
    return 1
}
# 进程退出后到被回收之间 kill -0 仍然成功（僵尸），给 3 秒
pid_gone() {
    local i
    for ((i = 0; i < 30; i++)); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.1; done
    return 1
}
sess_alive() { T has-session -t "=$SESS" 2>/dev/null; }
wait_gone() {   # 最多等 $1 秒 session 消失
    local i
    for ((i = 0; i < $1 * 10; i++)); do sess_alive || return 0; sleep 0.1; done
    return 1
}

# 一整个场景，打印 PASS/FAIL 行（名字固定，负对照按名字找红）。$1 = skill 目录，$2 = issue|pr
scenario() {
    local R="$1" kind="$2" p1 p2 n
    setup_scenario "$(basename "$R").$kind"

    dispatch "$R" "$kind" claude worker
    if ! sess_alive || ! wait_runs 1; then
        echo "FAIL 首次派工起了 session :: $(tail -5 "$D/dispatch.out" | tr '\n' ' ')"; return
    fi
    attach_client || { echo "FAIL 控制模式客户端挂上了"; return; }
    p1="$(last_pid claude)"

    # 干活 → 复审（换 agent，也换角色）
    dispatch "$R" "$kind" codex review
    wait_runs 2
    if client_attached && ! grep -q '^%exit' "$D/client.out"; then echo "PASS 换去复审后客户端还挂着"
    else echo "FAIL 换去复审后客户端还挂着 :: $(grep '^%' "$D/client.out" | tail -3 | tr '\n' ' ')"; fi
    [ -n "$(last_pid codex)" ] && echo "PASS 复审程序起来了" || echo "FAIL 复审程序起来了 :: $(tail -5 "$D/dispatch.out" | tr '\n' ' ')"
    [ "$(T show-options -qv -t "$SESS" @worker_agent)/$(T show-options -qv -t "$SESS" @worker_role)" = codex/review ] \
        && echo "PASS session 记的是复审" || echo "FAIL session 记的是复审 :: $(T show-options -t "$SESS" 2>&1 | grep worker_ | tr '\n' ' ')"
    if [ -n "$p1" ] && pid_gone "$p1"; then echo "PASS 不理挂断信号的旧程序已不在"
    else echo "FAIL 不理挂断信号的旧程序已不在 :: pid $p1 还活着"; kill -KILL "$p1" 2>/dev/null; fi
    grep -q "token=fake-token-for-test" <(T capture-pane -p -t "=$SESS:") \
        && echo "PASS 新程序拿到了令牌" || echo "FAIL 新程序拿到了令牌 :: $(T capture-pane -p -t "=$SESS:" | grep AGENT-RUN | tr '\n' ' ')"
    [ "$(readlink "/proc/$(last_pid codex)/cwd")" = "$(cd "$WT" && pwd -P)" ] \
        && echo "PASS 新程序在工作目录里" || echo "FAIL 新程序在工作目录里 :: $(readlink "/proc/$(last_pid codex)/cwd")"

    # 复审 → 干活（打回）
    p2="$(last_pid codex)"
    dispatch "$R" "$kind" claude worker
    wait_runs 3
    if client_attached && ! grep -q '^%exit' "$D/client.out"; then echo "PASS 切回干活后客户端还挂着"
    else echo "FAIL 切回干活后客户端还挂着"; fi
    [ "$(wc -l < "$CTL/runs")" = 3 ] && [ "$(awk 'END{print $1}' "$CTL/runs")" = claude ] \
        && echo "PASS 切回的是干活程序" || echo "FAIL 切回的是干活程序 :: $(tr '\n' ' ' < "$CTL/runs")"
    if [ -n "$p2" ] && pid_gone "$p2"; then echo "PASS 复审程序已不在"
    else echo "FAIL 复审程序已不在 :: pid $p2 还活着"; kill -KILL "$p2" 2>/dev/null; fi
    # 第一次启动的输出早于日志挂上（派工先等信任框再挂日志，原来就这样），不计；
    # 两次换程序后的启动都得进同一份文件——日志被关掉的话第三次就没了
    n="$(grep -a -o 'AGENT-RUN [a-z]*' "$D/logs/$SESS.log" 2>/dev/null | awk '{print $2}' | tr '\n' ' ')"
    [ "$n" = "codex claude " ] && echo "PASS 换程序后的两次启动都写进同一份会话日志" \
        || echo "FAIL 换程序后的两次启动都写进同一份会话日志 :: [$n]"

    # 新程序跑一阵后自然退出 → session 消失
    echo 3 > "$CTL/secs"
    dispatch "$R" "$kind" codex review
    if wait_runs 4 && sess_alive; then :; else echo "FAIL 自然退出前 session 在跑"; fi
    if wait_gone 8; then echo "PASS 程序自然退出后 session 消失"
    else echo "FAIL 程序自然退出后 session 消失 :: dead=$(T list-panes -t "=$SESS:" -F '#{pane_dead}' 2>&1)"; fi

    # 新程序秒退 → session 消失
    rm -f "$CTL/secs"
    dispatch "$R" "$kind" claude worker
    wait_runs 5
    attach_client
    echo 0 > "$CTL/secs"
    dispatch "$R" "$kind" codex review
    if wait_gone 5; then echo "PASS 新程序秒退后 session 消失"
    else echo "FAIL 新程序秒退后 session 消失 :: dead=$(T list-panes -t "=$SESS:" -F '#{pane_dead}' 2>&1)"; fi
    rm -f "$CTL/secs"
    T kill-server 2>/dev/null
}

# 把一份 skill 目录复制出来（不带 client/ 和 .git），改坏一处。$1 = 名字，$2 = python 替换脚本
mutant() {
    local M="$TMP/mut-$1"
    rm -rf "$M"; mkdir -p "$M"
    (cd "$REPO_DIR" && tar --exclude=./client --exclude=./.git -cf - .) | (cd "$M" && tar -xf -)
    if ! python3 -c "$2" "$M/scripts/_lib.sh"; then
        echo "  ❌ 负对照 $1 准备失败：要改的原文找不到"; fail=$((fail+1)); return 1
    fi
    printf '%s' "$M"
}
# 跑负对照：$1 = 名字，$2 = 期望变红的检查名，$3 = python 替换脚本，$4 = issue|pr
expect_red() {
    local M out
    M="$(mutant "$1" "$3")" || return
    out="$(scenario "$M" "$4")"
    if grep -qx "FAIL $2.*" <<<"$out" || grep -q "^FAIL $2 ::" <<<"$out"; then
        ok "负对照「$1」：「$2」变红"
    else
        bad "负对照「$1」：「$2」没变红"; sed 's/^/      /' <<<"$out"
    fi
}

judge() {   # 把 scenario 的输出换成计数
    local line
    while IFS= read -r line; do
        case "$line" in
            PASS\ *) ok "$1·${line#PASS }" ;;
            FAIL\ *) bad "$1·${line#FAIL }" ;;
        esac
    done
}

echo "── 1. issue 评论派工：干活 ⇄ 复审往返 ──"
judge issue < <(scenario "$REPO_DIR" issue)
echo "── 2. PR 评论派工：干活 ⇄ 复审往返 ──"
judge PR < <(scenario "$REPO_DIR" pr)

echo "── 3. 负对照 ──"
if mutation_gate; then
    # 换回删 session 再新建的旧做法
    expect_red "删 session 重建" "换去复审后客户端还挂着" '
import sys; p=sys.argv[1]; s=open(p).read()
old="""    if ! session_alive "$sess"; then
        tmux new-session -d -s "$sess" "$@" -c "$cwd" "$cmd"
        return
    fi
"""
assert old in s
s=s.replace(old, old.replace("if ! session_alive \"$sess\"; then", "tmux kill-session -t \"=$sess\" 2>/dev/null || true; if ! session_alive \"$sess\"; then"))
open(p,"w").write(s)' issue
fi
if mutation_gate; then
    # 不先按进程组终止，只靠 respawn-pane -k 的挂断信号
    expect_red "不先终止旧程序" "不理挂断信号的旧程序已不在" '
import sys; p=sys.argv[1]; s=open(p).read()
old="        kill_pane_pids $pid\n"
assert old in s
s=s.replace(old, "        :\n", 1)
open(p,"w").write(s)' pr
fi
if mutation_gate; then
    # 起完新程序忘了把「退出后保留窗格」关回去
    expect_red "保留窗格没关回去" "程序自然退出后 session 消失" '
import sys; p=sys.argv[1]; s=open(p).read()
old="""    tmux set-option -w -t "$pane" remain-on-exit off 2>/dev/null || true
    if [ "$(tmux display-message"""
assert old in s
s=s.replace(old, """    if [ "$(tmux display-message""")
open(p,"w").write(s)' issue
fi
if mutation_gate; then
    # 会话日志不先看有没有 pipe，直接 pipe-pane -o（它是开关，会把已有日志关掉）
    expect_red "日志开关没先判断" "换程序后的两次启动都写进同一份会话日志" '
import sys; p=sys.argv[1]; s=open(p).read()
old="""    if [ "$(tmux display-message -p -t "=$sess:" \x27#{pane_pipe}\x27 2>/dev/null)" = 1 ]; then
        return 0
    fi
"""
assert old in s
s=s.replace(old, "", 1)
open(p,"w").write(s)' pr
fi

echo
mutation_summary "$0"
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
