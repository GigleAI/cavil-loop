#!/usr/bin/env bash
# 非机器人提的条目也能叫醒外部需求机器人（GitHub#133）的行为守卫。
#
# 跑法：bash tests/requester-bot-any-item.test.sh            （默认不跑负对照）
#       MUTATION=1 bash tests/requester-bot-any-item.test.sh （连负对照一起跑；见 tests/lib/mutation.sh）
# 依赖：jq、python3、git、curl。不碰外网、不调真 gh：假 gh 是 tests/fixtures/requester-bot-fake-gh.py
# （和 tests/requester-bot.test.sh 共用），机器人侧用 tests/fixtures/requester-bot-ref-consumer.py——
# 照文档「交接协议」另写的一份，不调用叫醒脚本用的那份实现，两边对拍。
#
# 覆盖：
#   1. 开关关（功能本身开着）：非机器人条目照旧拒绝，叫醒脚本的输出、GitHub 调用和改动前逐字节相同；
#      四类提示词和改动前的拼装逐字节相同；来源判定的返回值 / 来源 / 原因（合并后通知和托管只看这些）
#      在开关开、关两种配置下都和改动前相同
#   2. 开关开 · 成功：非机器人 issue、关联确定的非机器人 PR、确定没有关联的 PR；交接评论只改标记那一行，
#      用量 footer 字节不变、机器记录仍是最后一行；webhook 恰好一次；机器人参考实现选中同一条评论
#   3. 开关开 · 拒绝（退出码 2、零写请求、拒绝原因就是那一条）
#   4. 开关开 · 失败与重试：逐行故障注入，断言退出码、评论、标签、webhook 次数
#   5. 观察：被测脚本每一次 GitHub 调用之前都跑一次机器人参考实现，任何时刻都不能判「出错」，
#      也不能选中别的评论
#   6. 机器人侧：叫醒之后评论被改 / 被删、手动重挂、外人伪造、旧交接评论
#   7. 合并后通知不碰非机器人条目；8. 开关开时的提示词
# 负对照只在 MUTATION=1 时跑；默认回归靠「确实叫醒成功」「确实写了」这类到达性断言防空转。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"
# shellcheck source=lib/compat.sh
source "$TEST_DIR/lib/compat.sh"
FAKE="$TEST_DIR/fixtures/requester-bot-fake-gh.py"
REF="$TEST_DIR/fixtures/requester-bot-ref-consumer.py"
FOOTER_FILE="$TEST_DIR/fixtures/requester-bot-real-footer.md"   # 本仓库一条真实评论的用量 footer 原样

unset CODING_AGENT_RELEASE_ROOT CLAUDE_PLUGIN_ROOT CAVIL_DEPLOY_ROOT CAVIL_DEPLOY_CONF \
      CODING_AGENT_CONFIG CODING_AGENT_RELEASE_LEASE_FD TICK_DIR FAKE_GH_OBSERVER

SANDBOX=$(mktemp -d)
HOOK_PID=""
cleanup() { [ -z "$HOOK_PID" ] || kill "$HOOK_PID" 2>/dev/null; [ -n "${KEEP_SANDBOX:-}" ] && { echo "SANDBOX=$SANDBOX"; return 0; }; rm -rf "$SANDBOX"; }
trap cleanup EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 -I "$FAKE"

pass=0; fail=0; QUIET=0
PREP_FAILED="$SANDBOX/prep-failed"; : > "$PREP_FAILED"
prep_failed() { printf '%s（%s）\n' "$1" "$2" >> "$PREP_FAILED"; echo "  ❌ 负对照 $1 没改上（$2）" >&2; }
chk() {
    if [ "$2" = "$3" ]; then [ "$QUIET" = 1 ] || echo "  ✅ $1"; pass=$((pass+1))
    else [ "$QUIET" = 1 ] || echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

copy_tree() { rm -rf "$2"; mkdir -p "$2"; cp -r "$1/scripts" "$1/prompts" "$2/"; }
NEW="$SANDBOX/new"; copy_tree "$REPO_DIR" "$NEW"
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$SANDBOX/old-src"
git -C "$REPO_DIR" archive "$BASE_REV" scripts prompts | tar -x -C "$SANDBOX/old-src"
OLD="$SANDBOX/old"; copy_tree "$SANDBOX/old-src" "$OLD"

mutate() {   # <名字> <文件（相对副本根）> <原文> <改成>
    mutation_on || return 0
    local D="$SANDBOX/mut-$1"
    rm -rf "$D"; cp -r "${MUT_BASE:-$NEW}" "$D"
    python3 - "$D/$2" "$3" "$4" <<'PYM' || { prep_failed "$1" "原文找不到"; return 1; }
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
if s.count(old) != 1:
    sys.exit(1)
open(p, "w").write(s.replace(old, new))
PYM
    printf '%s' "$D"
}
neg() {   # <说明> <suite 函数及参数…>：失败条数必须 > 0
    mutation_gate || return 0
    local desc="$1"; shift
    local before=$fail
    QUIET=1; [ -z "${SHOW_NEG:-}" ] || QUIET=0; "$@"; QUIET=0
    local got=$((fail - before))
    fail=$before
    chk "负对照：$desc → 变红（$got 条失败）" "$([ "$got" -gt 0 ] && echo red || echo green)" red
}

# ── 假 webhook（只听 127.0.0.1）──
HOOK="$SANDBOX/hook"; mkdir -p "$HOOK"; echo 200 > "$HOOK/mode"
python3 -I "$TEST_DIR/fixtures/requester-bot-fake-webhook.py" "$HOOK" >/dev/null 2>&1 &
HOOK_PID=$!
for _ in $(seq 50); do [ -s "$HOOK/port" ] && break; sleep 0.1; done
HOOK_URL="http://127.0.0.1:$(cat "$HOOK/port" 2>/dev/null)/hook"
hook_reset() { : > "$HOOK/req.log"; }
hook_count() { grep -c . "$HOOK/req.log" 2>/dev/null || true; }

# ── 运行环境 ──
RW="$SANDBOX/w"
MARK='<!-- bot-origin -->'
FOOTER=$(cat "$FOOTER_FILE")
new_env() {   # <any 开关 true|false> [额外配置行…]
    local any="$1"; shift
    rm -rf "$RW"; mkdir -p "$RW/state" "$RW/gh" "$RW/project"
    cat > "$RW/cavil-loop.config" <<CONF
REPO="example/requester-bot"
PROJECT_ROOT="$RW/project"
WORKTREE_BASE="$RW/wt"
STATE_DIR="$RW/state"
TMUX_PREFIX="rbany$$"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_AGENT_EXTRA="pending/agent/05"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
WORKER_SECRET_ENV=""
GH_TOKEN="fake-token-for-test"
PATH="$SANDBOX/bin:\$PATH"
LABEL_PENDING_REQUESTER_BOT="waiting/bot"
REQUESTER_BOT_ACCOUNT="req-bot"
REQUESTER_BOT_ALLOWED_ACTORS="worker-bot, reviewer-bot"
REQUESTER_BOT_ORIGIN_MARKER="$MARK"
REQUESTER_BOT_WAKE_ANY_ITEM="$any"
REQUESTER_BOT_WEBHOOK_URL='$HOOK_URL'
REQUESTER_BOT_WEBHOOK_KEY_HEADER='X-Hook-Key'
REQUESTER_BOT_WEBHOOK_KEY='k-test'
CONF
    local kv; for kv in "$@"; do printf '%s\n' "$kv" >> "$RW/cavil-loop.config"; done
    chmod 600 "$RW/cavil-loop.config"
    printf '{"me":"worker-bot","items":{},"next_comment_id":1000,"next_event_id":5000}' > "$RW/gh/state.json"
    printf '[]' > "$RW/gh/faults.json"
    : > "$RW/gh/calls.log"; : > "$RW/gh/obs.log"
    hook_reset
}
ST() { printf '%s' "$RW/gh/state.json"; }
jqset() { local f; f=$(ST); jq "$@" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
add_item() {   # <N> <issue|pr> <labels,逗号> [user] [body] [head_ref]
    jqset --arg n "$1" --arg kind "$2" --arg labels "$3" --arg user "${4:-someone}" --arg body "${5:-}" --arg ref "${6:-}" '
        .items[$n] = {number: ($n|tonumber), title: "item \($n)", user: $user, body: $body,
                      state: "open", is_pr: ($kind == "pr"),
                      head_ref: (if $ref == "" then "feature/issue-\($n)" else $ref end),
                      labels: ($labels | split(",") | map(select(. != ""))),
                      assignees: [], events: [], comments: []}'
}
set_field() { jqset --arg n "$1" --argjson v "$3" ".items[\$n].$2 = \$v"; }
add_comment() {   # <N> <user> <body> → 输出新评论编号
    local id; id=$(jq -r '.next_comment_id' "$(ST)")
    jqset --arg n "$1" --arg u "$2" --arg b "$3" --argjson id "$id" \
        '.items[$n].comments += [{id: $id, user: $u, body: $b}] | .next_comment_id = ($id + 1)'
    printf '%s' "$id"
}
body_of() { jq -j --arg n "$1" --argjson id "$2" '.items[$n].comments[] | select(.id == $id) | .body' "$(ST)"; }
labels_of() { jq -r --arg n "$1" '.items[$n].labels | join(",")' "$(ST)"; }
writes() { grep -c '^WRITE ' "$RW/gh/calls.log" 2>/dev/null || true; }
patches() { grep -c '^WRITE PATCH ' "$RW/gh/calls.log" 2>/dev/null || true; }
receipts() {   # <N> → 本账号发的叫醒记录条数
    jq -r --arg n "$1" '[.items[$n].comments[] | select(.user == "worker-bot" and (.body | test("requester-bot-wake: ")))] | length' "$(ST)"
}
latest_receipt() {   # <N> → 编号最大的叫醒记录里那一行的 event=… comment=…
    jq -r --arg n "$1" '[.items[$n].comments[] | select(.user == "worker-bot" and (.body | test("requester-bot-wake: ")))]
        | max_by(.id) // {} | (.body // "") | capture("(?<k>event=[0-9]+ comment=[0-9]+)").k // ""' "$(ST)"
}
faults() { printf '%s' "$1" > "$RW/gh/faults.json"; }
last_wait_event() {   # <N> → 最近一次挂等待标签的事件编号
    jq -r --arg n "$1" '[.items[$n].events | to_entries[] | select(.value.event == "labeled" and .value.label == "waiting/bot")
        | (.value.id // (.key + 1))] | max // ""' "$(ST)"
}
wait_events() { jq -r --arg n "$1" '[.items[$n].events[] | select(.event == "labeled" and .label == "waiting/bot")] | length' "$(ST)"; }
handoff_body() {   # <对象> [标记行（默认标准写法）]
    local t="$1" line="${2-<!-- requester-bot-forward-to: $1 -->}"
    printf '## 需要和%s确认这段对外文案\n\n请转给：%s\n\n要问的是：首页那句「一键开通」能不能对外说。\n\n%s\n\n\n%s\n' "$t" "$t" "$line" "$FOOTER"
}
ref() { python3 -I "$REF" "$(ST)" "$@"; }   # <N> [--minutes M] [--rule R]

# 一套标准条目：维护者的 issue #80；做它的 PR #81（分支带编号）；没关联的 PR #82；机器人提的 #50
fresh() {   # [any 开关，默认 true]
    new_env "${1:-true}"
    add_item 80 issue "doing/agent,pending/agent" maintainer "维护者自己的需求"
    add_item 81 pr "doing/agent,pending/review" worker-bot "实现 #80" feature/issue-80
    add_item 82 pr "doing/agent" worker-bot "" chore/x
    add_item 50 issue "doing/agent" req-bot "需求 $MARK"
    add_comment 80 maintainer "这段对外文案请和机器人那边的运营同步一下" >/dev/null
    C80=$(add_comment 80 worker-bot "$(handoff_body 运营)")
    C81=$(add_comment 81 worker-bot "$(handoff_body 运营)")
    C82=$(add_comment 82 worker-bot "$(handoff_body 张三)")
    : > "$RW/gh/calls.log"; hook_reset
}
wake() {   # <scripts 副本> <N>
    RC=0
    OUT=$(env FAKE_GH_DIR="$RW/gh" ${OBS:+FAKE_GH_OBSERVER="python3 -I $REF $(ST) $2 --rule ${REF_RULE:-v4} >> $RW/gh/obs.log"} \
        bash "$1/scripts/notify-requester-bot.sh" --config "$RW/cavil-loop.config" "$2" 2>&1) || RC=$?
}
# 交接评论里的用量 footer：机器记录仍是最后一个非空行
last_line_is_metrics() { printf '%s' "$1" | awk 'NF{l=$0} END{print (l ~ /^<!-- agent-metrics /) ? "yes" : "no"}'; }
footer_intact() {   # 评论正文末尾就是 footer 原样（评论经 $( ) 存进去，末尾不带换行）
    [ "$(printf '%s' "$1" | tail -c "$(printf '%s' "$FOOTER" | wc -c)")" = "$FOOTER" ] && echo yes || echo no
}

# ─────────────────────────────────────────────────────────────────────────
echo "── 1. 开关关：和改动前逐字节一致 ──"
# ─────────────────────────────────────────────────────────────────────────
off_suite() {   # <scripts 副本>
    local S="$1" n same=0 old_out old_rc
    compat_skip "开关关 · 叫醒脚本的退出码、输出、GitHub 调用与改动前" "$OLD" "$S" scripts prompts && same=1
    for n in 80 81 82; do
        if [ "$same" = 0 ]; then
            fresh false; wake "$OLD" $n; old_out="$OUT" old_rc=$RC; cp "$RW/gh/calls.log" "$SANDBOX/calls-old"
        fi
        fresh false; wake "$S" $n
        [ "$same" = 0 ] || old_rc=$RC   # 同版本：只剩「退出码是 2」这一半
        chk "开关关 · #$n：退出码 2（和改动前一样）" "$RC|$old_rc" "2|2"
        chk "开关关 · #$n：零写请求" "$(writes)" 0
        if [ "$same" = 0 ]; then
        chk "开关关 · #$n：输出和改动前逐字节相同" "$([ "$OUT" = "$old_out" ] && echo same || echo diff)" same
        chk "开关关 · #$n：GitHub 调用和改动前逐条相同" "$(cmp -s "$SANDBOX/calls-old" "$RW/gh/calls.log" && echo same || echo diff)" same
        fi
        chk "开关关 · #$n：交接评论没动" "$(body_of $n "$(eval echo \$C$n)" | grep -c 'wake-event')" 0
    done
    # 到达性：同一环境里机器人提的条目照常叫醒（上面的拒绝不是因为脚本根本跑不起来）
    fresh false; wake "$S" 50
    chk "开关关 · 到达性：机器人提的 #50 照常叫醒" "$RC|$(labels_of 50)" "0|waiting/bot"
}
off_suite "$NEW"

compose_out() {   # <scripts 副本> <kind>
    env FAKE_GH_DIR="$RW/gh" CODING_AGENT_CONFIG="$RW/cavil-loop.config" bash -c '
        source "$1/scripts/_lib.sh" 2>/dev/null; f=$(compose_prompt_template "$2"); cat "$f"' _ "$1" "$2"
}
# 改动前的拼装代码配本版的 prompts/（同 tests/requester-bot.test.sh 第 1 组的理由）
OLD_P="$SANDBOX/old-scripts-new-prompts"; copy_tree "$SANDBOX/old-src" "$OLD_P"
rm -rf "$OLD_P/prompts"; cp -r "$REPO_DIR/prompts" "$OLD_P/prompts"
off_prompt_suite() {   # <scripts 副本>
    local S="$1" kind same=0
    new_env false
    compat_skip "开关关 · 四类提示词与改动前的拼装" "$OLD_P" "$S" scripts prompts && same=1
    for kind in new-issue issue-comment pr-comment review; do
        # 叫醒命令里带着各自副本的路径，换成同一个占位再比
        compose_out "$S" $kind | sed "s|$S/|<副本>/|g" > "$SANDBOX/p-new-$kind.md"
        if [ "$same" = 0 ]; then
        compose_out "$OLD_P" $kind | sed "s|$OLD_P/|<副本>/|g" > "$SANDBOX/p-old-$kind.md"
        chk "开关关 · 提示词 $kind 和改动前的拼装逐字节一致" \
            "$(cmp -s "$SANDBOX/p-old-$kind.md" "$SANDBOX/p-new-$kind.md" && [ -s "$SANDBOX/p-new-$kind.md" ] && echo same || echo diff)" same
        fi
        chk "开关关 · 提示词 $kind 确实带着交接规则（对拍不是两边都没有）" \
            "$(grep -c '^# 外部需求机器人交接规则' "$SANDBOX/p-new-$kind.md")" 1
    done
}
off_prompt_suite "$NEW"

# 来源判定：合并后通知、托管判定只看返回值、来源编号、原因——开关开 / 关都必须和改动前一模一样
origin_rows() {   # <scripts 副本>
    env FAKE_GH_DIR="$RW/gh" CODING_AGENT_CONFIG="$RW/cavil-loop.config" bash -c '
        source "$1/scripts/_lib.sh" 2>/dev/null
        for n in 50 60 80 81 82 83 84 86; do
            j=$(gh api "repos/$REPO/issues/$n"); rc=0
            requester_bot_item_origin "$n" "$j" || rc=$?
            printf "%s rc=%s origin=%s reason=%s\n" "$n" "$rc" "$REQUESTER_BOT_ORIGIN" "$REQUESTER_BOT_REASON"
        done' _ "$1"
}
origin_suite() {   # <scripts 副本>
    local S="$1" any same=0
    compat_skip "来源判定 · 返回值 / 来源 / 原因与改动前" "$OLD" "$S" scripts prompts && same=1
    for any in false true; do
        fresh $any
        add_item 60 pr "" worker-bot "" feature/issue-50
        add_item 83 pr "" worker-bot $'Closes\n#80' chore/amb
        add_item 84 pr "" worker-bot "" feature/issue-82
        add_item 86 pr "" worker-bot "Closes #85" chore/missing
        origin_rows "$S" > "$SANDBOX/o-new" 2>/dev/null
        if [ "$same" = 0 ]; then
        origin_rows "$OLD" > "$SANDBOX/o-old" 2>/dev/null
        chk "来源判定 · 开关 $any：8 个条目的返回值 / 来源 / 原因和改动前逐条相同" \
            "$(cmp -s "$SANDBOX/o-old" "$SANDBOX/o-new" && echo same || echo diff)" same
        fi
        chk "来源判定 · 开关 $any：对拍不是两边都空（#50 判成机器人提的）" "$(grep -c '^50 rc=0 origin=50 ' "$SANDBOX/o-new")" 1
    done
}
origin_suite "$NEW"

# ─────────────────────────────────────────────────────────────────────────
echo "── 2. 开关开 · 成功 ──"
# ─────────────────────────────────────────────────────────────────────────
success_suite() {   # <scripts 副本>
    local S="$1" n c orig now e t
    for n in 80 81 82; do
        fresh; c=$(eval echo \$C$n); orig=$(body_of $n "$c")
        t=运营; [ "$n" = 82 ] && t=张三
        OBS=1 wake "$S" $n
        now=$(body_of $n "$c"); e=$(last_wait_event $n)
        chk "成功 · #$n：退出码 0" "$RC" 0
        chk "成功 · #$n：只剩等待标签" "$(labels_of $n)" "waiting/bot"
        chk "成功 · #$n：交接评论一个字节都没动（含 footer）" "$([ "$now" = "$orig" ] && echo yes || echo no)" yes
        chk "成功 · #$n：footer 仍在末尾、机器记录仍是最后一个非空行" "$(footer_intact "$now") $(last_line_is_metrics "$now")" "yes yes"
        chk "成功 · #$n：没有编辑任何评论" "$(patches)" 0
        chk "成功 · #$n：发了恰好一条叫醒记录" "$(receipts $n)" 1
        chk "成功 · #$n：叫醒记录写的是这次挂标签的事件和这条交接评论" "$(latest_receipt $n)" "event=$e comment=$c"
        chk "成功 · #$n：webhook 恰好一次" "$(hook_count)" 1
        chk "成功 · #$n：输出写明交接评论、事件编号和叫醒记录" "$(printf '%s' "$OUT" | grep -c "交接评论 $c，挂标签事件 $e，叫醒记录 [0-9]*，转给：$t")" 1
        chk "成功 · #$n：机器人参考实现选中同一条评论" "$(ref $n)" "ready $c $t"
        chk "成功 · #$n：叫醒过程中机器人任何时刻都没判「出错」、没选别的评论" \
            "$(grep -vE "^(not-waiting|preparing|handed-back|ready $c $t)\$" "$RW/gh/obs.log" | sort -u | paste -sd'|')" ""
        chk "成功 · #$n：观察确实跑了（看到过「准备中」）" "$(grep -c '^preparing$' "$RW/gh/obs.log" | awk '{print ($1>0)?"yes":"no"}')" yes
    done
    # 跨次调用：叫醒成功后发一条新交接评论再叫醒 → 新评论填新编号，旧评论不动，机器人认新评论
    fresh; wake "$S" 80; local e1 old1 c2
    e1=$(last_wait_event 80); old1=$(body_of 80 "$C80")
    set_field 80 labels '["waiting/bot","pending/agent","doing/agent"]'
    c2=$(add_comment 80 worker-bot "$(handoff_body 法务)"); hook_reset
    OBS=1 wake "$S" 80
    chk "跨次 · 发新评论再叫醒：退出码 0" "$RC" 0
    chk "跨次 · 新事件编号比上次大" "$([ "$(last_wait_event 80)" -gt "$e1" ] && echo yes || echo no)" yes
    chk "跨次 · 旧交接评论一个字节都没动" "$([ "$(body_of 80 "$C80")" = "$old1" ] && echo yes || echo no)" yes
    chk "跨次 · 机器人认新评论" "$(ref 80)" "ready $c2 法务"
    # 新的一次挂标签之前，上一次叫醒（旧评论）本来就是就绪的；之后只能是准备中或新评论
    chk "跨次 · 过程中没判「出错」" "$(grep -c '^error' "$RW/gh/obs.log")" 0
    chk "跨次 · 新一次挂标签之后不再选旧评论" \
        "$(awk -v c="ready $C80 运营" 'seen && $0 == c {bad=1} $0 == "preparing" {seen=1} END {print bad ? "bad" : "ok"}' "$RW/gh/obs.log")" ok
    chk "跨次 · webhook 一次" "$(hook_count)" 1
}
success_suite "$NEW"

# ─────────────────────────────────────────────────────────────────────────
echo "── 3. 开关开 · 拒绝 ──"
# ─────────────────────────────────────────────────────────────────────────
reject_case() {   # <说明> <编号> <拒绝原因里的一段>：在 wake 之前已布置好状态
    local desc="$1" n="$2" why="$3"
    : > "$RW/gh/calls.log"; hook_reset
    wake "$S" "$n"
    chk "拒绝 · $desc：退出码 2" "$RC" 2
    chk "拒绝 · $desc：零写请求" "$(writes)" 0
    chk "拒绝 · $desc：理由是「$why」" "$(printf '%s' "$OUT" | grep -cF -- "$why")" 1
}
reject_suite() {   # <scripts 副本>
    S="$1"
    # —— PR 关联认不准 ——
    fresh; add_item 83 pr "doing/agent" worker-bot $'Closes\n#80' chore/amb
    add_comment 83 worker-bot "$(handoff_body 运营)" >/dev/null
    reject_case "PR 正文 Closes 和 #80 分两行" 83 "关联写法有歧义"
    fresh; add_item 84 pr "doing/agent" worker-bot "" feature/issue-82
    add_comment 84 worker-bot "$(handoff_body 运营)" >/dev/null
    reject_case "PR 关联的是另一个 PR" 84 "是 PR，不是 issue"
    fresh; faults '[{"method":"GET","path":"issues/80$","mode":"fail","skip":0}]'
    # #81 自己的读取走 issues/81；关联的 #80 读不到
    reject_case "关联的 issue 读不到" 81 "读不到关联的 issue #80"
    fresh; faults '[{"method":"GET","path":"pulls/81$","mode":"fail"}]'
    reject_case "PR 读不到" 81 "读不到 PR #81"
    # —— 维护者那边 ——
    fresh; set_field 80 events '[{"event":"labeled","actor":"maintainer","label":"pending/human"}]'
    reject_case "关联的 issue 被维护者接手过" 81 "#80 由维护者 maintainer 手动标过"
    fresh; set_field 81 events '[{"event":"labeled","actor":"maintainer","label":"pending/human"}]'
    reject_case "PR 自己被维护者接手过" 81 "#81 由维护者 maintainer 手动标过"
    fresh; set_field 80 labels '["pending/human"]'
    reject_case "挂着 pending/human" 80 "挂着 pending/human"
    fresh; faults '[{"method":"GET","path":"/events$","mode":"fail"}]'
    reject_case "标签历史读不到" 80 "读不到 #80 的标签历史"
    fresh; set_field 80 state '"closed"'
    reject_case "条目已关闭" 80 "不是打开状态"
    # —— 交接评论 ——
    fresh; jqset '.items["82"].comments = []'
    reject_case "本账号没发过评论" 82 "没有本账号"
    fresh; add_comment 80 worker-bot "收到，我去问问" >/dev/null
    reject_case "最新评论没有标记、更早的有（不往前找）" 80 "没有转交标记"
    fresh; jqset '.items["82"].comments = []'; add_comment 82 someone "$(handoff_body 运营)" >/dev/null
    add_comment 82 worker-bot "普通评论" >/dev/null
    reject_case "标记只在别人的评论里" 82 "没有转交标记"
    local bad
    while IFS='|' read -r bad why; do
        [ -n "$bad" ] || continue
        fresh; add_comment 80 worker-bot "$(handoff_body x "$bad")" >/dev/null
        reject_case "标记 $bad" 80 "$why"
    done <<CASES
<!-- requester-bot-forward-to:  -->|转交对象不合格
<!-- requester-bot-forward-to: $(printf 'x%.0s' $(seq 101)) -->|转交对象不合格
<!-- requester-bot-forward-to: a>b -->|转交对象不合格
<!-- requester-bot-forward-to: a;b -->|转交对象不合格
<!-- requester-bot-forward-to 运营 -->|转交标记格式不对
CASES
    fresh; add_comment 80 worker-bot "$(handoff_body 运营)
<!-- requester-bot-forward-to: 法务 -->" >/dev/null
    reject_case "标记有两行" 80 "转交标记有 2 行"
    # 跨次：叫醒成功后不发新评论又跑一次 → 拒绝，评论、标签、webhook 都不变
    fresh; wake "$S" 80
    chk "拒绝 · 复用前提：第一次叫醒成功" "$RC" 0
    local before; before=$(body_of 80 "$C80")
    set_field 80 labels '["waiting/bot","doing/agent"]'
    # 叫醒成功后本账号最新的一条是叫醒记录，没有转交标记
    reject_case "复用已经叫醒过的交接评论" 80 "没有转交标记"
    chk "拒绝 · 复用：交接评论没动" "$([ "$(body_of 80 "$C80")" = "$before" ] && echo yes || echo no)" yes
    chk "拒绝 · 复用：没有多发叫醒记录" "$(receipts 80)" 1
    chk "拒绝 · 复用：标签没动" "$(labels_of 80)" "waiting/bot,doing/agent"
}
reject_suite "$NEW"

# ─────────────────────────────────────────────────────────────────────────
echo "── 4. 开关开 · 失败与重试 ──"
# ─────────────────────────────────────────────────────────────────────────
C_GET='issues/comments/[0-9]+$'
retry_case() {   # <说明> <期望退出码> <期望 webhook 次数> <期望挂标签次数> <faults JSON>
    local desc="$1" want="$2" hooks="$3" nwait="$4" spec="$5"
    fresh; faults "$spec"; local orig; orig=$(body_of 80 "$C80")
    OBS=1 wake "$S" 80
    local now; now=$(body_of 80 "$C80")
    chk "重试 · $desc：退出码 $want" "$RC" "$want"
    chk "重试 · $desc：webhook $hooks 次" "$(hook_count)" "$hooks"
    chk "重试 · $desc：挂了 $nwait 次等待标签" "$(wait_events 80)" "$nwait"
    if [ "$want" = 0 ]; then
        chk "重试 · $desc：只剩等待标签" "$(labels_of 80)" "waiting/bot"
        chk "重试 · $desc：最新的叫醒记录写的是最后一次挂标签" "$(latest_receipt 80)" "event=$(last_wait_event 80) comment=$C80"
        chk "重试 · $desc：机器人认这条评论" "$(ref 80)" "ready $C80 运营"
        chk "重试 · $desc：交接评论一个字节都没动" "$([ "$now" = "$orig" ] && echo yes || echo no)" yes
    else
        chk "重试 · $desc：交还后只挂 pending/human" "$(labels_of 80)" "pending/human"
        chk "重试 · $desc：交还后机器人不拉这一条" "$(ref 80)" not-waiting
    fi
    # 叫醒记录发出后交接评论被改、或存下的叫醒记录本身不对：机器人此时判「出错」是对的（就该交人），不算违规
    chk "重试 · $desc：过程中机器人没判「出错」、没选别的评论" \
        "$(grep -vE "^(not-waiting|preparing|handed-back|ready $C80 运营${ALLOW_ERR:+|error 正文指纹对不上（评论被改过）|error 挂标签之后没有对应的叫醒记录})\$" "$RW/gh/obs.log" | sort -u | paste -sd'|')" ""
}
RCPT_POST='issues/80/comments$'
RCPT_JQ='(.items["80"].comments[] | select(.user == "worker-bot" and (.body | test("requester-bot-wake: "))) | .body)'
EDIT_C='(.items["80"].comments[] | select(.user == "worker-bot" and (.body | test("requester-bot-forward-to"))) | .body) |= sub("一键开通"; "一键购买")'
jsq() { jq -cn --arg x "$1" '$x'; }   # 把一段 jq 表达式写成 JSON 字符串
retry_suite() {   # <scripts 副本>
    S="$1"
    retry_case "发叫醒记录报错一次" 0 1 2 '[{"method":"POST","path":"'"$RCPT_POST"'","mode":"fail","times":1}]'
    retry_case "发叫醒记录报错、其实已发出" 0 1 2 '[{"method":"POST","path":"'"$RCPT_POST"'","mode":"applyfail","times":1}]'
    # 读评论：叫醒前核对交接评论、挂标签后重读交接评论（放过这两次），第 3 次是读回叫醒记录
    retry_case "读回叫醒记录失败一次" 0 1 2 '[{"method":"GET","path":"'"$C_GET"'","mode":"fail","skip":2,"times":1}]'
    retry_case "读回一直失败" 3 0 2 '[{"method":"GET","path":"'"$C_GET"'","mode":"fail","skip":2}]'
    retry_case "发叫醒记录一直失败" 3 0 2 '[{"method":"POST","path":"'"$RCPT_POST"'","mode":"fail"}]'
    retry_case "读标签事件看不到这次挂的（新事件 0 个）" 3 0 2 '[{"method":"GET","path":"/events$","mode":"hidenew"}]'
    retry_case "本账号新事件 2 个" 3 0 4 '[{"method":"POST","path":"/labels$","field":"waiting/bot","mode":"set","jq":".items[\"80\"].events += [{\"event\":\"labeled\",\"actor\":\"worker-bot\",\"label\":\"waiting/bot\",\"id\":.next_event_id}] | .next_event_id += 1"}]'
    # 存下的叫醒记录本身不对（指纹 / 事件编号）：读回发现，重试
    ALLOW_ERR=1 retry_case "读回的叫醒记录指纹不对" 0 1 2 '[{"method":"GET","path":"'"$C_GET"'","mode":"set","skip":2,"times":1,"jq":'"$(jsq "$RCPT_JQ"' |= sub("sha256=[0-9a-f]+"; "sha256='"$(printf 0%.0s $(seq 64))"'")')"'}]'
    ALLOW_ERR=1 retry_case "读回的叫醒记录事件编号不对" 0 1 2 '[{"method":"GET","path":"'"$C_GET"'","mode":"set","skip":2,"times":1,"jq":'"$(jsq "$RCPT_JQ"' |= sub("event=[0-9]+"; "event=1")')"'}]'
    # 不重试的：只挂了一次等待标签
    retry_case "挂标签后交接评论被人改了" 3 0 1 '[{"method":"POST","path":"/labels$","field":"waiting/bot","mode":"set","jq":'"$(jsq "$EDIT_C")"'}]'
    retry_case "挂标签后交接评论被删了" 3 0 1 '[{"method":"POST","path":"/labels$","field":"waiting/bot","mode":"set","jq":".items[\"80\"].comments |= map(select(.user != \"worker-bot\"))"}]'
    retry_case "挂标签后本账号又发了评论" 3 0 1 '[{"method":"POST","path":"/labels$","field":"waiting/bot","mode":"set","jq":".items[\"80\"].comments += [{\"id\": 1999, \"user\": \"worker-bot\", \"body\": \"补一句\"}]"}]'
    # 复审第 1 轮的反例：重读交接评论之后、发叫醒记录的同时，有人改了交接评论
    ALLOW_ERR=1 retry_case "发叫醒记录的同时交接评论被人改了" 3 0 1 '[{"method":"POST","path":"'"$RCPT_POST"'","mode":"set","times":1,"jq":'"$(jsq "$EDIT_C")"'}]'
    chk "重试 · 发叫醒记录的同时被改：别人的修改原样保留（没被旧副本覆盖）" \
        "$(body_of 80 "$C80" | grep -c '一键购买')|$(body_of 80 "$C80" | grep -c '一键开通')" "1|0"
    chk "重试 · 发叫醒记录的同时被改：没有编辑任何评论" "$(patches)" 0
    # 时限：设成 0 秒 = 一挂上就超时，不发叫醒记录、交还
    fresh "true"; printf 'REQUESTER_BOT_WAKE_DEADLINE_SECS=0\n' >> "$RW/cavil-loop.config"
    : > "$RW/gh/calls.log"; OBS=1 wake "$S" 80
    chk "重试 · 超过时限：退出码 3" "$RC" 3
    chk "重试 · 超过时限：没发叫醒记录" "$(receipts 80)" 0
    chk "重试 · 超过时限：webhook 0 次" "$(hook_count)" 0
    chk "重试 · 超过时限：只挂 pending/human" "$(labels_of 80)" "pending/human"
    chk "重试 · 超过时限：输出写明原因" "$(printf '%s' "$OUT" | grep -q '还没发出叫醒记录，不再发' && echo yes || echo no)" yes
    chk "重试 · 超过时限：过程中没判「出错」" "$(grep -c '^error' "$RW/gh/obs.log")" 0
    # 交还也失败：退出码 4，照旧路径
    fresh; faults '[{"method":"POST","path":"'"$RCPT_POST"'","mode":"fail"},{"method":"POST","path":"/labels$","field":"pending/human","mode":"fail"}]'
    wake "$S" 80
    chk "重试 · 交还也失败：退出码 4" "$RC" 4
    chk "重试 · 交还也失败：webhook 0 次" "$(hook_count)" 0
}
retry_suite "$NEW"

# ─────────────────────────────────────────────────────────────────────────
echo "── 6. 机器人侧：叫醒之后的变化 ──"
# ─────────────────────────────────────────────────────────────────────────
consumer_suite() {   # <scripts 副本> [参考实现的规则]
    local S="$1" R="${2:-v4}" e
    fresh; wake "$S" 80; e=$(last_wait_event 80)
    chk "机器人 · 正常：就绪" "$(ref 80 --rule "$R")" "ready $C80 运营"
    chk "机器人 · 过了 31 分钟仍是就绪（叫醒记录在就不受时限影响）" "$(ref 80 --minutes 31 --rule "$R")" "ready $C80 运营"
    # 外人伪造一条同一事件编号的叫醒记录，指向他自己写的交接评论：不认
    local fc; fc=$(add_comment 80 someone "$(handoff_body 黑客)")
    add_comment 80 someone "<!-- requester-bot-wake: event=$e comment=$fc sha256=$(printf 0%.0s $(seq 64)) -->" >/dev/null
    chk "机器人 · 外人伪造同一编号的叫醒记录：照旧认原评论" "$(ref 80 --rule "$R")" "ready $C80 运营"
    # 交接评论被改
    jqset --argjson id "$C80" '(.items["80"].comments[] | select(.id == $id) | .body) |= sub("一键开通"; "一键购买")'
    chk "机器人 · 叫醒后评论被改：出错，不转达" "$(ref 80 --rule "$R" | awk '{print $1}')" error
    # 交接评论被删，旁边还留着上一次叫醒用过的旧交接评论
    fresh; wake "$S" 80
    set_field 80 labels '["waiting/bot","pending/agent"]'
    local c2; c2=$(add_comment 80 worker-bot "$(handoff_body 法务)"); wake "$S" 80
    jqset --argjson id "$c2" '.items["80"].comments |= map(select(.id != $id))'
    chk "机器人 · 新交接评论被删、旧交接评论还在：出错交人，不往旧评论找" "$(ref 80 --rule "$R" | awk '{print $1}')" error
    # 叫醒记录被删：找不到对应记录 → 准备中，过了时限出错
    fresh; wake "$S" 80
    jqset '.items["80"].comments |= map(select((.body | test("requester-bot-wake: ")) | not))'
    chk "机器人 · 叫醒记录被删：准备中（不转达）" "$(ref 80 --rule "$R")" preparing
    chk "机器人 · 叫醒记录被删、过了 31 分钟：出错交人" "$(ref 80 --minutes 31 --rule "$R" | awk '{print $1}')" error
    # 维护者手动摘了再挂等待标签
    fresh; wake "$S" 80
    jqset '.items["80"].events += [{"event":"unlabeled","actor":"maintainer","label":"waiting/bot","id":9000},{"event":"labeled","actor":"maintainer","label":"waiting/bot","id":9001}]'
    chk "机器人 · 手动重挂：准备中（不转旧内容）" "$(ref 80 --rule "$R")" preparing
    chk "机器人 · 手动重挂、过了 31 分钟：出错交人" "$(ref 80 --minutes 31 --rule "$R" | awk '{print $1}')" error
}
consumer_suite "$NEW"

# ── 6b. 机器人那边怎么分流（代码复审第 2 轮）──
# 「是不是机器人提的需求」两边必须同一个规则：issue 看作者 + 来源标记；PR 看它关联的 issue。
# 叫醒脚本走了老路（退出 0、没发叫醒记录）的，机器人参考实现必须判「机器人提的」；
# 走了新路（发了叫醒记录）的，必须判就绪并选中同一条交接评论。
route_case() {   # <说明> <编号> <对象> <规则>：wake 之前已布置好状态
    local desc="$1" n="$2" t="$3" R="$4" c
    wake "$NEW" "$n"
    chk "分流 · $desc：叫醒成功" "$RC" 0
    if [ "$(receipts "$n")" = 0 ]; then
        chk "分流 · $desc：叫醒脚本走老路 → 机器人也判机器人提的需求" "$(ref "$n" --rule "$R")" bot-origin
    else
        c=$(jq -r --arg n "$n" '[.items[$n].comments[] | select(.user == "worker-bot" and (.body | test("requester-bot-forward-to")))] | max_by(.id).id' "$(ST)")
        chk "分流 · $desc：叫醒脚本走新路 → 机器人选中同一条交接评论" "$(ref "$n" --rule "$R")" "ready $c $t"
    fi
}
routing_suite() {   # [机器人侧规则]
    local R="${1:-v4}"
    fresh; route_case "机器人提的 issue" 50 - "$R"
    fresh; add_item 60 pr "doing/agent" worker-bot "Closes #50" feature/issue-50
    route_case "机器人需求的 PR（作者是 worker，正文没有来源标记）" 60 - "$R"
    fresh; add_item 65 pr "doing/agent" worker-bot "这份改动 Closes #50" chore/v
    route_case "机器人需求的另开 PR（分支不带编号，正文 Closes #50）" 65 - "$R"
    fresh; set_field 80 body '"维护者的需求，正文引用了一段 <!-- bot-origin -->"'
    route_case "维护者的 issue，正文引用了来源标记" 80 运营 "$R"
    fresh; set_field 80 user '"req-bot"'
    route_case "机器人账号开的 issue、但没有来源标记" 80 运营 "$R"
    fresh; route_case "维护者 issue 做出的 PR" 81 运营 "$R"
    fresh; add_item 86 pr "doing/agent" req-bot "说明 <!-- bot-origin -->" chore/w
    add_comment 86 worker-bot "$(handoff_body 运营)" >/dev/null
    route_case "机器人开的、没关联任何 issue 的 PR（正文带标记）" 86 运营 "$R"
    # 认不准的条目叫醒脚本会拒绝；万一别人手动挂了等待标签，机器人也不转达
    fresh; add_item 83 pr "waiting/bot" worker-bot $'Closes\n#50' chore/amb
    set_field 83 events '[{"event":"labeled","actor":"maintainer","label":"waiting/bot","id":4000}]'
    chk "分流 · PR 关联写法有歧义（Closes 和 #50 分两行）：机器人判认不准、不转达" "$(ref 83 --rule "$R" | awk '{print $1}')" error
}
routing_suite
# 观察（第 5 组）已经并在第 2、4 组里：每次 GitHub 调用之前都跑一次参考实现，
# 断言「过程中没判出错、没选别的评论」。

# ─────────────────────────────────────────────────────────────────────────
echo "── 7. 合并后通知不碰非机器人条目 ──"
# ─────────────────────────────────────────────────────────────────────────
done_call() {   # <scripts 副本> <PR> <kind>
    env FAKE_GH_DIR="$RW/gh" CODING_AGENT_CONFIG="$RW/cavil-loop.config" bash -c '
        source "$1/scripts/_lib.sh" 2>/dev/null; requester_bot_done_notify "$2" "$3"' _ "$1" "$2" "$3"
}
done_suite() {   # <scripts 副本>
    local S="$1" rc
    fresh; set_field 81 state '"closed"'; set_field 81 merged true; : > "$RW/gh/calls.log"
    rc=0; done_call "$S" 81 merged || rc=$?
    chk "合并后 · 非机器人 PR 合并：有定论（出队）" "$rc" 0
    chk "合并后 · 非机器人 PR 合并：零写请求" "$(writes)" 0
    chk "合并后 · 非机器人 PR 合并：webhook 0 次" "$(hook_count)" 0
    # 到达性：机器人提的需求照常通知
    add_item 60 pr "" worker-bot "" feature/issue-50; set_field 60 state '"closed"'; set_field 60 merged true
    : > "$RW/gh/calls.log"; hook_reset
    rc=0; done_call "$S" 60 merged || rc=$?
    chk "合并后 · 到达性：机器人提的需求照常通知（发了评论、挂了等待标签）" \
        "$rc|$(jq -r '.items["50"].comments | length' "$(ST)")|$(labels_of 50 | tr ',' '\n' | grep -cx waiting/bot)" "0|1|1"
}
done_suite "$NEW"

# ─────────────────────────────────────────────────────────────────────────
echo "── 8. 开关开：提示词 ──"
# ─────────────────────────────────────────────────────────────────────────
ANY_HEAD='## 维护者自己的条目也能叫醒（本项目开启了这一项）'
prompt_suite() {   # <scripts 副本>
    local S="$1" kind out
    new_env true
    for kind in new-issue issue-comment pr-comment review; do
        out=$(compose_out "$S" $kind)
        chk "开关开 · $kind：「维护者自己的条目」一段恰好一次" "$(printf '%s\n' "$out" | grep -cxF "$ANY_HEAD")" 1
        chk "开关开 · $kind：排在交接规则之后" \
            "$(printf '%s\n' "$out" | awk -v h="$ANY_HEAD" '/^# 外部需求机器人交接规则/{a=NR} $0==h{b=NR} END{print (a && b > a) ? "yes" : "no"}')" yes
        chk "开关开 · $kind：占位符都替换掉了" "$(printf '%s\n' "$out" | grep -c '@@')" 0
        chk "开关开 · $kind：叫醒命令带上本项目配置（两段各一次）" "$(printf '%s\n' "$out" | grep -cF -- "--config '$RW/cavil-loop.config'")" 2
        chk "开关开 · $kind：写明标记格式" "$(printf '%s\n' "$out" | grep -cxF '   <!-- requester-bot-forward-to: <对象> -->')" 1
    done
}
prompt_suite "$NEW"

# ─────────────────────────────────────────────────────────────────────────
echo "── 9. 负对照 ──"
# ─────────────────────────────────────────────────────────────────────────
D=$(mutate no-switch scripts/notify-requester-bot.sh \
    'elif [ "$ORIGIN_RC" = 1 ] && requester_bot_wake_any_item \' \
    'elif [ "$ORIGIN_RC" = 1 ] && true \') && neg "不看开关" off_suite "$D"
D=$(mutate accept-unknown scripts/notify-requester-bot.sh \
    '     && { [ "$REQUESTER_BOT_ORIGIN_CLASS" = linked-other ] || [ "$REQUESTER_BOT_ORIGIN_CLASS" = none ]; }; then' \
    '     ; then') && neg "关联认不准也放行" reject_suite "$D"
D=$(mutate no-linked-takeover scripts/notify-requester-bot.sh \
    '    ORIGIN="${REQUESTER_BOT_LINKED:-$NUM}"' \
    '    ORIGIN="$NUM"') && neg "不查关联 issue 的维护者接手" reject_suite "$D"
D=$(mutate no-remove-first scripts/notify-requester-bot.sh \
    '        gh_write api -X DELETE "repos/$REPO/issues/$NUM/labels/$enc" >/dev/null 2>&1 || true
    }
    wake_once || return 1' \
    '        :
    }
    wake_once || return 1') && neg "已挂着等待标签时不先摘再挂" success_suite "$D"
D=$(mutate no-recheck scripts/notify-requester-bot.sh \
    '    E_ID="$e"
    rc=0; recheck_c || rc=$?' \
    '    E_ID="$e"
    rc=0') && neg "挂标签后不重读交接评论" retry_suite "$D"
D=$(mutate no-post-check scripts/notify-requester-bot.sh \
    '    # 发记录的同时 C 被改过：机器人会判「出错」交人，这边也不报成功
    rc=0; recheck_c || rc=$?' \
    '    rc=0') && neg "发完叫醒记录不再核对交接评论" retry_suite "$D"
D=$(mutate count-own-receipt scripts/notify-requester-bot.sh \
    '    cur=$(my_latest_comment "$C_ID") || { LAST_FAIL="重读评论列表失败"; return 1; }' \
    '    cur=$(my_latest_comment) || { LAST_FAIL="重读评论列表失败"; return 1; }') \
    && neg "重试时把这次发的叫醒记录当成别的评论" retry_suite "$D"
D=$(mutate no-verify scripts/notify-requester-bot.sh \
    '    python3 "$HANDOFF_PY" verify "$TMPD/rr" "$E_ID" "$C_ID" "$C_FP" >/dev/null \' \
    '    true \') && neg "不核对读回的叫醒记录" retry_suite "$D"
D=$(mutate no-deadline scripts/notify-requester-bot.sh \
    '    if past_deadline; then' \
    '    if false; then') && neg "去掉时限" retry_suite "$D"
# 允许复用：找交接评论时跳过所有叫醒记录（于是叫醒过的旧交接评论又成了「最新」）
D=$(mutate reuse-a scripts/notify-requester-bot.sh \
    '            [[ "$body" == *"<!-- requester-bot-wake: event="*" comment=$1 sha256="* ]] && continue' \
    '            [[ "$body" == *"<!-- requester-bot-wake: "* ]] && continue') \
    && D=$(MUT_BASE="$D" mutate reuse-b scripts/notify-requester-bot.sh \
    '    C_ID=$(my_latest_comment) || reject' \
    '    C_ID=$(my_latest_comment any) || reject') && neg "允许复用已经叫醒过的交接评论" reject_suite "$D"
D=$(mutate edit-comment scripts/notify-requester-bot.sh \
    '    rid=$(gh_write api -X POST "repos/$REPO/issues/$NUM/comments" --input "$TMPD/receipt.json" --jq '"'"'.id'"'"') \' \
    '    gh_write api -X PATCH "repos/$REPO/issues/comments/$C_ID" --input "$TMPD/receipt.json" >/dev/null || true
    rid=$(gh_write api -X POST "repos/$REPO/issues/$NUM/comments" --input "$TMPD/receipt.json" --jq '"'"'.id'"'"') \') \
    && neg "叫醒时还整段改写交接评论" success_suite "$D"
D=$(mutate done-uses-class scripts/_lib.sh \
    '    rc=0; requester_bot_item_origin "$pr" "$item" || rc=$?
    case "$rc" in' \
    '    rc=0; requester_bot_item_origin "$pr" "$item" || rc=$?
    [ "$REQUESTER_BOT_ORIGIN_CLASS" != linked-other ] || { rc=0; REQUESTER_BOT_ORIGIN="$REQUESTER_BOT_LINKED"; }
    case "$rc" in') && neg "合并后通知改用新分类" done_suite "$D"
D=$(mutate origin-rc scripts/_lib.sh \
    '        REQUESTER_BOT_REASON="#$origin 不是外部需求机器人提的需求（作者是 ${author:-未知}，不是 $REQUESTER_BOT_ACCOUNT）"
        return 1' \
    '        REQUESTER_BOT_REASON="#$origin 不是外部需求机器人提的需求（作者是 ${author:-未知}，不是 $REQUESTER_BOT_ACCOUNT）"
        requester_bot_wake_any_item && { REQUESTER_BOT_ORIGIN="$origin"; return 0; }
        return 1') && neg "开关打开时来源判定直接返回「是」" origin_suite "$D"
D=$(mutate no-prompt scripts/_lib.sh \
    '    requester_bot_wake_any_item || return 0
    f="$SKILL_DIR/prompts/requester-bot-handoff-any-item.md"' \
    '    return 0
    f="$SKILL_DIR/prompts/requester-bot-handoff-any-item.md"') && neg "不追加「维护者自己的条目」一段" prompt_suite "$D"
D=$(mutate prompt-always scripts/_lib.sh \
    '    requester_bot_wake_any_item || return 0
    f="$SKILL_DIR/prompts/requester-bot-handoff-any-item.md"' \
    '    f="$SKILL_DIR/prompts/requester-bot-handoff-any-item.md"') && neg "开关关也追加" off_prompt_suite "$D"
# 机器人侧退回前几版的规则：观察和机器人侧的断言必须变红
ref_rule_suite() {   # <规则>
    local R="$1"
    fresh; REF_RULE="$R" OBS=1 wake "$NEW" 80
    chk "规则 $R · 叫醒过程中机器人没判出错" "$(grep -c '^error' "$RW/gh/obs.log")" 0
    chk "规则 $R · 叫醒过程中确实观察了" "$([ -s "$RW/gh/obs.log" ] && echo yes || echo no)" yes
    consumer_suite "$NEW" "$R"
}
neg "机器人侧只看当前条目正文里有没有来源标记来分流" routing_suite bodymark
if mutation_on; then
    for r in v3 v2; do
        mutation_gate || true
        before=$fail; QUIET=1; ref_rule_suite $r; QUIET=0; got=$((fail - before)); fail=$before
        chk "负对照：机器人侧退回 $r 规则 → 变红（$got 条失败）" "$([ "$got" -gt 0 ] && echo red || echo green)" red
    done
else
    mutation_gate || true; mutation_gate || true
fi

# ─────────────────────────────────────────────────────────────────────────
echo "── 汇总 ──"
if [ -s "$PREP_FAILED" ]; then
    echo "  ❌ 有 $(wc -l < "$PREP_FAILED" | tr -d ' ') 个负对照没准备成功（没跑）："
    sed 's/^/     · /' "$PREP_FAILED"
    fail=$((fail + $(wc -l < "$PREP_FAILED")))
fi
mutation_summary "$0"
compat_summary
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
