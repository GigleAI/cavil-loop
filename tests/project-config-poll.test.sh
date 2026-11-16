#!/usr/bin/env bash
# kind: e2e
# 「项目配置」弹窗改的值真的被轮询用到；配置里不写时轮询实际用的值 = 登记表里写的（GitHub#388）。
#
# scripts/config-fields.txt 给每项登记了「不写这一行时 daemon 实际用的值」。有的默认值在 _lib.sh 加载时
# 就定了（tests/project-config.test.sh 对拍），有的是 agent-poll.sh 在用到的地方才补（${X:-默认}）——
# 这一类只有跑真实轮询才对得上。这里跑**真实** agent-poll.sh（常驻假 GitHub + 假 tmux / 假 claude，真 git）：
#   1. 配置里一项都不写：同时只派 1 条、派工失败记「第 1/3 次」、自愈记「第 1/3 次」、合并的 PR 被清理
#   2. 用真实 project-config.sh set 把这四项写进同一份配置，再跑：派 2 条、「1/5」、「1/4」、不清理
#   3. 等人审的 PR 和主干冲突（真冲突、真 merge-tree）：不写时刚更新的交回 agent、3 天没更新的只提醒
#      （= 开、2 天）；改成 5 天后 3 天没更新的也交回；关掉后什么都不做
#   4. 有新合并时刷新常驻正式站（GitHub#554）：不写 = 不刷新；用 project-config.sh 打开后，同样的合并触发刷新
#   5. 冲突检查判不出时重试几轮（GitHub#555）：不写 = 第 10 轮放弃这一版；用 project-config.sh 改成 3 后第 3 轮放弃
#   6. 「开着的都派」每轮扫几条（GitHub#555）：0 / 1 / 9 位 / 10 位 / 20 位，以及手写配置里带前导 0 的写法
#      （0000000000、0000000001、20 位长的 1、前导 0 的 10 亿），各在本机 GNU head 和一个照 macOS head 行为做的替身
#      （-n 只收 1 到 2^31-1）下跑真实轮询：派出去的条数按数值算，两边一样
#   7. 复盘用的模型：跑真实入口 post-merge-retrospective.sh（tests/project_config_retro_test.py），
#      看它实际交给模型程序的 --model：不写 / 写成空值 = sonnet，写了就是写的那个；
#      复盘开没开、两个复盘模式同样在那里对拍（GitHub#554）
#   8. 预览的几项（GitHub#556）：一项都不写时真实 preview-serve.sh 登记的端口、后端端口、闲置、就绪等待 = 窗口显示的值；
#      用 project-config.sh 改了之后（含取模改回留空）再注册，跟着变；算出来的端口超过 65535（手写的组合、编号涨上去）
#      注册入口拒绝、不写登记，边界正好的照常注册
#
#   bash tests/project-config-poll.test.sh      （约 40 秒）
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
unset CODING_AGENT_RELEASE_ROOT LABEL_AUTOPILOT LABEL_PENDING_BLOCKED LABEL_PENDING_LATER STUCK_WORKER_QUIET_SECS STUCK_WORKER_STEP_GAP_SECS STUCK_WORKER_MAX_RESTARTS GH_TOKEN WRITE_GH_TOKEN GITHUB_TOKEN POLL_FAKE_NOW
unset DISPATCH_AUTOPILOT DISPATCH_AUTOPILOT_ISSUE DISPATCH_AUTOPILOT_PR CAVIL_SCHEDULED_POLL
unset MAX_CONCURRENT_WORKERS DISPATCH_MAX_RETRIES SELFHEAL_MAX_RETRIES AUTO_CLEANUP_ON_MERGE PENDING_HUMAN_CONFLICT_MAX_TRIES
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
# main 和一个 PR 改同一个文件的同一行：真冲突。PR 的提交按 GitHub 的形状挂在 refs/pull/<n>/head 上
P=987205
G() { git -C "$SANDBOX/seed" -c user.email=t@x -c user.name=t "$@"; }
(echo base > "$SANDBOX/seed/f.txt" && G add f.txt && G commit -q -m init && G push -q origin HEAD:main \
    && echo from-pr > "$SANDBOX/seed/f.txt" && G commit -q -am "pr work" && G push -q origin "HEAD:refs/pull/$P/head") >/dev/null 2>&1
PR_SHA="$(G rev-parse HEAD)"
(G reset -q --hard HEAD~1 && echo from-main > "$SANDBOX/seed/f.txt" && G commit -q -am "main moved" && G push -q origin HEAD:main) >/dev/null 2>&1
# 编号取得很大，避开本机真实派工的编号
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
LATEST_SITE_BUILD_CMD="false"
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
        conflict)   # <PR 上次更新是几天前>：一个等人审的 PR，和 main 冲突
            jq -n --arg p "$P" --arg sha "$PR_SHA" --arg u "$(date -u -d "$2 days ago" +%Y-%m-%dT%H:%M:%SZ)" \
                '{($p): {kind:"pr", state:"open", merged:false, draft:false, title:"改动", body:"x", user:{login:"maint"}, updated_at:$u,
                         head:{sha:$sha, ref:"topic/conflict", repo:{full_name:"example/pc"}}, base:{ref:"main"}}}' > "$GD/items.json"
            jq -n --arg p "$P" '{($p): ["pending/human"]}' > "$GD/labels.json" ;;
        conflict-unknown)   # 一个等人审的 PR，GitHub 上拉不到它的提交：冲突检查每轮都判不出
            jq -n --arg p "$P2" --arg sha "$GHOST" \
                '{($p): {kind:"pr", state:"open", merged:false, draft:false, title:"拉不到", body:"x", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z",
                         head:{sha:$sha, ref:"topic/ghost", repo:{full_name:"example/pc"}}, base:{ref:"main"}}}' > "$GD/items.json"
            jq -n --arg p "$P2" '{($p): ["pending/human"]}' > "$GD/labels.json" ;;
        greedy)   # 两条没打标签的 issue：只有「开着的都派」会派
            jq -n --arg a "$A" --arg b "$B" "{(\$a): $issue, (\$b): $issue}" > "$GD/items.json"
            jq -n --arg a "$A" --arg b "$B" '{($a): [], ($b): []}' > "$GD/labels.json" ;;
        dead-worker)
            jq -n --arg c "$C" "{(\$c): $issue}" > "$GD/items.json"
            jq -n --arg c "$C" '{($c): ["doing/agent"]}' > "$GD/labels.json" ;;
    esac
}
poll() { env CODING_AGENT_CONFIG="$CONF" timeout 120 bash "$ROOT/scripts/agent-poll.sh" >/dev/null 2>&1; }
sessions() { grep -c '^new-session ' "$W/tmux.log" 2>/dev/null || true; }
logged() { grep -c -- "$1" "$W/state/poll.log" 2>/dev/null || true; }
cleaned() { jq -r --argjson n "$M" '(.cleaned_prs // []) | index($n) != null' "$W/state/state.json" 2>/dev/null; }
# 冲突检查这一轮对那个 PR 做了什么：worker = 留言并交回 agent；remind = 只留提醒；none = 什么都没做
conflict_outcome() {
    local marks human
    marks="$(jq -r --arg p "$P" '(.[$p] // [])[].body' "$GD/comments.json" 2>/dev/null | grep -o 'pending-human-conflict head=[0-9a-f]* mode=[a-z]*' | sed 's/.*mode=//' | sort -u | tr '\n' ' ')"
    human="$(jq -r --arg p "$P" '(.[$p] // []) | index("pending/human") != null' "$GD/labels.json")"
    case "$marks|$human" in
        "worker |false") echo worker ;;
        "remind |true") echo remind ;;
        "|true") echo none ;;
        *) echo "意外：评论标记[$marks] 仍挂 pending/human=$human" ;;
    esac
}
conflict_scenarios() {   # <PR 刚更新时期望> <PR 3 天没更新时期望>
    world conflict 0; poll
    chk "等人审的 PR 和主干冲突、刚更新过：$1" "$(conflict_outcome)" "$1"
    chk "到达性 · 这一轮确实读了打开的 PR 列表" "$([ "$(grep -c "repos/example/pc/pulls" "$GD/calls.log" 2>/dev/null || true)" -ge 1 ] && echo yes)" "yes"
    world conflict 3; poll
    chk "同一个 PR、3 天没更新：$2" "$(conflict_outcome)" "$2"
}
# 冲突检查判不出：先记下「这一版已经判不出 N 轮」，再跑一轮，看这一版 → "<轮数> trying|gaveup"
P2=987206; GHOST=3333333333333333333333333333333333333333
unknown_round() {   # <已经判不出的轮数>
    local tip tmp="$W/state/state.tmp"
    world conflict-unknown
    tip="$(git --git-dir="$SANDBOX/origin.git" rev-parse main)"
    jq --arg p "$P2" --arg k "$tip $GHOST" --argjson t "$1" '.pr_conflict[$p] = {key:$k, tries:$t, done:""}' "$W/state/state.json" > "$tmp" \
        && mv "$tmp" "$W/state/state.json"
    poll
    jq -r --arg p "$P2" '.pr_conflict[$p] // {} | "\(.tries) \(if (.done // "") == "" then "trying" else .done end)"' "$W/state/state.json"
}
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
}

echo "【1】配置里这几项一项都不写"
sed -i '/^PENDING_HUMAN_CONFLICT_CHECK=/d' "$CONF"
chk "夹具：配置里确实没有这六项" "$(grep -cE '^(MAX_CONCURRENT_WORKERS|DISPATCH_MAX_RETRIES|SELFHEAL_MAX_RETRIES|AUTO_CLEANUP_ON_MERGE|PENDING_HUMAN_CONFLICT_CHECK|PENDING_HUMAN_CONFLICT_AUTOFIX_DAYS)=' "$CONF")" "0"
scenarios "$(default_of MAX_CONCURRENT_WORKERS)" "$(default_of DISPATCH_MAX_RETRIES)" "$(default_of SELFHEAL_MAX_RETRIES)" "$(default_of AUTO_CLEANUP_ON_MERGE)"
chk "登记表里这四项「不写时的值」是 1 / 3 / 3 / true" \
    "$(default_of MAX_CONCURRENT_WORKERS) $(default_of DISPATCH_MAX_RETRIES) $(default_of SELFHEAL_MAX_RETRIES) $(default_of AUTO_CLEANUP_ON_MERGE)" "1 3 3 true"

# 冲突提醒：登记表说默认开、2 天内更新过的才自动交回——3 天没更新的那个只留提醒
chk "登记表里冲突提醒这两项「不写时的值」是 true / 2" "$(default_of PENDING_HUMAN_CONFLICT_CHECK) $(default_of PENDING_HUMAN_CONFLICT_AUTOFIX_DAYS)" "true 2"
conflict_scenarios worker remind
# 判不出时的重试上限：登记表说不写 = 10 轮
chk "登记表里冲突检查重试上限「不写时的值」是 10" "$(default_of PENDING_HUMAN_CONFLICT_MAX_TRIES)" "10"
chk "不写重试上限：判不出第 9 轮还在试（这一轮确实判了一次、记了数）" "$(unknown_round 8)" "9 trying"
chk "不写重试上限：第 10 轮放弃这一版" "$(unknown_round 9)" "10 gaveup"

# 有新合并时刷新正式站：不写 = 关（这一轮确实清理了那个已合并的 PR，说明合并确实被看到了）
world two-pending; poll
chk "不写「刷新正式站」：看到新合并、不刷新；登记表的「不写时的值」是 false" \
    "$(cleaned) $(logged 'merge 钩子') $(default_of LATEST_SITE_REFRESH)" "true 0 false"

echo "【2】用 project-config.sh 把四项写进同一份配置"
pc() { env -i HOME="$HOME" PATH="$PATH" bash "$ROOT/scripts/project-config.sh" "$@" 2>&1; }
rev="$(pc get pctest | jq -r .rev)"
out="$(printf '{"MAX_CONCURRENT_WORKERS":"2","DISPATCH_MAX_RETRIES":"5","SELFHEAL_MAX_RETRIES":"4","AUTO_CLEANUP_ON_MERGE":"false"}' | pc set pctest --rev "$rev")"
chk "保存成功" "$(tail -1 <<<"$out")" "RESULT=saved"
chk "配置里原有的行（含 PATH、令牌那两行）一个字没动" "$(grep -c -e '^PATH="'"$SANDBOX"'/bin:\$PATH"$' -e '^GH_TOKEN="fake-token-for-test"$' "$CONF") $(stat -c %a "$CONF")" "2 600"
scenarios 2 5 4 false

echo "【3】冲突提醒的两项：经 project-config.sh 改，轮询跟着变"
rev="$(pc get pctest | jq -r .rev)"
out="$(printf '{"PENDING_HUMAN_CONFLICT_AUTOFIX_DAYS":"5"}' | pc set pctest --rev "$rev")"
chk "自动交回天数改成 5：保存成功" "$(tail -1 <<<"$out")" "RESULT=saved"
conflict_scenarios worker worker
rev="$(pc get pctest | jq -r .rev)"
out="$(printf '{"PENDING_HUMAN_CONFLICT_CHECK":"false"}' | pc set pctest --rev "$rev")"
chk "冲突提醒关掉：保存成功" "$(tail -1 <<<"$out")" "RESULT=saved"
conflict_scenarios none none

echo "【4】刷新正式站：经 project-config.sh 打开，同样的合并触发刷新"
rev="$(pc get pctest | jq -r .rev)"
out="$(printf '{"LATEST_SITE_REFRESH":"true","AUTO_CLEANUP_ON_MERGE":"true"}' | pc set pctest --rev "$rev")"
chk "打开刷新（并把合并后清理改回开）：保存成功" "$(tail -1 <<<"$out")" "RESULT=saved"
world two-pending; poll
chk "看到新合并、触发刷新" "$(cleaned) $(logged 'merge 钩子')" "true 1"

echo "【5】冲突检查重试上限：经 project-config.sh 改成 3，轮询跟着变"
rev="$(pc get pctest | jq -r .rev)"
out="$(printf '{"PENDING_HUMAN_CONFLICT_CHECK":"true","PENDING_HUMAN_CONFLICT_MAX_TRIES":"3"}' | pc set pctest --rev "$rev")"
chk "重试上限改成 3（并把冲突提醒打开）：保存成功" "$(tail -1 <<<"$out")" "RESULT=saved"
chk "改成 3：第 2 轮还在试" "$(unknown_round 1)" "2 trying"
chk "改成 3：第 3 轮放弃这一版" "$(unknown_round 2)" "3 gaveup"

echo "【6】「开着的都派」每轮扫几条：GNU head 和 macOS 式 head 下，真实轮询派出去的条数一样"
# macOS 的 head 把 -n 的数用 strtol 存进 int、再拒绝非正数：只收 1 到 2^31-1，别的报错退出。照这个行为做一个替身，
# 其余调用原样交给本机的 head（daemon 别处也用 head，那些写法两个平台一样）
REAL_HEAD="$(command -v head)"; mkdir -p "$SANDBOX/bsdbin"
cat > "$SANDBOX/bsdbin/head" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$SANDBOX/bsdhead.log"
prev=""
for a in "\$@"; do
    n=""; is_n=0
    if [ "\$prev" = -n ]; then n="\$a"; is_n=1; else case "\$a" in -n?*) n="\${a#-n}"; is_n=1 ;; esac; fi
    if [ "\$is_n" = 1 ]; then
        # strtol 读的是数值：前导 0 不算位数（0000000001 = 1）
        v="\${n#"\${n%%[!0]*}"}"; [ -n "\$v" ] || v=0
        if ! [[ "\$n" =~ ^[0-9]+\$ ]] || ! [[ "\$v" =~ ^[0-9]{1,10}\$ ]] || [ "\$v" -le 0 ] || [ "\$v" -gt 2147483647 ]; then
            echo "head: illegal line count -- \$n" >&2; exit 1
        fi
    fi
    prev="\$a"
done
exec "$REAL_HEAD" "\$@"
SH
chmod +x "$SANDBOX/bsdbin/head"
chk "替身 head 像 macOS：-n 0 / 0000000000 / 2147483648 报错，-n 2 / -2 / 00000000000000000002 照常" \
    "$(printf 'a\nb\nc\n' | "$SANDBOX/bsdbin/head" -n 0 >/dev/null 2>&1; echo $?) $(printf 'a\n' | "$SANDBOX/bsdbin/head" -n 0000000000 >/dev/null 2>&1; echo $?) $(printf 'a\n' | "$SANDBOX/bsdbin/head" -n 2147483648 >/dev/null 2>&1; echo $?) $(printf 'a\nb\nc\n' | "$SANDBOX/bsdbin/head" -n 2 | wc -l | tr -d ' ') $(printf 'a\nb\nc\n' | "$SANDBOX/bsdbin/head" -2 | wc -l | tr -d ' ') $(printf 'a\nb\nc\n' | "$SANDBOX/bsdbin/head" -n 00000000000000000002 | wc -l | tr -d ' ')" \
    "1 1 1 2 2 2"
greedy_round() {   # <扫描条数> <gnu|bsd> → 这一轮起了几个 worker 会话
    local c2="$W/greedy.config"
    { cat "$CONF"; printf 'DISPATCH_MODE="greedy"\nMAX_CONCURRENT_WORKERS=5\nGREEDY_SCAN_LIMIT=%s\n' "$1"
      [ "$2" = bsd ] && printf 'PATH="%s:$PATH"\n' "$SANDBOX/bsdbin"; } > "$c2"
    world greedy
    env CODING_AGENT_CONFIG="$c2" timeout 120 bash "$ROOT/scripts/agent-poll.sh" >/dev/null 2>&1
    local n; n="$(sessions)"; printf '%s' "${n:-0}"   # 一个会话都没起时 tmux 记录文件不存在
}
: > "$SANDBOX/bsdhead.log"
for flavor in gnu bsd; do
    got=""
    for v in 0 1 999999999 2147483648 18446744073709551616; do got="$got $v:$(greedy_round "$v" "$flavor")"; done
    chk "$flavor head：扫 0 条不派、1 条派 1 个、9 位 / 10 位 / 20 位都把两条派完" "$got" " 0:0 1:1 999999999:2 2147483648:2 18446744073709551616:2"
    # 配置窗口不让写前导 0，但手写的已有配置照样被 daemon 读：按数值算，不按写了几位（复审第 4 轮）
    got=""
    for v in 0000000000 0000000001 00000000000000000001 00001000000000; do got="$got $v:$(greedy_round "$v" "$flavor")"; done
    chk "$flavor head：带前导 0 的写法按数值算——十个 0 不派、0000000001 和 20 位长的 1 只派 1 个、前导 0 的 10 亿派完" \
        "$got" " 0000000000:0 0000000001:1 00000000000000000001:1 00001000000000:2"
done
# 每轮对 issue、PR 各扫一次：每个交给 head 的数在记录里出现两次
chk "到达性 · bsd 那一组轮询真的用了替身 head：9 位的、带前导 0 的小数交给了它，数值到 10 亿的没交给它" \
    "$(grep -cx -- '-n 999999999' "$SANDBOX/bsdhead.log") $(grep -cxE -- '-n (0|1)' "$SANDBOX/bsdhead.log" | tr -d ' ') $(grep -cxE -- '-n (0000000000|0000000001|00000000000000000001)' "$SANDBOX/bsdhead.log") $(grep -cE -- '-n 0*[1-9][0-9]{9,}$' "$SANDBOX/bsdhead.log")" "2 4 6 0"
chk "登记表：扫描条数从 0 起、不设上限" "$(grep -E '^GREEDY_SCAN_LIMIT ' "$REPO_DIR/scripts/config-fields.txt" | awk -F'|' '{gsub(/ /, "", $3); print $3}')" "int:0:"

echo "【7】复盘用的模型：真实复盘入口实际交给模型程序的 --model"
# 这组用例自带一个假 HOME 和它自己的 git 身份：不带上面给轮询用的 git 环境变量
if out="$(env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM -u FAKE_GH_DIR -u FAKE_GH_LISTS -u FAKE_GH_REPO QUIET=1 python3 "$TEST_DIR/project_config_retro_test.py" 2>&1)"; then
    echo "  ✅ $(printf '%s\n' "$out" | grep -E '^Ran ')"; pass=$((pass+1))
else
    printf '%s\n' "$out" | tail -30; echo "  ❌ 复盘入口用例有红"; fail=$((fail+1))
fi

echo "【8】预览的几项（GitHub#556）：真实 preview-serve.sh 登记的端口和参数 = 窗口显示的值"
# 预览的默认值在用到的地方（preview-serve.sh / 公共库的 preview_port）才补：跑真实注册入口，读它写下的那份登记。
# 假 systemctl 只认「没在跑」、其余一律成功；不碰真实 systemd，tailnet 那项保持默认关。
PV="$SANDBOX/pv"; PCONF="$PV/cavil-loop.config"; mkdir -p "$PV/bin" "$PV/project" "$PV/state" "$PV/wt/issue-1040" "$HOME/.config/systemd/user"
printf '#!/usr/bin/env bash\ncase "$*" in *is-active*) echo inactive; exit 3;; esac\nexit 0\n' > "$PV/bin/systemctl"; chmod +x "$PV/bin/systemctl"
: > "$HOME/.config/systemd/user/cavil-loop-preview@.socket"
cat > "$PCONF" <<CONF
REPO="example/pv"
PROJECT_ROOT="$PV/project"
WORKTREE_BASE="$PV/wt"
STATE_DIR="$PV/state"
TMUX_PREFIX="pvtest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
PREVIEW_EXEC="node server.mjs"
CONF
printf 'PROJECT_ROOT=%s\nCODING_AGENT_CONFIG=%s\n' "$PV/project" "$PCONF" > "$HOME/.config/cavil-loop/pvtest.conf"
serve() {   # [issue，默认 1040] → 真实 preview-serve.sh 注册后写下的那份登记里「端口 后端端口 闲置 就绪等待」；没写出来输出 NONE
    local n="${1:-1040}"; mkdir -p "$PV/wt/issue-$n"
    rm -rf "$HOME/.config/cavil-loop/preview"
    env -i HOME="$HOME" PATH="$PV/bin:$PATH" CODING_AGENT_CONFIG="$PCONF" timeout 60 bash "$ROOT/scripts/preview-serve.sh" "$n" > "$PV/serve.out" 2>&1; echo "$?" > "$PV/serve.rc"
    local f; f="$(ls "$HOME/.config/cavil-loop/preview/"*.conf 2>/dev/null | head -1)"
    [ -n "$f" ] || { printf NONE; return; }
    ( set +u; source "$f"; printf '%s %s %s %s' "$PREVIEW_PORT" "$PREVIEW_BACKEND_PORT" "$PREVIEW_IDLE" "$PREVIEW_READY_TIMEOUT" )
}
shown_pv() {   # → 窗口显示的「起始号|取模|偏移|闲置|就绪等待」
    pc get pvtest | jq -r '[.fields[] | select(.name | test("^PREVIEW_(PORT_BASE|PORT_MODULO|BACKEND_OFFSET|IDLE|READY_TIMEOUT)$")) | {(.name): .value}] | add
        | "\(.PREVIEW_PORT_BASE)|\(.PREVIEW_PORT_MODULO)|\(.PREVIEW_BACKEND_OFFSET)|\(.PREVIEW_IDLE)|\(.PREVIEW_READY_TIMEOUT)"'
}
chk "一项都不写：真实注册用的是端口 4000+1040、后端再加 10000、闲置 30min、就绪等 90 秒" "$(serve)" "5040 15040 30min 90"
chk "同一份配置：窗口显示的正是这几个值（取模留空 = 不取模）" "$(shown_pv)" "4000||10000|30min|90"
rev="$(pc get pvtest | jq -r .rev)"
out="$(printf '{"PREVIEW_PORT_BASE":"6000","PREVIEW_PORT_MODULO":"1000","PREVIEW_BACKEND_OFFSET":"100","PREVIEW_READY_TIMEOUT":"30"}' | pc set pvtest --rev "$rev")"
chk "用 project-config.sh 改起始号、取模、偏移、就绪等待：保存成功" "$(tail -1 <<<"$out")" "RESULT=saved"
chk "改完再注册：端口 6000+1040%1000、后端再加 100、就绪等 30 秒" "$(serve)" "6040 6140 30min 30"
chk "窗口读回的是新值" "$(shown_pv)" "6000|1000|100|30min|30"
rev="$(pc get pvtest | jq -r .rev)"
out="$(printf '{"PREVIEW_PORT_MODULO":""}' | pc set pvtest --rev "$rev")"
chk "取模改回留空：保存成功，再注册就不取模（6000+1040）" "$(tail -1 <<<"$out") $(serve)" "RESULT=saved 7040 7140 30min 30"
# 算出来的端口超过 65535（GitHub#556 复审第 1 轮）：配置里手写的越界组合、或没取余数时 issue 编号涨上去——
# 真实注册入口在写任何登记之前就停下，退出码 2，说清是哪几项设置
pv_line() { local k="$1" v="$2" t; t="$(grep -v "^$k=" "$PCONF")"; printf '%s\n%s=%s\n' "$t" "$k" "$v" > "$PCONF"; }
pv_line PREVIEW_PORT_BASE 6000; pv_line PREVIEW_BACKEND_OFFSET 65535; pv_line PREVIEW_PORT_MODULO '""'
r="$(serve 1)"
chk "配置里手写起始号 6000 + 偏移 65535：#1 的后端端口 71536，注册拒绝（退出 2、没写登记）" "$r $(cat "$PV/serve.rc")" "NONE 2"
chk "拒绝时说清是后端端口越界、该改哪几项" "$(grep -c '后端端口 71536 超出' "$PV/serve.out") $(grep -c 'PREVIEW_BACKEND_OFFSET' "$PV/serve.out")" "1 1"
pv_line PREVIEW_PORT_BASE 4000; pv_line PREVIEW_BACKEND_OFFSET 10000
chk "默认的起始号和偏移、编号小的 #1040：照常注册（到达性）" "$(serve 1040) $(cat "$PV/serve.rc")" "5040 15040 30min 30 0"
chk "同一份配置，编号涨到 #52000：后端端口 66000 越界，注册拒绝" "$(serve 52000) $(cat "$PV/serve.rc") $(grep -c '后端端口 66000 超出' "$PV/serve.out")" "NONE 2 1"
chk "边界正好：编号 #51535 的后端端口 65535，照常注册" "$(serve 51535) $(cat "$PV/serve.rc")" "55535 65535 30min 30 0"
pv_line PREVIEW_PORT_BASE 65000
chk "公开端口本身越界（起始号 65000 + #1040 = 66040）：注册拒绝" "$(serve 1040) $(cat "$PV/serve.rc") $(grep -c '公开端口 66040 超出' "$PV/serve.out")" "NONE 2 1"
# 复审第 2 轮：手写的大数一进算术就回绕（偏移 2^64 加完等于没加，两个服务抢同一个端口）——先查输入再算
pv_line PREVIEW_PORT_BASE 4000; pv_line PREVIEW_BACKEND_OFFSET 18446744073709551616
chk "手写偏移 2^64：注册拒绝（不回绕成 4001 / 4001），点名偏移" "$(serve 1) $(cat "$PV/serve.rc") $(grep -c '后端偏移 18446744073709551616 不是' "$PV/serve.out")" "NONE 2 1"
pv_line PREVIEW_BACKEND_OFFSET 10000; pv_line PREVIEW_PORT_BASE 18446744073709555616
chk "手写起始号 2^64+4000：注册拒绝" "$(serve 1) $(cat "$PV/serve.rc") $(grep -c '起始号 18446744073709555616 不是' "$PV/serve.out")" "NONE 2 1"
pv_line PREVIEW_PORT_BASE 4000; pv_line PREVIEW_PORT_MODULO 0
chk "手写取余数 0（会除以零）：注册拒绝，不是算术报错" "$(serve 1) $(cat "$PV/serve.rc") $(grep -c '取余数 0 不是' "$PV/serve.out")" "NONE 2 1"
pv_line PREVIEW_PORT_MODULO 08
chk "手写取余数 08（bash 会按八进制读而报错）：注册拒绝" "$(serve 1) $(cat "$PV/serve.rc") $(grep -c '取余数 08 不是' "$PV/serve.out")" "NONE 2 1"
pv_line PREVIEW_PORT_MODULO '""'; pv_line PREVIEW_PORT_BASE 0
chk "起始号 0、不取余数：#1 端口 1、后端 10001，照常注册" "$(serve 1) $(cat "$PV/serve.rc")" "1 10001 30min 30 0"
pv_line PREVIEW_PORT_MODULO 1000
chk "起始号 0、取余数 1000：#1000 端口 0，注册拒绝；#1 端口 1 照常注册" "$(serve 1000) $(cat "$PV/serve.rc") | $(serve 1) $(cat "$PV/serve.rc")" "NONE 2 | 1 10001 30min 30 0"
# 复审第 3 轮：取余数是除数不是端口——旧配置的取余数 100000 照常注册、照常注销（不带 --port，按同一份算法找回端口）
pv_line PREVIEW_PORT_BASE 4000; pv_line PREVIEW_PORT_MODULO 100000
chk "旧配置取余数 100000：#1 注册出 4001 / 14001" "$(serve 1) $(cat "$PV/serve.rc")" "4001 14001 30min 30 0"
unserve() { env -i HOME="$HOME" PATH="$PV/bin:$PATH" CODING_AGENT_CONFIG="$PCONF" timeout 60 bash "$ROOT/scripts/preview-unserve.sh" "$@" > "$PV/unserve.out" 2>&1; echo $?; }
chk "同一份配置不带 --port 注销 #1：按同一份算法找到 4001，登记删掉" "$(unserve --issue 1) $(ls "$HOME/.config/cavil-loop/preview/" 2>/dev/null | grep -c '^4001\.conf$')" "0 0"
# 编号大了才越界：取余数 1000、起始号 60000、偏移 5000 能保存（见配置测试），余数大的那几条在注册时按实际端口拦下
pv_line PREVIEW_PORT_BASE 60000; pv_line PREVIEW_PORT_MODULO 1000; pv_line PREVIEW_BACKEND_OFFSET 5000
chk "起始号 60000、取余数 1000、偏移 5000：#535 后端 65535 照常注册，#536 后端 65536 拒绝" "$(serve 535) $(cat "$PV/serve.rc") | $(serve 536) $(cat "$PV/serve.rc") $(grep -c '后端端口 65536 超出' "$PV/serve.out")" "60535 65535 30min 30 0 | NONE 2 1"
pv_line PREVIEW_BACKEND_OFFSET 0
chk "手写偏移 0：后端和公开端口相同，注册拒绝" "$(serve 1) $(cat "$PV/serve.rc") $(grep -c '两个服务会抢同一个端口' "$PV/serve.out")" "NONE 2 1"
pv_line PREVIEW_PORT_BASE 4000; pv_line PREVIEW_PORT_MODULO '""'; pv_line PREVIEW_BACKEND_OFFSET 10000

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" = 0 ]
