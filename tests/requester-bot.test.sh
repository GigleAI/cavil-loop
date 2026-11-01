#!/usr/bin/env bash
# 外部需求机器人（GitHub#95 / #97）的行为守卫。
#
# 跑法：bash tests/requester-bot.test.sh        （默认不跑负对照；webhook 超时用例每条实等 10 秒）
#       MUTATION=1 bash tests/requester-bot.test.sh   （连负对照一起跑，约 11 分钟；见 tests/lib/mutation.sh）
# 依赖：jq、python3、git、curl。不碰外网、不调真 gh：假 gh（tests/fixtures/requester-bot-fake-gh.py）是一个
# 带状态的最小 GitHub，每次调用记进 calls.log，写调用另记一行 WRITE。
#
# 覆盖：
#   1. 功能关闭时：轮询的 GitHub 调用、派工记录、四类提示词拼装结果与改动前（merge-base 上的
#      scripts/ + prompts/）逐字节一致
#   2. 等待期间：只挂等待标签 → greedy 兜底、self-heal 都不派；又打了触发标签（普通 / fable /
#      追加 / pending/review，issue 与 PR）→ 按原流程派一次，派完等待标签被摘掉
#   3. 叫醒脚本：前置检查拒绝（零写请求）、成功、失败重试、交还维护者、交还中途失败
#   3d. 叫醒 = 等待标签 + webhook（GitHub#100）：issue / PR 都不指派、不请求 review；webhook 只在
#       成功出口发、恰好一次；配置不全 / 权限过宽 / 没有 curl 不发；地址、密钥不进输出和命令行
#       （假 webhook：tests/fixtures/requester-bot-fake-webhook.py，只听 127.0.0.1）
#   3e. PR 合并 / 关闭未合并后，daemon 在机器人提的 issue 上留结果评论、加等待标签、通知 webhook
#       （真跑 agent-poll.sh）
#   3f. 配置项新旧名字：只填旧名字照样开启、新旧都填用新的、早期入口名可用、setup.sh 同一规则
#   4. 提示词：开启时四类提示词末尾恰好一段交接规则，项目整份替换模板也收得到
#   6. 说法：除复盘记录外不再出现「传话」，文档锚点对得上
# 每组都配负对照：把被测脚本复制一份、改坏一处，同一组断言必须变红。负对照只在 MUTATION=1 时跑；
# 默认回归靠每组里「确实走到了」的断言（派工数 > 0、写请求确实发了、webhook 恰好 1 次…）防空转。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"
if [ -n "${REQUESTER_BOT_TEST_BAD_MUT:-}" ] && ! mutation_on; then
    echo "REQUESTER_BOT_TEST_BAD_MUT 验证的是负对照的准备失败记账，要和 MUTATION=1 一起设" >&2; exit 2
fi
FAKE="$TEST_DIR/fixtures/requester-bot-fake-gh.py"

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
# 负对照的准备（复制一份、改坏一处）都跑在 `D=$(mutate …)` 的命令替换子 shell 里：在那里
# 加 fail 传不回主进程，输出也被收进变量。所以准备失败一律记进这个文件（并打到 stderr），
# 汇总时计入失败——找不到要改的原文必须让整套测试变红，不能悄悄少跑一项。
PREP_FAILED="$SANDBOX/prep-failed"; : > "$PREP_FAILED"
prep_failed() {   # <负对照名> <原因>
    printf '%s（%s）\n' "$1" "$2" >> "$PREP_FAILED"
    echo "  ❌ 负对照 $1 没改上（$2）" >&2
}
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
# $1 = 目录，$2 = on/off（外部需求机器人功能），$3 = label/greedy，其余 KEY=VAL 追加进配置
new_env() {
    local W="$1" bot="$2" mode="$3"; shift 3
    rm -rf "$W/state" "$W/gh" "$W/wt"; mkdir -p "$W/state" "$W/gh" "$W/wt" "$W/project"
    cat > "$W/cavil-loop.config" <<CONF
REPO="example/requester-bot"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="rbtest$$"
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
# 上面那行关不掉「GH_TOKEN 必须有值」：_lib.sh 用 \${WORKER_SECRET_ENV:-GH_TOKEN}，空串也回落到
# GH_TOKEN。不给值时真派工脚本一开头就拒绝派工，测试只在本来带着 GH_TOKEN 的
# daemon / worker 环境里是绿的。gh 是假的，这个值不会被拿去用。
GH_TOKEN="fake-token-for-test"
PATH="$SANDBOX/bin:\$PATH"
CONF
    if [ "$bot" = on ]; then
        cat >> "$W/cavil-loop.config" <<'CONF'
LABEL_PENDING_REQUESTER_BOT="waiting/bot"
REQUESTER_BOT_ACCOUNT="req-bot"
REQUESTER_BOT_ALLOWED_ACTORS="worker-bot, reviewer-bot"
REQUESTER_BOT_ORIGIN_MARKER="<!-- bot-origin -->"
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
    add_item "$W" 9 issue "waiting/bot"
    add_item "$W" 20 pr "pending/agent"
    add_item "$W" 21 pr "pending/review"
    add_item "$W" 22 pr "doing/agent"
    add_item "$W" 23 pr "waiting/bot"
    # 分支不带编号、正文跨行写 Closes：会话编号 / 列表都会读正文，关闭时必须和改动前一样
    add_item "$W" 24 pr "doing/agent" someone $'Closes\n#9' chore/x
    add_item "$W" 25 pr "pending/agent" someone $'Fixes\r\n#8' chore/y
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
# 改动前的拼装代码（merge-base 的 scripts/）配本版的 prompts/：守的是「功能关闭时拼装不往模板里加东西」。
# 不拿 merge-base 的 prompts/ 来比——那样后来任何一个改模板文字的 PR（GitHub#102 起）都会在这里
# 变红，而它们和外部需求机器人无关。
OLD_P="$SANDBOX/old-scripts-new-prompts"; make_copy "$SANDBOX/old-src" "$OLD_P"
rm -rf "$OLD_P/prompts"; cp -r "$REPO_DIR/prompts" "$OLD_P/prompts"
for kind in new-issue issue-comment pr-comment review; do
    # 先后拼、各存一份再比（两边共用一个状态目录，拼装结果写在同一个固定文件里，不能同时拼）
    compose_out "$OLD_P" "$W" $kind > "$SANDBOX/off-old-$kind.md"
    compose_out "$NEW" "$W" $kind > "$SANDBOX/off-new-$kind.md"
    chk "关闭 · 提示词 $kind 和改动前的拼装逐字节一致" \
        "$(cmp -s "$SANDBOX/off-old-$kind.md" "$SANDBOX/off-new-$kind.md" && [ -s "$SANDBOX/off-new-$kind.md" ] && echo same || echo diff)" same
done

# ─────────────────────────────────────────────────────────────────────────
echo "── 2. 等待期间的派工 ──"
# ─────────────────────────────────────────────────────────────────────────
seed_wait() {
    local W="$1"
    # 只挂等待标签（含 greedy 会收的「什么触发标签都没有」）
    add_item "$W" 11 issue "waiting/bot"
    add_item "$W" 12 pr    "waiting/bot"
    # 等待标签 + 各种触发标签
    add_item "$W" 21 issue "waiting/bot,pending/agent"
    add_item "$W" 22 issue "waiting/bot,pending/agent/fable"
    add_item "$W" 23 issue "waiting/bot,pending/agent/05"
    add_item "$W" 24 issue "waiting/bot,pending/review"
    add_item "$W" 31 pr    "waiting/bot,pending/agent"
    add_item "$W" 32 pr    "waiting/bot,pending/agent/fable"
    add_item "$W" 33 pr    "waiting/bot,pending/agent/05"
    add_item "$W" 34 pr    "waiting/bot,pending/review"
    # self-heal：doing/agent 但没有 session
    add_item "$W" 41 issue "doing/agent,waiting/bot"
    add_item "$W" 42 issue "doing/agent"
    # 对照：普通的待派条目
    add_item "$W" 51 issue ""
    # GitHub#102 复审：PR 在等机器人认可，机器人却把答复贴到来源 issue、在 issue 上打了触发标签。
    # daemon 按条目自己的标签派工——派出去的是 issue，PR 仍停在等待（对接文档因此要求「在等待的那个条目上回」）。
    # 对照是 #31：答复贴在等待中的 PR 上、给 PR 打触发标签 → PR 续上
    add_item "$W" 61 issue "pending/agent"
    add_item "$W" 62 pr    "waiting/bot" someone "" feature/issue-61
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
    chk "$mode · 答复贴在来源 issue 上：派出去的是 issue" "$(dispatch_line "$W" 61 | awk '{print $1}' | sed -E 's/^dispatch-(new-issue|issue-comment)$/issue/')" "issue"
    chk "$mode · 答复贴在来源 issue 上：等待中的 PR 不派、仍挂等待标签" "$(dispatched "$W" 62) $(labels_of "$W" 62)" "0 waiting/bot"
    chk "$mode · 答复贴在等待中的 PR 上：派出去的是 PR" "$(dispatch_line "$W" 31 | awk '{print $1}')" "dispatch-pr-comment"
    chk "$mode · self-heal 不碰等待中的条目" "$(labels_of "$W" 41)" "doing/agent,waiting/bot"
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
    mutation_on || return 0      # 关着：不复制、不改，后面的 neg 只计数（见 tests/lib/mutation.sh）
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
neg() {   # <说明> <要跑的 suite 函数及参数…>：跑一遍，失败条数必须 > 0
    mutation_gate || return 0
    local desc="$1"; shift
    local before=$fail
    QUIET=1; [ -z "${SHOW_NEG:-}" ] || QUIET=0; "$@"; QUIET=0
    local got=$((fail - before))
    fail=$before
    chk "负对照：$desc → 变红（$got 条失败）" "$([ "$got" -gt 0 ] && echo red || echo green)" red
}

# 自检：准备失败必须被记下（否则下面每一个负对照都可能悄悄没跑）。
# REQUESTER_BOT_TEST_BAD_MUT=1 时保留这条记录，用来验证整套测试确实会因此非零退出。
if mutation_on; then
    D=$(mutate selftest-missing scripts/_lib.sh '这段原文不存在 #97' 'x' 2>/dev/null) && true
    chk "自检 · 负对照准备失败会记进失败（不被命令替换吞掉）" "$(grep -c '^selftest-missing（' "$PREP_FAILED")" 1
    [ -n "${REQUESTER_BOT_TEST_BAD_MUT:-}" ] || sed -i '/^selftest-missing（/d' "$PREP_FAILED"
fi

echo "── 2b. 负对照 ──"
D=$(mutate skip-in-label-pass scripts/agent-poll.sh \
    '        if labels_have_requester_bot_wait "$labels_csv"; then
            log "${kind} #${num} 挂着外部需求机器人等待标签' \
    '        if labels_have_requester_bot_wait "$labels_csv"; then continue; fi
        if labels_have_requester_bot_wait "$labels_csv"; then
            log "${kind} #${num} 挂着外部需求机器人等待标签') && neg "按触发标签收活那一趟改回「挂着等待标签就跳过」" wait_suite "$D" label
D=$(mutate no-greedy-skip scripts/_lib.sh \
    '        "${LABEL_PENDING_REVIEW:-}" \
        "${LABEL_PENDING_REQUESTER_BOT:-}"' \
    '        "${LABEL_PENDING_REVIEW:-}"') && neg "greedy 挡工清单去掉等待标签" wait_suite "$D" greedy
D=$(mutate no-dispatch-clear scripts/_lib.sh \
    '[ -z "$LABEL_PENDING_REQUESTER_BOT" ] || REQUESTER_BOT_DISPATCH_CLEAR=("$LABEL_PENDING_REQUESTER_BOT")' \
    ':') && neg "派工时不摘等待标签" wait_suite "$D" label
D=$(mutate no-selfheal-skip scripts/agent-poll.sh \
    '    if labels_have_requester_bot_wait "$labels_csv"; then
        SELFHEAL_REQUESTER_BOT+=' \
    '    if false; then
        SELFHEAL_REQUESTER_BOT+=') && neg "self-heal 不看等待标签" wait_suite "$D" label

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
    add_item "$W" $N_CMT issue "waiting/bot,pending/agent"
    add_item "$W" $N_PR  pr    "waiting/bot,pending/agent" someone "" "feature/issue-$N_PR"
    add_item "$W" $N_NEW issue "waiting/bot,pending/agent"
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
    mutation_on || return 0
    local Dm="$SANDBOX/real-mut-$1"
    rm -rf "$Dm"; cp -r "$REAL_NEW" "$Dm"
    python3 - "$Dm/scripts/$2" "$3" <<'PYM' || { prep_failed "$1" "原文找不到"; return 1; }
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
MARK='<!-- bot-origin -->'
RW="$SANDBOX/bot"
bot_case() {   # <scripts 副本> <N>：跑叫醒脚本，退出码进 RC，输出进 OUT
    RC=0
    OUT=$(env FAKE_GH_DIR="$RW/gh" bash "$1/scripts/${NOTIFY_ENTRY:-notify-requester-bot.sh}" --config "$RW/cavil-loop.config" "$2" 2>&1) || RC=$?
}
writes() { grep -c '^WRITE ' "$RW/gh/calls.log" 2>/dev/null || true; }
fresh_bot() {   # 一条标准的「机器人提的需求」#50 + 关联它的 PR #60
    new_env "$RW" on label
    add_item "$RW" 50 issue "doing/agent,pending/agent" req-bot "需求正文
$MARK"
    add_item "$RW" 60 pr "doing/agent,pending/review" worker-bot "实现 #50" feature/issue-50
    add_item "$RW" 61 pr "doing/agent" worker-bot "无关 PR" chore/x
    printf '[]' > "$RW/gh/faults.json"
}
faults() { printf '%s' "$1" > "$RW/gh/faults.json"; }
reject_suite() {   # <scripts 副本>
    local S="$1"
    fresh_bot; set_me "$RW" outsider; : > "$RW/gh/calls.log"
    bot_case "$S" 50; chk "拒绝 · 账号不在名单：退出码 2" "$RC" 2; chk "拒绝 · 账号不在名单：零写请求" "$(writes)" 0
    fresh_bot; add_item "$RW" 50 issue "doing/agent" someone "$MARK"; : > "$RW/gh/calls.log"
    bot_case "$S" 50; chk "拒绝 · 正文有标记但作者不是机器人：退出码 2" "$RC" 2; chk "拒绝 · 作者不是机器人：零写请求" "$(writes)" 0
    fresh_bot; add_item "$RW" 50 issue "doing/agent" req-bot "没有标记"; : > "$RW/gh/calls.log"
    bot_case "$S" 50; chk "拒绝 · 没有需求标记：退出码 2" "$RC" 2; chk "拒绝 · 没有需求标记：零写请求" "$(writes)" 0
    fresh_bot; set_field "$RW" 50 labels '["pending/human"]'; : > "$RW/gh/calls.log"
    bot_case "$S" 50; chk "拒绝 · 挂着 pending/human：退出码 2" "$RC" 2; chk "拒绝 · 挂着 pending/human：零写请求" "$(writes)" 0
    fresh_bot; set_field "$RW" 60 labels '["pending/review","pending/human"]'; : > "$RW/gh/calls.log"
    bot_case "$S" 60; chk "拒绝 · 复审轮次用尽双标签：退出码 2" "$RC" 2
    chk "拒绝 · 复审轮次用尽：两个标签都保留" "$(labels_of "$RW" 60)" "pending/review,pending/human"
    chk "拒绝 · 复审轮次用尽：零写请求" "$(writes)" 0
    fresh_bot; set_field "$RW" 50 events '[{"event":"labeled","actor":"maintainer","label":"pending/human"},{"event":"unlabeled","actor":"maintainer","label":"pending/human"}]'
    : > "$RW/gh/calls.log"
    bot_case "$S" 50; chk "拒绝 · 维护者曾手打 pending/human：退出码 2" "$RC" 2; chk "拒绝 · 维护者手打过：零写请求" "$(writes)" 0
    fresh_bot; set_field "$RW" 50 events '[{"event":"labeled","actor":"maintainer","label":"pending/human"}]'; : > "$RW/gh/calls.log"
    bot_case "$S" 60; chk "拒绝 · PR 关联的 issue 被维护者接手过：退出码 2" "$RC" 2
    fresh_bot; faults '[{"method":"GET","path":"/events$","mode":"fail"}]'; : > "$RW/gh/calls.log"
    bot_case "$S" 50; chk "拒绝 · 读不到标签历史 → 当作不知道：退出码 2" "$RC" 2; chk "拒绝 · 读不到标签历史：零写请求" "$(writes)" 0
    fresh_bot; : > "$RW/gh/calls.log"
    bot_case "$S" 61; chk "拒绝 · PR 关联不到机器人的 issue：退出码 2" "$RC" 2
    # 机器人自己开的 PR、正文只有标记、没关联任何 issue：不能拿 PR 自己当来源
    fresh_bot; add_item "$RW" 62 pr "doing/agent" req-bot "只有标记 $MARK" chore/y; : > "$RW/gh/calls.log"
    bot_case "$S" 62; chk "拒绝 · 机器人开的无关联 PR：退出码 2" "$RC" 2; chk "拒绝 · 机器人开的无关联 PR：零写请求" "$(writes)" 0
    # 关联编号指向另一个 PR（那个 PR 也是机器人开的、带标记）
    fresh_bot; add_item "$RW" 63 pr "" req-bot "$MARK" chore/z
    add_item "$RW" 64 pr "doing/agent" worker-bot "实现" feature/issue-63; : > "$RW/gh/calls.log"
    bot_case "$S" 64; chk "拒绝 · 关联编号指向 PR：退出码 2" "$RC" 2; chk "拒绝 · 关联编号指向 PR：零写请求" "$(writes)" 0
    # 别人另开的 PR：分支名不带编号，正文写 Closes #50 → 照样认出 #50（作对照）
    fresh_bot; add_item "$RW" 65 pr "doing/agent" worker-bot "这份改动解决 Closes #50" chore/v
    bot_case "$S" 65; chk "对照 · 正文 Closes #50 的另开 PR：认出 #50，退出码 0" "$RC" 0
    # 关键词和编号分在两行：daemon 两种找法结论不同 → 认不准，拒绝、零写请求
    fresh_bot; add_item "$RW" 66 pr "doing/agent" worker-bot "Closes
#50" chore/u; : > "$RW/gh/calls.log"
    bot_case "$S" 66; chk "拒绝 · 跨行写的 Closes（两种找法不一致）：退出码 2" "$RC" 2; chk "拒绝 · 跨行写的 Closes：零写请求" "$(writes)" 0
}
success_suite() {   # <scripts 副本>
    local S="$1"
    fresh_bot
    bot_case "$S" 50
    chk "成功 · 普通叫醒：退出码 0" "$RC" 0
    chk "成功 · 只剩等待标签（触发标签、doing/agent 都摘了）" "$(labels_of "$RW" 50)" "waiting/bot"
    # 带着 pending/agent / fable / 追加 / review 一起叫醒
    fresh_bot; set_field "$RW" 50 labels '["pending/agent","pending/agent/fable","pending/agent/05","pending/review","doing/agent"]'
    bot_case "$S" 50
    chk "成功 · 全部触发标签都摘掉" "$(labels_of "$RW" 50)" "waiting/bot"
    # 条目上已有本次的汇报评论：不按评论去重，照常叫醒
    fresh_bot; set_field "$RW" 50 comments '["## 汇报：已完成，提交 abc123"]'
    bot_case "$S" 50
    chk "成功 · 已有汇报评论照常叫醒" "$RC" 0
    # PR：经分支名关联到 #50
    fresh_bot; bot_case "$S" 60
    chk "成功 · PR 经关联 issue 判定来源：退出码 0" "$RC" 0
    chk "成功 · PR 上 pending/review 也摘掉" "$(labels_of "$RW" 60)" "waiting/bot"
    # 维护者之外的账号（允许名单里的 worker）打过 pending/human 不算接手
    fresh_bot; set_field "$RW" 50 events '[{"event":"labeled","actor":"worker-bot","label":"pending/human"},{"event":"unlabeled","actor":"worker-bot","label":"pending/human"}]'
    bot_case "$S" 50
    chk "成功 · worker 自己打过的 pending/human 不算维护者接手" "$RC" 0
    # 首次失败、重试成功
    fresh_bot; faults '[{"method":"POST","path":"/labels$","field":"waiting/bot","mode":"fail","times":1}]'
    bot_case "$S" 50
    chk "重试 · 首次加等待标签失败、重试成功：退出码 0" "$RC" 0
    chk "重试 · 最终只剩等待标签" "$(labels_of "$RW" 50)" "waiting/bot"
}
# 每一步注入失败或读回不符，重试两次都失败 → 交还维护者（退出码 3，只剩 pending/human）
fail_suite() {   # <scripts 副本>
    local S="$1" spec name
    while IFS='|' read -r name spec; do
        [ -n "$name" ] || continue
        fresh_bot; faults "$spec"
        bot_case "$S" 50
        chk "失败 · $name：退出码 3" "$RC" 3
        chk "失败 · $name：最终只有 pending/human" "$(labels_of "$RW" 50)" "pending/human"
    done <<'CASES'
加等待标签报错|[{"method":"POST","path":"/labels$","field":"waiting/bot","mode":"fail","times":2}]
加等待标签读回不在|[{"method":"POST","path":"/labels$","field":"waiting/bot","mode":"noop","times":2}]
摘触发标签读回仍在|[{"method":"DELETE","path":"/labels/pending%2Fagent$","mode":"noop","times":2}]
摘 doing/agent 读回仍在|[{"method":"DELETE","path":"/labels/doing%2Fagent$","mode":"noop","times":2}]
CASES
    # 摘标签返回成功但没生效：必须检出，不能报「已叫醒」
    fresh_bot; faults '[{"method":"DELETE","path":"/labels/doing%2Fagent$","mode":"noop","times":2}]'
    bot_case "$S" 50
    chk "失败 · 摘 doing/agent 没生效：输出说明原因" "$(printf '%s' "$OUT" | grep -q '读回仍有 doing/agent' && echo yes || echo no)" yes
    # PR 上同样：摘 pending/review 没生效 → 交还
    fresh_bot; faults '[{"method":"DELETE","path":"/labels/pending%2Freview$","mode":"noop","times":2}]'
    bot_case "$S" 60
    chk "失败 · PR 摘 pending/review 没生效：退出码 3" "$RC" 3
    chk "失败 · PR 摘 pending/review 没生效：最终只有 pending/human" "$(labels_of "$RW" 60)" "pending/human"
    # 交还也失败
    fresh_bot; faults '[{"method":"POST","path":"/labels$","mode":"fail"}]'
    bot_case "$S" 50
    chk "交还失败 · 退出码 4" "$RC" 4
    chk "交还失败 · 输出里没有「已交还维护者」" "$(printf '%s' "$OUT" | grep -c '已交还维护者')" 0
    chk "交还失败 · 输出里有实际读回的标签" "$(printf '%s' "$OUT" | grep -c '实际读回的标签：doing/agent, pending/agent')" 1
}
reject_suite "$NEW"; success_suite "$NEW"; fail_suite "$NEW"

# ── 交还中途失败：等待标签都还在，daemon 不派工 ──
# 叫醒一直失败（摘 doing/agent 读回仍在），再在交还的第 1 / 2–3 / 4 步注入失败。之后跑两轮 greedy 轮询：
# 第一轮 self-heal 会碰 doing/agent 残留，第二轮才会把翻回来的触发标签派出去。
handback_suite() {   # <scripts 副本>
    local S="$1" name spec want
    while IFS='|' read -r name want spec; do
        [ -n "$name" ] || continue
        fresh_bot
        sed -i 's/^DISPATCH_MODE=.*/DISPATCH_MODE="greedy"/' "$RW/cavil-loop.config"
        set_field "$RW" 50 labels '["doing/agent"]'
        faults "$spec"
        bot_case "$S" 50
        chk "交还第 $name 步失败：退出码 4" "$RC" 4
        chk "交还第 $name 步失败：标签" "$(labels_of "$RW" 50 | tr ',' '\n' | sort | paste -sd,)" "$want"
        chk "交还第 $name 步失败：没有「已交还维护者」" "$(printf '%s' "$OUT" | grep -c '已交还维护者')" 0
        faults '[]'
        : > "$RW/gh/dispatch.log"
        add_item "$RW" 51 issue ""     # 对照：普通条目，greedy 会兜底派它
        tick "$S" "$RW"; tick "$S" "$RW"
        chk "交还第 $name 步失败：两轮轮询零派工" "$(dispatched "$RW" 50)" 0
        # 到达性：上一条「零派工」在轮询一开头就退出时也成立
        chk "交还第 $name 步失败：到达性 · 同一轮询照常派了普通条目" "$(dispatched "$RW" 51)" 1
    done <<'CASES'
1|doing/agent,waiting/bot|[{"method":"DELETE","path":"/labels/doing%2Fagent$","mode":"noop","times":2},{"method":"POST","path":"/labels$","field":"pending/human","mode":"fail"}]
2–3|doing/agent,pending/human,waiting/bot|[{"method":"DELETE","path":"/labels/doing%2Fagent$","mode":"noop"}]
4|pending/human,waiting/bot|[{"method":"DELETE","path":"/labels/doing%2Fagent$","mode":"noop","times":2},{"method":"DELETE","path":"/labels/waiting%2Fbot$","mode":"noop"}]
CASES
}
handback_suite "$NEW"

echo "── 3b. 负对照 ──"
D=$(mutate no-precheck scripts/notify-requester-bot.sh \
    'requester_bot_check_actor || reject "$REQUESTER_BOT_REASON"' \
    'requester_bot_check_actor || true') && neg "删掉账号前置检查" reject_suite "$D"
D=$(mutate no-author-check scripts/_lib.sh \
    '    if [ "$(requester_bot_lc "$author")" != "$(requester_bot_lc "$REQUESTER_BOT_ACCOUNT")" ]; then' \
    '    if false; then') && neg "删掉作者核对（只认标记）" reject_suite "$D"
D=$(mutate no-history-check scripts/notify-requester-bot.sh \
    '        0) reject "#$n 曾由维护者' \
    '        0) : "#$n 曾由维护者') && neg "删掉「维护者接手过」检查" reject_suite "$D"
D=$(mutate no-pr-origin-check scripts/_lib.sh \
    '            REQUESTER_BOT_REASON="PR #$num 关联的 #$origin 是 PR，不是 issue"
            return 1' \
    '            :') && neg "不核对关联编号是不是 issue" reject_suite "$D"
D=$(MUT_BASE="$D" mutate fallback-origin scripts/_lib.sh \
    '        origin=$(branch_to_issue_num "$branch")' \
    '        origin=$(pr_to_issue_num "$num" "$branch"); [ "$origin" != "$num" ] || origin=""') \
    && neg "来源改用会话命名的编号（会读正文；叠加不核对 issue）" reject_suite "$D"
D=$(mutate no-readback scripts/notify-requester-bot.sh \
    '    # 读回核对：等待标签在、要摘的一个都不在' \
    '    return 0') && neg "删掉叫醒后的读回核对" fail_suite "$D"
D=$(mutate dedupe-comments scripts/notify-requester-bot.sh \
    '# ── 叫醒 ──' \
    '[ "$(gh api "repos/$REPO/issues/$NUM/comments" --jq length)" = 0 ] || reject "这条已经汇报过"
# ── 叫醒 ──') && neg "加回按评论去重" success_suite "$D"
D=$(mutate wait-label-first scripts/notify-requester-bot.sh \
    '    gh_write api -X POST "repos/$REPO/issues/$NUM/labels" -f "labels[]=$LABEL_PENDING_HUMAN" >/dev/null \
        || { LAST_FAIL="交还：加 $LABEL_PENDING_HUMAN 失败"; return 1; }' \
    '    gh_write api -X DELETE "repos/$REPO/issues/$NUM/labels/$(printf %s "$LABEL_PENDING_REQUESTER_BOT" | jq -sRr @uri)" >/dev/null 2>&1 || true
    gh_write api -X POST "repos/$REPO/issues/$NUM/labels" -f "labels[]=$LABEL_PENDING_HUMAN" >/dev/null \
        || { LAST_FAIL="交还：加 $LABEL_PENDING_HUMAN 失败"; return 1; }') && neg "把「最后摘等待标签」挪到交还第 1 步" handback_suite "$D"

echo "── 3c. 从 PR 正文找关联 issue：关闭 / 开启都和改动前逐字节一致 ──"
# 这条规则 daemon 里本来就有两份（会话命名用 grep 逐行找、活跃 worker 列表用 jq 整段找），
# 两份对跨行写法判断不同（main 上就如此）。本 PR 不改它们的行为：功能关闭 / 开启两种配置下，
# 同一批正文跑改动前（merge-base）和本版的会话命名与活跃 worker 列表，结果必须逐条相同；
# 再起真的 PR 派工，确认选中的会话也相同。叫醒脚本两种都跑、一致才认（下面单独核对）。
# 正文用 \n \r \t 转义写（python 解码），制表符、CRLF 是真的控制字符。
LINK_CASES='1|Closes #50
2|fixes #51 and refs #52
3|Resolves #53
4|REFS #54
5|relates to #56
6|Closes#57
7|see notes\nFixed   #58
8|
9|Closes\n#61
10|Closes\r\n#62
11|Closes\t#63
12|intro\ncLoSeS #64\n
13|Fixes\n\n  #65
14|Closes # 66
15|line one\r\nRefs #68\r\n
16|Closes\n#70, then Fixes #71'
link_numbers() {   # <scripts 副本> <W>：每条正文一行「PR 会话编号 列表里的编号」
    local S="$1" W="$2"
    env FAKE_GH_DIR="$W/gh" CODING_AGENT_CONFIG="$W/cavil-loop.config" TICK_DIR="$W/tick" bash -c '
        source "$1/scripts/_lib.sh" 2>/dev/null
        listing=$(list_active_workers all)
        for pr in $(jq -r ".items|keys[]" "$FAKE_GH_DIR/state.json" | sort -n); do
            name=$(pr_to_issue_num "$pr" "chore/b$pr")
            lst=$(printf "%s\n" "$listing" | grep -oE "^(issue #[0-9]+ \(PR #$pr\)|PR #$pr )" | head -1)
            printf "%s %s [%s]\n" "$pr" "$name" "$lst"
        done' _ "$S"
}
link_env() {   # <W> <on|off>
    new_env "$1" "$2" label
    python3 - "$1/gh/state.json" "$LINK_CASES" <<'PYL'
import json, re, sys
p, cases = sys.argv[1], sys.argv[2]
st = json.load(open(p))
for m in re.finditer(r'^(\d+)\|(.*)$', cases, re.M):
    n = 300 + int(m.group(1))
    st["items"][str(n)] = {"number": n, "title": f"pr {n}", "user": "worker-bot",
                           "body": m.group(2).encode().decode("unicode_escape"),
                           "state": "open", "is_pr": True, "head_ref": f"chore/b{n}",
                           "labels": ["doing/agent"], "assignees": [], "events": []}
json.dump(st, open(p, "w"))
PYL
}
link_suite() {   # <scripts 副本>
    local S="$1" mode
    for mode in off on; do
        link_env "$SANDBOX/link-old" $mode; link_env "$SANDBOX/link-new" $mode
        link_numbers "$OLD" "$SANDBOX/link-old" > "$SANDBOX/link-old.txt"
        link_numbers "$S" "$SANDBOX/link-new" > "$SANDBOX/link-new.txt"
        chk "正文关联 · 功能$mode：16 条正文的会话编号和列表编号与改动前逐条相同" \
            "$(cmp -s "$SANDBOX/link-old.txt" "$SANDBOX/link-new.txt" && echo same || { diff "$SANDBOX/link-old.txt" "$SANDBOX/link-new.txt" | grep -c '^>'; })" same
        chk "正文关联 · 功能$mode：对拍不是两边都空" "$(wc -l < "$SANDBOX/link-new.txt" | tr -d ' ')" 16
    done
}
# 叫醒脚本认定的来源：只在会话命名和活跃 worker 列表两边都指向同一个 issue 时才认，
# 否则拒绝。逐条正文核对这个性质（功能开启；关联的 issue 不存在，脚本会在读它时报出编号）。
bot_link_suite() {   # <scripts 副本>
    local S="$1" W="$SANDBOX/link-bot" pr name lst want got
    link_env "$W" on
    link_numbers "$S" "$W" > "$W/numbers.txt"
    while read -r pr name lst; do
        lst=$(printf '%s' "$lst" | grep -oE '^\[issue #[0-9]+' | grep -oE '[0-9]+'); [ -n "$lst" ] || lst=$pr
        if [ "$name" = "$lst" ] && [ "$name" != "$pr" ]; then want=$name; else want=-; fi
        RW_SAVE="$RW"; RW="$W"; bot_case "$S" "$pr"; RW="$RW_SAVE"
        got=$(printf '%s' "$OUT" | grep -oE '读不到关联的 issue #[0-9]+' | grep -oE '[0-9]+$' | head -1)
        [ -n "$got" ] || { [ "$RC" = 2 ] && got=-; }
        chk "正文关联 · PR #$pr：叫醒脚本的来源（会话命名 $name / 列表 $lst）" "${got:-?}" "$want"
    done < "$W/numbers.txt"
}
link_suite "$NEW"
bot_link_suite "$NEW"
D=$(mutate bot-whole-only scripts/_lib.sh \
    '            if [ "$by_line" != "$by_whole" ]; then' \
    '            by_line="$by_whole"; if [ "$by_line" != "$by_whole" ]; then') && neg "叫醒脚本只用整段找（跨行时和会话命名对不上）" bot_link_suite "$D"
D=$(mutate bot-line-only scripts/_lib.sh \
    '            if [ "$by_line" != "$by_whole" ]; then' \
    '            by_whole="$by_line"; if [ "$by_line" != "$by_whole" ]; then') && neg "叫醒脚本只用逐行找（跨行时和列表对不上）" bot_link_suite "$D"
D=$(mutate bot-no-body scripts/_lib.sh \
    '            origin="$by_line"' \
    '            origin=""') && neg "叫醒脚本不认正文关联（另开的 PR 叫不醒）" reject_suite "$D"
D=$(mutate link-wholebody scripts/_lib.sh \
    "    grep -oiE '(close[sd]?|fix(es|ed)?|resolve[sd]?|refs?)[[:space:]]+#[0-9]+' \\
        | head -1 \\
        | grep -oE '[0-9]+' || true" \
    "    jq -Rr --slurp --arg re \"\$PR_BODY_LINK_JQ_RE\" 'try capture(\$re).n catch \"\"' || true") \
    && neg "会话命名改成整段匹配（上一版的做法）" link_suite "$D"
D=$(mutate link-jq scripts/_lib.sh \
    'try capture($re).n catch "") // "")]' \
    'try capture("(?i)(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?|refs?)[ ]+#(?<n>[0-9]+)").n catch "") // "")]') && neg "活跃 worker 列表改成只认空格" link_suite "$D"

# 真的 PR 派工：功能关闭，分支不带编号、正文跨行写 Closes —— 选中的工作区与改动前相同
pr_dispatch_ws() {   # <scripts 目录> → 派工后建出来的工作区目录名
    local SD="$1" W="$DX/ws" N=987961
    rm -rf "$W"; mkdir -p "$W"
    new_env "$W" off label "PATH=\"$DX/bin:$SANDBOX/bin:\$PATH\"" 'WORKER_SECRET_ENV=""'
    git clone -q "$DX/up.git" "$W/project" 2>/dev/null
    add_item "$W" $N pr "pending/agent" someone "Closes
#50" "chore/ws"
    (cd "$W/project" && env HOME="$DX/home" FAKE_GH_DIR="$W/gh" CODING_AGENT_CONFIG="$W/cavil-loop.config" \
        timeout 120 bash "$SD/dispatch-pr-comment.sh" $N chore/ws 0) >/dev/null 2>&1
    rm -f /tmp/cavil-loop-pr-$N-*
    # 假 tmux 一律报「会话在」，派工走「注入现有会话」那条路：选中的会话名就是工作编号的落点
    grep -oE "PR #$N -> [^ ]* ?[A-Za-z0-9_.-]+-issue[0-9]+" "$W/state/poll.log" | grep -oE '[A-Za-z0-9_.-]+-issue[0-9]+$' | head -1
}
REAL_OLD="$SANDBOX/real-old"; rm -rf "$REAL_OLD"; mkdir -p "$REAL_OLD"; cp -r "$SANDBOX/old-src/scripts" "$SANDBOX/old-src/prompts" "$REAL_OLD/"
WS_OLD=$(pr_dispatch_ws "$REAL_OLD/scripts"); WS_NEW=$(pr_dispatch_ws "$REAL_NEW/scripts")
chk "真 PR 派工 · 功能关闭：跨行 Closes 时选中的会话与改动前相同（$WS_OLD）" "$WS_NEW" "$WS_OLD"
chk "真 PR 派工 · 对拍不是两边都空" "$([ -n "$WS_OLD" ] && echo yes || echo no)" yes

# ─────────────────────────────────────────────────────────────────────────
echo "── 4. 提示词拼装（开启） ──"
# ─────────────────────────────────────────────────────────────────────────
HEAD_LINE='# 外部需求机器人交接规则（本项目开启了外部需求机器人）'
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
    chk "开启 · 默认不要求先向机器人汇报" "$(printf '%s\n' "$out" | grep -c '不\*\*要求先向机器人汇报')" 1
    printf 'REQUESTER_BOT_REPORT_FIRST="是"\n' >> "$W/cavil-loop.config"
    out=$(compose_out "$S" "$W" issue-comment)
    chk "开启 · 配了先汇报后，规则换成先向机器人汇报" "$(printf '%s\n' "$out" | grep -c '要求\*\*先向机器人汇报')" 1
    # 只配了一部分：不追加
    new_env "$W" off label 'LABEL_PENDING_REQUESTER_BOT="waiting/bot"'
    chk "只配了等待标签：不追加交接规则" "$(compose_out "$S" "$W" new-issue | grep -cxF "$HEAD_LINE")" 0
}
prompt_suite "$NEW"
# 负对照：拼装函数不追加，改成写进工具自带的四份模板 → 整份替换的那份收不到
D=$(mutate tpl-only scripts/_lib.sh \
    '        if requester_bot_enabled; then
            printf '"'"'\n\n---\n\n'"'"'
            requester_bot_handoff_section
        fi' \
    '        :') && {
    if mutation_on; then
        for f in new-issue issue-comment pr-comment review; do
            printf '\n\n---\n\n%s\n' "$(cat "$D/prompts/requester-bot-handoff.md")" >> "$D/prompts/$f.template.md"
        done
    fi
    neg "交接规则只写进工具自带模板" prompt_suite "$D"
}

# ─────────────────────────────────────────────────────────────────────────
echo "── 3d. 叫醒 = 等待标签 + webhook（GitHub#100） ──"
# ─────────────────────────────────────────────────────────────────────────
# 假 webhook 只听 127.0.0.1、随机端口；地址里的路径段和密钥都是本次测试现编的哨兵串，
# 测试结束后在全部输出、日志、命令行采样里搜它们。每条用例开头清空请求记录。
HOOK="$SANDBOX/hook"; mkdir -p "$HOOK"; echo 200 > "$HOOK/mode"
python3 -I "$TEST_DIR/fixtures/requester-bot-fake-webhook.py" "$HOOK" >/dev/null 2>&1 &
HOOK_PID=$!
for _ in $(seq 50); do [ -s "$HOOK/port" ] && break; sleep 0.1; done
HOOK_PORT=$(cat "$HOOK/port" 2>/dev/null)
trap 'kill $HOOK_PID 2>/dev/null; cleanup' EXIT
HOOK_SECRET_PATH="hk-path-$$-$RANDOM$RANDOM"
HOOK_URL="http://127.0.0.1:$HOOK_PORT/$HOOK_SECRET_PATH"
HOOK_KEY_SENTINEL="key-$$-$RANDOM$RANDOM"
HOOK_KEY="Bearer q\"uo\\te-$HOOK_KEY_SENTINEL"    # 带 " 和 \：验证写进 curl 配置前转义了
chk "假 webhook 起来了" "$([ -n "$HOOK_PORT" ] && echo yes || echo no)" yes
hook_reset() { : > "$HOOK/req.log"; echo "${1:-200}" > "$HOOK/mode"; }
hook_count() { grep -c . "$HOOK/req.log" 2>/dev/null || true; }
hook_field() { jq -r "$1" "$HOOK/req.log" | head -1; }
# 给 $RW 的配置追加 webhook 三项（单引号原样写，不经 shell 展开）并收紧到 600
cfg_q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
hook_cfg() {   # [地址] [请求头名] [密钥]（传 - 表示不写这一项）
    local u="${1-$HOOK_URL}" h="${2-X-Hook-Key}" k="${3-$HOOK_KEY}"
    { [ "$u" = - ] || printf 'REQUESTER_BOT_WEBHOOK_URL=%s\n' "$(cfg_q "$u")"
      [ "$h" = - ] || printf 'REQUESTER_BOT_WEBHOOK_KEY_HEADER=%s\n' "$(cfg_q "$h")"
      [ "$k" = - ] || printf 'REQUESTER_BOT_WEBHOOK_KEY=%s\n' "$(cfg_q "$k")"; } >> "$RW/cavil-loop.config"
    chmod 600 "$RW/cavil-loop.config"
}
assign_review_calls() { grep -cE '/(assignees|requested_reviewers)' "$RW/gh/calls.log" 2>/dev/null || true; }
ALL_OUT="$SANDBOX/all-output.txt"; : > "$ALL_OUT"
keep_out() { printf '%s\n' "$OUT" >> "$ALL_OUT"; }

# 成功出口：issue / PR × 首次成功 / 重试成功，各恰好 1 次 webhook；没有任何指派 / review 调用
hook_success_suite() {   # <scripts 副本>
    local S="$1" n kind
    for n in 50 60; do
        kind=issue; [ "$n" = 50 ] || kind=pr
        fresh_bot; hook_cfg; hook_reset; : > "$RW/gh/calls.log"
        bot_case "$S" $n; keep_out
        chk "webhook · $kind 首次成功：退出码 0" "$RC" 0
        chk "webhook · $kind 首次成功：等待标签读回在" "$(labels_of "$RW" $n)" "waiting/bot"
        chk "webhook · $kind 首次成功：没有任何指派 / 请求 review 调用" "$(assign_review_calls)" 0
        chk "webhook · $kind 首次成功：恰好 1 次" "$(hook_count)" 1
        chk "webhook · $kind：POST 到配置的地址" "$(hook_field '.method + " " + .path')" "POST /$HOOK_SECRET_PATH"
        chk "webhook · $kind：密钥请求头原样（含 \" 和 \\）" "$(hook_field '.headers["x-hook-key"]')" "$HOOK_KEY"
        chk "webhook · $kind：Content-Type 是 JSON" "$(hook_field '.headers["content-type"]')" "application/json"
        chk "webhook · $kind：请求体" "$(hook_field '.body | fromjson | tojson')" \
            "{\"repo\":\"example/requester-bot\",\"number\":$n,\"kind\":\"$kind\"}"
        chk "webhook · $kind：输出一行「已通知 webhook（HTTP 200）」" "$(printf '%s\n' "$OUT" | grep -cxF '已通知 webhook（HTTP 200）')" 1
        fresh_bot; hook_cfg; hook_reset
        faults '[{"method":"DELETE","path":"/labels/doing%2Fagent$","mode":"noop","times":1}]'
        bot_case "$S" $n; keep_out
        chk "webhook · $kind 首次失败、重试成功：退出码 0" "$RC" 0
        chk "webhook · $kind 重试成功：恰好 1 次" "$(hook_count)" 1
    done
}
# 失败出口：2 / 3 / 4 各 0 次；交还路径没有撤 review 请求（也没有任何 review / 指派调用）
hook_exit_suite() {   # <scripts 副本>
    local S="$1" n kind
    for n in 50 60; do
        kind=issue; [ "$n" = 50 ] || kind=pr
        fresh_bot; hook_cfg; set_me "$RW" outsider; hook_reset
        bot_case "$S" $n; keep_out
        chk "webhook · $kind 退出码 2：0 次" "$RC|$(hook_count)" "2|0"
        fresh_bot; hook_cfg; hook_reset; : > "$RW/gh/calls.log"
        faults '[{"method":"DELETE","path":"/labels/doing%2Fagent$","mode":"noop","times":2}]'
        bot_case "$S" $n; keep_out
        chk "webhook · $kind 退出码 3：0 次" "$RC|$(hook_count)" "3|0"
        chk "webhook · $kind 退出码 3：交还时没有撤 review / 指派之类的调用" "$(assign_review_calls)" 0
        fresh_bot; hook_cfg; hook_reset
        faults '[{"method":"POST","path":"/labels$","mode":"fail"}]'
        bot_case "$S" $n; keep_out
        chk "webhook · $kind 退出码 4：0 次" "$RC|$(hook_count)" "4|0"
    done
}
# 不发的几种配置：一行固定日志，退出码 0，0 次请求
hook_config_suite() {   # <scripts 副本>
    local S="$1" name u h k mode want
    fresh_bot; hook_reset; bot_case "$S" 50; keep_out
    chk "webhook · 地址为空：退出码 0、0 次" "$RC|$(hook_count)" "0|0"
    chk "webhook · 地址为空：输出里不提 webhook" "$(printf '%s\n' "$OUT" | grep -c webhook)" 0
    while IFS='|' read -r name u h k mode want; do
        [ -n "$name" ] || continue
        [ "$u" != URL ] || u="$HOOK_URL"; [ "$k" != KEY ] || k="$HOOK_KEY"
        [ "$k" != NLKEY ] || k=$'abc\nurl = "http://127.0.0.1:1/x"'
        fresh_bot; hook_cfg "$u" "$h" "$k"; chmod "$mode" "$RW/cavil-loop.config"; hook_reset
        bot_case "$S" 50; keep_out
        chk "webhook · $name：退出码 0、0 次请求" "$RC|$(hook_count)" "0|0"
        chk "webhook · $name：一行「$want」" "$(printf '%s\n' "$OUT" | grep -cxF "$want")" 1
    done <<'CASES'
只填地址和请求头名|URL|X-Hook-Key|-|600|webhook 配置不完整，跳过
只填地址和密钥|URL|-|KEY|600|webhook 配置不完整，跳过
请求头名带冒号和空格|URL|X-Hook-Key: x|KEY|600|webhook 配置不完整，跳过
密钥里有换行|URL|X-Hook-Key|NLKEY|600|webhook 配置不完整，跳过
权限 644|URL|X-Hook-Key|KEY|644|配置文件权限过宽（应为 600），webhook 跳过
权限 640|URL|X-Hook-Key|KEY|640|配置文件权限过宽（应为 600），webhook 跳过
权限 664|URL|X-Hook-Key|KEY|664|配置文件权限过宽（应为 600），webhook 跳过
权限 604|URL|X-Hook-Key|KEY|604|配置文件权限过宽（应为 600），webhook 跳过
权限 620（只有组写位）|URL|X-Hook-Key|KEY|620|配置文件权限过宽（应为 600），webhook 跳过
CASES
    fresh_bot; hook_cfg; chmod 600 "$RW/cavil-loop.config"; hook_reset
    bot_case "$S" 50; keep_out
    chk "webhook · 权限 600：正常发" "$RC|$(hook_count)" "0|1"
    # 没有 curl：PATH 里只放除 curl 以外的命令
    local NC="$SANDBOX/nocurl-bin" f
    if [ ! -d "$NC" ]; then
        mkdir -p "$NC"
        for f in /usr/local/bin/* /usr/bin/* /bin/*; do
            [ "$(basename "$f")" != curl ] && [ -x "$f" ] && [ ! -e "$NC/$(basename "$f")" ] && ln -s "$f" "$NC/$(basename "$f")"
        done
    fi
    fresh_bot; hook_cfg; hook_reset
    RC=0; OUT=$(env PATH="$NC" FAKE_GH_DIR="$RW/gh" bash "$S/scripts/notify-requester-bot.sh" --config "$RW/cavil-loop.config" 50 2>&1) || RC=$?
    keep_out
    chk "webhook · 找不到 curl：退出码 0、0 次" "$RC|$(hook_count)" "0|0"
    chk "webhook · 找不到 curl：一行固定日志" "$(printf '%s\n' "$OUT" | grep -cxF '找不到 curl，webhook 跳过')" 1
}
# 对方出错：一行日志，退出码 0，不重试；超时单次不超过约 10 秒；不跟随跳转
hook_error_suite() {   # <scripts 副本>
    local S="$1" t0 t1
    fresh_bot; hook_cfg; hook_reset 500; bot_case "$S" 50; keep_out
    chk "webhook · 返回 500：退出码 0、只发 1 次（不重试）" "$RC|$(hook_count)" "0|1"
    chk "webhook · 返回 500：一行日志" "$(printf '%s\n' "$OUT" | grep -cxF 'webhook 通知失败（HTTP 500）')" 1
    fresh_bot; hook_cfg; hook_reset 302; bot_case "$S" 50; keep_out
    chk "webhook · 返回跳转：不跟随（只有 1 个请求）" "$RC|$(hook_count)" "0|1"
    chk "webhook · 返回跳转：记为失败" "$(printf '%s\n' "$OUT" | grep -cxF 'webhook 通知失败（HTTP 302）')" 1
    fresh_bot; hook_cfg "http://127.0.0.1:1/$HOOK_SECRET_PATH"; hook_reset; bot_case "$S" 50; keep_out
    chk "webhook · 连不上：退出码 0、一行日志" "$RC|$(printf '%s\n' "$OUT" | grep -cxF 'webhook 通知失败（连接失败）')" "0|1"
    fresh_bot; hook_cfg; hook_reset hang
    t0=$(date +%s); bot_case "$S" 50; t1=$(date +%s); keep_out
    chk "webhook · 超时：退出码 0、一行日志" "$RC|$(printf '%s\n' "$OUT" | grep -cxF 'webhook 通知失败（超时）')" "0|1"
    chk "webhook · 超时：整次叫醒不超过 14 秒（curl 上限 10 秒）" "$([ $((t1 - t0)) -le 14 ] && echo yes || echo "no:$((t1 - t0))s")" yes
    chk "webhook · 超时：只发 1 次（不重试）" "$(hook_count)" 1
}
# 不泄露：输出、poll.log、假 gh 调用记录、运行期间所有进程的命令行里都搜不到地址路径段和密钥
hook_leak_suite() {   # <scripts 副本>
    local S="$1" SAMP="$SANDBOX/cmdline-samples" FLAG="$SANDBOX/sampling" spid
    : > "$SAMP"; : > "$ALL_OUT"; touch "$FLAG"
    python3 -I -c '
import glob, os, sys
flag, out = sys.argv[1:3]
with open(out, "a") as o:
    while os.path.exists(flag):
        for f in glob.glob("/proc/[0-9]*/cmdline"):
            try:
                o.write(open(f, "rb").read().replace(b"\0", b" ").decode("utf-8", "replace") + "\n")
            except OSError:
                pass
' "$FLAG" "$SAMP" &
    spid=$!
    fresh_bot; hook_cfg; hook_reset hang; bot_case "$S" 50; keep_out   # 慢请求：curl 活 10 秒，采样一定碰得到
    fresh_bot; hook_cfg; hook_reset; bot_case "$S" 60; keep_out
    rm -f "$FLAG"; wait "$spid" 2>/dev/null
    chk "不泄露 · 采样确实碰到了 curl 进程（对照：采样不是空的）" "$(grep -c 'curl -q --config -' "$SAMP" | awk '{print ($1 > 0) ? "yes" : "no"}')" yes
    chk "不泄露 · 命令行里没有地址和密钥" "$(grep -cE "$HOOK_SECRET_PATH|$HOOK_KEY_SENTINEL" "$SAMP")" 0
    chk "不泄露 · 脚本输出里没有" "$(grep -cE "$HOOK_SECRET_PATH|$HOOK_KEY_SENTINEL" "$ALL_OUT")" 0
    chk "不泄露 · 到达性：poll.log 确实记了叫醒过程（下一条不是空日志）" "$(grep -c 'notify-requester-bot #60' "$RW/state/poll.log" 2>/dev/null | awk '{print ($1 > 0) ? "yes" : "no"}')" yes
    chk "不泄露 · poll.log 里没有" "$(grep -cE "$HOOK_SECRET_PATH|$HOOK_KEY_SENTINEL" "$RW/state/poll.log" 2>/dev/null || true)" 0
    chk "不泄露 · 假 gh 调用记录里没有" "$(grep -cE "$HOOK_SECRET_PATH|$HOOK_KEY_SENTINEL" "$RW/gh/calls.log")" 0
}
hook_success_suite "$NEW"; hook_exit_suite "$NEW"; hook_config_suite "$NEW"; hook_error_suite "$NEW"; hook_leak_suite "$NEW"
chk "不泄露 · 以上全部用例的输出里没有地址和密钥" "$(grep -cE "$HOOK_SECRET_PATH|$HOOK_KEY_SENTINEL" "$ALL_OUT")" 0

echo "── 3d 负对照（逐出口） ──"
D=$(mutate hook-none scripts/notify-requester-bot.sh \
    '    requester_bot_webhook_notify "$NUM" "$ITEM_KIND"' \
    '    :') && neg "首次成功 · 删掉 webhook 调用（红在「恰好 1 次」）" hook_success_suite "$D"
D=$(mutate hook-assign scripts/notify-requester-bot.sh \
    '    # 读回核对：等待标签在、要摘的一个都不在' \
    '    gh_write api -X POST "repos/$REPO/issues/$NUM/assignees" -f "assignees[]=$REQUESTER_BOT_ACCOUNT" >/dev/null || true
    # 读回核对：等待标签在、要摘的一个都不在') && neg "首次成功 · 恢复指派调用（红在「没有任何指派」）" hook_success_suite "$D"
D=$(mutate hook-review scripts/notify-requester-bot.sh \
    '    # 读回核对：等待标签在、要摘的一个都不在' \
    '    [ "$IS_PR" != true ] || gh_write api -X POST "repos/$REPO/pulls/$NUM/requested_reviewers" -f "reviewers[]=$REQUESTER_BOT_ACCOUNT" >/dev/null || true
    # 读回核对：等待标签在、要摘的一个都不在') && neg "首次成功 · PR 上恢复请求 review" hook_success_suite "$D"
D=$(mutate hook-first-only scripts/notify-requester-bot.sh \
    '    if wake_once; then WOKE="重试后成功' \
    '    if wake_once; then NOHOOK=1; WOKE="重试后成功') \
    && D=$(MUT_BASE="$D" mutate hook-first-only2 scripts/notify-requester-bot.sh \
    '    requester_bot_webhook_notify "$NUM" "$ITEM_KIND"' \
    '    [ -n "${NOHOOK:-}" ] || requester_bot_webhook_notify "$NUM" "$ITEM_KIND"') \
    && neg "重试成功 · 只在首次成功分支调用（红在「重试成功：恰好 1 次」）" hook_success_suite "$D"
D=$(mutate hook-on-2 scripts/notify-requester-bot.sh \
    'reject() { say "❌ 拒绝叫醒（标签未改动）：$*"; exit 2; }' \
    'reject() { say "❌ 拒绝叫醒（标签未改动）：$*"; requester_bot_webhook_notify "$NUM" issue; exit 2; }') \
    && neg "退出码 2 · 退出前无条件调用" hook_exit_suite "$D"
D=$(mutate hook-on-3 scripts/notify-requester-bot.sh \
    '    exit 3' \
    '    requester_bot_webhook_notify "$NUM" "$ITEM_KIND"; exit 3') && neg "退出码 3 · 退出前无条件调用" hook_exit_suite "$D"
D=$(mutate hook-on-4 scripts/notify-requester-bot.sh \
    'exit 4' \
    'requester_bot_webhook_notify "$NUM" "$ITEM_KIND"; exit 4') && neg "退出码 4 · 退出前无条件调用" hook_exit_suite "$D"
D=$(mutate hook-no-half scripts/_lib.sh \
    '    if [ -z "${REQUESTER_BOT_WEBHOOK_KEY_HEADER:-}" ] || [ -z "${REQUESTER_BOT_WEBHOOK_KEY:-}" ] \' \
    '    if false \') && neg "只填一半 / 带换行 · 去掉配置完整性检查" hook_config_suite "$D"
D=$(mutate hook-no-perm scripts/_lib.sh \
    '    if [ "$go" != 00 ]; then' \
    '    if false; then') && neg "权限过宽 · 去掉权限检查" hook_config_suite "$D"
D=$(mutate hook-perm-read-only scripts/_lib.sh \
    '    if [ "$go" != 00 ]; then' \
    '    if [ $(( ${go:0:1} & 4 )) -ne 0 ] || [ $(( ${go:1:1} & 4 )) -ne 0 ]; then') \
    && neg "权限过宽 · 只看读位（照搬现有 token 告警的判法，放过 620）" hook_config_suite "$D"
D=$(mutate hook-no-header-check scripts/_lib.sh \
    '       || ! [[ "$REQUESTER_BOT_WEBHOOK_KEY_HEADER" =~ ^[A-Za-z0-9-]+$ ]] \' \
    '       || false \') && neg "请求头名不校验字符" hook_config_suite "$D"
D=$(mutate hook-no-curl-check scripts/_lib.sh \
    '    if ! command -v curl >/dev/null 2>&1; then' \
    '    if false; then') && neg "没有 curl · 去掉检查（红在固定日志）" hook_config_suite "$D"
D=$(mutate hook-follow scripts/_lib.sh \
    '--max-redirs 0' '-L') && neg "跟随跳转" hook_error_suite "$D"
D=$(mutate hook-url-argv scripts/_lib.sh \
    "    code=\$(printf '%s\\n' \"\$conf\" | curl -q --config - --globoff -s" \
    "    code=\$(printf '%s\\n' \"\$conf\" | curl -q --config - --globoff \"\$REQUESTER_BOT_WEBHOOK_URL\" -H \"\$REQUESTER_BOT_WEBHOOK_KEY_HEADER: \$REQUESTER_BOT_WEBHOOK_KEY\" -s") \
    && neg "不泄露 · 把地址和密钥放命令行" hook_leak_suite "$D"
D=$(mutate hook-no-escape scripts/_lib.sh \
    '    _rb_curl_quote() { local v="${1//\\/\\\\}"; printf '"'"'"%s"'"'"' "${v//\"/\\\"}"; }' \
    '    _rb_curl_quote() { printf '"'"'"%s"'"'"' "$1"; }') && neg "写进 curl 配置前不转义" hook_success_suite "$D"

# ─────────────────────────────────────────────────────────────────────────
echo "── 3e. PR 合并 / 关闭未合并后告诉机器人（GitHub#97 Q2=A） ──"
# ─────────────────────────────────────────────────────────────────────────
# 起真的 agent-poll.sh（合并后清理那一段打开），看 daemon 是否在机器人提的 issue 上留结果评论、
# 加等待标签并通知 webhook（GitHub#100，不再指派）；不是机器人的需求、还有别的 PR 开着的、
# 别人伪造的标记都不能误判。
DW="$SANDBOX/done"
done_env() {   # <on|off>
    new_env "$DW" "$1" label 'AUTO_CLEANUP_ON_MERGE=true'
    if [ "$1" = on ]; then
        { printf 'REQUESTER_BOT_WEBHOOK_URL=%s\n' "$(cfg_q "${DONE_HOOK_URL:-$HOOK_URL}")"
          printf 'REQUESTER_BOT_WEBHOOK_KEY_HEADER=X-Hook-Key\n'
          printf 'REQUESTER_BOT_WEBHOOK_KEY=%s\n' "$(cfg_q "$HOOK_KEY")"; } >> "$DW/cavil-loop.config"
        chmod 600 "$DW/cavil-loop.config"
    fi
    hook_reset
    git init -q "$DW/project"
    printf '{"cleaned_prs":[],"cleaned_issues":[],"unmerged_prs_handled":[]}' > "$DW/state/state.json"
    # 机器人提的、已被 Closes 关掉的需求 + 合并的 PR
    add_item "$DW" 50 issue "pending/PR" req-bot "需求 $MARK"; set_field "$DW" 50 state '"closed"'
    add_item "$DW" 60 pr "pending/human" worker-bot "Closes #50" feature/issue-50
    set_field "$DW" 60 state '"closed"'; set_field "$DW" 60 merged true
    # 普通人的需求 + 合并的 PR：不通知
    add_item "$DW" 70 issue "pending/PR" someone "普通需求 $MARK"
    add_item "$DW" 71 pr "" worker-bot "Closes #70" feature/issue-70
    set_field "$DW" 71 state '"closed"'; set_field "$DW" 71 merged true
    # 机器人的需求 + 关闭未合并、没有别的 PR → 通知「关闭未合并」
    add_item "$DW" 52 issue "pending/PR" req-bot "$MARK"
    add_item "$DW" 72 pr "" worker-bot "" feature/issue-52; set_field "$DW" 72 state '"closed"'
    # 机器人的需求 + 关闭未合并、但这项工作还有别的 PR 开着 → 不通知。issue 上故意不挂
    # pending/PR：挂着的话 § 3c 早一步就跳过了，测不到新加的「还有别的 PR 开着」判断
    add_item "$DW" 53 issue "" req-bot "$MARK"
    add_item "$DW" 73 pr "" worker-bot "" feature/issue-53; set_field "$DW" 73 state '"closed"'
    add_item "$DW" 74 pr "pending/human" worker-bot "Refs #53" chore/second-try
    # 机器人的需求、已挂着等待标签（上一轮叫醒还没被机器人摘）：照样通知，标签不重复
    add_item "$DW" 54 issue "waiting/bot" req-bot "$MARK"
    add_item "$DW" 75 pr "" worker-bot "" feature/issue-54
    set_field "$DW" 75 state '"closed"'; set_field "$DW" 75 merged true
    # 别人在评论里写了同样的标记：挡不掉通知
    add_item "$DW" 55 issue "" req-bot "$MARK"
    set_field "$DW" 55 comments '[{"user":"someone","body":"<!-- requester-bot-done pr=76 kind=merged -->"}]'
    add_item "$DW" 76 pr "" worker-bot "" feature/issue-55
    set_field "$DW" 76 state '"closed"'; set_field "$DW" 76 merged true
}
done_tick() { tick "$1" "$DW"; }
my_marks() {   # <issue> → 本身份（worker-bot）发的结果评论标记，空格分隔
    jq -r --arg n "$1" '[(.items[$n].comments // [])[] | select(type == "object" and .user == "worker-bot") | .body
        | capture("<!-- requester-bot-done (?<m>pr=[0-9]+ kind=[a-z]+) -->").m] | join(" ")' "$DW/gh/state.json"
}
queue_len() { jq -r '(.requester_bot_done_queue // {}) | length' "$DW/state/state.json"; }
has_wait() { labels_of "$DW" "$1" | tr ',' '\n' | grep -cx 'waiting/bot'; }
done_assign_calls() { grep -cE '/(assignees|requested_reviewers)' "$DW/gh/calls.log" 2>/dev/null || true; }
hook_numbers() { jq -r '.body | fromjson | "\(.number):\(.kind)"' "$HOOK/req.log" | sort -n | paste -sd' '; }
done_suite() {   # <scripts 副本>
    local S="$1" before
    done_env on
    done_tick "$S"
    chk "合并 · 机器人的需求：留了「已合并」结果评论" "$(my_marks 50)" "pr=60 kind=merged"
    chk "合并 · 机器人的需求：来源 issue（已关闭）挂上等待标签" "$(has_wait 50)" 1
    chk "合并 · 评论正文写明合并提交" "$(jq -r '.items["50"].comments[0].body' "$DW/gh/state.json" | grep -c '合并提交 `0123456789ab`')" 1
    chk "合并 · 普通人的需求：不评论" "$(my_marks 70)" ""
    chk "合并 · 普通人的需求：不加等待标签" "$(has_wait 70)" 0
    chk "关闭未合并 · 机器人的需求：留了「关闭未合并」评论" "$(my_marks 52)" "pr=72 kind=closed"
    chk "关闭未合并 · 机器人的需求：挂上等待标签" "$(has_wait 52)" 1
    chk "关闭未合并 · 还有别的 PR 开着：不通知" "$(my_marks 53)$(has_wait 53)" "0"
    chk "合并 · 已挂着等待标签：照样通知、等待标签只有一个" "$(my_marks 54)|$(has_wait 54)" "pr=75 kind=merged|1"
    chk "结果通知 · 没有任何指派 / 请求 review 调用" "$(done_assign_calls)" 0
    chk "结果通知 · webhook 每个来源 issue 恰好 1 次，kind 都是 issue" "$(hook_numbers)" "50:issue 52:issue 54:issue 55:issue"
    chk "合并 · 别人伪造的标记挡不掉通知" "$(my_marks 55)" "pr=76 kind=merged"
    chk "清队 · 全部通知完，队列为空" "$(queue_len)" 0
    # 第二轮：一条都不重发
    before=$(grep -cE '^WRITE POST .*/(comments|labels)$' "$DW/gh/calls.log")
    hook_reset
    done_tick "$S"
    chk "第二轮 · 不重发评论、不重加标签" "$(grep -cE '^WRITE POST .*/(comments|labels)$' "$DW/gh/calls.log")" "$before"
    chk "第二轮 · 不再调 webhook" "$(hook_count)" 0
}
done_retry_suite() {   # <scripts 副本>：加标签失败 → 下轮只补标签，不重复评论；PR 现状读不全 → 不写
    local S="$1" mode
    for mode in fail noop; do
        done_env on
        # 只打「加等待标签」那一次：合并流程自己也会给 issue 加标签，不加 field 会先被它吃掉
        printf '[{"method":"POST","path":"/issues/50/labels$","field":"waiting/bot","mode":"%s","times":1}]' "$mode" > "$DW/gh/faults.json"
        done_tick "$S"
        chk "重试（加标签 $mode）· 第一轮评论发了、标签没加上" "$(my_marks 50)|$(has_wait 50)" "pr=60 kind=merged|0"
        chk "重试（加标签 $mode）· 失败的那条留在队里" "$(jq -r '.requester_bot_done_queue["60"].tries // "none"' "$DW/state/state.json")" 1
        chk "重试（加标签 $mode）· 第一轮没调 webhook" "$(jq -r '.body | fromjson | .number' "$HOOK/req.log" | grep -cx 50)" 0
        done_tick "$S"
        chk "重试（加标签 $mode）· 第二轮补上等待标签" "$(has_wait 50)" 1
        chk "重试（加标签 $mode）· 结果评论只有一条" "$(my_marks 50)" "pr=60 kind=merged"
        chk "重试（加标签 $mode）· 第二轮调了 webhook，共 1 次" "$(jq -r '.body | fromjson | .number' "$HOOK/req.log" | grep -cx 50)" 1
        chk "重试（加标签 $mode）· 出队" "$(queue_len)" 0
    done
    # webhook 失败不进重试：标签加上了就出队
    done_env on; hook_reset 500
    done_tick "$S"
    chk "webhook 返回 500 · 结果通知照样出队" "$(queue_len)|$(has_wait 50)" "0|1"
    chk "webhook 返回 500 · 每个来源 issue 只试 1 次" "$(hook_count)" 4
    chk "webhook 返回 500 · poll.log 记一行失败" "$(grep -c 'issue #50：webhook 通知失败（HTTP 500）' "$DW/state/poll.log")" 1
    hook_reset
    # 写之前现读 PR：状态字段缺失 → 本轮不写、留队
    done_env on
    set_field "$DW" 75 drop_pull_fields '["merged","merged_at"]'
    done_tick "$S"
    chk "现读核对 · PR 合并状态字段缺失：不评论" "$(my_marks 54)" ""
    chk "现读核对 · PR 合并状态字段缺失：留队待下轮" "$(jq -r '.requester_bot_done_queue["75"].tries // "none"' "$DW/state/state.json")" 1
    # 入队后 PR 被重新打开（现状和入队时不符）→ 不写、出队
    done_env on
    jq '.requester_bot_done_queue = {"74": {"kind": "merged", "tries": 0}}' "$DW/state/state.json" > "$DW/state/s.tmp" && mv "$DW/state/s.tmp" "$DW/state/state.json"
    done_tick "$S"
    chk "现读核对 · PR 还开着却按「已合并」入了队：不通知" "$(my_marks 53)" ""
    chk "现读核对 · 不符的那条出队" "$(jq -r '.requester_bot_done_queue | has("74")' "$DW/state/state.json")" false
    # 已有「已合并」通知的需求，旧的关闭 PR 后来才被扫到 → 不再补「关闭未合并」
    done_env on
    set_field "$DW" 53 comments '[{"user":"worker-bot","body":"<!-- requester-bot-done pr=99 kind=merged -->"}]'
    set_field "$DW" 74 state '"closed"'; set_field "$DW" 74 merged true; set_field "$DW" 74 head_ref '"feature/issue-53"'
    done_tick "$S"
    chk "已合并过的需求，旧 PR 关闭不再通知" "$(my_marks 53)" "pr=99 kind=merged pr=74 kind=merged"
}
# 复审 #98 第 1 轮：首轮发送失败留在队里，重试前这项需求新开了 PR → 不能再发「没有落地」；
# 打开的 PR 列表读失败 → 当成不知道、留队，不能当成「没有别的 PR」
done_rerun_suite() {   # <scripts 副本>
    local S="$1"
    done_env on
    printf '%s' '[{"method":"POST","path":"/issues/52/comments$","mode":"fail","times":1}]' > "$DW/gh/faults.json"
    done_tick "$S"
    chk "跨轮 · 首轮评论失败，#72 的关闭通知留在队里" "$(jq -r '.requester_bot_done_queue["72"].tries // "none"' "$DW/state/state.json")" 1
    add_item "$DW" 80 pr "" worker-bot "Refs #52" feature/issue-52
    done_tick "$S"
    chk "跨轮 · 重试前同一需求新开了 PR #80：不发关闭通知" "$(my_marks 52)" ""
    chk "跨轮 · 不加等待标签" "$(has_wait 52)" 0
    chk "跨轮 · 这条出队（工作在新 PR 上继续）" "$(jq -r '.requester_bot_done_queue | has("72")' "$DW/state/state.json")" false
    # 打开的 PR 列表读失败（只让这一个调用失败）
    done_env on
    printf '%s' '[{"method":"GET","path":"/pulls$","field":"sort=created","mode":"fail"}]' > "$DW/gh/faults.json"
    done_tick "$S"
    chk "列表读失败 · 有别的 PR 开着的 #53：不通知" "$(my_marks 53)$(has_wait 53)" "0"
    chk "列表读失败 · 没有别的 PR 的 #52 这轮也不通知" "$(my_marks 52)" ""
    chk "列表读失败 · 两条都留队" "$(jq -r '[.requester_bot_done_queue["72"].tries, .requester_bot_done_queue["73"].tries] | map(tostring) | join(",")' "$DW/state/state.json")" "1,1"
    chk "列表读失败 · 合并通知不受影响" "$(my_marks 50)" "pr=60 kind=merged"
    printf '[]' > "$DW/gh/faults.json"
    done_tick "$S"
    chk "列表恢复 · #52 补发关闭通知" "$(my_marks 52)" "pr=72 kind=closed"
    chk "列表恢复 · #53 仍不通知（#74 开着）" "$(my_marks 53)$(has_wait 53)" "0"
    chk "列表恢复 · 队列清空" "$(queue_len)" 0
}
# 写身份资格：叫醒脚本和合并后通知用同一批账号，结论必须一致
ACTOR_CASES='worker-bot|yes
Reviewer-Bot|yes
outsider|no
-|no'
actor_suite() {   # <scripts 副本>
    local S="$1" who want got_wake got_done
    while IFS='|' read -r who want; do
        # 叫醒脚本
        fresh_bot
        if [ "$who" = - ]; then faults '[{"method":"GET","path":"^user$","mode":"fail"}]'; else set_me "$RW" "$who"; fi
        bot_case "$S" 50
        got_wake=$([ "$RC" = 0 ] && echo yes || echo no)
        # 合并后通知
        done_env on
        if [ "$who" = - ]; then printf '%s' '[{"method":"GET","path":"^user$","mode":"fail"}]' > "$DW/gh/faults.json"; else set_me "$DW" "$who"; fi
        done_tick "$S"
        got_done=$([ -n "$(jq -r '[(.items["50"].comments // [])[] | select(type == "object")] | length | select(. > 0)' "$DW/gh/state.json")" ]             && [ "$(has_wait 50)" = 1 ] && echo yes || echo no)
        chk "写身份 ${who} · 叫醒脚本是否放行" "$got_wake" "$want"
        chk "写身份 ${who} · 合并后通知是否发出" "$got_done" "$want"
        if [ "$want" = no ]; then
            chk "写身份 ${who} · 合并后通知留队待下轮" "$(jq -r '.requester_bot_done_queue["60"].tries // "none"' "$DW/state/state.json")" 1
        fi
    done <<< "$ACTOR_CASES"
}
done_suite "$NEW"; done_retry_suite "$NEW"; done_rerun_suite "$NEW"; actor_suite "$NEW"
# 地址里带 [1-2] / {a,b}（复审 #101 第 1 轮）：curl 默认把它们展开成多个请求。叫醒和结果通知
# 两条真实路径各跑一遍：恰好 1 次、路径和查询原样、记 HTTP 200
GLOB_QS='?filter[1-2]=x&pick={a,b}'
glob_suite() {   # <scripts 副本>
    local S="$1"
    fresh_bot; hook_cfg "$HOOK_URL$GLOB_QS"; hook_reset; bot_case "$S" 50
    chk "地址带范围写法 · 叫醒：恰好 1 次" "$RC|$(hook_count)" "0|1"
    chk "地址带范围写法 · 叫醒：路径和查询原样" "$(hook_field .path)" "/$HOOK_SECRET_PATH$GLOB_QS"
    chk "地址带范围写法 · 叫醒：记为 HTTP 200" "$(printf '%s\n' "$OUT" | grep -cxF '已通知 webhook（HTTP 200）')" 1
    DONE_HOOK_URL="$HOOK_URL$GLOB_QS" done_env on
    printf '%s' '{"cleaned_prs":[],"cleaned_issues":[],"unmerged_prs_handled":[]}' > "$DW/state/state.json"
    done_tick "$S"
    chk "地址带范围写法 · 结果通知：每个来源 issue 恰好 1 次" "$(hook_numbers)" "50:issue 52:issue 54:issue 55:issue"
    chk "地址带范围写法 · 结果通知：路径和查询全部原样" "$(jq -r .path "$HOOK/req.log" | sort -u)" "/$HOOK_SECRET_PATH$GLOB_QS"
    chk "地址带范围写法 · 结果通知：记为 HTTP 200" "$(grep -c 'issue #50：已通知 webhook（HTTP 200）' "$DW/state/poll.log")" 1
}
glob_suite "$NEW"
done_env on; done_tick "$NEW"   # 上面最后一条用例不发通知；这里补一轮会发的，再查日志
chk "结果通知 · daemon 的 poll.log / 调用记录里没有 webhook 地址和密钥" \
    "$(cat "$DW/state/poll.log" "$DW/gh/calls.log" 2>/dev/null | grep -cE "$HOOK_SECRET_PATH|$HOOK_KEY_SENTINEL")" 0
chk "结果通知 · poll.log 里确实记了 webhook 结果（对照：上一条不是空日志）" "$(grep -c 'webhook' "$DW/state/poll.log" | awk '{print ($1 > 0) ? "yes" : "no"}')" yes
# 功能关闭：和改动前逐字节一致（GitHub 调用、标签、state.json），也确实走到了合并后清理
for v in old new; do
    rm -rf "$SANDBOX/done-off-$v"
    done_env off
    if [ "$v" = old ]; then done_tick "$OLD"; done_tick "$OLD"; else done_tick "$NEW"; done_tick "$NEW"; fi
    cp -r "$DW" "$SANDBOX/done-off-$v"
done
A="$SANDBOX/done-off-old"; B="$SANDBOX/done-off-new"
chk "关闭 · 合并后清理：GitHub 调用逐条相同" "$(cmp -s "$A/gh/calls.log" "$B/gh/calls.log" && echo same || echo diff)" same
chk "关闭 · 合并后清理：GitHub 状态相同" "$(cmp -s <(jq -S . "$A/gh/state.json") <(jq -S . "$B/gh/state.json") && echo same || echo diff)" same
chk "关闭 · 合并后清理：state.json 相同" "$(cmp -s <(jq -S . "$A/state/state.json") <(jq -S . "$B/state/state.json") && echo same || echo diff)" same
chk "关闭 · 对拍不是两边都空（确实处理了合并的 PR）" "$(jq -r '.cleaned_prs | length' "$B/state/state.json")" 4
echo "── 3e 负对照 ──"
D=$(mutate no-merged-enqueue scripts/agent-poll.sh \
    '                requester_bot_done_enqueue "$prnum" merged "$STATE_FILE"' \
    '                :') && neg "合并路径不入队" done_suite "$D"
D=$(mutate no-closed-enqueue scripts/agent-poll.sh \
    '            requester_bot_done_enqueue "$prnum" closed "$STATE_FILE"' \
    '            :') && neg "关闭未合并路径不入队" done_suite "$D"
D=$(mutate no-open-check scripts/_lib.sh \
    '        if [ -n "$others" ]; then' \
    '        if false; then') && neg "关闭通知不看还有没有别的 PR 开着" done_suite "$D"
D=$(mutate no-open-check2 scripts/_lib.sh \
    '        if [ -n "$others" ]; then' \
    '        if false; then') && neg "关闭通知不看还有没有别的 PR 开着（跨轮）" done_rerun_suite "$D"
D=$(mutate open-read-as-empty scripts/_lib.sh \
    '        if ! others=$(requester_bot_open_prs_for "$origin" "$pr"); then' \
    '        others=$(requester_bot_open_prs_for "$origin" "$pr") || others=""; if false; then') \
    && neg "打开的 PR 列表读失败当成「没有」" done_rerun_suite "$D"
D=$(mutate done-no-actor-check scripts/_lib.sh \
    '    if ! requester_bot_check_actor; then
        log "  PR #$pr 的结果通知不发' \
    '    requester_bot_check_actor; if false; then
        log "  PR #$pr 的结果通知不发') && neg "合并后通知不核对写身份在不在名单里" actor_suite "$D"
D=$(mutate wake-no-actor-check scripts/notify-requester-bot.sh \
    'requester_bot_check_actor || reject "$REQUESTER_BOT_REASON"' \
    'requester_bot_check_actor || true') && neg "叫醒脚本不核对写身份在不在名单里" actor_suite "$D"
D=$(mutate no-drain scripts/agent-poll.sh \
    '    requester_bot_done_drain "$STATE_FILE" || true' \
    '    :') && neg "不清队" done_suite "$D"
D=$(mutate done-no-origin-check scripts/_lib.sh \
    '    rc=0; requester_bot_item_origin "$pr" "$item" || rc=$?' \
    '    rc=0; requester_bot_item_origin "$pr" "$item" || { REQUESTER_BOT_ORIGIN=$(pr_to_issue_num "$pr" "$(printf %s "$REQUESTER_BOT_PR_JSON" | jq -r .head.ref)"); rc=0; }') \
    && neg "合并后通知不核对是不是机器人的需求" done_suite "$D"
D=$(mutate done-no-dedupe scripts/_lib.sh \
    '    if ! printf '"'"'%s\n'"'"' "$marks" | grep -qxF "$mark"; then' \
    '    if true; then') && neg "重试时不看评论发过没有（会重复评论）" done_retry_suite "$D"
D=$(mutate done-any-author scripts/_lib.sh \
    '--jq ".[] | select((.user.login // \"\" | ascii_downcase) == \"$(requester_bot_lc "$me")\") | (.body' \
    '--jq ".[] | (.body') && neg "认任何人发的标记评论（会被伪造挡掉）" done_suite "$D"
D=$(mutate done-no-state-check scripts/_lib.sh \
    '    if [ -z "$st" ] || [ -z "$merged" ]; then' \
    '    st=closed; merged=true; if false; then') && neg "写之前不核对 PR 现状" done_retry_suite "$D"
D=$(mutate hook-glob scripts/_lib.sh \
    'curl -q --config - --globoff -s' 'curl -q --config - -s') && neg "去掉 --globoff（叫醒、结果通知两条路径都变红）" glob_suite "$D"
D=$(mutate done-no-label scripts/_lib.sh \
    '    if ! gh_write api -X POST "repos/$REPO/issues/$origin/labels" -f "labels[]=$LABEL_PENDING_REQUESTER_BOT" >/dev/null 2>&1; then' \
    '    if false; then') && neg "结果通知 · 删掉加标签（红在「挂上等待标签」）" done_suite "$D"
D=$(mutate done-reassign scripts/_lib.sh \
    '    if ! gh_write api -X POST "repos/$REPO/issues/$origin/labels" -f "labels[]=$LABEL_PENDING_REQUESTER_BOT" >/dev/null 2>&1; then' \
    '    gh_write api -X POST "repos/$REPO/issues/$origin/assignees" -f "assignees[]=$REQUESTER_BOT_ACCOUNT" >/dev/null 2>&1 || true
    if ! gh_write api -X POST "repos/$REPO/issues/$origin/labels" -f "labels[]=$LABEL_PENDING_REQUESTER_BOT" >/dev/null 2>&1; then') \
    && neg "结果通知 · 恢复重新指派（红在「没有任何指派」）" done_suite "$D"
D=$(mutate done-no-label-readback scripts/_lib.sh \
    '    if ! printf '"'"'%s\n'"'"' "$labels" | grep -qxF "$LABEL_PENDING_REQUESTER_BOT"; then' \
    '    if false; then') && neg "结果通知 · 加标签后不读回" done_retry_suite "$D"
D=$(mutate done-no-hook scripts/_lib.sh \
    '    requester_bot_webhook_notify "$origin" issue' \
    '    :') && neg "结果通知 · 不调 webhook" done_suite "$D"
D=$(mutate done-hook-retry scripts/_lib.sh \
    '    requester_bot_webhook_notify "$origin" issue
    [ -z "$REQUESTER_BOT_WEBHOOK_RESULT" ] || log "  issue #$origin：$REQUESTER_BOT_WEBHOOK_RESULT"
    return 0' \
    '    requester_bot_webhook_notify "$origin" issue
    [ -z "$REQUESTER_BOT_WEBHOOK_RESULT" ] || log "  issue #$origin：$REQUESTER_BOT_WEBHOOK_RESULT"
    case "$REQUESTER_BOT_WEBHOOK_RESULT" in *失败*) return 1 ;; esac
    return 0') && neg "结果通知 · webhook 失败当成要重试" done_retry_suite "$D"
D=$(mutate done-closed-after-merged scripts/_lib.sh \
    '    if [ "$kind" = closed ] && printf '"'"'%s\n'"'"' "$marks" | grep -q '"'"'kind=merged'"'"'; then' \
    '    if false; then') && neg "已合并过还补「关闭未合并」" done_retry_suite "$D"

# ─────────────────────────────────────────────────────────────────────────
echo "── 3f. 配置项新旧名字（GitHub#97 Q1=B） ──"
# ─────────────────────────────────────────────────────────────────────────
old_names_env() {   # <W>：只用早期的 RELAY_* 名字开启
    new_env "$1" off label
    cat >> "$1/cavil-loop.config" <<'CONF'
LABEL_PENDING_RELAY="waiting/bot"
RELAY_BOT_ACCOUNT="req-bot"
RELAY_ALLOWED_ACTORS="worker-bot, reviewer-bot"
RELAY_ORIGIN_MARKER="<!-- bot-origin -->"
RELAY_REPORT_FIRST="true"
CONF
}
names_suite() {   # <scripts 副本>
    local S="$1" kind W2="$SANDBOX/names-new"
    # 旧名字照样开启：叫醒成功
    old_names_env "$RW"
    add_item "$RW" 50 issue "doing/agent" req-bot "需求 $MARK"
    add_item "$RW" 60 pr "doing/agent" worker-bot "实现" feature/issue-50
    printf '[]' > "$RW/gh/faults.json"
    bot_case "$S" 60
    chk "旧名字 · PR 叫醒：退出码 0" "$RC" 0
    chk "旧名字 · 等待标签按旧名字的值" "$(labels_of "$RW" 60)" "waiting/bot"
    # 旧名字和新名字拼出来的提示词逐字节相同（包括「先汇报」那一项）
    new_env "$W2" on label 'REQUESTER_BOT_REPORT_FIRST="true"'
    sed -i "s|$W2|$RW|g" "$W2/cavil-loop.config"
    # 两边先后拼、各存一份再比：两份配置共用同一个状态目录，拼装结果写在同一个固定文件里。
    # 原来用两个进程替换同时拼，两边常常读到同一份最后写完的文件，于是下面这处差别被盖住了：
    # 交接规则里的叫醒命令带着配置文件自己的路径，两份配置放在不同目录，这一处天然不同，
    # 比之前先把它对齐（只换这一个路径，其余逐字节比）
    for kind in new-issue review; do
        compose_out "$S" "$RW" $kind > "$SANDBOX/names-old-$kind.md"
        env CODING_AGENT_CONFIG="$W2/cavil-loop.config" bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; cat "$(compose_prompt_template "$2")"' _ "$S" $kind \
            | sed "s|$W2/cavil-loop.config|$RW/cavil-loop.config|g" > "$SANDBOX/names-new-$kind.md"
        chk "旧名字 · 提示词 $kind 与新名字的逐字节相同" \
            "$(cmp -s "$SANDBOX/names-old-$kind.md" "$SANDBOX/names-new-$kind.md" && echo same || echo diff)" same
    done
    chk "旧名字 · 提示词里确实有交接规则（对拍不是两边都空）" "$(compose_out "$S" "$RW" new-issue | grep -cxF "$HEAD_LINE")" 1
    # 新旧都填且不同：用新的，并提示
    old_names_env "$RW"
    printf 'REQUESTER_BOT_ACCOUNT="new-bot"\n' >> "$RW/cavil-loop.config"
    add_item "$RW" 50 issue "doing/agent" new-bot "需求 $MARK"
    printf '[]' > "$RW/gh/faults.json"
    bot_case "$S" 50
    # 账号现在只用来认「是不是机器人提的」：作者是 new-bot 的需求能叫醒 = 用的是新名字的值
    chk "新旧都填 · 用新名字的值" "$RC|$(labels_of "$RW" 50)" "0|waiting/bot"
    chk "新旧都填 · 输出提示了冲突" "$(printf '%s' "$OUT" | grep -c 'REQUESTER_BOT_ACCOUNT（用它）/ RELAY_BOT_ACCOUNT（忽略）')" 1
    # 早期入口名 notify-relay.sh 仍可用，转到同一个新脚本
    old_names_env "$RW"
    add_item "$RW" 60 pr "doing/agent" worker-bot "实现" feature/issue-50
    add_item "$RW" 50 issue "doing/agent" req-bot "需求 $MARK"
    printf '[]' > "$RW/gh/faults.json"
    NOTIFY_ENTRY=notify-relay.sh bot_case "$S" 60
    chk "早期入口名 · 照样叫醒" "$RC|$(labels_of "$RW" 60)" "0|waiting/bot"
}
names_suite "$NEW"
D=$(mutate no-old-names scripts/_lib.sh \
    'printf -v "$new" '"'"'%s'"'"' "$(cavil_pick_setting "${!new:-}" "${!old:-}")"' \
    'printf -v "$new" '"'"'%s'"'"' "$(cavil_pick_setting "${!new:-}" "")"') && neg "公共库不再认旧名字" names_suite "$D"
D=$(mutate old-wins scripts/_names.sh \
    '    if [ -n "$1" ]; then printf '"'"'%s'"'"' "$1"; else printf '"'"'%s'"'"' "$2"; fi' \
    '    if [ -n "$2" ]; then printf '"'"'%s'"'"' "$2"; else printf '"'"'%s'"'"' "$1"; fi') && neg "共用的挑名字函数改成旧的优先" names_suite "$D"
# setup.sh 建等待标签：真跑安装入口（隔离 HOME、假 gh / systemctl），断言它实际发出的建标签请求，
# 并和公共库（_lib.sh）对同一份配置挑出来的名字对拍。两边都调 _names.sh 的 cavil_pick_setting。
SETUP_ROOT="$SANDBOX/setup"; mkdir -p "$SETUP_ROOT/fakebin"
cat > "$SETUP_ROOT/fakebin/gh" <<'GH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${GH_LOG:-/dev/null}"
case "$*" in
    "auth status"*) exit 0 ;;
    "repo view"*) echo "acme/widget"; exit 0 ;;
    "label create"*) exit 0 ;;
    *"pr list"*--json*|*"issue list"*--json*) echo ""; exit 0 ;;
    *"repos/acme/widget/pulls"*) echo '[[]]'; exit 0 ;;
esac
echo '[]'
GH
cat > "$SETUP_ROOT/fakebin/systemctl" <<'SC'
#!/usr/bin/env bash
case "$*" in *is-active*) exit 3 ;; *is-enabled*) echo disabled; exit 1 ;; esac
exit 0
SC
printf '#!/usr/bin/env bash\nexit 0\n' > "$SETUP_ROOT/fakebin/claude"
chmod +x "$SETUP_ROOT/fakebin"/*
make_skill_src() {   # <目录>：把当前工作区（含未提交改动）做成一个可发布的 skill 仓库
    local d="$1"
    rm -rf "$d" "$d.git"; git init -q --bare "$d.git"; git init -q -b main "$d"
    (cd "$REPO_DIR" && git ls-files -co --exclude-standard -z) \
        | (cd "$REPO_DIR" && xargs -0 -I{} cp --parents -P {} "$d/" 2>/dev/null)
    git -C "$d" add -A >/dev/null
    git -C "$d" -c user.email=t@example.invalid -c user.name=t commit -qm snapshot
    git -C "$d" remote add origin "$d.git"; git -C "$d" push -q -u origin main 2>/dev/null
}
make_skill_src "$SETUP_ROOT/src"
setup_label() {   # <skill 目录> <配置追加内容> → setup.sh 实际建的等待标签（颜色 f9a8d4 那一条），没建输出空
    local src="$1" extra="$2" H="$SETUP_ROOT/h" HOST="$SETUP_ROOT/projects/widget"
    rm -rf "$H" "$SETUP_ROOT/projects"; mkdir -p "$H" "$SETUP_ROOT/projects"
    git init -q -b main "$HOST"; git -C "$HOST" -c user.email=t@x -c user.name=t commit -q --allow-empty -m init
    # 和真实安装一样以配置模板打底，再追加本测试的覆盖项（后写的赋值生效）
    { cat "$REPO_DIR/cavil-loop.config.example"
      printf 'REPO="acme/widget"\nPROJECT_ROOT="%s"\nSTATE_DIR="%s/state"\nWORKTREE_BASE="%s/wt"\nTMUX_PREFIX="widget"\n' "$HOST" "$H" "$H"
      printf '%s\n' "$extra"; } > "$HOST/cavil-loop.config"
    printf 'n\n' | env -u CAVIL_SKILL_LINK -u CAVIL_DEPLOY_ROOT -u CAVIL_DEPLOY_CONF -u CODING_AGENT_CONFIG \
        -u CODING_AGENT_RELEASE_ROOT -u WORKER_AGENT HOME="$H" PATH="$SETUP_ROOT/fakebin:$PATH" GH_LOG="$H/gh.log" \
        bash "$src/setup.sh" "$HOST" > "$H/setup.out" 2>&1 || { echo "SETUP-FAILED"; return; }
    grep -- '--color f9a8d4' "$H/gh.log" | sed -E 's/^label create (.*) --color f9a8d4.*/\1/' | head -1
}
lib_label() {   # <配置追加内容> → 公共库对同一份配置挑出的等待标签名
    local f="$SETUP_ROOT/lib.config"
    { cat "$REPO_DIR/cavil-loop.config.example"
      printf 'REPO="acme/widget"\nSTATE_DIR="%s/libstate"\nPROJECT_ROOT="%s"\nWORKTREE_BASE="%s/wt"\nTMUX_PREFIX="widget"\n' "$SETUP_ROOT" "$SETUP_ROOT" "$SETUP_ROOT"
      printf '%s\n' "$1"; } > "$f"
    env CODING_AGENT_CONFIG="$f" bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; printf %s "$LABEL_PENDING_REQUESTER_BOT"' _ "$REPO_DIR"
}
SETUP_CASES='只填新名字|LABEL_PENDING_REQUESTER_BOT="w/new"|w/new
只填旧名字|LABEL_PENDING_RELAY="w/old"|w/old
新旧都填：用新的|LABEL_PENDING_RELAY="w/old";LABEL_PENDING_REQUESTER_BOT="w/new"|w/new
都不填：不建|X=1|'
setup_suite() {   # <skill 目录>
    local src="$1" name cfg want got lib
    while IFS='|' read -r name cfg want; do
        [ -n "$name" ] || continue
        cfg=$(printf '%s' "$cfg" | tr ';' '\n')
        got=$(setup_label "$src" "$cfg")
        lib=$(lib_label "$cfg")
        chk "setup.sh 真跑 · $name：实际建的等待标签" "$got" "$want"
        chk "setup.sh 真跑 · $name：与公共库挑出的名字相同" "$got" "$lib"
        chk "setup.sh 真跑 · $name：公共库确实读到了配置（对拍不是两边都空）" "$(lib_label 'REQUESTER_BOT_ACCOUNT="probe"' >/dev/null; env CODING_AGENT_CONFIG="$SETUP_ROOT/lib.config" bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; printf %s "$REQUESTER_BOT_ACCOUNT"' _ "$REPO_DIR")" probe
    done <<< "$SETUP_CASES"
}
setup_suite "$SETUP_ROOT/src"
# 负对照：只改坏安装入口那一处（只读新名字），公共库不动 → 「只填旧名字」必须变红
if ! mutation_on; then neg "安装入口只读新名字（公共库不动）" :      # 关着：只计数
elif cp -r "$SETUP_ROOT/src" "$SETUP_ROOT/src-mut" && python3 - "$SETUP_ROOT/src-mut/setup.sh" <<'PYM'
import sys
p = sys.argv[1]; s = open(p).read()
old = '"$(config_value LABEL_PENDING_RELAY)")"'
if s.count(old) != 1: sys.exit(1)
open(p, "w").write(s.replace(old, '"")"'))
PYM
then neg "安装入口只读新名字（公共库不动）" setup_suite "$SETUP_ROOT/src-mut"
else prep_failed setup-only-new "原文找不到"
fi

echo "── 5. 代码和配置模板里不出现具体机器人名 ──"
# 文档的接入示例一节可以点名（issue 讨论定的），代码、提示词、配置模板、测试夹具都不行
chk "scripts/ prompts/ 配置模板 setup.sh 里没有 grokbot" \
    "$(grep -rli grokbot "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$REPO_DIR/cavil-loop.config.example" "$REPO_DIR/setup.sh" 2>/dev/null | wc -l | tr -d ' ')" 0
# GitHub#102：首页「可以调的地方」那一行和单独的对接文档以 grokbot 为例，其余文档不点名
chk "文档里只有首页那一行和对接文档点名" \
    "$(grep -rli grokbot "$REPO_DIR/docs" "$REPO_DIR/README.md" "$REPO_DIR/README.zh.md" "$REPO_DIR/AGENTS.md" "$REPO_DIR/AGENTS.zh.md" 2>/dev/null | sed "s|$REPO_DIR/||" | LC_ALL=C sort | paste -sd,)" "README.md,README.zh.md,docs/requester-bot.md,docs/requester-bot.zh.md"
chk "首页只在「可以调的地方」和「深入阅读」各一行点名" \
    "$(cat "$REPO_DIR/README.md" "$REPO_DIR/README.zh.md" | grep -ci grokbot)" 4


echo "── 6. 说法：不再把这个功能叫「传话」（GitHub#97） ──"
# 复盘记录是历史，不改；其余给人看的文字都不该再出现
chk "仓库里（复盘记录除外）不再出现「传话」" \
    "$(grep -rl '传话' "$REPO_DIR" --exclude-dir=.git --exclude-dir=retrospectives --exclude=requester-bot.test.sh 2>/dev/null | sed "s|$REPO_DIR/||" | paste -sd,)" ""
chk "英文文档里不再叫它 relay bot" \
    "$(grep -rli 'relay bot' "$REPO_DIR" --exclude-dir=.git --exclude-dir=retrospectives --exclude=requester-bot.test.sh 2>/dev/null | sed "s|$REPO_DIR/||" | paste -sd,)" ""
# 对接文档（GitHub#102）里的页内链接、以及别处指向对接文档的链接，锚点都必须真有对应标题
anchor_of() { python3 -c '
import re,sys
for l in open(sys.argv[1]):
    m=re.match(r"#+ (.*)",l)
    if m:
        t=m.group(1).strip().lower()
        t=re.sub(r"[^\w\- ]","",t)   # GitHub：去标点，保留字母数字（含中文）、空格、-
        print(t.replace(" ","-"))' "$1"; }
chk "指向对接文档的链接锚点都对得上" \
    "$(for f in requester-bot.md requester-bot.zh.md; do
         anchors=$(anchor_of "$REPO_DIR/docs/$f")
         { grep -hoE "\]\(#[^)]*\)" "$REPO_DIR/docs/$f" | sed 's/^](#//; s/)$//'
           grep -rhoE "$f#[^)]*" "$REPO_DIR"/docs "$REPO_DIR"/*.md "$REPO_DIR/cavil-loop.config.example" | sed "s|^$f#||"; } \
           | sort -u | while IFS= read -r a; do grep -qxF "$a" <<<"$anchors" || echo "$f#$a"; done
       done | paste -sd,)" ""
chk "指向对接文档的链接文件都在" \
    "$(grep -rhoE '(docs/)?requester-bot(\.zh)?\.md' "$REPO_DIR"/docs "$REPO_DIR"/*.md "$REPO_DIR/cavil-loop.config.example" | sed 's|^docs/||' | sort -u \
        | while read -r f; do [ -f "$REPO_DIR/docs/$f" ] || echo "$f"; done | paste -sd,)" ""
# 改了章节标题，指过去的链接都要跟着改：文档里每个指向本节的锚点都必须真有这一节
chk "文档里指向外部需求机器人一节的链接都对得上" \
    "$(grep -rhoE 'collaboration(\.zh)?\.md#[^)]*' "$REPO_DIR"/docs "$REPO_DIR"/*.md "$REPO_DIR/cavil-loop.config.example" 2>/dev/null | sort -u \
        | while IFS='#' read -r f a; do
            case "$f" in *zh*) h='## 外部需求机器人' ;; *) h='## External requester bot' ;; esac
            case "$a" in 外部需求机器人|external-requester-bot) grep -qxF "$h" "$REPO_DIR/docs/$f" || echo "$f#$a" ;; *需求机器人*|*requester*) echo "$f#$a" ;; esac
          done | paste -sd,)" ""

# ─────────────────────────────────────────────────────────────────────────
echo "── 汇总 ──"
if [ -s "$PREP_FAILED" ]; then
    echo "  ❌ 有 $(wc -l < "$PREP_FAILED" | tr -d ' ') 个负对照没准备成功（没跑）："
    sed 's/^/     · /' "$PREP_FAILED"
    fail=$((fail + $(wc -l < "$PREP_FAILED")))
fi
mutation_summary "$0"
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
