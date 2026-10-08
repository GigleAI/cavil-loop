#!/usr/bin/env bash
# `reap_finished_workers` / `kill_session_procs` 的行为守卫。
#
# 跑法：bash tests/reap-finished-workers.test.sh
# 依赖：tmux。不碰网络、不调 gh、不读任何真实项目的 config——自造临时 config +
# 自造 TMUX_PREFIX 沙盘，所以在有真 worker 在跑的机器上跑也是安全的。
#
# 为什么要有这个文件：回收逻辑一旦写错，错的方向有两个，且**都不会报错**——
#   · 收多了 → 把正在收尾的 worker 打断，或者顺手收掉人在用的 dev server；
#   · 收少了 → 回到 issue #745 现场那种「session 堆到 13 个、load 28」的状态。
# 两种都只能靠断言真实 tmux 行为拦住，读代码看不出来。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

TMP_CONF=$(mktemp -d)/coding-agent.config
SANDBOX="$(dirname "$TMP_CONF")"
cat > "$TMP_CONF" <<CONF
REPO="example/none"
PROJECT_ROOT="$SANDBOX/project"
WORKTREE_BASE="$SANDBOX/wt"
STATE_DIR="$SANDBOX/state"
TMUX_PREFIX="reaptest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
CONF
mkdir -p "$SANDBOX/state" "$SANDBOX/project" "$SANDBOX/wt"

export CODING_AGENT_CONFIG="$TMP_CONF"
# ⚠️ _lib.sh 顶部是 `set -euo pipefail` + `exec 9>&- 2>/dev/null`——后者 exec 不带命令，
# 那个 2>/dev/null 会**永久**吞掉调用方之后所有的 stderr。所以 source 之前先把 fd 2
# 存进 fd 8，source 之后再还回来，否则这个测试挂了会「无输出 + exit 1」，没法查。
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
# source 顺带把 -e 带了进来；测试要自己收集失败再汇总，这里关掉。
set +e

cleanup() {
    for s in $(tmux ls 2>/dev/null | awk -F: '$1 ~ /^reaptest-/ {print $1}'); do
        tmux kill-session -t "=$s" 2>/dev/null || true
    done
    rm -rf "$(dirname "$TMP_CONF")"
}
trap cleanup EXIT
cleanup

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 $3，实得 $2)"; fail=$((fail+1)); fi
}
alive() { tmux has-session -t "=$1" 2>/dev/null && echo yes || echo no; }

# Real list/reaper logic, deterministic GitHub pages (no live API calls).
mkdir -p "$SANDBOX/state"
ISSUE_PAGES='[[]]'
PR_PAGES='[[]]'
GH_FAIL=''
gh() {
    if [ -n "$GH_FAIL" ] && [[ "$*" == *"repos/$REPO/$GH_FAIL"* ]]; then
        echo 'simulated GitHub outage' >&2
        return 1
    fi
    case "$*" in
        *"repos/$REPO/issues"*) printf '%s\n' "$ISSUE_PAGES" ;;
        *"repos/$REPO/pulls"*) printf '%s\n' "$PR_PAGES" ;;
        *) return 1 ;;
    esac
}

# 一轮 poll 只拉一次 open 快照（open_snapshot），缓存落在 $TICK_DIR。本测试在**同一个
# 进程里**改 ISSUE_PAGES / PR_PAGES 来模拟「GitHub 上的世界变了」——那在现实里只会发生
# 在两轮之间，所以每次改完 fixture 都要像 agent-poll.sh 每轮开头那样把快照清掉。
# 不清的话读到的是上一次的世界，断言测的就不是它想测的东西了。
new_tick() { rm -rf "$TICK_DIR"; }

tmux new-session -d -s reaptest-issue901 'sleep 3000'
tmux new-session -d -s reaptest-issue902 'sleep 3000'
tmux new-session -d -s reaptest-issue903-server 'sleep 3000'
tmux new-session -d -s reaptest-issue904 'sleep 3000'
sleep 1

echo "【1】list_worker_sessions 的正则带结尾锚点，dev server 落在外面"
chk "枚举结果" "$(list_worker_sessions | sort | tr '\n' ',')" "reaptest-issue901,reaptest-issue902,reaptest-issue904,"

echo "【2】宽限期内不回收（worker 是先翻 label 再收尾的，别打断）"
declare -A active_keys=([904]=1)
REAP_GRACE_SECS=9999 reap_finished_workers active_keys >/dev/null 2>&1
chk "901 被宽限期挡住" "$(alive reaptest-issue901)" "yes"

echo "【3】过了宽限期 → 只收完工的"
REAP_GRACE_SECS=0 reap_finished_workers active_keys >/dev/null 2>&1
sleep 1
chk "901 已回收"                  "$(alive reaptest-issue901)" "no"
chk "902 已回收"                  "$(alive reaptest-issue902)" "no"
chk "904 保留（仍在 active_keys）" "$(alive reaptest-issue904)" "yes"
chk "903-server 保留（dev server 不归 daemon 管）" "$(alive reaptest-issue903-server)" "yes"

echo "【4】REAP_FINISHED_WORKERS=0 时完全不动手"
tmux new-session -d -s reaptest-issue905 'sleep 3000'; sleep 1
REAP_FINISHED_WORKERS=0 REAP_GRACE_SECS=0 reap_finished_workers active_keys >/dev/null 2>&1
chk "905 仍在" "$(alive reaptest-issue905)" "yes"

echo "【5】pane 进程真的死了——不是只掉了 session"
# issue #745 现场：kill-session 只发 SIGHUP，claude 被 reparent 到 tmux server 下继续
# 活着，10 个 session 杀完内存只掉 170 MB。只断言 has-session 会漏掉这个。
#
# ⚠️ 替身必须**忽略 SIGHUP**。第一版用 `sleep 3000`，而 sleep 是老老实实响应 SIGHUP 的
# ——光 kill-session 就能把它带走，于是把 kill_session_procs 整个删掉这条照样绿，
# 守卫自己是假阴性的。claude 属于不吃 SIGHUP 的那类，这里用 `trap "" HUP` 复现它。
tmux new-session -d -s reaptest-issue906 'trap "" HUP; while :; do sleep 1; done'; sleep 1
ppid=$(tmux list-panes -t '=reaptest-issue906' -F '#{pane_pid}')
REAP_GRACE_SECS=0 reap_finished_workers active_keys >/dev/null 2>&1
# ⚠️ 判「死没死」不能用 `kill -0`：**僵尸进程它也返回成功**。进程已经退出、只是还没被
# tmux server 收尸，本机负载高时这段能拖好几秒——于是这条就偶发红（实测把 CPU 打满，
# 5 次里红 3 次，报「期望 dead，实得 alive」，而 reaper 的日志明明写着已经回收）。
# 这条断言要证明的是 issue #745 那个现场：进程不再占着几百 MB 内存——僵尸恰恰不占，
# 所以状态 Z 一律算死。再配一个盯着**这个具体 pid** 的轮询（最多 15 秒）顶掉信号送达
# 与退出之间的时间差，空闲时几十毫秒就返回，真没死透照样会红。
proc_alive() {
    local st
    st=$(sed -e 's/.*) //' -e 's/ .*//' "/proc/$1/stat" 2>/dev/null) || return 1
    [ -n "$st" ] && [ "$st" != "Z" ]
}
for _ in $(seq 1 150); do proc_alive "$ppid" || break; sleep 0.1; done
chk "pane 进程 $ppid 已退出" "$(proc_alive "$ppid" && echo alive || echo dead)" "dead"

echo "【6】读不到 session_activity 时 fail closed（不回收）"
# `display-message -p -t '=name'`（缺末尾冒号）在 tmux 3.4 返回空串而非报错，
# 空值参与减法 = 「闲置 17 亿秒」= 宽限期静默失效。这条钉住保守方向。
tmux new-session -d -s reaptest-issue907 'sleep 3000'; sleep 1
_orig_tmux=$(command -v tmux)
tmux() { if [ "$1" = "list-sessions" ]; then echo "reaptest-issue907 "; else "$_orig_tmux" "$@"; fi; }
REAP_GRACE_SECS=0 reap_finished_workers active_keys >/dev/null 2>&1
unset -f tmux
chk "907 保留（活动时间读不到就不动）" "$(alive reaptest-issue907)" "yes"

echo "【7】查询失败不能变成空名单，也不能回收 session"
for endpoint in issues pulls; do
    GH_FAIL="$endpoint"
    new_tick
    list_active_workers >/dev/null 2>&1
    chk "$endpoint 查询失败向上传递" "$?" "1"
    REAP_GRACE_SECS=0 reap_finished_workers active_keys >/dev/null 2>&1
    chk "$endpoint 查询失败保留 907" "$(alive reaptest-issue907)" "yes"
done
GH_FAIL=''

echo "【8】缺少归属记录仍保护 PR 对应的本机 session；第二页不能漏"
SELFHEAL_ONLY_OWN_WORKERS=true
SELFHEAL_HOST_ID=testhost
STATE_FILE="$SANDBOX/state/state.json"
printf '{"worker_hosts":{}}' > "$STATE_FILE"
PR_PAGES='[[],[{"number":999,"head":{"ref":"feature/issue-907"},"body":"","labels":[{"name":"doing/agent"}]}]]'
new_tick
chk "并发名单仍按归属过滤" "$(list_active_workers)" ""
REAP_GRACE_SECS=0 reap_finished_workers active_keys >/dev/null 2>&1
chk "907 的 PR 仍 doing，保留" "$(alive reaptest-issue907)" "yes"
PR_PAGES='[[{"number":999,"head":{"ref":"external"},"body":"Refs #907","labels":[{"name":"doing/agent"}]}]]'
REAP_GRACE_SECS=0 reap_finished_workers active_keys >/dev/null 2>&1
chk "PR body 关联也保护 907" "$(alive reaptest-issue907)" "yes"
PR_PAGES='[[]]'
# 注意 labels 不能省：筛 doing/agent 从服务端 query 挪到了本地 jq，stub 以前忽略
# `?labels=` 参数，于是「凡是返回的 issue 都算 doing」。真实 REST 响应一定带 labels 数组。
ISSUE_PAGES='[[],[{"number":907,"labels":[{"name":"doing/agent"}]}]]'
REAP_GRACE_SECS=0 reap_finished_workers active_keys >/dev/null 2>&1
chk "issue 仍 doing，保留" "$(alive reaptest-issue907)" "yes"
ISSUE_PAGES='invalid json'
REAP_GRACE_SECS=0 reap_finished_workers active_keys >/dev/null 2>&1
chk "损坏响应不能授权回收" "$(alive reaptest-issue907)" "yes"
ISSUE_PAGES='[[]]'
REAP_GRACE_SECS=0 reap_finished_workers active_keys >/dev/null 2>&1
chk "确认 issue/PR 都已不 doing 后可回收" "$(alive reaptest-issue907)" "no"

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
