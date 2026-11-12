#!/usr/bin/env bash
# kind: e2e
# parts: 3
# 条目卡在 doing/agent、会话还在却没人干活 → daemon 催一次 / 重派 / 交人（GitHub#339）。
#
# 跑法：bash tests/stuck-worker.test.sh        （三段合计约 14 分钟；没有负对照；STUCK_ONLY=9,13 只跑指定的组，13x = 第三段）
# 依赖：tmux（3.0+）、git、jq、python3。
#
# 真跑 agent-poll.sh（连带真的派工脚本），配有状态的假 GitHub（tests/lib/fake_github.py）和
# **私有 socket** 上的真 tmux——绝不碰本机跑着 worker 的默认 server。工作窗格里跑一个假 agent：
# 画面内容由控制文件决定（闲 / 忙 / 只有某个 agent 的规则才算忙），收到的输入逐行记进文件。
# 时钟用 POLL_FAKE_NOW 拨，不靠真的等。
#
# 这块错了不会报错，方向有两个：
#   · 该管的没管 → 条目继续永远占着并发名额（本功能要治的病）
#   · 不该管的管了 → 把正在干活的 worker 打断、往人已经接手的条目上写东西
# 所以每一组「没催 / 没杀 / 没写」的断言旁边，都有一条「这一轮确实采到了这个窗格 / 确实读了
# 这条绑定条目」的到达性断言，或者同一场景去掉保护后确实推进的对照。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

# 干净环境重跑自己：worker 会话里本来就带着真 GH_TOKEN / TMUX 等，漏进来会让被测脚本读到真值，
# 或者让 tmux 命令连到外层 server。
if [ -z "${STUCK_TEST_CLEAN_ENV:-}" ]; then
    keep=(STUCK_TEST_CLEAN_ENV=1 HOME="$HOME" PATH="$PATH" LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}" TZ=UTC)
    [ -n "${KEEP_SANDBOX:-}" ] && keep+=(KEEP_SANDBOX="$KEEP_SANDBOX")
    [ -n "${STUCK_ONLY:-}" ] && keep+=(STUCK_ONLY="$STUCK_ONLY")
    [ -n "${TEST_PART:-}" ] && keep+=(TEST_PART="$TEST_PART")
    exec env -i "${keep[@]}" bash "${BASH_SOURCE[0]}" "$@"
fi

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/compat.sh
source "$TEST_DIR/lib/compat.sh"
# 分三段跑（tests/run.sh 每个单位限时 900 秒）：1 = 阶梯和判断、交人前的说明（①–⑫），2 = 停住和恢复（⑬），
# 3 = 恢复派工的失败与本机状态读失败（13x）
# shellcheck source=lib/parts.sh
source "$TEST_DIR/lib/parts.sh"

if ! command -v tmux > /dev/null 2>&1; then
    echo "⏭ 本机没有 tmux，整份跳过"; exit 0
fi

TMP=$(mktemp -d); TMP="$(cd "$TMP" && pwd -P)"
# socket 路径有长度上限，单独放一个短目录
TMUX_DIR=$(mktemp -d /tmp/sw.XXXX)
export TMUX_TMPDIR="$TMUX_DIR"
SOCK="$TMUX_DIR/tmux-$(id -u)/default"
mkdir -p "$(dirname "$SOCK")"; chmod 700 "$(dirname "$SOCK")"
REAL_TMUX="$(command -v tmux)"
# 测试自己的查询走真 tmux，不经过下面的故障注入包装
T() { timeout 10 "$REAL_TMUX" -S "$SOCK" "$@"; }
cleanup() {
    # 显式 -S：就算 TMUX_TMPDIR 没生效也不会去关本机默认 server
    timeout 10 "$REAL_TMUX" -S "$SOCK" kill-server 2>/dev/null || true
    rm -f /tmp/cavil-loop-issue-9883* /tmp/cavil-loop-pr-9883* 2>/dev/null
    [ -n "${KEEP_SANDBOX:-}" ] && { echo "SANDBOX=$TMP"; return 0; }
    rm -rf "$TMP" "$TMUX_DIR"
}
trap cleanup EXIT
export HOME="$TMP/home"; mkdir -p "$HOME"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export FAKE_GH_LISTS=1 FAKE_GH_REPO="example/sw"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then
        echo "  ✅ $1"; pass=$((pass+1))
    else
        echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1))
    fi
}

# ── 假命令 ───────────────────────────────────────────────────────────────────
FAKEBIN="$TMP/fakebin"; CTL="$TMP/ctl"; mkdir -p "$FAKEBIN" "$CTL"
bash "$TEST_DIR/lib/fake_gh_client.sh" install "$FAKEBIN/gh" python3 "$TEST_DIR/lib/fake_github.py"
# 假 agent：不在 tmux 里（driver 探版本之类）立刻退出。在 tmux 里：
#   · 画面 = $CTL/screen.<工作目录名> 的内容，贴在窗格底部（真的界面也是把状态行画在底部；
#     各 agent 的忙碌判据只看末尾几行）；文件变了才重画，免得抓画面时撞上清屏的那一帧
#   · 每次启动往 $CTL/runs.<工作目录名> 记一行；收到的输入逐行记进 $CTL/got.<工作目录名>
for a in claude codex; do
    cat > "$FAKEBIN/$a" <<SH
#!/usr/bin/env bash
[ -n "\${TMUX:-}" ] || exit 0
key=\$(basename "\$PWD")
# $CTL/die.<工作目录名> 存在时一启动就退出（模拟 worker 秒退）
[ -e "$CTL/die.\$key" ] && exit 1
echo "$a \$\$" >> "$CTL/runs.\$key"
last="__none__"
while :; do
    cur=\$(cat "$CTL/screen.\$key" 2>/dev/null || echo "> ")
    if [ "\$cur" != "\$last" ]; then
        printf '\\033[2J\\033[H'
        for _ in \$(seq 1 60); do echo; done
        printf '%s\\n' "\$cur"
        last="\$cur"
    fi
    if IFS= read -r -t 0.2 line; then printf '%s\\n' "\$line" >> "$CTL/got.\$key"; fi
done
SH
done
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/systemctl"
# 改假 GitHub 状态文件的小工具（钩子脚本里也用）：jset <文件> <jq 表达式> [jq 参数…]
cat > "$FAKEBIN/jset" <<'SH'
#!/usr/bin/env bash
f="$1"; e="$2"; shift 2
t=$(mktemp); jq "$e" "$f" "$@" > "$t" && mv "$t" "$f"
SH
# 被测脚本用的 tmux：每次调用记一行；$CTL/fault 里写一个 glob，参数整串匹配上就返回 1
# （模拟一次查询失败），其余原样交给真 tmux
cat > "$FAKEBIN/tmux" <<SH
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$CTL/tmux.log"
if [ -s "$CTL/fault" ]; then
    pat="\$(cat "$CTL/fault")"
    if [[ "\$*" == \$pat ]]; then echo "injected failure: \$*" >> "$CTL/fault.hits"; exit 1; fi
fi
exec "$REAL_TMUX" "\$@"
SH
# 被测脚本用的 jq：$CTL/jqfault 里写一个 glob，参数整串匹配上就返回 1（模拟一次本地状态读取失败）。
# 默认只坏一次（命中后把故障文件删掉）；同时有 $CTL/jqfault.keep 时一直坏到测试把它撤掉。
REAL_JQ="$(command -v jq)"
cat > "$FAKEBIN/jq" <<SH
#!/usr/bin/env bash
if [ -s "$CTL/jqfault" ]; then
    pat="\$(cat "$CTL/jqfault")"
    if [[ "\$*" == \$pat ]]; then
        echo hit >> "$CTL/jqfault.hits"
        [ -e "$CTL/jqfault.keep" ] || rm -f "$CTL/jqfault"
        exit 1
    fi
fi
exec "$REAL_JQ" "\$@"
SH
chmod +x "$FAKEBIN"/*
export PATH="$FAKEBIN:$PATH"

# ── 真 git：bare origin ─────────────────────────────────────────────────────
gq() { git -c user.email=t@example.invalid -c user.name=t "$@" >/dev/null 2>&1; }
G="$TMP/git"; mkdir -p "$G"
gq init -q --bare -b main "$G/up.git"
gq clone -q "$G/up.git" "$G/seed"
(cd "$G/seed" && echo x > f && gq add f && gq commit -qm init && gq push -q origin HEAD:main)

NEW="$TMP/new"; mkdir -p "$NEW"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$NEW/"
ROOT="$NEW"
HOST="swhost"
PREFIX="swtest"
MARK="daemon 自动提醒"
# 编号取真实条目用不到的大数：派工脚本把提示词写到固定的 /tmp/cavil-loop-issue-<N>-*.md
SEQ=988300

# ── 场景搭建 ─────────────────────────────────────────────────────────────────
# scn <名字> [额外的配置行…]：一个场景一套独立目录、一个干净的 tmux server、一份空的假 GitHub
scn() {
    local name="$1"; shift
    W="$TMP/sc.$name"; rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh" "$W/logs"
    GD="$W/gh"; CONF="$W/cavil-loop.config"; CALLS="$GD/calls.log"; STATE="$W/state/state.json"
    export FAKE_GH_DIR="$GD"
    gq clone -q "$G/up.git" "$W/project"
    cat > "$CONF" <<CONF
REPO="example/sw"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
SESSION_LOG_DIR="$W/logs"
TMUX_PREFIX="$PREFIX"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
LABEL_PENDING_BLOCKED="pending/blocked"
LABEL_DONE="Done"
WORKER_AGENT="claude"
REVIEW_WORKER_AGENT="codex"
SELFHEAL_HOST_ID="$HOST"
POST_MERGE_RETROSPECTIVE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=5
AGENT_TRUST_PROMPT_WAIT_SECS=1
AGENT_SESSION_CAPTURE_SECS=1
REAP_KILL_GRACE_SECS=3
WORKER_SECRET_ENV=""
PATH="$FAKEBIN:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    if [ "${STUCK_OFF:-0}" != 1 ]; then
        printf 'STUCK_WORKER_QUIET_SECS=100\nSTUCK_WORKER_STEP_GAP_SECS=50\nSTUCK_WORKER_MAX_RESTARTS=1\n' >> "$CONF"
    fi
    local line; for line in "$@"; do printf '%s\n' "$line" >> "$CONF"; done
    chmod 600 "$CONF"
    echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/events.json"
    echo '{}' > "$GD/comments.json"; echo '{}' > "$GD/perms.json"; echo loop-bot > "$GD/me"
    echo '{"cleaned_prs":[],"cleaned_issues":[],"worker_hosts":{},"worker_trigger_labels":{},"worker_models":{}}' > "$STATE"
    rm -f "$CTL"/screen.* "$CTL"/got.* "$CTL"/runs.* "$CTL"/die.* "$CTL/fault" "$CTL/fault.hits" "$CTL"/jqfault*; : > "$CTL/tmux.log"
    # 等旧 server 真的退干净再起新的：否则新会话连到正在退出的 server 上，窗格编号也不从头数
    T kill-server >/dev/null 2>&1
    local i; for ((i = 0; i < 50; i++)); do T list-sessions >/dev/null 2>&1 || break; sleep 0.1; done
    T new-session -d -s keep "sleep 3600" >/dev/null 2>&1
    NOW=1900000000
    SEQ=$((SEQ + 10))
}
jset() { "$FAKEBIN/jset" "$@"; }
mk_issue() {   # <编号> [标签…]
    local n="$1"; shift
    jset "$GD/items.json" '.[$n] = {kind:"issue", state:"open", title:"需求", body:"做一件事", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}' --arg n "$n"
    jset "$GD/labels.json" '.[$n] = $ARGS.positional' --arg n "$n" --args "$@"
}
mk_pr() {   # <PR 编号> <分支> <正文> [标签…]
    local n="$1" br="$2" body="$3"; shift 3
    jset "$GD/items.json" '.[$n] = {kind:"pr", state:"open", merged:false, draft:false, title:"实现", body:$body, user:{login:"loop-bot"},
        updated_at:"2026-01-01T00:00:00Z", head:{sha:"1111111111111111111111111111111111111111", ref:$br, repo:{full_name:"example/sw"}}, base:{ref:"main"}}' \
        --arg n "$n" --arg br "$br" --arg body "$body"
    jset "$GD/labels.json" '.[$n] = $ARGS.positional' --arg n "$n" --args "$@"
    # PR 派工从 GitHub 那样的 refs/pull/<n>/head 取提交
    (cd "$G/seed" && gq push -q origin "HEAD:refs/pull/$n/head")
}
own() {   # <工作编号> <触发标签>：派工时 daemon 记下的归属和触发标签
    jset "$STATE" '.worker_hosts[$n] = $h | .worker_trigger_labels[$n] = $l' --arg n "$1" --arg h "${3:-$HOST}" --arg l "$2"
}
mk_wt() {   # <工作编号>
    gq -C "$W/project" worktree add -q "$W/wt/issue-$1" -b "feature/issue-$1"
}
screen() {   # <工作编号> <画面>
    printf '%s\n' "$2" > "$CTL/screen.issue-$1"; sleep 0.6
}
IDLE='> '
BUSY_CLAUDE='✻ Working… (12s · esc to interrupt)'
# 只有 codex 的规则认这一行是忙（claude 的规则要「省略号 + 括号时长」或 esc to interrupt）
BUSY_CODEX_ONLY='• Thinking'
sess_of() { printf '%s-issue%s' "$PREFIX" "$1"; }
# mk_sess <工作编号> <agent> <角色>：daemon 起 worker 会话后的样子——工作窗格登记在会话上，
# 实际 agent 和角色也记在会话上
mk_sess() {
    local n="$1" agent="$2" role="$3" s pane
    s="$(sess_of "$n")"
    [ -f "$CTL/screen.issue-$n" ] || printf '%s\n' "$IDLE" > "$CTL/screen.issue-$n"
    T new-session -d -s "$s" -x 100 -y 30 -c "$W/wt/issue-$n" "$FAKEBIN/$agent"
    pane=$(T list-panes -t "=$s:" -F '#{pane_id}' | head -1)
    T set-option -t "=$s:" @worker_agent "$agent"
    T set-option -t "=$s:" @worker_role "$role"
    T set-option -t "=$s:" @worker_pane "$pane"
    local i; for ((i = 0; i < 50; i++)); do [ -s "$CTL/runs.issue-$n" ] && break; sleep 0.1; done
    sleep 0.5
}
pane_of() { T show-options -qv -t "=$(sess_of "$1"):" @worker_pane; }
alive() { T has-session -t "=$(sess_of "$1")" 2>/dev/null && echo yes || echo no; }
labels_of() { jq -r --arg n "$1" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
cnt() { local c; c=$(grep -c -- "$1" "$2" 2>/dev/null); printf '%s\n' "${c:-0}"; }
runs() { cnt '' "$CTL/runs.issue-$1"; }
nudges() { cnt "$MARK" "$CTL/got.issue-$1"; }
comments_on() { jq -r --arg n "$1" '(.[$n] // []) | length' "$GD/comments.json"; }
# 这条目上的写请求条数（加标签 / 摘标签 / 评论）
writes_on() { local c; c=$(grep -cE -- "-X (POST|DELETE) repos/example/sw/issues/$1/" "$CALLS" 2>/dev/null); printf '%s\n' "${c:-0}"; }
entry() { jq -c --arg n "$1" '.stuck_workers[$n] // {}' "$STATE"; }
efield() { jq -r --arg n "$1" ".stuck_workers[\$n] | $2" "$STATE" 2>/dev/null; }
# tick [秒]：把时钟往前拨这么多秒，跑一轮真的 agent-poll.sh
tick() {
    NOW=$((NOW + ${1:-0}))
    (cd "$W/project" && env CODING_AGENT_CONFIG="$CONF" POLL_FAKE_NOW="$NOW" timeout 180 bash "$ROOT/scripts/agent-poll.sh") \
        > "$W/poll.out" 2>&1
}
# 这一轮里 daemon 抓过哪个窗格的画面
captured() { cnt "^capture-pane -t $1 -p" "$CTL/tmux.log"; }
plog() { cnt "$1" "$W/state/poll.log"; }
# 下一次 GET 这个路径（key = 路径里的 / 换成 _，如 issues_7）之前执行一条命令：
# 模拟「daemon 这一轮开头读过快照之后、动手前重读之前，GitHub 上变了」
hook_next() {   # <key> <命令及参数…>
    local key="$1" k; shift
    k=$(( $(cat "$GD/count_$key" 2>/dev/null || echo 0) + 1 ))
    rm -f "$GD/hook.ran"
    { printf '%q ' "$@"; printf '\n'; printf 'touch %q\n' "$GD/hook.ran"; } > "$GD/hook_${key}_$k"
}
hook_ran() { [ -e "$GD/hook.ran" ] && echo yes || echo no; }
add_comment() {   # <编号>：有人留了一条评论（不动 updated_at：同一秒里的变化快照看不出来）
    "$FAKEBIN/jset" "$GD/comments.json" '.[$n] = ((.[$n] // []) + [{id: (9000 + ([.[][]] | length)), body: "看一下", user: {login: "maint"}, created_at: "2026-01-02T00:00:00Z"}])' --arg n "$1"
}
touch_item() { "$FAKEBIN/jset" "$GD/items.json" '.[$n].updated_at = $t' --arg n "$1" --arg t "2026-02-01T00:00:${2:-01}Z"; }
want() {
    case "$1" in 13) part_on 2 || return 1 ;; 13x) part_on 3 || return 1 ;; *) part_on 1 || return 1 ;; esac
    [ -z "${STUCK_ONLY:-}" ] || [[ ",$STUCK_ONLY," == *",$1,"* ]]
}

# ════════════════════════════════════════════════════════════════════════════
if want 1; then
echo "【1】issue：会话活着、agent 空闲、GitHub 无动静 → 催促 → 重派 → 交人"
scn ladder; N=$SEQ
mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
tick 0
chk "第一轮只开始计时：没催" "$(nudges "$N")" "0"
chk "到达性 · 这一轮抓了工作窗格的画面" "$([ "$(captured "$(pane_of "$N")")" -ge 1 ] && echo yes || echo no)" "yes"
chk "记下了开始空闲的时间" "$(efield "$N" '.since')" "$NOW"
tick 60
chk "60 秒（< 100）：还没催" "$(nudges "$N")" "0"
tick 50
chk "110 秒：催促文字真的进了工作窗格" "$([ "$(nudges "$N")" -ge 1 ] && echo yes || echo no)" "yes"
chk "催促不写 GitHub" "$(writes_on "$N")" "0"
chk "催完标签没变、会话还在" "$(labels_of "$N")/$(alive "$N")" "doing/agent/yes"
tick 30
chk "催后 30 秒（< 50）：不重派" "$(alive "$N")/$(labels_of "$N")" "yes/doing/agent"
chk "只催一次" "$(grep -c "发催促" "$W/state/poll.log")" "1"
tick 30
chk "催后 60 秒仍没动静：会话真的被结束" "$(alive "$N")" "no"
chk "标签回到原触发标签" "$(labels_of "$N")" "pending/agent"
chk "记了一次重派" "$(efield "$N" '.restarts')" "1"
R0=$(runs "$N")
tick 10
chk "下一轮真的重新派工：又挂上 doing/agent、起了新会话" "$(labels_of "$N")/$(alive "$N")" "doing/agent/yes"
chk "新会话里真的起了一个新的 agent 进程" "$([ "$(runs "$N")" -gt "$R0" ] && echo yes || echo no)" "yes"
chk "阶梯进度跨重派保留" "$(efield "$N" '.restarts')" "1"
sleep 1; tick 10
tick 60
chk "重派后 60 秒：还不交人" "$(labels_of "$N")" "doing/agent"
C0=$(comments_on "$N")
tick 50
chk "重派后又卡住 110 秒：标 pending/human、摘 doing/agent" "$(labels_of "$N")" "pending/human"
chk "发了一条交人评论" "$(( $(comments_on "$N") - C0 ))" "1"
body=$(jq -r --arg n "$N" '.[$n][-1].body' "$GD/comments.json")
chk "评论写明试过催促和重派、怎么继续" \
    "$(grep -c '发过一次催促' <<<"$body")/$(grep -c '结束会话并重新派工（共 1 次）' <<<"$body")/$(grep -c "session-log.sh $N" <<<"$body")/$(grep -c '改回 `pending/agent`' <<<"$body")" "1/1/1/1"
chk "评论里不用「你 / 我」" "$(grep -c '[你我]' <<<"$body")" "0"
chk "交人后会话保留，方便人查" "$(alive "$N")" "yes"
chk "交人后进度记录清掉" "$(entry "$N")" "{}"
tick 200
chk "交人之后不再动它" "$(labels_of "$N")/$(comments_on "$N")" "pending/human/$((C0 + 1))"
fi


# ════════════════════════════════════════════════════════════════════════════
if want 2; then
echo "【2】agent 在忙 → 不催、不杀，计时清零；闲下来重新计时"
scn busy; N=$SEQ
mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
tick 0
chk "空闲：开始计时" "$(efield "$N" '.since > 0')" "true"
screen "$N" "$BUSY_CLAUDE"; : > "$CTL/tmux.log"
tick 60
chk "到达性 · 这一轮抓了工作窗格的画面" "$([ "$(captured "$(pane_of "$N")")" -ge 1 ] && echo yes || echo no)" "yes"
chk "看到在忙：计时清零" "$(efield "$N" '.since')" "0"
tick 200
chk "一直在忙 260 秒：没催、会话还在、标签没变" "$(nudges "$N")/$(alive "$N")/$(labels_of "$N")" "0/yes/doing/agent"
screen "$N" "Compacting conversation"
tick 200
chk "压缩上下文算在忙：没催" "$(nudges "$N")/$(efield "$N" '.since')" "0/0"
screen "$N" "$IDLE"
tick 10
chk "闲下来：从这一刻重新计时" "$(efield "$N" '.since')" "$NOW"
tick 60
chk "闲了 60 秒：还没催（忙之前那段不算）" "$(nudges "$N")" "0"
tick 50
chk "闲满 110 秒：催了" "$([ "$(nudges "$N")" -ge 1 ] && echo yes || echo no)" "yes"
fi

# ════════════════════════════════════════════════════════════════════════════
if want 3; then
echo "【3】开发与复审用不同 agent：按会话实际跑的 agent 的规则判"
scn agents; N=$SEQ; M=$((SEQ + 1))
# 同一个画面「• Thinking」：codex 的规则算忙，claude 的规则算闲。主轮询加载的是 claude。
mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/review
screen "$N" "$BUSY_CODEX_ONLY"; mk_sess "$N" codex review
mk_issue "$M" doing/agent; mk_wt "$M"; own "$M" pending/agent
screen "$M" "$BUSY_CODEX_ONLY"; mk_sess "$M" claude worker
tick 0; tick 60; tick 50
chk "到达性 · 两个会话的工作窗格都被采样" \
    "$([ "$(captured "$(pane_of "$N")")" -ge 1 ] && echo yes || echo no)/$([ "$(captured "$(pane_of "$M")")" -ge 1 ] && echo yes || echo no)" "yes/yes"
chk "codex 复审会话：按 codex 的规则是忙 → 没催、没计时" "$(nudges "$N")/$(efield "$N" '.since // 0')" "0/0"
chk "对照 · 同一画面在 claude 会话里是闲 → 催了" "$([ "$(nudges "$M")" -ge 1 ] && echo yes || echo no)" "yes"
tick 60
chk "codex 复审会话一直忙：会话还在、标签没变" "$(alive "$N")/$(labels_of "$N")" "yes/doing/agent"
chk "对照 · claude 会话催后仍闲 → 被结束重派" "$(alive "$M")/$(labels_of "$M")" "no/pending/agent"
fi

# ════════════════════════════════════════════════════════════════════════════
if want 4; then
echo "【4】人在会话里另开窗格并切过去：只看、只催登记的工作窗格"
scn split; N=$SEQ
mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
WP=$(pane_of "$N")
# 人的窗格排在前面、成为当前窗格，画面是闲的；它收到的输入记进 human.got
T split-window -b -t "$WP" "cat >> '$CTL/human.got'"
HP=$(T list-panes -s -t "=$(sess_of "$N"):" -F '#{pane_id} #{pane_active}' | awk '$2 == 1 { print $1 }')
chk "夹具 · 当前窗格是人的那个，不是工作窗格" "$([ -n "$HP" ] && [ "$HP" != "$WP" ] && echo yes || echo no)" "yes"
screen "$N" "$BUSY_CLAUDE"
tick 0; tick 60; tick 60
chk "到达性 · 采的是登记的工作窗格" "$([ "$(captured "$WP")" -ge 1 ] && echo yes || echo no)" "yes"
chk "没去抓人的窗格" "$(captured "$HP")" "0"
chk "worker 在忙（人的窗格是闲的）：没催、没杀" "$(nudges "$N")/$(alive "$N")/$(efield "$N" '.since // 0')" "0/yes/0"
screen "$N" "$IDLE"
tick 0; tick 60; tick 50
chk "worker 闲下来：催促进了工作窗格" "$([ "$(nudges "$N")" -ge 1 ] && echo yes || echo no)" "yes"
chk "人的窗格没收到催促" "$(cnt "$MARK" "$CTL/human.got")" "0"
fi

# ════════════════════════════════════════════════════════════════════════════
if want 5; then
echo "【5】认不出 / 读不出 → 不推进；恢复后正常推进"
scn unknown; N=$SEQ
mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
WP=$(pane_of "$N")
T set-option -u -t "=$(sess_of "$N"):" @worker_agent
tick 0; tick 60; tick 60
chk "会话上没有 agent 记录：没计时、没催" "$(efield "$N" '.since // 0')/$(nudges "$N")" "0/0"
chk "原因只记一次日志" "$(plog '会话上没有记录它跑的是哪个 agent')" "1"
T set-option -t "=$(sess_of "$N"):" @worker_agent claude
T set-option -u -t "=$(sess_of "$N"):" @worker_pane
T split-window -b -t "$WP" "sleep 600"
tick 0; tick 60; tick 60
chk "多个窗格、没有登记工作窗格：没计时、没催" "$(efield "$N" '.since // 0')/$(nudges "$N")" "0/0"
chk "原因记了日志" "$(plog '没有登记工作窗格')" "1"
T set-option -t "=$(sess_of "$N"):" @worker_pane "$WP"
tick 0
chk "补上登记：开始计时" "$(efield "$N" '.since')" "$NOW"
S0=$NOW
tick 60
# 到点的这几轮，tmux 的读取各坏一次：抓画面 / 读会话选项 / 读窗格清单
for pat in 'capture-pane*' 'show-options*@worker_agent*' 'list-panes -s*'; do
    printf '%s\n' "$pat" > "$CTL/fault"; rm -f "$CTL/fault.hits"
    tick 50
    chk "tmux 读取失败（$pat）：到点也不催、会话还在" "$(nudges "$N")/$(alive "$N")" "0/yes"
    chk "到达性 · 那次读取确实发生并失败了" "$([ -s "$CTL/fault.hits" ] && echo yes || echo no)" "yes"
    chk "读不出时计时原样留着（不清零、不推进）" "$(efield "$N" '.since')" "$S0"
done
rm -f "$CTL/fault"
tick 10
chk "读取恢复：这一轮就催了" "$([ "$(nudges "$N")" -ge 1 ] && echo yes || echo no)" "yes"
# 登记的工作窗格没了（worker 退出，人的窗格撑着会话）
T kill-pane -t "$WP"
tick 60; tick 60
chk "登记的工作窗格已不在：不重派、不写 GitHub" "$(labels_of "$N")/$(writes_on "$N")" "doing/agent/0"
fi

# ════════════════════════════════════════════════════════════════════════════
if want 6; then
echo "【6】派工后有新动静（评论 / 标签 / 本地提交）→ 计时重置；观察中断过久也重新计时"
scn activity; N=$SEQ
mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
tick 0; tick 60
add_comment "$N"; touch_item "$N" 01
tick 60
chk "新评论：到 120 秒也没催，从这一刻重新计时" "$(nudges "$N")/$(efield "$N" '.since')" "0/$NOW"
tick 60
jset "$GD/labels.json" '.[$n] += ["bug"]' --arg n "$N"; touch_item "$N" 02
tick 60
chk "标签变化：没催，重新计时" "$(nudges "$N")/$(efield "$N" '.since')" "0/$NOW"
tick 60
(cd "$W/wt/issue-$N" && echo y > g && gq add g && gq commit -qm work)
tick 60
chk "本地有新提交（还没推）：没催，重新计时" "$(nudges "$N")/$(efield "$N" '.since')" "0/$NOW"
tick 2000
chk "两次观察隔了 2000 秒（daemon 停过）：不把停机算成空闲，重新计时" "$(nudges "$N")/$(efield "$N" '.since')" "0/$NOW"
tick 60; tick 50
chk "对照 · 之后安静满 110 秒：催了" "$([ "$(nudges "$N")" -ge 1 ] && echo yes || echo no)" "yes"
fi

# ════════════════════════════════════════════════════════════════════════════
if want 7; then
echo "【7】PR 卡住、对应 issue 挂着 pending/PR（开 PR 后的正常状态）→ 照样走完阶梯"
scn prpath; N=$SEQ; P=$((SEQ + 1))
mk_issue "$N" pending/PR
mk_pr "$P" "feature/issue-$N" "Refs #$N" doing/agent
mk_wt "$N"; own "$N" pending/review; mk_sess "$N" codex review
tick 0; tick 60; tick 50
chk "催促文字真的进了工作窗格" "$([ "$(nudges "$N")" -ge 1 ] && echo yes || echo no)" "yes"
tick 60
chk "会话真的被结束" "$(alive "$N")" "no"
chk "PR 的标签回到原触发标签（复审）" "$(labels_of "$P")" "pending/review"
R0=$(runs "$N")
tick 10
chk "下一轮真的重派：PR 又挂上 doing/agent、会话又起来了" "$(labels_of "$P")/$(alive "$N")" "doing/agent/yes"
chk "重派起的是复审 agent（codex）" "$(tail -1 "$CTL/runs.issue-$N" | awk '{print $1}')/$([ "$(runs "$N")" -gt "$R0" ] && echo yes || echo no)" "codex/yes"
sleep 1; tick 10; tick 60; tick 50
chk "再卡住：PR 被标 pending/human" "$(labels_of "$P")" "pending/human"
chk "交人评论发在 PR 上，写的是改回复审标签" "$(jq -r --arg n "$P" '.[$n][-1].body' "$GD/comments.json" | grep -c '改回 `pending/review`')" "1"
chk "issue 上的 pending/PR 全程没被动过" "$(labels_of "$N")/$(writes_on "$N")" "pending/PR/0"

echo "【7b】对照：绑定的 issue 明确在等人 / 等前置 / 等机器人 → 不推进；两条都挂 doing/agent → 不处理"
for prot in pending/human pending/blocked pending/bot; do
    scn "bound$(printf '%s' "$prot" | tr -d /)" 'LABEL_PENDING_REQUESTER_BOT="pending/bot"'; N=$SEQ; P=$((SEQ + 1))
    mk_issue "$N" pending/PR "$prot"
    mk_pr "$P" "feature/issue-$N" "Refs #$N" doing/agent
    mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
    L0=$(cnt "repos/example/sw/issues " "$CALLS")
    tick 0; tick 60; tick 60; tick 60
    chk "issue 挂 $prot：PR 没被催、没被重派、没有写入" "$(nudges "$N")/$(alive "$N")/$(labels_of "$P")/$(writes_on "$P")" "0/yes/doing/agent/0"
    chk "到达性 · 这几轮确实读了 issue 列表（绑定条目的标签从这里来）" "$([ "$(cnt "repos/example/sw/issues " "$CALLS")" -gt "$L0" ] && echo yes || echo no)" "yes"
done
# 最后一个场景接着用：摘掉保护标签后同一条 PR 确实会推进
jset "$GD/labels.json" '.[$n] = ["pending/PR"]' --arg n "$N"; touch_item "$N" 05
tick 0; tick 60; tick 50
chk "对照 · 摘掉保护标签后：催了" "$([ "$(nudges "$N")" -ge 1 ] && echo yes || echo no)" "yes"
scn both; N=$SEQ; P=$((SEQ + 1))
mk_issue "$N" doing/agent
mk_pr "$P" "feature/issue-$N" "Refs #$N" doing/agent
mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
tick 0; tick 60; tick 60; tick 60
chk "issue 和 PR 同时挂 doing/agent：不催、不杀、不写" "$(nudges "$N")/$(alive "$N")/$(writes_on "$N")/$(writes_on "$P")" "0/yes/0/0"
chk "原因只记一次日志" "$(plog '共用一个会话')" "1"
fi

# ════════════════════════════════════════════════════════════════════════════
if want 8; then
echo "【8】动手前复查：初判之后、动手之前 GitHub 上变了 → 不写、不结束会话、不记完成"
scn precheck; N=$SEQ; P=$((SEQ + 1))
mk_issue "$N" pending/PR
mk_pr "$P" "feature/issue-$N" "Refs #$N" doing/agent
mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
tick 0; tick 60; tick 50
chk "夹具 · 已经催过" "$([ "$(nudges "$N")" -ge 1 ] && echo yes || echo no)" "yes"
I="$GD/items.json"
# 卡住检测自己动手的次数（结束会话 / 翻回触发标签 / 转人工）
acted() { cnt '卡住检测：.*\(已翻回\|转人工\)' "$W/state/poll.log"; }
# pre_case <名字> <钩子 key> <还原命令…> -- <改动命令…>
# 改动挂在「这一轮动手前第一次重读 PR」之前：这一轮开头的快照还是旧的，只有重读看得到。
pre_case() {
    local name="$1" key="$2"; shift 2
    local -a undo=() doit=()
    while [ "$1" != "--" ]; do undo+=("$1"); shift; done; shift
    doit=("$@")
    tick 0                                  # 新的空闲周期：记下身份串
    hook_next "$key" "${doit[@]}"
    local w0 a0; w0=$(writes_on "$P"); a0=$(acted)
    tick 110                                # 到点
    chk "$name · 到达性：改动发生在本轮动手前的重读之前" "$(hook_ran)" "yes"
    chk "$name：PR 上没有任何写入、会话还在、没记重派、没留待办" \
        "$(( $(writes_on "$P") - w0 ))/$(( $(acted) - a0 ))/$(alive "$N")/$(efield "$N" '.restarts // 0')/$(efield "$N" '.pending // ""')" "0/0/yes/0/"
    "${undo[@]}"
}
pre_case "PR 改了目标分支" "issues_$P" jset "$I" '.[$n].base.ref = "main"' --arg n "$P" -- \
                                   jset "$I" '.[$n].base.ref = "release"' --arg n "$P"
pre_case "PR 远端多了新提交" "issues_$P" jset "$I" '.[$n].head.sha = "1111111111111111111111111111111111111111"' --arg n "$P" -- \
                                   jset "$I" '.[$n].head.sha = "2222222222222222222222222222222222222222"' --arg n "$P"
pre_case "PR 换了来源仓库" "issues_$P" jset "$I" '.[$n].head.repo.full_name = "example/sw"' --arg n "$P" -- \
                                   jset "$I" '.[$n].head.repo.full_name = "fork/sw"' --arg n "$P"
pre_case "PR 缺字段（来源读不到）" "issues_$P" jset "$I" '.[$n].head.repo = {full_name: "example/sw"}' --arg n "$P" -- \
                                   jset "$I" '.[$n].head.repo = null' --arg n "$P"
pre_case "PR 多了一条评论（同一秒，updated_at 没变）" "issues_$P" true -- \
                                   jset "$GD/comments.json" '.[$n] = ((.[$n] // []) + [{id: 901, body: "等一下", user: {login: "maint"}}])' --arg n "$P"
pre_case "PR 标签变了" "issues_$P" jset "$GD/labels.json" '.[$n] = ["doing/agent"]' --arg n "$P" -- \
                                   jset "$GD/labels.json" '.[$n] = ["doing/agent", "bug"]' --arg n "$P"
pre_case "绑定的 issue 挂上 pending/human" "issues_$P" jset "$GD/labels.json" '.[$n] = ["pending/PR"]' --arg n "$N" -- \
                                   jset "$GD/labels.json" '.[$n] = ["pending/PR", "pending/human"]' --arg n "$N"
pre_case "绑定的 issue 多了一条评论" "issues_$P" true -- \
                                   jset "$GD/comments.json" '.[$n] = ((.[$n] // []) + [{id: 903, body: "先别动", user: {login: "maint"}}])' --arg n "$N"
pre_case "重读失败（PR 的评论读不到）" "issues_$P" rm -f "$GD/F_issues_${P}_comments" -- \
                                   touch "$GD/F_issues_${P}_comments"
pre_case "重读失败（PR 的标签事件读不到）" "issues_$P" rm -f "$GD/F_issues_${P}_events" -- \
                                   touch "$GD/F_issues_${P}_events"
pre_case "重读失败（绑定的 issue 读不到）" "issues_$P" rm -f "$GD/F_issues_$N" -- \
                                   touch "$GD/F_issues_$N"
# 对照：同样的节奏、什么都不改 → 这一轮确实动手了
tick 0; tick 110
chk "对照 · 什么都没变：到点真的结束会话、翻回触发标签" "$(alive "$N")/$(labels_of "$P")" "no/pending/agent"
# 交人那一步同样要过复查
tick 10; sleep 1; tick 10
chk "夹具 · 已重派" "$(labels_of "$P")/$(alive "$N")" "doing/agent/yes"
tick 0
hook_next "issues_$P" jset "$GD/comments.json" '.[$n] = ((.[$n] // []) + [{id: 902, body: "我来看", user: {login: "maint"}}])' --arg n "$P"
C0=$(comments_on "$P"); w0=$(writes_on "$P")
tick 110
chk "交人前复查 · 到达性" "$(hook_ran)" "yes"
chk "交人前 PR 多了一条评论：不留言、不翻标签" "$(( $(writes_on "$P") - w0 ))/$(labels_of "$P")/$(( $(comments_on "$P") - C0 ))" "0/doing/agent/1"
tick 0; tick 110
chk "对照 · 之后什么都没变：交人" "$(labels_of "$P")" "pending/human"
# 关闭 / 合并 / 绑定 issue 关闭：轮询里别的流程（合并后打 Done、清理）会接着处理这条 PR，
# 所以各用一套独立场景，只断言「卡住检测自己没动手」
for v in closed merged issue-closed; do
    scn "pre$v"; N=$SEQ; P=$((SEQ + 1))
    mk_issue "$N" pending/PR
    mk_pr "$P" "feature/issue-$N" "Refs #$N" doing/agent
    mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
    tick 0; tick 60; tick 50
    case "$v" in
        closed) hook_next "issues_$P" jset "$GD/items.json" '.[$n].state = "closed"' --arg n "$P" ;;
        merged) hook_next "issues_$P" jset "$GD/items.json" '.[$n].merged = true | .[$n].state = "closed"' --arg n "$P" ;;
        issue-closed) hook_next "issues_$P" jset "$GD/items.json" '.[$n].state = "closed"' --arg n "$N" ;;
    esac
    tick 60
    chk "动手前 $v · 到达性" "$(hook_ran)" "yes"
    chk "动手前 $v：卡住检测没动手、没记重派、PR 没被翻回触发标签" \
        "$(acted)/$(efield "$N" '.restarts // 0')/$(efield "$N" '.pending // ""')/$(labels_of "$P" | grep -c 'pending/agent')" "0/0//0"
done
fi

# ── 停住 / 恢复 用到的小工具（【9】【13】共用）─────────────────────────────────
# 人（默认 maint）在条目上打 / 摘一个标签：标签、事件记录、更新时间一起变，和真 GitHub 一样
HT=0
hlabel() {   # <编号> <add|rm> <标签> [谁]
    local n="$1" op="$2" l="$3" who="${4:-maint}" ev
    if [ "$op" = add ]; then
        ev=labeled; jset "$GD/labels.json" '.[$n] = (((.[$n] // []) + [$l]) | unique)' --arg n "$n" --arg l "$l"
    else
        ev=unlabeled; jset "$GD/labels.json" '.[$n] = ((.[$n] // []) - [$l])' --arg n "$n" --arg l "$l"
    fi
    jset "$GD/events.json" '.[$n] = ((.[$n] // []) + [{event: $ev, label: {name: $l}, actor: {login: $who, type: "User"}}])' \
        --arg n "$n" --arg ev "$ev" --arg l "$l" --arg who "$who"
    HT=$((HT + 1))
    jset "$GD/items.json" '.[$n].updated_at = $t' --arg n "$n" --arg t "$(printf '2026-03-01T%02d:%02d:%02dZ' $((HT / 3600)) $((HT / 60 % 60)) $((HT % 60)))"
}
frozen() { jq -r --arg n "$1" '(.stuck_workers[$n].frozen // null) != null' "$STATE"; }
ff() { jq -r --arg n "$1" ".stuck_workers[\$n].frozen.$2" "$STATE" 2>/dev/null; }
got() { cnt '' "$CTL/got.issue-$1"; }
# 这一条被派工的次数（三条派工路径的日志都算）
disp() { cnt "dispatch PR #$1 comment\|dispatch issue-comment for #$1 \|dispatch new issue #$1:" "$W/state/poll.log"; }
# 目标上的标签写请求 / 评论写请求条数
lwrites() { local c; c=$(grep -cE -- "-X (POST|DELETE) repos/example/sw/issues/$1/labels" "$CALLS" 2>/dev/null); printf '%s\n' "${c:-0}"; }
cposts() { local c; c=$(grep -cE -- "-X POST repos/example/sw/issues/$1/comments" "$CALLS" 2>/dev/null); printf '%s\n' "${c:-0}"; }
notes_on() { jq -r --arg n "$1" '[(.[$n] // [])[] | select(.body | contains("stuck-frozen:"))] | length' "$GD/comments.json"; }
# 从现在数第 <k> 次 GET 这个路径之前执行一条命令
hook_at() {   # <key> <第几次> <命令…>
    local key="$1" off="$2" k; shift 2
    k=$(( $(cat "$GD/count_$key" 2>/dev/null || echo 0) + off ))
    rm -f "$GD/hook.ran"
    { printf '%q ' "$@"; printf '\n'; printf 'touch %q\n' "$GD/hook.ran"; } > "$GD/hook_${key}_$k"
}
# 第 <k> 次给这个条目加标签**生效之后**执行一条命令（假 GitHub 自带的钩子）
hook_after_add() {   # <编号> <命令…>
    local n="$1" k; shift
    k=$(( $(cat "$GD/count_POST_issues_${n}_labels" 2>/dev/null || echo 0) + 1 ))
    rm -f "$GD/hook.ran"
    { printf '%q ' "$@"; printf '\n'; printf 'touch %q\n' "$GD/hook.ran"; } > "$GD/hook_after_POST_issues_${n}_labels_$k"
}
# 导出给钩子脚本用（钩子在假 GitHub 的子进程里跑）
export_hook_env() { export GD FAKEBIN CTL; }
# 钩子里用的「人打 / 摘标签」（独立脚本：钩子拿不到本文件里的函数）
cat > "$FAKEBIN/hlabel" <<'SH'
#!/usr/bin/env bash
# hlabel <假 GitHub 目录> <编号> <add|rm> <标签> [谁]
GD="$1"; n="$2"; op="$3"; l="$4"; who="${5:-maint}"; J="$(dirname "$0")/jset"
if [ "$op" = add ]; then ev=labeled; "$J" "$GD/labels.json" '.[$n] = (((.[$n] // []) + [$l]) | unique)' --arg n "$n" --arg l "$l"
else ev=unlabeled; "$J" "$GD/labels.json" '.[$n] = ((.[$n] // []) - [$l])' --arg n "$n" --arg l "$l"; fi
"$J" "$GD/events.json" '.[$n] = ((.[$n] // []) + [{event: $ev, label: {name: $l}, actor: {login: $who, type: "User"}}])' \
    --arg n "$n" --arg ev "$ev" --arg l "$l" --arg who "$who"
"$J" "$GD/items.json" '.[$n].updated_at = "2026-04-01T00:00:00Z"' --arg n "$n"
SH
chmod +x "$FAKEBIN/hlabel"
pr_scn() {   # <名字> [配置行…]：PR 挂 doing/agent、issue 挂 pending/PR，已催过、间隔将满
    scn "$@"; N=$SEQ; P=$((SEQ + 1))
    mk_issue "$N" pending/PR; mk_pr "$P" "feature/issue-$N" "Refs #$N" doing/agent
    mk_wt "$N"; own "$N" pending/review; mk_sess "$N" codex review
    tick 0; tick 60; tick 50
}
is_scn() {   # <名字> [配置行…]：issue 挂 doing/agent，已催过、间隔将满
    scn "$@"; N=$SEQ
    mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
    tick 0; tick 60; tick 50
}
# 停住一条 PR（重派时摘 doing/agent 失败），并等到说明发出、恢复起点记下。
# 结束时：PR 标签 doing/agent + pending/review，会话还在，停住，起点已记。
frozen_pr() {   # <名字> [配置行…]
    pr_scn "$@"
    touch "$GD/F_delete_labels"; tick 60; rm -f "$GD/F_delete_labels"
    tick 0; tick 0
}
# 同上，issue 版（重派时摘 doing/agent 失败）：标签 doing/agent + pending/agent
frozen_is() {   # <名字> [配置行…]
    is_scn "$@"
    touch "$GD/F_delete_labels"; tick 60; rm -f "$GD/F_delete_labels"
    tick 0; tick 0
}
# 人按停住说明恢复：摘净流程标签，再打上一枚派工标签
human_resume() {   # <编号> <派工标签> <现有的流程标签…>
    local n="$1" x="$2" l; shift 2
    for l in "$@"; do hlabel "$n" rm "$l"; done
    hlabel "$n" add "$x"
}

# ════════════════════════════════════════════════════════════════════════════
if want 9; then
echo "【9】重派 / 交人的写入出异常 → 当场停住：不撤回、不重试、不续做；发说明；之后不派工"
# 9a 复审第 6 轮的复现：加上复审标签之后、摘 doing/agent 之前，关联的 issue 被人挂上 pending/human
pr_scn frz1
hook_after_add "$P" "$FAKEBIN/hlabel" "$GD" "$N" add pending/human
tick 60
chk "9a 到达性：暂停发生在加标签生效之后" "$(hook_ran)" "yes"
chk "9a 当轮停住：没摘 doing/agent、没撤回加上的标签、没结束会话、没记重派" \
    "$(frozen "$N")/$(labels_of "$P")/$(cnt "DELETE repos/example/sw/issues/$P/labels" "$CALLS")/$(alive "$N")/$(efield "$N" '.restarts // 0')" \
    "true/doing/agent,pending/review/0/yes/0"
chk "9a 停住范围包括 PR 和关联的 issue" "$(ff "$N" 'items | sort | join(",")')" "$N,$P"
w0=$(lwrites "$P"); g0=$(got "$N"); d0=$(disp "$P")
tick 10; tick 60; tick 110
chk "9a 之后三轮：没有派工、会话没收到新输入、PR 上没有标签写入（遗留的复审标签不算派工信号）" \
    "$(( $(disp "$P") - d0 ))/$(( $(got "$N") - g0 ))/$(( $(lwrites "$P") - w0 ))/$(labels_of "$P")" "0/0/0/doing/agent,pending/review"
chk "9a 到达性：派工队列确实看到这条挂着复审标签并跳过" "$([ "$(plog "本轮不派工的条目.*pr#$P(pending/review)")" -ge 1 ] && echo yes || echo no)" "yes"
chk "9a 停住说明发了一条，带记号，写明现状和恢复办法" \
    "$(notes_on "$P")/$(jq -r --arg n "$P" '.[$n][-1].body' "$GD/comments.json" | grep -c '已对这一条停手')/$(jq -r --arg n "$P" '.[$n][-1].body' "$GD/comments.json" | grep -c '怎么恢复')/$(jq -r --arg n "$P" '.[$n][-1].body' "$GD/comments.json" | grep -c '标签 `doing/agent`、`pending/review`')" "1/1/1/1"
chk "9a 说明里不用「你 / 我」" "$(jq -r --arg n "$P" '.[$n][-1].body' "$GD/comments.json" | grep -c '[你我]')" "0"
chk "9a 说明确认发出、恢复起点已记" "$(ff "$N" posted)/$(ff "$N" 'base != null')" "yes/true"

# 9b 每个写入点出错各一例 → 当轮停住，之后不派工、不重试
frz_case() {   # <名字> <restart|human> <期望的标签> <故障注入命令…>
    local name="$1" step="$2" want_labels="$3"; shift 3
    local extra=(); [ "$step" = human ] && extra=('STUCK_WORKER_MAX_RESTARTS=0')
    is_scn "frz$((++FRZN))" ${extra[@]+"${extra[@]}"}
    "$@"
    tick 60
    rm -f "$GD"/F_post_labels "$GD"/F_delete_labels "$GD"/F_post_comment "$GD/F_issues_${N}_events"
    chk "$name：当轮停住，会话还在，没记重派" "$(frozen "$N")/$(alive "$N")/$(efield "$N" '.restarts // 0')/$(labels_of "$N")" "true/yes/0/$want_labels"
    local w0 d0 r0; w0=$(lwrites "$N"); d0=$(disp "$N"); r0=$(runs "$N")
    tick 10; tick 60; tick 110
    chk "$name：之后三轮不重试写标签、不派工、不起新进程，只发了停住说明" \
        "$(( $(lwrites "$N") - w0 ))/$(( $(disp "$N") - d0 ))/$(( $(runs "$N") - r0 ))/$(notes_on "$N")/$(alive "$N")" "0/0/0/1/yes"
}
FRZN=1
frz_case "9b 重派 · 加触发标签失败" restart "doing/agent" eval 'touch "$GD/F_post_labels"'
frz_case "9b 重派 · 摘 doing/agent 失败" restart "doing/agent,pending/agent" eval 'touch "$GD/F_delete_labels"'
chk "9b 重派 · 摘失败后两个标签都在：派工队列看到 pending/agent 并跳过" "$([ "$(plog "本轮不派工的条目.*issue#$N(pending/agent)")" -ge 1 ] && echo yes || echo no)" "yes"
frz_case "9b 交人 · 说明评论没发成" human "doing/agent" eval 'touch "$GD/F_post_comment"'
frz_case "9b 交人 · 加 pending/human 失败" human "doing/agent" eval 'touch "$GD/F_post_labels"'
frz_case "9b 交人 · 摘 doing/agent 失败" human "doing/agent,pending/human" eval 'touch "$GD/F_delete_labels"'
frz_case "9b 重派 · 写完读不到标签记录" restart "doing/agent,pending/agent" eval 'hook_after_add "$N" touch "$GD/F_issues_${N}_events"'
frz_case "9b 重派 · 写完多出别人的标签事件" restart "bug,doing/agent,pending/agent" eval 'hook_after_add "$N" "$FAKEBIN/hlabel" "$GD" "$N" add bug'
frz_case "9b 重派 · 两次写入之间 agent 又忙了" restart "doing/agent,pending/agent" eval 'hook_after_add "$N" bash -c "printf \"%s\\n\" \"$BUSY_CLAUDE\" > \"$CTL/screen.issue-$N\"; sleep 0.8"'

# 9c 第一次写入之前读不到 → 什么都没写，重新计时，不算停住；读得到之后照常重派
is_scn nofrz
touch "$GD/F_issues_${N}_comments"
tick 60
chk "9c 动手前读不全：没写、没停住、重新计时" "$(writes_on "$N")/$(frozen "$N")/$(efield "$N" '.since')" "0/false/0"
rm -f "$GD/F_issues_${N}_comments"
tick 0; tick 110
chk "9c 对照 · 读得到之后：正常重派，没停住" "$(labels_of "$N")/$(alive "$N")/$(efield "$N" '.restarts')/$(frozen "$N")" "pending/agent/no/1/false"

echo "【9】停住说明：发前两次读取、结果不明先确认、发出之后才记恢复起点"
# 9d 说明发不出去期间人打的派工标签不算；发出、记下起点之后也不算，要重新打一次
is_scn note1
touch "$GD/F_delete_labels" "$GD/F_post_comment"; tick 60; rm -f "$GD/F_delete_labels"
chk "9d 夹具：停住，标签 doing/agent + pending/agent" "$(frozen "$N")/$(labels_of "$N")" "true/doing/agent,pending/agent"
tick 0
chk "9d 说明没发出去：计一次失败，没有起点" "$(ff "$N" tries)/$(ff "$N" posted)/$(ff "$N" base)/$(notes_on "$N")" "1/unknown/null/0"
human_resume "$N" pending/agent doing/agent pending/agent
d0=$(disp "$N"); tick 0
chk "9d 说明没发出去时人按恢复办法打了标签：不派工" "$(( $(disp "$N") - d0 ))/$(labels_of "$N")/$(ff "$N" tries)" "0/pending/agent/2"
rm -f "$GD/F_post_comment"
tick 0
chk "9d 说明发出去了" "$(ff "$N" posted)/$(notes_on "$N")" "yes/1"
tick 0
chk "9d 起点记在说明发出之后：不早于人刚才那次打标签" \
    "$([ "$(ff "$N" base)" -ge "$(jq -r --arg n "$N" '[.[$n] | to_entries[] | select(.value.actor.login == "maint") | (5000 + .key)] | last' "$GD/events.json")" ] && echo yes || echo no)" "yes"
tick 0; tick 10
chk "9d 说明发出前打的标签不算：仍停住、不派工" "$(frozen "$N")/$(( $(disp "$N") - d0 ))/$(labels_of "$N")" "true/0/pending/agent"
chk "9d 到达性：派工队列看到 pending/agent 并跳过" "$([ "$(plog "本轮不派工的条目.*issue#$N(pending/agent)")" -ge 1 ] && echo yes || echo no)" "yes"
human_resume "$N" pending/agent pending/agent
tick 0
chk "9d 对照 · 说明之后重新打一次：派工，换成 doing/agent，停住记录清掉" "$(( $(disp "$N") - d0 ))/$(labels_of "$N")/$(entry "$N")" "1/doing/agent/{}"

# 9e 发送结果不明：评论读不全 → 不重发、不记起点；读全后找到带记号的那条 → 认作已发出
is_scn note2
touch "$GD/F_delete_labels" "$GD/F_post_comment"; tick 60; rm -f "$GD/F_delete_labels"
tick 0
c0=$(cposts "$N")
touch "$GD/F_issues_${N}_comments"
tick 0; tick 0
chk "9e 结果不明且评论读不全：不重发、不计失败、没有起点" "$(( $(cposts "$N") - c0 ))/$(ff "$N" tries)/$(ff "$N" posted)/$(ff "$N" base)" "0/1/unknown/null"
# 其实上一次发出去了（响应丢了）：评论在 GitHub 上，带着这次的记号
jset "$GD/comments.json" '.[$n] = ((.[$n] // []) + [{id: 7777, body: ("<!-- stuck-frozen:" + $t + " -->\n说明"), user: {login: "loop-bot"}}])' --arg n "$N" --arg t "$(ff "$N" token)"
rm -f "$GD/F_issues_${N}_comments"
tick 0
chk "9e 读全后找到带记号的评论：认作已发出，不再发第二条" "$(ff "$N" posted)/$(ff "$N" comment)/$(( $(cposts "$N") - c0 ))" "yes/7777/0"
# 别人贴了一条带同样记号的评论不算（要写账号发的）
is_scn note2b
touch "$GD/F_delete_labels" "$GD/F_post_comment"; tick 60; rm -f "$GD/F_delete_labels"
tick 0
jset "$GD/comments.json" '.[$n] = ((.[$n] // []) + [{id: 7778, body: ("<!-- stuck-frozen:" + $t + " -->"), user: {login: "someone"}}])' --arg n "$N" --arg t "$(ff "$N" token)"
rm -f "$GD/F_post_comment"
tick 0
chk "9e 别人贴的带记号评论不算：daemon 自己重发一条" "$(ff "$N" posted)/$([ "$(ff "$N" comment)" != 7778 ] && echo own || echo theirs)" "yes/own"

# 9f 发前两次读取之间条目变了 → 这一轮不发、不计失败；条目关闭 → 不发，记录留着
is_scn note3
touch "$GD/F_delete_labels"; tick 60; rm -f "$GD/F_delete_labels"
c0=$(cposts "$N")
hook_at "issues_$N" 2 "$FAKEBIN/hlabel" "$GD" "$N" add bug
tick 0
chk "9f 到达性：改动发生在发说明前的第二次读取之前" "$(hook_ran)" "yes"
chk "9f 两次读到的不一样：这一轮不发、不计失败" "$(( $(cposts "$N") - c0 ))/$(ff "$N" tries)/$(ff "$N" posted)" "0/0/no"
tick 0
chk "9f 对照 · 下一轮没再变：发出" "$(ff "$N" posted)/$(notes_on "$N")" "yes/1"
for v in base head src; do
    pr_scn "note3$v"
    touch "$GD/F_delete_labels"; tick 60; rm -f "$GD/F_delete_labels"
    c0=$(cposts "$P")
    case "$v" in
        base) hook_at "issues_$P" 2 "$FAKEBIN/jset" "$GD/items.json" '.[$n].base.ref = "release"' --arg n "$P" ;;
        head) hook_at "issues_$P" 2 "$FAKEBIN/jset" "$GD/items.json" '.[$n].head.sha = "2222222222222222222222222222222222222222"' --arg n "$P" ;;
        src)  hook_at "issues_$P" 2 "$FAKEBIN/jset" "$GD/items.json" '.[$n].head.repo.full_name = "fork/sw"' --arg n "$P" ;;
    esac
    tick 0
    chk "9f PR 的 $v 在两次读取之间变了：到达、这一轮不发、不计失败" "$(hook_ran)/$(( $(cposts "$P") - c0 ))/$(ff "$N" tries)" "yes/0/0"
done
is_scn note4
touch "$GD/F_delete_labels"; tick 60; rm -f "$GD/F_delete_labels"
jset "$GD/items.json" '.[$n].state = "closed"' --arg n "$N"
tick 0; tick 0
chk "9f 发说明前条目被关闭：不发，停住记录留着" "$(notes_on "$N")/$(frozen "$N")" "0/true"
jset "$GD/items.json" '.[$n].state = "open"' --arg n "$N"
d0=$(disp "$N"); tick 0; tick 0; tick 0
chk "9f 重新打开：仍然停住（遗留的 pending/agent 不派工），说明这时发出" "$(frozen "$N")/$(( $(disp "$N") - d0 ))/$(notes_on "$N")" "true/0/1"

# 9g 说明一直发不出去：满 10 次不再发，继续停住，日志里给出本机解卡命令
is_scn note5
touch "$GD/F_delete_labels" "$GD/F_post_comment"; tick 60; rm -f "$GD/F_delete_labels"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13; do tick 5; done
chk "9g 连续失败：只发 10 次，仍停住、没有起点" "$(cposts "$N")/$(ff "$N" tries)/$(frozen "$N")/$(ff "$N" base)" "10/10/true/null"
chk "9g 日志里写了本机解卡命令" "$([ "$(plog "stuck-release.sh .* $N")" -ge 1 ] && echo yes || echo no)" "yes"
human_resume "$N" pending/agent doing/agent pending/agent
rm -f "$GD/F_post_comment"; d0=$(disp "$N")
tick 5; tick 5
chk "9g 没有说明就没有起点：人怎么打标签都不派工" "$(( $(disp "$N") - d0 ))/$(frozen "$N")" "0/true"

# 9h 起点读不到：说明已发出，标签记录读不全 → 不记起点；期间人打的标签落在起点之前，不算
is_scn base1
touch "$GD/F_delete_labels"; tick 60; rm -f "$GD/F_delete_labels"
# 说明发出那一轮里，读标签事件的顺序是：发前第一次读、发前第二次读、记起点。让第三次起读不到
hook_at "issues_${N}_events" 2 touch "$GD/F_issues_${N}_events"
tick 0; tick 0
chk "9h 标签记录读不全：说明已发出，但没有起点" "$(ff "$N" posted)/$(ff "$N" base)" "yes/null"
human_resume "$N" pending/agent doing/agent pending/agent
tick 0
rm -f "$GD/F_issues_${N}_events"; d0=$(disp "$N")
tick 0; tick 0; tick 0
chk "9h 读全后记下起点；之前打的标签不算，不派工" "$(ff "$N" 'base != null')/$(( $(disp "$N") - d0 ))/$(frozen "$N")" "true/0/true"
fi

# ════════════════════════════════════════════════════════════════════════════
# 本机解卡命令：照 docs/operations.zh.md 里那段命令的字面跑（项目名、编号两行换成本场景的值）。
# 环境只有 HOME 和 PATH；项目的环境文件、技能目录都按真实安装的位置摆在假 HOME 下。
OPS_BLOCK() { sed -n '/<!-- stuck-release-ops:begin -->/,/<!-- stuck-release-ops:end -->/p' "$1" | sed -n '/^```bash$/,/^```$/p' | sed '1d;$d'; }
release_cmd() {   # <编号> <喂给确认提示的输入> [额外环境…] → 输出在 $W/release.out，返回退出码
    local num="$1" input="$2"; shift 2
    mkdir -p "$HOME/.config/cavil-loop" "$HOME/.agents/skills"
    ln -sfn "$NEW" "$HOME/.agents/skills/cavil-loop"
    printf 'CODING_AGENT_CONFIG=%s\nPATH=%s\nTMUX_TMPDIR=%s\nFAKE_GH_DIR=%s\nFAKE_GH_LISTS=1\nFAKE_GH_REPO=example/sw\nGIT_CONFIG_GLOBAL=/dev/null\n' \
        "$CONF" "$PATH" "$TMUX_DIR" "$GD" > "$HOME/.config/cavil-loop/swproj.conf"
    OPS_BLOCK "$REPO_DIR/docs/operations.zh.md" | sed -e "s/^KEY=.*/KEY=swproj/" -e "s/^N=.*/N=$num/" > "$W/release.sh"
    local rc=0
    printf '%s' "$input" | env -i HOME="$HOME" PATH="$PATH" "$@" bash "$W/release.sh" > "$W/release.out" 2>&1 || rc=$?
    return "$rc"
}

if want 13; then
echo "【13】人恢复：说明之后打上的派工标签，要到派工那一刻仍然有效"
# 13a 各种「不算恢复」，最后一步才是有效的恢复
frozen_pr rel1
step() {   # <说明>：跑一轮，断言没派工、仍停住
    local d0 w0 g0; d0=$(disp "$P"); w0=$(lwrites "$P"); g0=$(got "$N")
    tick 5
    chk "13a $1：不派工、不写标签、会话没收到输入、仍停住" "$(( $(disp "$P") - d0 ))/$(( $(lwrites "$P") - w0 ))/$(( $(got "$N") - g0 ))/$(frozen "$N")" "0/0/0/true"
}
hlabel "$P" add bug;                step "只加分类标签"
hlabel "$P" rm doing/agent;         step "只摘 doing/agent（遗留 pending/review）"
chk "13a 到达性：派工队列看到遗留的 pending/review 并跳过" "$([ "$(plog "本轮不派工的条目.*pr#$P(pending/review)")" -ge 1 ] && echo yes || echo no)" "yes"
hlabel "$P" add pending/agent;      step "打上 pending/agent，但 pending/review 还留着"
hlabel "$P" rm pending/agent;       step "打上又摘掉（撤回），pending/review 还留着"
hlabel "$P" rm pending/review;      step "流程标签全摘了、没打派工标签"
hlabel "$P" add pending/agent; hlabel "$P" add pending/human;  step "打上 pending/agent 之后又挂 pending/human"
hlabel "$P" rm pending/human;       step "摘掉 pending/human（最后一次流程标签变化不是打派工标签）"
hlabel "$P" add pending/blocked;    step "挂等前置标签"
hlabel "$P" rm pending/blocked; hlabel "$P" rm pending/agent
hlabel "$N" add pending/human; hlabel "$P" add pending/agent;  step "打上 pending/agent，但关联的 issue 挂着 pending/human"
R0=$(runs "$N"); d0=$(disp "$P")
hlabel "$N" rm pending/human
tick 5
chk "13a 正向对照 · 关联 issue 的 pending/human 摘掉后：按 pending/agent 派工一次，换成 doing/agent，停住记录清掉" \
    "$(( $(disp "$P") - d0 ))/$(labels_of "$P")/$(entry "$N")/$([ "$(runs "$N")" -gt "$R0" ] && echo yes || echo no)" "1/bug,doing/agent/{}/yes"
chk "13a 派工用的是人打的那一枚标签" "$(jq -r --arg n "$N" '.worker_trigger_labels[$n]' "$STATE")" "pending/agent"
tick 10
chk "13a 之后照常：不再重复派工" "$(( $(disp "$P") - d0 ))/$(labels_of "$P")" "1/bug,doing/agent"

echo "【13】派工前最后一次现读：初筛之后人撤回 / 暂停 → 不翻标签、不启动会话、不送任务"
# 13b 三条派工路径各一例。改动挂在这一轮第二次读目标条目之前：第一次是卡住检测的初筛，
# 派工脚本的最后一次核对在它之后
final_case() {   # <名字> <pr|issue|new> <改动命令（钩子里跑）…>
    local name="$1" path="$2" T0; shift 2
    if [ "$path" = pr ]; then frozen_pr "fin$((++FINN))"; T0=$P; human_resume "$P" pending/agent doing/agent pending/review
    else frozen_is "fin$((++FINN))"; T0=$N; human_resume "$N" pending/agent doing/agent pending/agent; fi
    if [ "$path" = new ]; then
        T kill-session -t "=$(sess_of "$N")"; gq -C "$W/project" worktree remove --force "$W/wt/issue-$N"
    fi
    local r0 g0 w0; r0=$(runs "$N"); g0=$(got "$N"); w0=$(lwrites "$T0")
    hook_at "issues_$T0" 2 "$@"
    tick 5
    chk "$name · 到达性：改动发生在初筛之后；派工脚本确实跑到了最后一次核对" "$(hook_ran)/$(plog "#$T0 派工前最后一次核对没过")" "yes/1"
    chk "$name：没翻标签、没起新进程、会话没收到任务、仍停住、指令没用掉" \
        "$(( $(lwrites "$T0") - w0 ))/$(( $(runs "$N") - r0 ))/$(( $(got "$N") - g0 ))/$(frozen "$N")/$(ff "$N" used)" "0/0/0/true/null"
    [ "$path" != new ] || chk "$name：没有启动会话" "$(alive "$N")" "no"
}
FINN=0
final_case "13b PR 评论路径 · 人摘掉派工标签" pr "$FAKEBIN/hlabel" "$TMP/sc.fin1/gh" "$((SEQ + 11))" rm pending/agent
final_case "13b PR 评论路径 · 关联 issue 被挂上 pending/human" pr "$FAKEBIN/hlabel" "$TMP/sc.fin2/gh" "$((SEQ + 10))" add pending/human
final_case "13b issue 评论路径 · 人摘掉派工标签" issue "$FAKEBIN/hlabel" "$TMP/sc.fin3/gh" "$((SEQ + 10))" rm pending/agent
final_case "13b 新建路径 · 人摘掉派工标签" new "$FAKEBIN/hlabel" "$TMP/sc.fin4/gh" "$((SEQ + 10))" rm pending/agent
final_case "13b PR 评论路径 · 初筛之后 PR 推了新提交" pr "$FAKEBIN/jset" "$TMP/sc.fin5/gh/items.json" '.[$n].head.sha = "2222222222222222222222222222222222222222"' --arg n "$((SEQ + 11))"
# 正向对照：新建路径什么都不改 → 起会话、换成 doing/agent、记录清掉
frozen_is finok; human_resume "$N" pending/agent doing/agent pending/agent
T kill-session -t "=$(sess_of "$N")"; gq -C "$W/project" worktree remove --force "$W/wt/issue-$N"
tick 5
chk "13b 正向对照 · 新建路径：起了会话、换成 doing/agent、停住记录清掉" "$(alive "$N")/$(labels_of "$N")/$(entry "$N")" "yes/doing/agent/{}"

echo "【13】恢复指令只用一次：用掉之后派工没确认成功 → 重新停住，同一条指令不再派工；不进普通失败兜底"
# after_freeze <名字> <目标> <说明里应有的字样>：这一轮之后 → 重新停住（新记号）、指令已用掉；
# 再跑两轮：不再派工、不起新进程、不再送任务，派工标签还在也一样
after_refreeze() {
    local name="$1" T0="$2" phrase="$3" tok="$4" r0 g0 d0
    chk "$name：重新停住（新的一次：新记号、说明待发），这条指令记为已用掉" \
        "$(frozen "$N")/$([ "$(ff "$N" token)" != "$tok" ] && echo new || echo same)/$(ff "$N" 'used != null')/$(ff "$N" why | grep -c "$phrase")" "true/new/true/1"
    r0=$(runs "$N"); g0=$(got "$N"); d0=$(disp "$T0")
    tick 5; tick 5
    chk "$name：之后两轮不再派工、不起新进程、不再送任务" "$(( $(disp "$T0") - d0 ))/$(( $(runs "$N") - r0 ))/$(( $(got "$N") - g0 ))/$(frozen "$N")" "0/0/0/true"
}
# 13c① PR 评论路径：最后一次核对通过之后，换程序失败（任务没送成）。这一条的普通失败计数已经是
#       「再失败一次就交人」；同一轮里另一条没停住的 issue 也在同样的计数上、同样失败（对照）
frozen_pr use1; M=$((SEQ + 5))
mk_issue "$M" pending/agent; mk_wt "$M"; own "$M" pending/agent; mk_sess "$M" codex review
mkdir -p "$W/state/dispatch-fail"; echo 2 > "$W/state/dispatch-fail/pr-$P"; echo 2 > "$W/state/dispatch-fail/issue-$M"
human_resume "$P" pending/agent doing/agent pending/review
tok=$(ff "$N" token); c0=$(comments_on "$P")
printf '%s\n' 'respawn-pane*' > "$CTL/fault"
tick 5
rm -f "$CTL/fault"
chk "13c① 到达性：核对通过、指令用掉之后才失败" "$(plog "#$P 派工前最后一次核对通过")/$([ -s "$CTL/fault.hits" ] && echo hit || echo miss)" "1/hit"
chk "13c① 不进普通失败兜底：没有普通的转人工留言、没翻 pending/human、失败计数没动、评论读取位置没前进" \
    "$(jq -r --arg n "$P" '[(.[$n] // [])[] | select(.body | contains("自动处理已暂停"))] | length' "$GD/comments.json")/$(labels_of "$P")/$(cat "$W/state/dispatch-fail/pr-$P")/$(jq -r --arg n "$P" '.seen_comments[$n] // "none"' "$STATE")" \
    "0/pending/agent/2/none"
chk "13c① 对照 · 没停住的那条照原规则：第 3 次失败 → 留言并翻 pending/human" \
    "$(jq -r --arg n "$M" '[(.[$n] // [])[] | select(.body | contains("自动处理已暂停"))] | length' "$GD/comments.json")/$(labels_of "$M")" "1/pending/human"
after_refreeze "13c①" "$P" "任务可能已送出" "$tok"
# 重新授权：新说明发出、新起点之后，人再打一次 → 正常派工一次
tick 0
chk "13c① 新的停住说明发出（第二条）" "$(notes_on "$P")/$(ff "$N" posted)" "2/yes"
d0=$(disp "$P"); human_resume "$P" pending/agent pending/agent
tick 5
chk "13c① 重新授权 · 人再打一次：派工一次，换成 doing/agent，停住记录清掉，失败计数清零" \
    "$(( $(disp "$P") - d0 ))/$(labels_of "$P")/$(entry "$N")/$([ -e "$W/state/dispatch-fail/pr-$P" ] && echo kept || echo reset)" "1/doing/agent/{}/reset"

# 13c② 新建路径：会话已经起来，翻标签时加 doing/agent 失败（派工标签已摘掉）
frozen_is use2; human_resume "$N" pending/agent doing/agent pending/agent
T kill-session -t "=$(sess_of "$N")"; gq -C "$W/project" worktree remove --force "$W/wt/issue-$N"
tok=$(ff "$N" token); touch "$GD/F_post_labels"
tick 5
rm -f "$GD/F_post_labels"
chk "13c② 夹具：会话起来了，但条目上没有 doing/agent" "$(alive "$N")/$(labels_of "$N")" "yes/"
after_refreeze "13c②" "$N" "任务已送出，会话" "$tok"
chk "13c② 会话原样留着" "$(alive "$N")" "yes"

# 13c③ issue 评论路径：任务已经送进现有会话，翻标签时摘派工标签失败（结果：两个标签都在）
frozen_is use3; human_resume "$N" pending/agent doing/agent pending/agent
tok=$(ff "$N" token); g0=$(got "$N"); touch "$GD/F_delete_labels"
tick 5
rm -f "$GD/F_delete_labels"
chk "13c③ 夹具：任务送进了会话；派工标签没摘掉" "$([ "$(got "$N")" -gt "$g0" ] && echo sent || echo no)/$(labels_of "$N")" "sent/doing/agent,pending/agent"
after_refreeze "13c③" "$N" "任务已送出，会话" "$tok"
chk "13c③ 到达性：之后派工队列看到遗留的 pending/agent 并跳过" "$([ "$(plog "本轮不派工的条目.*issue#$N(pending/agent)")" -ge 2 ] && echo yes || echo no)" "yes"

# 13c④ 派工之后读不到条目
frozen_is use4; human_resume "$N" pending/agent doing/agent pending/agent
tok=$(ff "$N" token)
hook_after_add "$N" touch "$GD/F_issues_$N"
tick 5
rm -f "$GD/F_issues_$N"
chk "13c④ 到达性：翻标签之后才读不到" "$(hook_ran)/$(labels_of "$N")" "yes/doing/agent"
after_refreeze "13c④" "$N" "读不到条目的标签" "$tok"

# 13c⑤ 「指令已用掉」写不进本地 → 不派工，什么都没送出，指令没用掉；写得进之后正常派工
frozen_is use5; human_resume "$N" pending/agent doing/agent pending/agent
g0=$(got "$N"); w0=$(lwrites "$N")
echo x > "$W/state/stuck-release"
tick 5
chk "13c⑤ 写不进：没送任务、没翻标签、仍停住、指令没用掉" "$(( $(got "$N") - g0 ))/$(( $(lwrites "$N") - w0 ))/$(frozen "$N")/$(ff "$N" used)" "0/0/true/null"
chk "13c⑤ 到达性：派工脚本跑到了这一步" "$(plog "#$N 记不下「恢复指令已用掉」")" "1"
rm -f "$W/state/stuck-release"
tick 5
chk "13c⑤ 对照 · 写得进之后：派工，记录清掉" "$(labels_of "$N")/$(entry "$N")/$([ "$(got "$N")" -gt "$g0" ] && echo sent || echo no)" "doing/agent/{}/sent"

# 13c⑥ 成功不只看标签：派工期间人自己打了 doing/agent → 不算这次派工成功
frozen_is use6; human_resume "$N" pending/agent doing/agent pending/agent
tok=$(ff "$N" token)
k=$(( $(cat "$GD/count_POST_issues_${N}_labels" 2>/dev/null || echo 0) + 1 ))
printf '%q ' "$FAKEBIN/hlabel" "$GD" "$N" add doing/agent > "$GD/hook_POST_issues_${N}_labels_$k"
tick 5
chk "13c⑥ 夹具：标签看起来和成功一模一样" "$(labels_of "$N")" "doing/agent"
after_refreeze "13c⑥" "$N" "不属于这次派工的标签变化" "$tok"
# 13c⑦ 会话上的记号不是这一次的 → 不算成功
frozen_is use7; human_resume "$N" pending/agent doing/agent pending/agent
tok=$(ff "$N" token)
hook_after_add "$N" "$REAL_TMUX" -S "$SOCK" set-option -t "=$(sess_of "$N"):" @dispatch_token someone-else
tick 5
chk "13c⑦ 到达性" "$(hook_ran)/$(labels_of "$N")" "yes/doing/agent"
after_refreeze "13c⑦" "$N" "任务可能已送出" "$tok"

# 13c⑧ 派工脚本没走到最后一次核对就退出（读不到会话记录）：不算派工；连着 3 次 → 用掉指令、重新停住
frozen_is use8; human_resume "$N" pending/agent doing/agent pending/agent
tok=$(ff "$N" token); g0=$(got "$N")
printf '%s\n' 'show-options*@worker_model' > "$CTL/fault"
tick 5; tick 5
chk "13c⑧ 前两次：不算派工，仍是原来那次停住，指令没用掉，没有普通失败计数" \
    "$(ff "$N" miss)/$([ "$(ff "$N" token)" = "$tok" ] && echo same || echo new)/$(ff "$N" used)/$([ -e "$W/state/dispatch-fail/issue-$N" ] && echo counted || echo none)" "2/same/null/none"
tick 5
rm -f "$CTL/fault"
chk "13c⑧ 第三次：用掉这条指令、重新停住，任务没送出" "$([ "$(ff "$N" token)" != "$tok" ] && echo new || echo same)/$(ff "$N" 'used != null')/$(ff "$N" why | grep -c '任务没有送出')/$(( $(got "$N") - g0 ))" "new/true/1/0"
d0=$(disp "$N"); tick 5; tick 5
chk "13c⑧ 之后不再每轮空转" "$(( $(disp "$N") - d0 ))" "0"

echo "【13】停住期间，会动这一条的各个环节都跳过它（每例都有「没停住的同类条目照常处理」或解除后照常处理的对照）"
# 13d① 自愈：会话不在了也不翻标签
frozen_is con1; M=$((SEQ + 5))
mk_issue "$M" doing/agent; own "$M" pending/agent
T kill-session -t "=$(sess_of "$N")"
w0=$(lwrites "$N")
tick 5
chk "13d① 自愈跳过停住的条目；同一轮里没停住的那条照常翻回触发标签" \
    "$(( $(lwrites "$N") - w0 ))/$(labels_of "$N")/$(plog "self-heal 跳过（卡住检测已对它停手.*issue#$N")/$(labels_of "$M" | grep -c 'pending/agent\|doing/agent')" "0/doing/agent,pending/agent/1/1"
# 13d② 完工会话回收：doing/agent 被摘了，会话也不结束
frozen_is con2 'REAP_GRACE_SECS=0'; M=$((SEQ + 5))
mk_issue "$M" pending/human; mk_wt "$M"; own "$M" pending/agent; mk_sess "$M" claude worker
hlabel "$N" rm doing/agent
sleep 1; tick 5
chk "13d② 回收跳过停住的条目（会话还在）；同一轮里没停住的完工会话照常回收" \
    "$(alive "$N")/$([ "$(plog "回收暂缓.*issue #$N 卡住检测已对它停手")" -ge 1 ] && echo yes || echo no)/$(alive "$M")" "yes/yes/no"
# 13d③ 等前置：前置完成了也不翻回、不留言
frozen_is con3; M=$((SEQ + 5)); Q=$((SEQ + 6))
echo '{}' > "$GD/blocked_by.json"
jset "$GD/items.json" '.[$n] = {kind:"issue", state:"closed", state_reason:"completed", title:"前置", body:"x", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}' --arg n "$Q"
blocked_fix() {   # <编号>：挂等前置标签 + 登记等 #Q
    jset "$GD/comments.json" '.[$n] = ((.[$n] // []) + [{id: (8000 + ([.[][]] | length)), body: ("## 在等前置\n\n<!-- agent-blocked-by: #" + $q + " resume=pending/agent -->"), user: {login: "loop-bot"}, author_association: "COLLABORATOR", created_at: "2026-05-01T00:00:00Z"}])' --arg n "$1" --arg q "$Q"
}
mk_issue "$M"; hlabel "$M" add pending/blocked loop-bot; blocked_fix "$M"
hlabel "$N" rm doing/agent; hlabel "$N" rm pending/agent; hlabel "$N" add pending/blocked loop-bot; blocked_fix "$N"
w0=$(writes_on "$N")
tick 5
chk "13d③ 等前置跳过停住的条目；同一轮里没停住的那条照常翻回并留言" \
    "$(( $(writes_on "$N") - w0 ))/$(labels_of "$N")/$(jq -r --arg n "$M" '[(.[$n] // [])[] | select(.body | contains("agent-blocked-resolved"))] | length' "$GD/comments.json")" "0/pending/blocked/1"
# 13d④ PR 没合并就关闭（停住的 PR 是关联 issue 唯一的 PR），daemon 在重开之前轮询了一次
frozen_pr con4
jset "$GD/items.json" '.[$n].state = "closed"' --arg n "$P"
w0=$(writes_on "$N")
tick 5
chk "13d④ PR 关闭期间跨过一轮轮询：关联 issue 的标签没动、没记「已处理」、仍停住" \
    "$(( $(writes_on "$N") - w0 ))/$(labels_of "$N")/$(jq -r --argjson n "$P" '(.unmerged_prs_handled // []) | index($n) != null' "$STATE")/$(frozen "$N")" "0/pending/PR/false/true"
jset "$GD/items.json" '.[$n].state = "open"' --arg n "$P"
d0=$(disp "$P"); tick 5; tick 5
chk "13d④ 重新打开后：仍停住、不派工，关联关系和标签原样" "$(frozen "$N")/$(( $(disp "$P") - d0 ))/$(labels_of "$N")/$(labels_of "$P")" "true/0/pending/PR/doing/agent,pending/review"
# 对照：同样的关闭，换一条没停住的 PR → 关联 issue 照常从 pending/PR 翻成 pending/human
scn con4b; N=$SEQ; P=$((SEQ + 1))
mk_issue "$N" pending/PR; mk_pr "$P" "feature/issue-$N" "Refs #$N" pending/human
jset "$GD/items.json" '.[$n].state = "closed"' --arg n "$P"
tick 5
chk "13d④ 对照 · 没停住时：issue 从 pending/PR 翻成 pending/human" "$(labels_of "$N")" "pending/human"
# 13d⑤ PR 合并：停住的 issue 不打 Done / pending/human、不清理、不记「已清理」；解除后才做
scn con5; N=$SEQ; P=$((SEQ + 1))
mk_issue "$N" doing/agent; mk_pr "$P" "feature/issue-$N" "Refs #$N"
mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
tick 0; tick 60; tick 50
touch "$GD/F_delete_labels"; tick 60; rm -f "$GD/F_delete_labels"; tick 0
chk "13d⑤ 夹具：issue 停住，范围里有它的 PR" "$(frozen "$N")/$(ff "$N" 'items | sort | join(",")')" "true/$N,$P"
jset "$GD/items.json" '.[$n].state = "closed" | .[$n].merged = true' --arg n "$P"
w0=$(writes_on "$N")
tick 5; tick 5
chk "13d⑤ PR 合并后两轮：issue 没被写、工作目录和会话还在、没记「已清理」、合并后标签队列里没有它" \
    "$(( $(writes_on "$N") - w0 ))/$([ -d "$W/wt/issue-$N" ] && echo wt || echo gone)/$(alive "$N")/$(jq -r --argjson n "$P" '(.cleaned_prs // []) | index($n) != null' "$STATE")/$(jq -r '(.merged_label_queue // {}) | length' "$STATE")" \
    "0/wt/yes/false/0"
rc=0; release_cmd "$N" $'yes\n' || rc=$?
chk "13d⑤ 本机解卡：退出码 0，停住记录删掉" "$rc/$(frozen "$N")" "0/false"
tick 5
chk "13d⑤ 对照 · 解除后的那一轮：照常清理、记「已清理」、issue 交给人" \
    "$([ -d "$W/wt/issue-$N" ] && echo wt || echo gone)/$(jq -r --argjson n "$P" '(.cleaned_prs // []) | index($n) != null' "$STATE")/$(labels_of "$N" | grep -c 'pending/human')" "gone/true/1"
# 13d⑥ 子项全部关闭后的父 issue 收尾：父 issue 停住时先不做、不计重试次数；解除后才做
frozen_is con6 'LOG_LEVEL=debug'; S=$((SEQ + 6))
jset "$GD/items.json" '.[$s] = {kind:"issue", state:"closed", state_reason:"completed", title:"子项", body:"x", user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z", parent_issue_url: ("https://api.github.com/repos/example/sw/issues/" + $n)}' --arg s "$S" --arg n "$N"
echo "{\"$N\": [$S]}" > "$GD/subs.json"
jset "$STATE" '.split_rollup_queue = {($s): 0}' --arg s "$S"
c0=$(comments_on "$N"); w0=$(lwrites "$N")
tick 5; tick 5
chk "13d⑥ 父 issue 停住：不留汇总、不翻标签，子项留在队列里、重试次数没涨" \
    "$(( $(comments_on "$N") - c0 ))/$(( $(lwrites "$N") - w0 ))/$(jq -r --arg s "$S" '.split_rollup_queue[$s] // "gone"' "$STATE")" "0/0/0"
chk "13d⑥ 到达性：收尾确实走到了父 issue 这一步" "$([ "$(plog "#$N 已停手 → 「子项全部关闭后的父 issue 收尾」")" -ge 1 ] && echo yes || echo no)" "yes"
rc=0; release_cmd "$N" $'yes\n' || rc=$?
tick 5
chk "13d⑥ 对照 · 解除后：父 issue 收尾做了（记成已汇总、挂上 pending/human），子项出队" \
    "$rc/$(jq -r --arg n "$N" '.split_rollups[$n] // "none"' "$STATE")/$(labels_of "$N" | grep -c 'pending/human')/$(jq -r --arg s "$S" '.split_rollup_queue[$s] // "gone"' "$STATE")" "0/1/1/gone"
# 13d⑦ 等人 PR 的冲突检查、托管的接手 / 标签同步 / 合并：停住时一条都不碰
frozen_pr con7 'LOG_LEVEL=debug' 'PENDING_HUMAN_CONFLICT_CHECK=true' 'LABEL_AUTOPILOT="autopilot"' 'LABEL_PENDING_MERGE="pending/merge"'
hlabel "$P" rm doing/agent; hlabel "$P" rm pending/review; hlabel "$P" add pending/merge; hlabel "$P" add autopilot; hlabel "$N" add autopilot
w0=$(writes_on "$P"); : > "$CALLS.mark"; m0=$(cnt "pulls/$P/merge" "$CALLS")
tick 5
chk "13d⑦ 托管合并 / 接手 / 标签同步都跳过停住的 PR：PR 上没有写入、没有调合并" \
    "$(( $(writes_on "$P") - w0 ))/$(( $(cnt "pulls/$P/merge" "$CALLS") - m0 ))/$(labels_of "$P")" "0/0/autopilot,pending/merge"
chk "13d⑦ 到达性：三个环节都走到了这条 PR" \
    "$([ "$(plog "#$P 已停手 → 「托管合并」")" -ge 1 ] && echo y || echo n)/$([ "$(plog "#$P 已停手 → 「托管接手」")" -ge 1 ] && echo y || echo n)/$([ "$(plog "#$P 已停手 → 「托管标签同步」")" -ge 1 ] && echo y || echo n)" "y/y/y"
hlabel "$P" rm pending/merge; hlabel "$P" add pending/human
w0=$(writes_on "$P")
tick 5
chk "13d⑦ 等人 PR 的冲突检查跳过停住的 PR" "$(( $(writes_on "$P") - w0 ))/$([ "$(plog "#$P 已停手 → 「等人 PR 的冲突检查」")" -ge 1 ] && echo y || echo n)/$(jq -r --arg n "$P" '(.pr_conflict // {}) | has($n)' "$STATE")" "0/y/false"
rc=0; release_cmd "$P" $'yes\n' || rc=$?
tick 5
chk "13d⑦ 对照 · 解除后：冲突检查和托管环节重新处理这条 PR" \
    "$rc/$([ "$(plog "#$P 已停手")" -ge 1 ] && echo y || echo n)/$(jq -r --arg n "$P" '((.pr_conflict // {}) | has($n)) or ((.autopilot // {}) | tostring | contains($n))' "$STATE")" "0/y/true"

echo "【13】本机解卡命令（照文档里那段命令的字面跑，环境只有 HOME 和 PATH）"
chk "两份文档里的命令段一字不差" "$(diff <(OPS_BLOCK "$REPO_DIR/docs/operations.md") <(OPS_BLOCK "$REPO_DIR/docs/operations.zh.md") >/dev/null && echo same || echo differ)/$([ -n "$(OPS_BLOCK "$REPO_DIR/docs/operations.zh.md")" ] && echo found || echo empty)" "same/found"
# 说明一直发不出去的那种停住：没有起点，只能本机解卡
is_scn cmd1
touch "$GD/F_delete_labels" "$GD/F_post_comment"; tick 60; rm -f "$GD/F_delete_labels"; tick 5
chk "夹具：停住，说明没发出去，没有起点，标签 doing/agent + pending/agent" "$(frozen "$N")/$(ff "$N" posted)/$(ff "$N" base)/$(labels_of "$N")" "true/unknown/null/doing/agent,pending/agent"
E0=$(entry "$N")
keep() { [ "$(entry "$N")" = "$E0" ] && echo kept || echo changed; }
rc=0; release_cmd "$((N + 3))" $'yes\n' || rc=$?
chk "没有这一条的停住记录 → 退出码 1，什么都没改" "$rc/$(grep -c '没有停住记录' "$W/release.out")/$(keep)" "1/1/kept"
( exec 7>"$W/state/poll.lock"; flock 7; sleep 4 ) &
LOCKPID=$!; sleep 0.5
rc=0; release_cmd "$N" $'yes\n' STUCK_RELEASE_LOCK_WAIT=1 || rc=$?
wait "$LOCKPID" 2>/dev/null
chk "轮询锁被占着 → 等待超时，退出码 2，什么都没改" "$rc/$(keep)" "2/kept"
touch "$GD/F_issues_$N"
rc=0; release_cmd "$N" $'yes\n' || rc=$?
rm -f "$GD/F_issues_$N"
chk "读不到 GitHub → 退出码 4，没有问确认，什么都没改" "$rc/$(grep -c '确认解除请输入' "$W/release.out")/$(keep)" "4/0/kept"
rc=0; release_cmd "$N" $'no\n' || rc=$?
chk "输入的不是 yes → 退出码 5，什么都没改" "$rc/$(keep)" "5/kept"
rc=0; release_cmd "$N" '' STUCK_RELEASE_CONFIRM_WAIT=1 || rc=$?
chk "没有输入 → 退出码 5，什么都没改" "$rc/$(keep)" "5/kept"
chk "确认前把整份身份打印出来了（标签、最新一条流程标签事件）" "$(grep -c '"labels"' "$W/release.out")/$(grep -c 'last_flow_label_event' "$W/release.out")" "1/1"
hook_at "issues_$N" 2 "$FAKEBIN/hlabel" "$GD" "$N" add bug
rc=0; release_cmd "$N" $'yes\n' || rc=$?
chk "确认期间人改了标签 → 退出码 3，什么都没改" "$(hook_ran)/$rc/$(keep)" "yes/3/kept"
hook_at "issues_$N" 2 touch "$GD/F_issues_${N}_events"
rc=0; release_cmd "$N" $'yes\n' || rc=$?
rm -f "$GD/F_issues_${N}_events"
chk "确认之后再读没读全 → 退出码 3，什么都没改" "$(hook_ran)/$rc/$(keep)" "yes/3/kept"
d0=$(disp "$N"); tick 5
chk "各条失败退出之后：下一轮仍不派工" "$(( $(disp "$N") - d0 ))/$(frozen "$N")" "0/true"
# 正常解除：人先把标签整理成只剩一枚派工标签
hlabel "$N" rm doing/agent
rc=0; release_cmd "$N" $'yes\n' || rc=$?
chk "正常解除 → 退出码 0，停住记录删掉" "$rc/$(frozen "$N")/$(grep -c '已解除' "$W/release.out")" "0/false/1"
tick 5
chk "解除后下一轮：按条目上的派工标签照常派工" "$(( $(disp "$N") - d0 ))/$(labels_of "$N" | grep -c 'doing/agent')" "1/1"
# PR：确认期间只推了新提交 / 只改投了分支，标签没动 → 也不解除
for v in head base; do
    pr_scn "cmd2$v"
    touch "$GD/F_delete_labels" "$GD/F_post_comment"; tick 60; rm -f "$GD/F_delete_labels"
    E0=$(entry "$N")
    case "$v" in
        head) hook_at "issues_$P" 2 "$FAKEBIN/jset" "$GD/items.json" '.[$n].head.sha = "2222222222222222222222222222222222222222"' --arg n "$P" ;;
        base) hook_at "issues_$P" 2 "$FAKEBIN/jset" "$GD/items.json" '.[$n].base.ref = "release"' --arg n "$P" ;;
    esac
    rc=0; release_cmd "$P" $'yes\n' || rc=$?
    chk "PR 确认期间只变了 $v（标签没动）→ 退出码 3，什么都没改" "$(hook_ran)/$rc/$(keep)" "yes/3/kept"
done
rc=0; release_cmd "$N" $'yes\n' || rc=$?
chk "给的是关联 issue 的编号也找得到这条停住记录；整份身份里有 PR 的分支、提交、来源" \
    "$rc/$(grep -c '"base": "release"' "$W/release.out")/$(grep -c '"head":' "$W/release.out")/$(grep -c '"src": "example/sw"' "$W/release.out")" "0/1/1/1"
fi


if want 13x; then
echo "【13】恢复派工失败时，普通失败兜底不介入：另外两条派工路径（各从「再失败一次就交人」开始）"
bounced() { jq -r --arg n "$1" '[(.[$n] // [])[] | select(.body | contains("自动处理已暂停"))] | length' "$GD/comments.json"; }
# issue 评论路径：会话不在、工作目录还在 → 重起会话；核对通过之后起会话失败
frozen_is nob1; human_resume "$N" pending/agent doing/agent pending/agent
T kill-session -t "=$(sess_of "$N")"
mkdir -p "$W/state/dispatch-fail"; echo 2 > "$W/state/dispatch-fail/issue-$N"
tok=$(ff "$N" token)
printf '%s\n' 'new-session*' > "$CTL/fault"
tick 5
rm -f "$CTL/fault"
chk "issue 评论路径 · 到达性：核对通过、指令用掉之后才失败" "$(plog "#$N 派工前最后一次核对通过")/$([ -s "$CTL/fault.hits" ] && echo hit || echo miss)" "1/hit"
chk "issue 评论路径：没有普通的转人工留言、没翻 pending/human、失败计数没动、评论读取位置没前进；重新停住" \
    "$(bounced "$N")/$(labels_of "$N")/$(cat "$W/state/dispatch-fail/issue-$N")/$(jq -r --arg n "$N" '.seen_issue_comments[$n] // "none"' "$STATE")/$(frozen "$N")/$([ "$(ff "$N" token)" != "$tok" ] && echo new || echo same)" \
    "0/pending/agent/2/none/true/new"
d0=$(disp "$N"); tick 5; tick 5
chk "issue 评论路径：之后两轮不再派工（派工标签还在）" "$(( $(disp "$N") - d0 ))/$(alive "$N")" "0/no"
# 新建路径：会话起来就秒退 → 派工脚本自己那段「留言 + 翻 pending/human」也不做
frozen_is nob2; human_resume "$N" pending/agent doing/agent pending/agent
T kill-session -t "=$(sess_of "$N")"; gq -C "$W/project" worktree remove --force "$W/wt/issue-$N"
mkdir -p "$W/state/dispatch-fail"; echo 2 > "$W/state/dispatch-fail/issue-$N"
tok=$(ff "$N" token); : > "$CTL/die.issue-$N"
tick 5
rm -f "$CTL/die.issue-$N"
chk "新建路径 · 到达性：派工脚本走到了秒退后的转人工那一段，那两次写入都被拦下" \
    "$(plog "dispatch-new-issue: #$N worker 秒退")/$([ "$(plog '恢复派工里不做普通流程的这次 GitHub 写入')" -ge 2 ] && echo yes || echo no)" "1/yes"
chk "新建路径：没有普通的转人工留言、没翻 pending/human、失败计数没动；重新停住" \
    "$(bounced "$N")/$(labels_of "$N")/$(cat "$W/state/dispatch-fail/issue-$N")/$(frozen "$N")/$([ "$(ff "$N" token)" != "$tok" ] && echo new || echo same)" \
    "0/pending/agent/2/true/new"
r0=$(runs "$N"); d0=$(disp "$N"); tick 5; tick 5
chk "新建路径：之后两轮不再派工、不起新进程" "$(( $(disp "$N") - d0 ))/$(( $(runs "$N") - r0 ))" "0/0"
# 复审第 2 轮（代码）的复现：任务已经送进会话，轮询进程在收尾之前被杀掉；派工标签因为摘失败还留着。
# 下一轮没有任何新的人工操作 → 不能凭同一条指令再派一遍
tick_killable() {   # 跑一轮，把轮询进程的进程号记在 $W/poll.pid（不套 timeout：要杀的就是它本身）
    NOW=$((NOW + ${1:-0}))
    (cd "$W/project" && env CODING_AGENT_CONFIG="$CONF" POLL_FAKE_NOW="$NOW" POLL_PID_FILE="$W/poll.pid" \
        bash -c 'echo $$ > "$POLL_PID_FILE"; exec bash "$0"' "$ROOT/scripts/agent-poll.sh") > "$W/poll.out" 2>&1
}
frozen_is crash1; human_resume "$N" pending/agent doing/agent pending/agent
tok=$(ff "$N" token); g0=$(got "$N")
touch "$GD/F_delete_labels"
# 派工脚本翻标签的第一步（摘派工标签）之前，杀掉轮询进程；这时任务已经送进会话
k=$(( $(cat "$GD/count_DELETE_issues_${N}_labels" 2>/dev/null || echo 0) + 1 ))
printf 'kill -9 "$(cat %q)"\ntouch %q\n' "$W/poll.pid" "$GD/hook.ran" > "$GD/hook_DELETE_issues_${N}_labels_$k"
rm -f "$GD/hook.ran"
tick_killable 5
sleep 2   # 派工脚本成了孤儿，等它自己跑完
rm -f "$GD/F_delete_labels"
chk "轮询被杀 · 夹具：任务已送出、派工标签还在、状态里还没记「已用掉」，本机留着这次的凭据" \
    "$(hook_ran)/$([ "$(got "$N")" -gt "$g0" ] && echo sent || echo no)/$(labels_of "$N")/$(ff "$N" used)/$([ -s "$W/state/stuck-release/$N.used" ] && echo file || echo none)" \
    "yes/sent/doing/agent,pending/agent/null/file"
g1=$(got "$N"); d1=$(disp "$N"); r1=$(runs "$N")
tick 5
chk "轮询被杀 · 下一轮（没有新的人工操作）：不再派工、不再送任务；指令记为已用掉，重新停住，凭据在这之后才清掉" \
    "$(( $(disp "$N") - d1 ))/$(( $(got "$N") - g1 ))/$(( $(runs "$N") - r1 ))/$(ff "$N" 'used != null')/$([ "$(ff "$N" token)" != "$tok" ] && echo new || echo same)/$([ -e "$W/state/stuck-release/$N.used" ] && echo file || echo none)/$(ff "$N" why | grep -c '收尾之前中止')" \
    "0/0/0/true/new/none/1"
tick 5; tick 5
chk "轮询被杀 · 再过两轮：仍不派工，新的停住说明已发出" "$(( $(disp "$N") - d1 ))/$(( $(got "$N") - g1 ))/$(ff "$N" posted)" "0/0/yes"
d1=$(disp "$N"); human_resume "$N" pending/agent doing/agent pending/agent
tick 5
chk "轮询被杀 · 对照：人重新打一次派工标签 → 派工一次，记录清掉" "$(( $(disp "$N") - d1 ))/$(labels_of "$N")/$(entry "$N")" "1/doing/agent/{}"
# 复审第 3 轮（代码）的复现：同一个「轮询被杀」的场景，下一轮了结凭据时读本机停住记录失败一次。
# 读不出 ≠ 记录不在：凭据要留着、这一轮不派工；读得出之后照常了结
frozen_is crash1b; human_resume "$N" pending/agent doing/agent pending/agent
tok=$(ff "$N" token); g0=$(got "$N")
touch "$GD/F_delete_labels"
k=$(( $(cat "$GD/count_DELETE_issues_${N}_labels" 2>/dev/null || echo 0) + 1 ))
printf 'kill -9 "$(cat %q)"\ntouch %q\n' "$W/poll.pid" "$GD/hook.ran" > "$GD/hook_DELETE_issues_${N}_labels_$k"
rm -f "$GD/hook.ran"
tick_killable 5
sleep 2
rm -f "$GD/F_delete_labels"
chk "读失败 · 夹具：任务已送出、派工标签还在、凭据在、状态里没记「已用掉」" \
    "$(hook_ran)/$([ "$(got "$N")" -gt "$g0" ] && echo sent || echo no)/$(labels_of "$N")/$(ff "$N" used)/$([ -s "$W/state/stuck-release/$N.used" ] && echo file || echo none)" \
    "yes/sent/doing/agent,pending/agent/null/file"
g1=$(got "$N"); d1=$(disp "$N")
printf '%s\n' '-ce --arg k * if type == "object" and*' > "$CTL/jqfault"; rm -f "$CTL/jqfault.hits"
tick 5
chk "读失败 · 到达性：这一轮了结凭据时读停住记录确实失败了一次" "$([ -s "$CTL/jqfault.hits" ] && echo hit || echo miss)/$(plog "读不出工作编号 $N 的停住记录")" "hit/1"
chk "读失败 · 这一轮：凭据还在、不派工、不送任务、仍停住" \
    "$([ -s "$W/state/stuck-release/$N.used" ] && echo file || echo none)/$(( $(disp "$N") - d1 ))/$(( $(got "$N") - g1 ))/$(frozen "$N")" "file/0/0/true"
tick 5
chk "读失败 · 读得出之后的下一轮：指令记为已用掉、重新停住、凭据清掉，仍不派工、不送任务" \
    "$(ff "$N" 'used != null')/$([ "$(ff "$N" token)" != "$tok" ] && echo new || echo same)/$([ -e "$W/state/stuck-release/$N.used" ] && echo file || echo none)/$(( $(disp "$N") - d1 ))/$(( $(got "$N") - g1 ))" \
    "true/new/none/0/0"
tick 5; tick 5
chk "读失败 · 再过两轮：同一条指令始终没有再送任务" "$(( $(disp "$N") - d1 ))/$(( $(got "$N") - g1 ))" "0/0"
# 复审第 5 轮（代码）的复现：记录读得出，了结遗留凭据时从记录里「取字段」失败（条目类型、凭据里的事件编号）。
# 取不出 ≠ 空值：记录（含条目类型）和凭据都原样留着、这一轮什么都不写；读得出之后照常了结，
# 两条恢复途径（GitHub 上重新打派工标签、本机解卡命令）都还能用
crash_left() {   # <名字>：摆出「派工过了核对、任务已送出、父进程在收尾前被杀」的样子
    frozen_is "$1"; human_resume "$N" pending/agent doing/agent pending/agent
    local g0 k; g0=$(got "$N")
    touch "$GD/F_delete_labels"
    k=$(( $(cat "$GD/count_DELETE_issues_${N}_labels" 2>/dev/null || echo 0) + 1 ))
    printf 'kill -9 "$(cat %q)"\ntouch %q\n' "$W/poll.pid" "$GD/hook.ran" > "$GD/hook_DELETE_issues_${N}_labels_$k"
    rm -f "$GD/hook.ran"
    tick_killable 5
    sleep 2
    rm -f "$GD/F_delete_labels"
    chk "$1 · 夹具：任务已送出、凭据在、记录停住且类型为 issue" \
        "$(hook_ran)/$([ "$(got "$N")" -gt "$g0" ] && echo sent || echo no)/$([ -s "$W/state/stuck-release/$N.used" ] && echo file || echo none)/$(efield "$N" '.kind')/$(frozen "$N")" \
        "yes/sent/file/issue/true"
}
rcv_field_fail() {   # <名字> <jq 故障的 glob> <日志里应出现的字样> <后续：github|local>
    crash_left "$1"
    local tok g1 d1 c1 rc
    tok=$(ff "$N" token); g1=$(got "$N"); d1=$(disp "$N"); c1=$(cposts "$N")
    printf '%s\n' "$2" > "$CTL/jqfault"; rm -f "$CTL/jqfault.hits"
    tick 5
    chk "$1 · 到达性：了结凭据时这一次取字段确实失败了" "$([ -s "$CTL/jqfault.hits" ] && echo hit || echo miss)/$([ "$(plog "$3")" -ge 1 ] && echo logged || echo silent)" "hit/logged"
    chk "$1 · 这一轮：记录原样（类型 issue、编号、同一个记号、没记已用掉）、凭据还在，不派工、不送任务、不发说明" \
        "$(efield "$N" '.kind')/$(efield "$N" '.num')/$([ "$(ff "$N" token)" = "$tok" ] && echo same || echo changed)/$(ff "$N" used)/$([ -s "$W/state/stuck-release/$N.used" ] && echo file || echo none)/$(( $(disp "$N") - d1 ))/$(( $(got "$N") - g1 ))/$(( $(cposts "$N") - c1 ))" \
        "issue/$N/same/null/file/0/0/0"
    tick 5
    chk "$1 · 读得出之后的下一轮：照常了结——记为已用掉、重新停住（类型仍是 issue）、凭据清掉，不派工、不送任务" \
        "$(ff "$N" 'used != null')/$([ "$(ff "$N" token)" != "$tok" ] && echo new || echo same)/$(efield "$N" '.kind')/$([ -e "$W/state/stuck-release/$N.used" ] && echo file || echo none)/$(( $(disp "$N") - d1 ))/$(( $(got "$N") - g1 ))" \
        "true/new/issue/none/0/0"
    if [ "$4" = github ]; then
        tick 5; tick 5
        chk "$1 · 新的停住说明发出" "$(ff "$N" posted)" "yes"
        d1=$(disp "$N"); human_resume "$N" pending/agent doing/agent pending/agent
        tick 5
        chk "$1 · GitHub 途径：人重新打一次派工标签 → 派工一次，记录清掉" "$(( $(disp "$N") - d1 ))/$(labels_of "$N")/$(entry "$N")" "1/doing/agent/{}"
    else
        hlabel "$N" rm doing/agent
        rc=0; release_cmd "$N" $'yes\n' || rc=$?
        chk "$1 · 本机途径：解卡命令照常解除（退出码 0，记录清掉）" "$rc/$(entry "$N")/$(grep -c '已解除' "$W/release.out")" "0/{}/1"
    fi
}
rcv_field_fail rcvkind '-er *.frozen != null), .kind, .num]*' '读不出工作编号 [0-9]* 的停住记录，上一轮留下的派工凭据先留着' github
rcv_field_fail rcvkind2 '-er *.frozen != null), .kind, .num]*' '读不出工作编号 [0-9]* 的停住记录，上一轮留下的派工凭据先留着' local
rcv_field_fail rcvev '-er .event | numbers*' '上一轮留下的派工凭据读不出' github
# 派工后的收尾从记录里取字段失败：这一轮不收尾、什么都不写（凭据留着）；下一轮开头照常了结
frozen_is finfld; human_resume "$N" pending/agent doing/agent pending/agent
tok=$(ff "$N" token); g0=$(got "$N")
printf '%s\n' '-er *.frozen.cand.label // ""), (.frozen.miss*' > "$CTL/jqfault"; rm -f "$CTL/jqfault.hits"
tick 5
chk "收尾取字段失败 · 到达：任务已送出，收尾时取字段失败" \
    "$([ -s "$CTL/jqfault.hits" ] && echo hit || echo miss)/$([ "$(got "$N")" -gt "$g0" ] && echo sent || echo no)/$(plog "#$N 派工后读不出本机的停住记录")" "hit/sent/1"
chk "收尾取字段失败 · 这一轮：记录原样（类型 issue、同一个记号）、凭据还在" \
    "$(efield "$N" '.kind')/$([ "$(ff "$N" token)" = "$tok" ] && echo same || echo changed)/$([ -s "$W/state/stuck-release/$N.used" ] && echo file || echo none)" "issue/same/file"
g1=$(got "$N"); d1=$(disp "$N")
tick 5
chk "收尾取字段失败 · 下一轮开头照常了结：记为已用掉、重新停住、凭据清掉，不再派工" \
    "$(ff "$N" 'used != null')/$([ "$(ff "$N" token)" != "$tok" ] && echo new || echo same)/$(efield "$N" '.kind')/$([ -e "$W/state/stuck-release/$N.used" ] && echo file || echo none)/$(( $(disp "$N") - d1 ))/$(( $(got "$N") - g1 ))" \
    "true/new/issue/none/0/0"
# 写入口那道检查：调用方把空类型、错编号、换了类型交进来，停住记录都写不坏
frozen_is wrchk
cp "$STATE" "$W/state.before"
wr() { (cd "$W/project" && env CODING_AGENT_CONFIG="$CONF" bash -c 'source "$1/scripts/_lib.sh"; STATE_FILE="$STATE_DIR/state.json"; shift; "$@"' _ "$ROOT" "$@") > /dev/null 2>&1; }
r0=0; wr true || r0=$?
cp "$STATE" "$W/state.before"
r1=0; wr stuck_entry_set "$N" '.kind = ""' || r1=$?
r2=0; wr stuck_entry_set "$N" '.num = "x"' || r2=$?
r3=0; wr stuck_entry_set "$N" '.kind = "pr"' || r3=$?
r4=0; wr stuck_freeze "$N" "" "$N" "测试" || r4=$?
chk "写入口检查（先加载一次库，之后再比）：空类型 / 错编号 / 换类型 / 空类型停住都拒写，状态文件逐字节不变" \
    "$r0/$r1/$r2/$r3/$r4/$(cmp -s "$STATE" "$W/state.before" && echo same || echo changed)" "0/1/1/1/1/same"
# 主干后来加的「CI 失败报告」在子进程里写报告 issue：停住的条目名单由 stuck_frozen_items 交过去，
# 写到名单里的条目时这一步按写失败处理（下一轮再试）；功能关着时名单为空、什么都不拦
fl=$(cd "$W/project" && env CODING_AGENT_CONFIG="$CONF" bash -c 'source "$1/scripts/_lib.sh"; STATE_FILE="$STATE_DIR/state.json" stuck_frozen_items' _ "$ROOT" 2>/dev/null)
fl_off=$(cd "$W/project" && env CODING_AGENT_CONFIG="$CONF" STUCK_WORKER_QUIET_SECS= bash -c 'source "$1/scripts/_lib.sh"; STUCK_WORKER_QUIET_SECS=""; STATE_FILE="$STATE_DIR/state.json" stuck_frozen_items' _ "$ROOT" 2>/dev/null)
ciw() {   # <名单> <路径> → yes = 拦下
    CI_REPORT_STUCK_FROZEN="$1" python3 -c '
import importlib.util, sys
s = importlib.util.spec_from_file_location("cfr", sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
print("yes" if m.stuck_frozen(sys.argv[2]) else "no")' "$ROOT/scripts/ci_failure_report.py" "$2"
}
chk "CI 失败报告：停住的条目在名单里；功能关着名单为空" \
    "$(printf '%s\n' $fl | grep -cx "$N")/[$fl_off]" "1/[]"
chk "CI 失败报告：写到停住的条目（评论 / 标签 / 改状态）拦下，别的条目和新开报告不拦，名单为空不拦" \
    "$(ciw "$fl" "repos/example/sw/issues/$N/comments")/$(ciw "$fl" "repos/example/sw/issues/$N/labels/x")/$(ciw "$fl" "repos/example/sw/issues/$N")/$(ciw "$fl" "repos/example/sw/issues/1$N/comments")/$(ciw "$fl" "repos/example/sw/issues")/$(ciw "" "repos/example/sw/issues/$N/comments")/$(ciw "all" "repos/example/sw/issues/7/comments")" \
    "yes/yes/yes/no/no/no/yes"
r5=0; wr stuck_entry_set "$N" '.frozen.tries = 1' || r5=$?
chk "写入口检查 · 对照：正常字段照常写进去" "$r5/$(ff "$N" tries)/$(efield "$N" '.kind')" "0/1/issue"
# 复审第 4 轮（代码）的复现：每轮遍历停住记录时读失败一次。读不出 ≠ 没有记录：停住记录要留着、
# 这一轮不派工；读得出之后仍然要过恢复核对（这里人在那之前又挂了 pending/human → 不派）。
# 三种读失败各一例：读单条记录、读记录清单、从读到的记录里取字段
rdfail_loop() {   # <名字> <jq 故障的 glob> <日志里应出现的字样>
    frozen_is "$1"; human_resume "$N" pending/agent doing/agent pending/agent
    local g0 w0 d0 E0; g0=$(got "$N"); w0=$(lwrites "$N"); d0=$(disp "$N"); E0=$(ff "$N" token)
    printf '%s\n' "$2" > "$CTL/jqfault"; rm -f "$CTL/jqfault.hits"
    tick 5
    chk "$1 · 到达性：遍历停住记录时这一次读取确实失败了" "$([ -s "$CTL/jqfault.hits" ] && echo hit || echo miss)/$([ "$(plog "$3")" -ge 1 ] && echo logged || echo silent)" "hit/logged"
    chk "$1 · 读失败的这一轮：停住记录原样留着，不派工、不送任务、不写标签" \
        "$(frozen "$N")/$([ "$(ff "$N" token)" = "$E0" ] && echo same || echo changed)/$(( $(disp "$N") - d0 ))/$(( $(got "$N") - g0 ))/$(( $(lwrites "$N") - w0 ))" "true/same/0/0/0"
    # 读取恢复之前，人又把这一条暂停了：恢复核对必须还在
    hlabel "$N" add pending/human
    tick 5; tick 5
    chk "$1 · 读取恢复后人已挂上 pending/human：仍过恢复核对，不派工、不送任务、不写标签，标签原样" \
        "$(frozen "$N")/$(( $(disp "$N") - d0 ))/$(( $(got "$N") - g0 ))/$(( $(lwrites "$N") - w0 ))/$(labels_of "$N")" "true/0/0/0/pending/agent,pending/human"
    # 对照：人撤掉暂停、重新打一次派工标签 → 照常按恢复指令派
    hlabel "$N" rm pending/human; hlabel "$N" rm pending/agent; hlabel "$N" add pending/agent
    tick 5
    chk "$1 · 对照：人重新授权后照常派工，记录清掉" "$(( $(disp "$N") - d0 ))/$(labels_of "$N")/$(entry "$N")" "1/doing/agent/{}"
}
rdfail_loop rdloop1 '-ce --arg k * if type == "object" and*' '读不出工作编号 [0-9]* 的记录'
rdfail_loop rdloop2 '-er if type == "object" and ((.stuck_workers // {}) | type) == "object"*keys*' '读不出本机的记录清单'
rdfail_loop rdloop3 '-er *.frozen != null), (.restarts // 0*' '读不出工作编号 [0-9]* 的记录'
# 停住之后的各步（发说明、记起点、初筛）从记录里取字段失败：这一轮什么都不做，不重复发说明、不改起点
frozen_is rdloop4
c0=$(cposts "$N"); b0=$(ff "$N" base)
printf '%s\n' '-er *.frozen.posted // "no"), .frozen.base*' > "$CTL/jqfault"; rm -f "$CTL/jqfault.hits"
tick 5
chk "停住处理取字段失败：到达；没有再发说明、起点没变、仍停住" \
    "$([ -s "$CTL/jqfault.hits" ] && echo hit || echo miss)/$(( $(cposts "$N") - c0 ))/$([ "$(ff "$N" base)" = "$b0" ] && echo same || echo moved)/$(frozen "$N")" "hit/0/same/true"
# 恢复判断里取「最后一条流程标签事件是谁做的」失败：不能当成通过
frozen_is rdloop5; human_resume "$N" pending/agent doing/agent pending/agent
g0=$(got "$N")
printf '%s\n' '-er *.last.actor, .last.id, .last.label*' > "$CTL/jqfault"; touch "$CTL/jqfault.keep"; rm -f "$CTL/jqfault.hits"
tick 5
rm -f "$CTL/jqfault" "$CTL/jqfault.keep"
chk "恢复判断取字段失败：到达；当作不成立，不派工、仍停住" "$([ -s "$CTL/jqfault.hits" ] && echo hit || echo miss)/$(( $(got "$N") - g0 ))/$(frozen "$N")" "hit/0/true"
tick 5
chk "恢复判断 · 对照：读得出之后照常派工" "$(labels_of "$N")/$(entry "$N")" "doing/agent/{}"
# 派工前读不出本机的停住记录：不能把停住的条目当成普通派工放过去；读得出之后照常按恢复指令派
frozen_is rdfail2; human_resume "$N" pending/agent doing/agent pending/agent
g0=$(got "$N"); w0=$(lwrites "$N")
printf '%s\n' '*to_entries[] | select(.value.frozen != null and .value.kind*' > "$CTL/jqfault"; rm -f "$CTL/jqfault.hits"
tick 5
chk "派工前读失败 · 到达性：走到了派工这一步，读停住记录失败" "$([ -s "$CTL/jqfault.hits" ] && echo hit || echo miss)/$(plog "#$N 派工前读不出本机的停住记录")" "hit/1"
chk "派工前读失败：这一轮不派工（不送任务、不翻标签、没有普通失败计数），仍停住" \
    "$(( $(got "$N") - g0 ))/$(( $(lwrites "$N") - w0 ))/$([ -e "$W/state/dispatch-fail/issue-$N" ] && echo counted || echo none)/$(frozen "$N")" "0/0/none/true"
tick 5
chk "派工前读失败 · 对照：读得出之后照常按恢复指令派工，记录清掉" "$(labels_of "$N")/$(entry "$N")/$([ "$(got "$N")" -gt "$g0" ] && echo sent || echo no)" "doing/agent/{}/sent"
# 各环节问「停住了没有」时读不出：按停住算（这一轮不动它）
frozen_is rdfail3; M=$((SEQ + 5))
T kill-session -t "=$(sess_of "$N")"
w0=$(lwrites "$N")
printf '%s\n' '*.frozen.items*index($n)*' > "$CTL/jqfault"; touch "$CTL/jqfault.keep"; rm -f "$CTL/jqfault.hits"
tick 5
rm -f "$CTL/jqfault" "$CTL/jqfault.keep"
chk "「停住了没有」读不出：自愈不翻标签、派工队列不派，标签原样" \
    "$([ -s "$CTL/jqfault.hits" ] && echo hit || echo miss)/$(( $(lwrites "$N") - w0 ))/$(labels_of "$N")" "hit/0/doing/agent,pending/agent"
# 凭据还在、状态写不进去的那种（这里直接摆出这个状态）：这一轮不派工，凭据不删
frozen_is crash2; human_resume "$N" pending/agent doing/agent pending/agent
mkdir -p "$W/state/stuck-release"
# 先让初筛记下候选，再摆一份别的派工留下的凭据；把凭据做成这一轮开头了结不掉的样子不容易，
# 所以直接验 begin 的那道闸：凭据文件在初筛之后、派工之前出现
k=$(( $(cat "$GD/count_issues_$N" 2>/dev/null || echo 0) + 1 ))
printf 'echo %q > %q\ntouch %q\n' '{"token":"left-over","event":1}' "$W/state/stuck-release/$N.used" "$GD/hook.ran" > "$GD/hook_issues_${N}_$k"
rm -f "$GD/hook.ran"; g0=$(got "$N"); w0=$(lwrites "$N")
tick 5
chk "遗留凭据在初筛之后才出现 · 这一轮不派工、不删凭据" \
    "$(hook_ran)/$(( $(got "$N") - g0 ))/$(( $(lwrites "$N") - w0 ))/$(plog "#$N 上一次恢复派工的结果还没了结")/$([ -e "$W/state/stuck-release/$N.used" ] && echo file || echo none)" "yes/0/0/1/file"
tick 5
chk "遗留凭据 · 下一轮开头了结：记为已用掉、重新停住、凭据清掉，仍不派工" \
    "$(ff "$N" used)/$(( $(got "$N") - g0 ))/$([ -e "$W/state/stuck-release/$N.used" ] && echo file || echo none)/$(frozen "$N")" "1/0/none/true"
# 重测试排队开着时（GitHub#343），派工脚本会在条目锁里重新起自己一遍：恢复派工的标记要跟过去，
# 锁里跑的那一份照样过最后一次核对，不能变成普通派工
frozen_is heavy1 'HEAVY_TEST_COMMANDS="bash tests/run.sh"'; human_resume "$N" pending/agent doing/agent pending/agent
g0=$(got "$N"); w0=$(lwrites "$N")
hook_at "issues_$N" 2 "$FAKEBIN/hlabel" "$GD" "$N" rm pending/agent
tick 5
chk "条目锁里重新起的派工脚本 · 初筛之后人摘掉派工标签：照样被最后一次核对拦下，没送任务、没翻标签" \
    "$(hook_ran)/$(plog "#$N 派工前最后一次核对没过")/$(( $(got "$N") - g0 ))/$(( $(lwrites "$N") - w0 ))/$(frozen "$N")" "yes/1/0/0/true"
hlabel "$N" add pending/agent
tick 5
chk "条目锁里重新起的派工脚本 · 对照：没有变化时核对通过、按恢复指令派工，记录清掉" \
    "$(plog "#$N 派工前最后一次核对通过")/$(labels_of "$N")/$(entry "$N")/$([ "$(got "$N")" -gt "$g0" ] && echo sent || echo no)" "1/doing/agent/{}/sent"
# 对照：同样秒退，换一条没停住的新 issue → 派工脚本照原规则留言并翻 pending/human
scn nob3; N=$SEQ
mk_issue "$N" pending/agent; : > "$CTL/die.issue-$N"
tick 5
rm -f "$CTL/die.issue-$N"
chk "对照 · 没停住的新 issue 秒退：照原规则留言并翻 pending/human" "$(bounced "$N")/$(labels_of "$N")" "1/pending/human"
fi

# ════════════════════════════════════════════════════════════════════════════
if want 10; then
echo "【10】不归这里管的：别的机器派的、目标自己挂着保护标签的"
scn foreign; N=$SEQ; M=$((SEQ + 1))
mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent otherhost; mk_sess "$N" claude worker
mk_issue "$M" doing/agent pending/human; mk_wt "$M"; own "$M" pending/agent; mk_sess "$M" claude worker
tick 0; tick 60; tick 60; tick 60
chk "别的机器派的：不采样、不记状态、不催" "$(captured "$(pane_of "$N")")/$(entry "$N")/$(nudges "$N")" "0/{}/0"
chk "目标同时挂着 pending/human：不催、不写" "$(nudges "$M")/$(writes_on "$M")/$(alive "$M")" "0/0/yes"
# 对照：同两条，归属改成本机 / 摘掉 pending/human 之后确实推进
own "$N" pending/agent
jset "$GD/labels.json" '.[$n] = ["doing/agent"]' --arg n "$M"; touch_item "$M" 07
tick 0; tick 60; tick 50
chk "对照 · 归属改成本机后：催了" "$([ "$(nudges "$N")" -ge 1 ] && echo yes || echo no)" "yes"
chk "对照 · 摘掉 pending/human 后：催了" "$([ "$(nudges "$M")" -ge 1 ] && echo yes || echo no)" "yes"
fi

# ════════════════════════════════════════════════════════════════════════════
if want 11; then
echo "【11】worker 正常交接后阶梯从头算；功能关闭时什么都不做"
scn reset; N=$SEQ
mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
tick 0; tick 60; tick 50
chk "夹具 · 已催过，有进度记录" "$(efield "$N" '.nudged_at > 0')" "true"
# worker 被催后正常交接：翻成 pending/human
jset "$GD/labels.json" '.[$n] = ["pending/human"]' --arg n "$N"; touch_item "$N" 03
tick 10
chk "条目离开 doing/agent：进度记录清掉" "$(entry "$N")" "{}"
# 人处理完重新派工，又卡住：从催促开始，而不是直接重派
jset "$GD/labels.json" '.[$n] = ["doing/agent"]' --arg n "$N"; touch_item "$N" 04
G0=$(nudges "$N")
tick 0; tick 60; tick 50
chk "下一次派工又卡住：从催促重新开始" "$([ "$(nudges "$N")" -gt "$G0" ] && echo yes || echo no)/$(alive "$N")" "yes/yes"
for off in 'STUCK_WORKER_QUIET_SECS=0' 'STUCK_WORKER_QUIET_SECS=""' 'STUCK_WORKER_QUIET_SECS="abc"'; do
    scn off "$off"; N=$SEQ
    mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
    tick 0; tick 200; tick 200
    chk "$off：不采样、不催、不记状态" "$(captured "$(pane_of "$N")")/$(nudges "$N")/$(jq -r 'has("stuck_workers")' "$STATE")" "0/0/false"
    chk "到达性 · 轮询确实跑完了这几轮" "$(plog 'poll done')" "3"
done
fi

# ════════════════════════════════════════════════════════════════════════════
if want 12; then
echo "【12】功能关闭（配置里没有这一项）：GitHub 调用、tmux 调用、state.json、标签与改动前逐字节一致"
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
OLD="$TMP/old"; mkdir -p "$OLD"
git -C "$REPO_DIR" archive "$BASE_REV" scripts prompts | tar -x -C "$OLD"
if ! compat_skip "功能关闭时的调用、state.json、标签与改动前" "$OLD" "$NEW" scripts prompts; then
    run_off() {   # <被测根目录> → 结果留在 $TMP/off.<名字>
        local root="$1" tag="$2" N M
        ROOT="$root"; STUCK_OFF=1
        SEQ=988700
        scn offcmp; N=$SEQ; M=$((SEQ + 1))
        # 一条卡住的（会话在、空闲）+ 一条会话已经不在的（走 self-heal 翻回触发标签）
        mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
        mk_issue "$M" doing/agent; own "$M" pending/review
        : > "$CTL/tmux.log"
        tick 0; tick 200; tick 200
        mkdir -p "$TMP/off.$tag"
        cp "$CALLS" "$TMP/off.$tag/calls"; cp "$GD/labels.json" "$TMP/off.$tag/labels"
        jq -S . "$STATE" > "$TMP/off.$tag/state"
        # 窗格编号、进程号每次起 server 都从头数，两边一致；抓的是参数原文
        # 两边脚本目录不同（日志脱敏管道里带着脚本的路径），换成同一个占位再比
        sed "s|$root/|ROOT/|g" "$CTL/tmux.log" > "$TMP/off.$tag/tmux"
        echo "$(alive "$N")/$(labels_of "$N")/$(labels_of "$M")" > "$TMP/off.$tag/end"
        ROOT="$NEW"; STUCK_OFF=0
    }
    run_off "$OLD" old; run_off "$NEW" new
    chk "GitHub 调用逐条一致" "$(diff "$TMP/off.old/calls" "$TMP/off.new/calls" >/dev/null && echo same || echo differ)" "same"
    chk "tmux 调用逐条一致" "$(diff "$TMP/off.old/tmux" "$TMP/off.new/tmux" >/dev/null && echo same || echo differ)" "same"
    chk "state.json 一致" "$(diff "$TMP/off.old/state" "$TMP/off.new/state" >/dev/null && echo same || echo differ)" "same"
    chk "最终标签一致" "$(diff "$TMP/off.old/labels" "$TMP/off.new/labels" >/dev/null && echo same || echo differ)" "same"
    chk "到达性 · 卡住的那条没人管（这正是关闭时的行为）" "$(cut -d/ -f1-3 "$TMP/off.new/end")" "yes/doing/agent"
    chk "到达性 · 会话不在的那条被 self-heal 翻回它的触发标签（复审）" \
        "$(grep -c -- "-X POST repos/example/sw/issues/988711/labels -f labels\[\]=pending/review" "$TMP/off.new/calls")" "1"
    chk "到达性 · 这几轮确实有 GitHub 调用" "$([ "$(wc -l < "$TMP/off.new/calls")" -gt 5 ] && echo yes || echo no)" "yes"
fi
fi

echo
compat_summary
echo "通过 $pass / 失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
