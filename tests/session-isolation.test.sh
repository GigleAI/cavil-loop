#!/usr/bin/env bash
# 跑法：bash tests/session-isolation.test.sh
# 依赖：无网络。HOME 指向临时目录，造假的 claude / codex 历史文件，跑真脚本。
#
# 验证「worker 和 review 用同一个 agent 时，review 必须另起一条模型会话」：
#   - 角色从 DISPATCH_PROMPT_KIND 推出来，而且能跨**真实子进程**传到 dispatch 侧
#     （PR #30 的教训：只在当前 shell 里比字符串的测试，换成旧实现照样全绿）
#   - review 不会续 worker 的会话，worker 也不会续 review 的会话（两个方向都要守）
#   - 上线前留下的、没登记过的会话仍然能被 worker 收养，不丢正在做的活
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; tmux kill-session -t "$TMUX_TEST_SESS" 2>/dev/null' EXIT

FAKE_HOME="$TMP/home"
WT="$TMP/wt/issue-42"
WT_OTHER="$TMP/wt/issue-99"
mkdir -p "$FAKE_HOME" "$WT" "$WT_OTHER" "$TMP/project" "$TMP/state"
TMUX_TEST_SESS="sessisotest-issue42"

cat > "$TMP/coding-agent.config" <<CONF
REPO="example/none"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="sessisotest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_REVIEW="pending/review"
WORKER_AGENT="claude"
REVIEW_WORKER_AGENT="claude"
SESSION_LOG_DIR=""
CONF

pass=0
fail=0
chk() {
    if [ "$2" = "$3" ]; then
        echo "  ✅ $1"
        pass=$((pass + 1))
    else
        echo "  ❌ $1 (期望 '$3'，实得 '$2')"
        fail=$((fail + 1))
    fi
}
chk_contains() {
    case "$2" in
        *"$3"*) echo "  ✅ $1"; pass=$((pass + 1)) ;;
        *) echo "  ❌ $1 (输出里找不到 '$3'：$2)"; fail=$((fail + 1)) ;;
    esac
}
chk_lacks() {
    case "$2" in
        *"$3"*) echo "  ❌ $1 (输出里不该出现 '$3'：$2)"; fail=$((fail + 1)) ;;
        *) echo "  ✅ $1"; pass=$((pass + 1)) ;;
    esac
}

# 每个场景都开一个**真实子进程**去 source _lib.sh —— 角色是靠环境变量跨进程传的，
# 在当前 shell 里赋值再调函数，等于绕过了要测的那条链路。
lib_eval() {   # <snippet> [VAR=VAL ...]
    local snippet="$1"; shift
    env -i PATH="$PATH" HOME="$FAKE_HOME" \
        CODING_AGENT_CONFIG="$TMP/coding-agent.config" \
        REPO_DIR="$REPO_DIR" SNIPPET="$snippet" "$@" \
        bash -c 'source "$REPO_DIR/scripts/_lib.sh" 2>/dev/null; eval "$SNIPPET"'
}

claude_dir() { lib_eval "claude_session_dir '$1'"; }
mk_claude_session() {   # <cwd> <id> <mtime>
    local d; d="$(claude_dir "$1")"
    mkdir -p "$d"
    echo '{"type":"user"}' > "$d/$2.jsonl"
    touch -d "$3" "$d/$2.jsonl"
}
mk_codex_session() {   # <cwd> <id> <date-path> <ts>
    local d="$FAKE_HOME/.codex/sessions/$3"
    mkdir -p "$d"
    printf '{"timestamp":"%s","type":"session_meta","payload":{"session_id":"%s","cwd":"%s"}}\n' \
        "$4" "$2" "$1" > "$d/rollout-$4-$2.jsonl"
}
registry() { cat "$TMP/state/agent-sessions/$1" 2>/dev/null; }

W_ID="11111111-1111-4111-8111-111111111111"
R_ID="22222222-2222-4222-8222-222222222222"
LEGACY_ID="33333333-3333-4333-8333-333333333333"

echo "── 0. claude 历史目录的编码规则（拿真实观测值钉死）──"
# 2026-09-18 claude 2.1.276 实测值。只换 '/' 是不够的：带 '.' '_' 空格的 worktree
# 路径会算出一个不存在的目录，于是「有没有历史」永远答否 → 每次派工都新起会话，
# 上下文静默丢光（这条不会报错，只会安静地退化）。
chk "路径里的点也要变成连字符" \
    "$(lib_eval "claude_encoded_cwd /tmp/tmp.dkIFgXhOk6/wt/issue-7")" \
    "-tmp-tmp-dkIFgXhOk6-wt-issue-7"
chk "下划线 / 空格同样处理" \
    "$(lib_eval "claude_encoded_cwd '/a/enc.test_dir.v1/sub dir'")" \
    "-a-enc-test-dir-v1-sub-dir"
chk "原本就有的连字符保持不变" \
    "$(lib_eval "claude_encoded_cwd /home/sky/github/worktree/workloop/issue-32")" \
    "-home-sky-github-worktree-workloop-issue-32"

echo "── 1. 角色推导（跨进程，从 DISPATCH_PROMPT_KIND 推）──"
chk "没指定模板类型 = 普通 worker" \
    "$(lib_eval 'echo "$WORKER_SESSION_ROLE"')" "worker"
chk "review 模板 = review 角色" \
    "$(lib_eval 'echo "$WORKER_SESSION_ROLE"' DISPATCH_PROMPT_KIND=review)" "review"
chk "pr-comment 模板仍是 worker" \
    "$(lib_eval 'echo "$WORKER_SESSION_ROLE"' DISPATCH_PROMPT_KIND=pr-comment)" "worker"

echo "── 2. claude：全新会话会钉 id 并登记 ──"
out="$(lib_eval "agent_session_plan 42 '$WT'; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND|id=\$WORKER_SESSION_ID\"")"
chk_contains "首次派工起全新会话" "$out" "kind=new"
chk_contains "全新会话带 --session-id" "$out" "--session-id"
NEW_ID="$(registry 42.claude.worker)"
chk "worker 角色的 id 已登记" "$([ -n "$NEW_ID" ] && echo yes)" "yes"
chk_contains "登记的 id 就是命令里钉的那个" "$out" "$NEW_ID"

echo "── 3. claude：同角色再派工续同一条 ──"
mk_claude_session "$WT" "$NEW_ID" "2026-09-18 10:00:00"
out="$(lib_eval "agent_session_plan 42 '$WT'; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"")"
chk_contains "第二次是 resume" "$out" "kind=resume"
chk_contains "resume 的是自己登记的那条" "$out" "--resume $NEW_ID"

echo "── 4. 核心：review 不许续 worker 的会话 ──"
rm -rf "$TMP/state/agent-sessions" "$(claude_dir "$WT")"
mk_claude_session "$WT" "$W_ID" "2026-09-18 10:00:00"
lib_eval "agent_session_id_set 42 claude worker '$W_ID'" >/dev/null
out="$(lib_eval "agent_session_plan 42 '$WT'; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"" DISPATCH_PROMPT_KIND=review)"
chk_contains "review 首轮起全新会话" "$out" "kind=new"
chk_lacks "review 的命令里没有 worker 那条会话" "$out" "$W_ID"
chk_lacks "review 不会用 --continue（那会续到 worker 那条）" "$out" "--continue"
REVIEW_ID="$(registry 42.claude.review)"
chk "review 角色单独登记了一条" "$([ -n "$REVIEW_ID" ] && [ "$REVIEW_ID" != "$W_ID" ] && echo yes)" "yes"

echo "── 5. review 跨轮复用自己那条（Q3 拍板 A）──"
mk_claude_session "$WT" "$REVIEW_ID" "2026-09-18 11:00:00"
out="$(lib_eval "agent_session_plan 42 '$WT'; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"" DISPATCH_PROMPT_KIND=review)"
chk_contains "review 第 2 轮是 resume" "$out" "kind=resume"
chk_contains "续的是 review 自己那条" "$out" "--resume $REVIEW_ID"

echo "── 6. 反方向：worker 不许续 review 的会话 ──"
# review 那条现在是这个目录里**最新**的一条，老实现的 --continue 正好会续到它
out="$(lib_eval "agent_session_plan 42 '$WT'; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"")"
chk_contains "worker 续的是自己那条" "$out" "--resume $W_ID"
chk_lacks "worker 没碰 review 那条" "$out" "$REVIEW_ID"
chk_lacks "worker 没回落到 --continue" "$out" "--continue"

echo "── 7. 目录里只剩 review 那条时，worker 必须起全新 ──"
rm -rf "$TMP/state/agent-sessions" "$(claude_dir "$WT")"
mk_claude_session "$WT" "$R_ID" "2026-09-18 12:00:00"
lib_eval "agent_session_id_set 42 claude review '$R_ID'" >/dev/null
out="$(lib_eval "agent_session_plan 42 '$WT'; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"")"
chk_contains "worker 起全新会话" "$out" "kind=new"
chk_lacks "worker 没收养 review 那条" "$out" "--resume $R_ID"

echo "── 8. 向后兼容：上线前没登记过的会话仍被 worker 收养 ──"
rm -rf "$TMP/state/agent-sessions" "$(claude_dir "$WT")"
mk_claude_session "$WT" "$LEGACY_ID" "2026-09-18 09:00:00"
out="$(lib_eval "agent_session_plan 42 '$WT'; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"")"
chk_contains "收养旧会话" "$out" "kind=adopt"
chk_contains "续的就是那条旧会话" "$out" "--resume $LEGACY_ID"
chk "收养后补登记" "$(registry 42.claude.worker)" "$LEGACY_ID"

echo "── 9. 登记的会话已经不在了 → 起全新，不报错 ──"
rm -rf "$TMP/state/agent-sessions" "$(claude_dir "$WT")"
lib_eval "agent_session_id_set 42 claude review 'deadbeef-dead-4ead-8ead-deadbeefdead'" >/dev/null
out="$(lib_eval "agent_session_plan 42 '$WT'; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"" DISPATCH_PROMPT_KIND=review)"
chk_contains "会话没了就起全新" "$out" "kind=new"
chk_lacks "不会去 resume 一条不存在的会话" "$out" "--resume deadbeef"

echo "── 10. tmux：角色不同就不复用现有 session（挡住 prompt 注入那条路）──"
if command -v tmux > /dev/null 2>&1; then
    tmux kill-session -t "$TMUX_TEST_SESS" 2>/dev/null
    tmux new-session -d -s "$TMUX_TEST_SESS" "sleep 120" 2>/dev/null
    tmux set-option -t "$TMUX_TEST_SESS" @worker_agent claude 2>/dev/null
    tmux set-option -t "$TMUX_TEST_SESS" @worker_model "" 2>/dev/null
    tmux set-option -t "$TMUX_TEST_SESS" @worker_role worker 2>/dev/null
    chk "worker session + worker 派工 → 复用" \
        "$(lib_eval "tmux_session_matches_worker '$TMUX_TEST_SESS' && echo reuse || echo restart")" "reuse"
    chk "worker session + review 派工 → 重启换角色" \
        "$(lib_eval "tmux_session_matches_worker '$TMUX_TEST_SESS' && echo reuse || echo restart" DISPATCH_PROMPT_KIND=review)" "restart"
    tmux set-option -u -t "$TMUX_TEST_SESS" @worker_role 2>/dev/null
    chk "上线前的老 session（没记角色）当 worker，不无故重启" \
        "$(lib_eval "tmux_session_matches_worker '$TMUX_TEST_SESS' && echo reuse || echo restart")" "reuse"
    tmux kill-session -t "$TMUX_TEST_SESS" 2>/dev/null
else
    echo "  ⏭️  本机没有 tmux，跳过 tmux 角色比对（3 项）"
fi

echo "── 11. codex driver：会话按 cwd 归属，按 id 续 ──"
sed -i 's/^WORKER_AGENT="claude"$/WORKER_AGENT="codex"/' "$TMP/coding-agent.config"
rm -rf "$TMP/state/agent-sessions"
CW_ID="44444444-4444-4444-8444-444444444444"
CR_ID="55555555-5555-4555-8555-555555555555"
CO_ID="66666666-6666-4666-8666-666666666666"
mk_codex_session "$WT"       "$CW_ID" "2026/09/18" "2026-09-18T09-00-00"
mk_codex_session "$WT"       "$CR_ID" "2026/09/18" "2026-09-18T11-00-00"
mk_codex_session "$WT_OTHER" "$CO_ID" "2026/09/18" "2026-09-18T12-00-00"
chk "只列本 cwd 的会话，最新在前" \
    "$(lib_eval "agent_session_list '$WT' | tr '\n' ' '")" "$CR_ID $CW_ID "
chk "别的 worktree 的会话不混进来" \
    "$(lib_eval "agent_session_list '$WT' | grep -c '$CO_ID'")" "0"
chk "按 id 能确认会话还在" \
    "$(lib_eval "agent_session_exists '$WT' '$CW_ID' && echo yes || echo no")" "yes"
chk "codex 启动侧钉不了 id" "$(lib_eval "agent_session_new_id '$WT' n worker")" ""

lib_eval "agent_session_id_set 42 codex review '$CR_ID'" >/dev/null
out="$(lib_eval "agent_session_plan 42 '$WT'; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"" DISPATCH_PROMPT_KIND=review)"
chk_contains "codex review 续自己那条" "$out" "codex resume $CR_ID"
chk_lacks "codex review 不用 --last（那会按时间猜，分不清角色）" "$out" "resume --last"

out="$(lib_eval "agent_session_plan 42 '$WT'; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"")"
chk_contains "codex worker 收养的是非 review 的那条" "$out" "codex resume $CW_ID"
chk_lacks "codex worker 没收养 review 那条" "$out" "$CR_ID"

echo "── 12. codex：全新会话启动后回捞 id 登记 ──"
rm -rf "$TMP/state/agent-sessions" "$FAKE_HOME/.codex"
out="$(lib_eval "agent_session_plan 42 '$WT'; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND|pre=[\$AGENT_SESSION_PRELAUNCH_IDS]\"")"
chk_contains "没历史时起全新" "$out" "kind=new"
chk_lacks "全新时不带 resume" "$out" "resume"
# 模拟 codex 起来后落盘，再跑回捞
CAP_ID="77777777-7777-4777-8777-777777777777"
mk_codex_session "$WT" "$CAP_ID" "2026/09/18" "2026-09-18T13-00-00"
chk "回捞到新会话并登记" \
    "$(lib_eval "AGENT_LAUNCH_KIND=new WORKER_SESSION_ID='' AGENT_SESSION_PRELAUNCH_IDS=''; \
        agent_session_register_launched 42 '$WT'; agent_session_id_get 42 codex worker")" "$CAP_ID"

echo "── 13. 不支持会话隔离的第三方 driver：review 仍然起全新 ──"
mkdir -p "$TMP/project/.agents/skills/coding-agent-work-loop/drivers"
cat > "$TMP/project/.agents/skills/coding-agent-work-loop/drivers/mini.sh" <<'MINI'
agent_bin() { echo "mini"; }
agent_has_history() { [ -f "$1/.mini-history" ]; }
agent_is_busy() { return 1; }
agent_command_new() { echo "mini-new $3"; }
agent_command_resume() { echo "mini-resume $3"; }
MINI
sed -i 's/^WORKER_AGENT="codex"$/WORKER_AGENT="mini"/' "$TMP/coding-agent.config"
rm -rf "$TMP/state/agent-sessions"
touch "$WT/.mini-history"
out="$(lib_eval "agent_session_plan 42 '$WT'; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"" DISPATCH_PROMPT_KIND=review)"
chk_contains "没实现隔离的 driver，review 也一律起全新" "$out" "kind=new"
chk_contains "review 用的是 new 命令" "$out" "mini-new"
out="$(lib_eval "agent_session_plan 42 '$WT'; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"")"
chk_contains "worker 保持上线前的续接行为" "$out" "kind=legacy-resume"
chk_contains "worker 用的是 driver 自己的 resume 命令" "$out" "mini-resume"

echo "── 14. 决策必须活过命令替换（dispatch 就是这么调的）──"
sed -i 's/^WORKER_AGENT="mini"$/WORKER_AGENT="claude"/' "$TMP/coding-agent.config"
rm -rf "$TMP/state/agent-sessions"
# 真实 dispatch 是 `agent_session_plan ...` 之后再 `CMD="$(agent_launch_command ...)"`。
# 两步合成一步写进 $( ) 的话，plan 设的全局留在子 shell 里，dispatch 在 set -u 下
# 会直接 unbound variable 崩掉——这个 bug 真出现过，而且只在跨 $( ) 边界时才暴露，
# 所以这条用例必须照抄 dispatch 的调用形状，不能图省事在同一层里调。
out="$(lib_eval "set -u
agent_session_plan 42 '$WT'
CMD=\"\$(agent_launch_command '$WT' name /tmp/p.md)\"
echo \"|kind=\$AGENT_LAUNCH_KIND|id=\$WORKER_SESSION_ID|cmd=\$CMD\"")"
chk_contains "plan 设的 kind 在命令替换之后还在" "$out" "kind="
chk_lacks "kind 不是空的" "$out" "|kind=|"
chk_contains "命令照样产出来了" "$out" "cmd=claude"

echo "── 15. 三个 dispatch 脚本都必须走统一的角色解析入口 ──"
# 这条是结构性护栏：只要有人在某个 dispatch 分支里直接调 agent_command_new/resume，
# 那条路径就绕开了角色隔离——而它未必有对应的行为用例（历史上正是「三份各写一份」）。
chk "没有 dispatch 脚本直接调 agent_command_new/resume" \
    "$(grep -c 'agent_command_\(new\|resume\)' "$REPO_DIR"/scripts/dispatch-*.sh | awk -F: '{s+=$2} END {print s+0}')" "0"
chk "三个 dispatch 脚本都调了 agent_launch_command" \
    "$(grep -lc 'agent_launch_command' "$REPO_DIR"/scripts/dispatch-*.sh | wc -l)" "3"
chk "起完全新会话后都会回捞登记" \
    "$(grep -lc 'agent_session_register_launched' "$REPO_DIR"/scripts/dispatch-*.sh | wc -l)" "3"
chk "没有 dispatch 脚本把 plan 塞进命令替换里" \
    "$(grep -c '\$(agent_session_plan' "$REPO_DIR"/scripts/dispatch-*.sh | awk -F: '{s+=$2} END {print s+0}')" "0"
chk "三个 dispatch 脚本都在当前 shell 调 plan" \
    "$(grep -lc '^ *agent_session_plan ' "$REPO_DIR"/scripts/dispatch-*.sh | wc -l)" "3"

echo "── 16. set -euo pipefail 下不许把派工搞崩 ──"
# dispatch 脚本全都是 set -euo pipefail。「这个目录没有可收养的会话」是全新 worktree
# 每次都会走的正常分支，如果那条路径上有函数返回非 0，赋值语句会当场终止整条派工
# ——而且只在这一种最常见的情况下才发作。
EMPTY_WT="$TMP/wt/issue-77"
mkdir -p "$EMPTY_WT"
rm -rf "$TMP/state/agent-sessions"
chk "claude + 空目录：plan 不中断" \
    "$(lib_eval "set -euo pipefail
agent_session_plan 77 '$EMPTY_WT'
echo ok:\$AGENT_LAUNCH_KIND")" "ok:new"
sed -i 's/^WORKER_AGENT="claude"$/WORKER_AGENT="mini"/' "$TMP/coding-agent.config"
chk "不支持隔离的 driver + 无历史：plan 不中断" \
    "$(lib_eval "set -euo pipefail
agent_session_plan 77 '$EMPTY_WT'
echo ok:\$AGENT_LAUNCH_KIND")" "ok:new"
sed -i 's/^WORKER_AGENT="mini"$/WORKER_AGENT="codex"/' "$TMP/coding-agent.config"
# 造 800 个别的 cwd 的会话：不光要超过扫描上限（默认 200），还得让 sort 的输出
# 撑爆 64KB 管道缓冲区——不然 sort 一口气写完就退出了，根本轮不到 SIGPIPE。
# 这才是真正触发点：head 到量就关管道 → find/sort 吃 SIGPIPE → pipefail 把 141
# 冒给调用方的赋值语句 → set -e 直接终止派工。只放几个文件是测不出来的，
# 而真实机器上「codex 历史上千条」是常态（本机实测 1031 条）。
for i in $(seq 1 800); do
    mk_codex_session "$TMP/wt/other-$i" "$(printf '%08d-0000-4000-8000-000000000000' "$i")" \
        "2026/09/17" "$(printf '2026-09-17T%02d-%02d-00' $((i / 60)) $((i % 60)))"
done
chk "codex + 大量历史：plan 不中断（枚举管道会吃 SIGPIPE）" \
    "$(lib_eval "set -euo pipefail
agent_session_plan 77 '$EMPTY_WT'
echo ok:\$AGENT_LAUNCH_KIND")" "ok:new"

echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
