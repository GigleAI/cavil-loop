#!/usr/bin/env bash
# kind: e2e
# 续不上的对话不再反复续；退出前的最后一屏存进会话日志，交人时如实说存没存下（GitHub#738）。
#
# 跑法：bash tests/resume-failure.test.sh   （约 1.5 分钟）
# 依赖：tmux、git、jq、python3。不碰网络：假 gh；真 tmux，开在本次运行自己的服务上（tests/lib/tmux-sandbox.sh）；
# 真 agent-poll.sh、真派工脚本、真 agent-exit-screen.sh / resume_failure.py。
#
# 2026-11-27 本机换了 codex 的模型供应商，旧对话一打开就报错退出（约 3 秒后，派工脚本只等 2 秒）；
# 自动恢复每次都续同一条，三次后交人，评论里只有「退出码 1」，报错一行都没留下。这里断言：
#   1. 识别规则：tests/fixtures/resume-failure/ 的真实截屏认对；用量上限、目录信任框的真实截屏都不认
#   2. 续接 3 秒后才退出、屏幕上是「找不到这条对话」→ 下一轮自动恢复退役那条 id（进退役名单、登记清空），
#      日志写原因；再派工开的是新对话（新 id）；会话日志里有那段报错和保存标记，令牌样式的字符串已换掉
#   3. 不退役的两种：登记在两轮之间换成了别的 id；最后一屏不是这次启动的（记号对不上）——都照旧重试
#   4. 用完次数交人：认出原因时写原因和「已停用旧对话」；认不出时按保存结果写——存好 / 关了会话日志 /
#      抓屏失败 / 去令牌失败（什么都不留）/ 写入日志失败 / 只有上一次启动的记录（结果不明）；评论里都没有屏幕原文
#   5. 派工脚本（issue 评论、PR 评论两个入口）续接 2 秒内就退出：日志写认出的原因，照旧降级开新对话
#   6. 开会话日志时程序已经退出：日志说「程序已经退出」，不说「认不出窗格」
#   7. cleanup-issue.sh 删掉新加的三个记录文件
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# 本次运行独用一个 tmux 服务，跑完收掉（GitHub#647）。必须在建任何东西之前载入。
# shellcheck source=lib/tmux-sandbox.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/tmux-sandbox.sh"
tmux_sandbox_start

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
FIX="$TEST_DIR/fixtures/resume-failure"
if ! command -v tmux > /dev/null 2>&1; then
    echo "⏭ 本机没有 tmux，整份跳过"; exit 0
fi
TMP="$(mktemp -d)" || exit 1
tmux_sandbox_own_dir "$TMP"
TMP="$(cd "$TMP" && pwd -P)"

pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi; }
has() { case "$2" in *"$3"*) echo "  ✅ $1"; pass=$((pass+1)) ;; *) echo "  ❌ $1 (找不到 [$3]；实得 [${2:0:800}])"; fail=$((fail+1)) ;; esac; }
lacks() { case "$2" in *"$3"*) echo "  ❌ $1 (不该出现 [$3])"; fail=$((fail+1)) ;; *) echo "  ✅ $1"; pass=$((pass+1)) ;; esac; }

echo "【1】识别规则：真实截屏"
for f in "$FIX"/*.txt; do
    a=codex; case "$f" in */claude-*) a=claude ;; esac
    want=provider-gone; case "$f" in *session-missing*) want=session-missing ;; esac
    out="$(python3 "$REPO_DIR/scripts/resume_failure.py" "$a" < "$f")"
    chk "$(basename "$f") 认成 $want" "${out%%$'\t'*}" "$want"
done
neg=0; negn=0
for f in "$TEST_DIR"/fixtures/usage-limit/*.txt "$TEST_DIR"/fixtures/trust-dialog/*.txt; do
    for a in claude codex; do
        negn=$((negn + 1))
        [ -z "$(python3 "$REPO_DIR/scripts/resume_failure.py" "$a" < "$f")" ] || { neg=$((neg + 1)); echo "    误认：$f ($a)"; }
    done
done
chk "反例（用量上限、信任框的真实截屏，$negn 次）一个都不认" "$neg" 0
chk "到达性 · 反例确实读到了" "$([ "$negn" -ge 20 ] && echo yes)" yes
chk "别的 agent 的规则不串：claude 的规则不认 codex 的报错" \
    "$(python3 "$REPO_DIR/scripts/resume_failure.py" claude < "$FIX/codex-session-missing.txt")" ""
chk "报错在上文、最后 20 行里没有 → 不认" \
    "$( { cat "$FIX/claude-session-missing.txt"; seq 1 25; } | python3 "$REPO_DIR/scripts/resume_failure.py" claude)" ""

CTL="$TMP/ctl"; mkdir -p "$CTL"
NEXT_TMUX="$(command -v tmux)"   # 沙盒的 tmux 包装
REAL_PY="$(command -v python3)"
TOKEN="gh""p_$(printf 'Z%.0s' $(seq 36))"   # 令牌样式的字符串（拼出来写，源码里没有整串）

# 本机 PATH 里凡是有 claude 的目录都从被测脚本的 PATH 里拿掉
: > "$CTL/hide"
IFS=: read -r -a _dirs <<< "$PATH"
for _d in "${_dirs[@]}"; do [ -n "$_d" ] && [ -e "$_d/claude" ] && printf '%s\n' "$_d" >> "$CTL/hide"; done
printf '%s\n' "$TMP/__none__" >> "$CTL/hide"

# 假 claude：记下每次怎么起的；--session-id 新开时建对话文件（daemon 下次才会续它）。$CTL/mode：
#   sleep   一直睡
#   gone    续接时打出 claude 真实的「找不到这条对话」，等测试放行（$CTL/go）后以 1 退出——派工早已结束，
#           等于「2 秒之后才退出」，不靠固定时长
#   gone-now 续接时打出同一句，立刻以 1 退出（派工脚本的 2 秒检查看得到）；新开时一直睡
#   boom    打出一句认不出的报错和一个令牌样式的字符串，放行后以 1 退出
#   ok-exit 放行后以 0 退出
mkdir -p "$TMP/agentbin"
cat > "$TMP/agentbin/claude" <<SH
#!/usr/bin/env bash
[ -n "\${TMUX:-}" ] || exit 0
id=""; res=""; prev=""
for a in "\$@"; do case "\$prev" in --session-id) id="\$a" ;; --resume) res="\$a" ;; esac; prev="\$a"; done
if [ -n "\$res" ]; then echo "resume:\$res" >> "$CTL/launches"; else echo "new:\$id" >> "$CTL/launches"; fi
if [ -n "\$id" ]; then d="\$(cat "$CTL/home")/.claude/projects/\$(pwd -P | tr -c 'A-Za-z0-9' '-')"; mkdir -p "\$d"; : > "\$d/\$id.jsonl"; fi
waitgo() { local i; for ((i = 0; i < 900; i++)); do [ -e "$CTL/go" ] && return 0; sleep 0.1; done; }
case "\$(cat "$CTL/mode" 2>/dev/null)" in
    gone) [ -n "\$res" ] || exec sleep 120; echo "No conversation found with session ID: \$res"; waitgo; exit 1 ;;
    gone-now) [ -n "\$res" ] || exec sleep 120; echo "No conversation found with session ID: \$res"; exit 1 ;;
    boom) echo "boom: unexpected failure near $TOKEN"; waitgo; exit 1 ;;
    ok-exit) waitgo; exit 0 ;;
esac
exec sleep 120
SH
chmod +x "$TMP/agentbin/claude"

# 垫片：tmux 在 \$CTL/fail-capture 在时拒绝 capture-pane；python3 在 \$CTL/fail-redact 在时、被保存最后一屏的
# 脚本调用时失败（别处照常）
mkdir -p "$TMP/shim"
cat > "$TMP/shim/tmux" <<SH
#!/usr/bin/env bash
[ -e "$CTL/fail-capture" ] && [ "\${1:-}" = capture-pane ] && exit 1
exec "$NEXT_TMUX" "\$@"
SH
cat > "$TMP/shim/python3" <<SH
#!/usr/bin/env bash
if [ -e "$CTL/fail-redact" ] && tr '\0' ' ' < /proc/\$PPID/cmdline 2>/dev/null | grep -q agent-exit-screen; then exit 1; fi
exec "$REAL_PY" "\$@"
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/shim/systemctl"
chmod +x "$TMP/shim"/*

gq() { git -c user.email=t@example.invalid -c user.name=t "$@" >/dev/null 2>&1; }
gq init -q --bare -b main "$TMP/up.git"
gq clone -q "$TMP/up.git" "$TMP/seed"
(cd "$TMP/seed" && echo x > f && gq add f && gq commit -qm init && gq push -q origin HEAD:main)

N=987411
SESS="abc-issue$N"
OLD_ID="11111111-2222-4333-8444-555555555555"
P=""; GD=""; WT=""
sess_alive() { tmux has-session -t "=$SESS" 2>/dev/null; }
wait_gone() { local i; for ((i = 0; i < 150; i++)); do sess_alive || return 0; sleep 0.1; done; return 1; }
reg() { tr -d "[:space:]" 2>/dev/null < "$P/state/agent-sessions/$N.claude.worker"; }
retired() { cat "$P/state/agent-sessions/$N.claude.worker.retired" 2>/dev/null; }
plabels() { jq -r --arg n "$N" '(.[$n] // []) | sort | join(",")' "$GD/labels.json"; }
plog() { cat "$P/state/poll.log" 2>/dev/null; }
pcomments() { jq -r '.. | .body? // empty' "$GD"/comments.json 2>/dev/null; }
launches() { cat "$CTL/launches" 2>/dev/null; }
slog() { cat "$P/state/sessions/$SESS.log" 2>/dev/null; }
xdir() { printf '%s' "$P/state/worker-exit"; }

# 一个场景一套：真 git、已有工作目录、登记着一条已有对话文件的旧对话 OLD_ID、条目挂 pending/agent。
# $1 = 名字；其余参数追加进配置
setup() {
    P="$TMP/p.$1"; rm -rf "$P"; mkdir -p "$P/gh" "$P/bin" "$P/state" "$P/wt" "$P/home"
    shift
    gq clone -q "$TMP/up.git" "$P/project"
    WT="$P/wt/issue-$N"
    gq -C "$P/project" worktree add -q "$WT" -b "feature/issue-$N"
    bash "$TEST_DIR/lib/fake_gh_client.sh" install "$P/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
    GD="$P/gh"
    echo '{}' > "$GD/events.json"; echo '{}' > "$GD/perms.json"; echo loop-bot > "$GD/me"
    jq -n --arg i "$N" '{($i): {kind:"issue", state:"open", title:"续接测试", body:"做一件事", user:{login:"maint"}, updated_at:"2026-01-01T00:00:00Z"}}' > "$GD/items.json"
    jq -n --arg i "$N" '{($i): ["pending/agent"]}' > "$GD/labels.json"
    echo '{}' > "$GD/comments.json"
    cat > "$P/config" <<CONF
REPO="example/rf"
PROJECT_ROOT="$P/project"
WORKTREE_BASE="$P/wt"
STATE_DIR="$P/state"
TMUX_PREFIX="abc"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_PR="pending/PR"
LABEL_PENDING_REVIEW="pending/review"
LABEL_AGENT_DOING="doing/agent"
LABEL_DONE="Done"
LABEL_PENDING_BLOCKED=""
LABEL_AUTOPILOT=""
WORKER_AGENT="claude"
WORKER_SECRET_ENV=""
POST_MERGE_RETROSPECTIVE=false
PENDING_HUMAN_CONFLICT_CHECK=false
POLL_BACKOFF_LADDER=""
PRICE_AUTO_FETCH=0
SELFHEAL_MAX_RETRIES=9
AGENT_TRUST_PROMPT_WAIT_SECS=1
CAVIL_AGENT_BIN_CHECK_WAIT=2
GH_TOKEN="fake-token-for-test"
PATH="$TMP/shim:$P/bin:$TMP/agentbin:\$(printf '%s' "\$PATH" | tr ':' '\n' | grep -vxF -f "$CTL/hide" | paste -sd: -)"
CONF
    local extra; for extra in "$@"; do printf '%s\n' "$extra" >> "$P/config"; done
    chmod 600 "$P/config"
    echo '{"cleaned_prs":[],"cleaned_issues":[]}' > "$P/state/state.json"
    mkdir -p "$P/state/agent-sessions"
    echo "$OLD_ID" > "$P/state/agent-sessions/$N.claude.worker"
    local d="$P/home/.claude/projects/$(printf %s "$WT" | tr -c 'A-Za-z0-9' '-')"
    mkdir -p "$d"; : > "$d/$OLD_ID.jsonl"
    echo "$P/home" > "$CTL/home"
    rm -f "$CTL/launches" "$CTL/go" "$CTL/mode" "$CTL"/fail-*
    tmux kill-session -t "=$SESS" 2>/dev/null
    return 0
}
poll_round() {
    (cd "$P/project" && tmux_sandbox_env_i HOME="$P/home" LANG=C.UTF-8 CODING_AGENT_CONFIG="$P/config" \
        FAKE_GH_LISTS=1 FAKE_GH_REPO=example/rf FAKE_GH_DIR="$GD" \
        timeout 180 bash "$REPO_DIR/scripts/agent-poll.sh") > "$P/poll.out" 2>&1
}
# 派一次续接（模式 $1），放行让它退出、等会话消失
resume_and_die() {
    echo "$1" > "$CTL/mode"; rm -f "$CTL/go"
    poll_round
    chk "到达性 · [$1] 这一轮续的是旧对话" "$(launches | tail -n 1)" "resume:$OLD_ID"
    chk "到达性 · [$1] 派工后条目在 doing/agent" "$(plabels)" "doing/agent"
    [ -z "${2:-}" ] || "$2"   # 程序退出之前要布置的故障
    touch "$CTL/go"; wait_gone; rm -f "$CTL/go"
    chk "到达性 · [$1] 程序退出、会话消失" "$(sess_alive && echo alive || echo gone)" gone
}

echo "【2】续接 3 秒后才退出、认出「找不到这条对话」→ 退役，下一次派工开新对话"
setup retire
resume_and_die gone
X="$(xdir)/$SESS"
chk "保存结果：已存进会话日志" "$(cut -d' ' -f2- "$X.saved" 2>/dev/null)" saved
has "会话日志里有那段报错" "$(slog)" "No conversation found with session ID: $OLD_ID"
has "会话日志里有这次的保存标记" "$(slog)" "程序退出（记号 $(cat "$X.launch")），最后一屏"
echo sleep > "$CTL/mode"
poll_round
has "自动恢复的日志写了认出的原因" "$(plog)" "认出的原因：claude 找不到这条对话的记录，已退役这条对话，下一次派工开新对话"
chk "旧 id 进了退役名单" "$(retired)" "$OLD_ID"
chk "登记清空了" "$(reg)" ""
chk "送回派工标签" "$(plabels)" "pending/agent"
chk "这一轮计了一次重试（计数不清零）" "$(cat "$P/state/selfheal/$N" 2>/dev/null)" 1
for _ in 1 2; do launches | tail -n 1 | grep -q '^new:' && break; poll_round; done
L="$(launches | tail -n 1)"
chk "再派工开的是新对话" "${L%%:*}" new
NEW_ID="${L#new:}"
chk "新对话的 id 不是旧的、登记的就是它" "$([ "$NEW_ID" != "$OLD_ID" ] && [ "$(reg)" = "$NEW_ID" ] && echo yes)" yes
chk "新对话起来了" "$(sess_alive && echo alive)" alive
tmux kill-session -t "=$SESS" 2>/dev/null

echo "【3a】登记在两轮之间换成了别的 id → 不退役，照旧重试"
setup swapped
resume_and_die gone
OTHER="99999999-8888-4777-8666-555555555555"
echo "$OTHER" > "$P/state/agent-sessions/$N.claude.worker"
poll_round
has "日志写明登记已换、不退役" "$(plog)" "对话登记已不是这次续的那条（或读不到），不退役"
chk "退役名单里没有旧 id" "$(retired | grep -c "$OLD_ID")" 0
chk "登记还是换上去的那条" "$(reg)" "$OTHER"
chk "照旧送回派工标签" "$(plabels)" "pending/agent"
has "日志仍写了认出的原因" "$(plog)" "认出的原因：claude 找不到这条对话的记录）"

echo "【3b】最后一屏不是这次启动的（记号对不上）→ 不退役、不说原因"
setup stale-token
resume_and_die gone
echo "00000000-0000-4000-8000-000000000000" > "$(xdir)/$SESS.launch"   # 之后又有一次启动，没留任何记录
poll_round
chk "登记没动" "$(reg)" "$OLD_ID"
chk "退役名单是空的" "$(retired)" ""
lacks "日志没有认出的原因" "$(plog)" "认出的原因"
has "到达性 · 这一轮确实做了自动恢复" "$(plog)" "self-heal: issue #$N session=$SESS 不存在"

echo "【4】用完次数交人：评论按事实写"
at_cap() { mkdir -p "$P/state/selfheal"; echo 9 > "$P/state/selfheal/$N"; }
handoff() {   # $1 = 名字，$2 = 期望评论里有的句子，$3 = 退出前布置故障的函数（可空），其余 = 配置
    local name="$1" want="$2" arm="$3"; shift 3
    setup "$name" "$@"
    resume_and_die boom "$arm"
    at_cap
    poll_round
    chk "[$name] 转 pending/human" "$(plabels)" "pending/human"
    has "[$name] 评论写了退出码" "$(pcomments)" "退出码 1：程序报错退出"
    has "[$name] 评论写了保存结果" "$(pcomments)" "$want"
    lacks "[$name] 评论里没有屏幕原文" "$(pcomments)" "boom"
    lacks "[$name] 评论里没有令牌样式的字符串" "$(pcomments)" "$TOKEN"
    lacks "[$name] 没认出原因就不说原因" "$(pcomments)" "认出的原因"
}
handoff saved '退出前的最后一屏已存进会话日志（令牌已去掉），在 daemon 机器上用 `session-log.sh '"$N"' -c` 看' ""
has "[saved] 会话日志里有那句报错" "$(slog)" "boom: unexpected failure near"
lacks "[saved] 会话日志里没有令牌原文" "$(slog)" "$TOKEN"
has "[saved] 会话日志里令牌换成了占位" "$(slog)" "REDACTED-"
handoff log-off '本项目关了会话日志，退出前的最后一屏没有存下来' "" 'SESSION_LOG_DIR=""'
chk "[log-off] 没建会话日志" "$(ls "$P/state/sessions" 2>/dev/null | wc -l | tr -d ' ')" 0
has "[log-off] 最后一屏仍存了一份给识别用（令牌已换掉）" "$(cat "$(xdir)/$SESS.screen")" "boom: unexpected failure near REDACTED-"
arm_capture() { touch "$CTL/fail-capture"; }
handoff capture '这次没能存下退出前的最后一屏（抓屏失败）' arm_capture
arm_redact() { touch "$CTL/fail-redact"; }
handoff redact '去掉令牌这一步失败，为了不留明文什么都没存' arm_redact
chk "[redact] 记录目录里没有令牌原文" "$(grep -rl "$TOKEN" "$(xdir)" 2>/dev/null | wc -l | tr -d ' ')" 0
chk "[redact] 没留最后一屏" "$([ -e "$(xdir)/$SESS.screen" ] && echo yes || echo no)" no
arm_write() { chmod 444 "$P/state/sessions/$SESS.log"; }
handoff write '这次没能存下退出前的最后一屏（写文件失败）' arm_write
# 只有上一次启动的记录：把「这次启动」换成一次没留任何记录的新启动再交人
setup stale
resume_and_die boom
echo "00000000-0000-4000-8000-000000000000" > "$(xdir)/$SESS.launch"
at_cap; poll_round
has "[stale] 只有上一次启动的记录：评论写结果不明" "$(pcomments)" "不确定退出前的最后一屏有没有存下来"
lacks "[stale] 不说已存" "$(pcomments)" "已存进会话日志"
# 认出原因时：写原因和「已停用旧对话」
setup cap-known
resume_and_die gone
at_cap; poll_round
chk "[认出原因] 转 pending/human" "$(plabels)" "pending/human"
has "[认出原因] 评论写了原因" "$(pcomments)" "认出的原因：claude 找不到这条对话的记录，再续多少次都一样"
has "[认出原因] 评论写了已停用旧对话" "$(pcomments)" "daemon 已停用这条旧对话，标签改回后会开一条新对话接着做"
lacks "[认出原因] 评论里没有屏幕原文" "$(pcomments)" "No conversation found"
chk "[认出原因] 旧 id 进了退役名单" "$(retired)" "$OLD_ID"

echo "【5】派工脚本续接 2 秒内就退出：日志写原因，照旧降级开新对话"
# issue 评论入口走真 agent-poll；PR 评论入口直接跑派工脚本（假 gh 只管条目和标签）
setup now-issue
echo gone-now > "$CTL/mode"
poll_round
has "[issue 评论] 降级日志写了原因" "$(plog)" "降级为全新"
has "[issue 评论] 降级日志带认出的原因" "$(plog)" "认出的原因：claude 找不到这条对话的记录）"
chk "[issue 评论] 降级后开的是新对话" "$(launches | tail -n 1 | cut -d: -f1)" new
tmux kill-session -t "=$SESS" 2>/dev/null
setup now-pr
PR=987412
mkdir -p "$CTL/items"; rm -f "$CTL/items"/*; : > "$CTL/items/$PR.pr"
(cd "$TMP/seed" && gq push -q origin "HEAD:refs/pull/$PR/head")
cat > "$P/bin/gh" <<SH
#!/usr/bin/env bash
FAKE_ITEM_DIR="$CTL/items" . "$TEST_DIR/lib/fake_item_labels.sh" "\$@"
case "\$*" in *title*) echo "测试标题"; exit 0 ;; esac
echo "{}"
SH
chmod +x "$P/bin/gh"
echo gone-now > "$CTL/mode"
(cd "$P/project" && tmux_sandbox_env_i HOME="$P/home" LANG=C.UTF-8 CODING_AGENT_CONFIG="$P/config" \
    timeout 120 bash "$REPO_DIR/scripts/dispatch-pr-comment.sh" "$PR" "feature/issue-$N" 0) > "$P/dispatch.out" 2>&1
chk "[PR 评论] 到达性 · 先续的是旧对话" "$(launches | head -n 1)" "resume:$OLD_ID"
has "[PR 评论] 降级日志带认出的原因" "$(plog)" "认出的原因：claude 找不到这条对话的记录）"
chk "[PR 评论] 降级后开的是新对话" "$(launches | tail -n 1 | cut -d: -f1)" new
tmux kill-session -t "=$SESS" 2>/dev/null

echo "【6】开会话日志时程序已经退出"
tmux_sandbox_env_i HOME="$P/home" CODING_AGENT_CONFIG="$P/config" REPO_DIR="$REPO_DIR" \
    bash -c 'source "$REPO_DIR/scripts/_lib.sh"; start_session_logging abc-issue-nosuch' > /dev/null 2>&1
has "日志说程序已经退出" "$(plog)" "abc-issue-nosuch 里的程序已经退出，没挂上会话日志"
lacks "不说认不出窗格" "$(plog | grep abc-issue-nosuch)" "认不出"

echo "【7】cleanup-issue.sh 删掉记录文件"
setup cleanup
resume_and_die boom
chk "到达性 · 清理前三个记录文件都在" "$(ls "$(xdir)" | grep -cE "^$SESS\.(screen|saved|session)$")" 3
(cd "$P/project" && tmux_sandbox_env_i HOME="$P/home" LANG=C.UTF-8 CODING_AGENT_CONFIG="$P/config" \
    timeout 60 bash "$REPO_DIR/scripts/cleanup-issue.sh" "$N") > /dev/null 2>&1
chk "清理后一个都不剩" "$(ls "$(xdir)" 2>/dev/null | grep -c "^$SESS")" 0

report_counts "$pass" "$fail"
echo
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" = 0 ]
