#!/usr/bin/env bash
# kind: e2e
# 人手动关闭（「已完成」）的 issue 自动打 Done —— GitHub#159。
#
# 跑法：bash tests/closed-issue-done.test.sh              （默认不跑末尾的负对照）
#       MUTATION=1 bash tests/closed-issue-done.test.sh   （连负对照一起跑，见 tests/lib/mutation.sh）
# 依赖：bash、jq、python3、git。不碰网络：有状态的假 GitHub（tests/lib/fake_github.py，FAKE_GH_LISTS=1
# 打开 issue / PR 列表）+ 假 tmux，HOME 指向临时目录。每一轮都**真的**起 agent-poll.sh 子进程，
# 「打没打、摘了什么、留没留队」都从假 GitHub 的标签、调用记录和 state.json 里读，不读源码。
#
# 这块错了的方向都不报错，只会让看板悄悄不对：
#   · 把「关闭原因读不到」当成「已完成」→ 不做了 / 重复的 issue 被打上 Done
#   · 只看 Done 在不在 → 摘标签失败、Done 加成功后，残留的 pending/human 永远没人摘
#   · 写之前不重读 → 刚被重新打开的 issue 也打上 Done
#   · 出队放在写之前 / 摘除失败当成功 → 一次接口抖动就永久漏标
#   · 清单漏了自定义派工标签 → 关掉的 issue 下一轮又被派工
# 合并路径（PR 合并后给 PR 和被带关的 issue 打 Done）的调用与改动前（merge-base）逐条一致。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"
# shellcheck source=lib/compat.sh
source "$TEST_DIR/lib/compat.sh"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export TZ=UTC
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN
export FAKE_GH_LISTS=1 FAKE_GH_REPO="example/cd"

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
# 假 tmux：$FAKE_TMUX_BUSY 存在时，任何 session 都「在」且杀不掉 → cleanup-issue.sh 失败
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
if [ -n "${FAKE_TMUX_BUSY:-}" ] && [ -f "$FAKE_TMUX_BUSY" ]; then
    case "$1" in has-session) exit 0 ;; kill-session) exit 1 ;; capture-pane) exit 0 ;; esac
fi
case "$1" in has-session) exit 1 ;; ls|list-sessions) exit 1 ;; esac
exit 0
SH
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/tmux"

pass=0; fail=0; QUIET=0
chk() {
    if [ "$2" = "$3" ]; then
        [ "$QUIET" = 1 ] || echo "  ✅ $1"; pass=$((pass+1))
    else
        [ "$QUIET" = 1 ] || echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1))
    fi
}
section() { [ "$QUIET" = 1 ] || echo "$1"; }

BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$SANDBOX/old"
git -C "$REPO_DIR" archive "$BASE_REV" scripts prompts | tar -x -C "$SANDBOX/old"

run_scenarios() {
    local SCRIPTS="$1" W="$SANDBOX/run"
    local R="repos/example/cd"
    local CONF STATE CALLS GD

    fresh() {   # [--no-seed] [额外配置行…]
        local seed=1
        if [ "${1:-}" = --no-seed ]; then seed=0; shift; fi
        rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh"
        git init -q -b main "$W/project" 2>/dev/null
        GD="$W/gh"; export FAKE_GH_DIR="$GD"; CALLS="$GD/calls.log"; STATE="$W/state/state.json"
        export FAKE_TMUX_BUSY="$W/tmux-busy"
        CONF="$W/cavil-loop.config"
        cat > "$CONF" <<CONF
REPO="example/cd"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="cdtest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
LABEL_DONE="Done"
POST_MERGE_RETROSPECTIVE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=0
SUB_ISSUE_ROLLUP_MAX_TRIES=3
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
        local l; for l in "$@"; do printf '%s\n' "$l" >> "$CONF"; done
        echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/events.json"
        echo '{}' > "$GD/comments.json"; echo '{}' > "$GD/perms.json"; echo loop-bot > "$GD/me"
        # 已装好的项目：两份「已处理」记录早就存在（第一次装时的 bootstrap 已跑过）
        if [ "$seed" = 1 ]; then echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$STATE"; fi
    }
    jset() {
        local f="$GD/$1" e="$2"; shift 2
        jq "$@" "$e" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    }
    mkissue() {   # <n> <labels_csv> <state> [state_reason，"-" = 字段为 null]
        jset items.json '.[$n] = {kind:"issue", state:$s, state_reason:(if $r == "-" then null else $r end),
                title:"t", body:"需求", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}' \
            --arg n "$1" --arg s "$3" --arg r "${4:--}"
        jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$2"
        # 真 GitHub 上每个挂着的标签都有打上它的那条记录，关闭也有一条（GitHub#461：清扫按记录里的先后认
        # 「关闭之后挂上的 pending/human」）。夹具里的标签都是关闭之前打上的
        jset events.json '.[$n] = ([$l | split(",")[] | select(. != "") | {event:"labeled", label:{name:.}, actor:{login:"maint", type:"User"}, created_at:"2026-01-01T00:00:00Z"}]
                + (if $s == "closed" then [{event:"closed", actor:{login:"maint", type:"User"}, created_at:"2026-01-01T00:00:00Z"}] else [] end))' \
            --arg n "$1" --arg l "$2" --arg s "$3"
    }
    mkmerged() {   # <n> <分支> <正文> <labels_csv>
        jset items.json '.[$n] = {kind:"pr", state:"closed", merged:true, title:"t", body:$b,
                user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z",
                head:{sha:"1111111111111111111111111111111111111111", ref:$r, repo:{full_name:"example/cd"}}, base:{ref:"main"}}' \
            --arg n "$1" --arg r "$2" --arg b "$3"
        jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$4"
    }
    set_issue() {   # <n> <jq 赋值>：改 issue 的 GitHub 字段（state / state_reason）
        jset items.json ".[\$n] |= ($2)" --arg n "$1"
    }

    tick() { : > "$CALLS"; env CODING_AGENT_CONFIG="$CONF" bash "$SCRIPTS/agent-poll.sh" >/dev/null 2>&1; }
    n_calls() { grep -cE -- "$1" "$CALLS" 2>/dev/null || true; }
    labels_of() { jq -r --arg n "$1" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
    writes_on() { n_calls "^gh api -X (POST|PUT|DELETE|PATCH) $R/issues/$1/"; }
    # 「这一轮重读过没有」：0 / 1。GitHub#461 起一次只写一个标签、每写一个之前读两次，次数随要写的标签数变
    reread() { [ "$(n_calls "^gh api $R/issues/$1 --jq .*state_reason")" -gt 0 ] && echo 1 || echo 0; }
    queued() { jq -r --arg i "$1" '(.closed_done_queue // {}) | if has($i) then .[$i] | tostring else "无" end' "$STATE" 2>/dev/null; }
    cleaned() { jq -r --argjson i "$1" '(.cleaned_issues // []) | index($i) != null' "$STATE" 2>/dev/null; }
    log_has() { grep -cF -- "$1" "$W/state/poll.log" 2>/dev/null || true; }

    # ── 【1】主路径 ──
    section "【1】手动关闭·已完成：摘流程标签、加 Done，非流程标签保留"
    fresh 'LABEL_AUTOPILOT="autopilot"'
    mkissue 7 "pending/human,autopilot,bug" closed completed
    tick
    chk "标签：Done 加上、pending/human 摘掉、autopilot 和 bug 保留" "$(labels_of 7)" "Done,autopilot,bug"
    chk "写前重读过这个 issue" "$(reread 7)" 1
    chk "出队" "$(queued 7)" "无"
    chk "本机清理照常记为已处理" "$(cleaned 7)" true
    chk "日志写了这一笔" "$(log_has 'issue #7 手动关闭（已完成）→ Done')" 1
    tick
    chk "下一轮不再碰它（零读零写）" "$(reread 7)/$(writes_on 7)" "0/0"

    section "【2】全部流程标签：自定义派工标签、等外部机器人、等合并、pending/PR、doing/agent 都摘"
    fresh 'LABEL_AUTOPILOT="autopilot"' 'LABEL_PENDING_AGENT_EXTRA="pending/agent/05"' 'LABEL_PENDING_REQUESTER_BOT="pending/requester"'
    mkissue 8 "pending/agent,pending/agent/05,pending/agent/fable,pending/review,pending/requester,pending/merge,pending/PR,doing/agent,autopilot" closed completed
    tick
    chk "只剩 Done 和 autopilot" "$(labels_of 8)" "Done,autopilot"
    chk "出队" "$(queued 8)" "无"

    section "【2b】托管关闭时 pending/merge 不算流程标签（配置为空）；没配置的标签不发空请求"
    fresh
    mkissue 9 "pending/merge,pending/human" closed completed
    tick
    chk "pending/merge 原样保留" "$(labels_of 9)" "Done,pending/merge"
    chk "没有对空标签名发删除" "$(n_calls "^gh api -X DELETE $R/issues/9/labels/ ")" 0

    # ── 【3】不该打 ──
    for reason in not_planned duplicate; do
        section "【3】以「$reason」关闭：零写入、出队"
        fresh
        mkissue 10 "pending/human" closed "$reason"
        tick
        chk "$reason：标签不动" "$(labels_of 10)" "pending/human"
        chk "$reason：零写入" "$(writes_on 10)" 0
        chk "$reason：确实重读过（不是没跑到）" "$(reread 10)" 1
        chk "$reason：出队" "$(queued 10)" "无"
    done

    section "【3b】第一次装（还没有「已处理」记录）：历史关闭的不补打"
    fresh --no-seed
    mkissue 11 "pending/human" closed completed
    tick
    chk "零写入" "$(writes_on 11)" 0
    chk "没入队" "$(queued 11)" "无"
    chk "到达性 · 这一轮确实列了已关闭 issue" "$(n_calls '^gh issue list .*--state closed')" 2

    # ── 【4】原因未知跨两轮 ──
    section "【4】第 1 轮关闭原因为空 → 不写、留队；第 2 轮原因变「已完成」→ 打上、出队"
    fresh
    mkissue 12 "pending/human" closed -
    tick
    chk "第 1 轮：零写入" "$(writes_on 12)" 0
    chk "第 1 轮：重读过" "$(reread 12)" 1
    chk "第 1 轮：留队，已试 1 次" "$(queued 12)" 1
    chk "第 1 轮：本机清理照常完成" "$(cleaned 12)" true
    set_issue 12 '.state_reason = "completed"'
    tick
    chk "第 2 轮：打上 Done、摘掉 pending/human" "$(labels_of 12)" "Done"
    chk "第 2 轮：出队" "$(queued 12)" "无"

    section "【4b】没见过的关闭原因也算「不知道」"
    fresh
    mkissue 13 "pending/human" closed reopened_by_magic
    tick
    chk "零写入" "$(writes_on 13)" 0
    chk "留队" "$(queued 13)" 1

    section "【4c】读 issue 失败也留队"
    fresh
    mkissue 14 "pending/human" closed completed
    touch "$GD/F_issues_14"
    tick
    chk "零写入" "$(writes_on 14)" 0
    chk "留队" "$(queued 14)" 1
    rm -f "$GD/F_issues_14"
    tick
    chk "恢复后打上" "$(labels_of 14)" "Done"
    chk "恢复后出队" "$(queued 14)" "无"

    # ── 【5】部分失败跨两轮 ──
    section "【5】第 1 轮摘 pending/human 报错 → 停手（一次只写一个标签，GitHub#461）、留队；第 2 轮摘掉再加 Done"
    fresh
    mkissue 15 "pending/human" closed completed
    touch "$GD/F_delete_labels"
    tick
    chk "第 1 轮：pending/human 还在、没往下加 Done" "$(labels_of 15)" "pending/human"
    chk "第 1 轮：留队" "$(queued 15)" 1
    rm -f "$GD/F_delete_labels"
    tick
    chk "第 2 轮：摘掉 pending/human、加上 Done" "$(labels_of 15)" "Done"
    chk "第 2 轮：Done 只加了一次" "$(n_calls "^gh api -X POST $R/issues/15/labels ")" 1
    chk "第 2 轮：出队" "$(queued 15)" "无"

    section "【5b】摘的标签本来就不在（404）算成功"
    fresh
    mkissue 16 "pending/human" closed completed
    # 重读之后、删除之前有人先摘掉了它
    cat > "$GD/hook_issues_16_1" <<HOOK
jq '.["16"] = ["pending/x"]' "$GD/labels.json" > "$GD/l.tmp" && mv "$GD/l.tmp" "$GD/labels.json"
jq '.["16"] += [{event:"unlabeled", label:{name:"pending/human"}, actor:{login:"maint", type:"User"}, created_at:"2026-01-01T00:00:00Z"}]' "$GD/events.json" > "$GD/e.tmp" && mv "$GD/e.tmp" "$GD/events.json"
HOOK
    tick
    chk "Done 加上" "$(labels_of 16)" "Done,pending/x"
    chk "出队（404 不算失败）" "$(queued 16)" "无"

    # ── 【6】加 Done 失败 ──
    section "【6】加 Done 失败 → 留队；下一轮补上"
    fresh
    mkissue 17 "pending/PR" closed completed
    touch "$GD/F_post_labels"
    tick
    chk "第 1 轮：留队" "$(queued 17)" 1
    rm -f "$GD/F_post_labels"
    tick
    chk "第 2 轮：Done 加上" "$(labels_of 17)" "Done"
    chk "第 2 轮：出队" "$(queued 17)" "无"

    # ── 【7】已有 Done、无残留 ──
    section "【7】已有 Done、没有流程标签残留 → 零写入出队"
    fresh
    mkissue 18 "Done,bug" closed completed
    tick
    chk "零写入" "$(writes_on 18)" 0
    chk "重读过" "$(reread 18)" 1
    chk "出队" "$(queued 18)" "无"

    section "【7b】已有 Done 但还挂着 pending/human → 照样去摘"
    fresh
    mkissue 19 "Done,pending/human" closed completed
    tick
    chk "pending/human 摘掉" "$(labels_of 19)" "Done"
    chk "没重复加 Done" "$(n_calls "^gh api -X POST $R/issues/19/labels ")" 0

    # ── 【8】入队后被重新打开 ──
    section "【8】列表说已关闭、写前重读发现已被重新打开 → 零写入、出队"
    fresh
    mkissue 20 "pending/human" closed completed
    cat > "$GD/hook_issues_20_1" <<HOOK
jq '.["20"].state = "open" | .["20"].state_reason = "reopened"' "$GD/items.json" > "$GD/i.tmp" && mv "$GD/i.tmp" "$GD/items.json"
HOOK
    tick
    chk "零写入" "$(writes_on 20)" 0
    chk "重读过" "$(reread 20)" 1
    chk "出队" "$(queued 20)" "无"

    # ── 【9】重试上限 ──
    section "【9】连续读不到 → 到上限（本测试配成 3 轮）放弃、出队、记日志"
    fresh
    mkissue 21 "pending/human" closed -
    tick; tick
    chk "两轮后仍在队（已试 2 次）" "$(queued 21)" 2
    tick
    chk "第 3 轮放弃、出队" "$(queued 21)" "无"
    chk "日志写了放弃" "$(log_has 'issue #21 关闭后的 Done 连续 3 次没打成 → 放弃')" 1
    tick
    chk "放弃后不再读它" "$(reread 21)" 0

    # ── 【10】本机清理失败 ──
    section "【10】本机清理失败（worker session 杀不掉）→ 标签照常打成；下一轮只重试清理"
    fresh
    mkissue 22 "pending/human" closed completed
    touch "$FAKE_TMUX_BUSY"
    tick
    chk "第 1 轮：清理失败、没记已处理" "$(cleaned 22)" false
    chk "第 1 轮：标签照常打成" "$(labels_of 22)" "Done"
    chk "第 1 轮：标签这件事记为已结束（不删记录，挡住下一轮再入队）" "$(queued 22)" "done"
    tick
    chk "第 2 轮：本机清理照样重试" "$(log_has 'auto-cleanup closed issue #22 → cleanup-issue.sh')" 2
    chk "第 2 轮：不再重读、零写入" "$(reread 22)/$(writes_on 22)" "0/0"
    chk "第 2 轮：记录仍是已结束" "$(queued 22)" "done"
    rm -f "$FAKE_TMUX_BUSY"
    tick
    chk "第 3 轮：清理成功、记为已处理" "$(cleaned 22)" true
    chk "第 3 轮：已结束的记录随清理成功删掉" "$(queued 22)" "无"
    chk "第 3 轮：标签不变、零写入" "$(labels_of 22)/$(writes_on 22)" "Done/0"

    # ── 【10b】本机清理一直失败 + 标签一直打不成：上限照样生效（代码复审第 1 轮）──
    local variant
    for variant in add-fails unknown-reason; do
        section "【10b】清理一直失败 + 标签一直不成（$variant）：到上限后不再重读、不再写，清理继续重试"
        fresh
        if [ "$variant" = add-fails ]; then
            mkissue 23 "pending/human" closed completed; touch "$GD/F_post_labels"
        else
            mkissue 23 "pending/human" closed -
        fi
        touch "$FAKE_TMUX_BUSY"
        local seq="" reads="" r
        for r in 1 2 3 4 5 6 7; do
            tick
            seq="$seq$(queued 23),"; reads="$reads$(reread 23),"
        done
        chk "$variant：队列次数 1,2 后结束且不再从 0 数" "$seq" "1,2,done,done,done,done,done,"
        chk "$variant：只有前 3 轮重读，之后零读" "$reads" "1,1,1,0,0,0,0,"
        chk "$variant：「放弃」只记一次" "$(log_has 'issue #23 关闭后的 Done 连续 3 次没打成 → 放弃')" 1
        chk "$variant：本机清理 7 轮都在重试" "$(log_has 'auto-cleanup closed issue #23 → cleanup-issue.sh')" 7
        chk "$variant：一直没记为已处理" "$(cleaned 23)" false
        rm -f "$FAKE_TMUX_BUSY" "$GD/F_post_labels"
        tick
        chk "$variant：清理恢复后记为已处理、记录删掉、标签不再碰" "$(cleaned 23)/$(queued 23)/$(reread 23)/$(writes_on 23)" "true/无/0/0"
    done

    # ── 【11】合并路径不变 ──
    section "【11】PR 合并带关 issue：合并路径的调用与改动前逐条一致（只多出新队列的重读和事件记录读取）"
    local old_calls new_calls
    merged_scene() {
        fresh 'LABEL_AUTOPILOT="autopilot"' 'LABEL_PENDING_AGENT_EXTRA="pending/agent/05"'
        mkissue 30 "pending/PR,autopilot" closed completed
        mkmerged 31 feature/issue-30 "做了。

Closes #30" "pending/human,pending/merge"
        mkissue 32 "pending/PR" open
        mkmerged 33 feature/issue-32 "Refs #32" "pending/review"
    }
    local old_labels old_state csame=0
    compat_skip "合并路径的调用、最终标签、state.json 与改动前" "$SANDBOX/old" "$(dirname "$SCRIPTS")" scripts prompts && csame=1
    if [ "$csame" = 0 ]; then
    merged_scene
    : > "$CALLS"; env CODING_AGENT_CONFIG="$CONF" bash "$SANDBOX/old/scripts/agent-poll.sh" >/dev/null 2>&1
    old_calls=$(grep -v -e '--jq .*state_reason' -e '^gh api --paginate --slurp repos/example/cd/issues/3[0-3]/events$' "$CALLS")
    old_labels=$(jq -cS . "$GD/labels.json")
    old_state=$(jq -cS 'del(.closed_done_queue)' "$STATE")
    fi
    merged_scene
    tick
    new_calls=$(grep -v -e '--jq .*state_reason' -e '^gh api --paginate --slurp repos/example/cd/issues/3[0-3]/events$' "$CALLS")
    if [ "$csame" = 0 ]; then
    chk "调用记录（去掉新队列的重读、事件记录读取）逐条一致" "$([ "$old_calls" = "$new_calls" ] && echo same || diff <(echo "$old_calls") <(echo "$new_calls") | head -5 | tr '\n' ' ')" same
    chk "最终标签一致" "$(jq -cS . "$GD/labels.json")" "$old_labels"
    chk "state.json（去掉新队列字段）一致" "$(jq -cS 'del(.closed_done_queue)' "$STATE")" "$old_state"
    fi
    chk "到达性 · 合并路径真的给 PR 打了 Done" "$(labels_of 31)" "Done"
    chk "到达性 · 被带关的 issue 打了 Done、autopilot 保留" "$(labels_of 30)" "Done,autopilot"
    chk "带关的 issue 也进了新队列、重读一次后零写入出队" "$(reread 30)/$(queued 30)" "1/无"
}

run_scenarios "$REPO_DIR/scripts"
POS_PASS=$pass; POS_FAIL=$fail

# ── 负对照：改坏一处，上面同一套场景必须变红 ──
mut_fail=0; mut_ran=0
mutate() {   # <名字> <文件（相对 scripts/）> <原文> <替换后>
    local name="$1" file="$2" M="$SANDBOX/mut-$1"
    mutation_gate || return 0
    mut_ran=$((mut_ran + 1))
    rm -rf "$M"; mkdir -p "$M"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$M/"
    if ! python3 - "$M/scripts/$file" "$3" "$4" <<'PY'
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
if s.count(old) < 1:
    sys.exit(1)
open(p, "w").write(s.replace(old, new, 1))
PY
    then
        echo "  ❌ 负对照 $name：要改的原文找不到（准备失败）"; mut_fail=$((mut_fail + 1)); return 0
    fi
    pass=0; fail=0; QUIET=1
    run_scenarios "$M/scripts"
    QUIET=0
    if [ "$fail" -gt 0 ]; then
        echo "  ✅ 负对照 $name：$fail 条检查变红"
    else
        echo "  ❌ 负对照 $name：改坏后整套检查仍全绿（测试分不出这个错误实现）"; mut_fail=$((mut_fail + 1))
    fi
}

mutate unknown-as-completed _lib.sh '        completed) ;;
        not_planned|duplicate)' '        *) ;;
        not_planned|duplicate)'
mutate no-reread-state _lib.sh '        open)
            CD_V=skip; CD_MSG="issue #$issue 已重新打开' '        openx)
            CD_V=skip; CD_MSG="issue #$issue 已重新打开'
mutate fast-path-done-only _lib.sh '    if [ ${#stale[@]} -gt 0 ]; then
        CD_V=write; CD_NEXT="del:${stale[0]}"' '    if false; then
        CD_V=write; CD_NEXT="del:${stale[0]}"'
mutate delete-fail-ok _lib.sh '                    log "  ⚠️ issue #$issue 摘 $lab 失败: $out"
                    return 1' '                    log "  ⚠️ issue #$issue 摘 $lab 失败: $out"
                    return 0'
mutate add-fail-ok _lib.sh '                    log "  ⚠️ issue #$issue 加 $lab 失败: $out"
                    return 1' '                    log "  ⚠️ issue #$issue 加 $lab 失败: $out"
                    return 0'
mutate no-custom-trigger _lib.sh '        trigger_labels_all
        printf' '        printf'
mutate dequeue-before-write _lib.sh '        if closed_done_label "$issue"; then' '        closed_done_label "$issue"; if true; then'
mutate no-enqueue agent-poll.sh '            closed_done_enqueue "$issnum" "$STATE_FILE"
            log "auto-cleanup closed issue #$issnum → cleanup-issue.sh --force"' '            log "auto-cleanup closed issue #$issnum → cleanup-issue.sh --force"'
mutate no-drain agent-poll.sh '    closed_done_drain "$STATE_FILE" || true' '    :'
mutate finish-deletes _lib.sh '        if closed_done_label "$issue"; then
            closed_done_finish "$issue" "$state_file"' '        if closed_done_label "$issue"; then
            jq --arg i "$issue" "del(.closed_done_queue[\$i])" "$state_file" > "$tmp" && mv "$tmp" "$state_file"'
mutate giveup-deletes _lib.sh '→ 放弃（请手动打 ${LABEL_DONE}、摘掉流程标签）"
            closed_done_finish "$issue" "$state_file"' '→ 放弃（请手动打 ${LABEL_DONE}、摘掉流程标签）"
            jq --arg i "$issue" "del(.closed_done_queue[\$i])" "$state_file" > "$tmp" && mv "$tmp" "$state_file"'
mutate enqueue-resets _lib.sh '{($i): ((.closed_done_queue // {})[$i] // 0)}' '{($i): 0}'
mutate no-forget agent-poll.sh '                closed_done_forget "$issnum" "$STATE_FILE"
' ''
mutate no-cap _lib.sh '        if [ "$tries" -ge "$cap" ]; then
            log "⚠️ issue #$issue 关闭后' '        if false; then
            log "⚠️ issue #$issue 关闭后'

echo
echo "正向：$POS_PASS 通过 / $POS_FAIL 失败"
mutation_summary "$0"
compat_summary
if mutation_on; then echo "负对照：$mut_ran 项中 $mut_fail 项没能变红或准备失败"; fi
# 正式版计数在负对照开始前已存下、负对照不改它：各模式下都只含回归（tests/lib/report.sh）
REPORT_REGRESS_ONLY=1 report_counts "$POS_PASS" "$POS_FAIL" "$mut_ran" "$mut_fail"
[ "$POS_FAIL" -eq 0 ] && [ "$mut_fail" -eq 0 ]
