#!/usr/bin/env bash
# kind: e2e
# 「项目配置」弹窗改的值真的被轮询用到；配置里不写时轮询实际用的值 = 登记表里写的（GitHub#388）。
#
# scripts/config-fields.txt 给每项登记了「不写这一行时 daemon 实际用的值」。有的默认值在 _lib.sh 加载时
# 就定了（tests/project-config.test.sh 对拍），有的是 agent-poll.sh 在用到的地方才补（${X:-默认}）——
# 这一类只有跑真实轮询才对得上。这里跑**真实** agent-poll.sh（常驻假 GitHub + 假 tmux / 假 claude，真 git）：
#   1. 配置里一项都不写：同时只派 1 条、派工失败记「第 1/3 次」、自愈记「第 1/3 次」、合并的 PR 被清理
#   2. 用真实 project-config.sh set 把这四项写进同一份配置，再跑：派 2 条、「1/5」、「1/4」、不清理
#
#   bash tests/project-config-poll.test.sh      （约 1 分钟）
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
SANDBOX=$(mktemp -d)
trap '[ -n "${KEEP_SANDBOX:-}" ] && echo "SANDBOX=$SANDBOX" || rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home/.config/cavil-loop"
export HOME="$SANDBOX/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TZ=UTC
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT LABEL_PENDING_BLOCKED GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN POLL_FAKE_NOW
unset DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR CAVIL_SCHEDULED_POLL
unset MAX_CONCURRENT_WORKERS DISPATCH_MAX_RETRIES SELFHEAL_MAX_RETRIES AUTO_CLEANUP_ON_MERGE
export FAKE_GH_LISTS=1 FAKE_GH_REPO="example/pc"

bash "$TEST_DIR/lib/fake_gh_client.sh" install "$SANDBOX/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
# 假 tmux：FAKE_TMUX_FAIL=1 时 new-session 失败（派工失败的夹具），否则记一行并成功
cat > "$SANDBOX/bin/tmux" <<'SH'
#!/usr/bin/env bash
log="${FAKE_TMUX_LOG:?}"
case "$1" in
    new-session)
        [ -e "$log.fail" ] && { echo "fake tmux: new-session refused" >&2; exit 1; }
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

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

git init -q --bare -b main "$SANDBOX/origin.git"
git clone -q "$SANDBOX/origin.git" "$SANDBOX/seed" 2>/dev/null
(cd "$SANDBOX/seed" && git -c user.email=t@x -c user.name=t commit -q --allow-empty -m init && git push -q origin HEAD:main) >/dev/null 2>&1
# 编号取得很大：派工脚本会往 /tmp 写 prompt 文件，避开本机真实派工的文件名
A=987201; B=987202; C=987203; M=987204
ROOT="$SANDBOX/skill"; mkdir -p "$ROOT"; cp -r "$REPO_DIR/scripts" "$REPO_DIR/prompts" "$ROOT/"

W="$SANDBOX/run"; CONF="$W/cavil-loop.config"; GD="$W/gh"
# 配置只建一次：第 2 步由 project-config.sh 改它，世界（GitHub、状态目录）每个场景重建
mkdir -p "$W"
cat > "$CONF" <<CONF
REPO="example/pc"
PROJECT_ROOT="$W/project"
WORKTREE_BASE="$W/wt"
STATE_DIR="$W/state"
TMUX_PREFIX="pctest"
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
AGENT_TRUST_PROMPT_WAIT_SECS=1
WORKER_SECRET_ENV=""
PATH="$SANDBOX/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
chmod 600 "$CONF"
printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\n' "$W/project" "$CONF" > "$HOME/.config/cavil-loop/pctest.conf"

world() {   # <场景：two-pending | failing | dead-worker>
    rm -rf "$W/state" "$W/wt" "$W/project" "$GD" "$W/tmux.log" "$W/tmux.log.live" "$W/tmux.log.fail"
    mkdir -p "$W/state" "$W/wt" "$GD"
    git clone -q "$SANDBOX/origin.git" "$W/project" 2>/dev/null
    export FAKE_GH_DIR="$GD" FAKE_TMUX_LOG="$W/tmux.log"
    echo '{}' > "$GD/events.json"; echo '{}' > "$GD/perms.json"; echo loop-bot > "$GD/me"; echo '{}' > "$GD/comments.json"
    echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$W/state/state.json"
    local issue='{kind:"issue", state:"open", title:"需求", body:"做一件事", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}'
    case "$1" in
        two-pending)
            jq -n --arg a "$A" --arg b "$B" --arg m "$M" "{(\$a): $issue, (\$b): $issue,
                (\$m): {kind:\"pr\", state:\"closed\", merged:true, title:\"已合并\", body:\"x\", user:{login:\"loop-bot\"}, updated_at:\"2026-01-01T00:00:00Z\",
                        head:{sha:\"2222222222222222222222222222222222222222\", ref:\"chore/merged\", repo:{full_name:\"example/pc\"}}, base:{ref:\"main\"}}}" > "$GD/items.json"
            jq -n --arg a "$A" --arg b "$B" --arg m "$M" '{($a): ["pending/agent"], ($b): ["pending/agent"], ($m): ["pending/human"]}' > "$GD/labels.json" ;;
        failing)
            : > "$W/tmux.log.fail"
            jq -n --arg a "$A" "{(\$a): $issue}" > "$GD/items.json"
            jq -n --arg a "$A" '{($a): ["pending/agent"]}' > "$GD/labels.json" ;;
        dead-worker)
            jq -n --arg c "$C" "{(\$c): $issue}" > "$GD/items.json"
            jq -n --arg c "$C" '{($c): ["doing/agent"]}' > "$GD/labels.json" ;;
    esac
}
poll() { env CODING_AGENT_CONFIG="$CONF" timeout 120 bash "$ROOT/scripts/agent-poll.sh" >/dev/null 2>&1; }
sessions() { grep -c '^new-session ' "$W/tmux.log" 2>/dev/null || true; }
logged() { grep -c -- "$1" "$W/state/poll.log" 2>/dev/null || true; }
cleaned() { jq -r --argjson n "$M" '(.cleaned_prs // []) | index($n) != null' "$W/state/state.json" 2>/dev/null; }
default_of() { grep -vE '^[[:space:]]*(#|$)' "$REPO_DIR/scripts/config-fields.txt" | awk -F'|' -v k="$1" '{gsub(/[ \t]/, "", $1); gsub(/^[ \t]+|[ \t]+$/, "", $4)} $1 == k {print $4}'; }

scenarios() {   # <同时几条> <派工失败上限> <自愈上限> <合并后清理 true|false>
    world two-pending; poll
    chk "两条待派工：这一轮起了 $1 个 worker 会话" "$(sessions)" "$1"
    chk "合并的 PR 记为已清理：$4" "$(cleaned)" "$4"
    # 开着：这一轮确实列了已合并 PR（「已清理」不是凑巧）；关着：整段跳过，一次都不列（上面起了会话，说明这一轮确实跑了）
    chk "这一轮列没列已合并 PR：$4" "$([ "$(grep -c '^gh pr list .*--state merged' "$GD/calls.log" 2>/dev/null || true)" -ge 1 ] && echo true || echo false)" "$4"
    world failing; poll
    chk "派工失败：日志写「第 1/$2 次」" "$(logged "#$A 派工失败（第 1/$2 次")" "1"
    world dead-worker; poll
    chk "worker 会话没了：日志写自愈「第 1/$3 次」" "$(logged "#$C session=.*自动重新派工（第 1/$3 次")" "1"
    rm -f /tmp/cavil-loop-issue-98720[1-4]-* 2>/dev/null
}

echo "【1】配置里这四项一项都不写"
chk "夹具：配置里确实没有这四项" "$(grep -cE '^(MAX_CONCURRENT_WORKERS|DISPATCH_MAX_RETRIES|SELFHEAL_MAX_RETRIES|AUTO_CLEANUP_ON_MERGE)=' "$CONF")" "0"
scenarios "$(default_of MAX_CONCURRENT_WORKERS)" "$(default_of DISPATCH_MAX_RETRIES)" "$(default_of SELFHEAL_MAX_RETRIES)" "$(default_of AUTO_CLEANUP_ON_MERGE)"
chk "登记表里这四项「不写时的值」是 1 / 3 / 3 / true" \
    "$(default_of MAX_CONCURRENT_WORKERS) $(default_of DISPATCH_MAX_RETRIES) $(default_of SELFHEAL_MAX_RETRIES) $(default_of AUTO_CLEANUP_ON_MERGE)" "1 3 3 true"

echo "【2】用 project-config.sh 把四项写进同一份配置"
pc() { env -i HOME="$HOME" PATH="$PATH" bash "$ROOT/scripts/project-config.sh" "$@" 2>&1; }
rev="$(pc get pctest | jq -r .rev)"
out="$(printf '{"MAX_CONCURRENT_WORKERS":"2","DISPATCH_MAX_RETRIES":"5","SELFHEAL_MAX_RETRIES":"4","AUTO_CLEANUP_ON_MERGE":"false"}' | pc set pctest --rev "$rev")"
chk "保存成功" "$(tail -1 <<<"$out")" "RESULT=saved"
chk "配置里原有的行（含 PATH、令牌那两行）一个字没动" "$(grep -c -e '^PATH="'"$SANDBOX"'/bin:\$PATH"$' -e '^GH_TOKEN="fake-token-for-test"$' "$CONF") $(stat -c %a "$CONF")" "2 600"
scenarios 2 5 4 false

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" = 0 ]
