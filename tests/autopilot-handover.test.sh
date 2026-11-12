#!/usr/bin/env bash
# kind: e2e
# 托管交人：几次写入之间维护者改了状态时，daemon 察觉并停手 —— GitHub#382。
#
# 跑法：bash tests/autopilot-handover.test.sh
# 依赖：bash、jq、python3、git。不碰网络：有状态的假 GitHub（tests/lib/fake_github.py）+ 假 tmux，HOME 指向
# 临时目录。每一轮都**真的**起 agent-poll.sh 子进程；「写了什么、停在哪」都从假 GitHub 的调用记录和状态里读，
# 不读源码。不带负对照（GitHub#234 起不新增）。
#
# 交人要连发几个独立请求（发说明 → 加 pending/human → 摘 pending/merge）。这块错了的方向都不报错：
#   · 两次写入之间不重读 → 维护者刚关掉 / 刚接手 / 刚重新排队的 PR 又被按旧结论写一遍
#   · 只在第一次写入前重读 → 后两次写入照旧盖掉人的操作
#   · 只看 PR 不看关联 issue → issue 上撤销叫停之后，PR 仍被交人
#   · 先判定、后取基准 → 判定和取基准之间的重新入队被当成原来那一次
#   · 跨轮的待办不带基准 → 人摘掉的标签下一轮又被加回来
#   · 读不到当成「没变」→ 该停的没停
# 所以每个「停手」的用例都同时断言：注入之前的那次写确实发生了、写前核对确实读过。
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
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR \
      DISPATCH_AUTOPILOT_WHERE DISPATCH_PROMPT_KIND AUTOPILOT_HUMAN_PATHS AUTOPILOT_HUMAN_PATHS_DEFAULT TRUSTED_REPOS
unset GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN
export FAKE_GH_REPO="example/ap"

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; ls|list-sessions) exit 1 ;; esac
exit 0
SH
chmod +x "$SANDBOX/bin/tmux"

# 「维护者改了 GitHub」：在假 GitHub 的目录里原地改状态，标签改动都带上真 GitHub 会有的那条标签记录
cat > "$SANDBOX/bin/gd-act" <<'SH'
#!/usr/bin/env bash
# gd-act <假 GitHub 目录> <动作> [编号]
cd "$1" || exit 1
n="${3:-8}"
j() { jq "${@:3}" "$2" "$1" > "$1.t" && mv "$1.t" "$1"; }
lab() {   # <labeled|unlabeled> <标签> [操作人]
    if [ "$1" = labeled ]; then j labels.json '.[$n] = (((.[$n] // []) + [$l]) | unique)' --arg n "$n" --arg l "$2"
    else j labels.json '.[$n] = ((.[$n] // []) - [$l])' --arg n "$n" --arg l "$2"; fi
    j events.json '.[$n] = ((.[$n] // []) + [{event: $e, label: {name: $l}, actor: {login: $a, type: "User"}, created_at: "2026-03-01T00:00:00Z"}])' \
        --arg n "$n" --arg e "$1" --arg l "$2" --arg a "${3:-maint}"
}
case "$2" in
    close)        j items.json '.[$n].state = "closed"' --arg n "$n" ;;
    unqueue)      lab unlabeled pending/merge ;;
    add-human)    lab labeled pending/human ;;
    rm-human)     lab unlabeled pending/human ;;
    add-other)    lab labeled bug ;;
    push)         j items.json '.[$n].head.sha = "2222222222222222222222222222222222222222"' --arg n "$n" ;;
    rebase)       j items.json '.[$n].base.ref = "dev"' --arg n "$n" ;;
    body)         j items.json '.[$n].body = (.[$n].body + "\n\n补充说明")' --arg n "$n" ;;
    requeue)      lab unlabeled pending/merge; lab labeled pending/merge ;;
    rm-autopilot) lab unlabeled autopilot ;;
    undraft)      j items.json '.[$n].draft = false' --arg n "$n" ;;
    kill)         kill -9 "$(cat poll.pid)" 2>/dev/null ;;
    *) echo "gd-act: 不认识的动作 $2" >&2; exit 1 ;;
esac
SH
chmod +x "$SANDBOX/bin/gd-act"

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

# 改动前的脚本（没有交人发生的轮次逐字节对拍用）
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$SANDBOX/old"
git -C "$REPO_DIR" archive "$BASE_REV" scripts prompts | tar -x -C "$SANDBOX/old"
rm -rf "$SANDBOX/old/prompts"; cp -r "$REPO_DIR/prompts" "$SANDBOX/old/prompts"

H1=1111111111111111111111111111111111111111
H2=2222222222222222222222222222222222222222
R="repos/example/ap"
SCRIPTS="$REPO_DIR/scripts"
W="$SANDBOX/run"
OFF='LABEL_AUTOPILOT=""'

fresh() {   # [额外配置行…]
    rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh"
    git init -q "$W/project" 2>/dev/null
    GD="$W/gh"; export FAKE_GH_DIR="$GD"; CALLS="$GD/calls.log"; STATE="$W/state/state.json"
    CONF="$W/cavil-loop.config"
    cat > "$CONF" <<CONF
REPO="example/ap"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="aptest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
LABEL_AUTOPILOT="autopilot"
POST_MERGE_RETROSPECTIVE=false
AUTO_CLEANUP_ON_MERGE=false
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
    echo '{}' > "$GD/comments.json"; echo '{"maint":"admin","helper":"read"}' > "$GD/perms.json"
    echo '{}' > "$GD/checks.json"; echo '{}' > "$GD/files.json"; echo loop-bot > "$GD/me"
    echo '{}' > "$STATE"
}
conf_line() { printf '%s\n' "$1" >> "$CONF"; }            # 改配置：后写的一行生效
jset() { local f="$GD/$1" e="$2"; shift 2; jq "$@" "$e" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
sset() { jq "$@" "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"; }
ev() {   # <n> <labeled|unlabeled> <标签> <操作人>
    EVN=$((EVN + 1))
    jset events.json '.[$n] = ((.[$n] // []) + [{event:$e, label:{name:$l}, actor:{login:$a, type:"User"}, created_at:$c}])' \
        --arg n "$1" --arg e "$2" --arg l "$3" --arg a "$4" --arg c "$(printf '2026-01-01T00:%02d:00Z' "$EVN")"
}
act() { "$SANDBOX/bin/gd-act" "$GD" "$@"; }               # 现在就改（两轮之间）
# 一个准备好合并的托管 PR：issue 7（maint 打的托管标签）+ PR 8，复审记录和测试重跑记录齐全。
# PR 8 的标签记录：托管标签副本（编号 5000）、复审送进合并队列（5001）——假 GitHub 按位置给编号
happy() {
    jset items.json '.["7"] = {kind:"issue", state:"open", title:"t", body:"需求", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}'
    jset labels.json '.["7"] = ["autopilot","pending/PR"]'
    ev 7 labeled autopilot maint
    jset items.json '.["8"] = {kind:"pr", state:"open", merged:false, draft:false, title:"t", body:"做了 X。\n\nRefs #7",
            user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z", created_at:"2025-12-01T00:00:00Z",
            head:{sha:$h, ref:"feature/issue-7", repo:{full_name:"example/ap"}}, base:{ref:"main"},
            mergeable:true, mergeable_state:"clean"}' --arg h "$H1"
    jset labels.json '.["8"] = ["pending/merge","autopilot"]'
    ev 8 labeled autopilot loop-bot
    ev 8 labeled pending/merge loop-bot
    sset --arg h "$H1" '.autopilot.prs["8"] = {reviewed_head:$h, reviewed_at:"2026-01-01T00:00:00Z", reviewed_base:"main"}'
    jset comments.json '.["8"] = [{id:900, user:{login:"loop-bot"}, created_at:"2026-06-01T00:00:00Z",
            body:("## ✅ 复审通过\n\n<!-- autopilot-review-pass head=" + $h + " passed=12 failed=0 -->")}]' --arg h "$H1"
}
draft() { happy; jset items.json '.["8"].draft = true'; }   # 最简单的交人原因：草稿
tick() {   # [scripts 目录]
    : > "$CALLS"
    env CODING_AGENT_CONFIG="$CONF" bash "${1:-$SCRIPTS}/agent-poll.sh" >/dev/null 2>&1 &
    echo $! > "$GD/poll.pid"; wait $! 2>/dev/null
    return 0
}
n_calls() { grep -cE -- "$1" "$CALLS" 2>/dev/null || true; }
merged() { jq -r --arg n "${1:-8}" 'if .[$n].merged then 1 else 0 end' "$GD/items.json"; }   # 真的合并了没有
labels_of() { jq -r --arg n "$1" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
comments_with() { jq -r --arg n "${2:-8}" '(.[$n] // [])[].body' "$GD/comments.json" | grep -cF -- "$1" || true; }
writes() { n_calls "^gh api -X (POST|PUT|DELETE|PATCH) "; }
# 这一轮的写入顺序，缩成三个字母：C = 发评论，H = 加标签，M = 摘标签
wseq() {
    grep -E "^gh api -X (POST|DELETE) " "$CALLS" 2>/dev/null | sed -E \
        -e 's#^gh api -X POST [^ ]*/comments .*#C#' -e 's#^gh api -X POST [^ ]*/labels .*#H#' -e 's#^gh api -X DELETE [^ ]*/labels/.*#M#' | tr -d '\n'
}
pr_reads() { n_calls "^gh api $R/pulls/${1:-8}\$"; }
ev_reads() { n_calls "^gh api --paginate --slurp $R/issues/${1:-8}/events"; }
log_has() { grep -cF -- "$1" "$W/state/poll.log" 2>/dev/null || true; }
off_rec() { jq -r '(.autopilot.prs["8"] // {}) | if has("off_handover") then "待办" else "" end' "$STATE" 2>/dev/null; }
hook() {   # <hook 文件名（不带 hook_ 前缀）> <动作…>：到那个时刻由假 GitHub 执行「维护者的操作」
    printf '%q %q %s < /dev/null\n' "$SANDBOX/bin/gd-act" "$GD" "$2 ${3:-}" > "$GD/hook_$1"
}
nohooks() { rm -f "$GD"/hook_*; }

# 交人那一轮里 PR #8 被读的次数（GET pulls/8）：
#   1 触发（合并许可）  2 取基准  3 作数的判定  4 确认基准 →【发说明】
#   5 重判  6 核对 →【加 pending/human】  7 确认自己的写入  8 重判  9 核对 →【摘 pending/merge】
# hook pulls_8_<k> = 第 k 次读之前改状态。读和紧跟着的写之间没有读，那是消除不了的窗口，不在这里注入。

# ─────────────────────────────────────────────────────────────────────────
section "【1】稳定情况：每种交人原因都在同一轮完成三次写入（说明 → 加 pending/human → 摘 pending/merge）"
stable() {   # <说明> <原因代号> <说明里的一句话> [交人后的标签] [这一轮的写入顺序]
    chk "$1 → 没合并，PR 交到人手上" "$(merged)/$(labels_of 8)" "0/${4:-autopilot,pending/human}"
    chk "$1 → 三次写入的顺序" "$(wseq)" "${5:-CHM}"
    chk "$1 → 说明一条，带原因代号和本次入队的标记" \
        "$(comments_with "$3")/$(comments_with "<!-- cavil-loop:autopilot-handover pr=8 q=5001 head=$H1 why=$2 -->")" "1/1"
}
fresh; draft; tick
stable "草稿" draft 'PR 是草稿状态'
chk "草稿 → 到达性：这一轮读了 9 次 PR、5 次 PR 的标签记录（每次写入之前都核对）" "$(pr_reads)/$([ "$(ev_reads)" -ge 5 ] && echo yes || echo no)" "9/yes"
tick
chk "  → 下一轮零写入" "$(writes)" 0

fresh; happy; jset items.json '.["8"].head.repo.full_name = "fork/ap"'; tick
# 这种原因下，排在合并之前的「补标签」那一趟先把 daemon 补在 PR 上的托管标签副本收回（GitHub#190）：多一次摘标签
stable "来自 fork（不满足托管条件）" not-eligible '这个 PR 不满足托管条件' pending/human MCHM

fresh; happy; act add-human 7; tick
stable "issue 上挂了 pending/human" issue-halt 'issue #7 上挂了 `pending/human`'

fresh; happy; act rm-autopilot 7; tick
stable "issue 上的托管标签被摘掉（授权不成立）" auth '已叫停' pending/human MCHM

fresh; happy; jset files.json '.["8"] = [{"filename":".github/workflows/ci.yml"}]'; tick
stable "改了 .github/" github-dir '改动碰了 `.github/` 目录'

fresh 'AUTOPILOT_HUMAN_PATHS="default"'; happy; jset files.json '.["8"] = [{"filename":"client/package.json"}]'; tick
stable "碰了需人过目的文件" paths '改动碰了合并前需人过目的文件'

fresh 'AUTOPILOT_HUMAN_PATHS="a/b.txt"'; happy; tick
stable "需人过目清单写错" paths-config '有一个条目写法不认识'

fresh; happy; jset comments.json '.["8"] = []'; tick
stable "没有复审的测试重跑记录" no-evidence '找不到提交'

fresh; happy; : > "$GD/F_pulls_8_files"; tick; tick
chk "连续读不到（未到上限）→ 零写入" "$(writes)/$(labels_of 8)" "0/autopilot,pending/merge"
tick
stable "连续读不到到上限" unknown-cap '连续 3 轮读不到判断所需的信息'

fresh 'AUTOPILOT_CHECKS_TIMEOUT_HOURS=1'; happy
jset checks.json '.[$h] = {check_runs:[{name:"unit",status:"in_progress"}]}' --arg h "$H1"
sset '.autopilot.prs["8"].checks_pending_since = 1'; tick
stable "检查超时" checks-timeout '还没跑完'

fresh; happy; : > "$GD/F_merge_405"; tick
stable "GitHub 拒绝合并" merge-refused 'GitHub 拒绝合并'

fresh 'REVIEW_MAX_ROUNDS=2'; happy
jset checks.json '.[$h] = {check_runs:[{name:"unit",status:"completed",conclusion:"failure"}]}' --arg h "$H1"
sset '.autopilot.prs["8"].bounces = 2'; tick
stable "打回 worker 次数到上限" bounce-cap '合并前检查已经打回 worker 2 次'

fresh; happy; : > "$GD/F_merge_502"; tick; tick; tick
stable "合并请求连续失败到上限" unknown-cap '合并请求失败'

# 没绑 issue 的 PR（授权和叫停都只看 PR）
fresh
jset items.json '.["8"] = {kind:"pr", state:"open", merged:false, draft:true, title:"t", body:"做了 X。",
        user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z", created_at:"2025-12-01T00:00:00Z",
        head:{sha:$h, ref:"feature/xyz", repo:{full_name:"example/ap"}}, base:{ref:"main"}, mergeable:true, mergeable_state:"clean"}' --arg h "$H1"
jset labels.json '.["8"] = ["pending/merge","autopilot"]'
ev 8 labeled autopilot maint; ev 8 labeled pending/merge loop-bot
sset --arg h "$H1" '.autopilot.prs["8"] = {reviewed_head:$h, reviewed_at:"2026-01-01T00:00:00Z", reviewed_base:"main"}'
tick
stable "没绑 issue 的草稿 PR" draft 'PR 是草稿状态'

# 拆分子项：父 issue 50（维护者打的托管）→ 子项 51（loop 账号建、带拆分标记）→ PR 8
split() {
    jset items.json '.["50"] = {kind:"issue", state:"open", title:"t", body:"需求", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}'
    jset labels.json '.["50"] = ["autopilot","pending/PR"]'; ev 50 labeled autopilot maint
    jset items.json '.["51"] = {kind:"issue", state:"open", title:"t", body:"子项\n\n<!-- agent-split-from: #50 -->", user:{login:"loop-bot"},
            updated_at:"2026-01-01T00:00:00Z", parent_issue_url:"https://api.github.com/repos/example/ap/issues/50"}'
    jset labels.json '.["51"] = ["pending/PR"]'
    jset items.json '.["8"] = {kind:"pr", state:"open", merged:false, draft:true, title:"t", body:"做了 X。\n\nRefs #51\nPart of #50",
            user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z", created_at:"2025-12-01T00:00:00Z",
            head:{sha:$h, ref:"feature/issue-51", repo:{full_name:"example/ap"}}, base:{ref:"main"}, mergeable:true, mergeable_state:"clean"}' --arg h "$H1"
    jset labels.json '.["8"] = ["pending/merge","autopilot"]'
    ev 8 labeled autopilot loop-bot; ev 8 labeled pending/merge loop-bot
    sset --arg h "$H1" '.autopilot.prs["8"] = {reviewed_head:$h, reviewed_at:"2026-01-01T00:00:00Z", reviewed_base:"main"}'
}
fresh; split; tick
stable "拆分子项的草稿 PR" draft 'PR 是草稿状态'
chk "拆分子项 → 到达性：核对时读了子项和父 issue 的标签记录" \
    "$([ "$(ev_reads 51)" -ge 5 ] && echo yes || echo no)/$([ "$(ev_reads 50)" -ge 5 ] && echo yes || echo no)" "yes/yes"

# ─────────────────────────────────────────────────────────────────────────
section "【2】发说明之前维护者改了状态（触发之后任何一处）→ 一次都不写"
# 第 2 / 3 / 4 次读 PR 之前注入 = 触发后取基准前 / 取基准后判定前 / 判定后确认基准前
for k in 2 3 4; do
    for a in close unqueue add-human add-other push rebase body requeue undraft; do
        # 触发之后、取基准之前的改动不算「变化」：判定整个重做在新现状上，结论没变就照常交人（见【3】）
        if [ "$k" = 2 ]; then case "$a" in add-other|push|rebase|body|requeue) continue ;; esac; fi
        fresh; draft; hook "pulls_8_$k" "$a"; tick
        chk "第 $k 次读 PR 前 [$a] → 零写入" "$(writes)/$(comments_with 'cavil-loop:autopilot-handover')" "0/0"
        chk "第 $k 次读 PR 前 [$a] → 到达性：注入确实发生在核对途中" "$([ "$(pr_reads)" -ge "$k" ] && echo yes || echo no)" yes
    done
done
# 关联 issue 一侧的变化（PR 自己完全没动）
fresh; happy; act add-human 7; hook pulls_8_4 "rm-human 7"; tick
chk "判定后 issue 上撤销了叫停 → 零写入" "$(writes)/$(labels_of 8)" "0/autopilot,pending/merge"
chk "  → 到达性：这一轮确实走到了交人的核对" "$([ "$(pr_reads)" -ge 4 ] && echo yes || echo no)" yes
fresh; draft; hook pulls_8_4 "rm-autopilot 7"; tick
chk "判定后 issue 上的托管标签被摘掉 → 零写入" "$(writes)" 0
fresh; draft; hook pulls_8_4 "close 7"; tick
chk "判定后 issue 被关闭 → 零写入" "$(writes)" 0
fresh; split; hook pulls_8_4 "add-other 50"; tick
chk "判定后父 issue 上动了标签 → 零写入" "$(writes)" 0
nohooks; tick
chk "  → 下一轮（没人再动）照常完成交人" "$(wseq)/$(labels_of 8)" "CHM/autopilot,pending/human"

# ─────────────────────────────────────────────────────────────────────────
section "【3】触发之后、取基准之前重新入队：旧判断不作数，判定整个重做在新的一次排队上"
fresh; draft; hook pulls_8_2 requeue; tick
chk "同一提交重新入队后仍是草稿 → 交人完成，说明标记的是新的一次入队（编号 5003），不是旧的 5001" \
    "$(wseq)/$(comments_with 'q=5003 ')/$(comments_with 'q=5001 ')" "CHM/1/0"
fresh; draft; hook pulls_8_2 requeue; hook pulls_8_3 undraft; tick
chk "重新入队之后、重做判定之前又改成不是草稿 → 零写入" "$(writes)" 0

# ─────────────────────────────────────────────────────────────────────────
section "【4】说明发出之后、加 pending/human 之前维护者改了状态 → 不加、不摘"
for a in close unqueue add-human add-other push rebase body requeue undraft; do
    fresh; draft; hook pulls_8_5 "$a"; tick
    chk "说明后 [$a] → 只发了说明，标签一个没动" "$(wseq)/$(comments_with 'cavil-loop:autopilot-handover')" "C/1"
done
fresh; happy; act add-human 7; hook pulls_8_6 "rm-human 7"; tick
chk "说明后 issue 上撤销了叫停（PR 没动）→ 不加、不摘" "$(wseq)/$(labels_of 8)" "C/autopilot,pending/merge"
nohooks; tick
chk "  → 下一轮按现状：不再需要交人，照常合并" "$(merged)" 1
fresh; draft; hook after_POST_issues_8_comments_1 "rm-autopilot 7"; tick
chk "说明后 issue 上的托管标签被摘掉 → 不加、不摘" "$(wseq)" "C"

fresh; draft; hook pulls_8_5 requeue; tick
nohooks; tick
chk "说明后同一提交重新入队 → 下一轮按新的一次入队重新发说明（旧说明不算），交人完成" \
    "$(wseq)/$(comments_with 'q=5001 ')/$(comments_with 'q=5003 ')/$(labels_of 8)" "CHM/1/1/autopilot,pending/human"
fresh; draft; hook pulls_8_5 add-other; tick
nohooks; tick
chk "说明后加了个无关标签 → 下一轮仍是同一次入队：说明不重发，只补两次标签写" \
    "$(wseq)/$(comments_with 'cavil-loop:autopilot-handover')/$(labels_of 8)" "HM/1/autopilot,bug,pending/human"

# ─────────────────────────────────────────────────────────────────────────
section "【5】加 pending/human 之后、摘 pending/merge 之前维护者改了状态 → 不摘"
# hook after_POST_issues_8_labels_1 = daemon 那次加标签已经生效之后
for a in close add-other push rebase body requeue rm-human; do
    fresh; draft; hook after_POST_issues_8_labels_1 "$a"; tick
    chk "加标签后 [$a] → 说明和加标签发生了，没有摘" "$(wseq)" "CH"
done
fresh; draft; hook pulls_8_8 push; tick
chk "确认过自己的写入之后、摘之前推了新提交 → 没有摘" "$(wseq)/$(labels_of 8)" "CH/autopilot,pending/human,pending/merge"
fresh; happy; act add-human 7; hook pulls_8_8 "rm-human 7"; tick
chk "加标签后 issue 上撤销了叫停 → 没有摘" "$(wseq)" "CH"
fresh; draft; hook after_POST_issues_8_labels_1 unqueue; tick
chk "加标签后维护者自己摘了 pending/merge → daemon 不再写" "$(wseq)/$(labels_of 8)" "CH/autopilot,pending/human"
# 维护者和 daemon 同一瞬间都加了 pending/human：标签只有一枚，记录里那一条不是写入账号的
fresh; draft; hook POST_issues_8_labels_1 add-human; tick
chk "加标签的同一瞬间维护者也加了 → daemon 认不出是自己的那一次，不摘" "$(wseq)/$(labels_of 8)" "CH/autopilot,pending/human,pending/merge"
nohooks; tick
chk "  → 下一轮按现状（两个标签都在）只摘 pending/merge，不再发说明" "$(wseq)/$(comments_with 'cavil-loop:autopilot-handover')" "M/1"

# 停手之后的下一轮：按那一刻的现状重新判断
fresh; draft; hook after_POST_issues_8_labels_1 requeue; tick
nohooks; tick
chk "保留 pending/human 重新入队 → 下一轮按现状（两个标签都在）摘掉 pending/merge" "$(wseq)/$(labels_of 8)" "M/autopilot,pending/human"
fresh; draft; hook after_POST_issues_8_labels_1 rm-human; tick
nohooks; tick
chk "pending/human 被摘掉 → 下一轮重新判断：仍是草稿，说明不重发，补完交人" \
    "$(wseq)/$(comments_with 'cavil-loop:autopilot-handover')/$(labels_of 8)" "HM/1/autopilot,pending/human"
fresh; draft; hook after_POST_issues_8_labels_1 close; tick
nohooks; tick
chk "PR 被关闭 → 下一轮零写入" "$(writes)" 0

# ─────────────────────────────────────────────────────────────────────────
section "【6】中断与失败：下一轮接上，说明只有一条"
fresh; draft; hook after_POST_issues_8_comments_1 kill; tick
chk "说明发出后进程被杀 → 只有说明" "$(comments_with 'cavil-loop:autopilot-handover')/$(labels_of 8)" "1/autopilot,pending/merge"
nohooks; sleep 0.3; tick
chk "  → 下一轮不重发说明，补完两次标签写" "$(wseq)/$(comments_with 'cavil-loop:autopilot-handover')/$(labels_of 8)" "HM/1/autopilot,pending/human"

fresh; draft; : > "$GD/F_post_comment_lost"; tick
chk "说明已生效但报失败 → 不翻标签" "$(comments_with 'cavil-loop:autopilot-handover')/$(labels_of 8)" "1/autopilot,pending/merge"
rm -f "$GD/F_post_comment_lost"; tick
chk "  → 下一轮认出已发的说明，不重发" "$(wseq)/$(comments_with 'cavil-loop:autopilot-handover')" "HM/1"

fresh; draft; : > "$GD/F_post_comment"; tick
chk "说明没发出去 → 不翻标签（不出现没有说明的 pending/human）" "$(comments_with 'cavil-loop:autopilot-handover')/$(labels_of 8)" "0/autopilot,pending/merge"
rm -f "$GD/F_post_comment"; tick
chk "  → 恢复后完成" "$(wseq)/$(labels_of 8)" "CHM/autopilot,pending/human"

fresh; draft; : > "$GD/F_post_labels"; tick
chk "加标签失败 → 说明已发，标签没动" "$(comments_with 'cavil-loop:autopilot-handover')/$(labels_of 8)" "1/autopilot,pending/merge"
rm -f "$GD/F_post_labels"; tick
chk "  → 下一轮只补标签" "$(wseq)/$(comments_with 'cavil-loop:autopilot-handover')/$(labels_of 8)" "HM/1/autopilot,pending/human"

fresh; draft; : > "$GD/F_delete_labels"; tick
chk "摘标签失败 → 两个标签都在" "$(labels_of 8)" "autopilot,pending/human,pending/merge"
rm -f "$GD/F_delete_labels"; tick
chk "  → 下一轮按现状摘掉，不再发说明" "$(wseq)/$(comments_with 'cavil-loop:autopilot-handover')/$(labels_of 8)" "M/1/autopilot,pending/human"

fresh; draft; hook after_POST_issues_8_labels_1 kill; tick
chk "加完 pending/human 后进程被杀 → 两个标签都在" "$(labels_of 8)" "autopilot,pending/human,pending/merge"
nohooks; sleep 0.3; tick
chk "  → 下一轮按现状摘掉 pending/merge" "$(wseq)/$(labels_of 8)" "M/autopilot,pending/human"

# ─────────────────────────────────────────────────────────────────────────
section "【7】分不清（读不到、记录缺编号、记录和标签对不上）→ 本轮零写入；恢复后照常完成"
# 用「issue 上叫停」这个原因：判定本身不读标签记录和评论，读不到的只有写前核对
unk() {   # <说明> <准备（在 happy + issue 叫停 之后执行）> <恢复>
    fresh; happy; act add-human 7; eval "$2"; tick
    chk "$1 → 零写入" "$(writes)/$(labels_of 8)" "0/autopilot,pending/merge"
    chk "$1 → 到达性：这一轮确实判定了要交人、停在写前核对" "$([ $(( $(log_has 'PR #8 该交人') + $(log_has 'PR #8 交人前') )) -ge 1 ] && echo yes || echo no)" yes
    eval "$3"; tick
    chk "$1 → 恢复后完成交人" "$(wseq)/$(labels_of 8)" "CHM/autopilot,pending/human"
}
unk "PR 的标签记录读不到" ': > "$GD/F_issues_8_events"' 'rm -f "$GD/F_issues_8_events"'
unk "issue 的标签记录读不到" ': > "$GD/F_issues_7_events"' 'rm -f "$GD/F_issues_7_events"'
unk "issue 读不到（第 2 次起）" 'printf "touch %q\n" "$GD/F_issues_7" > "$GD/hook_issues_7_1"' 'rm -f "$GD/F_issues_7" "$GD/hook_issues_7_1"'
unk "评论读不到" ': > "$GD/F_issues_8_comments"' 'rm -f "$GD/F_issues_8_comments"'
unk "写入账号读不到" ': > "$GD/F_user"' 'rm -f "$GD/F_user"'
unk "标签记录缺编号" \
    'cp "$GD/events.json" "$GD/events.keep"; jset events.json ".[\"8\"][1].id = null"' 'cp "$GD/events.keep" "$GD/events.json"'
unk "标签记录和当前标签对不上（挂着 pending/merge，记录里最后一次却是摘掉）" \
    'cp "$GD/events.json" "$GD/events.keep"; ev 8 unlabeled pending/merge maint' 'cp "$GD/events.keep" "$GD/events.json"'
unk "标签记录里编号重复" \
    'cp "$GD/events.json" "$GD/events.keep"; jset events.json ".[\"8\"][0].id = 7 | .[\"8\"][1].id = 7"' 'cp "$GD/events.keep" "$GD/events.json"'

# ─────────────────────────────────────────────────────────────────────────
section "【8】PR 上已挂着 pending/human（维护者叫停）：只摘 pending/merge、不发说明；摘之前现状变了就不摘"
fresh; happy; act add-human; tick
chk "维护者自己挂了 pending/human → 只摘 pending/merge，不留言" "$(wseq)/$(labels_of 8)/$(comments_with 'cavil-loop daemon')" "M/autopilot,pending/human/0"
# 这一轮读 PR：1 合并许可（看到两个标签）  2 取基准  3 核对 →【摘】
for a in rm-human requeue add-other push close unqueue; do
    fresh; happy; act add-human; hook pulls_8_3 "$a"; tick
    chk "取基准之后 [$a] → 不摘" "$(writes)" 0
    chk "取基准之后 [$a] → 到达性：核对确实读了" "$([ "$(pr_reads)" -ge 3 ] && echo yes || echo no)" yes
done
fresh; happy; act add-human; : > "$GD/F_issues_8_events"; tick
chk "标签记录读不到 → 不摘" "$(writes)/$(labels_of 8)" "0/autopilot,pending/human,pending/merge"
rm -f "$GD/F_issues_8_events"; tick
chk "  → 恢复后摘掉" "$(wseq)/$(labels_of 8)" "M/autopilot,pending/human"
fresh; happy; act add-human; hook pulls_8_3 rm-human; tick
nohooks; tick
chk "维护者撤销叫停并留在队列里 → 下一轮照常合并" "$(merged)" 1

# ─────────────────────────────────────────────────────────────────────────
section "【9】托管关掉后的收尾：加 pending/human → 摘 pending/merge → 发说明，三次写入逐次核对；待办带着基准"
OFFMSG='托管已在配置里关掉'
fresh "$OFF"; happy; tick
chk "稳定 → 三次写入、交到人手上、说明一条、待办清掉" "$(wseq)/$(labels_of 8)/$(comments_with "$OFFMSG")/$(off_rec)" "HMC/autopilot,pending/human/1/"
chk "  → 说明带本次入队的标记" "$(comments_with '<!-- cavil-loop:autopilot-off pr=8 q=5001 -->')" 1
tick
chk "  → 下一轮零写入，也不再读这个 PR" "$(writes)/$(pr_reads)" "0/0"

# 这一轮读 PR：1 取基准  2 核对 →【加】  3 确认  4 核对 →【摘】  5 确认  6 核对 →【发说明】
for a in close requeue push add-other rm-human; do
    for k in 2 4 6; do
        [ "$a" = rm-human ] && [ "$k" = 2 ] && continue   # 那时 pending/human 还没加
        fresh "$OFF"; happy; hook "pulls_8_$k" "$a"; tick
        case "$k" in 2) want="" ;; 4) want=H ;; 6) want=HM ;; esac
        chk "收尾第 $k 次核对前 [$a] → 之后不再写（已写：${want:-无}）" "$(wseq)/$(comments_with "$OFFMSG")" "$want/0"
    done
done

# 方案复审第 2 轮的两轮时序：标签都翻好了、说明还没发，维护者摘掉 pending/human 自己接手
fresh "$OFF"; happy; hook pulls_8_6 rm-human; tick
chk "当轮：发说明之前维护者摘掉了 pending/human → 不发说明" "$(wseq)/$(comments_with "$OFFMSG")/$(labels_of 8)" "HM/0/autopilot"
nohooks; tick; w1=$(writes); r1=$(off_rec); tick
chk "  → 之后两轮都零写入：待办作废，不把 pending/human 加回来，不补说明" "$w1/$r1/$(writes)/$(labels_of 8)/$(comments_with "$OFFMSG")" "0//0/autopilot/0"

fresh "$OFF"; happy; : > "$GD/F_post_comment"; tick
chk "说明没发出去 → 标签已翻、待办留着" "$(labels_of 8)/$(off_rec)" "autopilot,pending/human/待办"
act rm-human; rm -f "$GD/F_post_comment"; tick
chk "两轮之间维护者摘掉 pending/human 接手 → 下一轮待办作废，零写入" "$(writes)/$(off_rec)/$(labels_of 8)" "0//autopilot"
chk "  → 到达性：这一轮确实读了 PR 的现状来比对" "$([ "$(pr_reads)" -ge 1 ] && echo yes || echo no)" yes
tick
chk "  → 再下一轮也零写入" "$(writes)/$(comments_with "$OFFMSG")" "0/0"

fresh "$OFF"; happy; : > "$GD/F_post_comment"; tick
rm -f "$GD/F_post_comment"; tick
chk "对照：两轮之间没人动 → 下一轮只补发说明，清掉待办" "$(wseq)/$(comments_with "$OFFMSG")/$(off_rec)" "C/1/"

# 作废之后 PR 仍在合并队列：下一轮当作新的一件事从头开始（不在作废的同一轮里重开）
fresh "$OFF"; happy; hook after_POST_issues_8_labels_1 add-other; tick
chk "加完 pending/human 后维护者加了无关标签 → 本轮到此为止" "$(wseq)" "H"
nohooks; tick
chk "  → 下一轮：待办作废，这一轮不写" "$(writes)/$(off_rec)" "0/"
tick
chk "  → 再下一轮：仍挂着等合并标签，作为新的一件事完成（pending/human 已在，不重加）" \
    "$(wseq)/$(labels_of 8)/$(comments_with "$OFFMSG")/$(off_rec)" "MC/autopilot,bug,pending/human/1/"

# 每次写入前后进程被杀：下一轮分得清「写成了没记」和「没写成」
fresh "$OFF"; happy; hook after_POST_issues_8_labels_1 kill; tick
chk "加 pending/human 写成后进程被杀 → 待办留着（记着待写的那一步）" "$(labels_of 8)/$(off_rec)" "autopilot,pending/human,pending/merge/待办"
nohooks; sleep 0.3; tick
chk "  → 下一轮认出那次是自己写成的，接着摘、发说明" "$(wseq)/$(labels_of 8)/$(comments_with "$OFFMSG")/$(off_rec)" "MC/autopilot,pending/human/1/"
fresh "$OFF"; happy; hook POST_issues_8_labels_1 kill; tick
chk "加 pending/human 的请求刚发出进程就被杀（daemon 没看到结果，GitHub 上已生效）→ 待办留着" "$(labels_of 8)/$(off_rec)" "autopilot,pending/human,pending/merge/待办"
nohooks; sleep 0.3; tick
chk "  → 下一轮认出是自己写成的，接着摘、发说明" "$(wseq)/$(labels_of 8)/$(comments_with "$OFFMSG")" "MC/autopilot,pending/human/1"
fresh "$OFF"; happy; : > "$GD/F_post_labels"; tick
chk "加 pending/human 没写成（待写已记下）→ 标签没动、待办留着" "$(labels_of 8)/$(off_rec)" "autopilot,pending/merge/待办"
rm -f "$GD/F_post_labels"; tick
chk "  → 下一轮现状等于预期，从这一步接着做完" "$(wseq)/$(labels_of 8)/$(comments_with "$OFFMSG")" "HMC/autopilot,pending/human/1"
fresh "$OFF"; happy; hook after_POST_issues_8_comments_1 kill; tick
nohooks; sleep 0.3; tick
chk "说明发出后进程被杀（待办没清）→ 下一轮不重发，只清待办" "$(writes)/$(comments_with "$OFFMSG")/$(off_rec)" "0/1/"

fresh "$OFF"; happy; : > "$GD/F_issues_8_events"; tick
chk "标签记录读不到 → 零写入、不记待办" "$(writes)/$(off_rec)" "0/"
rm -f "$GD/F_issues_8_events"; tick
chk "  → 恢复后完成" "$(wseq)/$(labels_of 8)" "HMC/autopilot,pending/human"

# 收尾做到一半重新开启托管：待办被清；之后再关闭，旧待办不会复活
fresh "$OFF"; happy; : > "$GD/F_post_comment"; tick
chk "（准备）标签已翻、说明欠着、待办在" "$(labels_of 8)/$(off_rec)" "autopilot,pending/human/待办"
rm -f "$GD/F_post_comment"; conf_line 'LABEL_AUTOPILOT="autopilot"'; tick
chk "重新开启托管 → 待办被清，这一轮不写" "$(off_rec)/$(writes)" "/0"
conf_line "$OFF"; tick
chk "之后再关闭 → 这个 PR 不在合并队列，不再碰（不补发上次欠的说明）" "$(writes)/$(comments_with "$OFFMSG")" "0/0"

# 关闭托管时，交人（流程一）停在两个中间状态
fresh; draft; : > "$GD/F_post_labels"; tick
chk "（准备）开着时交人只发了说明" "$(comments_with 'cavil-loop:autopilot-handover')/$(labels_of 8)" "1/autopilot,pending/merge"
rm -f "$GD/F_post_labels"; conf_line "$OFF"; tick
chk "关闭托管 → 收尾接手：加、摘、发「托管已关」说明（两条说明各说各的）" \
    "$(wseq)/$(labels_of 8)/$(comments_with 'cavil-loop:autopilot-handover')/$(comments_with "$OFFMSG")" "HMC/autopilot,pending/human/1/1"
fresh; draft; : > "$GD/F_delete_labels"; tick
chk "（准备）开着时交人加了 pending/human、没摘掉 pending/merge" "$(labels_of 8)" "autopilot,pending/human,pending/merge"
rm -f "$GD/F_delete_labels"; conf_line "$OFF"; tick
chk "关闭托管 → 收尾接手：只摘、发「托管已关」说明" "$(wseq)/$(labels_of 8)/$(comments_with "$OFFMSG")" "MC/autopilot,pending/human/1"

# 关掉再开启：交人不留本机待办，开启后按 GitHub 现状重判；同一次入队已发的说明不重发
fresh; draft; : > "$GD/F_post_labels"; tick
conf_line "$OFF"; : > "$GD/F_issues_8_events"; tick     # 关着的这一轮什么都读不全、什么都没做
rm -f "$GD/F_post_labels" "$GD/F_issues_8_events"; conf_line 'LABEL_AUTOPILOT="autopilot"'; tick
chk "关掉又开启 → 按现状重判：说明不重发，补完交人" "$(wseq)/$(comments_with 'cavil-loop:autopilot-handover')/$(labels_of 8)" "HM/1/autopilot,pending/human"

# ─────────────────────────────────────────────────────────────────────────
section "【10】没有交人发生的轮次：GitHub 调用、state.json、评论、标签与改动前逐字节一致"
same_run() {   # <scripts 根> <场景>
    local root="$1" sc="$2" i
    case "$sc" in off-none) fresh "$OFF" ;; *) fresh ;; esac
    happy
    case "$sc" in
        merge) ;;
        wait-checks) jset checks.json '.[$h] = {check_runs:[{name:"unit",status:"in_progress"}]}' --arg h "$H1" ;;
        to-worker)   jset checks.json '.[$h] = {check_runs:[{name:"unit",status:"completed",conclusion:"failure"}]}' --arg h "$H1" ;;
        conflict)    jset items.json '.["8"].mergeable = false | .["8"].mergeable_state = "dirty"' ;;
        to-review)   jset items.json '.["8"].head.sha = $h' --arg h "$H2" ;;
        unknown)     : > "$GD/F_pulls_8_files" ;;
        in-review)   jset labels.json '.["8"] = ["pending/review","autopilot"]' ;;
        off-none)    echo '{}' > "$STATE"; jset labels.json '.["8"] = ["pending/review","autopilot"]' ;;
    esac
    for i in 1 2; do
        tick "$root/scripts"
        echo "── 第 $i 轮调用"; cat "$CALLS"
    done
    echo "── state"; jq -S 'del(.autopilot.handoff)' "$STATE" | sed -E 's/20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z/<时间>/g; s/"checks_pending_since": [0-9]+/"checks_pending_since": <秒>/'
    echo "── 标签"; jq -S . "$GD/labels.json"
    echo "── 评论"; jq -S '[.[] | .[] | .body]' "$GD/comments.json"
}
if ! compat_skip "没有交人的轮次与改动前" "$SANDBOX/old" "$REPO_DIR" scripts; then
    for sc in merge wait-checks to-worker conflict to-review unknown in-review off-none; do
        old=$(same_run "$SANDBOX/old" "$sc"); new=$(same_run "$REPO_DIR" "$sc")
        chk "场景 $sc → 和改动前逐字节一样" "$([ -n "$new" ] && [ "$old" = "$new" ] && echo same || echo differ)" same
        [ "$old" = "$new" ] || [ -z "${KEEP_SANDBOX:-}" ] || { printf '%s\n' "$old" > "$SANDBOX/same-$sc.old"; printf '%s\n' "$new" > "$SANDBOX/same-$sc.new"; }
    done
fi
# 到达性：上面比的不是空记录——这几个场景确实合并了 / 打回了 / 重审了
fresh; happy; tick
chk "到达性 · 正常的托管 PR 照常合并" "$(merged)" 1
fresh; happy; jset checks.json '.[$h] = {check_runs:[{name:"unit",status:"completed",conclusion:"failure"}]}' --arg h "$H1"; tick
chk "到达性 · 检查没过 → 交回 worker（不是交人）" "$(labels_of 8)/$(comments_with 'cavil-loop:autopilot-handover')" "autopilot,pending/agent/0"
fresh; happy; jset items.json '.["8"].head.sha = $h' --arg h "$H2"; tick
chk "到达性 · 复审之后有新提交 → 重新交复审（不是交人）" "$(labels_of 8)" "autopilot,pending/review"

echo
compat_summary
echo "通过 $pass / 失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
