#!/usr/bin/env bash
# kind: e2e
# 轮询运行记录（GitHub#344）：每轮自己写一条记录、出异常自己留快照、被强杀的轮次只在查看时显示。
#
# 跑法：bash tests/poll-runlog.test.sh        （约 1.5 分钟）
# 依赖：bash、jq、python3、git、flock。不碰网络：常驻假 GitHub（tests/lib/fake_github.py）+ 假 tmux /
# 假 claude，HOME 指向临时目录；跑的是真的 scripts/poll-entry.sh、agent-poll.sh、poll-history.sh。
#
# 这个功能「只记不判」，错了不会报错，只会悄悄少记、多记或挡住轮询，所以每一组都要能分出对错：
#   · 否定断言（没有补写、没有超上限、没有令牌）都配一条「这一轮确实跑了」的正向断言
#     （假 GitHub 收到了请求、该派的工派了出去、正式记录多了一条）；
#   · 要卡住某一步时用命名管道 / 测试专用的停顿点（CAVIL_RUNLOG_TEST_*，见 scripts/_runlog.sh），
#     不靠 sleep 碰运气。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# shellcheck source=lib/compat.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/compat.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || { chmod -R u+w "$SANDBOX" 2>/dev/null; rm -rf "$SANDBOX"; }' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TZ=UTC
unset CODING_AGENT_RELEASE_ROOT CODING_AGENT_CONFIG LABEL_AUTOPILOT LABEL_PENDING_BLOCKED GH_TOKEN WRITE_GH_TOKEN \
      GITHUB_TOKEN PROJECT_GH_TOKEN POLL_FAKE_NOW POLL_BACKOFF_LADDER POLL_IDLE_PROBE ENABLE_POLL_RUN_LOG \
      POLL_RUN_LOG_ROUNDS POLL_RUN_LOG_SNAPSHOTS POLL_RUN_LOG_SLOW_SECS POLL_RUN_LOG_INFLIGHT \
      CAVIL_RUNLOG_TEST_KILL_AT CAVIL_RUNLOG_TEST_HOLD CAVIL_RUNLOG_ENTRY_MAX CAVIL_SCHEDULED_POLL
unset DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR
export FAKE_GH_LISTS=1 FAKE_GH_REPO="example/rl"
ENTRY_DIR="$HOME/.local/state/cavil-loop/runlog/entry"

# 假 gh：真正干活的是常驻假 GitHub（装在 gh.real）。前面套一层只管轻量检查（`gh api -i`）：
# 按 $FAKE_PROBE_MODE 文件回 200 / 304 / 5xx，形状照真 gh 实测的（状态行在 stdout，304 以 1 退出）。
bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh.real" python3 "$TEST_DIR/lib/fake_github.py"
cat > "$SANDBOX/bin/gh" <<SH
#!/usr/bin/env bash
if [ "\${1:-}" = api ] && [ "\${2:-}" = -i ]; then
    echo "gh \$*" >> "\$FAKE_GH_DIR/calls.log"
    echo "gh \$*" >> "\$FAKE_GH_DIR/probe.log"
    case "\$(cat "\$FAKE_GH_DIR/probe.mode" 2>/dev/null)" in
        304) printf 'HTTP/2.0 304 Not Modified\r\nEtag: "abc"\r\n\r\n'; exit 1 ;;
        502) printf 'HTTP/2.0 502 Bad Gateway\r\n\r\n'; exit 1 ;;
        dead) exit 1 ;;
        *) printf 'HTTP/2.0 200 OK\r\nEtag: W/"abc"\r\n\r\n[]\n'; exit 0 ;;
    esac
fi
exec "$SANDBOX/bin/gh.real" "\$@"
SH
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
log="${FAKE_TMUX_LOG:?}"
case "$1" in
    new-session)
        name=""; prev=""
        for a in "$@"; do [ "$prev" = -s ] && name="$a"; prev="$a"; done
        echo "new-session $name" >> "$log"; echo "$name" >> "$log.live"; exit 0 ;;
    has-session)
        t=""; prev=""
        for a in "$@"; do [ "$prev" = -t ] && t="${a#=}"; prev="$a"; done
        grep -qxF -- "$t" "$log.live" 2>/dev/null; exit $? ;;
    ls|list-sessions) [ -s "$log.live" ] && cat "$log.live"; exit 0 ;;
esac
exit 0
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$SANDBOX/bin/claude"
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/tmux" "$SANDBOX/bin/claude"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}
ok() {   # <说明> <命令...>：命令成功算通过
    local d="$1"; shift
    if "$@" >/dev/null 2>&1; then echo "  ✅ $d"; pass=$((pass+1)); else echo "  ❌ $d"; fail=$((fail+1)); fi
}
section() { echo "$1"; }

git init -q --bare -b main "$SANDBOX/origin.git"
git clone -q "$SANDBOX/origin.git" "$SANDBOX/seed" 2>/dev/null
(cd "$SANDBOX/seed" && git -c user.email=t@x -c user.name=t commit -q --allow-empty -m init && git push -q origin HEAD:main) >/dev/null 2>&1
N_ISSUE=986441

# mkproj <名字> [多出来的配置行...]：一个空仓库的项目（没有任何条目 = 一轮空转）
mkproj() {
    local name="$1"; shift
    W="$SANDBOX/$name"; GD="$W/gh"; CONF="$W/cavil-loop.config"; CALLS="$GD/calls.log"; RL="$W/state/runlog"
    rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$GD"
    git clone -q "$SANDBOX/origin.git" "$W/project" 2>/dev/null
    export FAKE_GH_DIR="$GD" FAKE_TMUX_LOG="$W/tmux.log"
    cat > "$CONF" <<CONF
REPO="example/rl"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="rltest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
LABEL_DONE="Done"
POST_MERGE_RETROSPECTIVE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=3
AGENT_TRUST_PROMPT_WAIT_SECS=1
WORKER_SECRET_ENV=""
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    local l; for l in "$@"; do printf '%s\n' "$l" >> "$CONF"; done
    chmod 600 "$CONF"
    echo '{}' > "$GD/events.json"; echo '{}' > "$GD/perms.json"; echo loop-bot > "$GD/me"
    echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/comments.json"
    echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$W/state/state.json"
}
add_issue() {   # 挂一个待派工的新 issue
    jq -n --arg i "$N_ISSUE" '{($i): {kind:"issue", state:"open", title:"新需求", body:"做一件事", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}}' > "$GD/items.json"
    jq -n --arg i "$N_ISSUE" '{($i): ["pending/agent"]}' > "$GD/labels.json"
}
poll() {   # [环境变量赋值...]：跑一轮真的 agent-poll.sh，返回它的退出码
    # 套一层子 shell：被测进程被强杀时，bash 那行 "Killed" 提示打给子 shell 的 stderr，不进测试输出
    ( env CODING_AGENT_CONFIG="$CONF" "$@" timeout 120 bash "$ROOT/scripts/agent-poll.sh" >/dev/null 2>&1; exit $? ) 2>/dev/null
}
entry() {  # [环境变量赋值...]：经真的 poll-entry.sh 跑一轮
    ( env CODING_AGENT_CONFIG="$CONF" "$@" timeout 120 bash "$ROOT/scripts/poll-entry.sh" >/dev/null 2>&1; exit $? ) 2>/dev/null
}
history() { env -u CODING_AGENT_CONFIG bash "$ROOT/scripts/poll-history.sh" --config "$CONF" "$@"; }
count() {  # <目录>：里面有几个文件（含隐藏的临时文件）；目录不在算 0
    [ -d "$1" ] || { echo 0; return; }
    find "$1" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' '
}
rounds_json() { cat "$RL"/rounds/*.json 2>/dev/null | jq -c -s 'sort_by(.start, .id)'; }
last_round() { rounds_json | jq -c '.[-1]'; }
calls_n() { [ -f "$CALLS" ] && wc -l < "$CALLS" | tr -d ' ' || echo 0; }
tree_sum() { (cd "$1" 2>/dev/null && find . -type f | LC_ALL=C sort | xargs -r sha256sum; find . | LC_ALL=C sort) 2>/dev/null | sha256sum | cut -d' ' -f1; }
wait_for() {   # <文件通配> ：最多等 20 秒
    local i=0
    while ! compgen -G "$1" >/dev/null; do i=$((i+1)); [ "$i" -lt 200 ] || return 1; sleep 0.1; done
}

ROOT="$REPO_DIR"

# ═════════ 1. 正常一轮 ═════════
section "【1】正常一轮：恰好一条正式记录，计数对得上"
mkproj p1
poll; chk "空转一轮退出码 0" "$?" "0"
chk "正式记录恰好一条" "$(count "$RL/rounds")" "1"
chk "结果 ok" "$(last_round | jq -r .outcome)" "ok"
chk "没有残留的进度文件" "$(count "$RL/inflight")" "0"
chk "没有残留的记账文件" "$(count "$RL/acct")" "0"
chk "没有残留的入口记录" "$(count "$ENTRY_DIR")" "0"
chk "假 GitHub 确实收到了请求（> 0）" "$([ "$(calls_n)" -gt 0 ] && echo yes)" "yes"
chk "GitHub 调用数 = 假 GitHub 实际收到的次数" "$(last_round | jq -r .gh_calls)" "$(calls_n)"
chk "失败调用 0、派工 0、候选 0" "$(last_round | jq -r '"\(.gh_failed)/\(.dispatched)/\(.candidates)"')" "0/0/0"
chk "走到最后一步" "$(last_round | jq -r .step)" "pace-record"
chk "没有快照" "$(last_round | jq -r .snapshot.state)/$(count "$RL/snapshots")" "none/0"

add_issue
poll; chk "有一个新 issue 的一轮退出码 0" "$?" "0"
chk "正式记录两条（每轮各一条）" "$(count "$RL/rounds")" "2"
chk "候选 1、派工成功 1、失败 0" "$(last_round | jq -r '"\(.candidates)/\(.dispatched)/\(.dispatch_failed)"')" "1/1/0"
chk "真的派了工（起了 worker 会话）" "$(grep -c "^new-session rltest-issue$N_ISSUE\$" "$W/tmux.log" 2>/dev/null)" "1"
chk "真的翻了标签" "$(jq -r --arg n "$N_ISSUE" '.[$n] | join(",")' "$GD/labels.json")" "doing/agent"

# ═════════ 2. 出错退出 / 读不到 GitHub ═════════
section "【2】出错退出、读不到 GitHub：各一条记录 + 一份快照"
mkproj p2
# 状态文件换成目录：补字段那一步的 mv 失败，set -e 当场退出
rm -f "$W/state/state.json"; mkdir "$W/state/state.json"
poll; rc=$?
chk "轮询以非零退出（记录没有改掉退出码）" "$([ "$rc" != 0 ] && echo nonzero)" "nonzero"
chk "一条 error 记录，带同一个退出码" "$(last_round | jq -r '"\(.outcome)/\(.rc)"')" "error/$rc"
chk "出了一份快照" "$(count "$RL/snapshots")/$(last_round | jq -r .snapshot.state)" "1/written"
SNAP="$RL/snapshots/$(last_round | jq -r .snapshot.name)"
chk "快照里有脚本名和行号" "$(jq -r '.where | test("^agent-poll\\.sh:[1-9][0-9]*:")' "$SNAP")" "true"
chk "快照里没有源码行（where 之外没有任意文本字段）" "$(jq -r 'keys | sort | join(",")' "$SNAP")" "bash,config,id,pace,poll_log,probe,rc,reason,release,rounds,steps,t,v,where"
chk "快照里的配置是校验过的值" "$(jq -r '.config.repo + " " + .config.tmux_prefix' "$SNAP")" "example/rl rltest"
poll
chk "同原因同位置一小时内不再出第二份" "$(count "$RL/snapshots")/$(last_round | jq -r .snapshot.state)" "1/dedup"
chk "正式记录照常每轮一条" "$(count "$RL/rounds")" "2"

mkproj p2b
touch "$GD/F_issues" "$GD/F_pulls"
poll; chk "读不到 GitHub 的一轮退出码 0" "$?" "0"
chk "结果 github-unreadable" "$(last_round | jq -r .outcome)" "github-unreadable"
chk "出了快照" "$(last_round | jq -r .snapshot.state)" "written"
chk "失败的调用记进了失败数" "$([ "$(last_round | jq -r .gh_failed)" -gt 0 ] && echo yes)" "yes"

# ═════════ 3. 轻量检查：超时 / 读取失败 / 状态码分开记 ═════════
section "【3】轻量检查：超时和读取失败留快照，放行不变"
mkdir -p "$SANDBOX/tbin"
# 假 timeout：只对轻量检查那一次（timeout 30 gh …）立刻以 124 退出，别的照常
# （真 timeout 用绝对路径调，PATH 一个字不动——动了 PATH，后面的 gh 就不再是假的了）
REAL_TIMEOUT=$(command -v timeout)
cat > "$SANDBOX/tbin/timeout" <<SH
#!/usr/bin/env bash
if [ "\${1:-}" = 30 ] && [ "\${2:-}" = gh ] && [ -e "\$FAKE_GH_DIR/probe.timeout" ]; then exit 124; fi
exec "$REAL_TIMEOUT" "\$@"
SH
chmod +x "$SANDBOX/tbin/timeout"
mkproj p3 'POLL_BACKOFF_LADDER="0:300"' 'POLL_IDLE_PROBE=true' "PATH=\"$SANDBOX/tbin:$SANDBOX/bin:\$PATH\""
poll; chk "第一轮（还没有节奏状态）照常跑" "$(last_round | jq -r .outcome)" "ok"
echo 200 > "$GD/probe.mode"
# 节奏闸门哪一轮开始拦，取决于节奏状态怎么落的（并行跑测试、机器忙时会晚一轮）：最多再跑三轮，
# 等到轻量检查真的发生的那一轮再断言。
for i in 1 2 3; do poll; [ -z "$(last_round | jq -r .probe)" ] || break; done
chk "检查回 200 → 提前跑一轮，不出快照" "$(last_round | jq -r '"\(.outcome)/\(.probe)/\(.snapshot.state)"')" "ok/200/none"
echo 304 > "$GD/probe.mode"; before=$(calls_n)
poll
chk "检查回 304 → 本轮跳过" "$(last_round | jq -r '"\(.outcome)/\(.probe)"')" "pace-skip/304"
chk "这一轮只有检查这一次调用，且计入调用数" "$(last_round | jq -r .gh_calls)/$(( $(calls_n) - before ))" "1/1"
chk "304 不出快照" "$(count "$RL/snapshots")" "0"
touch "$GD/probe.timeout"; before=$(calls_n)
poll; rc=$?
chk "检查超时 → 本轮照跑（放行不变），退出码 0" "$rc/$(last_round | jq -r .outcome)" "0/ok"
chk "检查结果记为超时" "$(last_round | jq -r .probe)" "timeout"
chk "超时的一轮出了快照（后面的查询都正常也出）" "$(last_round | jq -r .snapshot.state)/$(jq -r .reason "$RL/snapshots/$(last_round | jq -r .snapshot.name)" 2>/dev/null)" "written/probe-timeout"
chk "超时那次请求计入调用数和失败数（其余请求真的发到了假 GitHub）" \
    "$(last_round | jq -r '"\(.gh_calls)/\(.gh_failed)"')" "$(( $(calls_n) - before + 1 ))/1"
chk "后面的请求确实发生了（> 0）" "$([ $(( $(calls_n) - before )) -gt 0 ] && echo yes)" "yes"
rm -f "$GD/probe.timeout"; echo dead > "$GD/probe.mode"
poll
chk "检查读取失败（不是超时）→ 记成读取失败，出快照" "$(last_round | jq -r '"\(.outcome)/\(.probe)/\(.snapshot.state)"')" "ok/unreadable/written"
echo 502 > "$GD/probe.mode"
poll
chk "检查回 502 → 记下状态码，出快照" "$(last_round | jq -r '"\(.probe)/\(.snapshot.state)"')" "http-502/written"

# 同一个响应，本机有没有 timeout 这个命令，记出来的调用数 / 失败数 / 检查结果必须一样
# （PR #390 复审第 1 轮：真 gh 对 304 以 1 退出，原来不经 timeout 时按退出码记成失败、经 timeout 时记成成功）
mkdir -p "$SANDBOX/nobin"
for d in /usr/local/bin /usr/bin /bin; do
    for f in "$d"/*; do
        b=${f##*/}
        [ "$b" != timeout ] && [ ! -e "$SANDBOX/nobin/$b" ] && ln -s "$f" "$SANDBOX/nobin/$b"
    done
done 2>/dev/null
probe_cases() {   # <项目名> <PATH 那一行>：依次回 200 / 304 / 读取失败 / 502，每种记下那一轮的结果
    mkproj "$1" 'POLL_BACKOFF_LADDER="0:300"' 'POLL_IDLE_PROBE=true' "$2"
    local m before i out=""
    poll
    for m in 200 304 dead 502; do
        echo "$m" > "$GD/probe.mode"; before=$(calls_n)
        for i in 1 2 3; do poll; [ -z "$(last_round | jq -r .probe)" ] || break; done
        # 调用数减去「别的请求」（假 GitHub 收到的总数里除掉检查那一次）= 检查这一次记了几次调用
        out+="$m:$(last_round | jq -r --argjson other "$(( $(calls_n) - before - 1 ))" '"\(.probe) 检查记了 \(.gh_calls - $other) 次调用 失败 \(.gh_failed)"') | "
    done
    printf '%s' "$out"
}
WITH_T=$(probe_cases p3w "PATH=\"$SANDBOX/bin:\$PATH\"")
chk "有 timeout 时确实经它转手（对照有效）" "$(env PATH="$SANDBOX/bin:$PATH" bash -c 'command -v timeout >/dev/null && echo yes')" "yes"
NO_T=$(probe_cases p3n "PATH=\"$SANDBOX/bin:$SANDBOX/nobin\"")
chk "没有 timeout 的那个 PATH 里确实找不到它" "$(env PATH="$SANDBOX/bin:$SANDBOX/nobin" bash -c 'command -v timeout >/dev/null && echo yes || echo no')" "no"
chk "四种响应都记到了，304 算成功、读取失败和 502 算失败，每次检查恰好记一次调用" "$WITH_T" \
    "200:200 检查记了 1 次调用 失败 0 | 304:304 检查记了 1 次调用 失败 0 | dead:unreadable 检查记了 1 次调用 失败 1 | 502:http-502 检查记了 1 次调用 失败 1 | "
chk "有没有 timeout，记出来的一模一样" "$NO_T" "$WITH_T"

# ═════════ 4. 并发：每轮一条；慢步骤 / 卡死 ═════════
section "【4】并发：第一轮还在跑时第二轮跳过，各一条记录"
mkproj p4 'POLL_RUN_LOG_SLOW_SECS=1'
mkfifo "$W/fifo"
printf '#!/usr/bin/env bash\n: > "%s/held"\nread -r _ < "%s/fifo"\n' "$W" "$W" > "$GD/hook_issues_1"; chmod +x "$GD/hook_issues_1"
poll & P1=$!
wait_for "$W/held" || echo "  （没等到第一轮卡住）"
chk "第一轮卡在一次 GitHub 请求上，还没有正式记录" "$(count "$RL/rounds")" "0"
poll; chk "第二轮退出码 0" "$?" "0"
chk "第二轮一条 lock-busy" "$(count "$RL/rounds")/$(last_round | jq -r .outcome)" "1/lock-busy"
HOLDER=$(ls "$RL/inflight" | sed 's/\.json$//')
chk "记下了占锁的是第一轮" "$(last_round | jq -r .holder)" "$HOLDER"
chk "查看命令把第一轮显示为还在跑" "$(history --json | jq -r '.inflight | map(.state) | join(",")')" "running"
chk "没有替第一轮写任何正式记录" "$(ls "$RL/rounds" | grep -c -- "-$HOLDER.json")" "0"
sleep 2   # 让占锁的那一轮超过「慢」的门槛（1 秒）
poll
chk "占锁超过门槛 → 出一份卡死快照，用被卡住的那一轮命名" "$(ls "$RL/snapshots" 2>/dev/null | tr '\n' ' ')" "$HOLDER-stuck.json "
poll
chk "同一轮卡死只出一次" "$(count "$RL/snapshots")" "1"
echo go > "$W/fifo"; wait "$P1"; chk "放开后第一轮正常结束" "$?" "0"
chk "第一轮自己写了一条 ok" "$(ls "$RL/rounds" | grep -c -- "-$HOLDER.json")/$(cat "$RL"/rounds/*-"$HOLDER".json | jq -r .outcome)" "1/ok"
chk "一共四条记录（一轮一条），进度文件清空" "$(count "$RL/rounds")/$(count "$RL/inflight")" "4/0"
chk "第一轮有一步超过门槛 → 它自己出了慢步骤快照" "$(cat "$RL"/rounds/*-"$HOLDER".json | jq -r .snapshot.name)" "$HOLDER-slow-step.json"

# ═════════ 5. 被强杀：只显示，不补写 ═════════
section "【5】在每个时刻被强杀：之后没有任何补写，查看命令现场显示"
mkproj p5a
entry CAVIL_RUNLOG_TEST_KILL_AT=entry; chk "入口刚写完就被杀（退出码 137）" "$?" "137"
KID=$(ls "$ENTRY_DIR" | sed 's/\.json$//')
poll; poll; poll
chk "之后跑了三轮，三条记录，没有一条属于被杀的那次" "$(count "$RL/rounds")/$(ls "$RL/rounds" | grep -c -- "-$KID.json")" "3/0"
chk "入口记录还在，没人动它" "$(ls "$ENTRY_DIR" | tr '\n' ' ')" "$KID.json "
chk "查看命令显示：入口启动了，主轮询没起来" "$(history | grep -c "$KID.*入口启动了")" "1"
rm -f "${ENTRY_DIR:?}"/*

mkproj p5b
poll CAVIL_RUNLOG_TEST_KILL_AT=begin; chk "配置加载完、进度文件刚写就被杀" "$?" "137"
KID=$(ls "$RL/inflight" | sed 's/\.json$//')
poll; poll; poll
chk "三条记录，没有一条属于被杀的那轮" "$(count "$RL/rounds")/$(ls "$RL/rounds" | grep -c -- "-$KID.json")" "3/0"
chk "没有补快照" "$(count "$RL/snapshots")" "0"
chk "进度文件原样留着" "$(ls "$RL/inflight" | tr '\n' ' ')" "$KID.json "
chk "查看命令显示：未正常结束，停在 start" "$(history --json | jq -r '.inflight[] | "\(.state)/\(.step)"')" "vanished/start"
chk "文字输出同样标出" "$(history | grep -c "$KID.*未正常结束")" "1"

mkproj p5c
touch "$GD/F_issues" "$GD/F_pulls"
poll CAVIL_RUNLOG_TEST_KILL_AT=snapshot; chk "快照写完、正式记录没写就被杀" "$?" "137"
KID=$(ls "$RL/inflight" | sed 's/\.json$//')
chk "留下一份快照，没有正式记录" "$(count "$RL/snapshots")/$(count "$RL/rounds")" "1/0"
rm -f "$GD/F_issues" "$GD/F_pulls"
poll; poll; poll
chk "三条记录，没有补写被杀那轮；快照还是那一份" "$(count "$RL/rounds")/$(ls "$RL/rounds" | grep -c -- "-$KID.json")/$(count "$RL/snapshots")" "3/0/1"
chk "查看命令显示未正常结束，并列出那份快照" "$(history --json | jq -r '"\(.inflight[0].state)/\(.last_snapshot.reason)"')" "vanished/github-unreadable"

mkproj p5d
poll CAVIL_RUNLOG_TEST_KILL_AT=record; chk "正式记录写完、进度文件没删就被杀" "$?" "137"
KID=$(ls "$RL/inflight" | sed 's/\.json$//')
chk "正式记录和进度文件都在" "$(ls "$RL/rounds" | grep -c -- "-$KID.json")/$(count "$RL/inflight")" "1/1"
chk "查看命令按已完成显示，不算未正常结束" "$(history --json | jq -r '.inflight[0].state')/$(history | grep -c 未正常结束)" "finished/0"
poll
chk "下一轮顺手清掉多余的进度文件" "$(count "$RL/inflight")" "0"
chk "那一轮仍然只有一条记录" "$(ls "$RL/rounds" | grep -c -- "-$KID.json")/$(count "$RL/rounds")" "1/2"

# ═════════ 6. 进程判断：只用于显示，查看不写盘 ═════════
section "【6】进程判断：不存在 / 进程号被复用 / 还在跑 / 判断不了"
mkproj p6
poll
lstart_of() { bash -c 'source "$1/scripts/_runlog.sh"; LC_ALL=C ps -o lstart= -p "$2" | _runlog_lstart_norm' _ "$ROOT" "$1"; }
sleep 300 & LIVE=$!
( exit 0 ) & DEAD=$!; wait "$DEAD"
mkdir -p "$RL/inflight"
mk_inflight() { printf '{"v":1,"id":"%s","start":%s,"lock":1,"step":"queue","steps":[["start",0]],"log_from":0}\n' "$1" "$(date +%s)" > "$RL/inflight/$1.json"; }
mk_inflight "$DEAD-2026Jan01.000000"
mk_inflight "$LIVE-2020Jan01.000000"
mk_inflight "$LIVE-$(lstart_of "$LIVE")"
state_of() { history --json | jq -r --arg id "$1" '.inflight[] | select(.id == $id) | .state'; }
before=$(tree_sum "$W/state")
chk "进程已退出 → 未正常结束" "$(state_of "$DEAD-2026Jan01.000000")" "vanished"
chk "进程号被别的进程复用（启动时间不同）→ 未正常结束" "$(state_of "$LIVE-2020Jan01.000000")" "vanished"
chk "进程还在、启动时间相同 → 还在跑" "$(state_of "$LIVE-$(lstart_of "$LIVE")")" "running"
mkdir -p "$SANDBOX/psbin"
fake_ps() { printf '#!/usr/bin/env bash\n%s\n' "$1" > "$SANDBOX/psbin/ps"; chmod +x "$SANDBOX/psbin/ps"; }
all_states() { PATH="$SANDBOX/psbin:$PATH" history --json | jq -r '[.inflight[].state] | unique | join(",")'; }
fake_ps 'exit 1';                                   chk "ps 失败 → 全部判断不了" "$(all_states)" "unknown"
fake_ps 'exit 0';                                   chk "ps 输出为空 → 全部判断不了" "$(all_states)" "unknown"
fake_ps 'echo "what is this"; echo "1 2 3"';        chk "ps 输出读不懂 → 全部判断不了" "$(all_states)" "unknown"
fake_ps 'echo "    1 Thu Jan  1 00:00:00 2026"';    chk "进程列表里没有查看命令自己 → 全部判断不了" "$(all_states)" "unknown"
chk "判断不了时文字输出不写成未正常结束" "$(PATH="$SANDBOX/psbin:$PATH" history | grep -c 未正常结束)/$(PATH="$SANDBOX/psbin:$PATH" history | grep -c 判断不了)" "0/3"
history >/dev/null; history --json >/dev/null
chk "查看前后状态目录逐字节不变（查看不写盘）" "$(tree_sum "$W/state")" "$before"
kill "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null

# ═════════ 7. 容量：写前腾位 + 写后裁剪，五个目录同一规则 ═════════
section "【7】容量上限：填满后连续被杀不累积，放行一轮回到上限以内"
CAPS=('POLL_RUN_LOG_ROUNDS=4' 'POLL_RUN_LOG_SNAPSHOTS=3' 'POLL_RUN_LOG_INFLIGHT=3')
# 连续 10 轮都停在同一点被杀，每杀一次数一次；输出过程中见到的最大文件数
kill_loop() {   # <目录> <停顿点> <怎么跑：poll / entry> [每轮之前跑的命令]
    local dir="$1" at="$2" how="$3" pre="${4:-}" i max=0 n
    for i in 1 2 3 4 5 6 7 8 9 10; do
        [ -z "$pre" ] || eval "$pre"
        "$how" CAVIL_RUNLOG_TEST_KILL_AT="$at" CAVIL_RUNLOG_ENTRY_MAX=3
        n=$(count "$dir"); [ "$n" -le "$max" ] || max=$n
    done
    echo "$max"
}
mkproj p7 "${CAPS[@]}"
exec 8>"$W/state/poll.lock"; flock 8        # 占着轮询锁：下面每一轮都是「锁被占，跳过」，很快
for i in 1 2 3 4 5 6; do poll; done
chk "正常连跑 6 轮：正式记录不超过上限 4" "$(count "$RL/rounds")" "4"
chk "正式记录：连续 10 轮在「已改名、未裁剪」处被杀，最多时也不超过 4" "$(kill_loop "$RL/rounds" renamed:rounds poll)" "4"
chk "正式记录：连续 10 轮在「临时文件写到一半」处被杀，最多时也不超过 4" "$(kill_loop "$RL/rounds" tmp:rounds poll)" "4"
chk "进度文件：连续 10 轮在「已改名、未裁剪」处被杀，不超过 3" "$(kill_loop "$RL/inflight" renamed:inflight poll)" "3"
chk "进度文件：连续 10 轮在「临时文件写到一半」处被杀，不超过 3" "$(kill_loop "$RL/inflight" tmp:inflight poll)" "3"
chk "记账文件：连续 10 轮在「已改名、未裁剪」处被杀，不超过 3" "$(kill_loop "$RL/acct" renamed:acct poll)" "3"
chk "记账文件：连续 10 轮在「临时文件写到一半」处被杀，不超过 3" "$(kill_loop "$RL/acct" tmp:acct poll)" "3"
chk "入口目录：连续 10 轮在「已改名、未裁剪」处被杀，不超过 3" "$(kill_loop "$ENTRY_DIR" renamed:entry entry)" "3"
chk "入口目录：连续 10 轮在「临时文件写到一半」处被杀，不超过 3" "$(kill_loop "$ENTRY_DIR" tmp:entry entry)" "3"
flock -u 8; exec 8>&-
# 放行一轮：真的跑了（假 GitHub 收到请求），各目录回到上限以内
before=$(calls_n); poll; rc=$?
chk "放行一轮：退出码 0，假 GitHub 确实收到了请求" "$rc/$([ "$(calls_n)" -gt "$before" ] && echo yes)" "0/yes"
chk "放行那一轮自己的记录写成了" "$(last_round | jq -r .outcome)" "ok"
chk "放行后各目录都在上限以内（正式记录 4、进度 3、记账 3）" \
    "$([ "$(count "$RL/rounds")" -le 4 ] && [ "$(count "$RL/inflight")" -le 3 ] && [ "$(count "$RL/acct")" -le 3 ] && echo yes)" "yes"
rm -f "${ENTRY_DIR:?}"/* "${ENTRY_DIR:?}"/.tmp.* 2>/dev/null

# 快照：每轮都出错（状态文件是目录）；每轮之前把已有快照改成两小时前的，不然同原因一小时内不再写
mkproj p7s "${CAPS[@]}"
rm -f "$W/state/state.json"; mkdir "$W/state/state.json"
AGE_SNAPS='find "$RL/snapshots" -type f -exec touch -d "2 hours ago" {} + 2>/dev/null'
for i in 1 2 3 4 5; do eval "$AGE_SNAPS"; poll; done
chk "快照：正常连出 5 份，不超过上限 3" "$(count "$RL/snapshots")" "3"
chk "快照：连续 10 轮在「已改名、未裁剪」处被杀，不超过 3" "$(kill_loop "$RL/snapshots" renamed:snapshots poll "$AGE_SNAPS")" "3"
chk "快照：连续 10 轮在「临时文件写到一半」处被杀，不超过 3" "$(kill_loop "$RL/snapshots" tmp:snapshots poll "$AGE_SNAPS")" "3"
eval "$AGE_SNAPS"; poll
chk "快照：再放行一轮，新快照写成，仍不超过 3" "$(last_round | jq -r .snapshot.state)/$(count "$RL/snapshots")" "written/3"

# K 个轮次同时停在「已腾位、未裁剪」之间
mkproj p7k "${CAPS[@]}"
exec 8>"$W/state/poll.lock"; flock 8
for i in 1 2 3 4; do poll; done
mkfifo "$W/hold"
K=3; pids=()
for i in 1 2 3; do poll CAVIL_RUNLOG_TEST_HOLD="renamed:rounds:$W/hold" & pids+=($!); done
i=0; while [ "$(ls "$W"/hold.at.* 2>/dev/null | wc -l)" -lt "$K" ] && [ "$i" -lt 200 ]; do i=$((i+1)); sleep 0.1; done
chk "三轮都停在了「已改名、未裁剪」" "$(ls "$W"/hold.at.* 2>/dev/null | wc -l | tr -d ' ')" "3"
n=$(count "$RL/rounds")
chk "三轮同时在写：不超过 上限−1+3 = 6（实得 $n）" "$([ "$n" -le 6 ] && echo yes)" "yes"
held=0; for f in "$W"/hold.at.*; do held=$((held + $(ls "$RL/rounds" | grep -c -- "^[0-9]*-${f##*.}-"))); done
chk "三轮各自的记录都写成了（没有因为同时在写而互相放弃）" "$held" "3"
for f in "$W"/hold.at.*; do kill -9 "${f##*.}" 2>/dev/null; done
for p in "${pids[@]}"; do wait "$p" 2>/dev/null; done
chk "三轮全部被杀后不再增长，仍不超过 6" "$([ "$(count "$RL/rounds")" -le 6 ] && echo yes)" "yes"
poll
chk "下一次写入就收回到上限 4" "$(count "$RL/rounds")" "4"
flock -u 8; exec 8>&-

# 留下的是最新的：先放 4 条一小时前的旧记录，再跑 4 轮 → 旧的一条不剩
mkproj p7n "${CAPS[@]}"
mkdir -p "$RL/rounds"
for i in 1 2 3 4; do echo '{"v":1,"id":"old","start":1,"end":1,"outcome":"ok"}' > "$RL/rounds/100$i-9$i-old.json"; done
find "$RL/rounds" -type f -exec touch -d "1 hour ago" {} +
for i in 1 2 3 4; do poll; done
chk "满了以后删的是最旧的：4 条旧记录一条不剩，留下这 4 轮的" "$(count "$RL/rounds")/$(ls "$RL/rounds" | grep -c -- '-old\.json$')" "4/0"

# 删不掉文件且已满：放弃新增，轮询照常
mkproj p7r "${CAPS[@]}"
for i in 1 2 3 4; do poll; done
before_set=$(ls -A "$RL/rounds" | tr '\n' ' '); before=$(calls_n)
if [ "$(id -u)" != 0 ]; then
    chmod a-w "$RL/rounds"
    poll; rc=$?
    chmod u+w "$RL/rounds"
    chk "正式记录目录只读且已满：退出码 0，假 GitHub 照常收到请求" "$rc/$([ "$(calls_n)" -gt "$before" ] && echo yes)" "0/yes"
    chk "没有新增任何文件，原来的 4 条原样在" "$(ls -A "$RL/rounds" | tr '\n' ' ')" "$before_set"
else
    echo "    ⏭ 以 root 运行，只读目录挡不住写入，这一组跳过"
fi

# 计数不靠往文件里写：轮次中途把计数目录清空、设成只读，调用数照样一次不差
# （PR #390 复审第 1、2 轮：原来每次调用往记账文件追加一行，文件被删、被重建、中途写失败都会让计数悄悄变少）
mkproj p7a
printf '#!/usr/bin/env bash\nfind "%s/acct" -mindepth 1 -delete 2>/dev/null\nchmod a-w "%s/acct" "%s"\n: > "%s/tampered"\n' "$RL" "$RL" "$RL" "$W" > "$GD/hook_issues_1"; chmod +x "$GD/hook_issues_1"
poll; rc=$?
chmod u+w "$RL" "$RL/acct" 2>/dev/null
chk "中途清空计数目录并设成只读的一轮退出码 0" "$rc" "0"
chk "那次清空确实发生在这一轮中途，且之后还有请求" "$([ -e "$W/tampered" ] && [ "$(calls_n)" -gt 1 ] && echo yes)" "yes"
chk "这一轮自己的记录因为目录只读没写成（对照有效）" "$(count "$RL/rounds")" "0"
# 目录恢复可写之后再跑一轮，同样中途清空（但不设只读），这一轮的记录能写成，计数必须精确
printf '#!/usr/bin/env bash\nfind "%s/acct" -mindepth 1 -delete 2>/dev/null\n' "$RL" > "$GD/hook_issues_1"
rm -f "$GD/count_issues" "$GD/count_pulls"; before=$(calls_n)
poll; chk "再跑一轮（中途清空计数目录）退出码 0" "$?" "0"
chk "调用数 = 假 GitHub 这一轮实际收到的次数，不是未知也没变少" "$(last_round | jq -r '"\(.outcome)/\(.gh_calls)/\(.gh_failed)/\(.gh_capped)"')" "ok/$(( $(calls_n) - before ))/0/0"
chk "计数目录里没有留下文件" "$(count "$RL/acct")" "0"

# 计数器建不出来（计数目录的位置上是个文件）：调用数是「未知」，不是 0
mkproj p7b
mkdir -p "$RL"; : > "$RL/acct"
poll; chk "计数器建不出来的一轮退出码 0" "$?" "0"
chk "调用数记成未知（null），不是 0" "$(last_round | jq -r '"\(.outcome)/\(.gh_calls)/\(.gh_failed)"')" "ok/null/null"
chk "那一轮其实发了请求" "$([ "$(calls_n)" -gt 0 ] && echo yes)" "yes"
chk "查看命令显示「未知」" "$(history | grep -c '未知')" "1"

# 数到上限：标「计数已封顶」，查看命令在数字后面加 +
mkproj p7c
poll CAVIL_RUNLOG_TEST_TICKS=3
chk "这一轮的请求比上限多（对照有效）" "$([ "$(calls_n)" -gt 4 ] && echo yes)" "yes"
chk "数满了就标封顶，不冒充完整计数" "$(last_round | jq -r .gh_capped)" "1"
chk "查看命令在调用数后面加 +" "$(history | grep -cE ' [0-9]+/[0-9]+\+ ')" "1"

# ═════════ 8. 快照只放校验过的值 ═════════
section "【8】快照只放校验过的值：未知字段、非法指纹、内联令牌都不进快照"
mkproj p8 'FOO_NOTE="SECRETMARK_inline_value"' 'REPO_NOTE="ghp_SECRETMARKinline0123456789"'
printf '{"next_due":1,"last_poll":1,"last_active":1,"fail_streak":0,"fingerprint":"SECRETMARK_fp_ghp_abc","extra":"SECRETMARK_extra","next":"ghp_SECRETMARKpace0123456789"}\n' > "$W/state/poll-pace.json"
rm -f "$W/state/state.json"; mkdir "$W/state/state.json"
poll
SNAP="$RL/snapshots/$(last_round | jq -r .snapshot.name)"
chk "出了快照" "$([ -f "$SNAP" ] && echo yes)" "yes"
chk "非法指纹写成 invalid，合法的数字原样" "$(jq -c .pace "$SNAP")" '{"next_due":1,"last_poll":1,"last_active":1,"fail_streak":0,"fingerprint":"invalid"}'
chk "记录目录里搜不到任何标记" "$(grep -rl SECRETMARK "$RL" "$ENTRY_DIR" 2>/dev/null | wc -l | tr -d ' ')" "0"

# ═════════ 9. 令牌 ═════════
section "【9】带令牌的假环境：记录、快照、入口记录里搜不到任何一个"
TOKS=(ghp_READTOKENMARK0123456789abcdef ghp_WRITETOKENMARK0123456789abcd github_pat_PROJECTMARK0123456789 WEBHOOKURLKEYMARK123456 WEBHOOKKEYMARK1234567890)
mkproj p9 "GH_TOKEN=\"${TOKS[0]}\"" "WRITE_GH_TOKEN=\"${TOKS[1]}\"" "PROJECT_GH_TOKEN=\"${TOKS[2]}\"" \
    "REQUESTER_BOT_WEBHOOK_URL=\"https://hook.example/wake?key=${TOKS[3]}\"" "REQUESTER_BOT_WEBHOOK_KEY=\"${TOKS[4]}\"" \
    'POLL_BACKOFF_LADDER="0:300"' 'POLL_IDLE_PROBE=true' "PATH=\"$SANDBOX/tbin:$SANDBOX/bin:\$PATH\""
TENV=(GITHUB_TOKEN="${TOKS[0]}" SOME_API_KEY="${TOKS[4]}")
add_issue
entry "${TENV[@]}"; chk "正常一轮（经入口脚本，带派工）" "$?/$(last_round | jq -r '"\(.outcome)/\(.dispatched)"')" "0/ok/1"
touch "$GD/probe.timeout"; entry "${TENV[@]}"; rm -f "$GD/probe.timeout"
chk "超时一轮出了快照" "$(last_round | jq -r .snapshot.state)" "written"
touch "$GD/F_issues" "$GD/F_pulls"; echo 200 > "$GD/probe.mode"; entry "${TENV[@]}"
chk "读不到 GitHub 的一轮出了快照" "$(last_round | jq -r '"\(.outcome)/\(.snapshot.state)"')" "github-unreadable/written"
entry "${TENV[@]}" CAVIL_RUNLOG_TEST_KILL_AT=tmp:rounds
entry "${TENV[@]}" CAVIL_RUNLOG_TEST_KILL_AT=begin
entry "${TENV[@]}" CAVIL_RUNLOG_TEST_KILL_AT=entry
(cd "$SANDBOX" && env "${TENV[@]}" CODING_AGENT_CONFIG="$SANDBOX/no-such.config" timeout 60 bash "$ROOT/scripts/poll-entry.sh" >/dev/null 2>&1)
chk "有东西可搜：正式记录、快照、进度文件、临时文件、入口记录都留下了" \
    "$([ "$(count "$RL/rounds")" -ge 3 ] && [ "$(count "$RL/snapshots")" -ge 2 ] && [ "$(count "$RL/inflight")" -ge 1 ] && [ "$(count "$ENTRY_DIR")" -ge 2 ] && ls -A "$RL/rounds" | grep -q '^\.tmp\.' && echo yes)" "yes"
hits=0; for t in "${TOKS[@]}"; do hits=$((hits + $(grep -rl -- "$t" "$RL" "$ENTRY_DIR" 2>/dev/null | wc -l))); done
chk "五个假令牌一个都搜不到" "$hits" "0"
chk "假 GitHub 那边确实用到了令牌（令牌真的在环境里）" "$(grep -c -- "${TOKS[0]}" "$GD/tokens.log" 2>/dev/null | awk '{print ($1 > 0) ? "yes" : "no"}')" "yes"
rm -f "${ENTRY_DIR:?}"/*

# ═════════ 10. 只记不判 ═════════
section "【10】只记不判：开 / 关 / 目录不可写 / 改动前的脚本，轮询做的事逐字节一样"
# 一个项目跑三轮：新 issue 派工 → 空转 → 读不到 GitHub；把轮询对外做的事和退出码收成一份摘要
scenario() {   # <被测根目录> <名字> [多出来的配置行...]
    local root="$1" name="$2"; shift 2
    mkproj "$name" "$@"
    [ -z "${SCEN_PRE:-}" ] || eval "$SCEN_PRE"
    add_issue
    local r1 r2 r3
    env CODING_AGENT_CONFIG="$CONF" timeout 120 bash "$root/scripts/agent-poll.sh" >/dev/null 2>&1; r1=$?
    env CODING_AGENT_CONFIG="$CONF" timeout 120 bash "$root/scripts/agent-poll.sh" >/dev/null 2>&1; r2=$?
    touch "$GD/F_issues" "$GD/F_pulls"
    env CODING_AGENT_CONFIG="$CONF" timeout 120 bash "$root/scripts/agent-poll.sh" >/dev/null 2>&1; r3=$?
    {
        echo "rc=$r1/$r2/$r3"
        echo "--calls"; sed "s#$W#<W>#g" "$CALLS"
        echo "--labels"; jq -S -c . "$GD/labels.json"
        echo "--state"; jq -S -c . "$W/state/state.json"
        echo "--tmux"; cat "$W/tmux.log" 2>/dev/null
    } > "$SANDBOX/$name.digest"
}
scenario "$ROOT" s_on
chk "开着：三轮都有记录" "$(count "$RL/rounds")" "3"
chk "开着：这三轮真的做了事（派了工、发了请求）" "$(grep -c '^new-session' "$W/tmux.log")/$([ "$(calls_n)" -gt 5 ] && echo yes)" "1/yes"
scenario "$ROOT" s_off 'ENABLE_POLL_RUN_LOG=false'
chk "关着：不留任何记录文件" "$(count "$RL")/$(count "$ENTRY_DIR")" "0/0"
ok "关着 = 开着：GitHub 请求序列、标签、state.json、派工、退出码逐字节一样" diff "$SANDBOX/s_on.digest" "$SANDBOX/s_off.digest"
SCEN_PRE=': > "$W/state/runlog"' scenario "$ROOT" s_blocked
chk "记录目录建不出来（同名的是个文件）：没有任何记录" "$([ -f "$RL" ] && [ ! -s "$RL" ] && echo yes)" "yes"
ok "目录不可写 = 开着：轮询做的事和退出码逐字节一样" diff "$SANDBOX/s_on.digest" "$SANDBOX/s_blocked.digest"
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
OLD="$SANDBOX/old"; mkdir -p "$OLD"
git -C "$REPO_DIR" archive "$BASE_REV" scripts prompts | tar -x -C "$OLD"
if ! compat_skip "记录开着时轮询做的事与改动前" "$OLD" "$REPO_DIR" scripts; then
    scenario "$OLD" s_old
    ok "改动前的脚本 = 开着：GitHub 请求序列、标签、state.json、派工、退出码逐字节一样" diff "$SANDBOX/s_old.digest" "$SANDBOX/s_on.digest"
fi

# ═════════ 11. 入口 ═════════
section "【11】入口：配置都没加载成功也留一行"
mkproj p11
(cd "$SANDBOX" && env CODING_AGENT_CONFIG="$SANDBOX/no-such.config" timeout 60 bash "$ROOT/scripts/poll-entry.sh" >/dev/null 2>&1); rc=$?
chk "找不到配置：退出码 2（没被改掉）" "$rc" "2"
chk "入口目录里恰好一份，写着加载配置前退出、退出码 2" "$(count "$ENTRY_DIR")/$(cat "$ENTRY_DIR"/*.json | jq -r '"\(.ev)/\(.rc)"')" "1/early-exit/2"
chk "记下了是哪份配置" "$(cat "$ENTRY_DIR"/*.json | jq -r .config)" "$SANDBOX/no-such.config"
entry; chk "配置正常的一轮（经入口脚本）退出码 0" "$?" "0"
chk "它跑完后入口目录里没有它的文件（还是原来那一份）" "$(count "$ENTRY_DIR")/$(count "$RL/rounds")" "1/1"
chk "查看命令列出那次加载配置前退出" "$(env -u CODING_AGENT_CONFIG bash "$ROOT/scripts/poll-history.sh" --state-dir "$W/state" | grep -c '加载配置前退出，退出码 2')" "1"
rm -f "${ENTRY_DIR:?}"/*

# ═════════ 12. 查看命令 ═════════
section "【12】查看命令：文字和 JSON 同一份结果"
mkproj p12
chk "一条记录都没有时提示去看调度器日志" "$(history | grep -c 'journalctl --user')" "1"
rm -f "$W/state/state.json"; mkdir "$W/state/state.json"; poll
rmdir "$W/state/state.json"; echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$W/state/state.json"
poll; poll
chk "JSON 里的轮数 = 文字表格的行数" "$(history --json | jq '.rounds | length')" "$(history | grep -cE '^[0-9]{2}-[0-9]{2} ')"
chk "JSON 和文字的结果序列一致" "$(history --json | jq -r '[.rounds[].outcome] | join(" ")')" "$(history | grep -E '^[0-9]{2}-[0-9]{2} ' | awk '{print $4}' | tr '\n' ' ' | sed 's/ $//')"
chk "-n 1 只给最近一轮" "$(history -n 1 --json | jq '.rounds | length')" "1"
chk "有记录时不再提示调度器日志" "$(history | grep -c 'journalctl --user')" "0"
chk "显示最近一份快照的原因和位置" "$(history | grep -c '原因 error  位置 agent-poll.sh:')" "1"
chk "快照对应的 poll.log 片段现读现印（那一轮没写日志也说明）" "$(history | grep -cE 'poll.log 里的内容')" "1"
find "$RL/snapshots" -type f -delete
chk "快照被挤掉后那一轮显示「已过期」" "$(history --json | jq -r '[.rounds[].snapshot_state] | join(",")')/$(history | grep -c 快照已过期)" "expired,none,none/1"
chk "参数不对时报错退出 2" "$(history -n abc >/dev/null 2>&1; echo $?)" "2"

# ═════════ 13. 运维文档里的步骤 ═════════
section "【13】运维文档里的查看 / 关闭步骤：中英文一字不差，在空环境里按原样执行"
ops_block() {   # <文档> <标记名> → 标记之间 ```bash 代码块的内容
    awk -v b="<!-- $2:begin -->" -v e="<!-- $2:end -->" '
        index($0, b) {on=1; next} index($0, e) {on=0}
        on && /^```bash$/ {inb=1; next} on && /^```$/ {inb=0; next} inb' "$1"
}
VIEW_EN=$(ops_block "$REPO_DIR/docs/operations.md" poll-history-ops); VIEW_ZH=$(ops_block "$REPO_DIR/docs/operations.zh.md" poll-history-ops)
OFF_EN=$(ops_block "$REPO_DIR/docs/operations.md" poll-history-off-ops); OFF_ZH=$(ops_block "$REPO_DIR/docs/operations.zh.md" poll-history-off-ops)
chk "两份文档都有查看和关闭两段" "$([ -n "$VIEW_EN" ] && [ -n "$OFF_EN" ] && echo yes)" "yes"
chk "查看步骤两份一字不差" "$([ "$VIEW_EN" = "$VIEW_ZH" ] && echo same)" "same"
chk "关闭步骤两份一字不差" "$([ "$OFF_EN" = "$OFF_ZH" ] && echo same)" "same"
# 一台「装好了这个项目的机器」：HOME 里有实例的环境文件和技能目录；环境里什么都不预设
mkproj p13
OPS_HOME="$SANDBOX/ops-home"; mkdir -p "$OPS_HOME/.config/cavil-loop" "$OPS_HOME/.agents/skills"
ln -s "$ROOT" "$OPS_HOME/.agents/skills/cavil-loop"
printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\n' "$W/project" "$CONF" > "$OPS_HOME/.config/cavil-loop/rltest.conf"
run_ops() {   # <步骤文本>：维护者要填的只有 KEY 那一行，别的照抄
    printf '%s\n' "$1" | sed 's/^KEY=myproject /KEY=rltest /' > "$SANDBOX/ops.sh"
    env -i HOME="$OPS_HOME" PATH=/usr/local/bin:/usr/bin:/bin bash "$SANDBOX/ops.sh" 2>&1
}
out=$(run_ops "$VIEW_EN")
chk "还没跑过：查看步骤不报错，说明没有记录" "$(grep -c '一条记录都没有' <<<"$out")/$(grep -ci 'no such file\|not found\|error' <<<"$out")" "1/0"
poll; poll
out=$(run_ops "$VIEW_EN")
chk "跑过两轮：查看步骤列出这两轮" "$(grep -cE '^[0-9]{2}-[0-9]{2} .* ok ' <<<"$out")" "2"
out=$(run_ops "$OFF_EN"); rc=$?
chk "关闭步骤执行成功，记录目录删掉了" "$rc/$([ -e "$RL" ] && echo exists || echo gone)" "0/gone"
before=$(calls_n); poll; rc=$?
chk "关掉之后轮询照常（退出码 0、假 GitHub 收到请求），不再留记录" "$rc/$([ "$(calls_n)" -gt "$before" ] && echo yes)/$(count "$RL")" "0/yes/0"
out=$(run_ops "$VIEW_EN")
chk "关掉之后查看步骤说明这里是空的，并提到开关" "$(grep -c 'ENABLE_POLL_RUN_LOG=false' <<<"$out")" "1"
sed -i '/^ENABLE_POLL_RUN_LOG=false$/d' "$CONF"
poll
chk "把那一行删掉就重新打开：下一轮又有记录" "$(count "$RL/rounds")" "1"

compat_summary
report_counts "$pass" "$fail"
echo "通过 $pass / 失败 $fail"
[ "$fail" = 0 ]
