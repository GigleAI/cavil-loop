#!/usr/bin/env bash
# 换 worker / 换复审时不把 attach 着的终端踢出 tmux（GitHub#197）。
#
# 跑法：bash tests/session-switch-keeps-client.test.sh            （默认回归，约 30 秒）
#       MUTATION=1 bash tests/session-switch-keeps-client.test.sh （另跑 10 条负对照，约 6 分钟）
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
REAL_TMUX="$(command -v tmux)"
# 测试自己的查询走真 tmux，不经过下面的故障注入包装
T() { timeout 10 "$REAL_TMUX" -S "$SOCK" "$@"; }
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
cat > "$FAKEBIN/gh" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CTL/gh.log"
case "\$*" in
    *title*) echo "测试标题"; exit 0 ;;
esac
echo "{}"
SH
# 假 agent：不在 tmux 里（driver 探版本之类）立刻退出；在 tmux 里就像 claude 一样**不理
# SIGHUP**，打一行标记、往 $CTL/runs 记「名字 pid 令牌」（断言读这份文件，不读屏幕——
# 屏幕会按 80 列软换行，长行里的令牌被折成两半），然后睡 $CTL/secs 秒（默认 120）。
for a in claude codex; do
    cat > "$FAKEBIN/$a" <<SH
#!/usr/bin/env bash
[ -n "\${TMUX:-}" ] || exit 0
trap '' HUP
secs=\$(cat "$CTL/secs" 2>/dev/null || echo 120)
echo "AGENT-RUN $a pid=\$\$ cwd=\$(pwd -P) token=\${GH_TOKEN:-none}"
echo "$a \$\$ token=\${GH_TOKEN:-none}" >> "$CTL/runs"
if [ -e "$CTL/tick" ]; then
    while :; do echo "TICK \$\$"; sleep 0.1; done
fi
exec sleep "\$secs"
SH
done
cat > "$FAKEBIN/systemctl" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$FAKEBIN"/*
# 被测脚本用的 tmux：$CTL/fault 里写一个 glob，参数整串匹配上就返回 1（模拟一次查询失败），
# 其余原样交给真 tmux
cat > "$FAKEBIN/tmux" <<SH
#!/usr/bin/env bash
if [ -s "$CTL/fault" ]; then
    pat="\$(cat "$CTL/fault")"
    if [[ "\$*" == \$pat ]]; then echo "injected failure: \$*" >> "$CTL/fault.hits"; exit 1; fi
fi
exec "$REAL_TMUX" "\$@"
SH
chmod +x "$FAKEBIN/tmux"
export PATH="$FAKEBIN:$PATH"

# ── 真 git：bare origin + 主 checkout + 一条 worktree ─────────────────────────
gq() { git -c user.email=t@example.invalid -c user.name=t "$@" >/dev/null 2>&1; }
G="$TMP/git"; mkdir -p "$G"
gq init -q --bare -b main "$G/up.git"
gq clone -q "$G/up.git" "$G/seed"
(cd "$G/seed" && echo x > f && gq add f && gq commit -qm init && gq push -q origin HEAD:main)
# 编号取一个真实 issue 用不到的大数：派工脚本把提示词写到固定的 /tmp/cavil-loop-issue-<N>-*.md，
# 用小编号会和本机正在跑的真 worker 或别的测试撞同一个文件（GitHub#211 起测试会并行跑）
N=987971
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
    ( sleep 90 | timeout 90 "$REAL_TMUX" -S "$SOCK" -C attach -t "=$SESS" > "$D/client.out" 2>&1 ) > /dev/null 2>&1 < /dev/null &
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
    [ "$(awk '$1 == "codex" { t = $3 } END { print t }' "$CTL/runs")" = "token=fake-token-for-test" ] \
        && echo "PASS 新程序拿到了令牌" || echo "FAIL 新程序拿到了令牌 :: $(tr '\n' ' ' < "$CTL/runs")"
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

# pid 所在的窗格：沿父进程往上找，直到碰到某个窗格的首进程
pane_of_pid() {
    local p="$1" map
    map="$(T list-panes -a -F '#{pane_pid} #{pane_id}')"
    while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
        awk -v p="$p" '$1 == p { print $2; f = 1 } END { exit !f }' <<<"$map" && return 0
        p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
    done
    return 1
}

# 人在 worker 的 session 里分屏（新窗格排在 worker 前面），再派复审；然后 worker 自己退出、
# 人的窗格撑着 session，再派一次。$1 = skill 目录，$2 = issue|pr
split_scenario() {
    local R="$1" kind="$2" wpane w1 hpane hpid w2 n
    setup_scenario "$(basename "$R").split.$kind"
    dispatch "$R" "$kind" claude worker
    if ! sess_alive || ! wait_runs 1; then
        echo "FAIL 分屏·首次派工起了 session :: $(tail -5 "$D/dispatch.out" | tr '\n' ' ')"; return
    fi
    attach_client || { echo "FAIL 分屏·控制模式客户端挂上了"; return; }
    w1="$(last_pid claude)"; wpane="$(pane_of_pid "$w1")"
    # 人的程序：普通进程，在 worker 前面分出来的窗格里跑
    hpane="$(T split-window -b -t "$wpane" -P -F '#{pane_id}' "exec sleep 600")"
    hpid="$(T display-message -p -t "$hpane" '#{pane_pid}')"
    [ "$(T list-panes -s -t "=$SESS" -F '#{pane_id}' | head -1)" = "$hpane" ] \
        || { echo "FAIL 分屏·夹具：人的窗格排在第一个 :: $(T list-panes -s -t "=$SESS" -F '#{pane_id}' | tr '\n' ' ')"; return; }

    dispatch "$R" "$kind" codex review
    wait_runs 2
    w2="$(last_pid codex)"
    if pid_gone "$w1"; then echo "PASS 分屏·旧 worker 已不在"; else echo "FAIL 分屏·旧 worker 已不在 :: pid $w1 还活着"; kill -KILL "$w1" 2>/dev/null; fi
    kill -0 "$hpid" 2>/dev/null && echo "PASS 分屏·人的程序还活着" || echo "FAIL 分屏·人的程序还活着 :: pid $hpid 没了"
    [ -n "$w2" ] && [ "$(pane_of_pid "$w2")" = "$wpane" ] && echo "PASS 分屏·复审程序在原 worker 窗格里" \
        || echo "FAIL 分屏·复审程序在原 worker 窗格里 :: 期望 $wpane，实得 $( [ -n "$w2" ] && pane_of_pid "$w2")"
    if client_attached && ! grep -q '^%exit' "$D/client.out"; then echo "PASS 分屏·客户端还挂着"
    else echo "FAIL 分屏·客户端还挂着"; fi

    # worker 自己退出，人的窗格还撑着 session；再派一次干活
    kill -TERM "$w2" 2>/dev/null; pid_gone "$w2"
    for ((n = 0; n < 30; n++)); do T display-message -p -t "$wpane" x > /dev/null 2>&1 || break; sleep 0.1; done
    dispatch "$R" "$kind" claude worker
    wait_runs 3
    n="$(last_pid claude)"
    [ "$n" != "$w1" ] && kill -0 "$n" 2>/dev/null && echo "PASS 分屏·worker 窗格没了也能再起 worker" \
        || echo "FAIL 分屏·worker 窗格没了也能再起 worker :: $(tail -5 "$D/dispatch.out" | tr '\n' ' ')"
    kill -0 "$hpid" 2>/dev/null && echo "PASS 分屏·再起 worker 时人的程序还活着" || echo "FAIL 分屏·再起 worker 时人的程序还活着"
    if client_attached && ! grep -q '^%exit' "$D/client.out"; then echo "PASS 分屏·再起 worker 时客户端还挂着"
    else echo "FAIL 分屏·再起 worker 时客户端还挂着"; fi
    T kill-server 2>/dev/null
}

# 在被测 skill 目录里 source 公共库，问一次 worker_alive
lib_alive() {   # <skill 目录>
    (cd "$D/proj" && HOME="$D/home" CODING_AGENT_CONFIG="$D/config" timeout 30 \
        bash -c 'source "$1/scripts/_lib.sh" > /dev/null 2>&1; set +e; worker_alive "$2"; case $? in 0) echo alive ;; 1) echo dead ;; 2) echo unknown ;; *) echo "rc$?" ;; esac' _ "$1" "$SESS" 2>/dev/null)
}
# 在被测 skill 目录里 source 公共库，调一次 start_session_logging
lib_logging() {   # <skill 目录>
    (cd "$D/proj" && HOME="$D/home" CODING_AGENT_CONFIG="$D/config" timeout 30 \
        bash -c 'source "$1/scripts/_lib.sh" > /dev/null 2>&1; set +e; start_session_logging "$2"' _ "$1" "$SESS" > /dev/null 2>&1)
}

# 读 tmux 失败时（复审第 2 轮）：不杀、不另起、不改记录、不翻标签；恢复后正常切换。
# $1 = skill 目录，$2 = issue|pr
fault_scenario() {
    local R="$1" kind="$2" w1 wpane hpane hpid name pat rc runs0 n
    setup_scenario "$(basename "$R").fault.$kind"
    dispatch "$R" "$kind" claude worker
    if ! sess_alive || ! wait_runs 1; then
        echo "FAIL 故障·首次派工起了 session :: $(tail -5 "$D/dispatch.out" | tr '\n' ' ')"; return
    fi
    w1="$(last_pid claude)"; wpane="$(pane_of_pid "$w1")"
    hpane="$(T split-window -b -t "$wpane" -P -F '#{pane_id}' "exec sleep 600")"
    hpid="$(T display-message -p -t "$hpane" '#{pane_pid}')"
    attach_client || { echo "FAIL 故障·控制模式客户端挂上了"; return; }
    [ "$(T show-options -qv -t "=$SESS:" @worker_pane)" = "$wpane" ] \
        || { echo "FAIL 故障·夹具：已记录 worker 窗格 :: $(T show-options -qv -t "=$SESS:" @worker_pane)"; return; }

    local round rcs r
    for name in 窗格清单读不到 记录读不到 身份读不到; do
        case "$name" in
            窗格清单读不到) pat='*list-panes*#{pane_pid} #{pane_dead}*' ;;
            记录读不到)     pat='*show-options*@worker_pane*' ;;
            身份读不到)     pat='*show-options*@worker_agent*' ;;
        esac
        runs0="$(wc -l < "$CTL/runs")"; : > "$CTL/gh.log"; rm -f "$CTL/fault.hits"
        printf '%s' "$pat" > "$CTL/fault"
        if [ "$name" != 身份读不到 ]; then
            # 判活只读窗格清单 / 记录；身份那一项和判活无关
            [ "$(lib_alive "$R")" != dead ] && echo "PASS 故障·${name}·判活不判死" || echo "FAIL 故障·${name}·判活不判死"
        fi
        # 故障连续持续两轮派工
        rcs=""; rc=1
        for round in 1 2; do
            dispatch "$R" "$kind" codex review; r=$?
            rcs="$rcs $r"; [ "$r" = 0 ] && rc=0
        done
        rm -f "$CTL/fault"
        # 到达性：故障确实被被测代码撞上了
        [ -s "$CTL/fault.hits" ] && echo "PASS 故障·${name}·查询确实失败过" || echo "FAIL 故障·${name}·查询确实失败过"
        [ "$rc" != 0 ] && echo "PASS 故障·${name}·两轮派工都失败退出" || echo "FAIL 故障·${name}·两轮派工都失败退出 :: 退出码 $rcs"
        kill -0 "$w1" 2>/dev/null && echo "PASS 故障·${name}·原 worker 还活着" || echo "FAIL 故障·${name}·原 worker 还活着"
        kill -0 "$hpid" 2>/dev/null && echo "PASS 故障·${name}·人的程序还活着" || echo "FAIL 故障·${name}·人的程序还活着"
        n="$(wc -l < "$CTL/runs")"
        [ "$n" = "$runs0" ] && echo "PASS 故障·${name}·没有起第二个程序" || echo "FAIL 故障·${name}·没有起第二个程序 :: $(tr '\n' ' ' < "$CTL/runs")"
        [ "$(T show-options -qv -t "=$SESS:" @worker_pane)" = "$wpane" ] && echo "PASS 故障·${name}·记录没被改" \
            || echo "FAIL 故障·${name}·记录没被改 :: $(T show-options -qv -t "=$SESS:" @worker_pane)"
        [ "$(T list-panes -s -t "=$SESS:" -F x | wc -l)" = 2 ] && echo "PASS 故障·${name}·窗格数没变" || echo "FAIL 故障·${name}·窗格数没变"
        if client_attached && ! grep -q '^%exit' "$D/client.out"; then echo "PASS 故障·${name}·客户端还挂着"
        else echo "FAIL 故障·${name}·客户端还挂着"; fi
        grep -q 'doing/agent' "$CTL/gh.log" && echo "FAIL 故障·${name}·没有翻标签 :: $(grep doing/agent "$CTL/gh.log" | head -1)" \
            || echo "PASS 故障·${name}·没有翻标签"
    done

    # 查询恢复后：正常完成一次切换
    : > "$CTL/gh.log"
    dispatch "$R" "$kind" codex review
    wait_runs 2
    pid_gone "$w1" && echo "PASS 故障·恢复后·旧 worker 已停" || { echo "FAIL 故障·恢复后·旧 worker 已停"; kill -KILL "$w1" 2>/dev/null; }
    kill -0 "$hpid" 2>/dev/null && echo "PASS 故障·恢复后·人的程序还活着" || echo "FAIL 故障·恢复后·人的程序还活着"
    n="$(last_pid codex)"
    [ -n "$n" ] && [ "$(pane_of_pid "$n")" = "$wpane" ] && echo "PASS 故障·恢复后·复审程序在原 worker 窗格里" \
        || echo "FAIL 故障·恢复后·复审程序在原 worker 窗格里 :: $(tail -3 "$D/dispatch.out" | tr '\n' ' ')"
    grep -q 'doing/agent' "$CTL/gh.log" && echo "PASS 故障·恢复后·翻了标签" || echo "FAIL 故障·恢复后·翻了标签"
    T kill-server 2>/dev/null
}

# 会话日志与 session 清单读不到时（复审第 3 轮）。$1 = skill 目录
log_fault_scenario() {
    local R="$1" wpane w1 t0 t1 t2 r
    setup_scenario "$(basename "$R").logfault"
    : > "$CTL/tick"
    dispatch "$R" issue claude worker
    if ! sess_alive || ! wait_runs 1; then
        echo "FAIL 日志·首次派工起了 session :: $(tail -5 "$D/dispatch.out" | tr '\n' ' ')"; return
    fi
    w1="$(last_pid claude)"; wpane="$(pane_of_pid "$w1")"
    lib_logging "$R"
    [ "$(T display-message -p -t "$wpane" '#{pane_pipe}')" = 1 ] \
        || { echo "FAIL 日志·夹具：日志管道已开 :: $(T display-message -p -t "$wpane" '#{pane_pipe}')"; return; }
    ticks() { grep -ac TICK "$D/logs/$SESS.log" 2>/dev/null; }
    sleep 0.5; t0="$(ticks)"
    # 任何读日志状态（pane_pipe）的查询都失败，连续两轮
    printf '%s' '*pane_pipe*' > "$CTL/fault"; rm -f "$CTL/fault.hits"
    # 每一轮之后都查：旧写法的 -o 是开关，两轮会关了又开，只看最后会把错误抵消掉
    local closed=""
    for r in 1 2; do
        lib_logging "$R"
        [ "$(T display-message -p -t "$wpane" '#{pane_pipe}')" = 1 ] || closed="$closed 第${r}轮"
    done
    rm -f "$CTL/fault"
    [ -s "$CTL/fault.hits" ] && echo "PASS 日志·读不到·查询确实失败过" || echo "FAIL 日志·读不到·查询确实失败过"
    [ -z "$closed" ] && echo "PASS 日志·读不到时管道还开着" || echo "FAIL 日志·读不到时管道还开着 ::$closed 后被关掉"
    sleep 0.6; t1="$(ticks)"
    [ "$t1" -gt "$t0" ] && echo "PASS 日志·读不到时日志还在增长" || echo "FAIL 日志·读不到时日志还在增长 :: $t0 -> $t1"
    # 恢复后连调两次：仍是开着（不会被开关切回关闭），日志继续增长
    closed=""
    for r in 1 2; do
        lib_logging "$R"
        [ "$(T display-message -p -t "$wpane" '#{pane_pipe}')" = 1 ] || closed="$closed 第${r}轮"
    done
    [ -z "$closed" ] && echo "PASS 日志·恢复后重复调用管道还开着" || echo "FAIL 日志·恢复后重复调用管道还开着 ::$closed 后被关掉"
    sleep 0.6; t2="$(ticks)"
    [ "$t2" -gt "$t1" ] && echo "PASS 日志·恢复后日志还在增长" || echo "FAIL 日志·恢复后日志还在增长 :: $t1 -> $t2"
    # 日志确实关着时，恢复后能开起来（到达性：「开」这条路真的走得到）
    T pipe-pane -t "$wpane"; sleep 0.2
    [ "$(T display-message -p -t "$wpane" '#{pane_pipe}')" = 0 ] || { echo "FAIL 日志·夹具：手动关掉日志"; return; }
    lib_logging "$R"
    [ "$(T display-message -p -t "$wpane" '#{pane_pipe}')" = 1 ] && echo "PASS 日志·确实没开时会开起来" \
        || echo "FAIL 日志·确实没开时会开起来"
    # session 清单读不到：判活要说「不知道」，不能说「死了」
    printf '%s' '*list-sessions*' > "$CTL/fault"
    r="$(lib_alive "$R")"
    rm -f "$CTL/fault"
    [ "$r" = unknown ] && echo "PASS 会话清单读不到·判活为不知道" || echo "FAIL 会话清单读不到·判活为不知道 :: $r"
    [ "$(lib_alive "$R")" = alive ] && echo "PASS 会话清单恢复后·判活为活着" || echo "FAIL 会话清单恢复后·判活为活着"
    rm -f "$CTL/tick"
    T kill-server 2>/dev/null
}

# 把一份 skill 目录复制出来（不带 client/ 和 .git），改坏一处。$1 = 名字，$2 = python 替换脚本
mutant() {
    local M="$TMP/mut-$1"
    rm -rf "$M"; mkdir -p "$M"
    (cd "$REPO_DIR" && tar --exclude=./client --exclude=./.git -cf - .) | (cd "$M" && tar -xf -)
    python3 -c "$2" "$M/scripts/_lib.sh" >&2 || return 1
    printf '%s' "$M"
}
# 跑负对照：$1 = 名字，$2 = 期望变红的检查名，$3 = python 替换脚本，$4 = issue|pr
expect_red() {
    local M out
    if ! M="$(mutant "$1" "$3")"; then
        bad "负对照「$1」准备失败：要改的原文找不到"; return
    fi
    out="$("${5:-scenario}" "$M" "$4")"
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

echo "── 3. 人在 worker 的 session 里分屏 ──"
judge issue < <(split_scenario "$REPO_DIR" issue)
judge PR < <(split_scenario "$REPO_DIR" pr)

echo "── 4. 读 tmux 失败时什么都不动 ──"
judge issue < <(fault_scenario "$REPO_DIR" issue)
judge PR < <(fault_scenario "$REPO_DIR" pr)

echo "── 5. 读不到日志状态 / session 清单时 ──"
judge issue < <(log_fault_scenario "$REPO_DIR")

echo "── 6. 负对照 ──"
if mutation_gate; then
    # 换回删 session 再新建的旧做法
    expect_red "删 session 重建" "换去复审后客户端还挂着" '
import sys; p=sys.argv[1]; s=open(p).read()
old="""    if ! session_alive "$sess"; then
        pane="$(tmux new-session"""
assert old in s
s=s.replace(old, old.replace("    if ! session_alive", "    tmux kill-session -t \"=$sess\" 2>/dev/null || true\n    if ! session_alive"))
open(p,"w").write(s)' issue
fi
if mutation_gate; then
    # 不先按进程组终止，只靠 respawn-pane -k 的挂断信号
    expect_red "不先终止旧程序" "不理挂断信号的旧程序已不在" '
import sys; p=sys.argv[1]; s=open(p).read()
old="        kill_pane_pids \x22$pid\x22\n"
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
    # 会话日志不先看有没有 pipe，又用回 pipe-pane -o（它是开关，会把已有日志关掉）
    expect_red "日志开关没先判断" "换程序后的两次启动都写进同一份会话日志" '
import sys; p=sys.argv[1]; s=open(p).read()
old="    [ \x22$pipe\x22 = 1 ] && return 0\n"
assert old in s
s=s.replace(old, "", 1)
old2="    if ! tmux pipe-pane -t \x22$tgt\x22"
assert old2 in s
s=s.replace(old2, "    if ! tmux pipe-pane -o -t \x22$tgt\x22", 1)
open(p,"w").write(s)' pr
fi
if mutation_gate; then
    # 按排列顺序认 worker 窗格（复审第 1 轮的实现）
    expect_red "按顺序认 worker 窗格" "分屏·人的程序还活着" '
import sys; p=sys.argv[1]; s=open(p).read()
old="""        if [ -n "$rec" ] && [ "$id" = "$rec" ]; then hit="$id $pid $dead $pipe"; fi"""
assert old in s
s=s.replace(old, "        [ \x22$n\x22 -eq 1 ] && hit=\x22$id $pid $dead $pipe\x22", 1)
open(p,"w").write(s)' issue split_scenario
fi
if mutation_gate; then
    # 记录读失败当成「没有记录」（复审第 2 轮复现 B）
    expect_red "记录读失败当没有" "故障·记录读不到·人的程序还活着" '
import sys; p=sys.argv[1]; s=open(p).read()
old="""    if ! rec="$(tmux show-options -qv -t "=$sess:" @worker_pane 2>/dev/null)"; then
        echo unknown; return 0
    fi"""
assert old in s
s=s.replace(old, "    rec=\x22$(tmux show-options -qv -t \x22=$sess:\x22 @worker_pane 2>/dev/null || true)\x22", 1)
open(p,"w").write(s)' issue fault_scenario
fi
if mutation_gate; then
    # 窗格清单读失败当成「记录的窗格已不在」（复审第 2 轮复现 A）
    expect_red "清单读失败当窗格不在" "故障·窗格清单读不到·没有起第二个程序" '
import sys; p=sys.argv[1]; s=open(p).read()
old="""    if ! panes="$(tmux list-panes -s -t "=$sess:" -F \x27#{pane_id} #{pane_pid} #{pane_dead} #{pane_pipe}\x27 2>/dev/null)"; then
        echo unknown; return 0
    fi"""
assert old in s
s=s.replace(old, "    panes=\x22$(tmux list-panes -s -t \x22=$sess:\x22 -F \x27#{pane_id} #{pane_pid} #{pane_dead} #{pane_pipe}\x27 2>/dev/null || true)\x22", 1)
old2="""    if [ "$n" -eq 0 ]; then echo unknown; return 0; fi"""
assert old2 in s
s=s.replace(old2, """    if [ "$n" -eq 0 ] && [ -n "$rec" ]; then echo "gone $rec"; return 0; fi""", 1)
open(p,"w").write(s)' pr fault_scenario
fi
if mutation_gate; then
    # 日志状态读不到时照旧用 -o 开（复审第 3 轮复现）
    expect_red "日志读不到当没开" "日志·读不到时管道还开着" '
import sys; p=sys.argv[1]; s=open(p).read()
old="""    case "$st" in
        found|single) ;;
        *)
            log "  ⚠️ 认不出 $sess 的 worker 窗格（或读不到，状态 $st），本次不碰会话日志"
            return 0 ;;
    esac
    [ "$pipe" = 1 ] && return 0"""
assert old in s
s=s.replace(old, "    [ \x22$pipe\x22 = 1 ] && return 0\n    tgt=\x22=$sess:\x22", 1)
old2="    if ! tmux pipe-pane -t \x22$tgt\x22"
assert old2 in s
s=s.replace(old2, "    if ! tmux pipe-pane -o -t \x22$tgt\x22", 1)
open(p,"w").write(s)' issue log_fault_scenario
fi
if mutation_gate; then
    # 身份读不到时当成默认值（改动前的写法）
    expect_red "身份读不到当默认" "故障·身份读不到·原 worker 还活着" '
import sys; p=sys.argv[1]; s=open(p).read()
old="2>/dev/null)\x22 || return 2"
assert s.count(old) == 3
s=s.replace(old, "2>/dev/null || true)\x22")
open(p,"w").write(s)' pr fault_scenario
fi
if mutation_gate; then
    # session 清单读不到时当成「不在」
    expect_red "清单读不到当不在" "会话清单读不到·判活为不知道" '
import sys; p=sys.argv[1]; s=open(p).read()
old="""    rm -f "$err"
    return 2
}"""
assert old in s
s=s.replace(old, "    rm -f \x22$err\x22\n    return 1\n}", 1)
open(p,"w").write(s)' issue log_fault_scenario
fi

echo
mutation_summary "$0"
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
