#!/usr/bin/env bash
# kind: e2e
# agent 撞到用量上限：这个 agent 停派到解除，被打断的条目留言并转人工 —— GitHub#341。
#
# 跑法：bash tests/usage-limit.test.sh        （约 2 分钟；没有负对照）
# 依赖：bash、jq、python3、git、tmux（3.0+）。不碰网络。
#
# 真跑 agent-poll.sh 和三个派工脚本；真 tmux，但开在**私有 socket** 上（绝不碰本机跑着 worker 的
# 默认 server）；GitHub 是有状态的假服务（tests/lib/fake_github.py）；worker 窗格里放的是真实截屏
# （tests/fixtures/usage-limit/），会话记录按真实 CLI 的记录结构写。
#
# 这块错了的方向都不报错：
#   · 把对话里引用的那句话当成真上限 → 一个 agent 无端停摆、条目被转给人
#   · 「读不到」当成「没变」→ 条目已经被人改了，daemon 照样留言、改标签
#   · 写成功但没收到回应 → 下一轮重复留言，或把自己加的标签当成人改的而停在半路、名额一直占着
#   · 暂停记录读坏了当成「在暂停」→ 整个项目悄悄不派工
#   · 功能关着也多读了 tmux / GitHub → 没开这项的项目悄悄变了
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

# 干净环境重跑自己：worker 会话里带着真 GH_TOKEN / TMUX，漏进来会让 tmux 命令连到外层 server
if [ -z "${USAGE_LIMIT_TEST_CLEAN_ENV:-}" ]; then
    keep=(USAGE_LIMIT_TEST_CLEAN_ENV=1 HOME="$HOME" PATH="$PATH" LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}")
    [ -n "${KEEP_SANDBOX:-}" ] && keep+=(KEEP_SANDBOX="$KEEP_SANDBOX")
    [ -n "${TEST_PART:-}" ] && keep+=(TEST_PART="$TEST_PART")
    [ -n "${ONLY:-}" ] && keep+=(ONLY="$ONLY")
    exec env -i "${keep[@]}" bash "${BASH_SOURCE[0]}" "$@"
fi

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/compat.sh
source "$TEST_DIR/lib/compat.sh"
FX="$TEST_DIR/fixtures/usage-limit"

if ! command -v tmux > /dev/null 2>&1; then
    echo "⏭ 本机没有 tmux，整份跳过"; exit 0
fi

SANDBOX=$(mktemp -d); SANDBOX="$(cd "$SANDBOX" && pwd -P)"
TMUX_DIR=$(mktemp -d /tmp/ul.XXXX)          # socket 路径有长度上限，单独放一个短目录
export TMUX_TMPDIR="$TMUX_DIR"
SOCK="$TMUX_DIR/tmux-$(id -u)/default"
mkdir -p "$(dirname "$SOCK")"; chmod 700 "$(dirname "$SOCK")"
REAL_TMUX="$(command -v tmux)"
T() { timeout 10 "$REAL_TMUX" -S "$SOCK" "$@"; }
cleanup() {
    timeout 10 "$REAL_TMUX" -S "$SOCK" kill-server 2>/dev/null || true
    [ -n "${KEEP_SANDBOX:-}" ] && { echo "SANDBOX=$SANDBOX"; return 0; }
    rm -rf "$SANDBOX" "$TMUX_DIR"
}
trap cleanup EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home" "$SANDBOX/ctl"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TZ=UTC
CTL="$SANDBOX/ctl"

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
# 被测脚本用的 tmux：每次调用记一行；$CTL/fault 里写一个 glob，参数整串匹配上就返回 1（一次查询失败）
cat > "$SANDBOX/bin/tmux" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CTL/tmux.log"
if [ -s "$CTL/fault" ]; then
    pat="\$(cat "$CTL/fault")"
    if [[ "\$*" == \$pat ]]; then echo "injected failure: \$*" >> "$CTL/fault.hits"; exit 1; fi
fi
exec "$REAL_TMUX" "\$@"
SH
# 假 agent：不在 tmux 里（driver 探版本）立刻退出；在 tmux 里记一行「名字 参数」然后睡着
for a in claude codex; do
    cat > "$SANDBOX/bin/$a" <<SH
#!/usr/bin/env bash
[ -n "\${TMUX:-}" ] || exit 0
trap '' HUP
echo "$a \$*" | tr '\n' ' ' >> "$CTL/runs"; echo >> "$CTL/runs"
echo "AGENT-RUN $a"
exec sleep 300
SH
done
printf '#!/usr/bin/env bash\nexit 0\n' > "$SANDBOX/bin/systemctl"
chmod +x "$SANDBOX/bin"/*
export PATH="$SANDBOX/bin:$PATH"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}
has() {   # <名字> <文件> <固定字符串>
    if grep -qF -- "$3" "$2" 2>/dev/null; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1（$2 里没有「$3」）"; fail=$((fail+1)); fi
}
hasnt() {
    if grep -qF -- "$3" "$2" 2>/dev/null; then echo "  ❌ $1（$2 里出现了「$3」）"; fail=$((fail+1))
    else echo "  ✅ $1"; pass=$((pass+1)); fi
}
want() { [ -z "${ONLY:-}" ] || case " $ONLY " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

ROOT="$REPO_DIR"
W="$SANDBOX/run"
export FAKE_GH_REPO="example/ul"
HOSTID="ulhost"
T0=1790000000            # 受控时钟（POLL_FAKE_NOW）：2026-09-21 14:13:20 UTC
NOW=$T0
PFX="ultest"

# ── 一套干净的项目：配置、状态、假 GitHub、空的 tmux server ──
fresh() {   # [额外配置行…]
    T kill-server 2>/dev/null; sleep 0.2
    rm -rf "$W" "$HOME/.claude" "$HOME/.codex" "$HOME/.local/state/cavil-loop"; mkdir -p "$W/state" "$W/wt" "$W/gh" "$W/logs"
    git init -q -b main "$W/project" 2>/dev/null
    GD="$W/gh"; export FAKE_GH_DIR="$GD"; CALLS="$GD/calls.log"; STATE="$W/state/state.json"
    CONF="$W/cavil-loop.config"; UL="$W/state/usage-limit.json"; LOG="$W/state/poll.log"
    cat > "$CONF" <<CONF
REPO="example/ul"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
SESSION_LOG_DIR="$W/logs"
TMUX_PREFIX="$PFX"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
WORKER_AGENT="claude"
REVIEW_WORKER_AGENT="codex"
SELFHEAL_HOST_ID="$HOSTID"
POST_MERGE_RETROSPECTIVE=false
AUTO_CLEANUP_ON_MERGE=false
PENDING_HUMAN_CONFLICT_CHECK=false
REAP_FINISHED_WORKERS=0
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=3
AGENT_TRUST_PROMPT_WAIT_SECS=1
AGENT_SESSION_CAPTURE_SECS=1
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    local l; for l in "$@"; do printf '%s\n' "$l" >> "$CONF"; done
    echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/events.json"
    echo '{}' > "$GD/comments.json"; echo '{}' > "$GD/perms.json"
    echo loop-bot > "$GD/me"
    echo '{"seen_comments":{},"seen_issue_comments":{},"seen_review_comments":{},"seen_reviews":{},"worker_models":{},"worker_trigger_labels":{},"worker_hosts":{},"split_rollups":{},"split_rollup_commented":{},"split_rollup_queue":{},"merged_label_queue":{},"pr_conflict":{}}' > "$STATE"
    : > "$CTL/runs"; : > "$CTL/tmux.log"; rm -f "$CTL/fault" "$CTL/fault.hits"
    NOW=$T0
    # 另一个 session 撑着 server（最后一个 session 没了 server 就退出）
    T new-session -d -s keep "sleep 900"
}
on() { fresh 'ENABLE_USAGE_LIMIT_PAUSE="true"' "$@"; }
jset() { local f="$1" e="$2"; shift 2; jq "$@" "$e" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
mkissue() {   # <n> <labels_csv>
    jset "$GD/items.json" '.[$n] = {kind:"issue", state:"open", title:"t", body:"需求", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}' --arg n "$1"
    jset "$GD/labels.json" '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$2"
}
mkpr() {   # <n> <labels_csv>
    jset "$GD/items.json" '.[$n] = {kind:"pr", state:"open", merged:false, draft:false, title:"t", body:"x", user:{login:"loop-bot"},
            updated_at:"2026-01-01T00:00:00Z",
            head:{sha:"1111111111111111111111111111111111111111", ref:("feature/issue-" + $n), repo:{full_name:"example/ul"}}, base:{ref:"main"}}' --arg n "$1"
    jset "$GD/labels.json" '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$2"
}
labels() { jq -r --arg n "$1" '.[$n] | sort | join(",")' "$GD/labels.json"; }
ncomments() { jq -r --arg n "$1" '(.[$n] // []) | length' "$GD/comments.json"; }
nwrites() { grep -cE -- '-X (POST|DELETE|PATCH|PUT)' "$CALLS" 2>/dev/null || true; }

# ── 一个「已经派出去」的 worker：tmux 会话里摆着一屏、登记了会话、有一份会话记录 ──
enc() { printf %s "$1" | tr -c 'A-Za-z0-9' '-'; }
record_path() {   # <work> <agent> <sid>
    if [ "$2" = claude ]; then echo "$HOME/.claude/projects/$(enc "$W/wt/issue-$1")/$3.jsonl"
    else echo "$HOME/.codex/sessions/2026/09/21/rollout-2026-09-21T00-00-00-$3.jsonl"; fi
}
# 会话记录：真实 CLI 的记录结构（claude：一行一个 user / assistant；codex：rollout 的 response_item / event_msg）
write_record() {   # <work> <agent> <sid> <clean|assistant|tool|prompt|halfline|synthetic|old>
    local f; f="$(record_path "$1" "$2" "$3")"; mkdir -p "$(dirname "$f")"
    local ts="2026-09-21T16:40:00.000Z" q="You've hit your session limit · resets 4:50pm (Asia/Singapore)"
    [ "$2" = codex ] && q="You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 21st, 2026 7:35 PM."
    if [ "$2" = claude ]; then
        {
            jq -cn --arg t "$ts" '{type:"user", message:{role:"user", content:"接着做这个 issue"}, timestamp:$t, sessionId:"s"}'
            jq -cn --arg t "$ts" '{type:"assistant", message:{role:"assistant", model:"claude-opus-5", content:[{type:"text", text:"先截图"}, {type:"tool_use", id:"tu1", name:"Bash", input:{command:"node shoot-all.mjs"}}]}, timestamp:$t}'
            jq -cn --arg t "$ts" '{type:"user", message:{role:"user", content:[{type:"tool_result", tool_use_id:"tu1", content:"shot: 02-learn-home"}]}, toolUseResult:{stdout:"shot: 02-learn-home", stderr:""}, timestamp:$t}'
            case "$4" in
                assistant) jq -cn --arg t "$ts" --arg q "$q" '{type:"assistant", message:{role:"assistant", model:"claude-opus-5", content:[{type:"text", text:("界面上会显示：\n  ⎿  " + $q)}]}, timestamp:$t}' ;;
                tool) jq -cn --arg t "$ts" --arg q "$q" '{type:"user", message:{role:"user", content:[{type:"tool_result", tool_use_id:"tu2", content:("  ⎿  " + $q)}]}, toolUseResult:{stdout:("  ⎿  " + $q), stderr:""}, timestamp:$t}' ;;
                prompt) jq -cn --arg t "$ts" --arg q "$q" '{type:"user", message:{role:"user", content:("issue 里引用了：" + $q)}, timestamp:$t}' ;;
                synthetic) jq -cn --arg t "$ts" --arg q "$q" '{type:"assistant", isApiErrorMessage:true, error:"rate_limit", message:{role:"assistant", model:"<synthetic>", content:[{type:"text", text:$q}]}, timestamp:$t}' ;;
                old) jq -cn --arg q "$q" '{type:"assistant", message:{role:"assistant", model:"claude-opus-5", content:[{type:"text", text:("上一轮讨论过：" + $q)}]}, timestamp:"2026-09-01T00:00:00.000Z"}' ;;
            esac
        } > "$f"
    else
        {
            jq -cn --arg t "$ts" --arg id "$3" --arg cwd "$W/wt/issue-$1" '{timestamp:$t, type:"session_meta", payload:{id:$id, cwd:$cwd}}'
            jq -cn --arg t "$ts" '{timestamp:$t, type:"response_item", payload:{type:"message", role:"user", content:[{type:"input_text", text:"复审这个 PR"}]}}'
            jq -cn --arg t "$ts" '{timestamp:$t, type:"response_item", payload:{type:"message", role:"assistant", content:[{type:"output_text", text:"开始看 diff"}]}}'
            jq -cn --arg t "$ts" '{timestamp:$t, type:"response_item", payload:{type:"function_call_output", call_id:"c1", output:"diff --git a/x b/x"}}'
            jq -cn --arg t "$ts" '{timestamp:$t, type:"event_msg", payload:{type:"token_count", rate_limits:{primary:{used_percent:100.0, window_minutes:300, resets_at:1790019300}}}}'
            case "$4" in
                assistant) jq -cn --arg t "$ts" --arg q "$q" '{timestamp:$t, type:"response_item", payload:{type:"message", role:"assistant", content:[{type:"output_text", text:("■ " + $q)}]}}' ;;
                tool) jq -cn --arg t "$ts" --arg q "$q" '{timestamp:$t, type:"response_item", payload:{type:"function_call_output", call_id:"c2", output:("■ " + $q)}}' ;;
            esac
        } > "$f"
    fi
    [ "$4" != halfline ] || printf '{"type":"assistant","message":{"role":"assis' >> "$f"
}
# codex 样本屏上的日期是 2026-08（真实截屏原文）；受控时钟在 9 月，换成钟点之后的一个时刻
codex_screen() { sed 's/Aug 20th, 2026 11:35 AM/Sep 21st, 2026 7:35 PM/' "$FX/$1" > "$CTL/screen.$1"; echo "$CTL/screen.$1"; }
mkworker() {   # <work> <agent> <role> <屏幕文件> [会话 id（空 = 不登记）] [触发标签]
    local work="$1" agent="$2" role="$3" screen="$4" sid="${5-}" trig="${6:-pending/agent}" s="$PFX-issue$1"
    T new-session -d -x 220 -y 50 -s "$s" "cat '$screen'; exec sleep 900"
    T set-option -t "=$s:" @worker_agent "$agent" >/dev/null
    T set-option -t "=$s:" @worker_role "$role" >/dev/null
    jset "$STATE" '.worker_hosts[$k] = $h | .worker_trigger_labels[$k] = $t' --arg k "$work" --arg h "$HOSTID" --arg t "$trig"
    if [ -n "$sid" ]; then
        mkdir -p "$W/state/agent-sessions"; echo "$sid" > "$W/state/agent-sessions/$work.$agent.$role"
    fi
    sleep 0.3
}
screen_of() { T capture-pane -p -t "$PFX-issue$1" | sed 's/[[:space:]]*$//' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}'; }
poll() {   # [环境变量赋值…]
    : > "$CALLS"
    ( env "$@" POLL_FAKE_NOW="$NOW" CODING_AGENT_CONFIG="$CONF" bash "$ROOT/scripts/agent-poll.sh" > "$W/poll.out" 2>&1 &
      echo $! > "$W/poll.pid"; wait $! ) 2>/dev/null
}
pause_file() { ls "$HOME/.local/state/cavil-loop/usage-limit/"$1-*.json 2>/dev/null | head -1; }
ep() { python3 -c "import datetime as d,sys; print(int(d.datetime.strptime(sys.argv[1], '%Y-%m-%d %H:%M').replace(tzinfo=d.timezone.utc).timestamp()))" "$1"; }
SID1="11111111-1111-4111-8111-111111111111"
SID2="22222222-2222-4222-8222-222222222222"
# 样本屏写的是 4:50pm (Asia/Singapore) = 08:50 UTC；T0 是 14:13 UTC → 下一个 08:50 UTC 在第二天
UNTIL_CLAUDE=$(python3 -c "
import datetime as d
t=d.datetime.fromtimestamp($T0, d.timezone.utc); r=t.replace(hour=8, minute=50, second=0, microsecond=0)
print(int((r if r>t else r+d.timedelta(days=1)).timestamp()))")

# ═════════════════════════════════════════════════════════════════════════
# 【1】识别规则本身：真实截屏 → 是不是上限、几点解除；会话记录 → 这句话是谁打出来的
# ═════════════════════════════════════════════════════════════════════════
det() {   # <agent> <屏幕文件> [usage_limit.py 的其余参数…] → 一行 JSON
    local a="$1" f="$2"; shift 2
    python3 -I "$ROOT/scripts/usage_limit.py" detect --agent "$a" --screen "$f" "$@"
}
if want 1; then
echo "【1】识别规则：真实截屏、解除时间、会话记录"
mkdir -p "$SANDBOX/u"; W="$SANDBOX/u"
write_record 1 claude "$SID1" clean;  RC="$(record_path 1 claude "$SID1")"
write_record 1 codex  "$SID2" clean;  RX="$(record_path 1 codex "$SID2")"
# 屏幕
for f in claude-limit.txt claude-limit-autocontinue.txt; do
    chk "claude 上限屏认出：$f" "$(det claude "$FX/$f" --record "$RC" --now $T0 | jq -r .verdict)" "limit"
done
for f in codex-limit-dialog.txt codex-limit-composer.txt; do
    chk "codex 上限屏认出：$f" "$(det codex "$(codex_screen $f)" --record "$RX" --now $T0 | jq -r .verdict)" "limit"
done
for f in claude-limit-then-prompt.txt claude-limit-reset-continued.txt claude-weekly-warning.txt; do
    chk "claude 反例不认：$f" "$(det claude "$FX/$f" --record "$RC" --now $T0 | jq -r .verdict)" "no"
done
chk "codex 反例不认：还有 N 次重置可用" "$(det codex "$FX/codex-resets-available.txt" --record "$RX" --now $T0 | jq -r .verdict)" "no"
# 上限提示后面又有了新输出 → 不是最后一块
{ sed '/^──/,$d' "$FX/claude-limit.txt"; printf '\n● 接着跑测试\n\n────────────────────────────────────────\n❯ \n'; } > "$CTL/s.more"
chk "claude：提示后面还有新输出 → 不认" "$(det claude "$CTL/s.more" --record "$RC" --now $T0 | jq -r .verdict)" "no"
{ cat "$(codex_screen codex-limit-composer.txt)" | sed '/^› Ask Codex/,$d'; printf '• 继续看 diff\n\n› Ask Codex to do anything\n'; } > "$CTL/s.more2"
chk "codex：提示后面还有新输出 → 不认" "$(det codex "$CTL/s.more2" --record "$RX" --now $T0 | jq -r .verdict)" "no"
# 窄窗格把 codex 那句话折成三行
sed 's/^■ You.ve hit your usage limit\. Visit https:\/\/chatgpt.com\/codex\/settings\/usage to$/■ You'"'"'ve hit your usage limit. Visit\nhttps:\/\/chatgpt.com\/codex\/settings\/usage to/' "$(codex_screen codex-limit-dialog.txt)" > "$CTL/s.narrow"
chk "codex：折成三行照样认出" "$(det codex "$CTL/s.narrow" --record "$RX" --now $T0 | jq -r .verdict)" "limit"
chk "codex：折行不改变读出的解除时间" "$(det codex "$CTL/s.narrow" --record "$RX" --now $T0 | jq -r .reset_text)" "Sep 21st, 2026 7:35 PM"

# 解除时间
chk "claude：4:50pm 新加坡 = 当天 08:50 UTC 之后的下一个" "$(det claude "$FX/claude-limit.txt" --record "$RC" --now $T0 | jq -r .reset_epoch)" "$(ep '2026-09-22 08:50')"
chk "claude：来源写 screen" "$(det claude "$FX/claude-limit.txt" --record "$RC" --now $T0 | jq -r .reset_source)" "screen"
N2=$(ep '2026-09-22 08:00')   # 新加坡 16:00，离 16:50 只差 50 分钟（不跨午夜）
chk "claude：不跨午夜时取当天" "$(det claude "$FX/claude-limit.txt" --record "$RC" --now $N2 | jq -r .reset_epoch)" "$(ep '2026-09-22 08:50')"
sed 's/resets 4:50pm (Asia\/Singapore)/resets Sep 25, 2pm (Asia\/Singapore)/' "$FX/claude-limit.txt" > "$CTL/s.date"
chk "claude：带日期的写法（周上限提醒里见过的格式）" "$(det claude "$CTL/s.date" --record "$RC" --now $T0 | jq -r .reset_epoch)" "$(ep '2026-09-25 06:00')"
chk "codex：年月日按本机时区（测试里是 UTC）" "$(det codex "$(codex_screen codex-limit-dialog.txt)" --record "$RX" --now $T0 | jq -r .reset_epoch)" "$(ep '2026-09-21 19:35')"
sed 's/try again at Sep 21st, 2026 7:35 PM\./try again later./' "$(codex_screen codex-limit-dialog.txt)" > "$CTL/s.later"
chk "读不出解除时间 → 固定等待" "$(det codex "$CTL/s.later" --record "$RX" --now $T0 --fallback 1800 | jq -r '"\(.verdict) \(.reset_source) \(.reset_epoch)"')" "limit fallback $((T0 + 1800))"
sed 's/Sep 21st, 2026 7:35 PM/Dec 25th, 2026 7:35 PM/' "$(codex_screen codex-limit-dialog.txt)" > "$CTL/s.far"
chk "解除时间在 8 天以外 → 固定等待" "$(det codex "$CTL/s.far" --record "$RX" --now $T0 | jq -r '"\(.verdict) \(.reset_source) \(.reset_epoch)"')" "limit fallback $((T0 + 3600))"
chk "屏上的解除时间已经过了 → 不算上限" "$(det codex "$FX/codex-limit-dialog.txt" --record "$RX" --now $T0 | jq -r .verdict)" "no"
sed 's/resets 4:50pm (Asia\/Singapore)/resets 4:50pm (Mars\/Olympus)/' "$FX/claude-limit.txt" > "$CTL/s.tz"
sed 's/resets 4:50pm (Asia\/Singapore)/resets 4:50pm @maint [x](http:\/\/e.invalid) <b>/' "$FX/claude-limit.txt" > "$CTL/s.inj"
chk "解除时间那一段不是纯时间文字 → 固定等待，原文不带出来（它会进评论）" "$(det claude "$CTL/s.inj" --record "$RC" --now $T0 | jq -r '"\(.verdict) \(.reset_source) [\(.reset_text)]"')" "limit fallback []"
chk "认不出的时区 → 固定等待，不猜" "$(det claude "$CTL/s.tz" --record "$RC" --now $T0 | jq -r .reset_source)" "fallback"

# 会话记录：同一屏，来源不同
for k in assistant tool prompt; do
    write_record 2 claude "$SID1" "$k"
    chk "claude 同一屏、记录里${k}含这句 → 不认" "$(det claude "$FX/claude-limit.txt" --record "$(record_path 2 claude "$SID1")" --now $T0 | jq -r .verdict)" "no"
done
for k in assistant tool; do
    write_record 2 codex "$SID2" "$k"
    chk "codex 同一屏、记录里${k}含这句 → 不认" "$(det codex "$(codex_screen codex-limit-dialog.txt)" --record "$(record_path 2 codex "$SID2")" --now $T0 | jq -r .verdict)" "no"
done
write_record 2 claude "$SID1" synthetic
chk "claude：CLI 自己写的上限错误记录不算引用" "$(det claude "$FX/claude-limit.txt" --record "$(record_path 2 claude "$SID1")" --now $T0 | jq -r .verdict)" "limit"
write_record 2 claude "$SID1" old
chk "本次派工之前的旧对话里有这句：不带起点时按引用算" "$(det claude "$FX/claude-limit.txt" --record "$(record_path 2 claude "$SID1")" --now $T0 | jq -r .verdict)" "no"
chk "本次派工之前的旧对话里有这句：带起点时不算" "$(det claude "$FX/claude-limit.txt" --record "$(record_path 2 claude "$SID1")" --since "$(ep '2026-09-20 00:00')" --now $T0 | jq -r .verdict)" "limit"
write_record 2 claude "$SID1" halfline
chk "记录最后一行还没写完 → 证据不足" "$(det claude "$FX/claude-limit.txt" --record "$(record_path 2 claude "$SID1")" --now $T0 | jq -r .verdict)" "unsure"
chk "记录文件不存在 → 证据不足" "$(det claude "$FX/claude-limit.txt" --record "$W/nope.jsonl" --now $T0 | jq -r .verdict)" "unsure"
chk "没有会话记录可核对 → 证据不足" "$(det claude "$FX/claude-limit.txt" --now $T0 | jq -r .verdict)" "unsure"
: > "$CTL/empty.jsonl"
chk "记录是空文件 → 证据不足" "$(det claude "$FX/claude-limit.txt" --record "$CTL/empty.jsonl" --now $T0 | jq -r .verdict)" "unsure"
chk "同一屏的指纹不随记录变" "$(det claude "$FX/claude-limit.txt" --now $T0 | jq -r .fingerprint)" "$(det claude "$FX/claude-limit.txt" --record "$RC" --now $T0 | jq -r .fingerprint)"
W="$SANDBOX/run"
fi

# ═════════════════════════════════════════════════════════════════════════
# 【2】claude 撞上限（issue）：第一轮只记下，第二轮认定 → 停派 + 留言 + 转人工
# ═════════════════════════════════════════════════════════════════════════
if want 2; then
echo "【2】claude 撞上限：两轮认定，留言并转人工，会话不动"
on
mkissue 7 "doing/agent,autopilot"
write_record 7 claude "$SID1" clean
mkworker 7 claude worker "$FX/claude-limit.txt" "$SID1"
before_screen="$(screen_of 7)"
poll
chk "第 1 轮：标签不动" "$(labels 7)" "autopilot,doing/agent"
chk "第 1 轮：没有留言" "$(ncomments 7)" "0"
chk "第 1 轮：没有任何写请求" "$(nwrites)" "0"
chk "第 1 轮：还没有暂停记录" "$(pause_file claude)" ""
has "第 1 轮：日志说下一轮再认定" "$LOG" "下一轮屏幕和会话记录都没变就认定"
poll
chk "第 2 轮：标签换成 pending/human（别的标签原样）" "$(labels 7)" "autopilot,pending/human"
chk "第 2 轮：留言一条" "$(ncomments 7)" "1"
pf="$(pause_file claude)"
chk "第 2 轮：有 claude 的暂停记录" "$([ -n "$pf" ] && echo yes)" "yes"
chk "暂停到样本屏上写的时刻（4:50pm 新加坡时间的下一个）" "$(jq -r '.until' "$pf" 2>/dev/null)" "$UNTIL_CLAUDE"
chk "暂停记录写明读自界面" "$(jq -r '.source' "$pf" 2>/dev/null)" "screen"
body="$(jq -r '.["7"][0].body' "$GD/comments.json")"
printf '%s\n' "$body" > "$CTL/body"
has "留言说明是哪个 agent" "$CTL/body" 'agent：`claude`（开发）'
has "留言带界面上的解除时间原文" "$CTL/body" "4:50pm (Asia/Singapore)"
has "留言写明标签改回哪个" "$CTL/body" '改回 `pending/agent`'
hasnt "留言里没有第二人称" "$CTL/body" "你"
hasnt "留言里没有第一人称" "$CTL/body" "我"
chk "留言是写身份发的" "$(jq -r '.["7"][0].user.login' "$GD/comments.json")" "loop-bot"
chk "会话还在" "$(T has-session -t "=$PFX-issue7" 2>/dev/null && echo alive)" "alive"
chk "屏幕没被动过（没送字、没换程序）" "$(screen_of 7)" "$before_screen"
hasnt "daemon 没往会话里送键" "$CTL/tmux.log" "send-keys"
hasnt "daemon 没关会话" "$CTL/tmux.log" "kill-session"
hasnt "daemon 没换窗格里的程序" "$CTL/tmux.log" "respawn-pane"
chk "转人工的记录已清" "$(jq -r '.items | length' "$UL")" "0"
has "日志：暂停派工到几点" "$LOG" "⏸ 用量上限：claude 撞到用量上限（issue #7），暂停派工到"
has "日志：已留言并转人工" "$LOG" "issue #7 已留言并转人工"
poll
chk "第 3 轮：不再留言" "$(ncomments 7)" "1"
chk "第 3 轮：没有写请求" "$(nwrites)" "0"
fi

# ═════════════════════════════════════════════════════════════════════════
# 【3】不误判：屏幕一样、来源不同；证据不足；反例屏；别人的活
# ═════════════════════════════════════════════════════════════════════════
quiet_rounds() {   # <名字> <轮数>：跑几轮，要求什么都没写、没有暂停
    local name="$1" n="$2" i w=0
    for i in $(seq "$n"); do poll; w=$((w + $(nwrites))); done
    chk "$name：没有任何写请求" "$w" "0"
    chk "$name：标签不动" "$(labels 7)" "doing/agent"
    chk "$name：没有暂停记录" "$(pause_file claude)$(pause_file codex)" ""
    has "$name：这一轮确实看过这个会话的屏幕" "$CTL/tmux.log" "capture-pane -p -t %"
}
if want 3; then
echo "【3】不误判"
for k in assistant tool prompt; do
    on; mkissue 7 "doing/agent"; write_record 7 claude "$SID1" "$k"
    mkworker 7 claude worker "$FX/claude-limit.txt" "$SID1"
    quiet_rounds "同一屏、会话记录里${k}含这句" 3
done
on; mkissue 7 "doing/agent"; mkworker 7 claude worker "$FX/claude-limit.txt" ""
quiet_rounds "会话没登记" 3
chk "会话没登记：「证据不足」只说一次" "$(grep -c '证据不足' "$LOG")" "1"

on; mkissue 7 "doing/agent"; write_record 7 claude "$SID1" halfline
mkworker 7 claude worker "$FX/claude-limit.txt" "$SID1"
quiet_rounds "记录最后一行没写完（落盘延迟）" 2
write_record 7 claude "$SID1" clean       # 写完了
poll; chk "记录写完后的第 1 轮：只记下" "$(labels 7) $(ncomments 7)" "doing/agent 0"
poll; chk "记录写完后的第 2 轮：认定并转人工" "$(labels 7) $(ncomments 7)" "pending/human 1"

on; mkissue 7 "doing/agent"; write_record 7 claude "$SID1" clean
mkworker 7 claude worker "$FX/claude-limit.txt" "$SID1"
poll
jq -cn '{type:"assistant", message:{role:"assistant", model:"claude-opus-5", content:[{type:"text", text:"还在写"}]}, timestamp:"2026-09-21T16:41:00.000Z"}' >> "$(record_path 7 claude "$SID1")"
poll; chk "两轮之间会话记录长了：不认定" "$(labels 7) $(ncomments 7) $(pause_file claude)" "doing/agent 0 "
poll; chk "之后两轮都没变：认定" "$(labels 7) $(ncomments 7)" "pending/human 1"

for f in claude-limit-then-prompt.txt claude-limit-reset-continued.txt claude-weekly-warning.txt; do
    on; mkissue 7 "doing/agent"; write_record 7 claude "$SID1" clean
    mkworker 7 claude worker "$FX/$f" "$SID1"
    quiet_rounds "反例屏 $f" 2
done
on; mkissue 7 "doing/agent"; write_record 7 codex "$SID2" clean
mkworker 7 codex worker "$FX/codex-resets-available.txt" "$SID2"
quiet_rounds "反例屏 codex 重置次数提示" 2

# 别的机器派的、同一个工作编号下 issue 和 PR 都在进行中的：不碰
on; mkissue 7 "doing/agent"; write_record 7 claude "$SID1" clean
mkworker 7 claude worker "$FX/claude-limit.txt" "$SID1"
jset "$STATE" '.worker_hosts["7"] = "other-host"'
for i in 1 2 3; do poll; done
chk "别的机器派的：不碰" "$(labels 7) $(ncomments 7) $(pause_file claude)" "doing/agent 0 "
on; mkissue 7 "doing/agent"; mkpr 8 "doing/agent"; jset "$GD/items.json" '.["8"].head.ref = "feature/issue-7"'
write_record 7 claude "$SID1" clean; mkworker 7 claude worker "$FX/claude-limit.txt" "$SID1"
for i in 1 2 3; do poll; done
chk "issue 和它的 PR 都挂着进行中：都不碰" "$(labels 7)|$(labels 8)|$(ncomments 7)$(ncomments 8)|$(pause_file claude)" "doing/agent|doing/agent|00|"
# 条目上还挂着别的流程标签：照样停派，但不转人工，也不每两轮重来一遍
on 'LABEL_PENDING_BLOCKED="pending/blocked"'; mkissue 7 "doing/agent,pending/blocked"; write_record 7 claude "$SID1" clean
mkworker 7 claude worker "$FX/claude-limit.txt" "$SID1"
for i in 1 2 3 4 5 6; do poll; done
chk "挂着别的流程标签：不留言、不改标签" "$(labels 7) $(ncomments 7)" "doing/agent,pending/blocked 0"
chk "挂着别的流程标签：照样停派" "$([ -n "$(pause_file claude)" ] && echo paused)" "paused"
chk "挂着别的流程标签：「不转人工」只说一次" "$(grep -c '不转人工——' "$LOG")" "1"
fi

# ═════════════════════════════════════════════════════════════════════════
# 【4】codex、复审角色、PR；读不出解除时间
# ═════════════════════════════════════════════════════════════════════════
if want 4; then
echo "【4】codex 复审 PR 时撞上限"
on
mkissue 30 "pending/PR"; mkpr 31 "doing/agent"; jset "$GD/items.json" '.["31"].head.ref = "feature/issue-30"'
write_record 30 codex "$SID2" clean
mkworker 30 codex review "$(codex_screen codex-limit-dialog.txt)" "$SID2" "pending/review"
poll; poll
chk "PR 换成 pending/human" "$(labels 31)" "pending/human"
chk "绑定的 issue 不动" "$(labels 30) $(ncomments 30)" "pending/PR 0"
jq -r '.["31"][0].body' "$GD/comments.json" > "$CTL/body"
has "留言：codex（复审）" "$CTL/body" 'agent：`codex`（复审）'
has "留言：改回复审标签" "$CTL/body" '改回 `pending/review`'
chk "暂停的是 codex" "$([ -n "$(pause_file codex)" ] && echo yes)" "yes"
chk "claude 没被暂停" "$(pause_file claude)" ""
chk "codex 暂停到屏上写的时刻" "$(jq -r .until "$(pause_file codex)")" "$(ep '2026-09-21 19:35')"
hasnt "换模型的弹框没被碰（没送键）" "$CTL/tmux.log" "send-keys"

on 'USAGE_LIMIT_FALLBACK_SECS=1800'
mkissue 7 "doing/agent"; write_record 7 codex "$SID2" clean
sed 's/try again at Sep 21st, 2026 7:35 PM\./try again later./' "$(codex_screen codex-limit-composer.txt)" > "$CTL/s.later"
mkworker 7 codex worker "$CTL/s.later" "$SID2"
poll; poll
chk "读不出解除时间：按配置的固定等待暂停" "$(jq -r '"\(.source) \(.until)"' "$(pause_file codex)")" "fallback $((T0 + 1800))"
jq -r '.["7"][0].body' "$GD/comments.json" > "$CTL/body"
has "读不出解除时间：留言照实说是估的" "$CTL/body" "按固定等待 30 分钟估的"
chk "读不出解除时间：照样转人工" "$(labels 7)" "pending/human"
fi

# ═════════════════════════════════════════════════════════════════════════
# 【5】停派：撞上限的 agent 不派、别的 agent 照派、到点恢复、续接原会话
# ═════════════════════════════════════════════════════════════════════════
with_origin() {   # 派工要真的建 worktree：bare origin + 主 checkout
    local gq='git -c user.email=t@example.invalid -c user.name=t'
    rm -rf "$W/project" "$W/up.git" "$W/seed"
    $gq init -q --bare -b main "$W/up.git" >/dev/null 2>&1
    $gq clone -q "$W/up.git" "$W/seed" >/dev/null 2>&1
    (cd "$W/seed" && echo x > f && $gq add f && $gq commit -qm init && $gq push -q origin HEAD:main) >/dev/null 2>&1
    $gq clone -q "$W/up.git" "$W/project" >/dev/null 2>&1
}
runs() { grep -c "^$1 " "$CTL/runs" 2>/dev/null || true; }
if want 5; then
echo "【5】停派与恢复"
on; with_origin
mkissue 7 "doing/agent"; write_record 7 claude "$SID1" clean
git -C "$W/project" worktree add -q "$W/wt/issue-7" -b feature/issue-7 >/dev/null 2>&1
mkworker 7 claude worker "$FX/claude-limit.txt" "$SID1"
poll; poll
chk "前提：issue 7 已转人工、claude 在暂停" "$(labels 7) $([ -n "$(pause_file claude)" ] && echo paused)" "pending/human paused"
mkissue 20 "pending/agent"; mkissue 21 "pending/review"
: > "$CTL/runs"
poll
chk "claude 的新 issue 不派：标签不动" "$(labels 20)" "pending/agent"
chk "claude 的新 issue 不派：没起 claude" "$(runs claude)" "0"
chk "不计派工失败" "$(ls "$W/state/dispatch-fail" 2>/dev/null | wc -l | tr -d ' ')" "0"
has "日志写明暂停到几点、跳过了谁" "$LOG" "本轮跳过（标签不动、不计失败）：issue #20"
chk "另一个 agent（codex 复审）照常派" "$(labels 21) $(runs codex)" "doing/agent 1"
# 人提前把转人工的那条改回派工标签：等到解除才派
jset "$GD/labels.json" '.["7"] = ["pending/agent"]'
: > "$CTL/runs"; poll
chk "提前改回标签：解除前不派" "$(labels 7) $(runs claude)" "pending/agent 0"
# 同一台机器上的另一个项目（另一份配置和状态目录，同一个账号目录）也停派
sed -e "s|STATE_DIR=.*|STATE_DIR=\"$W/state2\"|" -e 's|TMUX_PREFIX=.*|TMUX_PREFIX="ulb"|' "$CONF" > "$W/conf2"; mkdir -p "$W/state2"
echo 'SELFHEAL_ONLY_OWN_WORKERS="true"' >> "$W/conf2"     # 第二个项目不去「自愈」第一个项目的会话
( : > "$CALLS"; env POLL_FAKE_NOW="$NOW" CODING_AGENT_CONFIG="$W/conf2" bash "$ROOT/scripts/agent-poll.sh" > /dev/null 2>&1 )
chk "同机另一个项目：同一个 agent 也不派" "$(labels 20) $(runs claude)" "pending/agent 0"
has "同机另一个项目：日志同样写明" "$W/state2/poll.log" "claude 暂停派工到"
# 别的会话在忙，不会把暂停清掉
chk "codex 会话在跑着，claude 的暂停还在" "$([ -n "$(pause_file claude)" ] && echo paused)" "paused"
# 到点。转人工的那个会话这时通常已被完工回收关掉（闲置 5 分钟）：这里直接关掉它
T kill-session -t "=$PFX-issue7"
NOW=$((UNTIL_CLAUDE + 1)); : > "$CTL/runs"
poll
chk "到点后：排队的 issue 派出去了" "$(labels 20)" "doing/agent"
chk "到点后：被转人工又改回标签的那条也派了" "$(labels 7)" "doing/agent"
has "到点后：那一条续接的是登记的原会话" "$CTL/runs" "claude --resume $SID1"

# 暂停记录坏了 / 写着离谱的时间：按没有暂停处理（否则整个项目悄悄不派工）
on; with_origin; mkissue 20 "pending/agent"
mkdir -p "$HOME/.local/state/cavil-loop/usage-limit"
PF="$HOME/.local/state/cavil-loop/usage-limit/claude-$(printf '%s' "$HOME/.claude" | sha256sum | cut -c1-12).json"
echo '{"until": ' > "$PF"
poll
chk "暂停记录读不出：照常派" "$(labels 20)" "doing/agent"
has "暂停记录读不出：日志说明" "$LOG" "读不出，按「没有暂停」处理"
on; with_origin; mkissue 20 "pending/agent"; mkdir -p "$(dirname "$PF")"
echo "{\"until\": $((T0 + 40 * 86400))}" > "$PF"
poll
chk "暂停记录写着 40 天后：照常派" "$(labels 20)" "doing/agent"
on; with_origin; mkissue 20 "pending/agent"; mkdir -p "$(dirname "$PF")"
echo "{\"until\": $((T0 + 600))}" > "$PF"
poll
chk "对照：格式正常的暂停记录确实挡住派工（上面两条走的是同一个文件）" "$(labels 20)" "pending/agent"
# 另一个账号目录的 claude 不受影响（暂停记录按 agent + 账号目录分）
poll CLAUDE_CONFIG_DIR="$HOME/.claude-other"
chk "另一个账号目录的同种 agent：照常派" "$(labels 20) $(runs claude)" "doing/agent 1"

# 并发上限 1：撞上限的会话占着唯一名额时别人不抢跑；转人工做完、名额空出后，另一个 agent 接到活
on 'MAX_CONCURRENT_WORKERS=1'; with_origin
mkissue 7 "doing/agent"; write_record 7 claude "$SID1" clean
mkworker 7 claude worker "$FX/claude-limit.txt" "$SID1"
mkissue 21 "pending/review"
poll
chk "名额被占：另一个 agent 的条目还没派" "$(labels 21) $(runs codex)" "pending/review 0"
poll
chk "这一轮转人工做完" "$(labels 7)" "pending/human"
poll
chk "名额空出后：另一个 agent 的条目派出去了" "$(labels 21) $(runs codex)" "doing/agent 1"

# 轮询节奏：有 agent 在暂停时，最慢 2 分钟一轮
on 'POLL_BACKOFF_LADDER="0:600"'
poll
chk "对照：没有暂停时按阶梯退避 10 分钟" "$(jq -r '.next_due - .last_poll' "$W/state/poll-pace.json")" "600"
mkdir -p "$(dirname "$PF")"; echo "{\"until\": $((T0 + 7200))}" > "$PF"
NOW=$((T0 + 1800)); poll
chk "有暂停时封顶 120 秒" "$(jq -r '.next_due - .last_poll' "$W/state/poll-pace.json")" "120"
fi

# ═════════════════════════════════════════════════════════════════════════
# 【6】转人工的三步：响应丢失、记账前退出、中途被人改了、读不到
# ═════════════════════════════════════════════════════════════════════════
arm() {   # 备好一条已经看过一轮的 issue 7（下一轮就会认定）
    on "$@"; mkissue 7 "doing/agent"; write_record 7 claude "$SID1" clean
    mkworker 7 claude worker "$FX/claude-limit.txt" "$SID1"
    poll
}
arm_pr() {   # 同上，PR 31（工作编号 30）
    on; mkissue 30 "pending/PR"; mkpr 31 "doing/agent"; jset "$GD/items.json" '.["31"].head.ref = "feature/issue-30"'
    write_record 30 claude "$SID1" clean
    mkworker 30 claude worker "$FX/claude-limit.txt" "$SID1"
    poll
}
hook() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$GD/$1"; }   # <hook 文件名> <脚本>
# 人在 GitHub 上改标签（带事件，操作人 maint）
human_add='python3 - "$FAKE_GH_DIR" "$N" "$L" <<PY
import json,sys
d,n,l=sys.argv[1:4]
lb=json.load(open(d+"/labels.json")); lb.setdefault(n,[]).append(l); json.dump(lb,open(d+"/labels.json","w"))
ev=json.load(open(d+"/events.json")); ev.setdefault(n,[]).append({"id":90000+sum(len(v) for v in ev.values()),"event":"labeled","label":{"name":l},"actor":{"login":"maint","type":"User"}}); json.dump(ev,open(d+"/events.json","w"))
PY'
human_del='python3 - "$FAKE_GH_DIR" "$N" "$L" <<PY
import json,sys
d,n,l=sys.argv[1:4]
lb=json.load(open(d+"/labels.json")); lb[n]=[x for x in lb.get(n,[]) if x!=l]; json.dump(lb,open(d+"/labels.json","w"))
ev=json.load(open(d+"/events.json")); ev.setdefault(n,[]).append({"id":90000+sum(len(v) for v in ev.values()),"event":"unlabeled","label":{"name":l},"actor":{"login":"maint","type":"User"}}); json.dump(ev,open(d+"/events.json","w"))
PY'
dels() { grep -c -- '-X DELETE' "$CALLS" 2>/dev/null || true; }
posts_label() { grep -c -- "-X POST repos/example/ul/issues/$1/labels" "$CALLS" 2>/dev/null || true; }
# 一步里每圈重读一次条目（GET issues/<n>）：第 1 次记基线，第 2 次留言前，第 3 次加标签前，第 5 次摘标签前
if want 6; then
echo "【6】转人工三步的跨轮恢复与停手"
arm; touch "$GD/Flost_post_comment"; poll
chk "留言成功但响应丢了：这一轮停在留言这一步" "$(ncomments 7) $(labels 7)" "1 doing/agent"
rm -f "$GD/Flost_post_comment"; poll
chk "下一轮认出是自己发的：不重复留言，做完" "$(ncomments 7) $(labels 7)" "1 pending/human"

arm; touch "$GD/Flost_post_labels"; poll
chk "加标签成功但响应丢了：这一轮停下，两个标签都在" "$(labels 7)" "doing/agent,pending/human"
rm -f "$GD/Flost_post_labels"; poll
chk "下一轮认出是自己加的：接着摘掉进行中，做完" "$(ncomments 7) $(labels 7)" "1 pending/human"
chk "下一轮没有再加一次标签" "$(posts_label 7)" "0"

arm; touch "$GD/Flost_delete_labels"; poll
chk "摘标签成功但响应丢了：标签已经对了" "$(labels 7)" "pending/human"
rm -f "$GD/Flost_delete_labels"; poll
chk "下一轮认出已经做完：不再发任何写请求" "$(nwrites) $(ncomments 7) $(jq -r '.items | length' "$UL")" "0 1 0"

arm; touch "$GD/Flost_delete_labels"; poll
rm -f "$GD/Flost_delete_labels"; T kill-session -t "=$PFX-issue7"; poll
has "三次写入都已生效、之后会话被关掉：照样记为做完，不说停手" "$LOG" "issue #7 已留言并转人工"
hasnt "三次写入都已生效、之后会话被关掉：日志里没有停手" "$LOG" "转人工停手"

arm; hook hook_after_POST_issues_7_labels_1 "kill -9 \$(cat '$W/poll.pid')"; poll
chk "加完标签、记账前进程被杀：两个标签都在，记录还停在加标签那一步" "$(labels 7) $(jq -r '.items["issue:7"].step' "$UL")" "doing/agent,pending/human 2"
rm -f "$GD/hook_after_POST_issues_7_labels_1"; poll
chk "下一轮接着做完，不重复留言、不重复加标签" "$(labels 7) $(ncomments 7) $(posts_label 7)" "pending/human 1 0"

# ── 两步之间被人改了：停手，之后不再写（不摘回、不补留言）──
stopped() {   # <名字> <期望的最终标签> <编号>
    local n="${3:-7}" w
    chk "$1：停在人留下的样子" "$(labels "$n")" "$2"
    has "$1：日志写明停手" "$LOG" "转人工停手"
    poll; w=$(nwrites); poll; w=$((w + $(nwrites)))
    chk "$1：之后两轮不再发任何写请求（同一屏不从头再来）" "$w $(labels "$n") $(ncomments "$n")" "0 $2 1"
    has "$1：之后两轮确实又看过这个会话" "$CTL/tmux.log" "capture-pane -p -t %"
}
arm; hook hook_issues_7_3 "N=7 L=pending/blocked; $human_add"; poll
chk "留言之后人加了等前置标签：daemon 没有加人工标签" "$(posts_label 7)" "0"
stopped "留言后人加了保护标签" "doing/agent,pending/blocked"

arm; hook hook_issues_7_3 "N=7 L=pending/human; $human_add"; poll
stopped "留言后人自己加了人工标签" "doing/agent,pending/human"

arm; hook hook_issues_7_3 "jq '.[\"7\"].state = \"closed\"' '$GD/items.json' > '$GD/i.tmp' && mv '$GD/i.tmp' '$GD/items.json'"; poll
chk "留言之后条目被关闭：没有标签写入" "$(posts_label 7) $(dels)" "0 0"
chk "留言之后条目被关闭：标签不动" "$(labels 7)" "doing/agent"

arm; hook hook_issues_7_5 "N=7 L=doing/agent; $human_del"; poll
chk "daemon 加了人工标签后，人摘掉了进行中：人工标签留着" "$(labels 7)" "pending/human"
chk "daemon 加了人工标签后，人摘掉了进行中：daemon 没有发任何摘标签请求" "$(dels)" "0"
chk "这一轮 daemon 确实加过人工标签（上面两条不是因为没走到）" "$(posts_label 7)" "1"
poll; chk "下一轮：不撤销、不补写" "$(nwrites) $(labels 7) $(ncomments 7)" "0 pending/human 1"

arm; hook hook_issues_7_5 "N=7 L=pending/blocked; $human_add"; poll
chk "daemon 加了人工标签后，人加了等前置：不摘进行中" "$(dels)" "0"
stopped "加标签后人加了保护标签" "doing/agent,pending/blocked,pending/human"

arm_pr; hook hook_issues_31_3 "jq '.[\"31\"].base.ref = \"release\"' '$GD/items.json' > '$GD/i.tmp' && mv '$GD/i.tmp' '$GD/items.json'"; poll
chk "PR 改了目标分支：不写标签" "$(posts_label 31) $(dels)" "0 0"
stopped "PR 改了目标分支" "doing/agent" 31
arm_pr; hook hook_issues_31_3 "jq '.[\"31\"].head.sha = \"2222222222222222222222222222222222222222\"' '$GD/items.json' > '$GD/i.tmp' && mv '$GD/i.tmp' '$GD/items.json'"; poll
stopped "PR 有了新提交" "doing/agent" 31
arm_pr; hook hook_issues_31_5 "jq '.[\"31\"].head.repo.full_name = \"fork/ul\"' '$GD/items.json' > '$GD/i.tmp' && mv '$GD/i.tmp' '$GD/items.json'"; poll
chk "加标签后 PR 来源变了：不摘进行中" "$(dels)" "0"
stopped "PR 来源变了" "doing/agent,pending/human" 31
arm_pr; hook hook_issues_31_3 "jq '.[\"31\"].merged = true | .[\"31\"].state = \"closed\"' '$GD/items.json' > '$GD/i.tmp' && mv '$GD/i.tmp' '$GD/items.json'"; poll
chk "PR 已合并：不写标签" "$(posts_label 31) $(dels) $(labels 31)" "0 0 doing/agent"

arm; hook hook_issues_7_3 "'$REAL_TMUX' -S '$SOCK' kill-session -t '=$PFX-issue7'; '$REAL_TMUX' -S '$SOCK' new-session -d -s '$PFX-issue7' 'sleep 900'"; poll
chk "留言后会话被换掉（窗格不是原来那个）：不写标签" "$(posts_label 7) $(labels 7)" "0 doing/agent"
has "会话被换掉：日志写明停手" "$LOG" "转人工停手"
# 原窗格里换了程序（换 agent / 续接降级都走 respawn-pane，窗格编号不变）、或角色登记换了会话编号：
# 都不再是撞上限的那个 worker（代码复审第 1 轮）
respawn="'$REAL_TMUX' -S '$SOCK' respawn-pane -k -t '$PFX-issue7' 'echo NEW-WORKER; exec sleep 900'"
arm; pane_before="$(T list-panes -t "=$PFX-issue7:" -F '#{pane_id}')"
hook hook_issues_7_3 "$respawn"; poll
chk "留言后原窗格里换了程序：窗格编号确实没变、新程序在跑" "$(T list-panes -t "=$PFX-issue7:" -F '#{pane_id}') $(screen_of 7 | grep -c NEW-WORKER)" "$pane_before 1"
chk "留言后原窗格里换了程序：不加人工标签" "$(posts_label 7) $(labels 7)" "0 doing/agent"
has "原窗格里换了程序：日志写明停手" "$LOG" "转人工停手"
poll; poll
chk "原窗格里换了程序：之后也不写，新 worker 的进行中标签还在" "$(nwrites) $(labels 7) $(ncomments 7)" "0 doing/agent 1"
arm; hook hook_issues_7_5 "$respawn"; poll
chk "加标签后原窗格里换了程序：不摘进行中" "$(dels) $(labels 7)" "0 doing/agent,pending/human"
arm; hook hook_issues_7_3 "echo $SID2 > '$W/state/agent-sessions/7.claude.worker'"; poll
chk "留言后角色登记换了会话编号：不加人工标签" "$(posts_label 7) $(labels 7) $(cat "$W/state/agent-sessions/7.claude.worker")" "0 doing/agent $SID2"
poll; poll
chk "角色登记换了会话编号：之后也不写" "$(nwrites) $(labels 7) $(ncomments 7)" "0 doing/agent 1"
arm; hook hook_issues_7_5 "echo $SID2 > '$W/state/agent-sessions/7.claude.worker'"; poll
chk "加标签后角色登记换了会话编号：不摘进行中" "$(dels) $(labels 7)" "0 doing/agent,pending/human"
# 进程的启动时刻读不出：算读不到，不算没变
arm; printf '#!/usr/bin/env bash\nexit 1\n' > "$SANDBOX/bin/ps"; chmod +x "$SANDBOX/bin/ps"; poll
chk "进程启动时刻读不出：本轮什么都不写" "$(nwrites) $(labels 7)" "0 doing/agent"
rm -f "$SANDBOX/bin/ps"; poll; poll
chk "读得出之后：照常认定并转人工（对照：没变化时确实交人）" "$(ncomments 7) $(labels 7)" "1 pending/human"
arm; jset "$STATE" '.worker_hosts["7"] = "other-host"'; poll
chk "认定前派工归属变了：什么都不写" "$(nwrites) $(labels 7)" "0 doing/agent"

# ── 读不到：本轮不写、记录留着，恢复后接着做完 ──
# （假 GitHub 先判故障、再跑 hook：第 2 次读之前放下故障，第 3 次读——加标签前那次——才失败）
arm; hook hook_issues_7_2 "touch '$GD/F_issues_7'"; poll
chk "加标签前条目读不到：只留了言，标签没动" "$(ncomments 7) $(labels 7) $(posts_label 7)" "1 doing/agent 0"
chk "条目读不到：记录留着" "$(jq -r '.items["issue:7"].step' "$UL")" "2"
rm -f "$GD/F_issues_7" "$GD/hook_issues_7_2"; poll
chk "条目读得到之后：接着做完，不重复留言" "$(ncomments 7) $(labels 7)" "1 pending/human"

arm; hook hook_issues_7_3 "touch '$GD/F_issues_7_events'"; poll
chk "加标签前标签事件读不到：标签没动，记录留着" "$(labels 7) $(posts_label 7) $(jq -r '.items["issue:7"].step' "$UL")" "doing/agent 0 2"
rm -f "$GD/F_issues_7_events" "$GD/hook_issues_7_3"; poll
chk "标签事件读得到之后：做完" "$(ncomments 7) $(labels 7)" "1 pending/human"

arm; hook hook_issues_7_3 "echo 'show-options -qv -t =$PFX-issue7: @worker_agent' > '$CTL/fault'"; poll
chk "加标签前 tmux 读不到：标签没动，记录留着" "$(labels 7) $(posts_label 7) $(jq -r '.items["issue:7"].step' "$UL")" "doing/agent 0 2"
chk "tmux 的故障确实打中了" "$([ -s "$CTL/fault.hits" ] && echo hit)" "hit"
rm -f "$CTL/fault" "$GD/hook_issues_7_3"; poll
chk "tmux 读得到之后：做完，会话还在" "$(ncomments 7) $(labels 7) $(T has-session -t "=$PFX-issue7" 2>/dev/null && echo alive)" "1 pending/human alive"

arm; touch "$GD/F_user"; poll
chk "读不到 daemon 自己的账号名：什么都不写" "$(nwrites) $(labels 7)" "0 doing/agent"
rm -f "$GD/F_user"; poll
chk "读得到之后：做完" "$(ncomments 7) $(labels 7)" "1 pending/human"

# ── 写入一直失败：累计到上限就停手，之后不再试 ──
arm; touch "$GD/F_post_labels"
for i in $(seq 12); do poll; done
chk "加标签一直失败：留言只有一条，标签没动" "$(ncomments 7) $(labels 7)" "1 doing/agent"
has "加标签一直失败：到上限后日志写明停手" "$LOG" "累计失败 10 次 → 停手"
rm -f "$GD/F_post_labels"; poll; poll
chk "停手之后故障消失：也不再写" "$(nwrites) $(labels 7) $(ncomments 7)" "0 doing/agent 1"
fi

# ═════════════════════════════════════════════════════════════════════════
# 【7】开关不开：GitHub 调用、tmux 调用、state.json 和改动前一样；不留任何新文件
# ═════════════════════════════════════════════════════════════════════════
if want 7; then
echo "【7】开关不开时和改动前一样"
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$SANDBOX/old" "$SANDBOX/new"
git -C "$REPO_DIR" archive "$BASE_REV" scripts prompts | tar -x -C "$SANDBOX/old"
cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$SANDBOX/new/"
off_run() {   # <根目录> <输出前缀> [额外配置行…]
    local root="$1" out="$2" i; shift 2
    fresh "$@"; mkissue 7 "doing/agent"; mkissue 20 "pending/human"; write_record 7 claude "$SID1" clean
    mkworker 7 claude worker "$FX/claude-limit.txt" "$SID1"
    : > "$CTL/tmux.log"; : > "$out.gh"
    for i in 1 2 3; do
        : > "$CALLS"
        env POLL_FAKE_NOW="$NOW" CODING_AGENT_CONFIG="$CONF" bash "$root/scripts/agent-poll.sh" > /dev/null 2>&1
        cat "$CALLS" >> "$out.gh"
    done
    sed -E 's/%[0-9]+/%N/g' "$CTL/tmux.log" > "$out.tmux"
    jq -S . "$STATE" > "$out.state"
    ls "$W/state" | grep -v '^poll' | sort > "$out.files"
}
for variant in "" 'ENABLE_USAGE_LIMIT_PAUSE=""' 'ENABLE_USAGE_LIMIT_PAUSE="false"'; do
    vn="${variant:-不写这一行}"
    off_run "$SANDBOX/new" "$SANDBOX/off.new" ${variant:+"$variant"}
    chk "[$vn] 没有写请求、标签不动" "$(grep -cE -- '-X (POST|DELETE)' "$SANDBOX/off.new.gh") $(labels 7)" "0 doing/agent"
    chk "[$vn] 不留状态文件、不留暂停记录" "$([ -e "$UL" ] && echo ul)$([ -e "$HOME/.local/state/cavil-loop/usage-limit" ] && echo dir)" ""
    hasnt "[$vn] 没有截过屏" "$SANDBOX/off.new.tmux" "capture-pane"
    chk "[$vn] 这几轮确实跑了（读过 open 条目）" "$([ "$(grep -c 'repos/example/ul/issues' "$SANDBOX/off.new.gh")" -ge 3 ] && echo ran)" "ran"
    if ! compat_skip "开关不开（$vn）对比改动前" "$SANDBOX/old" "$SANDBOX/new" scripts; then
        off_run "$SANDBOX/old" "$SANDBOX/off.old" ${variant:+"$variant"}
        chk "[$vn] GitHub 调用和改动前逐字节一样" "$(cmp -s "$SANDBOX/off.old.gh" "$SANDBOX/off.new.gh" && echo same)" "same"
        chk "[$vn] tmux 调用和改动前一样" "$(cmp -s "$SANDBOX/off.old.tmux" "$SANDBOX/off.new.tmux" && echo same)" "same"
        chk "[$vn] state.json 和改动前一样" "$(cmp -s "$SANDBOX/off.old.state" "$SANDBOX/off.new.state" && echo same)" "same"
        chk "[$vn] 状态目录里的文件和改动前一样" "$(cmp -s "$SANDBOX/off.old.files" "$SANDBOX/off.new.files" && echo same)" "same"
    fi
done
# 对照：同一个场景开着开关会动手（上面的「一样」不是因为场景本身什么都不触发）
off_run "$SANDBOX/new" "$SANDBOX/off.on" 'ENABLE_USAGE_LIMIT_PAUSE="true"'
chk "对照：开着开关时同一场景会转人工" "$(labels 7)" "pending/human"
fi

# ═════════════════════════════════════════════════════════════════════════
# 【8】运维文档里「查看 / 手动解除暂停」：中英文一字不差，在空环境里按原样执行
# ═════════════════════════════════════════════════════════════════════════
if want 8; then
echo "【8】文档里的查看 / 手动解除步骤"
ops_block() {   # <文档> <第几个 bash 代码块>
    awk -v want="$2" '/<!-- usage-limit-ops:begin -->/{on=1; next} /<!-- usage-limit-ops:end -->/{on=0}
         on && /^```bash$/{n++; inb=1; next} on && /^```$/{inb=0; next} inb && n == want' "$1"
}
for b in 1 2; do
    en="$(ops_block "$REPO_DIR/docs/operations.md" $b)"; zh="$(ops_block "$REPO_DIR/docs/operations.zh.md" $b)"
    chk "第 $b 段：两份文档都有、一字不差" "$([ -n "$en" ] && [ "$en" = "$zh" ] && echo same)" "same"
    printf '%s\n' "$en" > "$SANDBOX/ops$b.sh"
done
# 空环境：只给 HOME 和 PATH；TZ 固定成 UTC 只为了让输出里的钟点和机器无关
run_ops() { env -i HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin TZ=UTC bash "$SANDBOX/ops$1.sh" 2>&1; }
on; with_origin
chk "还没有暂停：查看步骤照实说没有，不报错" "$(run_ops 1)" "no pause record on this machine / 本机没有暂停记录"
mkissue 7 "doing/agent"; write_record 7 claude "$SID1" clean
mkworker 7 claude worker "$FX/claude-limit.txt" "$SID1"
poll; poll
out="$(run_ops 1)"
chk "有暂停：列出 agent、到几点、账号目录、哪个条目" "$(printf '%s\n' "$out" | grep -c "^claude  until 2026-09-22 08:50 UTC  account=$HOME/.claude  seen-on=example/ul issue #7  time-from=screen\$")" "1"
mkissue 20 "pending/agent"; poll
chk "解除之前：claude 的条目不派" "$(labels 20)" "pending/agent"
out="$(run_ops 2)"
chk "手动解除：输出剩 0 条" "$(printf '%s\n' "$out" | grep -c '^pause records left for claude: 0 ')" "1"
chk "手动解除后：查看步骤说没有暂停" "$(run_ops 1)" "no pause record on this machine / 本机没有暂停记录"
poll
chk "手动解除后：下一轮就派工" "$(labels 20)" "doing/agent"
chk "再执行一次解除（已经没有记录）：不报错" "$(run_ops 2 | grep -c '^pause records left for claude: 0 ')" "1"
# 账号其实还在上限里：下一个撞上的会话再被认出来，暂停重新出现（文档说「没有需要回退的东西」）
mkissue 8 "doing/agent"; write_record 8 claude "$SID2" clean
mkworker 8 claude worker "$FX/claude-limit.txt" "$SID2"
poll; poll
chk "解除后又撞上：暂停重新出现，那一条转人工" "$([ -n "$(pause_file claude)" ] && echo paused) $(labels 8)" "paused pending/human"
fi

echo
compat_summary
REPORT_REGRESS_ONLY=1
report_counts "$pass" "$fail"
echo "通过 $pass，失败 $fail"
[ "$fail" = 0 ]
