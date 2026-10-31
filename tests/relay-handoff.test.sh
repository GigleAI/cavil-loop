#!/usr/bin/env bash
# 外部传话机器人交接（GitHub#95）的行为守卫。
#
# 跑法：bash tests/relay-handoff.test.sh        （约 1–2 分钟）
# 依赖：jq、python3、git。不碰网络、不调真 gh：假 gh（tests/fixtures/relay-fake-gh.py）是一个
# 带状态的最小 GitHub，每次调用记进 calls.log，写调用另记一行 WRITE。
#
# 覆盖：
#   1. 功能关闭时：轮询的 GitHub 调用、派工记录、四类提示词拼装结果与改动前（merge-base 上的
#      scripts/ + prompts/）逐字节一致
#   2. 等待期间：只挂等待标签 → greedy 兜底、self-heal 都不派；又打了触发标签（普通 / fable /
#      追加 / pending/review，issue 与 PR）→ 按原流程派一次，派完等待标签被摘掉
#   3. 叫醒脚本：前置检查拒绝（零写请求）、成功、先移再加、失败重试、交还维护者、交还中途失败
#   4. 提示词：开启时四类提示词末尾恰好一段交接规则，项目整份替换模板也收得到
# 每组都配负对照：把被测脚本复制一份、改坏一处，同一组断言必须变红。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
FAKE="$TEST_DIR/fixtures/relay-fake-gh.py"

# 从 worker / daemon 里跑时环境里带着这几个变量，会把 SKILL_DIR 钉到别处的安装上：
# 新旧两份副本就都读同一套 prompts/，「和改动前逐字节一致」就成了自己比自己。
unset CODING_AGENT_RELEASE_ROOT CLAUDE_PLUGIN_ROOT CAVIL_DEPLOY_ROOT CAVIL_DEPLOY_CONF \
      CODING_AGENT_CONFIG CODING_AGENT_RELEASE_LEASE_FD TICK_DIR

SANDBOX=$(mktemp -d)
cleanup() { [ -n "${KEEP_SANDBOX:-}" ] && { echo "SANDBOX=$SANDBOX"; return 0; }; rm -rf "$SANDBOX"; }
trap cleanup EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
cat > "$SANDBOX/bin/gh" <<EOF
#!/usr/bin/env bash
exec python3 -I "$FAKE" "\$@"
EOF
chmod +x "$SANDBOX/bin/gh"

pass=0; fail=0; QUIET=0
chk() {
    if [ "$2" = "$3" ]; then [ "$QUIET" = 1 ] || echo "  ✅ $1"; pass=$((pass+1))
    else [ "$QUIET" = 1 ] || echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

# ── 被测脚本的一份可改副本：$1 = 来源（仓库根 或 merge-base 解出来的目录），$2 = 目标 ──
# dispatch-*.sh 换成桩：记一行派工 + 走真实的「翻 doing/agent」那一步（新版是 _lib.sh 的
# flip_to_doing；改动前的旧版没有这个函数，桩里照抄旧版的内联写法）。
make_copy() {
    local src="$1" dst="$2" f
    rm -rf "$dst"; mkdir -p "$dst"
    cp -r "$src/scripts" "$src/prompts" "$dst/"
    for f in dispatch-new-issue dispatch-issue-comment dispatch-pr-comment; do
        cat > "$dst/scripts/$f.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
trigger_labels_array
echo "$(basename "$0" .sh) $1 label=${DISPATCH_PENDING_AGENT_LABEL:-} kind=${DISPATCH_PROMPT_KIND:-}" >> "$FAKE_GH_DIR/dispatch.log"
if declare -F flip_to_doing >/dev/null; then
    flip_to_doing "$1" "stub" || true
else
    run_gh "label 翻转 (stub)" gh_label_flip "$1" --add "$LABEL_AGENT_DOING" --remove "${TRIGGER_LABELS_ALL[@]}" || true
fi
STUB
    done
}

# 改动前的版本：merge-base 上的 scripts/ + prompts/
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$SANDBOX/old-src"
git -C "$REPO_DIR" archive "$BASE_REV" scripts prompts | tar -x -C "$SANDBOX/old-src"

# ── 一个运行环境：配置 + 假 GitHub 状态 ──
# $1 = 目录，$2 = on/off（传话功能），$3 = label/greedy，其余 KEY=VAL 追加进配置
new_env() {
    local W="$1" relay="$2" mode="$3"; shift 3
    rm -rf "$W/state" "$W/gh" "$W/wt"; mkdir -p "$W/state" "$W/gh" "$W/wt" "$W/project"
    cat > "$W/cavil-loop.config" <<CONF
REPO="example/relay"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="relaytest$$"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_AGENT_EXTRA="pending/agent/05"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
DISPATCH_MODE="$mode"
MAX_CONCURRENT_WORKERS=50
POST_MERGE_RETROSPECTIVE=false
AUTO_CLEANUP_ON_MERGE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
WORKER_SECRET_ENV=""
PATH="$SANDBOX/bin:\$PATH"
CONF
    if [ "$relay" = on ]; then
        cat >> "$W/cavil-loop.config" <<'CONF'
LABEL_PENDING_RELAY="waiting/relay"
RELAY_BOT_ACCOUNT="relay-bot"
RELAY_ALLOWED_ACTORS="worker-bot, reviewer-bot"
RELAY_ORIGIN_MARKER="<!-- relay-origin -->"
CONF
    fi
    local kv; for kv in "$@"; do printf '%s\n' "$kv" >> "$W/cavil-loop.config"; done
    printf '{"me":"worker-bot","items":{}}' > "$W/gh/state.json"
    : > "$W/gh/calls.log"; : > "$W/gh/dispatch.log"
}

# 往假 GitHub 里放一条：add_item <W> <N> <issue|pr> <labels,逗号> [user] [body] [head_ref]
add_item() {
    local W="$1" n="$2" kind="$3" labels="$4" user="${5:-someone}" body="${6:-}" ref="${7:-}"
    local f="$W/gh/state.json"
    jq --arg n "$n" --arg kind "$kind" --arg labels "$labels" --arg user "$user" \
       --arg body "$body" --arg ref "$ref" '
        .items[$n] = {number: ($n|tonumber), title: "item \($n)", user: $user, body: $body,
                      state: "open", is_pr: ($kind == "pr"),
                      head_ref: (if $ref == "" then "feature/issue-\($n)" else $ref end),
                      labels: ($labels | split(",") | map(select(. != ""))),
                      assignees: [], events: []}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}
labels_of() { jq -r --arg n "$2" '.items[$n].labels | join(",")' "$1/gh/state.json"; }
assignees_of() { jq -r --arg n "$2" '.items[$n].assignees | join(",")' "$1/gh/state.json"; }
set_field() { local f="$1/gh/state.json"; jq --arg n "$2" --argjson v "$4" ".items[\$n].$3 = \$v" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
set_me() { local f="$1/gh/state.json"; jq --arg m "$2" '.me = $m' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
dispatched() { grep -c " $2 " "$1/gh/dispatch.log" 2>/dev/null || true; }
dispatch_line() { grep " $2 " "$1/gh/dispatch.log" | head -1; }
tick() {   # <scripts 副本> <W>
    rm -rf "$2/state/.tick"
    env FAKE_GH_DIR="$2/gh" CODING_AGENT_CONFIG="$2/cavil-loop.config" bash "$1/scripts/agent-poll.sh" >/dev/null 2>&1
}

NEW="$SANDBOX/new"; OLD="$SANDBOX/old"
make_copy "$REPO_DIR" "$NEW"
make_copy "$SANDBOX/old-src" "$OLD"

# ─────────────────────────────────────────────────────────────────────────
echo "── 1. 功能关闭：和改动前逐字节一致 ──"
# ─────────────────────────────────────────────────────────────────────────
seed_mixed() {   # 一批覆盖各条路径的条目（不含等待标签：关闭时它没有意义）
    local W="$1"
    add_item "$W" 1 issue "pending/agent"
    add_item "$W" 2 issue "pending/agent/fable"
    add_item "$W" 3 issue "pending/agent/05"
    add_item "$W" 4 issue "pending/review"
    add_item "$W" 5 issue "pending/review,pending/human"
    add_item "$W" 6 issue "doing/agent"
    add_item "$W" 7 issue ""
    add_item "$W" 8 issue "pending/human"
    add_item "$W" 9 issue "waiting/relay"
    add_item "$W" 20 pr "pending/agent"
    add_item "$W" 21 pr "pending/review"
    add_item "$W" 22 pr "doing/agent"
    add_item "$W" 23 pr "waiting/relay"
}
for mode in label greedy; do
    for v in old new; do
        W="$SANDBOX/off-$v-$mode"
        new_env "$W" off "$mode"
        seed_mixed "$W"
        if [ "$v" = old ]; then tick "$OLD" "$W"; tick "$OLD" "$W"; else tick "$NEW" "$W"; tick "$NEW" "$W"; fi
    done
    A="$SANDBOX/off-old-$mode/gh"; B="$SANDBOX/off-new-$mode/gh"
    chk "关闭 · $mode 模式：GitHub 调用逐条相同" "$(cmp -s "$A/calls.log" "$B/calls.log" && echo same || echo diff)" same
    chk "关闭 · $mode 模式：派工记录相同" "$(cmp -s "$A/dispatch.log" "$B/dispatch.log" && echo same || echo diff)" same
    chk "关闭 · $mode 模式：最终标签相同" "$(cmp -s <(jq -S '.items|map_values(.labels)' "$A/state.json") <(jq -S '.items|map_values(.labels)' "$B/state.json") && echo same || echo diff)" same
    chk "关闭 · $mode 模式：确实派了工（对拍不是两边都空）" "$([ -s "$B/dispatch.log" ] && echo yes || echo no)" yes
done

compose_out() {   # <scripts 副本> <W> <kind> → 拼好的提示词内容
    env FAKE_GH_DIR="$2/gh" CODING_AGENT_CONFIG="$2/cavil-loop.config" bash -c '
        source "$1/scripts/_lib.sh" 2>/dev/null; f=$(compose_prompt_template "$2"); cat "$f"' _ "$1" "$3"
}
project_prompts() {   # 模拟项目：一份整份替换的模板 + 一份追加要求
    local P="$1/project/.agents/skills/cavil-loop/prompts"
    mkdir -p "$P"
    printf '项目整份替换的新 issue 模板\n第二行\n' > "$P/new-issue.template.md"
    printf '项目追加要求：先跑 make check\n' > "$P/issue-comment.extra.md"
}
W="$SANDBOX/off-compose"; new_env "$W" off label; project_prompts "$W"
chk "对拍前提：两份副本读的是各自的 prompts/（不是同一套安装）" \
    "$(env CODING_AGENT_CONFIG="$W/cavil-loop.config" bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; printf %s "$SKILL_DIR"' _ "$NEW")" "$NEW"
for kind in new-issue issue-comment pr-comment review; do
    chk "关闭 · 提示词 $kind 和改动前逐字节一致" \
        "$(cmp -s <(compose_out "$OLD" "$W" $kind) <(compose_out "$NEW" "$W" $kind) && echo same || echo diff)" same
done

# ─────────────────────────────────────────────────────────────────────────
echo "── 2. 等待期间的派工 ──"
# ─────────────────────────────────────────────────────────────────────────
seed_wait() {
    local W="$1"
    # 只挂等待标签（含 greedy 会收的「什么触发标签都没有」）
    add_item "$W" 11 issue "waiting/relay"
    add_item "$W" 12 pr    "waiting/relay"
    # 等待标签 + 各种触发标签
    add_item "$W" 21 issue "waiting/relay,pending/agent"
    add_item "$W" 22 issue "waiting/relay,pending/agent/fable"
    add_item "$W" 23 issue "waiting/relay,pending/agent/05"
    add_item "$W" 24 issue "waiting/relay,pending/review"
    add_item "$W" 31 pr    "waiting/relay,pending/agent"
    add_item "$W" 32 pr    "waiting/relay,pending/agent/fable"
    add_item "$W" 33 pr    "waiting/relay,pending/agent/05"
    add_item "$W" 34 pr    "waiting/relay,pending/review"
    # self-heal：doing/agent 但没有 session
    add_item "$W" 41 issue "doing/agent,waiting/relay"
    add_item "$W" 42 issue "doing/agent"
    # 对照：普通的待派条目
    add_item "$W" 51 issue ""
}
wait_suite() {   # <scripts 副本> <mode>；断言写进 chk
    local S="$1" mode="$2" W="$SANDBOX/wait-$mode" n
    new_env "$W" on "$mode"
    seed_wait "$W"
    tick "$S" "$W"
    chk "$mode · 只挂等待标签的 issue 不派" "$(dispatched "$W" 11)" 0
    chk "$mode · 只挂等待标签的 PR 不派" "$(dispatched "$W" 12)" 0
    for n in 21 22 23 24 31 32 33 34; do
        chk "$mode · #$n 等待中又打了触发标签 → 派一次" "$(dispatched "$W" $n)" 1
        chk "$mode · #$n 派完等待标签被摘掉" "$(labels_of "$W" $n)" "doing/agent"
    done
    chk "$mode · fable 标签按 fable 原流程派" "$(dispatch_line "$W" 22 | grep -o 'label=[^ ]*')" "label=pending/agent/fable"
    chk "$mode · 追加标签按它自己派" "$(dispatch_line "$W" 33 | grep -o 'label=[^ ]*')" "label=pending/agent/05"
    chk "$mode · pending/review 按复审流程派" "$(dispatch_line "$W" 24 | grep -o 'kind=[^ ]*')" "kind=review"
    chk "$mode · self-heal 不碰等待中的条目" "$(labels_of "$W" 41)" "doing/agent,waiting/relay"
    chk "$mode · self-heal 照常恢复普通条目（对照）" "$(labels_of "$W" 42)" "pending/agent"
    if [ "$mode" = greedy ]; then
        chk "greedy · 普通条目照常兜底派工（对照）" "$(dispatched "$W" 51)" 1
    fi
    # 第二轮：只剩等待标签的那几条仍然不派
    tick "$S" "$W"
    chk "$mode · 第二轮仍不派只挂等待标签的条目" "$(( $(dispatched "$W" 11) + $(dispatched "$W" 12) + $(dispatched "$W" 41) ))" 0
    # 等待标签摘掉 → greedy 续上；label 模式要有人打触发标签
    set_field "$W" 11 labels '[]'
    tick "$S" "$W"
    if [ "$mode" = greedy ]; then
        chk "greedy · 摘掉等待标签后照常续上" "$(dispatched "$W" 11)" 1
    else
        chk "label · 摘掉等待标签、没有触发标签 → 不派（要有人打触发标签）" "$(dispatched "$W" 11)" 0
        set_field "$W" 11 labels '["pending/agent"]'
        tick "$S" "$W"
        chk "label · 再打上触发标签 → 派" "$(dispatched "$W" 11)" 1
    fi
}
wait_suite "$NEW" label
wait_suite "$NEW" greedy

# 负对照：复制一份新版、改坏一处（python 精确替换，替换不到就当场报错），整组断言必须变红
mutate() {   # <名字> <文件（相对副本根）> <原文> <改成>
    local D="$SANDBOX/mut-$1"
    rm -rf "$D"; cp -r "$NEW" "$D"
    python3 - "$D/$2" "$3" "$4" <<'PYM' || { echo "  ❌ 负对照 $1 没改上（原文找不到）"; fail=$((fail+1)); return 1; }
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
if s.count(old) != 1:
    sys.exit(1)
open(p, "w").write(s.replace(old, new))
PYM
    printf '%s' "$D"
}
neg() {   # <说明> <要跑的 suite 函数及参数…>：跑一遍，失败条数必须 > 0
    local desc="$1"; shift
    local before=$fail
    QUIET=1; [ -z "${SHOW_NEG:-}" ] || QUIET=0; "$@"; QUIET=0
    local got=$((fail - before))
    fail=$before
    chk "负对照：$desc → 变红（$got 条失败）" "$([ "$got" -gt 0 ] && echo red || echo green)" red
}

echo "── 2b. 负对照 ──"
D=$(mutate skip-in-label-pass scripts/agent-poll.sh \
    '        if labels_have_relay "$labels_csv"; then
            log "${kind} #${num} 挂着等待传话标签' \
    '        if labels_have_relay "$labels_csv"; then continue; fi
        if labels_have_relay "$labels_csv"; then
            log "${kind} #${num} 挂着等待传话标签') && neg "按触发标签收活那一趟改回「挂着等待标签就跳过」" wait_suite "$D" label
D=$(mutate no-greedy-skip scripts/_lib.sh \
    '        "${LABEL_PENDING_REVIEW:-}" \
        "${LABEL_PENDING_RELAY:-}"' \
    '        "${LABEL_PENDING_REVIEW:-}"') && neg "greedy 挡工清单去掉等待标签" wait_suite "$D" greedy
D=$(mutate no-dispatch-clear scripts/_lib.sh \
    '[ -z "$LABEL_PENDING_RELAY" ] || RELAY_DISPATCH_CLEAR=("$LABEL_PENDING_RELAY")' \
    ':') && neg "派工时不摘等待标签" wait_suite "$D" label
D=$(mutate no-selfheal-skip scripts/agent-poll.sh \
    '    if labels_have_relay "$labels_csv"; then
        SELFHEAL_RELAY+=' \
    '    if false; then
        SELFHEAL_RELAY+=') && neg "self-heal 不看等待标签" wait_suite "$D" label

# ── 2c. 三个真实派工脚本：派工翻 doing/agent 时都摘掉等待标签 ──
# 上面的轮询测试把派工脚本换成了桩；这里起**真的** dispatch-*.sh（假 gh + 一律返回成功的
# 假 tmux + 真 git 仓库），逐个确认三条派工路径都经同一个「翻 doing/agent」步骤。
DX="$SANDBOX/dx"
mkdir -p "$DX/bin" "$DX/home"
printf '#!/usr/bin/env bash\nexit 0\n' > "$DX/bin/tmux"; chmod +x "$DX/bin/tmux"
git init -q --bare "$DX/up.git"
git clone -q "$DX/up.git" "$DX/seed" 2>/dev/null
(cd "$DX/seed" && git -c user.email=t@x -c user.name=t commit -q --allow-empty -m init && git push -q origin HEAD:main) >/dev/null 2>&1
# 编号取得很大：派工脚本会往 /tmp 写 prompt 文件，避开本机真实派工的文件名
N_CMT=987951; N_PR=987952; N_NEW=987953
real_dispatch_suite() {   # <scripts 目录（未换桩的真脚本）>
    local SD="$1" W="$DX/run"
    rm -rf "$W"; mkdir -p "$W"
    new_env "$W" on label "PATH=\"$DX/bin:$SANDBOX/bin:\$PATH\"" 'WORKER_SECRET_ENV=""'
    git clone -q "$DX/up.git" "$W/project" 2>/dev/null
    add_item "$W" $N_CMT issue "waiting/relay,pending/agent"
    add_item "$W" $N_PR  pr    "waiting/relay,pending/agent" someone "" "feature/issue-$N_PR"
    add_item "$W" $N_NEW issue "waiting/relay,pending/agent"
    local run=(env HOME="$DX/home" FAKE_GH_DIR="$W/gh" CODING_AGENT_CONFIG="$W/cavil-loop.config")
    (cd "$W/project" && "${run[@]}" timeout 120 bash "$SD/dispatch-issue-comment.sh" $N_CMT 0) >/dev/null 2>&1
    (cd "$W/project" && "${run[@]}" timeout 120 bash "$SD/dispatch-pr-comment.sh" $N_PR "feature/issue-$N_PR" 0) >/dev/null 2>&1
    (cd "$W/project" && "${run[@]}" timeout 120 bash "$SD/dispatch-new-issue.sh" $N_NEW) >/dev/null 2>&1
    chk "真派工 · issue 评论派工摘掉等待标签" "$(labels_of "$W" $N_CMT)" "doing/agent"
    chk "真派工 · PR 评论派工摘掉等待标签" "$(labels_of "$W" $N_PR)" "doing/agent"
    chk "真派工 · 新 issue 派工摘掉等待标签" "$(labels_of "$W" $N_NEW)" "doing/agent"
    rm -f /tmp/cavil-loop-issue-$N_CMT-* /tmp/cavil-loop-pr-$N_PR-* /tmp/cavil-loop-issue-$N_NEW-*
}
REAL_NEW="$SANDBOX/real-new"; rm -rf "$REAL_NEW"; mkdir -p "$REAL_NEW"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$REAL_NEW/"
real_dispatch_suite "$REAL_NEW/scripts"
# 负对照：逐个派工脚本改回不带等待标签的旧写法，那一条必须变红
real_mut() {   # <名字> <脚本> <原文>
    local Dm="$SANDBOX/real-mut-$1"
    rm -rf "$Dm"; cp -r "$REAL_NEW" "$Dm"
    python3 - "$Dm/scripts/$2" "$3" <<'PYM' || { echo "  ❌ 负对照 $1 没改上"; fail=$((fail+1)); return 1; }
import sys, re
p, old = sys.argv[1:3]
s = open(p).read()
if s.count(old) != 1: sys.exit(1)
num = re.search(r'flip_to_doing "(\$[A-Z]+)"', old).group(1)
s = s.replace(old, f'run_gh "x" gh_label_flip "{num}" --add "$LABEL_AGENT_DOING" --remove "${{TRIGGER_LABELS_ALL[@]}}" || true')
open(p, "w").write(s)
PYM
    printf '%s' "$Dm/scripts"
}
D=$(real_mut cmt dispatch-issue-comment.sh 'flip_to_doing "$ISSUE" "issue #$ISSUE pending/agent → doing/agent" || true') \
    && neg "issue 评论派工改回不摘等待标签" real_dispatch_suite "$D"
D=$(real_mut pr dispatch-pr-comment.sh 'flip_to_doing "$PR" "PR #$PR pending/agent → $LABEL_AGENT_DOING" || true') \
    && neg "PR 评论派工改回不摘等待标签" real_dispatch_suite "$D"
D=$(real_mut new dispatch-new-issue.sh 'flip_to_doing "$ISSUE" "issue #$ISSUE pending/agent → doing/agent" || true') \
    && neg "新 issue 派工改回不摘等待标签" real_dispatch_suite "$D"

# ─────────────────────────────────────────────────────────────────────────
echo "── 3. 叫醒脚本 ──"
# ─────────────────────────────────────────────────────────────────────────
MARK='<!-- relay-origin -->'
RW="$SANDBOX/relay"
relay_case() {   # <scripts 副本> <N>：跑叫醒脚本，退出码进 RC，输出进 OUT
    RC=0
    OUT=$(env FAKE_GH_DIR="$RW/gh" bash "$1/scripts/notify-relay.sh" --config "$RW/cavil-loop.config" "$2" 2>&1) || RC=$?
}
writes() { grep -c '^WRITE ' "$RW/gh/calls.log" 2>/dev/null || true; }
fresh_relay() {   # 一条标准的「机器人提的需求」#50 + 关联它的 PR #60
    new_env "$RW" on label
    add_item "$RW" 50 issue "doing/agent,pending/agent" relay-bot "需求正文
$MARK"
    add_item "$RW" 60 pr "doing/agent,pending/review" worker-bot "实现 #50" feature/issue-50
    add_item "$RW" 61 pr "doing/agent" worker-bot "无关 PR" chore/x
    printf '[]' > "$RW/gh/faults.json"
}
faults() { printf '%s' "$1" > "$RW/gh/faults.json"; }
reject_suite() {   # <scripts 副本>
    local S="$1"
    fresh_relay; set_me "$RW" outsider; : > "$RW/gh/calls.log"
    relay_case "$S" 50; chk "拒绝 · 账号不在名单：退出码 2" "$RC" 2; chk "拒绝 · 账号不在名单：零写请求" "$(writes)" 0
    fresh_relay; add_item "$RW" 50 issue "doing/agent" someone "$MARK"; : > "$RW/gh/calls.log"
    relay_case "$S" 50; chk "拒绝 · 正文有标记但作者不是机器人：退出码 2" "$RC" 2; chk "拒绝 · 作者不是机器人：零写请求" "$(writes)" 0
    fresh_relay; add_item "$RW" 50 issue "doing/agent" relay-bot "没有标记"; : > "$RW/gh/calls.log"
    relay_case "$S" 50; chk "拒绝 · 没有需求标记：退出码 2" "$RC" 2; chk "拒绝 · 没有需求标记：零写请求" "$(writes)" 0
    fresh_relay; set_field "$RW" 50 labels '["pending/human"]'; : > "$RW/gh/calls.log"
    relay_case "$S" 50; chk "拒绝 · 挂着 pending/human：退出码 2" "$RC" 2; chk "拒绝 · 挂着 pending/human：零写请求" "$(writes)" 0
    fresh_relay; set_field "$RW" 60 labels '["pending/review","pending/human"]'; : > "$RW/gh/calls.log"
    relay_case "$S" 60; chk "拒绝 · 复审轮次用尽双标签：退出码 2" "$RC" 2
    chk "拒绝 · 复审轮次用尽：两个标签都保留" "$(labels_of "$RW" 60)" "pending/review,pending/human"
    chk "拒绝 · 复审轮次用尽：零写请求" "$(writes)" 0
    fresh_relay; set_field "$RW" 50 events '[{"event":"labeled","actor":"maintainer","label":"pending/human"},{"event":"unlabeled","actor":"maintainer","label":"pending/human"}]'
    : > "$RW/gh/calls.log"
    relay_case "$S" 50; chk "拒绝 · 维护者曾手打 pending/human：退出码 2" "$RC" 2; chk "拒绝 · 维护者手打过：零写请求" "$(writes)" 0
    fresh_relay; set_field "$RW" 50 events '[{"event":"labeled","actor":"maintainer","label":"pending/human"}]'; : > "$RW/gh/calls.log"
    relay_case "$S" 60; chk "拒绝 · PR 关联的 issue 被维护者接手过：退出码 2" "$RC" 2
    fresh_relay; faults '[{"method":"GET","path":"/events$","mode":"fail"}]'; : > "$RW/gh/calls.log"
    relay_case "$S" 50; chk "拒绝 · 读不到标签历史 → 当作不知道：退出码 2" "$RC" 2; chk "拒绝 · 读不到标签历史：零写请求" "$(writes)" 0
    fresh_relay; : > "$RW/gh/calls.log"
    relay_case "$S" 61; chk "拒绝 · PR 关联不到机器人的 issue：退出码 2" "$RC" 2
}
success_suite() {   # <scripts 副本>
    local S="$1"
    fresh_relay
    relay_case "$S" 50
    chk "成功 · 普通叫醒：退出码 0" "$RC" 0
    chk "成功 · 只剩等待标签（触发标签、doing/agent 都摘了）" "$(labels_of "$RW" 50)" "waiting/relay"
    chk "成功 · 机器人成了 assignee" "$(assignees_of "$RW" 50)" "relay-bot"
    # 机器人已是 assignee：必须先移再加（直接加不会通知它）
    fresh_relay; set_field "$RW" 50 assignees '["relay-bot"]'; : > "$RW/gh/calls.log"
    relay_case "$S" 50
    chk "成功 · 已是 assignee：退出码 0" "$RC" 0
    chk "成功 · 已是 assignee：先 DELETE 再 POST" \
        "$(grep -E '^WRITE (DELETE|POST) .*/assignees$' "$RW/gh/calls.log" | awk '{print $2}' | tr '\n' ' ')" "DELETE POST "
    # 带着 pending/agent / fable / 追加 / review 一起叫醒
    fresh_relay; set_field "$RW" 50 labels '["pending/agent","pending/agent/fable","pending/agent/05","pending/review","doing/agent"]'
    relay_case "$S" 50
    chk "成功 · 全部触发标签都摘掉" "$(labels_of "$RW" 50)" "waiting/relay"
    # 条目上已有本次的汇报评论：不按评论去重，照常叫醒
    fresh_relay; set_field "$RW" 50 comments '["## 汇报：已完成，提交 abc123"]'
    relay_case "$S" 50
    chk "成功 · 已有汇报评论照常叫醒" "$RC" 0
    # PR：经分支名关联到 #50
    fresh_relay; relay_case "$S" 60
    chk "成功 · PR 经关联 issue 判定来源：退出码 0" "$RC" 0
    chk "成功 · PR 上 pending/review 也摘掉" "$(labels_of "$RW" 60)" "waiting/relay"
    # 维护者之外的账号（允许名单里的 worker）打过 pending/human 不算接手
    fresh_relay; set_field "$RW" 50 events '[{"event":"labeled","actor":"worker-bot","label":"pending/human"},{"event":"unlabeled","actor":"worker-bot","label":"pending/human"}]'
    relay_case "$S" 50
    chk "成功 · worker 自己打过的 pending/human 不算维护者接手" "$RC" 0
    # 首次失败、重试成功
    fresh_relay; faults '[{"method":"POST","path":"/assignees$","mode":"fail","times":1}]'
    relay_case "$S" 50
    chk "重试 · 首次指派失败、重试成功：退出码 0" "$RC" 0
    chk "重试 · 最终只剩等待标签" "$(labels_of "$RW" 50)" "waiting/relay"
}
# 每一步注入失败或读回不符，重试两次都失败 → 交还维护者（退出码 3，只剩 pending/human）
fail_suite() {   # <scripts 副本>
    local S="$1" spec name
    while IFS='|' read -r name spec; do
        [ -n "$name" ] || continue
        fresh_relay; faults "$spec"
        relay_case "$S" 50
        chk "失败 · $name：退出码 3" "$RC" 3
        chk "失败 · $name：最终只有 pending/human" "$(labels_of "$RW" 50)" "pending/human"
    done <<'CASES'
加等待标签报错|[{"method":"POST","path":"/labels$","field":"waiting/relay","mode":"fail","times":2}]
加等待标签读回不在|[{"method":"POST","path":"/labels$","field":"waiting/relay","mode":"noop","times":2}]
摘触发标签读回仍在|[{"method":"DELETE","path":"/labels/pending%2Fagent$","mode":"noop","times":2}]
摘 doing/agent 读回仍在|[{"method":"DELETE","path":"/labels/doing%2Fagent$","mode":"noop","times":2}]
指派报错|[{"method":"POST","path":"/assignees$","mode":"fail","times":2}]
指派读回不在|[{"method":"POST","path":"/assignees$","mode":"noop","times":2}]
CASES
    # 已是 assignee 时「先移」那一步报错
    fresh_relay; set_field "$RW" 50 assignees '["relay-bot"]'
    faults '[{"method":"DELETE","path":"/assignees$","mode":"fail","times":2}]'
    relay_case "$S" 50
    chk "失败 · 先移 assignee 报错：退出码 3" "$RC" 3
    chk "失败 · 先移 assignee 报错：最终只有 pending/human" "$(labels_of "$RW" 50)" "pending/human"
    # 交还也失败
    fresh_relay; faults '[{"method":"POST","path":"/labels$","mode":"fail"}]'
    relay_case "$S" 50
    chk "交还失败 · 退出码 4" "$RC" 4
    chk "交还失败 · 输出里没有「已交还维护者」" "$(printf '%s' "$OUT" | grep -c '已交还维护者')" 0
    chk "交还失败 · 输出里有实际读回的标签" "$(printf '%s' "$OUT" | grep -c '实际读回的标签：doing/agent, pending/agent')" 1
}
reject_suite "$NEW"; success_suite "$NEW"; fail_suite "$NEW"

# ── 交还中途失败：等待标签都还在，daemon 不派工 ──
# 叫醒一直失败（指派读回不符），再在交还的第 1 / 2–3 / 4 步注入失败。之后跑两轮 greedy 轮询：
# 第一轮 self-heal 会碰 doing/agent 残留，第二轮才会把翻回来的触发标签派出去。
handback_suite() {   # <scripts 副本>
    local S="$1" name spec want
    while IFS='|' read -r name want spec; do
        [ -n "$name" ] || continue
        fresh_relay
        sed -i 's/^DISPATCH_MODE=.*/DISPATCH_MODE="greedy"/' "$RW/cavil-loop.config"
        set_field "$RW" 50 labels '["doing/agent"]'
        faults "$spec"
        relay_case "$S" 50
        chk "交还第 $name 步失败：退出码 4" "$RC" 4
        chk "交还第 $name 步失败：标签" "$(labels_of "$RW" 50 | tr ',' '\n' | sort | paste -sd,)" "$want"
        chk "交还第 $name 步失败：没有「已交还维护者」" "$(printf '%s' "$OUT" | grep -c '已交还维护者')" 0
        faults '[]'
        : > "$RW/gh/dispatch.log"
        tick "$S" "$RW"; tick "$S" "$RW"
        chk "交还第 $name 步失败：两轮轮询零派工" "$(dispatched "$RW" 50)" 0
    done <<'CASES'
1|waiting/relay|[{"method":"POST","path":"/assignees$","mode":"noop"},{"method":"POST","path":"/labels$","field":"pending/human","mode":"fail"}]
2–3|doing/agent,pending/human,waiting/relay|[{"method":"POST","path":"/assignees$","mode":"noop"},{"method":"DELETE","path":"/labels/doing%2Fagent$","mode":"noop"}]
4|pending/human,waiting/relay|[{"method":"POST","path":"/assignees$","mode":"noop"},{"method":"DELETE","path":"/labels/waiting%2Frelay$","mode":"noop"}]
CASES
}
handback_suite "$NEW"

echo "── 3b. 负对照 ──"
D=$(mutate add-directly scripts/notify-relay.sh \
    '    if has_login "$assignees" "$RELAY_BOT_ACCOUNT"; then' \
    '    if false; then') && neg "「先移再加」改成直接加" success_suite "$D"
D=$(mutate no-precheck scripts/notify-relay.sh \
    'in_list "$ME" "$RELAY_ALLOWED_ACTORS" || reject' \
    'true || reject') && neg "删掉账号前置检查" reject_suite "$D"
D=$(mutate no-author-check scripts/notify-relay.sh \
    '[ "$(lc "$ORIGIN_AUTHOR")" = "$(lc "$RELAY_BOT_ACCOUNT")" ] \' \
    'true \') && neg "删掉作者核对（只认标记）" reject_suite "$D"
D=$(mutate no-history-check scripts/notify-relay.sh \
    '        0) reject "#$n 曾由维护者' \
    '        0) : "#$n 曾由维护者') && neg "删掉「维护者接手过」检查" reject_suite "$D"
D=$(mutate no-readback scripts/notify-relay.sh \
    '    # 读回核对：等待标签在、要摘的一个都不在、机器人是 assignee' \
    '    return 0') && neg "删掉叫醒后的读回核对" fail_suite "$D"
D=$(mutate dedupe-comments scripts/notify-relay.sh \
    '# ── 叫醒 ──' \
    '[ "$(gh api "repos/$REPO/issues/$NUM/comments" --jq length)" = 0 ] || reject "这条已经汇报过"
# ── 叫醒 ──') && neg "加回按评论去重" success_suite "$D"
D=$(mutate relay-first scripts/notify-relay.sh \
    '    gh_write api -X POST "repos/$REPO/issues/$NUM/labels" -f "labels[]=$LABEL_PENDING_HUMAN" >/dev/null \
        || { LAST_FAIL="交还：加 $LABEL_PENDING_HUMAN 失败"; return 1; }' \
    '    gh_write api -X DELETE "repos/$REPO/issues/$NUM/labels/$(printf %s "$LABEL_PENDING_RELAY" | jq -sRr @uri)" >/dev/null 2>&1 || true
    gh_write api -X POST "repos/$REPO/issues/$NUM/labels" -f "labels[]=$LABEL_PENDING_HUMAN" >/dev/null \
        || { LAST_FAIL="交还：加 $LABEL_PENDING_HUMAN 失败"; return 1; }') && neg "把「最后摘等待标签」挪到交还第 1 步" handback_suite "$D"

# ─────────────────────────────────────────────────────────────────────────
echo "── 4. 提示词拼装（开启） ──"
# ─────────────────────────────────────────────────────────────────────────
HEAD_LINE='# 外部传话交接规则（本项目开启了外部传话机器人）'
prompt_suite() {   # <scripts 副本>
    local S="$1" W="$SANDBOX/prompt-on" kind out
    new_env "$W" on label; project_prompts "$W"
    for kind in new-issue issue-comment pr-comment review; do
        out=$(compose_out "$S" "$W" $kind)
        chk "开启 · $kind：交接规则段恰好一次" "$(printf '%s\n' "$out" | grep -cxF "$HEAD_LINE")" 1
        chk "开启 · $kind：交接规则段在最末尾（后面没有别的段）" \
            "$(printf '%s\n' "$out" | awk -v h="$HEAD_LINE" '$0==h{f=1;next} f && /^---$/{n++} END{print n+0}')" 0
        chk "开启 · $kind：占位符都替换掉了" "$(printf '%s\n' "$out" | grep -c '@@')" 0
        chk "开启 · $kind：叫醒命令带上本项目配置" "$(printf '%s\n' "$out" | grep -cF -- "--config '$W/cavil-loop.config'")" 1
    done
    out=$(compose_out "$S" "$W" new-issue)
    chk "开启 · 整份替换的模板保留了项目内容" "$(printf '%s\n' "$out" | grep -c '^项目整份替换的新 issue 模板$')" 1
    out=$(compose_out "$S" "$W" issue-comment)
    chk "开启 · 交接规则排在项目追加要求之后" \
        "$(printf '%s\n' "$out" | awk -v h="$HEAD_LINE" '/^项目追加要求/{a=NR} $0==h{b=NR} END{print (a && b > a) ? "yes" : "no"}')" yes
    chk "开启 · 默认不要求先经传话汇报" "$(printf '%s\n' "$out" | grep -c '不\*\*要求先经传话汇报')" 1
    printf 'RELAY_REPORT_FIRST="是"\n' >> "$W/cavil-loop.config"
    out=$(compose_out "$S" "$W" issue-comment)
    chk "开启 · 配了先汇报后，规则换成先经传话汇报" "$(printf '%s\n' "$out" | grep -c '要求\*\*先经传话汇报')" 1
    # 只配了一部分：不追加
    new_env "$W" off label 'LABEL_PENDING_RELAY="waiting/relay"'
    chk "只配了等待标签：不追加交接规则" "$(compose_out "$S" "$W" new-issue | grep -cxF "$HEAD_LINE")" 0
}
prompt_suite "$NEW"
# 负对照：拼装函数不追加，改成写进工具自带的四份模板 → 整份替换的那份收不到
D=$(mutate tpl-only scripts/_lib.sh \
    '        if relay_enabled; then
            printf '"'"'\n\n---\n\n'"'"'
            relay_handoff_section
        fi' \
    '        :') && {
    for f in new-issue issue-comment pr-comment review; do
        printf '\n\n---\n\n%s\n' "$(cat "$D/prompts/relay-handoff.md")" >> "$D/prompts/$f.template.md"
    done
    neg "交接规则只写进工具自带模板" prompt_suite "$D"
}

echo "── 5. 代码和配置模板里不出现具体机器人名 ──"
# 文档的接入示例一节可以点名（issue 讨论定的），代码、提示词、配置模板、测试夹具都不行
chk "scripts/ prompts/ 配置模板 setup.sh 里没有 grokbot" \
    "$(grep -rli grokbot "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$REPO_DIR/cavil-loop.config.example" "$REPO_DIR/setup.sh" 2>/dev/null | wc -l | tr -d ' ')" 0
chk "文档里只有「外部传话机器人」那一节点名" \
    "$(grep -rli grokbot "$REPO_DIR/docs" "$REPO_DIR/README.md" "$REPO_DIR/README.zh.md" "$REPO_DIR/AGENTS.md" "$REPO_DIR/AGENTS.zh.md" 2>/dev/null | sed "s|$REPO_DIR/||" | sort | paste -sd,)" "docs/collaboration.md,docs/collaboration.zh.md"

# ─────────────────────────────────────────────────────────────────────────
echo "── 汇总 ──"
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
