#!/usr/bin/env bash
# kind: e2e
# 暂缓标签 —— GitHub#463。
#
# 跑法：bash tests/later-label.test.sh
# 依赖：bash、jq、python3、git。不碰网络：假 GitHub（tests/lib/fake_github.py，有状态）+ 假 tmux，
# HOME 指向临时目录。每一轮都**真的**起 agent-poll.sh 子进程。
#
# 守的是：
#   · 配了暂缓标签：greedy 兜底趟不收挂着它的 issue / PR，同一轮里没挂它的确实收了
#   · 托管的「只挂托管标签就派」也不收挂着它的 issue；同一轮里只挂托管标签的确实收了
#   · 只挡自动捞取：有人打了 pending/agent 照常进派工队列
#   · 配置里没写这一行、或写成空值：轮询的 GitHub 调用和改动前（merge-base）逐条相同，
#     挂着 pending/later 的条目照旧被 greedy 收（它在关着时只是个普通标签）
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/compat.sh
source "$TEST_DIR/lib/compat.sh"
# shellcheck source=lib/prompt-files.sh
source "$TEST_DIR/lib/prompt-files.sh"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TZ=UTC
unset CODING_AGENT_RELEASE_ROOT LABEL_PENDING_LATER LABEL_PENDING_BLOCKED LABEL_AUTOPILOT \
    DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR DISPATCH_MODE GREEDY_SKIP_LABELS
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

# 改动前的版本：merge-base 上的 scripts/，配本版的 prompts/
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$SANDBOX/old"
git -C "$REPO_DIR" archive "$BASE_REV" scripts | tar -x -C "$SANDBOX/old"
cp -r "$REPO_DIR/prompts" "$SANDBOX/old/prompts"
mkdir -p "$SANDBOX/new"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$SANDBOX/new/"
prompt_tree_isolate "$SANDBOX/old" "$SANDBOX/old-prompts" || { echo "❌ 改动前的派工脚本认不出提示词写在哪"; exit 1; }

T0=1790000000
export FAKE_GH_REPO="example/pl"
W="$SANDBOX/run"
fresh() {   # [额外配置行…]
    rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$W/gh"
    git init -q "$W/project" 2>/dev/null
    GD="$W/gh"; export FAKE_GH_DIR="$GD"; CALLS="$GD/calls.log"; STATE="$W/state/state.json"
    CONF="$W/cavil-loop.config"
    cat > "$CONF" <<CONF
REPO="example/pl"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="pltest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
POST_MERGE_RETROSPECTIVE=false
AUTO_CLEANUP_ON_MERGE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
POLL_IDLE_PROBE=false
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=0
DISPATCH_MODE="greedy"
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    local l; for l in "$@"; do printf '%s\n' "$l" >> "$CONF"; done
    EVN=0
    echo '{}' > "$GD/items.json"; echo '{}' > "$GD/labels.json"; echo '{}' > "$GD/events.json"
    echo '{}' > "$GD/comments.json"; echo '{}' > "$GD/perms.json"; echo '{}' > "$GD/blocked_by.json"
    echo loop-bot > "$GD/me"
}
on() { fresh 'LABEL_PENDING_LATER="pending/later"' 'LOG_LEVEL="debug"' "$@"; }
jset() { local f="$GD/$1" e="$2"; shift 2; jq "$@" "$e" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
mkissue() {   # <n> <labels_csv>
    jset items.json '.[$n] = {kind:"issue", state:"open", title:"t", body:"需求", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}' --arg n "$1"
    jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$2"
    local x; for x in ${2//,/ }; do ev "$1" labeled "$x" maint; done
}
mkpr() {   # <n> <labels_csv>
    jset items.json '.[$n] = {kind:"pr", state:"open", merged:false, draft:false, title:"t", body:"x", user:{login:"maint"},
            updated_at:"2026-01-01T00:00:00Z",
            head:{sha:"1111111111111111111111111111111111111111", ref:("topic-" + $n), repo:{full_name:"example/pl"}}, base:{ref:"main"}}' \
        --arg n "$1"
    jset labels.json '.[$n] = ($l | split(",") | map(select(. != "")))' --arg n "$1" --arg l "$2"
    local x; for x in ${2//,/ }; do ev "$1" labeled "$x" maint; done
}
ev() {   # <n> <labeled|unlabeled> <标签> [操作人]
    EVN=$((EVN + 1))
    jset events.json '.[$n] = ((.[$n] // []) + [{id:($i|tonumber), event:$e, label:{name:$l}, actor:{login:$a, type:"User"}, created_at:$c}])' \
        --arg n "$1" --arg e "$2" --arg l "$3" --arg a "${4:-loop-bot}" --arg i "$EVN" \
        --arg c "$(printf '2026-01-01T%02d:%02d:00Z' $((EVN / 60)) $((EVN % 60)))"
}
tick() {   # [<root>]
    : > "$CALLS"
    env POLL_FAKE_NOW="$T0" CODING_AGENT_CONFIG="$CONF" bash "${1:-$SANDBOX/new}/scripts/agent-poll.sh" >/dev/null 2>&1
}
# 最后一行「派工队列」里有没有这一条（日志里写 issue#N( / PR#N(）
queued() {
    local k="$1"; [ "$k" = pr ] && k=PR
    grep -E '派工队列' "$W/state/poll.log" 2>/dev/null | tail -1 | grep -c "$k#$2(" || true
}
skipped_for() { grep -E 'greedy' "$W/state/poll.log" 2>/dev/null | grep -c "$1#$2(pending/later)" || true; }

echo "── 1. 配了暂缓标签：greedy 兜底趟跳过它，同一轮里别的条目照常收 ──"
on
mkissue 10 "pending/later"; mkissue 11 "bug,pending/later"; mkissue 40 ""
mkpr 50 "pending/later"; mkpr 51 ""
tick
chk "只挂暂缓标签的 issue 不进派工队列" "$(queued issue 10)" 0
chk "暂缓标签混在别的标签里也认得出" "$(queued issue 11)" 0
chk "挂暂缓标签的 PR 不进派工队列" "$(queued pr 50)" 0
chk "日志写明是被暂缓标签挡住的" "$(skipped_for issue 10)" 1
chk "到达性 · 同一轮没挂它的 issue 确实收了" "$(queued issue 40)" 1
chk "到达性 · 同一轮没挂它的 PR 确实收了" "$(queued pr 51)" 1
chk "暂缓标签原样不动" "$(jq -c '.["10"]' "$GD/labels.json")" '["pending/later"]'

echo "── 2. 只挡自动捞取：打了 pending/agent 照常派 ──"
on
mkissue 10 "pending/agent,pending/later"; mkissue 12 "pending/later"
tick
chk "打了 pending/agent 的暂缓条目进派工队列" "$(queued issue 10)" 1
chk "对照 · 只挂暂缓标签的仍不进" "$(queued issue 12)" 0

echo "── 3. 托管：只挂托管标签就派的那一趟也不收挂暂缓标签的 issue ──"
on 'DISPATCH_MODE="label"' 'LABEL_PENDING_REVIEW="pending/review"' 'LABEL_AUTOPILOT="autopilot"'
echo '{"maint":"admin"}' > "$GD/perms.json"
mkissue 10 "autopilot,pending/later"; mkissue 41 "autopilot"
tick
chk "挂暂缓标签的托管 issue 不当作派工" "$(queued issue 10)" 0
chk "到达性 · 只挂托管标签的 issue 确实收了" "$(queued issue 41)" 1

echo "── 4. 配置里没写 / 写成空值：GitHub 调用与改动前逐条相同 ──"
for mode in missing empty; do
    sides="old new"; csame=0
    if compat_skip "暂缓标签关着（$mode）：轮询的 GitHub 调用与改动前" "$SANDBOX/old" "$SANDBOX/new" scripts prompts; then
        sides="new"; csame=1
    fi
    for side in $sides; do
        if [ "$mode" = empty ]; then fresh 'LABEL_PENDING_LATER=""'; else fresh; fi
        mkissue 10 "pending/later"; mkissue 40 ""; mkpr 50 "pending/later"
        tick "$SANDBOX/$side"
        cp "$CALLS" "$SANDBOX/off-$mode-$side.calls"
        jq -S . "$STATE" > "$SANDBOX/off-$mode-$side.state"
        printf '%s %s %s\n' "$(queued issue 10)" "$(queued issue 40)" "$(queued pr 50)" > "$SANDBOX/off-$mode-$side.q"
    done
    if [ "$csame" = 0 ]; then
        chk "$mode：GitHub 调用逐条相同" "$(cmp -s "$SANDBOX/off-$mode-old.calls" "$SANDBOX/off-$mode-new.calls" && echo same || echo diff)" same
        chk "$mode：state.json 逐字节相同" "$(cmp -s "$SANDBOX/off-$mode-old.state" "$SANDBOX/off-$mode-new.state" && echo same || echo diff)" same
        chk "$mode：派工队列与改动前相同" "$(cat "$SANDBOX/off-$mode-new.q")" "$(cat "$SANDBOX/off-$mode-old.q")"
    fi
    chk "$mode：关着时 pending/later 只是普通标签，照旧被 greedy 收" "$(cat "$SANDBOX/off-$mode-new.q")" "1 1 1"
    chk "到达性 · $mode：这一轮确实读了 open 列表" "$([ "$(grep -c 'state=open' "$SANDBOX/off-$mode-new.calls")" -gt 0 ] && echo yes || echo no)" yes
done

echo
echo "结果：$pass 通过 / $fail 失败"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
