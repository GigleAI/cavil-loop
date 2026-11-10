#!/usr/bin/env bash
# kind: e2e
# 条目卡在 doing/agent、会话还在却没人干活 → daemon 催一次 / 重派 / 交人（GitHub#339）。
#
# 跑法：bash tests/stuck-worker.test.sh        （约 5 分钟；没有负对照）
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
    exec env -i "${keep[@]}" bash "${BASH_SOURCE[0]}" "$@"
fi

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/compat.sh
source "$TEST_DIR/lib/compat.sh"

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
    rm -f "$CTL"/screen.* "$CTL"/got.* "$CTL"/runs.* "$CTL/fault" "$CTL/fault.hits"; : > "$CTL/tmux.log"
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
want() { [ -z "${STUCK_ONLY:-}" ] || [[ ",$STUCK_ONLY," == *",$1,"* ]]; }

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
acted() { cnt '卡住检测：.*\(结束会话\|转人工\)' "$W/state/poll.log"; }
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
                                   jset "$GD/comments.json" '.[$n] = ((.[$n] // []) + [{id: 77001, body: "等一下", user: {login: "maint"}}])' --arg n "$P"
pre_case "PR 标签变了" "issues_$P" jset "$GD/labels.json" '.[$n] = ["doing/agent"]' --arg n "$P" -- \
                                   jset "$GD/labels.json" '.[$n] = ["doing/agent", "bug"]' --arg n "$P"
pre_case "绑定的 issue 挂上 pending/human" "issues_$P" jset "$GD/labels.json" '.[$n] = ["pending/PR"]' --arg n "$N" -- \
                                   jset "$GD/labels.json" '.[$n] = ["pending/PR", "pending/human"]' --arg n "$N"
pre_case "绑定的 issue 多了一条评论" "issues_$P" true -- \
                                   jset "$GD/comments.json" '.[$n] = ((.[$n] // []) + [{id: 77003, body: "先别动", user: {login: "maint"}}])' --arg n "$N"
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
hook_next "issues_$P" jset "$GD/comments.json" '.[$n] = ((.[$n] // []) + [{id: 77002, body: "我来看", user: {login: "maint"}}])' --arg n "$P"
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

# ════════════════════════════════════════════════════════════════════════════
if want 9; then
echo "【9】动手到一半失败 → 下一轮照原来的依据重新核对：没变就做完，变了就放弃"
# 9a 重派：加触发标签失败 → 什么不可逆的事都没做；下一轮收敛
scn retry1; N=$SEQ
mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
tick 0; tick 60; tick 50
touch "$GD/F_post_labels"
tick 60
chk "加标签失败：会话不动、标签不动，待办留着、没记成已重派" \
    "$(alive "$N")/$(labels_of "$N")/$(efield "$N" '.pending')/$(efield "$N" '.restarts // 0')" "yes/doing/agent/restart/0"
rm -f "$GD/F_post_labels"
: > "$CTL/tmux.log"
tick 10
chk "到达性 · 续做前重新抓了工作窗格的画面" "$([ "$(captured "%1")" -ge 1 ] && echo yes || echo no)" "yes"
chk "下一轮收敛：标签是触发标签、会话结束、记一次重派、待办清掉" \
    "$(labels_of "$N")/$(alive "$N")/$(efield "$N" '.restarts')/$(efield "$N" '.pending')" "pending/agent/no/1/"
chk "没有重复催促、没有评论" "$(plog '发催促')/$(comments_on "$N")" "1/0"
# 9a2 重派：标签加上了、doing/agent 没摘掉 → 下一轮接着摘
scn retry1b; N=$SEQ
mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
tick 0; tick 60; tick 50
touch "$GD/F_delete_labels"
tick 60
chk "摘 doing/agent 失败：两个标签都在，会话不动，待办留着" \
    "$(labels_of "$N")/$(alive "$N")/$(efield "$N" '.pending')" "doing/agent,pending/agent/yes/restart"
rm -f "$GD/F_delete_labels"
R0=$(runs "$N"); P0=$(cat "$CTL/runs.issue-$N" | tail -1)
tick 10
# 这一轮开头的快照里触发标签已经在，所以同一轮里摘掉 doing/agent、结束旧会话之后紧接着就重派了
chk "下一轮收敛：记一次重派、待办清掉，旧会话结束、同一轮里重新派工起了新的 agent 进程" \
    "$(efield "$N" '.restarts')/$(efield "$N" '.pending')/$(plog '已翻回 pending/agent，结束会话')/$([ "$(runs "$N")" -gt "$R0" ] && echo yes || echo no)/$(labels_of "$N")" "1//1/yes/doing/agent"
# 9b 待办留着时各种变化 → 放弃，不补写。每种一套场景；最后一列是这一轮对目标的写请求数
drop_case() {   # <名字> <restart|human> <pr|issue> <变化命令…>
    local name="$1" step="$2" shape="$3"; shift 3
    local extra=(); [ "$step" = human ] && extra=('STUCK_WORKER_MAX_RESTARTS=0')
    scn "drop$((++DROPN))" ${extra[@]+"${extra[@]}"}; N=$SEQ; P=$((SEQ + 1)); TGT=$N
    if [ "$shape" = pr ]; then
        mk_issue "$N" pending/PR; mk_pr "$P" "feature/issue-$N" "Refs #$N" doing/agent; TGT=$P
        own "$N" pending/review
    else
        mk_issue "$N" doing/agent; own "$N" pending/agent
    fi
    mk_wt "$N"; mk_sess "$N" claude worker
    tick 0; tick 60; tick 50
    if [ "$step" = human ]; then touch "$GD/F_post_comment"; else touch "$GD/F_post_labels"; fi
    tick 60
    rm -f "$GD/F_post_comment" "$GD/F_post_labels"
    chk "$name · 夹具：待办留着" "$(efield "$N" '.pending')" "$step"
    "$@"
    local w0 c0 g0; w0=$(writes_on "$TGT"); c0=$(comments_on "$TGT"); g0=$(cnt "repos/example/sw/issues/$TGT\$" "$CALLS")
    : > "$CTL/tmux.log"
    tick 10
    chk "$name · 到达性：这一轮重读了目标条目" "$([ "$(cnt "repos/example/sw/issues/$TGT\$" "$CALLS")" -gt "$g0" ] && echo yes || echo no)" "yes"
    # 条目被关闭时，轮询里的收尾流程会自己清掉会话，那不是卡住检测动的手：那一例不看会话
    local al; al=$(alive "$N"); [ "${DROP_SKIP_ALIVE:-0}" = 1 ] && al=yes
    chk "$name：放弃待办，目标上没有写入、没有新评论、卡住检测没结束会话" \
        "$(( $(writes_on "$TGT") - w0 ))/$(( $(comments_on "$TGT") - c0 ))/$al/$(plog '结束会话')/$(efield "$N" '.pending // ""')/$(efield "$N" '.restarts // 0')" "0/0/yes/0//0"
}
DROPN=0
set_labels() { jset "$GD/labels.json" '.[$n] = $ARGS.positional' --arg n "$1" --args "${@:2}"; }
# 复审第 1 轮的两个复现
drop_case "交人待办 · agent 又在忙了" human issue eval 'screen "$N" "$BUSY_CLAUDE"'
chk "交人待办 · agent 又在忙了 · 到达性：续做前抓了工作窗格的画面" "$([ "$(captured "$(pane_of "$N")")" -ge 1 ] && echo yes || echo no)" "yes"
chk "交人待办 · agent 又在忙了：标签仍是 doing/agent" "$(labels_of "$N")" "doing/agent"
drop_case "重派待办 · 绑定的 issue 被人挂上 pending/human" restart pr eval 'set_labels "$N" pending/PR pending/human'
chk "重派待办 · 绑定 issue 暂停：PR 没被加回复审标签" "$(labels_of "$P" | grep -c 'pending/review')" "0"
# 其余组合
drop_case "重派待办 · agent 又在忙了" restart issue eval 'screen "$N" "$BUSY_CLAUDE"'
drop_case "重派待办 · 目标被人挂上 pending/human" restart issue eval 'set_labels "$N" doing/agent pending/human'
drop_case "重派待办 · 目标被人换成 pending/human" restart issue eval 'set_labels "$N" pending/human'
drop_case "重派待办 · 目标多了一条评论" restart issue eval 'add_comment "$N"'
DROP_SKIP_ALIVE=1 drop_case "重派待办 · 目标被关闭" restart issue eval 'jset "$GD/items.json" ".[\$n].state = \"closed\"" --arg n "$N"'
drop_case "重派待办 · 工作窗格里的进程换了" restart issue eval 'T respawn-pane -k -t "$(pane_of "$N")" "$FAKEBIN/claude"; sleep 1'
drop_case "重派待办 · PR 远端多了新提交" restart pr eval 'jset "$GD/items.json" ".[\$n].head.sha = \"3333333333333333333333333333333333333333\"" --arg n "$P"'
drop_case "交人待办 · 绑定的 issue 被人挂上等前置标签" human pr eval 'set_labels "$N" pending/PR pending/blocked'
drop_case "交人待办 · 目标多了一条评论" human issue eval 'add_comment "$N"'
drop_case "交人待办 · 本地有新提交" human issue eval '(cd "$W/wt/issue-$N" && echo y > g && gq add g && gq commit -qm work)'
# 9c 续做时读不出 → 待办原样留着；读得出之后做完
scn retry3; N=$SEQ
mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
tick 0; tick 60; tick 50
touch "$GD/F_post_labels"; tick 60; rm -f "$GD/F_post_labels"
printf '%s\n' 'capture-pane*' > "$CTL/fault"; w0=$(writes_on "$N")
tick 10
chk "续做时画面抓不到：不写、不放弃，待办留着" "$(( $(writes_on "$N") - w0 ))/$(efield "$N" '.pending')/$(alive "$N")" "0/restart/yes"
rm -f "$CTL/fault"; touch "$GD/F_issues_${N}_comments"
tick 10
chk "续做时条目读不全：不写、不放弃，待办留着" "$(( $(writes_on "$N") - w0 ))/$(efield "$N" '.pending')/$(alive "$N")" "0/restart/yes"
rm -f "$GD/F_issues_${N}_comments"
tick 10
chk "读得出之后：做完" "$(labels_of "$N")/$(alive "$N")/$(efield "$N" '.restarts')" "pending/agent/no/1"
# 9d 交人：评论失败 → 下一轮补；加标签失败 → 下一轮补，评论不重复
scn retry4 'STUCK_WORKER_MAX_RESTARTS=0'; N=$SEQ
mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
tick 0; tick 60; tick 50
chk "夹具 · 已催过" "$([ "$(nudges "$N")" -ge 1 ] && echo yes || echo no)" "yes"
touch "$GD/F_post_comment"
tick 60
chk "最多重派 0 次：催完直接交人，不结束会话" "$(alive "$N")/$(efield "$N" '.pending')" "yes/human"
chk "评论没发出去：标签不动" "$(labels_of "$N")/$(comments_on "$N")" "doing/agent/0"
rm -f "$GD/F_post_comment"; touch "$GD/F_post_labels"
tick 10
chk "评论补发了；加标签失败，待办仍留着、标签不动" "$(comments_on "$N")/$(efield "$N" '.pending')/$(labels_of "$N")" "1/human/doing/agent"
rm -f "$GD/F_post_labels"; touch "$GD/F_delete_labels"
tick 10
chk "标签加上了、doing/agent 没摘掉：待办仍留着，评论仍只有一条" "$(labels_of "$N")/$(efield "$N" '.pending')/$(comments_on "$N")" "doing/agent,pending/human/human/1"
rm -f "$GD/F_delete_labels"
tick 10
chk "下一轮收敛：pending/human，评论仍只有一条，记录清掉" "$(labels_of "$N")/$(comments_on "$N")/$(entry "$N")" "pending/human/1/{}"
fi

if want 9 || want 9e; then
# 9e 一直做不完：有上限，不会每轮重试到天荒地老
scn retry5; N=$SEQ
mk_issue "$N" doing/agent; mk_wt "$N"; own "$N" pending/agent; mk_sess "$N" claude worker
tick 0; tick 60; tick 50
touch "$GD/F_post_labels"
tick 60
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do tick 5; done
chk "加标签连续失败：试 10 次后放弃待办，会话和标签都没动" \
    "$(cnt '卡住重派.*失败' "$W/state/poll.log")/$(efield "$N" '.pending')/$(alive "$N")/$(labels_of "$N")" "10//yes/doing/agent"
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
        cp "$CTL/tmux.log" "$TMP/off.$tag/tmux"
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
