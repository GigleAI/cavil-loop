#!/usr/bin/env bash
# kind: e2e
# 关掉往返记录后，停在半路的条目怎么重派（GitHub#646，PR #652 维护者选 Q1 = A）。
#
# 跑法：bash tests/round-log-redispatch.test.sh
# 依赖：bash、jq、python3、git、awk。不碰网络：假 GitHub（tests/lib/fake_github.py，有状态）+ 假 tmux，
# HOME 指向临时目录。
#
# 守的是 docs/operations{,.zh}.md「关掉」折叠块里的重派步骤，整条走一遍：
#   1. 查被打断的是哪次派工：文档里 round-log-redispatch-ops 那段命令按字面在只带 HOME / PATH / LANG
#      的环境里跑（只把示例编号 123 和示例账号换成真的，人照做时也是这样），中英两份一字不差。
#      只认仍然有效的 daemon 派工：loop 账号挂的 doing/agent、紧挨着之前 loop 账号摘掉恰好一个派工标签、
#      之后流程标签没再变过、没挂 pending/human、前后两次读的标签相同（PR #652 复审第 2 轮）。
#      看的是标签历史里 daemon 最后一次挂 doing/agent 前摘掉的那个标签——不是最后一条评论：
#      只有 PR 正文、没有 worker 评论的首轮复审也要回到 pending/review。
#   2. 照文档在页面上做的那一步（摘 doing/agent、挂 RESTORE 给出的标签），这里用同一个假 GitHub 的写接口做。
#   3. 真的起一轮 agent-poll.sh：复审回到复审那一趟（DISPATCH_PROMPT_KIND=review），worker 回到 worker 那一趟。
#      派工脚本换成只记录调用的替身——这里要看的是 poller 把条目交给谁，不是派工脚本本身。
# 看不出来的情况（读不到、历史里没有派工、摘掉的标签对不上）一律是 UNKNOWN、退出非 0，不给出标签。
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
unset CODING_AGENT_RELEASE_ROOT LABEL_PENDING_LATER LABEL_PENDING_BLOCKED LABEL_AUTOPILOT GREEDY_SKIP_LABELS ENABLE_ROUND_LOG
# 在派工会话里跑时会继承派工变量（如 DISPATCH_PROMPT_KIND=review）：全部清掉
for __v in $(compgen -v DISPATCH_); do unset "$__v"; done; unset __v
unset GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN POLL_FAKE_NOW

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; ls|list-sessions) exit 1 ;; esac
exit 0
SH
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/tmux"

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

doc_block() {   # <文档> <块名>
    awk -v b="<!-- $2:begin -->" -v e="<!-- $2:end -->" '$0==b{f=1;next} $0==e{f=0} f' "$REPO_DIR/docs/$1" \
        | awk '/^```bash$/{f=1;next} /^```$/{f=0} f'
}

# 派工脚本换成替身：只记下 poller 交给了哪个脚本、哪个编号、哪一种派工
mkdir -p "$SANDBOX/new"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$SANDBOX/new/"
for s in dispatch-new-issue dispatch-issue-comment dispatch-pr-comment; do
    cat > "$SANDBOX/new/scripts/$s.sh" <<SH
#!/usr/bin/env bash
printf '%s %s kind=%s\n' "$s" "\$1" "\${DISPATCH_PROMPT_KIND:-}" >> "\$DISPATCH_LOG"
exit 0
SH
done

T0=1790000000
export FAKE_GH_REPO="owner/repo"
W="$SANDBOX/run"
GD="$W/gh"; export FAKE_GH_DIR="$GD"
CONF="$W/cavil-loop.config"
export DISPATCH_LOG="$W/dispatch.log"
rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$GD"
git init -q "$W/project" 2>/dev/null
cat > "$CONF" <<CONF
REPO="owner/repo"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="rdtest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
POST_MERGE_RETROSPECTIVE=false
AUTO_CLEANUP_ON_MERGE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
POLL_IDLE_PROBE=false
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=5
DISPATCH_MODE="label"
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
LABEL_PENDING_BLOCKED=""
CONF
chmod 600 "$CONF"
EVN=0
echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/events.json"
echo '{}' > "$GD/comments.json"; echo '{}' > "$GD/perms.json"; echo '{}' > "$GD/blocked_by.json"
echo loop-bot > "$GD/me"

jset() { local f="$GD/$1" e="$2"; shift 2; jq "$@" "$e" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
ev() {   # <n> <labeled|unlabeled> <标签> [操作人]
    EVN=$((EVN + 1))
    jset events.json '.[$n] = ((.[$n] // []) + [{id:($i|tonumber), event:$e, label:{name:$l}, actor:{login:$a, type:"User"}, created_at:$c}])' \
        --arg n "$1" --arg e "$2" --arg l "$3" --arg a "${4:-loop-bot}" --arg i "$EVN" \
        --arg c "$(printf '2026-01-01T%02d:%02d:00Z' $((EVN / 60)) $((EVN % 60)))"
}
labels() { jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$2"; }
mkissue() {   # <n>
    jset items.json '.[$n] = {kind:"issue", state:"open", title:"t", body:"需求", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}' --arg n "$1"
}
mkpr() {   # <n>
    jset items.json '.[$n] = {kind:"pr", state:"open", merged:false, draft:false, title:"t", body:"交付说明只在正文里\n\nCloses #1", user:{login:"loop-bot"},
            updated_at:"2026-01-01T00:00:00Z",
            head:{sha:"1111111111111111111111111111111111111111", ref:("feature/issue-" + $n), repo:{full_name:"owner/repo"}}, base:{ref:"main"}}' \
        --arg n "$1"
}
# daemon 派工的标签写法（flip_to_doing → gh_label_flip）：先摘派工标签，再挂 doing/agent，都是写账号
dispatch_flip() {   # <n> <派工标签>
    ev "$1" unlabeled "$2"; ev "$1" labeled doing/agent
}

echo "── 0. 文档里的命令：中英一字不差 ──"
chk "round-log-redispatch-ops：中英两份文档里的命令一字不差" \
    "$(doc_block operations.zh.md round-log-redispatch-ops)" "$(doc_block operations.md round-log-redispatch-ops)"
doc_block operations.md round-log-redispatch-ops > "$SANDBOX/block.sh"
chk "命令块里的示例编号只出现一次（照做时只换它）" "$(grep -c 'N=123' "$SANDBOX/block.sh")" 1
chk "命令块里的 loop 账号示例只出现一次（照做时换成真的账号）" "$(grep -c 'LOOP=loop-account' "$SANDBOX/block.sh")" 1
# 读标签历史那一下顺手改条目标签的替身：测「读的过程中标签变了」（只对写了 shim_hook_<n> 的条目生效）
mkdir -p "$SANDBOX/shim"
cat > "$SANDBOX/shim/gh" <<SH
#!/usr/bin/env bash
for a in "\$@"; do
    case "\$a" in repos/owner/repo/issues/*/events*) n="\${a#repos/owner/repo/issues/}"; n="\${n%%/*}"
        [ -f "\$FAKE_GH_DIR/shim_hook_\$n" ] && bash "\$FAKE_GH_DIR/shim_hook_\$n" ;;
    esac
done
exec "$SANDBOX/bin/gh" "\$@"
SH
chmod +x "$SANDBOX/shim/gh"
SYS_PATH="$(dirname "$(command -v awk)"):$(dirname "$(command -v grep)"):/usr/bin:/bin"
run_block() {   # <编号>
    sed -e "s/N=123/N=$1/" -e "s/LOOP=loop-account/LOOP=loop-bot/" "$SANDBOX/block.sh" > "$SANDBOX/block-$1.sh"
    RC=0; OUT="$(env -i HOME="$HOME" PATH="$SANDBOX/shim:$SANDBOX/bin:$SYS_PATH" LANG=C.UTF-8 FAKE_GH_DIR="$GD" FAKE_GH_REPO=owner/repo \
        bash "$SANDBOX/block-$1.sh" 2>&1)" || RC=$?
    LAST="$(printf '%s\n' "$OUT" | tail -1)"
}

echo "── 1. 查出被打断的是哪次派工 ──"
# PR 8：首轮复审。worker 把交付只写在 PR 正文里，没有任何 worker 评论；daemon 摘 pending/review、挂 doing/agent 派了复审
mkpr 8; ev 8 labeled pending/review; dispatch_flip 8 pending/review; labels 8 "doing/agent"
run_block 8
chk "只有 PR 正文的首轮复审：RESTORE pending/review、退出 0" "$LAST $RC" "RESTORE: pending/review 0"
# issue 5：worker。维护者挂 pending/agent，daemon 摘掉它派了 worker
mkissue 5; ev 5 labeled pending/agent maint; dispatch_flip 5 pending/agent; labels 5 "doing/agent,bug"
run_block 5
chk "worker：RESTORE pending/agent" "$LAST $RC" "RESTORE: pending/agent 0"
# PR 9：先派过一次复审，复审打回后又派了 worker —— 看的是最后一次派工
mkpr 9; ev 9 labeled pending/review; dispatch_flip 9 pending/review; ev 9 labeled pending/agent; ev 9 unlabeled doing/agent
dispatch_flip 9 pending/agent; labels 9 "doing/agent"
run_block 9
chk "派过多次：按最后一次派工 RESTORE pending/agent" "$LAST $RC" "RESTORE: pending/agent 0"
# issue 6：多人协作的后缀标签
mkissue 6; ev 6 labeled pending/agent/alice maint; dispatch_flip 6 pending/agent/alice; labels 6 "doing/agent"
run_block 6
chk "带后缀的派工标签原样给出" "$LAST $RC" "RESTORE: pending/agent/alice 0"
# issue 7：已经不挂 doing/agent
mkissue 7; ev 7 labeled pending/agent maint; dispatch_flip 7 pending/agent; ev 7 unlabeled doing/agent; ev 7 labeled pending/human; labels 7 "pending/human"
run_block 7
chk "不挂 doing/agent：NOT_STUCK、退出非 0" "$LAST $([ "$RC" != 0 ] && echo nz)" "NOT_STUCK: the item does not carry doing/agent nz"
# issue 4：doing/agent 是人手挂的，前面没有被摘掉的派工标签
mkissue 4; ev 4 labeled doing/agent maint; labels 4 "doing/agent"
run_block 4
chk "doing/agent 是人手挂的：UNKNOWN、不给标签" "$LAST $([ "$RC" != 0 ] && echo nz)" "UNKNOWN: doing/agent was not added by loop-bot nz"
# PR 11：维护者亲手摘 pending/review、再挂 doing/agent（同一个账号先摘后挂，但不是 loop 账号）
mkpr 11; ev 11 labeled pending/review; ev 11 unlabeled pending/review maint; ev 11 labeled doing/agent maint; labels 11 "doing/agent"
run_block 11
chk "维护者自己先摘后挂：UNKNOWN（不是 daemon 派工）" "$LAST $([ "$RC" != 0 ] && echo nz)" "UNKNOWN: doing/agent was not added by loop-bot nz"
# PR 12：两条标签事件都没有账号字段
mkpr 12; ev 12 labeled pending/review; labels 12 "doing/agent"
jset events.json '.["12"] += [{event:"unlabeled", label:{name:"pending/review"}, actor:null}, {event:"labeled", label:{name:"doing/agent"}, actor:null}]'
run_block 12
chk "事件没有账号字段：UNKNOWN" "$LAST $([ "$RC" != 0 ] && echo nz)" "UNKNOWN: doing/agent was not added by loop-bot nz"
# PR 13：现状还挂 doing/agent，历史里 daemon 已摘掉它、挂了 pending/human（交人）
mkpr 13; ev 13 labeled pending/review; dispatch_flip 13 pending/review; ev 13 labeled pending/human; ev 13 unlabeled doing/agent
labels 13 "doing/agent"
run_block 13
chk "历史里 doing/agent 已被摘掉：UNKNOWN（保留交人）" "$LAST $([ "$RC" != 0 ] && echo nz)" "UNKNOWN: the label history does not end with doing/agent added nz"
# PR 14：同时挂着 pending/human
mkpr 14; ev 14 labeled pending/review; dispatch_flip 14 pending/review; ev 14 labeled pending/human; labels 14 "doing/agent,pending/human"
run_block 14
chk "同时挂着 pending/human：UNKNOWN" "$LAST $([ "$RC" != 0 ] && echo nz)" "UNKNOWN: the item is on pending/human too nz"
# PR 15：派工之后有人又挂了一个派工标签
mkpr 15; ev 15 labeled pending/review; dispatch_flip 15 pending/review; ev 15 labeled pending/agent maint; ev 15 unlabeled pending/agent maint
labels 15 "doing/agent"
run_block 15
chk "派工之后流程标签又变过：UNKNOWN" "$LAST $([ "$RC" != 0 ] && echo nz)" "UNKNOWN: labels changed after the dispatch nz"
# PR 16：第一次读到 doing/agent，读历史的同时 daemon 摘掉它、挂上 pending/human
mkpr 16; ev 16 labeled pending/review; dispatch_flip 16 pending/review; labels 16 "doing/agent"
printf '%s\n' "cd '$GD' && jq '.[\"16\"] = [\"pending/human\"]' labels.json > l.tmp && mv l.tmp labels.json" > "$GD/shim_hook_16"
run_block 16; rm -f "$GD/shim_hook_16"
chk "读的过程中交了人：UNKNOWN" "$LAST $([ "$RC" != 0 ] && echo nz)" "UNKNOWN: the labels changed while reading nz"
chk "到达性 · 替身确实改了标签" "$(jq -c '.["16"]' "$GD/labels.json")" '["pending/human"]'
# issue 3：标签历史里根本没有挂 doing/agent 的记录（历史和现状对不上）
mkissue 3; labels 3 "doing/agent"
run_block 3
chk "历史里没有派工：UNKNOWN" "$LAST $([ "$RC" != 0 ] && echo nz)" "UNKNOWN: the label history does not end with doing/agent added nz"
# issue 2：同一次派工摘掉了两个派工标签，分不清
mkissue 2; ev 2 labeled pending/agent maint; ev 2 labeled pending/review maint
ev 2 unlabeled pending/review; ev 2 unlabeled pending/agent; ev 2 labeled doing/agent; labels 2 "doing/agent"
run_block 2
chk "摘掉的派工标签不止一个：UNKNOWN" "$LAST $([ "$RC" != 0 ] && echo nz)" "UNKNOWN: cannot tell which label dispatched it nz"
# 读不到
: > "$GD/F_issues_5_events"; run_block 5; rm -f "$GD/F_issues_5_events"
chk "标签历史读不到：UNKNOWN（不给标签）" "$LAST $([ "$RC" != 0 ] && echo nz)" "UNKNOWN: could not read the label history nz"
: > "$GD/F_issues_5"; run_block 5; rm -f "$GD/F_issues_5"
chk "条目读不到：UNKNOWN" "$LAST $([ "$RC" != 0 ] && echo nz)" "UNKNOWN: could not read the item nz"

echo "── 2. 照做：摘 doing/agent、挂回 RESTORE 的标签，真跑一轮 poller ──"
# 别的条目都放回不会被派工的样子，只留 PR 8 和 issue 5 这两条
for n in 9 6 4 3 2 11 12 13 14 15 16; do labels "$n" "pending/human"; done
for n in 8 5; do
    run_block "$n"; restore="${LAST#RESTORE: }"
    env PATH="$SANDBOX/bin:$PATH" gh api -X DELETE "repos/owner/repo/issues/$n/labels/doing%2Fagent" >/dev/null 2>&1
    env PATH="$SANDBOX/bin:$PATH" gh api -X POST "repos/owner/repo/issues/$n/labels" -f "labels[]=$restore" >/dev/null 2>&1
done
chk "PR 8 挂回 pending/review、不再挂 doing/agent" "$(jq -c '.["8"]' "$GD/labels.json")" '["pending/review"]'
chk "issue 5 挂回 pending/agent、原有的别的标签不动" "$(jq -c '.["5"] | sort' "$GD/labels.json")" '["bug","pending/agent"]'
: > "$DISPATCH_LOG"
env POLL_FAKE_NOW="$T0" CODING_AGENT_CONFIG="$CONF" bash "$SANDBOX/new/scripts/agent-poll.sh" >/dev/null 2>&1
chk "PR 8 回到复审那一趟" "$(grep -c '^dispatch-pr-comment 8 kind=review$' "$DISPATCH_LOG")" 1
chk "issue 5 回到 worker 那一趟（不是复审）" \
    "$(grep -E '^dispatch-(new-issue|issue-comment) 5 ' "$DISPATCH_LOG" | grep -vc 'kind=review$')" 1
chk "这一轮只派了这两条" "$(grep -c . "$DISPATCH_LOG")" 2
[ "$fail" = 0 ] || sed 's/^/     | /' "$DISPATCH_LOG"

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" = 0 ]
