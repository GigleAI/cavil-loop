#!/usr/bin/env bash
# kind: smoke
# Shell 冒烟测试：daemon 的主路径能走通 —— GitHub#212（#207 子项 ②）。
#
# 跑法：bash tests/smoke.test.sh              （约 10 秒；默认不跑末尾的负对照）
#       MUTATION=1 bash tests/smoke.test.sh   （连负对照一起跑，见 tests/lib/mutation.sh）
#       bash tests/run.sh --quick             （冒烟 + 单元 + 守卫 + 测试框架自测，交付前先跑这一组）
# 依赖：bash、jq、python3、git。不碰网络：常驻假 GitHub（tests/lib/fake_github.py，FAKE_GH_LISTS=1）
# + 假 tmux / 假 claude，HOME 指向临时目录；轮询、派工、建 worktree 都是真脚本、真 git。
#
# 只确认三条主路径能走通，和现有端到端测试有意重叠，不替代它们：
#   ① 新 issue 挂 pending/agent → 一轮轮询后被派工：翻成 doing/agent、起了 worker 会话、建了 worktree
#   ② PR 上有新评论、挂 pending/agent → 派工：翻成 doing/agent、起了 worker 会话
#   ③ PR 合并 → 打上 Done
# 每条都同时断言「这件事发生了」（标签、会话、worktree、调用记录），不只断言「没出错」。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"

SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TZ=UTC
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT LABEL_PENDING_BLOCKED GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN POLL_FAKE_NOW
unset DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR
export FAKE_GH_LISTS=1 FAKE_GH_REPO="example/sm"

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
# 假 tmux：new-session 记一行并「成功」，之后 has-session 认得这个会话；别的命令一律成功
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
log="${FAKE_TMUX_LOG:?}"
case "$1" in
    new-session)
        name=""; prev=""
        for a in "$@"; do [ "$prev" = -s ] && name="$a"; prev="$a"; done
        echo "new-session $name" >> "$log"; echo "$name" >> "$log.live"; exit 0 ;;
    has-session)
        t=""; prev=""
        for a in "$@"; do [ "$prev" = -t ] && t="${a#=}"; prev="$a"; done
        grep -qxF -- "$t" "$log.live" 2>/dev/null; exit $? ;;
    ls|list-sessions) [ -s "$log.live" ] && cat "$log.live"; exit 0 ;;
esac
exit 0
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$SANDBOX/bin/claude"
chmod +x "$SANDBOX/bin/gh" "$SANDBOX/bin/tmux" "$SANDBOX/bin/claude"

pass=0; fail=0; QUIET=0
chk() {
    if [ "$2" = "$3" ]; then
        [ "$QUIET" = 1 ] || echo "  ✅ $1"; pass=$((pass+1))
    else
        [ "$QUIET" = 1 ] || echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1))
    fi
}
section() { [ "$QUIET" = 1 ] || echo "$1"; }

# 一个真的 origin（裸库）：派工要从它建 worktree 和分支
git init -q --bare -b main "$SANDBOX/origin.git"
git clone -q "$SANDBOX/origin.git" "$SANDBOX/seed" 2>/dev/null
# 编号取得很大，避开本机真实派工的编号
N_ISSUE=986101; N_PR=986102; N_MERGED=986103
# main 一个提交；PR 的提交放在 GitHub 那样的 refs/pull/<n>/head 上（PR 派工从那里取）
(cd "$SANDBOX/seed" && git -c user.email=t@x -c user.name=t commit -q --allow-empty -m init && git push -q origin HEAD:main \
    && git -c user.email=t@x -c user.name=t commit -q --allow-empty -m "pr work" && git push -q origin "HEAD:refs/pull/$N_PR/head") >/dev/null 2>&1

run_smoke() {   # <被测的根目录（含 scripts/ prompts/）>
    local ROOT="$1" W="$SANDBOX/run"
    local R="repos/example/sm"
    local GD="$W/gh" CONF="$W/cavil-loop.config" CALLS="$W/gh/calls.log"
    rm -rf "$W"; mkdir -p "$W/state" "$W/wt" "$GD"
    git clone -q "$SANDBOX/origin.git" "$W/project" 2>/dev/null
    export FAKE_GH_DIR="$GD" FAKE_TMUX_LOG="$W/tmux.log"
    cat > "$CONF" <<CONF
REPO="example/sm"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="smtest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
LABEL_DONE="Done"
POST_MERGE_RETROSPECTIVE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
MAX_CONCURRENT_WORKERS=3
# 信任框检查默认盯 4 秒；假 tmux 上不会出现，1 秒足够走到这一步（主路径照常经过它）
AGENT_TRUST_PROMPT_WAIT_SECS=1
WORKER_SECRET_ENV=""
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    chmod 600 "$CONF"
    echo '{}' > "$GD/events.json"; echo '{}' > "$GD/perms.json"; echo loop-bot > "$GD/me"
    jq -n --arg i "$N_ISSUE" --arg p "$N_PR" --arg m "$N_MERGED" '{
        ($i): {kind:"issue", state:"open", title:"新需求", body:"做一件事", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"},
        ($p): {kind:"pr", state:"open", merged:false, draft:false, title:"实现", body:"x", user:{login:"loop-bot"},
               updated_at:"2026-01-01T00:00:00Z",
               head:{sha:"1111111111111111111111111111111111111111", ref:("feature/issue-" + $p), repo:{full_name:"example/sm"}}, base:{ref:"main"}},
        ($m): {kind:"pr", state:"closed", merged:true, title:"已合并", body:"x", user:{login:"loop-bot"},
               updated_at:"2026-01-01T00:00:00Z",
               head:{sha:"2222222222222222222222222222222222222222", ref:"chore/merged", repo:{full_name:"example/sm"}}, base:{ref:"main"}}
    }' > "$GD/items.json"
    jq -n --arg i "$N_ISSUE" --arg p "$N_PR" --arg m "$N_MERGED" \
        '{($i): ["pending/agent"], ($p): ["pending/agent"], ($m): ["pending/human"]}' > "$GD/labels.json"
    jq -n --arg p "$N_PR" '{($p): [{id: 5001, body:"请把 X 改成 Y", user:{login:"maint"}, author_association:"COLLABORATOR",
        created_at:"2026-01-02T00:00:00Z"}]}' > "$GD/comments.json"
    # 已装好的项目：「已清理」记录早就存在，所以这一轮新出现的合并 PR 会被处理
    echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$W/state/state.json"

    labels_of() { jq -r --arg n "$1" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
    session_of() { grep -c "^new-session smtest-issue$1\$" "$W/tmux.log" 2>/dev/null || true; }

    env CODING_AGENT_CONFIG="$CONF" timeout 120 bash "$ROOT/scripts/agent-poll.sh" >/dev/null 2>&1

    section "① 新 issue 派工"
    chk "issue 翻成 doing/agent" "$(labels_of "$N_ISSUE")" "doing/agent"
    chk "起了这个 issue 的 worker 会话" "$(session_of "$N_ISSUE")" "1"
    chk "建了 worktree，在 feature 分支上" \
        "$(git -C "$W/wt/issue-$N_ISSUE" rev-parse --abbrev-ref HEAD 2>/dev/null)" "feature/issue-$N_ISSUE"

    section "② PR 评论派工"
    chk "PR 翻成 doing/agent" "$(labels_of "$N_PR")" "doing/agent"
    chk "起了这个 PR 的 worker 会话" "$(session_of "$N_PR")" "1"

    section "③ PR 合并后打 Done"
    chk "合并的 PR 打上 Done、摘掉 pending/human" "$(labels_of "$N_MERGED")" "Done"
    chk "记为已清理" "$(jq -r --argjson n "$N_MERGED" '(.cleaned_prs // []) | index($n) != null' "$W/state/state.json" 2>/dev/null)" "true"
    chk "到达性 · 这一轮确实列了已合并 PR" "$(grep -c '^gh pr list .*--state merged' "$CALLS" 2>/dev/null || true)" "1"

}

T0=$(date +%s)
echo "【主路径】真实 agent-poll.sh 一轮"
NEW="$SANDBOX/new"; mkdir -p "$NEW"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$NEW/"
run_smoke "$NEW"
chk "60 秒内跑完（实测 $(( $(date +%s) - T0 )) 秒）" "$([ $(( $(date +%s) - T0 )) -le 60 ] && echo yes || echo no)" "yes"

# ── 负对照：把派工主路径改坏（新 issue 派工不翻 doing/agent），冒烟必须变红 ──
# 改坏的副本只在开关打开时准备；上面的正例就是它的对照。
echo "【负对照】"
mutant_flip() {   # 新 issue 派工脚本里翻 doing/agent 的那一步换成空操作
    local D="$SANDBOX/mut-flip"
    rm -rf "$D"; cp -r "$NEW" "$D"
    python3 - "$D/scripts/dispatch-new-issue.sh" <<'PY' || return 1
import sys
p = sys.argv[1]; s = open(p).read()
old = 'flip_to_doing "$ISSUE" "issue #$ISSUE pending/agent → doing/agent" || true'
if s.count(old) != 1:
    sys.exit("mutation target found %d times" % s.count(old))
open(p, "w").write(s.replace(old, ':'))
PY
    printf '%s' "$D"
}
# 正例的计数在这里存下：负对照在改坏的副本上重跑同一组断言，那些结果不算回归（tests/lib/report.sh）
REAL_PASS=$pass; REAL_FAIL=$fail; mut_ran=0; mut_fail=0
if mutation_gate; then
    mut_ran=$((mut_ran + 1))
    if D=$(mutant_flip); then
        pass=0; fail=0; QUIET=1; run_smoke "$D"; QUIET=0
        if [ "$fail" -gt 0 ]; then
            echo "  ✅ 负对照拦下：新 issue 派工不翻 doing/agent（$fail 条变红）"
        else
            echo "  ❌ 负对照没拦下：新 issue 派工不翻 doing/agent（改坏后冒烟仍全绿）"; mut_fail=$((mut_fail + 1))
        fi
    else
        echo "  ❌ 负对照准备失败：找不到新 issue 派工里翻 doing/agent 的那一行"; mut_fail=$((mut_fail + 1))
    fi
fi
pass=$REAL_PASS; fail=$REAL_FAIL

echo
mutation_summary "$0"
echo "正式版：$pass 通过 / $fail 失败；负对照失效 $mut_fail 条（本次跑了 $mut_ran 条）"
REPORT_REGRESS_ONLY=1 report_counts "$pass" "$fail" "$mut_ran" "$mut_fail"
[ "$fail" -eq 0 ] && [ "$mut_fail" -eq 0 ]
