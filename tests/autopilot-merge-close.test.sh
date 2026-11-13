#!/usr/bin/env bash
# kind: e2e
# 托管 PR 合并即关 issue，并挂 pending/human 提醒人看 —— GitHub#461（父 issue #444）。
#
# 跑法：bash tests/autopilot-merge-close.test.sh
# 依赖：bash、jq、python3、git。不碰网络：有状态的假 GitHub（tests/lib/fake_github.py；merge_closes 文件打开
# 「合并时按正文关闭关键词关掉 issue」）+ 假 tmux，HOME 指向临时目录。每一轮都**真的**起 agent-poll.sh 子进程，
# 结论都从假 GitHub 的标签、事件、评论、调用记录和 state.json 里读，不读源码。
#
# 这块错了的方向都不报错，只会让看板悄悄不对：
#   · 关闭清扫照旧摘掉所有流程标签 → 合并后挂上的 pending/human 下一轮就没了，人收不到提醒
#   · 先后比时间戳 → 合并关 issue 和 daemon 挂提醒在同一秒，提醒被当成关闭前的旧标签摘掉
#   · 判定之后不重读 / 写完一步不核对 → 人刚重新挂的提醒、刚重开的 issue 被按旧结论接着写
#   · 读不到事件记录当成「没有提醒」→ 照摘不误
#   · 人摘掉提醒后又被加回
# `Refs #N` 写法、非托管 PR 的收尾、人在 pending/human 状态下直接关 issue 的清扫：写入与改动前（merge-base）逐字一致。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/compat.sh
source "$TEST_DIR/lib/compat.sh"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export TZ=UTC
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR \
      DISPATCH_AUTOPILOT_WHERE DISPATCH_PROMPT_KIND TRUSTED_REPOS
unset GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN
export FAKE_GH_LISTS=1 FAKE_GH_REPO="example/ap"

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; ls|list-sessions) exit 1 ;; esac
exit 0
SH
chmod +x "$SANDBOX/bin/tmux"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then
        echo "  ✅ $1"; pass=$((pass+1))
    else
        echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1))
        if [ -n "${KEEP_SANDBOX:-}" ] && [ -n "${W:-}" ]; then
            cp "$W/state/poll.log" "$SANDBOX/fail-$fail.poll.log" 2>/dev/null; cp "$W/gh/calls.log" "$SANDBOX/fail-$fail.calls.log" 2>/dev/null
        fi
    fi
}
section() { echo "$1"; }

H1=1111111111111111111111111111111111111111
SUMMARY='<!-- autopilot-summary:begin -->
<details><summary>背景</summary>

合并后 issue 一直开着。

</details>
<details><summary>采用的方案</summary>

合并即关、挂提醒。

</details>
<details><summary>排除的方案和原因</summary>

没有考虑别的方案：维护者已选定。

</details>
<!-- autopilot-summary:end -->'

BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$SANDBOX/old"
git -C "$REPO_DIR" archive "$BASE_REV" scripts prompts | tar -x -C "$SANDBOX/old"

W="$SANDBOX/run"
R="repos/example/ap"
SCRIPTS="$REPO_DIR/scripts"
fresh() {   # [额外配置行…]
    rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh"
    git init -q -b main "$W/project" 2>/dev/null
    GD="$W/gh"; export FAKE_GH_DIR="$GD"; CALLS="$GD/calls.log"; STATE="$W/state/state.json"
    CONF="$W/cavil-loop.config"
    cat > "$CONF" <<CONF
REPO="example/ap"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="mctest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
LABEL_DONE="Done"
LABEL_AUTOPILOT="autopilot"
LABEL_PENDING_BLOCKED="pending/blocked"
BLOCKED_RECHECK_SECS=0
POST_MERGE_RETROSPECTIVE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=0
AUTOPILOT_UNKNOWN_MAX=3
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    local l; for l in "$@"; do printf '%s\n' "$l" >> "$CONF"; done
    EVN=0
    echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/events.json"
    echo '{}' > "$GD/comments.json"; echo '{"maint":"admin"}' > "$GD/perms.json"
    echo '{}' > "$GD/checks.json"; echo '{}' > "$GD/files.json"; echo loop-bot > "$GD/me"
    # 已装好的项目：两份「已处理」记录早就存在，合并后关掉的 issue 会进关闭清扫
    echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$STATE"
}
jset() { local f="$GD/$1" e="$2"; shift 2; jq "$@" "$e" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
ev() {   # <n> <labeled|unlabeled|closed|reopened> <标签或 -> <操作人>（时间全部同一秒：先后只能看记录里的位置）
    jset events.json '.[$n] = ((.[$n] // []) + [({event:$e, actor:{login:$a, type:"User"}, created_at:"2026-01-01T00:00:00Z"}
            + (if $l == "-" then {} else {label:{name:$l}} end))])' --arg n "$1" --arg e "$2" --arg l "$3" --arg a "$4"
}
mkissue() {   # <n> <labels_csv> [open|closed] [作者]：每个标签补一条「打上」，已关闭的再补一条 closed（都在它们之后）
    local L
    jset items.json '.[$n] = {kind:"issue", state:$s, state_reason:(if $s == "closed" then "completed" else null end),
            title:"t", body:"需求", user:{login:$a}, updated_at:"2026-01-01T00:00:00Z"}' \
        --arg n "$1" --arg s "${3:-open}" --arg a "${4:-maint}"
    jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$2"
    for L in ${2//,/ }; do ev "$1" labeled "$L" "$( [ "$L" = autopilot ] && echo maint || echo loop-bot)"; done
    [ "${3:-open}" != closed ] || ev "$1" closed - maint
}
mkpr() {   # <n> <分支> <正文> <labels_csv> [目标分支]
    jset items.json '.[$n] = {kind:"pr", state:"open", merged:false, draft:false, title:"合并即关", body:$b,
            user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z", created_at:"2025-12-01T00:00:00Z",
            head:{sha:$h, ref:$r, repo:{full_name:"example/ap"}}, base:{ref:$base},
            mergeable:true, mergeable_state:"clean"}' \
        --arg n "$1" --arg r "$2" --arg b "$3" --arg h "$H1" --arg base "${5:-main}"
    jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$4"
    local L; for L in ${4//,/ }; do ev "$1" labeled "$L" loop-bot; done
}
review_ok() {   # <pr>：复审通过、留了测试记录
    jq --arg p "$1" --arg h "$H1" '.autopilot.prs[$p] = {reviewed_head:$h, reviewed_at:"2026-01-01T00:00:00Z", reviewed_base:"main"}' \
        "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    jset comments.json '.[$p] = ((.[$p] // []) + [{id: 900, user:{login:"loop-bot"}, created_at:"2026-06-01T00:00:00Z",
            body:("## ✅ 复审通过\n\n<!-- autopilot-review-pass head=" + $h + " passed=5 failed=0 -->")}])' --arg p "$1" --arg h "$H1"
}
# 托管 issue 7（维护者打的托管）+ 它的 PR 8（复审已通过、等合并），正文按 <正文> 写
ready() {   # <正文> [目标分支]
    mkissue 7 "autopilot,pending/PR"
    mkpr 8 feature/issue-7 "$1" "pending/merge" "${2:-main}"
    review_ok 8
}
# 等 #7 的下游条目 90
downstream() {
    mkissue 90 "pending/blocked"
    jset comments.json '.["90"] = [{id: 5001, user:{login:"loop-bot"}, author_association:"NONE", created_at:"2026-06-01T00:00:00Z",
            body:"## 等前置\n\n<!-- agent-blocked-by: #7 resume=pending/agent -->"}]'
}
hook() {   # <钩子名> <脚本>：假 GitHub 在对应请求之前 / 之后跑它（见 tests/lib/fake_github.py 开头）
    printf 'set -e\ncd %q\n%s\n' "$GD" "$2" > "$GD/$1"
}
human_relabel() {   # <n> <标签>：人摘掉再加回（标签集合不变，事件多两条）
    printf '%s' "python3 - <<'PY'
import json
e = json.load(open('events.json')); a = {'login': 'maint', 'type': 'User'}
e.setdefault('$1', []).extend([{'event': 'unlabeled', 'label': {'name': '$2'}, 'actor': a, 'created_at': '2026-01-01T00:00:00Z'},
                               {'event': 'labeled', 'label': {'name': '$2'}, 'actor': a, 'created_at': '2026-01-01T00:00:00Z'}])
json.dump(e, open('events.json', 'w'))
PY"
}
human_add() {   # <n> <标签>：人加上一个标签
    printf '%s' "python3 - <<'PY'
import json
l = json.load(open('labels.json')); e = json.load(open('events.json'))
l.setdefault('$1', []).append('$2')
e.setdefault('$1', []).append({'event': 'labeled', 'label': {'name': '$2'}, 'actor': {'login': 'maint', 'type': 'User'}, 'created_at': '2026-01-01T00:00:00Z'})
json.dump(l, open('labels.json', 'w')); json.dump(e, open('events.json', 'w'))
PY"
}
human_reopen() {   # <n>
    printf '%s' "python3 - <<'PY'
import json
i = json.load(open('items.json')); e = json.load(open('events.json'))
i['$1']['state'] = 'open'; i['$1']['state_reason'] = 'reopened'
e.setdefault('$1', []).append({'event': 'reopened', 'actor': {'login': 'maint', 'type': 'User'}, 'created_at': '2026-01-01T00:00:00Z'})
json.dump(i, open('items.json', 'w')); json.dump(e, open('events.json', 'w'))
PY"
}

tick() { : > "$CALLS"; env CODING_AGENT_CONFIG="$CONF" bash "$SCRIPTS/agent-poll.sh" >/dev/null 2>&1; }
n_calls() { grep -cE -- "$1" "$CALLS" 2>/dev/null || true; }
merged() { n_calls "^gh api -X PUT $R/pulls/$1/merge "; }
labels_of() { jq -r --arg n "$1" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
has_label() { case ",$(labels_of "$1")," in *",$2,"*) echo yes ;; *) echo no ;; esac; }
comments_with() { jq -r --arg n "$1" '(.[$n] // [])[].body' "$GD/comments.json" | grep -cF -- "$2" || true; }
label_writes() { n_calls "^gh api -X (POST|DELETE) $R/issues/$1/labels"; }
issue_state() { jq -r --arg n "$1" '.[$n].state // ""' "$GD/items.json"; }
queued() { jq -r --arg i "$1" '(.closed_done_queue // {}) | if has($i) then .[$i] | tostring else "无" end' "$STATE" 2>/dev/null; }
mqueued() { jq -r --arg i "$1" '(.merged_label_queue // {}) | has($i)' "$STATE" 2>/dev/null; }
handoff() { jq -r --arg p "$1" '.autopilot.handoff[$p] // "none" | if type == "object" then "rec" else . end' "$STATE"; }
event_reads() { n_calls "^gh api --paginate --slurp $R/issues/$1/events"; }

# ── 【1】主路径 ──
section "【1】托管 PR 写 Closes #7：合并即关 issue；Done + pending/human；合并说明；清扫不摘提醒；下游开工；人摘掉后不加回"
fresh; : > "$GD/merge_closes"
ready "做了 X。

Closes #7

$SUMMARY"
downstream
tick
chk "PR 8 合并了" "$(merged 8)" 1
chk "issue 7 随合并关闭" "$(issue_state 7)" closed
chk "issue 7：Done + pending/human，pending/PR 摘掉，托管标签不动" "$(labels_of 7)" "Done,autopilot,pending/human"
chk "合并说明发在 issue 7，只有一条" "$(comments_with 7 'autopilot-merged pr=8 ')" 1
chk "  → 写明已随合并关闭、看完摘 pending/human" "$(comments_with 7 '本 issue 已随合并关闭，挂着 `pending/human` 提醒人看')" 1
chk "  → 写明返工步骤" "$(comments_with 7 '要返工就重开本 issue、摘掉 `Done` 和 `pending/human`、打 `pending/agent`')" 1
chk "  → 照搬总结段" "$(comments_with 7 '合并即关、挂提醒。')" 1
chk "交接记录已清" "$(handoff 8)" none
chk "关闭清扫读过事件记录、认出提醒是关闭之后挂的、出队" "$( [ "$(event_reads 7)" -gt 0 ] && echo read)/$(queued 7)" "read/无"
tick
chk "第 2 轮：提醒还在" "$(labels_of 7)" "Done,autopilot,pending/human"
chk "第 2 轮：issue 7 零标签写入" "$(label_writes 7)" 0
chk "下游 90 自动开工（翻回 pending/agent）" "$(has_label 90 pending/agent)/$(has_label 90 pending/blocked)" "yes/no"
jset labels.json '.["7"] = ["Done", "autopilot"]'; ev 7 unlabeled pending/human maint
tick; tick
chk "人摘掉 pending/human 之后：两轮都没加回" "$(labels_of 7)/$(label_writes 7)" "Done,autopilot/0"

# ── 【2】同一秒 ──
section "【2】关闭和挂提醒在同一秒：按记录里的先后认，关闭之后挂的留着、之前挂的照旧摘"
fresh
mkissue 20 "pending/PR" closed; ev 20 labeled pending/human loop-bot
jset labels.json '.["20"] += ["pending/human"]'
mkissue 21 "pending/human,pending/PR" closed
tick
chk "关闭之后挂的：留着；pending/PR 摘掉、加 Done" "$(labels_of 20)" "Done,pending/human"
chk "关闭之前挂的（人在 pending/human 状态下直接关）：照旧摘掉" "$(labels_of 21)" "Done"
chk "两条都出队" "$(queued 20)/$(queued 21)" "无/无"

# ── 【3】判定后写入前的变化 ──
section "【3】清扫判定之后、写入之前人摘掉又挂上提醒 → 本轮不写；下一轮保留提醒"
fresh
mkissue 22 "pending/human,pending/PR" closed
hook hook_issues_22_2 "$(human_relabel 22 pending/human)"
tick
chk "第 1 轮：零标签写入、留队" "$(label_writes 22)/$(queued 22)" "0/1"
tick
chk "第 2 轮：提醒留着（现在是关闭之后挂的），pending/PR 摘掉、加 Done" "$(labels_of 22)" "Done,pending/human"
chk "第 2 轮：出队" "$(queued 22)" "无"

section "【3b】两次写之间人重新挂上提醒（daemon 刚摘掉它）→ 停手；下一轮保留提醒"
fresh
mkissue 23 "pending/human,pending/PR" closed
hook hook_issues_23_3 "$(human_add 23 pending/human)"
tick
chk "第 1 轮：只写了那一次摘除，之后停手、留队" "$(label_writes 23)/$(queued 23)" "1/1"
tick
chk "第 2 轮：人挂的提醒留着，其余照常收敛" "$(labels_of 23)" "Done,pending/human"

section "【3c】对照：同样的 issue、什么都不变 → 第 1 轮就收敛（摘 pending/human、pending/PR，加 Done）"
fresh
mkissue 24 "pending/human,pending/PR" closed
tick
chk "收敛到 Done、出队" "$(labels_of 24)/$(queued 24)" "Done/无"
chk "三次写" "$(label_writes 24)" 3

# ── 【4】重开 ──
section "【4】清扫判定之后、写入之前人重开 issue → 不打 Done、不摘标签"
fresh
mkissue 25 "pending/human,pending/PR" closed
hook hook_issues_25_2 "$(human_reopen 25)"
tick
chk "第 1 轮：零标签写入" "$(label_writes 25)" 0
tick
chk "第 2 轮：仍然零写入、标签原样、出队" "$(label_writes 25)/$(labels_of 25)/$(queued 25)" "0/pending/PR,pending/human/无"

section "【4b】合并后交接加上 Done 之后、下一步之前人重开 issue → 停手，之后不再写"
fresh; : > "$GD/merge_closes"
ready "Closes #7

$SUMMARY"
hook hook_after_POST_issues_7_labels_1 "$(human_reopen 7)"
tick
chk "合并了；交接只写了加 Done 那一次" "$(merged 8)/$(label_writes 7)" "1/1"
tick
chk "下一轮：issue 开着，不摘 pending/PR、不挂 pending/human" "$(issue_state 7)/$(labels_of 7)/$(label_writes 7)" "open/Done,autopilot,pending/PR/0"

section "【4c】对照：同形场景什么都不变 → 交接三步写成"
fresh; : > "$GD/merge_closes"
ready "Closes #7

$SUMMARY"
tick
chk "交接写了三次（加 Done、摘 pending/PR、加 pending/human）" "$(label_writes 7)/$(labels_of 7)" "3/Done,autopilot,pending/human"

# ── 【5】读不到事件记录 ──
section "【5】清扫读不到事件记录 → 本轮零写入、留队；恢复后完成"
fresh
mkissue 26 "pending/human,pending/PR" closed; ev 26 labeled pending/human loop-bot
: > "$GD/F_issues_26_events"
tick
chk "第 1 轮：零写入、留队" "$(label_writes 26)/$(queued 26)" "0/1"
rm -f "$GD/F_issues_26_events"
tick
chk "恢复后：关闭之后挂的提醒留着、其余收敛、出队" "$(labels_of 26)/$(queued 26)" "Done,pending/human/无"

section "【5b】合并后交接读不到事件记录 → issue 零标签写入（交接和清扫都不写）、留在重试队列；恢复后完成"
fresh; : > "$GD/merge_closes"
ready "Closes #7

$SUMMARY"
# 合并之后才读不到（合并前的授权判断也读这份记录）：发合并说明之前打开故障
hook hook_after_POST_issues_7_comments_1 ': > F_issues_7_events'
tick
chk "合并了、说明发了，issue 7 零标签写入、在两个重试队列里" "$(merged 8)/$(comments_with 7 'autopilot-merged pr=8 ')/$(label_writes 7)/$(mqueued 7)/$(queued 7)" "1/1/0/true/1"
chk "  → 标签原样" "$(labels_of 7)" "autopilot,pending/PR"
rm -f "$GD/F_issues_7_events"
tick
chk "恢复后：Done + pending/human、两个队列都出队、说明没重发" "$(labels_of 7)/$(mqueued 7)/$(queued 7)/$(comments_with 7 'autopilot-merged pr=8 ')" "Done,autopilot,pending/human/false/无/1"

section "【5b2】交接停在读不到事件时，人在关闭后挂上又摘掉 pending/human → 恢复后不加回"
fresh; : > "$GD/merge_closes"
ready "Closes #7

$SUMMARY"
hook hook_after_POST_issues_7_comments_1 ': > F_issues_7_events'
tick
jset labels.json '.["7"] += ["pending/human"]'; ev 7 labeled pending/human maint
jset labels.json '.["7"] -= ["pending/human"]'; ev 7 unlabeled pending/human maint
rm -f "$GD/F_issues_7_events"
tick
chk "恢复后：没加回 pending/human；Done 加上、pending/PR 摘掉、交接记录清掉" "$(has_label 7 pending/human)/$(labels_of 7)/$(handoff 8)" "no/Done,autopilot/none"
chk "  → 这一轮没有加 pending/human 的请求" "$(n_calls "^gh api -X POST $R/issues/7/labels -f labels\[\]=pending/human")" 0
tick
chk "再一轮：仍然没加回" "$(has_label 7 pending/human)/$(label_writes 7)" "no/0"

section "【5b3】对照：同形场景、人没动 → 恢复后照常挂上 pending/human"
fresh; : > "$GD/merge_closes"
ready "Closes #7

$SUMMARY"
hook hook_after_POST_issues_7_comments_1 ': > F_issues_7_events'
tick
rm -f "$GD/F_issues_7_events"
tick
chk "挂上 pending/human" "$(labels_of 7)" "Done,autopilot,pending/human"

section "【5b4】清扫：没挂提醒的已关闭 issue，读不到事件记录 → 零写入、留队；恢复后收敛"
fresh
mkissue 71 "pending/PR" closed
: > "$GD/F_issues_71_events"
tick
chk "第 1 轮：零写入、留队、标签原样" "$(label_writes 71)/$(queued 71)/$(labels_of 71)" "0/1/pending/PR"
chk "  → 到达性：确实去读了事件记录" "$( [ "$(event_reads 71)" -gt 0 ] && echo read)" read
rm -f "$GD/F_issues_71_events"
tick
chk "恢复后：摘 pending/PR、加 Done、出队" "$(labels_of 71)/$(queued 71)" "Done/无"

section "【5b5】清扫：没挂提醒，两次判定之间被重开又关上 → 本轮不写；下一轮收敛"
fresh
mkissue 72 "pending/PR" closed
hook hook_issues_72_2 "python3 - <<'PY'
import json
e = json.load(open('events.json')); a = {'login': 'maint', 'type': 'User'}
e.setdefault('72', []).extend([{'event': 'reopened', 'actor': a, 'created_at': '2026-01-01T00:00:00Z'},
                               {'event': 'closed', 'actor': a, 'created_at': '2026-01-01T00:00:00Z'}])
json.dump(e, open('events.json', 'w'))
PY"
tick
chk "第 1 轮：零写入、留队" "$(label_writes 72)/$(queued 72)" "0/1"
tick
chk "第 2 轮：收敛到 Done、出队" "$(labels_of 72)/$(queued 72)" "Done/无"

section "【5c】挂着 pending/human 却找不到「加上」它的记录 → 判不了，零写入"
fresh
mkissue 27 "pending/PR" closed; jset labels.json '.["27"] += ["pending/human"]'
tick
chk "零写入、留队" "$(label_writes 27)/$(queued 27)" "0/1"

section "【5c2】记录说提醒已摘掉、标签却还挂着（响应互相矛盾）→ 判不了，零写入、留队"
fresh
mkissue 73 "pending/human,pending/PR" closed
ev 73 unlabeled pending/human maint
tick
chk "零写入、留队、标签原样" "$(label_writes 73)/$(queued 73)/$(labels_of 73)" "0/1/pending/PR,pending/human"
chk "  → 到达性：确实读了事件记录" "$( [ "$(event_reads 73)" -gt 0 ] && echo read)" read

section "【5c3】交接：记录说关闭后挂了提醒、之后没摘，标签却不在 → 判不了，交接记录留着、不写标签"
fresh; : > "$GD/merge_closes"
ready "Closes #7

$SUMMARY"
hook hook_after_POST_issues_7_comments_1 ': > F_issues_7_events'
tick
ev 7 labeled pending/human maint      # 事件有、标签没有
rm -f "$GD/F_issues_7_events"
tick
chk "零标签写入、交接记录还在、在重试队列" "$(label_writes 7)/$(handoff 8)/$(mqueued 7)" "0/rec/true"

section "【5c4】对照：同样的记录、标签和记录一致（挂着）→ 交接照常收敛、提醒留着"
fresh; : > "$GD/merge_closes"
ready "Closes #7

$SUMMARY"
hook hook_after_POST_issues_7_comments_1 ': > F_issues_7_events'
tick
ev 7 labeled pending/human maint; jset labels.json '.["7"] += ["pending/human"]'
rm -f "$GD/F_issues_7_events"
tick
chk "收敛：Done + 人挂的提醒、pending/PR 摘掉、交接完成" "$(labels_of 7)/$(handoff 8)" "Done,autopilot,pending/human/none"

section "【3d】清扫：daemon 摘掉旧提醒之后、下一次读之前，人又挂上再摘掉 → 停手（只留已写成的那次）；下一轮收敛"
fresh
mkissue 74 "pending/human,pending/PR" closed
hook hook_issues_74_3 "python3 - <<'PY'
import json
e = json.load(open('events.json')); a = {'login': 'maint', 'type': 'User'}
e.setdefault('74', []).extend([{'event': 'labeled', 'label': {'name': 'pending/human'}, 'actor': a, 'created_at': '2026-01-01T00:00:00Z'},
                               {'event': 'unlabeled', 'label': {'name': 'pending/human'}, 'actor': a, 'created_at': '2026-01-01T00:00:00Z'}])
json.dump(e, open('events.json', 'w'))
PY"
tick
chk "第 1 轮：只写了那一次摘除、留队" "$(label_writes 74)/$(queued 74)/$(labels_of 74)" "1/1/pending/PR"
tick
chk "第 2 轮：收敛到 Done、出队" "$(labels_of 74)/$(queued 74)" "Done/无"

section "【4d】交接：daemon 加上 Done 之后、下一步之前，人挂上又摘掉提醒 → 停手；下一轮收尾、不再挂提醒"
fresh; : > "$GD/merge_closes"
ready "Closes #7

$SUMMARY"
hook hook_after_POST_issues_7_labels_1 "python3 - <<'PY'
import json
e = json.load(open('events.json')); a = {'login': 'maint', 'type': 'User'}
e.setdefault('7', []).extend([{'event': 'labeled', 'label': {'name': 'pending/human'}, 'actor': a, 'created_at': '2026-01-01T00:00:00Z'},
                              {'event': 'unlabeled', 'label': {'name': 'pending/human'}, 'actor': a, 'created_at': '2026-01-01T00:00:00Z'}])
json.dump(e, open('events.json', 'w'))
PY"
tick
# 停手之后同一轮的重试队列从头现读再判（新的基线）：人挂上又摘掉过 → 收尾时不再挂提醒
chk "加 Done 之后发现人的新事件 → 那一圈停手" "$(grep -c '托管合并交接：issue #7 在 daemon 两次写标签之间有变化' "$W/state/poll.log")" 1
chk "同一轮重试队列从头再判：摘 pending/PR、交接完成，没有挂提醒" "$(labels_of 7)/$(handoff 8)/$(n_calls "^gh api -X POST $R/issues/7/labels -f labels\\[\\]=pending/human")" "Done,autopilot/none/0"
tick
chk "再一轮：零写入" "$(label_writes 7)" 0

# ── 【6】GitHub 晚一步关 / 不会关 ──
section "【6】合并时 GitHub 还没关掉 issue → 交接等着（零标签写入）；关掉之后收敛"
fresh
ready "Closes #7

$SUMMARY"
tick
chk "合并了；issue 还开着、标签零写入、在重试队列" "$(merged 8)/$(issue_state 7)/$(label_writes 7)/$(mqueued 7)" "1/open/0/true"
jset items.json '.["7"].state = "closed" | .["7"].state_reason = "completed"'; ev 7 closed - loop-bot
tick
chk "关掉之后：Done + pending/human" "$(labels_of 7)/$(mqueued 7)" "Done,autopilot,pending/human/false"

section "【6b】合进的不是默认分支（GitHub 不会关 issue）→ 照旧：issue 留着、翻 pending/human"
fresh
echo develop > "$GD/default_branch"
ready "Closes #7

$SUMMARY"
tick
chk "合并了、交接没记「合并即关」" "$(merged 8)/$(handoff 8)" "1/none"
chk "issue 开着、pending/human、摘 pending/PR" "$(issue_state 7)/$(labels_of 7)" "open/autopilot,pending/human"
chk "说明是「满意就关闭」那一版" "$(comments_with 7 '要人做的：看过之后满意就关闭本 issue')" 1

# ── 【7】和改动前一致 ──
section "【7】Refs 写法、非托管 PR、人在 pending/human 状态下直接关 issue：写入与改动前逐字一致"
same_scene() {
    fresh 'LABEL_PENDING_AGENT_EXTRA="pending/agent/05"'
    ready "做了 X。

Refs #7

$SUMMARY"
    mkissue 30 "pending/PR"
    jset items.json '.["31"] = {kind:"pr", state:"closed", merged:true, title:"t", body:"Refs #30", user:{login:"loop-bot"},
            updated_at:"2026-01-01T00:00:00Z", head:{sha:"2222222222222222222222222222222222222222", ref:"feature/issue-30", repo:{full_name:"example/ap"}}, base:{ref:"main"}}'
    jset labels.json '.["31"] = ["pending/review"]'
    mkissue 32 "pending/human,bug" closed
}
run_two() {   # <scripts 目录>：跑两轮，输出两轮的写请求、最终标签和评论
    local s="$1" out="" r
    for r in 1 2; do
        : > "$CALLS"; env CODING_AGENT_CONFIG="$CONF" bash "$s/agent-poll.sh" >/dev/null 2>&1
        out="$out$(grep -E '^gh (api -X (POST|PUT|DELETE|PATCH)|issue comment|pr comment)' "$CALLS")"$'\n'
    done
    printf '%s\n%s\n%s\n' "$out" "$(jq -cS . "$GD/labels.json")" "$(jq -cS 'map_values(map(.body))' "$GD/comments.json")"
}
if ! compat_skip "Refs 写法 / 非托管 PR / 直接关闭的清扫与改动前" "$SANDBOX/old" "$REPO_DIR" scripts prompts; then
    same_scene; old_out=$(run_two "$SANDBOX/old/scripts")
    same_scene; new_out=$(run_two "$SCRIPTS")
    chk "两轮的写请求、最终标签、评论逐字一致" "$([ "$old_out" = "$new_out" ] && echo same || diff <(echo "$old_out") <(echo "$new_out") | head -8 | tr '\n' ' ')" same
fi
same_scene; tick; tick
chk "到达性 · Refs 写法照旧：合并、issue 开着、pending/human" "$(merged 8)/$(issue_state 7)/$(labels_of 7)" "0/open/autopilot,pending/human"
chk "到达性 · 非托管 PR 的 issue → pending/human" "$(labels_of 30)" "pending/human"
chk "到达性 · 直接关闭的 issue → Done、pending/human 摘掉" "$(labels_of 32)" "Done,bug"
chk "到达性 · Refs 写法的 PR 确实合并过（第 1 轮）" "$(comments_with 7 'autopilot-merged pr=8 ')" 1

echo
echo "正式版：$pass 通过 / $fail 失败"
compat_summary
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
