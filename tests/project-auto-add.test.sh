#!/usr/bin/env bash
# 守护程序把本仓库 issue / PR 自动加进 Project 的守卫 —— GitHub#116。
#
# 跑法：bash tests/project-auto-add.test.sh              （默认不跑负对照，约 1 分钟）
#       MUTATION=1 bash tests/project-auto-add.test.sh   （连 16 项负对照一起跑；见 tests/lib/mutation.sh）
#       ONLY=s_basic bash tests/project-auto-add.test.sh  （只跑一组场景，排查用）
# 依赖：jq、python3。不碰网络：假 gh（tests/fixtures/project-auto-add-fake-gh.py）是带状态的最小
# GitHub——多个 Project、每个 Project 谁能读谁能写、条目分页、按段 / 按页的故障注入——每次调用
# 记一行，写请求带着调用时的身份名。
#
# 每一轮都**真的**起 agent-poll.sh 子进程（派工脚本换成只记一行的桩），所以「同步出错时派工照常」
# 是数派工记录数出来的，「这一轮发了几次写请求、用的哪把令牌」是数调用记录数出来的。
#
# 这块错了都不报错，只会悄悄变成别的样子：
#   · 已在里面也写 → 每分钟对每个条目发一次写请求（bot 号因请求量被封过一次）；
#   · 只读第一页 / 首次也只看最近窗口 → 老的开着的条目永远进不去；
#   · 候选只认开着的 → 停机期间新建又关掉的条目漏掉；不挡开启前已关闭的 → 有人评论老 issue 就被拉进去；
#   · 失败也推进同步时间 / 失败也标「首次已完成」/ 每次重试重写开启时间 → 漏掉的条目再也补不回来；
#   · 读身份看不见 Project 还去写 → 每个条目都显得「不在里面」，每轮全量写一遍；
#   · 一个 Project 读失败拖住另一个 → 新加的看板读不全时，老看板也停止同步；
#   · 新加看板触发的全量读取让老看板也顺手补老条目 → 人从老看板里拿掉的卡片被塞回去。
# 末尾的负对照（MUTATION=1）把这 16 种错误分别塞进脚本副本，断言对应场景变红。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"
FAKE="$TEST_DIR/fixtures/project-auto-add-fake-gh.py"

unset CODING_AGENT_RELEASE_ROOT CLAUDE_PLUGIN_ROOT CAVIL_DEPLOY_ROOT CAVIL_DEPLOY_CONF \
      CODING_AGENT_CONFIG CODING_AGENT_RELEASE_LEASE_FD TICK_DIR GH_TOKEN WRITE_GH_TOKEN PROJECT_GH_TOKEN

SANDBOX=$(mktemp -d)
cleanup() { [ -n "${KEEP_SANDBOX:-}" ] && { echo "SANDBOX=$SANDBOX"; return 0; }; rm -rf "$SANDBOX"; }
trap cleanup EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 -I "$FAKE"

POLL_TOKEN="ghp_POLL0000000000000000000000000000000"
READ_TOKEN="ghp_READ1111111111111111111111111111111"
WRITE_TOKEN="ghp_WRIT2222222222222222222222222222222"

pass=0; fail=0; QUIET=0
chk() {
    if [ "$2" = "$3" ]; then [ "$QUIET" = 1 ] || echo "  ✅ $1"; pass=$((pass+1))
    else [ "$QUIET" = 1 ] || echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}
PREP_FAILED="$SANDBOX/prep-failed"; : > "$PREP_FAILED"

# ── 被测脚本副本：派工脚本换成桩（记一行），其余原样 ──
make_copy() {   # <目标目录>
    local dst="$1" f
    rm -rf "$dst"; mkdir -p "$dst"
    cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$dst/"
    for f in dispatch-new-issue dispatch-issue-comment dispatch-pr-comment; do
        cat > "$dst/scripts/$f.sh" <<'STUB'
#!/usr/bin/env bash
echo "$(basename "$0" .sh) $1" >> "$FAKE_GH_DIR/dispatch.log"
STUB
    done
}
SCRIPTS_REAL="$SANDBOX/real"
make_copy "$SCRIPTS_REAL"
SCRIPTS="$SCRIPTS_REAL"

iso_ago() { date -u -d "@$(( $(date +%s) - $1 ))" +%Y-%m-%dT%H:%M:%SZ; }
iso_plus() { jq -rn --arg t "$1" --argjson s "$2" '($t | fromdateiso8601) + $s | todateiso8601'; }
DAY=86400

# ── 一个运行环境 ──
# new_env <projects 配置值> [KEY=VAL...]：默认单令牌（所有读写都是 poll 身份）
new_env() {
    local projects="$1"; shift
    W="$SANDBOX/w"
    rm -rf "$W"; mkdir -p "$W/state" "$W/gh" "$W/wt" "$W/project"
    cat > "$W/cavil-loop.config" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="paatest$$"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
MAX_CONCURRENT_WORKERS=50
POST_MERGE_RETROSPECTIVE=false
AUTO_CLEANUP_ON_MERGE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
WORKER_SECRET_ENV=""
GH_TOKEN="$POLL_TOKEN"
AUTO_ADD_PROJECTS="$projects"
PATH="$SANDBOX/bin:\$PATH"
CONF
    local kv; for kv in "$@"; do printf '%s\n' "$kv" >> "$W/cavil-loop.config"; done
    chmod 600 "$W/cavil-loop.config"
    jq -n --arg p "$POLL_TOKEN" --arg r "$READ_TOKEN" --arg w "$WRITE_TOKEN" '{
        repo: "acme/widget",
        tokens: {($p): "poll", ($r): "read", ($w): "write"},
        owners: {myorg: "org", alice: "user"},
        projects: {
          "myorg/4":  {id: "PVT_A", readers: ["poll"], writers: ["poll"]},
          "myorg/11": {id: "PVT_B", readers: ["poll"], writers: ["poll"]},
          "alice/2":  {id: "PVT_U", readers: ["poll"], writers: ["poll"]}
        },
        items: [],
        rest_issues: [{number: 900, labels: ["pending/agent"]}],
        faults: []
    }' > "$W/gh/world.json"
    : > "$W/gh/calls.log"; : > "$W/gh/dispatch.log"
}
world() { jq "$@" "$W/gh/world.json" > "$W/gh/world.tmp" && mv "$W/gh/world.tmp" "$W/gh/world.json"; }
# add_item <id> <number> <issue|pr> <OPEN|CLOSED|MERGED> <createdAt> <updatedAt> [project id...]
add_item() {
    local id="$1" n="$2" kind="$3" st="$4" c="$5" u="$6"; shift 6
    local ps; ps=$(jq -cn '$ARGS.positional' --args "$@")   # --args 会吞掉后面的文件名，单独先拼好
    world --arg id "$id" --argjson n "$n" --arg k "$kind" --arg s "$st" --arg c "$c" --arg u "$u" --argjson ps "$ps" \
        '.items += [{id: $id, number: $n, kind: $k, state: $s, createdAt: $c, updatedAt: $u, projects: $ps}]'
}
set_item() { world --arg id "$1" --argjson v "$3" "(.items[] | select(.id == \$id)).$2 = \$v"; }
add_fault() { world --argjson f "$1" '.faults += [$f]'; }
clear_faults() { world '.faults = []'; }
tick() {
    : > "$W/gh/calls.log"; : > "$W/gh/dispatch.log"
    env FAKE_GH_DIR="$W/gh" CODING_AGENT_CONFIG="$W/cavil-loop.config" bash "$SCRIPTS/scripts/agent-poll.sh" >/dev/null 2>&1
}
n_calls() { grep -cE -- "$1" "$W/gh/calls.log" 2>/dev/null || true; }
writes() { n_calls "^WRITE .* ok\$"; }
writes_to() { n_calls "^WRITE .*project=$1 content=$2 ok\$"; }
write_tries() { n_calls "^WRITE "; }
reads() { n_calls "^READ "; }
dispatched() { grep -c "dispatch-new-issue 900" "$W/gh/dispatch.log" 2>/dev/null || true; }
in_proj() { jq -r --arg id "$1" --arg p "$2" '.items[] | select(.id == $id) | .projects | index($p) != null' "$W/gh/world.json"; }
st() { jq -r --arg k "$1" --arg f "$2" '.projects[$k][$f] // "" | tostring' "$W/state/project-auto-add.json" 2>/dev/null; }
warns() { grep -c "自动加入 Project：$1" "$W/state/poll.log" 2>/dev/null || true; }
yes_if() { if eval "$1"; then echo yes; else echo no; fi; }
# 把某个 Project 的状态直接设成「已完成首次、上次同步在 N 秒前」
seed_done() {   # <key> <pid> <enabled 几秒前> <last_sync 几秒前>
    local f="$W/state/project-auto-add.json"
    [ -f "$f" ] || echo '{}' > "$f"
    jq --arg k "$1" --arg p "$2" --arg e "$(iso_ago "$3")" --arg l "$(iso_ago "$4")" \
        '.projects[$k] = {project_id: $p, enabled_at: $e, initial_done: true, last_sync: $l}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}

# ═════════════════════════════════════════════════════════════════════════
# 场景：每个函数一组，负对照拿同一个函数在改坏的副本上重跑
# ═════════════════════════════════════════════════════════════════════════

s_disabled() {
    [ "$QUIET" = 1 ] || echo "【1】配置留空 → 一次相关调用都不发，派工照常"
    new_env ""
    add_item I_1 1 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)"
    tick
    chk "Project 相关调用 0 次（读 / 解析 / 写 / 补翻）" "$(n_calls '^(READ|RESOLVE|WRITE|ITEMS) ')" 0
    chk "没有生成同步状态文件" "$(yes_if "[ -e '$W/state/project-auto-add.json' ]")" no
    chk "到达性 · 这一轮照常派工" "$(dispatched)" 1
    chk "到达性 · 这一轮确实读了 GitHub" "$(yes_if "[ $(n_calls '^REST GET repos/acme/widget/issues') -gt 0 ]")" yes
}

s_basic() {
    [ "$QUIET" = 1 ] || echo "【2】已在 Project 的不写；不在的恰好写 1 次；两个 Project 只补缺的那个"
    new_env "myorg/4 myorg/11"
    add_item I_1 1 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)" PVT_A PVT_B
    add_item I_2 2 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)" PVT_A
    add_item P_3 3 pr OPEN "$(iso_ago $DAY)" "$(iso_ago 60)"
    tick
    chk "到达性 · 读了条目" "$(yes_if "[ $(reads) -gt 0 ]")" yes
    chk "#1 两边都在 → 对它写 0 次" "$(n_calls '^WRITE .*content=I_1 ')" 0
    chk "#2 只缺 B → 只往 B 写 1 次" "$(writes_to PVT_B I_2) $(n_calls '^WRITE .*project=PVT_A content=I_2 ')" "1 0"
    chk "PR #3 两边都缺 → 各写 1 次" "$(writes_to PVT_A P_3) $(writes_to PVT_B P_3)" "1 1"
    chk "总写请求恰好 3 次" "$(write_tries)" 3
    chk "派工照常" "$(dispatched)" 1
    chk "A 首次全量完成" "$(st myorg/4 initial_done)" true
    tick
    chk "下一轮：全都在了 → 写 0 次" "$(write_tries)" 0
    chk "到达性 · 下一轮确实又读了" "$(yes_if "[ $(reads) -gt 0 ]")" yes
    chk "下一轮只发 1 次读请求（issue 与 PR 合在一次里）" "$(reads)" 1
}

s_paging() {
    [ "$QUIET" = 1 ] || echo "【3】开着的条目超过 100 个：第二页里缺的也被加上"
    new_env "myorg/4"
    local n
    for n in $(seq 1 150); do
        if [ "$n" = 130 ]; then add_item "I_$n" "$n" issue OPEN "$(iso_ago $((300 * DAY - n)))" "$(iso_ago $((200 * DAY - n)))"
        else add_item "I_$n" "$n" issue OPEN "$(iso_ago $((300 * DAY - n)))" "$(iso_ago $((200 * DAY - n)))" PVT_A; fi
    done
    tick
    chk "第二页里的 #130 被加上" "$(writes_to PVT_A I_130)" 1
    chk "只写了这一个" "$(write_tries)" 1
    chk "全部开着的那条流读了第 2 页" "$(n_calls '^READ .*oi:2')" 1
    chk "首次全量完成" "$(st myorg/4 initial_done)" true
}

s_tokens() {
    [ "$QUIET" = 1 ] || echo "【4】读写分开配置：读令牌只读、写令牌能写 → 加入成功，各用各的"
    new_env "myorg/4" "PROJECT_GH_TOKEN=\"$READ_TOKEN\"" "WRITE_GH_TOKEN=\"$WRITE_TOKEN\""
    world '.projects["myorg/4"].readers = ["read"] | .projects["myorg/4"].writers = ["write"]'
    add_item I_1 1 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)"
    tick
    chk "加入成功" "$(in_proj I_1 PVT_A)" true
    chk "写请求用写令牌" "$(n_calls '^WRITE token=write .* ok$')" 1
    chk "没有用别的令牌写" "$(n_calls '^WRITE token=(poll|read) ')" 0
    chk "读请求全部用读令牌" "$(n_calls '^(READ|RESOLVE) token=read ') / $(n_calls '^(READ|RESOLVE) ')" \
        "$(n_calls '^(READ|RESOLVE) ') / $(n_calls '^(READ|RESOLVE) ')"
    chk "到达性 · 确实读过" "$(yes_if "[ $(reads) -gt 0 ]")" yes
}

s_write_denied() {
    [ "$QUIET" = 1 ] || echo "【5】写入身份没权限：记警告、派工照常、不推进、每轮只试 1 次"
    new_env "myorg/4"
    world '.projects["myorg/4"].writers = []'
    add_item I_1 1 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)"
    add_item I_2 2 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)"
    tick
    chk "试写了，没成功" "$(write_tries) $(writes)" "1 0"
    chk "日志里有警告" "$(yes_if "[ $(warns 'myorg/4：.*写入失败') -ge 1 ]")" yes
    chk "派工照常" "$(dispatched)" 1
    chk "没有标首次完成" "$(st myorg/4 initial_done)" ""
    chk "同步时间没写" "$(st myorg/4 last_sync)" ""
    local en; en=$(st myorg/4 enabled_at)
    tick
    chk "第二轮同样的警告不重复写日志" "$(warns 'myorg/4：.*写入失败')" 1
    chk "开启时间不变" "$(st myorg/4 enabled_at)" "$en"
}

s_read_fail() {
    [ "$QUIET" = 1 ] || echo "【6】读失败 / 配置格式错：记警告、派工照常、同步时间不推进"
    new_env "myorg/4"
    add_item I_1 1 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)" PVT_A
    seed_done myorg/4 PVT_A $((5 * DAY)) 3600
    local before; before=$(st myorg/4 last_sync)
    add_fault '{"op":"read","all":true}'
    tick
    chk "读失败：有警告" "$(yes_if "[ $(warns 'myorg/4：.*读取失败') -ge 1 ]")" yes
    chk "读失败：派工照常" "$(dispatched)" 1
    chk "读失败：同步时间不推进" "$(st myorg/4 last_sync)" "$before"
    chk "读失败：写 0 次" "$(write_tries)" 0
    clear_faults
    tick
    chk "恢复后推进" "$(yes_if "[[ '$(st myorg/4 last_sync)' > '$before' ]]")" yes

    new_env "myorg/4 foo bar/x myorg/11"
    add_item I_1 1 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)"
    tick
    chk "格式错：点名报出那两项" "$(grep -c '格式不对.*foo bar/x' "$W/state/poll.log" 2>/dev/null || true)" 1
    chk "格式错：其余 Project 照常加入" "$(writes_to PVT_A I_1) $(writes_to PVT_B I_1)" "1 1"
    chk "格式错：派工照常" "$(dispatched)" 1
    tick
    chk "格式错：下一轮不重复刷同一条警告" "$(grep -c '格式不对' "$W/state/poll.log" 2>/dev/null || true)" 1

    new_env "myorg/99 alice/2"
    add_item I_1 1 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)"
    tick
    chk "编号不存在：点名报出" "$(yes_if "[ $(warns 'myorg/99：.*找不到') -ge 1 ]")" yes
    chk "编号不存在：不往任何地方写它" "$(n_calls '^WRITE .*project= ')" 0
    chk "用户名下的 Project 照常解析、加入" "$(writes_to PVT_U I_1)" 1
    chk "编号不存在：派工照常" "$(dispatched)" 1
}

s_candidates() {
    [ "$QUIET" = 1 ] || echo "【7】加哪些：停机期间新建又关掉的加；开启前已关闭的老条目不加；重新打开的加"
    new_env "myorg/4"
    seed_done myorg/4 PVT_A $((30 * DAY)) $((3 * DAY))   # 停机 3 天
    add_item I_10 10 issue CLOSED "$(iso_ago $((2 * DAY)))" "$(iso_ago DAY)"          # 停机期间新建并关闭
    add_item P_11 11 pr MERGED "$(iso_ago $((2 * DAY)))" "$(iso_ago DAY)"             # 停机期间新建并合并
    add_item I_12 12 issue CLOSED "$(iso_ago $((90 * DAY)))" "$(iso_ago 300)"         # 开启前就关了，刚有人评论
    add_item I_13 13 issue OPEN "$(iso_ago $((90 * DAY)))" "$(iso_ago 300)"           # 开启前的老条目，刚重新打开
    tick
    chk "停机期间新建并关闭的 issue 被加入" "$(writes_to PVT_A I_10)" 1
    chk "停机期间新建并合并的 PR 被加入" "$(writes_to PVT_A P_11)" 1
    chk "开启前已关闭、刚有人评论 → 写 0 次" "$(n_calls '^WRITE .*content=I_12 ')" 0
    chk "重新打开的老条目被加入" "$(writes_to PVT_A I_13)" 1
    chk "到达性 · #12 确实在这一轮读到的范围里" "$(yes_if "[ $(reads) -ge 1 ]")" yes
    chk "全部成功 → 同步时间推进" "$(yes_if "[[ '$(st myorg/4 last_sync)' > '$(iso_ago 120)' ]]")" yes
}

s_first_enable() {
    [ "$QUIET" = 1 ] || echo "【8】首次启用：开了很久、更新时间远早于现在的开着的条目也被加入"
    new_env "myorg/4"
    add_item I_1 1 issue OPEN "$(iso_ago $((400 * DAY)))" "$(iso_ago $((300 * DAY)))"
    add_item I_2 2 issue CLOSED "$(iso_ago $((400 * DAY)))" "$(iso_ago $((300 * DAY)))"
    tick
    chk "很久没动的开着的 #1 被加入" "$(writes_to PVT_A I_1)" 1
    chk "早就关了的 #2 不加" "$(n_calls '^WRITE .*content=I_2 ')" 0
    chk "首次全量完成" "$(st myorg/4 initial_done)" true
}

s_add_second() {
    [ "$QUIET" = 1 ] || echo "【9】A 已完成后配置里新加 B：老的开着条目补进 B，对 A 写 0 次"
    new_env "myorg/4 myorg/11"
    seed_done myorg/4 PVT_A $((30 * DAY)) 600
    add_item I_1 1 issue OPEN "$(iso_ago $((100 * DAY)))" "$(iso_ago $((50 * DAY)))" PVT_A
    add_item I_2 2 issue OPEN "$(iso_ago $((100 * DAY)))" "$(iso_ago $((50 * DAY)))"
    tick
    chk "#1 补进 B" "$(writes_to PVT_B I_1)" 1
    chk "对 A 写 0 次（A 只看最近更新，#2 不在它的窗口里）" "$(n_calls '^WRITE .*project=PVT_A ')" 0
    chk "B 首次全量完成" "$(st myorg/11 initial_done)" true
    chk "A 照常推进" "$(yes_if "[[ '$(st myorg/4 last_sync)' > '$(iso_ago 120)' ]]")" yes
}

s_isolation_write() {
    [ "$QUIET" = 1 ] || echo "【10】第一个 Project 写失败、第二个正常：第二个照常加入并推进，第一个不推进"
    new_env "myorg/4 myorg/11"
    seed_done myorg/4 PVT_A $((30 * DAY)) 3600
    seed_done myorg/11 PVT_B $((30 * DAY)) 3600
    local a_before; a_before=$(st myorg/4 last_sync)
    add_item I_1 1 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)"
    add_fault '{"op":"write","project":"PVT_A"}'
    tick
    chk "B 照常加入" "$(writes_to PVT_B I_1)" 1
    chk "B 推进" "$(yes_if "[[ '$(st myorg/11 last_sync)' > '$a_before' ]]")" yes
    chk "A 不推进" "$(st myorg/4 last_sync)" "$a_before"
    chk "派工照常" "$(dispatched)" 1
}

s_initial_retry() {
    [ "$QUIET" = 1 ] || echo "【11】首次全量第二页读失败 / 某笔写失败：不标完成、不推进、开启时间不变；下一轮补齐"
    new_env "myorg/4"
    local n
    # 250 个：「最近更新」第一页是 #151–#250，「全部开着的」第一页是 #1–#100，第二页 #101–#200
    # 失败 → #101–#150 这一轮谁都拿不到
    for n in $(seq 1 250); do add_item "I_$n" "$n" issue OPEN "$(iso_ago $((300 * DAY - n)))" "$(iso_ago $((200 * DAY - n)))"; done
    add_fault '{"op":"read","seg":"oi","page":2,"times":1}'
    tick
    local en; en=$(st myorg/4 enabled_at)
    chk "第一页的条目先加进去了" "$(writes_to PVT_A I_1)" 1
    chk "失败那页独有的 #120 这一轮没加" "$(in_proj I_120 PVT_A)" false
    chk "读失败 → 不标完成" "$(st myorg/4 initial_done)" ""
    chk "读失败 → 同步时间没写" "$(st myorg/4 last_sync)" ""
    chk "到达性 · 确实读到了第 2 页（失败的那页）" "$(n_calls '^READ .*oi:2')" 1
    add_fault '{"op":"write","content":"I_120","times":1}'
    tick
    chk "第二轮：已加的不再写" "$(n_calls '^WRITE .*content=I_1 ')" 0
    chk "第二轮：#120 之前缺的补上了" "$(writes_to PVT_A I_101)" 1
    chk "第二轮：写失败 → 仍不标完成" "$(st myorg/4 initial_done)" ""
    chk "第二轮：同步时间没写" "$(st myorg/4 last_sync)" ""
    chk "第二轮：开启时间不变" "$(st myorg/4 enabled_at)" "$en"
    tick
    chk "第三轮：剩下的补齐" "$(writes_to PVT_A I_120) $(writes_to PVT_A I_150)" "1 1"
    chk "第三轮：首次全量完成" "$(st myorg/4 initial_done)" true
    chk "开启时间仍是第一次尝试的时刻" "$(st myorg/4 enabled_at)" "$en"
    chk "全程 250 个条目每个都在、只在一次" "$(jq '[.items[] | select(.projects == ["PVT_A"])] | length' "$W/gh/world.json")" 250
}

s_restart() {
    [ "$QUIET" = 1 ] || echo "【12】首次全量失败 → 期间新建条目 X 并关闭 → 进程重启 → 重试成功：X 被加入"
    new_env "myorg/4"
    add_item I_1 1 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)"
    add_fault '{"op":"read","all":true}'
    tick
    local en; en=$(st myorg/4 enabled_at)
    chk "失败后开启时间已落盘" "$(yes_if "[ -n '$en' ]")" yes
    chk "失败后没标完成" "$(st myorg/4 initial_done)" ""
    clear_faults
    sleep 2   # 让「重试时的当前时间」一定晚于开启时间（开启时间按秒记）
    add_item I_9 9 issue CLOSED "$(iso_plus "$en" 1)" "$(iso_plus "$en" 1)"
    tick       # 每一轮都是新进程 = 重启
    chk "X 被加入" "$(writes_to PVT_A I_9)" 1
    chk "开启时间仍是第一次尝试的时刻" "$(st myorg/4 enabled_at)" "$en"
    chk "首次全量完成" "$(st myorg/4 initial_done)" true
}

s_read_isolation() {
    [ "$QUIET" = 1 ] || echo "【13】A 已完成、新加 B；B 才需要的后续页读失败 → A 推进，B 不推进，下一轮 B 完成"
    new_env "myorg/4 myorg/11"
    seed_done myorg/4 PVT_A $((30 * DAY)) 600
    local a_before; a_before=$(st myorg/4 last_sync)
    local n
    for n in $(seq 1 250); do add_item "I_$n" "$n" issue OPEN "$(iso_ago $((300 * DAY - n)))" "$(iso_ago $((200 * DAY - n)))" PVT_A; done
    add_item I_500 500 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)"   # 最近更新的，A 和 B 都缺
    add_fault '{"op":"read","seg":"oi","page":2,"times":1}'
    tick
    chk "A：最近更新的 #500 加入" "$(writes_to PVT_A I_500)" 1
    chk "A：推进" "$(yes_if "[[ '$(st myorg/4 last_sync)' > '$a_before' ]]")" yes
    chk "B：不标完成" "$(st myorg/11 initial_done)" ""
    chk "B：不推进" "$(st myorg/11 last_sync)" ""
    local en; en=$(st myorg/11 enabled_at)
    chk "到达性 · B 独有的那页确实失败过" "$(n_calls '^READ .*oi:2')" 1
    chk "第一轮 B 还没拿到失败那页独有的 #120" "$(in_proj I_120 PVT_B)" false
    tick
    chk "下一轮 B 完成" "$(st myorg/11 initial_done)" true
    chk "B 的开启时间不变" "$(st myorg/11 enabled_at)" "$en"
    chk "B 补齐了第二页的条目" "$(in_proj I_120 PVT_B)" true

    [ "$QUIET" = 1 ] || echo "【14】A、B 都需要的那页失败 → 两个都不推进"
    new_env "myorg/4 myorg/11"
    seed_done myorg/4 PVT_A $((30 * DAY)) 600
    seed_done myorg/11 PVT_B $((30 * DAY)) 600
    # A、B 各自记下自己的起点：两次 seed_done 各取一次当前时间，跨秒时两者差 1 秒（CI 上实际出现过）
    a_before=$(st myorg/4 last_sync); local b_before; b_before=$(st myorg/11 last_sync)
    add_item I_1 1 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)" PVT_A PVT_B
    add_fault '{"op":"read","seg":"ri","page":1,"times":1}'
    tick
    chk "A 不推进" "$(st myorg/4 last_sync)" "$a_before"
    chk "B 不推进" "$(st myorg/11 last_sync)" "$b_before"
    chk "派工照常" "$(dispatched)" 1
}

s_item_projects() {
    [ "$QUIET" = 1 ] || echo "【15】条目挂的 Project 超过一页：补翻后判断；补翻失败 → 不写、不推进"
    new_env "myorg/4"
    local many=() n
    for n in $(seq 1 25); do many+=("PVT_X$n"); world --arg p "PVT_X$n" '.projects[$p] = {id: $p, readers: ["poll"], writers: []}'; done
    seed_done myorg/4 PVT_A $((30 * DAY)) 3600
    local before; before=$(st myorg/4 last_sync)
    add_item I_1 1 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)" "${many[@]}" PVT_A   # A 排在第 26 张
    tick
    chk "补翻了一次" "$(n_calls '^ITEMS ')" 1
    chk "补翻后认出已在 A 里 → 写 0 次" "$(write_tries)" 0
    chk "推进" "$(yes_if "[[ '$(st myorg/4 last_sync)' > '$before' ]]")" yes
    before=$(st myorg/4 last_sync)
    set_item I_1 updatedAt "\"$(iso_ago 1)\""
    add_fault '{"op":"items"}'
    tick
    chk "补翻失败 → 写 0 次" "$(write_tries)" 0
    chk "补翻失败 → 不推进" "$(st myorg/4 last_sync)" "$before"
    chk "到达性 · 确实去补翻了" "$(n_calls '^ITEMS ')" 1
}

s_read_blind() {
    [ "$QUIET" = 1 ] || echo "【16】读身份看不见 Project（缓存的 id 还在）→ 一个写请求都不发"
    new_env "myorg/4"
    seed_done myorg/4 PVT_A $((30 * DAY)) 3600
    world '.projects["myorg/4"].readers = []'
    add_item I_1 1 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)" PVT_A
    add_item I_2 2 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)" PVT_A
    tick
    chk "写 0 次" "$(write_tries)" 0
    chk "到达性 · 读过" "$(yes_if "[ $(reads) -gt 0 ]")" yes
    chk "有警告" "$(yes_if "[ $(warns 'myorg/4：.*看不见') -ge 1 ]")" yes
    chk "派工照常" "$(dispatched)" 1
    tick
    chk "下一轮重新按编号解析、仍不写" "$(n_calls '^RESOLVE ') $(write_tries)" "2 0"
}

s_case() {
    [ "$QUIET" = 1 ] || echo "【17】同一个看板换一种大小写写法：沿用原进度，停机期间的条目照样补上；多个写法只写一次"
    local en
    # (a) 旧状态按配置原文的大小写记成 MyOrg/4，配置改写成 myorg/4
    new_env "myorg/4"
    seed_done MyOrg/4 PVT_A $((30 * DAY)) $((3 * DAY))
    en=$(st MyOrg/4 enabled_at)
    add_item I_10 10 issue CLOSED "$(iso_ago $((2 * DAY)))" "$(iso_ago DAY)"
    tick
    chk "旧状态大小写不同 → 停机期间新建又关掉的条目被加入" "$(writes_to PVT_A I_10)" 1
    chk "旧状态大小写不同 → 开启时间沿用" "$(st myorg/4 enabled_at)" "$en"
    chk "状态里只剩一份（归一成小写）" "$(jq -r '.projects | keys | join(",")' "$W/state/project-auto-add.json")" "myorg/4"

    # (b) 旧状态是 myorg/4，配置只改成 MYORG/4
    new_env "MYORG/4"
    seed_done myorg/4 PVT_A $((30 * DAY)) $((3 * DAY))
    en=$(st myorg/4 enabled_at)
    add_item I_10 10 issue CLOSED "$(iso_ago $((2 * DAY)))" "$(iso_ago DAY)"
    tick
    chk "只改配置大小写 → 停机期间的条目被加入" "$(writes_to PVT_A I_10)" 1
    chk "只改配置大小写 → 开启时间沿用" "$(st myorg/4 enabled_at)" "$en"
    chk "只改配置大小写 → 没有多出一份状态" "$(jq -r '.projects | keys | join(",")' "$W/state/project-auto-add.json")" "myorg/4"

    # (c) 同时写两种大小写
    new_env "myorg/4 MYORG/4"
    add_item I_1 1 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)"
    tick
    chk "两种大小写同时配置 → 同一条目只写 1 次" "$(write_tries)" 1
    chk "到达性 · 确实写进去了" "$(in_proj I_1 PVT_A)" true

    # (d) 状态里已经有两种大小写的两份：合并取最保守的（最早开启、最早同步）
    new_env "myorg/4"
    seed_done myorg/4 PVT_A $((30 * DAY)) $((3 * DAY))
    seed_done MYORG/4 PVT_A 3600 60
    en=$(st myorg/4 enabled_at)
    add_item I_10 10 issue CLOSED "$(iso_ago $((2 * DAY)))" "$(iso_ago DAY)"
    tick
    chk "两份状态合并 → 按更早的那份补上停机期间的条目" "$(writes_to PVT_A I_10)" 1
    chk "两份状态合并 → 开启时间取最早" "$(st myorg/4 enabled_at)" "$en"

    # (e) 两个不同写法（不只是大小写）落到同一个看板
    new_env "myorg/4 renamed-org/4"
    world '.owners["renamed-org"] = "org" | .projects["renamed-org/4"] = .projects["myorg/4"]'
    add_item I_1 1 issue OPEN "$(iso_ago $DAY)" "$(iso_ago 60)"
    tick
    chk "两个写法同一个看板 → 只写 1 次" "$(write_tries)" 1
    chk "两个写法同一个看板 → 日志点名跳过" "$(grep -c 'renamed-org/4：和 myorg/4 是同一个 Project' "$W/state/poll.log" 2>/dev/null || true)" 1
}

ALL_SCENARIOS=(s_disabled s_basic s_paging s_tokens s_write_denied s_read_fail s_candidates
               s_first_enable s_add_second s_isolation_write s_initial_retry s_restart
               s_read_isolation s_item_projects s_read_blind s_case)
for s in "${ONLY:-${ALL_SCENARIOS[@]}}"; do "$s"; done

# ═════════════════════════════════════════════════════════════════════════
echo "── 负对照：改坏一处，对应场景必须变红 ──"
# ═════════════════════════════════════════════════════════════════════════
MUT_RAN=0
mutate() {   # <名> <场景> <文件> <原文> <改成>
    local name="$1" scen="$2" file="$3" old="$4" new="$5"
    mutation_gate || return 0
    local D="$SANDBOX/mut-$name"
    make_copy "$D"
    if ! python3 - "$D/scripts/$file" "$old" "$new" <<'PY'
import sys
p, old, new = sys.argv[1:]
s = open(p).read()
if old not in s:
    sys.exit(1)
open(p, "w").write(s.replace(old, new, 1))
PY
    then
        echo "  ❌ 负对照「$name」准备失败：$file 里找不到要改的原文"; echo "$name" >> "$PREP_FAILED"; return 0
    fi
    local p0="$pass" f0="$fail"
    SCRIPTS="$D"; QUIET=1
    "$scen"
    SCRIPTS="$SCRIPTS_REAL"; QUIET=0
    local red=$((fail - f0))
    pass="$p0"; fail="$f0"; MUT_RAN=$((MUT_RAN + 1))
    chk "负对照「$name」→ $scen 变红（$red 条）" "$([ "$red" -gt 0 ] && echo red || echo green)" red
}
PAA=project-auto-add.sh
mutate "去掉已在里面就跳过" s_basic "$PAA" \
    '| select((.projects | index($p)) == null)]' ']'
mutate "去掉留空就关闭" s_disabled _lib.sh \
    "[ -n \"\$(printf '%s' \"\${AUTO_ADD_PROJECTS:-}\" | tr -d ' ,\\t\\n')\" ] || return 0" ':'
mutate "只读第一页" s_paging "$PAA" \
    'if [ "$nxt" != true ]; then' 'if true; then'
mutate "写操作改用读令牌" s_tokens "$PAA" \
    'r=$(gh_write api graphql -f p=' 'r=$(project_gh_graphql -f p='
mutate "候选只认开着的" s_candidates "$PAA" \
    '(.state == "OPEN" or .createdAt > $en)' '(.state == "OPEN")'
mutate "去掉开启前已关闭的不加" s_candidates "$PAA" \
    '(.state == "OPEN" or .createdAt > $en)' 'true'
mutate "已同步完的 Project 顺手补别人多读到的老条目" s_add_second "$PAA" \
    '($ini == "1" and .state == "OPEN")' '(.state == "OPEN")'
mutate "失败也推进同步时间" s_isolation_write "$PAA" \
    'if [ "$read_ok" = 1 ] && [ -z "$write_err" ] && [ "$unknown_n" = 0 ]; then' 'if true; then'
mutate "首次也只扫最近时间窗口" s_first_enable "$PAA" \
    '[ "${INITIAL[$k]}" = 1 ] && need_open=1' ':'
mutate "首次全量失败也写已完成" s_initial_retry "$PAA" \
    'paa_warn_once "$k" "$why，同步时间不推进，下一轮重试"' \
    'paa_set ".projects[\$k].initial_done = true" --arg k "$k"; paa_warn_once "$k" "$why，同步时间不推进，下一轮重试"'
mutate "开启时间改成每次重试的当前时间" s_restart "$PAA" \
    '[ -n "$(paa_get "$k" enabled_at)" ] || paa_set' 'paa_set'
mutate "读身份看不见 Project 仍去写" s_read_blind "$PAA" \
    'paa_warn_once "$k" "${WHY[$k]:-读取失败}，本轮不写"; continue' ':'
mutate "任意读失败就让所有 Project 都不推进" s_read_isolation "$PAA" \
    'covered ri "${CUT[$k]}" && covered rp "${CUT[$k]}" || read_ok=0' \
    '[ "${SEG_FAIL[ri]}${SEG_FAIL[rp]}${SEG_FAIL[oi]}${SEG_FAIL[op]}" = 0000 ] && covered ri "${CUT[$k]}" && covered rp "${CUT[$k]}" || read_ok=0'

mutate "配置里的组织名不归一大小写" s_case "$PAA" \
    '        t=$(paa_canon "$t")
' ''
mutate "已有状态的键不归一大小写" s_case "$PAA" \
    '| group_by(.key | ascii_downcase)
        | map({key: (.[0].key | ascii_downcase),' '| group_by(.key)
        | map({key: .[0].key,'
mutate "同一个看板的不同写法不去重" s_case "$PAA" \
    'if [ -n "${PID_OWNER[$pid]:-}" ]; then' 'if false; then'

if [ -s "$PREP_FAILED" ]; then fail=$((fail + $(wc -l < "$PREP_FAILED"))); fi
echo
mutation_summary "$0"
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
