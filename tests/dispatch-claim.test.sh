#!/usr/bin/env bash
# kind: e2e
# 派工先认领、再交任务（GitHub#700）。
#
# 跑法：bash tests/dispatch-claim.test.sh     （约 1 分钟）
# 依赖：bash、jq、python3、git。不碰网络：常驻假 GitHub（tests/lib/fake_github.py，按状态回答、记下每次调用）
# + 假 tmux（记下送任务 / 起程序，和假 GitHub 的调用写进同一条时间线），HOME 指向临时目录；
# 派工脚本、轮询主程序都是真脚本。
#
# 以前三个派工脚本先把任务交给 worker、之后才翻 doing/agent：worker 一拿到任务就读状态，读到
# 「一个流程标签都没有」或还没摘的 pending/agent，就判定本次派工不持有条目、停下（GigleStudyBuddy#494）。
# 这里断言的是先后和结果，不是源码：
#   ① 认领（加 doing/agent、摘触发标签、读回）全部发生在送任务 / 起程序之前；送任务之后没有标签写入
#   ② 送任务那一刻跑真实的状态读取脚本，输出 holding yes；worker 秒交回下一轮不会被 daemon 盖掉
#   ③ 正常复审（pending/review）、挂着等前置标签又被打了派工标签的，照常认领、交任务
#   ④ 认领前人已撤回 / 关闭 / PR 变了 → 78，什么都不写；读不到 → 77，什么都不写
#   ⑤ 认领只做成一部分 → 复原成原样、读回一致 → 1；复原前人改了 → 78；读回读不到 → 77
#   ⑥ 交任务开始后起程序报错 → 77，doing/agent 留着
#   ⑦ 真实轮询主程序：失败次数到上限减一时，77 / 78 不留言、不写标签、计数不动；确定失败（1）照旧转人工
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TZ=UTC
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT LABEL_PENDING_BLOCKED GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN POLL_FAKE_NOW
unset DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR DISPATCH_PROMPT_KIND DISPATCH_PENDING_AGENT_LABEL
unset DISPATCH_CLAIM_SOURCE DISPATCH_PR_BASE DISPATCH_PR_HEAD DISPATCH_PR_SOURCE DISPATCH_STUCK_RELEASE
export FAKE_GH_LISTS=1 FAKE_GH_REPO="example/dc"

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
# 假 tmux：会话名单在 $FAKE_TMUX_DIR/live；每个动作记进假 GitHub 的 calls.log（同一条时间线）。
#   paste-buffer      = 往会话里送任务；之后画面变成「在忙」，注入判成功
#   send-keys Enter   = 提交；有 $FAKE_TMUX_DIR/on_enter 就跑它（模拟 worker 一拿到任务就干的事）
#   new-session       = 起程序；有 $FAKE_TMUX_DIR/fail_new 就报错
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
d="${FAKE_TMUX_DIR:?}"
printf 'tmux %s\n' "$*" >> "$FAKE_GH_DIR/calls.log"
tgt=""; prev=""
for a in "$@"; do [ "$prev" = -t ] || [ "$prev" = -s ] && tgt="${a#=}"; prev="$a"; done
tgt="${tgt%%:*}"
case "$1" in
    has-session) grep -qxF -- "$tgt" "$d/live" 2>/dev/null; exit $? ;;
    new-session)
        [ -e "$d/fail_new" ] && exit 1
        echo "$tgt" >> "$d/live"; exit 0 ;;
    ls|list-sessions) [ -s "$d/live" ] && cat "$d/live"; exit 0 ;;
    show-options) exit 0 ;;
    capture-pane) [ -e "$d/busy" ] && echo "✻ Working… (esc to interrupt)"; exit 0 ;;
    paste-buffer) : > "$d/busy"; exit 0 ;;
    send-keys)
        case " $* " in *" Enter "*) [ -e "$d/on_enter" ] && bash "$d/on_enter" ;; esac
        exit 0 ;;
esac
exit 0
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$SANDBOX/bin/claude"
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/tmux" "$SANDBOX/bin/claude"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

git init -q --bare -b main "$SANDBOX/origin.git"
git clone -q "$SANDBOX/origin.git" "$SANDBOX/seed" 2>/dev/null
(cd "$SANDBOX/seed" && git -c user.email=t@x -c user.name=t commit -q --allow-empty -m init && git push -q origin HEAD:main \
    && git -c user.email=t@x -c user.name=t commit -q --allow-empty -m "pr work" && git push -q origin "HEAD:refs/pull/40/head") >/dev/null 2>&1

W="$SANDBOX/w"; GD="$W/gh"; CONF="$W/cavil-loop.config"; CALLS="$GD/calls.log"; TD="$W/tmux"
R="repos/example/dc"
HEAD_SHA="1111111111111111111111111111111111111111"
export FAKE_GH_DIR="$GD" FAKE_TMUX_DIR="$TD"

# 一套全新的环境。$1 = 追加进配置的行
fresh() {
    rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$GD" "$TD"
    git clone -q "$SANDBOX/origin.git" "$W/project" 2>/dev/null
    cat > "$CONF" <<CONF
REPO="example/dc"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="dctest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_PENDING_REVIEW="pending/review"
LABEL_PENDING_BLOCKED="pending/blocked"
LABEL_AGENT_DOING="doing/agent"
LABEL_DONE="Done"
LABEL_AUTOPILOT=""
POST_MERGE_RETROSPECTIVE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=3
DISPATCH_MAX_RETRIES=3
AGENT_TRUST_PROMPT_WAIT_SECS=1
INJECT_STATE_WAIT_SECS=0
WORKER_SECRET_ENV=""
ENABLE_ROUND_LOG=false
AUTO_ASSIGN_REQUESTER=false
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
${1:-}
CONF
    chmod 600 "$CONF"
    echo '{}' > "$GD/events.json"; echo '{}' > "$GD/perms.json"; echo loop-bot > "$GD/me"
    echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/comments.json"
    echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$W/state/state.json"
    : > "$CALLS"; : > "$TD/live"
}
mkissue() {   # <编号> <标签逗号串> [state]
    local t; t=$(mktemp)
    jq --arg n "$1" --arg s "${3:-open}" '.[$n] = {kind:"issue", state:$s, title:"t", body:"b", user:{login:"maint"},
        updated_at:"2026-01-01T00:00:00Z"}' "$GD/items.json" > "$t" && mv "$t" "$GD/items.json"
    setlabels "$1" "$2"
}
mkpr() {   # <编号> <标签逗号串> [merged]
    local t; t=$(mktemp)
    jq --arg n "$1" --arg sha "$HEAD_SHA" --argjson m "${3:-false}" '.[$n] = {kind:"pr", state:(if $m then "closed" else "open" end),
        merged:$m, draft:false, title:"p", body:"x", user:{login:"loop-bot"}, updated_at:"2026-01-01T00:00:00Z",
        head:{sha:$sha, ref:("feature/issue-" + $n), repo:{full_name:"example/dc"}}, base:{ref:"main"}}' "$GD/items.json" > "$t" \
        && mv "$t" "$GD/items.json"
    setlabels "$1" "$2"
}
setlabels() {   # <编号> <标签逗号串>
    local t; t=$(mktemp)
    jq --arg n "$1" --arg l "$2" '.[$n] = ($l | split(",") | map(select(length > 0)))' "$GD/labels.json" > "$t" && mv "$t" "$GD/labels.json"
}
labels_of() { jq -r --arg n "$1" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
live() { echo "dctest-issue$1" >> "$TD/live"; }
# 时间线里第一处匹配的行号（没有 = 0）
at() { grep -n -m1 -E -- "$1" "$CALLS" 2>/dev/null | cut -d: -f1 | grep . || echo 0; }
# 某一行号之后有没有标签写入
label_writes_after() { awk -v n="$1" 'NR > n && /^gh api -X (POST|DELETE) [^ ]*\/labels/' "$CALLS" | wc -l | tr -d ' '; }
label_writes() { grep -cE '^gh api -X (POST|DELETE) [^ ]*/labels' "$CALLS" || true; }
delivered() { grep -cE '^tmux (paste-buffer|new-session)' "$CALLS" || true; }

# 跑一个派工脚本。$1 = 脚本名，其余是它的参数；环境变量里放本次派工的期望（和轮询主程序传的一样）
RC=""
run_dispatch() {
    local s="$1"; shift
    RC=0
    (cd "$W/project" && env CODING_AGENT_CONFIG="$CONF" timeout 120 bash "$REPO_DIR/scripts/$s.sh" "$@" >/dev/null 2>&1) || RC=$?
}

echo "── ① 先认领、再送任务（issue 新评论，往活着的会话里送）──"
fresh; mkissue 11 "pending/agent"; live 11
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label run_dispatch dispatch-issue-comment 11 0
chk "退出 0（已送出）" "$RC" 0
chk "标签只剩 doing/agent" "$(labels_of 11)" "doing/agent"
add=$(at "^gh api -X POST $R/issues/11/labels"); del=$(at "^gh api -X DELETE $R/issues/11/labels/pending%2Fagent"); paste=$(at '^tmux paste-buffer')
chk "到达性 · 加 doing/agent、摘 pending/agent、送任务都发生了" "$([ "$add" -gt 0 ] && [ "$del" -gt 0 ] && [ "$paste" -gt 0 ] && echo yes)" yes
chk "加 doing/agent 在摘触发标签之前" "$([ "$add" -lt "$del" ] && echo yes)" yes
chk "认领在送任务之前" "$([ "$del" -lt "$paste" ] && echo yes)" yes
chk "送任务之后没有任何标签写入" "$(label_writes_after "$paste")" 0

echo "── ② 送任务那一刻 worker 读状态：真实的状态读取脚本 ──"
fresh; mkissue 12 "pending/agent"; live 12
cat > "$TD/on_enter" <<EOF
env CODING_AGENT_CONFIG="$CONF" bash "$REPO_DIR/scripts/feedback-fingerprint.sh" snapshot 12 2>/dev/null | grep -E '^(holding|write) ' > "$TD/worker-saw"
EOF
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label run_dispatch dispatch-issue-comment 12 0
chk "退出 0" "$RC" 0
chk "worker 一拿到任务就读：持有条目" "$(grep '^holding' "$TD/worker-saw" 2>/dev/null)" "holding yes"
chk "worker 一拿到任务就读：可以写" "$(grep -c '^write ok' "$TD/worker-saw" 2>/dev/null)" 1

echo "── ② worker 秒答、立刻交回下一轮：daemon 不覆盖 ──"
fresh; mkissue 13 "pending/agent"; live 13
cat > "$TD/on_enter" <<EOF
env CODING_AGENT_CONFIG="$CONF" bash -c 'gh api -X POST $R/issues/13/labels -f "labels[]=pending/review" >/dev/null; gh api -X DELETE $R/issues/13/labels/doing%2Fagent >/dev/null'
EOF
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label run_dispatch dispatch-issue-comment 13 0
chk "退出 0" "$RC" 0
chk "条目停在 worker 交回的 pending/review" "$(labels_of 13)" "pending/review"

echo "── ③ 正常复审 / 等前置期间又被打了派工标签：照常认领、交任务 ──"
fresh; mkissue 14 "pending/review"; live 14
DISPATCH_PENDING_AGENT_LABEL=pending/review DISPATCH_CLAIM_SOURCE=label run_dispatch dispatch-issue-comment 14 0
chk "issue · pending/review 派工：退出 0" "$RC" 0
chk "issue · pending/review 换成 doing/agent" "$(labels_of 14)" "doing/agent"
chk "issue · 任务送出去了" "$(delivered)" 1
fresh; mkpr 40 "pending/review"; live 40
DISPATCH_PENDING_AGENT_LABEL=pending/review DISPATCH_CLAIM_SOURCE=label DISPATCH_PR_BASE=main DISPATCH_PR_HEAD="$HEAD_SHA" \
    DISPATCH_PR_SOURCE=example/dc run_dispatch dispatch-pr-comment 40 feature/issue-40 0
chk "PR · pending/review 派工：退出 0" "$RC" 0
chk "PR · pending/review 换成 doing/agent" "$(labels_of 40)" "doing/agent"
chk "PR · 任务送出去了" "$(delivered)" 1
chk "PR · 认领在送任务之前" "$([ "$(at "^gh api -X DELETE $R/issues/40/labels/pending%2Freview")" -lt "$(at '^tmux paste-buffer')" ] && echo yes)" yes
fresh; mkissue 15 "pending/agent,pending/blocked"; live 15
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label run_dispatch dispatch-issue-comment 15 0
chk "等前置标签 + 派工标签：退出 0" "$RC" 0
chk "等前置标签一并摘掉" "$(labels_of 15)" "doing/agent"
fresh; mkissue 16 "autopilot"; live 16
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=autopilot run_dispatch dispatch-issue-comment 16 0
chk "只挂托管标签的（当作派工标签派）：托管关着时认领前就撤回 → 78" "$RC" 78
fresh 'LABEL_AUTOPILOT="autopilot"'; mkissue 16 "autopilot"; live 16
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=autopilot run_dispatch dispatch-issue-comment 16 0
chk "只挂托管标签的：照常认领、交任务（退出 0）" "$RC" 0
chk "只挂托管标签的：托管标签留着、加上 doing/agent" "$(labels_of 16)" "autopilot,doing/agent"
fresh; mkissue 17 ""; live 17
DISPATCH_CLAIM_SOURCE=free run_dispatch dispatch-issue-comment 17 0
chk "greedy 兜底派的（没有标签）：退出 0" "$RC" 0
chk "greedy 兜底派的：加上 doing/agent" "$(labels_of 17)" "doing/agent"

echo "── ④ 认领前：人已撤回 / 关闭 / PR 变了 → 78；读不到 → 77。都什么都不写 ──"
pre_case() {   # <说明> <期望退出码> <脚本> <参数…>（条目已经造好）
    local what="$1" want="$2"; shift 2
    run_dispatch "$@"
    chk "$what：退出 $want" "$RC" "$want"
    chk "$what：没有标签写入" "$(label_writes)" 0
    chk "$what：没有送任务 / 起程序" "$(delivered)" 0
}
fresh; mkissue 21 "pending/agent" closed; live 21
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label pre_case "issue 已关闭" 78 dispatch-issue-comment 21 0
fresh; mkissue 22 ""; live 22
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label pre_case "人已摘掉派工标签" 78 dispatch-issue-comment 22 0
fresh; mkissue 23 "pending/human"; live 23
DISPATCH_CLAIM_SOURCE=free pre_case "greedy：人打上了挡工标签" 78 dispatch-issue-comment 23 0
fresh; mkpr 41 "pending/agent" true; live 41
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label DISPATCH_PR_BASE=main DISPATCH_PR_HEAD="$HEAD_SHA" \
    pre_case "PR 已合并" 78 dispatch-pr-comment 41 feature/issue-41 0
fresh; mkpr 42 "pending/agent"; live 42
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label DISPATCH_PR_BASE=main DISPATCH_PR_HEAD=2222222222222222222222222222222222222222 \
    pre_case "PR 有了新提交" 78 dispatch-pr-comment 42 feature/issue-42 0
fresh; mkpr 43 "pending/agent"; live 43
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label DISPATCH_PR_BASE=release DISPATCH_PR_HEAD="$HEAD_SHA" \
    pre_case "PR 换了目标分支" 78 dispatch-pr-comment 43 feature/issue-43 0
fresh; mkissue 24 "pending/agent"; live 24; touch "$GD/F_issues_24"
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label pre_case "认领前读不到条目" 77 dispatch-issue-comment 24 0
fresh; mkissue 25 "pending/agent"; live 25; echo 'del(.labels)' > "$GD/jq_issues_25"
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label pre_case "认领前读到的条目缺标签字段" 77 dispatch-issue-comment 25 0

echo "── ⑤ 认领只做成一部分 / 认领期间被人改了 ──"
fresh; mkissue 31 "pending/agent"; live 31
mkdir -p "$GD/F_post_label_doing"; touch "$GD/F_post_label_doing/agent"
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label run_dispatch dispatch-issue-comment 31 0
chk "加 doing/agent 失败：退出 1（确定失败）" "$RC" 1
chk "加 doing/agent 失败：条目原样" "$(labels_of 31)" "pending/agent"
chk "加 doing/agent 失败：没有摘标签" "$(grep -cE "^gh api -X DELETE $R/issues/31/labels" "$CALLS")" 0
chk "加 doing/agent 失败：没有送任务" "$(delivered)" 0

fresh; mkissue 32 "pending/agent"; live 32
touch "$GD/F_delete_labels"; printf 'rm -f "%s/F_delete_labels"\n' "$GD" > "$GD/hook_DELETE_issues_32_labels_2"
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label run_dispatch dispatch-issue-comment 32 0
chk "摘触发标签失败（只做成一半）：退出 1" "$RC" 1
chk "复原成认领前的样子" "$(labels_of 32)" "pending/agent"
chk "到达性 · 复原确实摘了 doing/agent" "$(grep -cE "^gh api -X DELETE $R/issues/32/labels/doing%2Fagent" "$CALLS")" 1
chk "只做成一半：没有送任务" "$(delivered)" 0

fresh; mkissue 33 "pending/agent"; live 33
touch "$GD/F_delete_labels"
# 摘触发标签（失败）之后、复原之前，人打上了 pending/human：读回是第 c+1 次读条目，复原前的核对是第 c+2 次
cat > "$GD/human_adds_33" <<EOF
jq '.["33"] += ["pending/human"]' "$GD/labels.json" > "$GD/l.tmp" && mv "$GD/l.tmp" "$GD/labels.json"
EOF
cat > "$GD/hook_DELETE_issues_33_labels_1" <<EOF
c=\$(cat "$GD/count_issues_33" 2>/dev/null || echo 0)
cp "$GD/human_adds_33" "$GD/hook_issues_33_\$((c + 2))"
EOF
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label run_dispatch dispatch-issue-comment 33 0
chk "只做成一半、复原前人打上了 pending/human：退出 78" "$RC" 78
chk "到达性 · 人的标签确实打上了" "$(labels_of 33 | grep -c 'pending/human')" 1
chk "不复原：doing/agent 没被 daemon 摘掉" "$(grep -cE "^gh api -X DELETE $R/issues/33/labels/doing%2Fagent" "$CALLS")" 0
chk "不复原：没往回加派工标签" "$(grep -cE "^gh api -X POST $R/issues/33/labels" "$CALLS")" 1

fresh; mkissue 34 "pending/agent"; live 34
# 认领期间人关了条目
printf 'jq ".[\\"34\\"].state = \\"closed\\"" "%s/items.json" > "%s/i.tmp" && mv "%s/i.tmp" "%s/items.json"\n' "$GD" "$GD" "$GD" "$GD" \
    > "$GD/hook_DELETE_issues_34_labels_1"
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label run_dispatch dispatch-issue-comment 34 0
chk "认领期间人关了条目：退出 78" "$RC" 78
chk "认领期间人关了条目：没有送任务" "$(delivered)" 0
chk "认领期间人关了条目：读回之后没再写标签" "$(label_writes)" 2

fresh; mkissue 35 "pending/agent"; live 35
printf "echo 'del(.labels)' > '%s/jq_issues_35'\n" "$GD" > "$GD/hook_DELETE_issues_35_labels_1"
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label run_dispatch dispatch-issue-comment 35 0
chk "认领后读不回：退出 77" "$RC" 77
chk "认领后读不回：没有送任务" "$(delivered)" 0
chk "认领后读不回：之后不再写" "$(label_writes)" 2

echo "── ⑥ 交任务开始后起程序报错 → 结果不明（77），不写标签 ──"
fresh; mkissue 51 "pending/agent"; touch "$TD/fail_new"
DISPATCH_PENDING_AGENT_LABEL=pending/agent DISPATCH_CLAIM_SOURCE=label run_dispatch dispatch-new-issue 51
chk "起程序报错：退出 77" "$RC" 77
chk "doing/agent 留着（交给自愈）" "$(labels_of 51)" "doing/agent"
chk "到达性 · 确实试过起程序" "$(grep -c '^tmux new-session' "$CALLS")" 1
chk "认领在起程序之前" "$([ "$(at "^gh api -X DELETE $R/issues/51/labels/pending%2Fagent")" -lt "$(at '^tmux new-session')" ] && echo yes)" yes
chk "起程序之后没有标签写入" "$(label_writes_after "$(at '^tmux new-session')")" 0

echo "── ⑦ 真实轮询主程序：失败次数到上限减一 ──"
poll() { (cd "$W/project" && env CODING_AGENT_CONFIG="$CONF" timeout 180 bash "$REPO_DIR/scripts/agent-poll.sh" >/dev/null 2>&1) || true; }
preset_fail() { mkdir -p "$W/state/dispatch-fail"; echo 2 > "$W/state/dispatch-fail/$1"; }
fails_of() { cat "$W/state/dispatch-fail/$1" 2>/dev/null || echo 0; }
comments_on() { jq -r --arg n "$1" '(.[$n] // []) | length' "$GD/comments.json"; }
poll_case() {   # <说明> <键> <编号> <期望标签>
    poll
    chk "$1：没有留言" "$(comments_on "$3")" 0
    chk "$1：失败次数不变" "$(fails_of "$2")" 2
    chk "$1：标签" "$(labels_of "$3")" "$4"
}
# 先确认预置的计数文件名和轮询主程序用的一致：确定失败（复原成功 → 1）照旧计数、满次转人工
fresh; mkissue 61 "pending/agent"; preset_fail issue-61
mkdir -p "$GD/F_post_label_doing"; touch "$GD/F_post_label_doing/agent"
poll
chk "确定失败（新 issue 入口）：照旧转人工" "$(labels_of 61)" "pending/human"
chk "确定失败：留了转人工说明" "$(comments_on 61)" 1
chk "到达性 · 这一轮确实派了它" "$(grep -c "^gh api -X POST $R/issues/61/labels -f labels\[\]=doing/agent" "$CALLS")" 1

fresh; mkissue 62 "pending/agent"; preset_fail issue-62; touch "$TD/fail_new"
poll_case "新 issue 入口 · 结果不明（起程序报错）" issue-62 62 "doing/agent"
chk "到达性 · 确实试过起程序" "$(grep -c '^tmux new-session' "$CALLS")" 1

fresh; mkissue 63 "pending/agent"; preset_fail issue-63
printf 'jq ".[\\"63\\"] += [\\"pending/human\\"]" "%s/labels.json" > "%s/l.tmp" && mv "%s/l.tmp" "%s/labels.json"\n' "$GD" "$GD" "$GD" "$GD" \
    > "$GD/hook_POST_issues_63_labels_1"
# daemon 自己摘掉 pending/agent 之后才读回发现：人加的标签和 doing/agent 都留着，daemon 不再替人改
poll_case "新 issue 入口 · 认领期间人改了标签（78）" issue-63 63 "doing/agent,pending/human"

fresh; mkissue 64 "pending/agent"; preset_fail issue-64; live 64; touch "$GD/F_issues_64"
poll_case "issue 新评论入口 · 认领前读不到（77）" issue-64 64 "pending/agent"
chk "到达性 · 这一轮确实把它派给了评论派工" "$(grep -c "issues/64/comments" "$CALLS" | awk '{print ($1 > 0)}')" 1

fresh; mkissue 65 "pending/agent"; preset_fail issue-65; live 65
printf 'jq ".[\\"65\\"].state = \\"closed\\"" "%s/items.json" > "%s/i.tmp" && mv "%s/i.tmp" "%s/items.json"\n' "$GD" "$GD" "$GD" "$GD" \
    > "$GD/hook_POST_issues_65_labels_1"
poll_case "issue 新评论入口 · 认领期间人关了条目（78）" issue-65 65 "doing/agent"

fresh; mkpr 44 "pending/agent"; preset_fail pr-44; live 44
echo '.head.sha = "3333333333333333333333333333333333333333"' > "$GD/jq_pulls_44"
poll_case "PR 入口 · PR 在派工前有了新提交（78）" pr-44 44 "pending/agent"

fresh; mkpr 45 "pending/agent"; preset_fail pr-45; live 45; touch "$GD/F_pulls_45"
poll_case "PR 入口 · 认领前读不到 PR（77）" pr-45 45 "pending/agent"

fresh; mkissue 66 "pending/agent"; preset_fail issue-66; live 66
poll
chk "已送出：失败次数清零" "$(fails_of issue-66)" 0
chk "已送出：标签是 doing/agent" "$(labels_of 66)" "doing/agent"

echo
echo "结果：$pass 通过 / $fail 失败"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
