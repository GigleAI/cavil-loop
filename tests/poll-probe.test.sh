#!/usr/bin/env bash
# kind: e2e
# 空闲时的轻量检查（GitHub#252）：退避判定「本轮跳过」时先用一次条件请求问 GitHub
# 「仓库最近更新的那一条变了没有」，没变（304）照旧跳过、变了提前完整跑一轮；开着时
# 完整检查的最长间隔封顶 POLL_IDLE_PROBE_MAX_SECS（默认 600 秒）。
#
# 跑法：bash tests/poll-probe.test.sh          （本机空闲时约 40 秒，负载高时 3 分钟以上：真的把 agent-poll.sh 起几百次）
#       MUTATION=1 bash tests/poll-probe.test.sh  另跑 6 份故意改坏的副本，每份必须变红（约 8 分钟）
# 依赖：jq、git、python3。不碰网络、不碰真 tmux session，HOME 指向临时目录。
#
# 两个方向都不报错，所以每条都要能分出对错实现：
#   · 说不准当成「没变化」→ 空闲项目接活又回到最长等封顶 / 心跳，没有任何报错；
#   · 检查本身变成每 tick 一次完整轮询，或者有活时也去问 → 省了等于没省。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# shellcheck source=lib/mutation.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/mutation.sh"
# shellcheck source=lib/compat.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/compat.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
unset POLL_FAKE_NOW POLL_IDLE_PROBE POLL_IDLE_PROBE_MAX_SECS POLL_BACKOFF_LADDER POLL_FORCE_SYNC_SECS \
      MAX_CONCURRENT_WORKERS GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN LABEL_AUTOPILOT LABEL_PENDING_BLOCKED

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
STATE="$SANDBOX/state"
mkdir -p "$STATE" "$SANDBOX/project" "$SANDBOX/wt" "$SANDBOX/bin" "$SANDBOX/home"
CONF="$SANDBOX/cavil-loop.config"
cat > "$CONF" <<CONF
REPO="example/pace"
PROJECT_ROOT="$SANDBOX/project"
WORKTREE_BASE="$SANDBOX/wt"
STATE_DIR="$STATE"
TMUX_PREFIX="probetest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
POST_MERGE_RETROSPECTIVE=false
CONF

# ── 假 gh：可执行文件（agent-poll.sh 是子进程，看不到本文件的 function）──
# 每次调用记进 GH_COUNT；轻量检查另记进 PROBE_COUNT，带着它发出去的 If-None-Match。
# 轻量检查的回应照真 gh 实测的形状：-i 把状态行和响应头写在 stdout；304 时 gh 以 1 退出，
# 响应头里的 ETag 去掉了 W/ 前缀；200 时以 0 退出。
GH_COUNT="$SANDBOX/gh.count"; PROBE_COUNT="$SANDBOX/probe.count"
SNAP_ISSUES="$SANDBOX/issues.json"; SNAP_PULLS="$SANDBOX/pulls.json"
GH_FAIL="$SANDBOX/gh.fail"            # 存在 = 快照读取失败（整轮读不到 GitHub）
SERVER_ETAG="$SANDBOX/server.etag"    # GitHub 那边「最近更新的那一条」当前的版本标记
PROBE_MODE="$SANDBOX/probe.mode"      # 空 / fail（无输出退出 1）/ 502（回一个别的状态码）
cat > "$SANDBOX/bin/gh" <<'GHEOF'
#!/usr/bin/env bash
echo "$*" >> "$GH_COUNT"
if [ "${1:-}" = api ] && [ "${2:-}" = -i ] && [[ "$*" == *"repos/example/pace/issues"*"state=all"* ]]; then
    inm=""; prev=""
    for a in "$@"; do
        if [ "$prev" = -H ]; then inm="${a#If-None-Match: }"; fi
        prev="$a"
    done
    echo "inm=[$inm]" >> "$PROBE_COUNT"
    mode=$(cat "$PROBE_MODE" 2>/dev/null || true)
    case "$mode" in
        fail) echo "connect: network unreachable" >&2; exit 1 ;;
        502)  printf 'HTTP/2.0 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'; exit 1 ;;
    esac
    cur=$(cat "$SERVER_ETAG")
    if [ -n "$inm" ] && [ "$inm" = "$cur" ]; then
        printf 'HTTP/2.0 304 Not Modified\r\nEtag: %s\r\n\r\n' "${cur#W/}"; echo "gh: HTTP 304" >&2; exit 1
    fi
    printf 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nEtag: %s\r\n\r\n[{"number":1}]' "$cur"; exit 0
fi
case "$*" in
    *"repos/example/pace/issues"*)
        [ -f "$GH_FAIL" ] && { echo "403 suspended" >&2; exit 1; }
        cat "$SNAP_ISSUES"; exit 0 ;;
    *"repos/example/pace/pulls"*)
        [ -f "$GH_FAIL" ] && { echo "403 suspended" >&2; exit 1; }
        cat "$SNAP_PULLS"; exit 0 ;;
    *"pr list"*--json\ number\ --jq*) echo '[]'; exit 0 ;;
    *"pr list"*|*"issue list"*) exit 0 ;;
esac
exit 0
GHEOF
chmod +x "$SANDBOX/bin/gh"
export GH_COUNT PROBE_COUNT SNAP_ISSUES SNAP_PULLS GH_FAIL SERVER_ETAG PROBE_MODE
export HOME="$SANDBOX/home" PATH="$SANDBOX/bin:$PATH" CODING_AGENT_CONFIG="$CONF"

pass=0; fail=0
QUIET=${QUIET:-0}
chk() {
    if [ "$2" = "$3" ]; then [ "$QUIET" = 1 ] || echo "  ✅ $1"; pass=$((pass + 1))
    else [ "$QUIET" = 1 ] || echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail + 1)); fi
}
say() { [ "$QUIET" = 1 ] || echo "$@"; }

DAY=86400
T0=1700000000
PACE="$STATE/poll-pace.json"
ETAG_FILE="$STATE/poll-probe.etag"
LOGF="$STATE/poll.log"

polls()  { grep -c 'poll start' "$LOGF" 2>/dev/null || echo 0; }
probes() { [ -f "$PROBE_COUNT" ] && wc -l < "$PROBE_COUNT" | tr -d ' ' || echo 0; }
# run_ticks <scripts 根> <起> <止> → 这段里真跑了几轮（每 60 秒一个 tick）
run_ticks() {
    local root="$1" t="$2" end="$3" before
    before=$(polls)
    while [ "$t" -le "$end" ]; do
        POLL_FAKE_NOW="$t" bash "$root/scripts/agent-poll.sh" >/dev/null 2>&1
        t=$((t + 60))
    done
    echo $(( $(polls) - before ))
}
reset_state() {
    rm -rf "$STATE"; mkdir -p "$STATE"
    : > "$GH_COUNT"; : > "$PROBE_COUNT"; rm -f "$GH_FAIL" "$PROBE_MODE"
    printf '%s\n' '[[]]' > "$SNAP_ISSUES"; printf '%s\n' '[[]]' > "$SNAP_PULLS"
    printf '%s\n' 'W/"v1"' > "$SERVER_ETAG"
}
# 把项目带进「安静 8 天」且检查标记已转正的状态，返回之后的下一个 tick 时刻。
#   T0 跑一轮；S 到点再跑一轮（S 起完整检查间隔是封顶值）；S+60 第一次检查——还没有标记 →
#   回 200 → 提前跑一轮并把标记转正。之后同一个标记就该回 304。
quiet_8d() {
    local root="$1" S=$((T0 + 8 * DAY))
    run_ticks "$root" "$T0" "$T0" >/dev/null
    run_ticks "$root" "$S" $((S + 60)) >/dev/null
    echo $((S + 120))
}

scenarios() {   # <scripts 根>
    local R="$1" S N p0 la

    say "【1】没在退避（项目刚有动静）→ 一次都不问，每 tick 照跑"
    reset_state; export POLL_IDLE_PROBE=true
    chk "头 30 分钟每 tick 都跑" "$(run_ticks "$R" $T0 $((T0 + 1740)))" "30"
    chk "轻量检查一次都没发" "$(probes)" "0"

    say "【2】安静 8 天、仓库没变 → 每分钟问一次（304），完整检查每 10 分钟一轮"
    reset_state
    N=$(quiet_8d "$R")
    chk "第一次检查没有标记 → 提前跑了一轮，标记已转正" "$(cat "$ETAG_FILE" 2>/dev/null)" 'W/"v1"'
    : > "$PROBE_COUNT"
    chk "之后 30 个 tick 只真跑 3 轮（600 秒封顶）" "$(run_ticks "$R" "$N" $((N + 1740)))" "3"
    chk "其余 27 个 tick 各问了一次" "$(probes)" "27"
    chk "问的时候带着已转正的标记" "$(sort -u "$PROBE_COUNT")" 'inm=[W/"v1"]'
    chk "跳过的那行写明检查结果" "$(grep -c '轻量检查：无变化' "$LOGF")" "27"
    chk "下一档写的是 600 秒" "$(jq -r '.next_due - .last_poll' "$PACE")" "600"

    say "【3】安静 8 天后有人打 pending/agent → 下一个 tick 就跑到派工那一步"
    N=$((N + 1800))
    export MAX_CONCURRENT_WORKERS=0      # 进得了队列、派不出去：只看「这一轮有没有跑到派工」
    printf '%s\n' 'W/"v2"' > "$SERVER_ETAG"
    printf '%s\n' '[[{"number":8,"updated_at":"2026-02-02T00:00:00Z","title":"todo","labels":[{"name":"pending/agent"}]}]]' > "$SNAP_ISSUES"
    chk "改动后的第一个 tick 就真跑" "$(run_ticks "$R" "$N" "$N")" "1"
    chk "日志写明是检查叫醒的" "$(grep -c '轻量检查：仓库有变化 → 提前跑一轮' "$LOGF")" "1"
    chk "这一轮跑到了派工（并发 0，排队）" "$(grep -c 'issue #8 排队' "$LOGF")" "1"
    chk "安静计时归零" "$(jq -r --argjson n "$N" '.last_active == $n' "$PACE")" "true"
    chk "新标记已转正" "$(cat "$ETAG_FILE")" 'W/"v2"'
    unset MAX_CONCURRENT_WORKERS

    say "【4】别处变了、但本机关心的条目没变 → 跑一轮，不算活动"
    reset_state
    N=$(quiet_8d "$R"); la=$(jq -r '.last_active' "$PACE")
    printf '%s\n' 'W/"v3"' > "$SERVER_ETAG"
    chk "被叫醒跑了一轮" "$(run_ticks "$R" "$N" "$N")" "1"
    chk "安静计时没被清零" "$(jq -r '.last_active' "$PACE")" "$la"
    chk "下一个 tick 回 304 → 跳过" "$(run_ticks "$R" $((N + 60)) $((N + 60)))" "0"

    say "【5】说不准一律当「变了」：读不到、回了别的状态码、标记文件坏了"
    reset_state; N=$(quiet_8d "$R")
    echo fail > "$PROBE_MODE"
    chk "检查读不到 GitHub → 3 个 tick 都真跑" "$(run_ticks "$R" "$N" $((N + 120)))" "3"
    chk "日志写明原因" "$(grep -c '轻量检查：读不到 GitHub' "$LOGF")" "3"
    reset_state; N=$(quiet_8d "$R")
    echo 502 > "$PROBE_MODE"
    chk "回 502 → 真跑" "$(run_ticks "$R" "$N" "$N")" "1"
    chk "日志写明状态码" "$(grep -c '轻量检查：GitHub 回了 HTTP 502' "$LOGF")" "1"
    reset_state; N=$(quiet_8d "$R")
    printf 'W/"v1"\r\nInjected: x\n' > "$ETAG_FILE"
    : > "$PROBE_COUNT"
    chk "标记文件坏了 → 真跑" "$(run_ticks "$R" "$N" "$N")" "1"
    chk "坏标记不进请求头（这次没带 If-None-Match）" "$(cat "$PROBE_COUNT")" "inm=[]"
    chk "跑完换成服务端给的标记" "$(cat "$ETAG_FILE")" 'W/"v1"'

    say "【6】检查回 200、这一轮却没读完 GitHub → 新标记作废，变化不会被吞掉"
    reset_state; N=$(quiet_8d "$R")
    printf '%s\n' 'W/"v4"' > "$SERVER_ETAG"
    touch "$GH_FAIL"
    run_ticks "$R" "$N" "$N" >/dev/null
    chk "这一轮按读取失败记账" "$(jq -r '.fail_streak' "$PACE")" "1"
    chk "已转正的还是旧标记" "$(cat "$ETAG_FILE")" 'W/"v1"'
    chk "没留下待转正的新标记" "$([ -e "$ETAG_FILE.pending" ] && echo yes || echo no)" "no"
    run_ticks "$R" $((N + 60)) $((N + 60)) >/dev/null      # 到点重试，再失败 → 下一次等 120 秒
    p0=$(probes)
    chk "故障退避中跳过的 tick" "$(run_ticks "$R" $((N + 120)) $((N + 120)))" "0"
    chk "故障退避期间不发检查" "$(probes)" "$p0"
    rm -f "$GH_FAIL"
    run_ticks "$R" $((N + 180)) $((N + 180)) >/dev/null    # 到点、读通，回到空闲退避
    chk "恢复后失败计数清零" "$(jq -r '.fail_streak' "$PACE")" "0"
    chk "恢复后下一个 tick：检查仍对照旧标记 → 看到变化 → 真跑" "$(run_ticks "$R" $((N + 240)) $((N + 240)))" "1"
    chk "这次才转正新标记" "$(cat "$ETAG_FILE")" 'W/"v4"'

    say "【7】封顶值写错 → 一行警告、不封顶（按原阶梯 30 分钟），检查照常"
    reset_state; export POLL_IDLE_PROBE_MAX_SECS=abc
    N=$(quiet_8d "$R")
    : > "$PROBE_COUNT"
    chk "30 个 tick 只真跑 1 轮（原阶梯）" "$(run_ticks "$R" "$N" $((N + 1740)))" "1"
    chk "检查照常发" "$(probes)" "29"
    chk "日志有警告" "$([ "$(grep -c "POLL_IDLE_PROBE_MAX_SECS='abc'" "$LOGF")" -ge 1 ] && echo yes || echo no)" "yes"
    export POLL_IDLE_PROBE_MAX_SECS=0
    reset_state; N=$(quiet_8d "$R")
    chk "写成 0 也不会变成每 tick 都跑" "$(run_ticks "$R" "$N" $((N + 1740)))" "1"
    unset POLL_IDLE_PROBE_MAX_SECS

    say "【8】关掉（POLL_IDLE_PROBE=false）→ 不问、不封顶，7 天档仍是 30 分钟"
    reset_state; export POLL_IDLE_PROBE=false
    run_ticks "$R" $T0 $T0 >/dev/null
    S=$((T0 + 8 * DAY)); run_ticks "$R" "$S" "$S" >/dev/null
    chk "之后 30 个 tick 只真跑 1 轮" "$(run_ticks "$R" $((S + 60)) $((S + 1800)))" "1"
    chk "一次都没问" "$(probes)" "0"
    chk "不留标记文件" "$(ls "$STATE" | grep -c poll-probe || true)" "0"
    export POLL_IDLE_PROBE=true
}

say "═══ 当前实现 ═══"
scenarios "$REPO_DIR"

say "【9】关掉时 GitHub 调用和节奏状态与改动前逐字节一致"
MB=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD)
BASE="$SANDBOX/base"; mkdir -p "$BASE"
git -C "$REPO_DIR" archive "$MB" scripts prompts | tar -x -C "$BASE"
off_run() {   # <根> <输出前缀>
    reset_state
    run_ticks "$1" $T0 $((T0 + 300)) >/dev/null
    run_ticks "$1" $((T0 + 8 * DAY)) $((T0 + 8 * DAY + 1800)) >/dev/null
    printf '%s\n' '[[{"number":8,"updated_at":"2026-02-02T00:00:00Z","title":"todo","labels":[{"name":"pending/human"}]}]]' > "$SNAP_ISSUES"
    run_ticks "$1" $((T0 + 8 * DAY + 3600)) $((T0 + 8 * DAY + 3900)) >/dev/null
    cp "$GH_COUNT" "$2.calls"; cp "$PACE" "$2.pace"; ls "$STATE" | grep -v '^poll.log$' > "$2.files"
}
if ! compat_skip "关掉检查 vs 改动前" "$BASE" "$REPO_DIR" scripts; then
    export POLL_IDLE_PROBE=false
    off_run "$BASE" "$SANDBOX/old"
    off_run "$REPO_DIR" "$SANDBOX/new"
    export POLL_IDLE_PROBE=true
    chk "GitHub 调用序列一致（$(wc -l < "$SANDBOX/old.calls" | tr -d ' ') 次）" \
        "$(cmp -s "$SANDBOX/old.calls" "$SANDBOX/new.calls" && echo same || echo diff)" "same"
    chk "节奏状态文件一致" "$(cmp -s "$SANDBOX/old.pace" "$SANDBOX/new.pace" && echo same || echo diff)" "same"
    chk "状态目录里的文件一致" "$(cmp -s "$SANDBOX/old.files" "$SANDBOX/new.files" && echo same || echo diff)" "same"
    chk "调用序列不是空的（真跑了）" "$([ -s "$SANDBOX/new.calls" ] && echo yes || echo no)" "yes"
fi

# ── 负对照：故意改坏一处，上面同一组场景必须变红 ──
echo "【负对照】"
REAL_PASS=$pass; REAL_FAIL=$fail; mut_ran=0; mut_fail=0
mutant() {   # <名字> <python 替换：old> <new>
    local D="$SANDBOX/mut-$1"
    rm -rf "$D"; mkdir -p "$D"; cp -r "$REPO_DIR/scripts" "$D/"; cp -r "$REPO_DIR/prompts" "$D/"
    python3 - "$D/scripts/_lib.sh" "$2" "$3" <<'PY' || return 1
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
if s.count(old) != 1:
    sys.exit("mutation target found %d times" % s.count(old))
open(p, "w").write(s.replace(old, new))
PY
    printf '%s' "$D"
}
try_mutant() {   # <说明> <名字> <old> <new>
    local D
    mutation_gate || return 0
    mut_ran=$((mut_ran + 1))
    if ! D=$(mutant "$2" "$3" "$4"); then
        echo "  ❌ 负对照准备失败：$1（要改的原文找不到）"; mut_fail=$((mut_fail + 1)); return 0
    fi
    pass=0; fail=0; QUIET=1; scenarios "$D"; QUIET=0
    if [ "$fail" -gt 0 ]; then echo "  ✅ 负对照拦下：$1（$fail 条变红）"
    else echo "  ❌ 负对照没拦下：$1（改坏后仍全绿）"; mut_fail=$((mut_fail + 1)); fi
}
try_mutant "读不到 GitHub 当成没变化" read-as-unchanged \
    '        "") PACE_PROBE_REASON="读不到 GitHub"; return 1 ;;' \
    '        "") PACE_PROBE_REASON="读不到 GitHub"; return 0 ;;'
try_mutant "回 200 时新标记直接转正（不等这一轮读完）" commit-early \
    '                pace_probe_etag_write "$PROBE_ETAG_FILE.pending" "$new_etag" || true' \
    '                pace_probe_etag_write "$PROBE_ETAG_FILE" "$new_etag" || true'
try_mutant "故障退避期间也发检查" probe-in-fail-backoff \
    '        PACE_SKIP_MSG="本轮跳过（GitHub 读取连续失败 ${fail_streak} 次，还差 $(pace_human_secs "$remain") 重试）"
        return 1' \
    '        PACE_SKIP_MSG="本轮跳过（GitHub 读取连续失败 ${fail_streak} 次，还差 $(pace_human_secs "$remain") 重试）"
        if pace_probe_on && ! pace_probe; then return 0; fi
        return 1'
try_mutant "开着时不封顶" no-cap \
    '    if [ "$iv" -gt 0 ] && pace_probe_on && pcap=$(pace_probe_cap) && [ "$iv" -gt "$pcap" ]; then iv="$pcap"; fi' \
    ':'
try_mutant "关掉时仍封顶" cap-when-off \
    '    if [ "$iv" -gt 0 ] && pace_probe_on && pcap=$(pace_probe_cap) && [ "$iv" -gt "$pcap" ]; then iv="$pcap"; fi' \
    '    if [ "$iv" -gt 600 ]; then iv=600; fi'
try_mutant "坏标记照样进请求头" etag-unchecked \
    '    if pace_etag_ok "$e"; then printf '"'"'%s'"'"' "$e"; fi' \
    '    printf '"'"'%s'"'"' "$e"'
pass=$REAL_PASS; fail=$REAL_FAIL

echo
compat_summary
mutation_summary "$0"
echo "正式版：$pass 通过 / $fail 失败；负对照失效 $mut_fail 条（本次跑了 $mut_ran 条）"
REPORT_REGRESS_ONLY=1 report_counts "$pass" "$fail" "$mut_ran" "$mut_fail"
[ "$fail" -eq 0 ] && [ "$mut_fail" -eq 0 ]
