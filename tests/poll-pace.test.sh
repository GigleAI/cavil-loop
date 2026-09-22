#!/usr/bin/env bash
# 轮询节奏（退避闸门）的守卫 —— issue #35。
#
# 跑法：bash tests/poll-pace.test.sh
# 依赖：jq。不碰网络、不碰真 tmux session（TMUX_PREFIX 用独有前缀）、HOME 指向 temp。
#
# 为什么必须有这个文件：这层闸门决定「这一轮跑不跑」，**错了的两个方向都不报错**：
#   · 退得太狠 / 状态坏了不跑 → 某个项目静默停摆，日志上看不出异常；
#   · 退得不够 / 该省没省     → 改了等于没改，而且没有任何失败信号。
# 所以每条断言都要能分辨「有这个实现」和「没有这个实现」，光断言「正确输入 → 正确
# 输出」是不够的（AGENTS.md 那条规矩）。负对照在文件末尾说明怎么跑。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

SANDBOX=$(mktemp -d)
TMP_CONF="$SANDBOX/coding-agent.config"
mkdir -p "$SANDBOX/state" "$SANDBOX/project" "$SANDBOX/wt" "$SANDBOX/bin" "$SANDBOX/home"

cat > "$TMP_CONF" <<CONF
REPO="example/pace"
PROJECT_ROOT="$SANDBOX/project"
WORKTREE_BASE="$SANDBOX/wt"
STATE_DIR="$SANDBOX/state"
TMUX_PREFIX="pacetest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
POST_MERGE_RETROSPECTIVE=false
CONF

# ── 假 gh：可执行文件而不是 shell function ──
# agent-poll.sh 是**子进程**，看不到本文件里定义的 function。每次调用往 gh.count 追
# 一行，这样「本轮到底打了几次 GitHub」是数出来的而不是推出来的。
GH_COUNT="$SANDBOX/gh.count"
SNAP_ISSUES="$SANDBOX/issues.json"
SNAP_PULLS="$SANDBOX/pulls.json"
GH_FAIL="$SANDBOX/gh.fail"       # 文件存在 = 快照读取一律失败（模拟 403 / 断网）
cat > "$SANDBOX/bin/gh" <<'GHEOF'
#!/usr/bin/env bash
echo "$*" >> "$GH_COUNT"
case "$*" in
    *"/issues"*state=open*|*"/issues "*|*"repos/example/pace/issues"*)
        [ -f "$GH_FAIL" ] && { echo "403 suspended" >&2; exit 1; }
        cat "$SNAP_ISSUES"; exit 0 ;;
esac
case "$*" in
    *"repos/example/pace/pulls"*)
        [ -f "$GH_FAIL" ] && { echo "403 suspended" >&2; exit 1; }
        cat "$SNAP_PULLS"; exit 0 ;;
    *"pr list"*--json\ number\ --jq*) echo '[]'; exit 0 ;;
    *"pr list"*|*"issue list"*) exit 0 ;;
esac
exit 0
GHEOF
chmod +x "$SANDBOX/bin/gh"
export GH_COUNT SNAP_ISSUES SNAP_PULLS GH_FAIL
export HOME="$SANDBOX/home"
export PATH="$SANDBOX/bin:$PATH"
export CODING_AGENT_CONFIG="$TMP_CONF"

printf '%s\n' '[[]]' > "$SNAP_ISSUES"
printf '%s\n' '[[]]' > "$SNAP_PULLS"

# ⚠️ 同 open-snapshot / reap 测试：_lib.sh 顶部的 `exec 9>&- 2>/dev/null` 会永久吞掉
# 调用方 stderr，source 前后自己倒一手 fd 2，否则这个测试挂了会「无输出 + exit 1」。
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e

cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

DAY=86400
PACE="$SANDBOX/state/poll-pace.json"
write_pace() {   # next_due last_poll last_active fail_streak fingerprint
    jq -n --argjson nd "$1" --argjson lp "$2" --argjson la "$3" --argjson fs "$4" --arg fp "$5" \
        '{next_due:$nd,last_poll:$lp,last_active:$la,fail_streak:$fs,fingerprint:$fp}' > "$PACE"
}
gate() {  # now → "run" / "skip"
    POLL_FAKE_NOW="$1" pace_should_poll >/dev/null 2>&1 && echo run || echo skip
}

echo "【1】阶梯按「安静了多久」分档（用户拍板的 1 天 / 3 天 / 7 天 → 5 / 10 / 30 分钟）"
# 0 = 完全不设闸（每个 tick 都跑）。**不能**是 POLL_INTERVAL_SECS —— 那等于给脚本加了
# 一条速度下限，会把 timer 跑 30 秒的实例悄悄拉回 60 秒。
chk "安静 12 小时 → 不退避（返回 0）"  "$(pace_interval_for_quiet $((DAY / 2)))" "0"
chk "安静 1 天整 → 5 分钟"   "$(pace_interval_for_quiet $DAY)"         "300"
chk "安静 2 天 → 5 分钟"     "$(pace_interval_for_quiet $((2 * DAY)))" "300"
chk "安静 3 天整 → 10 分钟"  "$(pace_interval_for_quiet $((3 * DAY)))" "600"
chk "安静 5 天 → 10 分钟"    "$(pace_interval_for_quiet $((5 * DAY)))" "600"
chk "安静 7 天整 → 30 分钟"  "$(pace_interval_for_quiet $((7 * DAY)))" "1800"
chk "安静 30 天 → 仍是 30 分钟（有上限）" "$(pace_interval_for_quiet $((30 * DAY)))" "1800"

echo "【1c】不退避档必须是「不设闸」而不是「最快 60 秒一次」"
# 这条是 2026-09-22 的真实回归：第一版返回 POLL_INTERVAL_SECS，于是 tick 比它快的实例
# （tutor 的 drop-in 是 30 秒）被悄悄拉回 60 秒，而且 tests/dispatch-backoff.test.sh 的
# 端到端那组当场红了——连着四轮只派出去一次。
_save_interval="$POLL_INTERVAL_SECS"
POLL_INTERVAL_SECS=30
chk "tick 30 秒的实例不会被拉回 60 秒" "$(pace_interval_for_quiet 3600)" "0"
POLL_INTERVAL_SECS="$_save_interval"

echo "【1b】阶梯写乱序也要取对档 —— 靠「门槛最大的那档」而不是「最后一个跨过的」"
_save_ladder="$POLL_BACKOFF_LADDER"
POLL_BACKOFF_LADDER="604800:1800,86400:300,259200:600"
chk "倒序书写：安静 5 天仍取 10 分钟" "$(pace_interval_for_quiet $((5 * DAY)))" "600"
POLL_BACKOFF_LADDER="86400:300,zzz:600,259200:oops,604800:1800"
chk "一个档位写歪不影响其它档（5 天）"  "$(pace_interval_for_quiet $((5 * DAY)) 2>/dev/null)" "300"
chk "一个档位写歪不影响其它档（8 天）"  "$(pace_interval_for_quiet $((8 * DAY)) 2>/dev/null)" "1800"
POLL_BACKOFF_LADDER="$_save_ladder"

echo "【2】读不到 GitHub 时是另一套阶梯（1→2→4→8→16→30 分钟封顶）"
chk "第 1 次失败"  "$(pace_fail_interval 1)" "60"
chk "第 2 次"      "$(pace_fail_interval 2)" "120"
chk "第 3 次"      "$(pace_fail_interval 3)" "240"
chk "第 4 次"      "$(pace_fail_interval 4)" "480"
chk "第 5 次"      "$(pace_fail_interval 5)" "960"
chk "第 6 次封顶"  "$(pace_fail_interval 6)" "1800"
chk "第 99 次仍封顶（翻倍循环不失控）" "$(pace_fail_interval 99)" "1800"

echo "【3】闸门：没到点跳过、到点就跑（含 timer 抖动余量）"
write_pace 1000300 1000000 1000000 0 fp
chk "早 120 秒 → 跳过"          "$(gate 1000180)" "skip"
chk "差 5 秒（在抖动余量内）→ 跑" "$(gate 1000295)" "run"
chk "正好到点 → 跑"              "$(gate 1000300)" "run"

echo "【4】坏状态四连 —— 每一种都必须「下一个 tick 就跑」，绝不能静默卡死"
write_pace $((1000000 + 365 * DAY)) 1000000 1000000 0 fp
chk "① next_due 写成一年后"      "$(gate 1000060)" "run"
echo 'not json at all' > "$PACE"
chk "② 状态文件是垃圾"            "$(gate 1000060)" "run"
write_pace 1000300 1000000 1000000 0 fp
rm -f "$PACE"
chk "③ 状态文件被删"              "$(gate 1000060)" "run"
write_pace 1000300 1000000 1000000 0 fp
chk "④ 时钟往回拨一小时"          "$(gate 996400)"  "run"
# 负对照的靶子：没有「夹紧」那几行时，①④ 会变成 skip

echo "【5】心跳：距上次真跑满 30 分钟就无条件跑（哪怕 next_due 还早）"
# next_due 故意放在「还没到点、但也没远到触发夹紧」的那条缝里 —— 只有心跳能救它。
#
# ⚠️ 这个状态在正常运行下写不出来（默认阶梯最慢一档就等于心跳值），而这正是心跳存在的
# 意义：它兜的是**本地状态已经不对、却又没不对到被夹紧发现**的那一类。测试必须构造这
# 条缝，否则断言会被普通的「到点了」判断顺手放行 —— 那样摘掉心跳测试照样全绿（实测）。
write_pace $((1000000 + 3000)) 1000000 1000000 0 fp
chk "等了 1500 秒（不到心跳，也没到 next_due）→ 跳过" "$(gate 1001500)" "skip"
chk "等满 1800 秒（心跳到点，next_due 还早 1200 秒）→ 跑" "$(gate 1001800)" "run"

echo "【5b】心跳不覆盖「读不到 GitHub」那套退避（否则故障退避形同虚设）"
_save_fail_max="$POLL_FAIL_BACKOFF_MAX_SECS"
POLL_FAIL_BACKOFF_MAX_SECS=7200
write_pace $((1000000 + 7200)) 1000000 1000000 5 fp
chk "故障中等了 3600 秒（过了心跳）→ 仍跳过" "$(gate 1003600)" "skip"
chk "故障中等满 7200 秒 → 跑"                "$(gate 1007200)" "run"
POLL_FAIL_BACKOFF_MAX_SECS="$_save_fail_max"

echo "【6】关掉开关 = 行为完全回到改动前"
_save_ladder="$POLL_BACKOFF_LADDER"
POLL_BACKOFF_LADDER=""
write_pace $((1000000 + 365 * DAY)) 1000000 1000000 0 fp
chk "阶梯留空时任何状态都照跑" "$(gate 1000001)" "run"
POLL_BACKOFF_LADDER="$_save_ladder"

# ──────────────────────────────────────────────────────────────────────────
# 端到端：真的跑 agent-poll.sh，数它打了几次 GitHub
# ──────────────────────────────────────────────────────────────────────────
POLL="$REPO_DIR/scripts/agent-poll.sh"
run_ticks() {   # 起始epoch 结束epoch [tick秒] → 打印这段里「真跑」了几轮
    local t="$1" end="$2" step="${3:-60}" before after
    before=$(grep -c 'poll start' "$SANDBOX/state/poll.log" 2>/dev/null || echo 0)
    while [ "$t" -le "$end" ]; do
        POLL_FAKE_NOW="$t" bash "$POLL" >/dev/null 2>&1
        t=$((t + step))
    done
    after=$(grep -c 'poll start' "$SANDBOX/state/poll.log" 2>/dev/null || echo 0)
    echo $((after - before))
}
reset_e2e() {
    rm -rf "$SANDBOX/state"; mkdir -p "$SANDBOX/state"
    : > "$GH_COUNT"; rm -f "$GH_FAIL"
    printf '%s\n' '[[]]' > "$SNAP_ISSUES"
    printf '%s\n' '[[]]' > "$SNAP_PULLS"
}
T0=1700000000

echo "【7】端到端：仓库一直不变时，安静到哪一档就按哪一档跑"
reset_e2e
# 先把时间推过 1 天，让安静计时真的累积起来（这段本身还是每 tick 跑，因为不到第一档）
chk "头 1 小时（刚开始，不退避）→ 每 tick 都跑" "$(run_ticks $T0 $((T0 + 3540)))" "60"
# 跳到「安静满 1 天」之后的一小时：5 分钟一轮 → 3600/300 = 12 轮
S1=$((T0 + DAY + 3600))
chk "安静满 1 天后的一小时 → 12 轮（5 分钟档）" "$(run_ticks $S1 $((S1 + 3540)))" "12"
S3=$((T0 + 3 * DAY + 3600))
chk "安静满 3 天后的一小时 → 6 轮（10 分钟档）"  "$(run_ticks $S3 $((S3 + 3540)))" "6"
S7=$((T0 + 7 * DAY + 3600))
chk "安静满 7 天后的一小时 → 2 轮（30 分钟档）"  "$(run_ticks $S7 $((S7 + 3540)))" "2"

echo "【8】端到端：一有动静立刻回到不退避，不用等一个完整周期"
# 承接上面：此时已退到 30 分钟档。改一条 updated_at = 仓库有变化。
S8=$((S7 + 7200))
printf '%s\n' '[[{"number":7,"updated_at":"2026-02-02T00:00:00Z","title":"poked","labels":[{"name":"pending/human"}]}]]' > "$SNAP_ISSUES"
chk "变化后的第一个 tick 就跑"   "$(run_ticks $S8 $S8)" "1"
chk "安静计时已归零"             "$(jq -r --argjson n "$S8" '.last_active == $n' "$PACE")" "true"
chk "下一轮回到不退避（next_due 就是现在）"  "$(jq -r --argjson n "$S8" '.next_due - $n' "$PACE")" "0"
chk "紧接着的一小时 → 每 tick 都跑" "$(run_ticks $((S8 + 60)) $((S8 + 3600)))" "60"

echo "【9】读不到 GitHub 不算「安静」—— 安静计时必须冻结，而不是继续累加"
reset_e2e
run_ticks $T0 $T0 >/dev/null                      # 建一次正常状态
LA_BEFORE=$(jq -r '.last_active' "$PACE")
touch "$GH_FAIL"
run_ticks $((T0 + 60)) $((T0 + 120)) >/dev/null    # 两轮失败
chk "失败不动 last_active（不是 $((T0+120))）" "$(jq -r '.last_active' "$PACE")" "$LA_BEFORE"
chk "失败计数起来了"                            "$(jq -r '.fail_streak >= 1' "$PACE")" "true"
chk "下一轮按故障节奏等（不是 60 秒的空闲档）"  "$(jq -r '.next_due - .last_poll >= 60' "$PACE")" "true"
rm -f "$GH_FAIL"
run_ticks $((T0 + 3000)) $((T0 + 3000)) >/dev/null
chk "恢复一次就把失败计数清零"                  "$(jq -r '.fail_streak' "$PACE")" "0"

echo "【10a】GitHub 上挂着 doing/agent 时不退避"
reset_e2e
printf '%s\n' '[[{"number":9,"updated_at":"2026-03-03T00:00:00Z","title":"busy","labels":[{"name":"doing/agent"}]}]]' > "$SNAP_ISSUES"
run_ticks $T0 $T0 >/dev/null
B1=$((T0 + 10 * DAY))    # 快照十天不变，但一直挂着 doing/agent
chk "十天没变化但有 doing/agent → 仍每 tick 跑" "$(run_ticks $B1 $((B1 + 3540)))" "60"
# 注：这一条同时被 self-heal 的 pace_mark_acted 和 active_keys 两条路径保证（本例里
# session 不存在，self-heal 会先命中）。所以它验的是**行为**，不能用来隔离某一行代码——
# 10b / 10c 才是那两条信号各自的靶子。

echo "【10b】队列里有活在等（并发满、这轮派不出去）也不算安静"
# 隔离 QUEUE_SORTED 那条信号：把并发上限压成 0，于是条目进得了队列但绝对派不出去。
# 没有 doing/agent → 不触发 self-heal，PACE_ACTED 全程是 0；快照十天不变 → 指纹恒定。
# 此时唯一能让它不退避的就是「队列非空」这一条。
reset_e2e
printf '%s\n' '[[{"number":8,"updated_at":"2026-03-03T00:00:00Z","title":"queued","labels":[{"name":"pending/agent"}]}]]' > "$SNAP_ISSUES"
export MAX_CONCURRENT_WORKERS=0
run_ticks $T0 $T0 >/dev/null
B2=$((T0 + 10 * DAY))
chk "十天没变化但队列里一直有活 → 仍每 tick 跑" "$(run_ticks $B2 $((B2 + 3540)))" "60"
unset MAX_CONCURRENT_WORKERS

echo "【10c】本机还有 worker session 活着（标签已经翻走了）也不算安静"
# 隔离 list_worker_sessions 那条信号：worker 翻完 label 到收尾完成之间有一段窗口，
# GitHub 上已经没有 doing/agent、队列也空，但进程还在、还等着被回收。这段时间退避的话，
# 回收就被拖慢，内存一直占着（issue #745 那个病根）。
if command -v tmux >/dev/null 2>&1; then
    reset_e2e
    printf '%s\n' '[[]]' > "$SNAP_ISSUES"
    tmux new-session -d -s pacetest-issue42 'sleep 3000' 2>/dev/null
    run_ticks $T0 $T0 >/dev/null
    B3=$((T0 + 10 * DAY))
    chk "十天没变化但本机 session 还活着 → 仍每 tick 跑" "$(run_ticks $B3 $((B3 + 3540)))" "60"
    tmux kill-session -t '=pacetest-issue42' 2>/dev/null
else
    echo "  ⏭  跳过（本机没有 tmux）"
fi

echo "【11】关掉开关时，一小时的 gh 调用次数与改动前一致"
reset_e2e
# ⚠️ 必须 export：run_ticks 里跑的是**子进程** agent-poll.sh，`VAR=x run_ticks` 那种
# 函数前缀赋值靠不住（本文件 2026-09-22 初版就是这么写的，结果「关掉开关」那一组其实
# 测的还是开着的行为）。
export POLL_BACKOFF_LADDER=""
run_ticks $T0 $((T0 + 3540)) >/dev/null
OFF_CALLS=$(wc -l < "$GH_COUNT" | tr -d ' ')
OFF_POLLS=$(grep -c 'poll start' "$SANDBOX/state/poll.log")
unset POLL_BACKOFF_LADDER
chk "关掉后 60 个 tick 全都真跑"       "$OFF_POLLS" "60"
chk "关掉后不留下节奏状态文件"          "$([ -e "$PACE" ] && echo yes || echo no)" "no"
reset_e2e
# 同一段时间、同样的输入，但阶梯开着且已经安静 8 天 → 调用必须显著更少
C0=$((T0 + 8 * DAY))
run_ticks $T0 $T0 >/dev/null
: > "$GH_COUNT"
run_ticks $C0 $((C0 + 3540)) >/dev/null
ON_CALLS=$(wc -l < "$GH_COUNT" | tr -d ' ')
chk "开着（安静 8 天）调用数降到 1/10 以下" \
    "$([ "$ON_CALLS" -le $((OFF_CALLS / 10)) ] && echo yes || echo no)" "yes"

echo
echo "通过 $pass / 失败 $fail"
# ── 负对照怎么跑 ──
#   · 删掉 agent-poll.sh 里 `if ! pace_should_poll; then ... fi` 整段  → 【7】【11】变红
#   · 删掉 _lib.sh:pace_should_poll 里「夹紧 / 时钟往回跳」两行 if     → 【4】①④ 变红
#   · pace_record_fail 里把 last_active 改成无条件 =now（故障当空闲）  → 【9】变红
#   · 删掉 pace_should_poll 里的心跳那段 if                            → 【5】第二条变红
#   · 心跳去掉 `fail_streak -eq 0` 这个前提（心跳压过故障退避）        → 【5b】第一条变红
#   · 删掉 agent-poll.sh 结尾的 `QUEUE_SORTED` 那行                    → 【10b】变红
#   · 删掉结尾的 `list_worker_sessions` 那行                           → 【10c】变红
# 全绿说明测试没测到点子上 —— 本文件 2026-09-22 就因为【5】写歪而漏掉过一次心跳负对照。
[ "$fail" -eq 0 ]
