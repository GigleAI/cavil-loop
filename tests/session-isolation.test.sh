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
# 续接 claude 时 driver 会起一个 `claude -p` 探测当前默认模型（#56）。测试不调真 CLI：
# 放一个只吐 init 行的假 claude 在 PATH 最前面。
mkdir -p "$TMP/bin"
printf '%s\n' '#!/usr/bin/env bash' \
    'echo '"'"'{"type":"system","subtype":"init","model":"fake-default"}'"'" > "$TMP/bin/claude"
chmod +x "$TMP/bin/claude"
export PATH="$TMP/bin:$PATH"
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
mk_codex_session() {   # <cwd> <id> <date-path> <ts> [启动时用的 prompt 原文]
    local d="$FAKE_HOME/.codex/sessions/$3"
    local f="$d/rollout-$4-$2.jsonl"
    mkdir -p "$d"
    printf '{"timestamp":"%s","type":"session_meta","payload":{"session_id":"%s","cwd":"%s"}}\n' \
        "$4" "$2" "$1" > "$f"
    # 第 5 个参数 = 这条会话启动时收到的 prompt。回捞要靠它举证「这条是本次启动建的」，
    # 所以凡是要走回捞的场景都必须给，不给就等于一条「举证不出来」的会话。
    if [ -n "${5:-}" ]; then
        printf '%s\n' "$5" | python3 -c '
import json,sys
txt=sys.stdin.read()
if txt.endswith("\n"): txt=txt[:-1]
print(json.dumps({"type":"response_item","payload":{"type":"message","role":"user",
      "content":[{"type":"input_text","text":txt}]}}, ensure_ascii=False))
' >> "$f"
    fi
}
# 照真实 rollout 的形状造会话：session_meta → developer×2 → user(仓库指令)
# → user(任务 prompt) → assistant → [user(后续追加的消息)]
# 0.161.0 的真实事件顺序就是这样——「第一条 user 消息」是仓库指令，不是任务。
mk_codex_session_real() {   # <cwd> <id> <date-path> <ts> <前置消息> <任务消息> [assistant 之后的消息]
    local d="$FAKE_HOME/.codex/sessions/$3"
    local f="$d/rollout-$4-$2.jsonl"
    mkdir -p "$d"
    CWD="$1" SID="$2" TS="$4" PRE="$5" TASK="$6" POST="${7:-}" python3 - > "$f" <<'INNER'
import json, os
def msg(role, text, ctype="input_text"):
    return {"type": "response_item",
            "payload": {"type": "message", "role": role,
                        "content": [{"type": ctype, "text": text}]}}
out = [{"timestamp": os.environ["TS"], "type": "session_meta",
        "payload": {"session_id": os.environ["SID"], "cwd": os.environ["CWD"]}},
       {"type": "event_msg", "payload": {"type": "task_started"}},
       msg("developer", "<skills_instructions>…</skills_instructions>"),
       msg("developer", "<multi_agent_role>…</multi_agent_role>"),
       msg("user", os.environ["PRE"]),
       msg("user", os.environ["TASK"]),
       msg("assistant", "好，我开始。", "output_text")]
if os.environ.get("POST"):
    out.append(msg("user", os.environ["POST"]))
for o in out:
    # 紧凑形式，跟真实 codex 写出来的一样（无空格）
    print(json.dumps(o, ensure_ascii=False, separators=(",", ":")))
INNER
}

# 造一份 prompt 文件，并把它的内容回显出来（给 mk_codex_session 当第 5 个参数）
mk_prompt() {   # <路径> <正文>
    printf '%s\n' "$2" > "$1"
    printf '%s' "$2"
}
registry() { cat "$TMP/state/agent-sessions/$1" 2>/dev/null; }

# plan 现在要收一个 prompt 文件（钉不了 id 的 driver 要往里打启动标记）
PLAN_PROMPT="$TMP/plan-prompt.md"
printf 'plan 用的占位 prompt\n' > $PLAN_PROMPT

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
out="$(lib_eval "agent_session_plan 42 '$WT' $PLAN_PROMPT; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND|id=\$WORKER_SESSION_ID\"")"
chk_contains "首次派工起全新会话" "$out" "kind=new"
chk_contains "全新会话带 --session-id" "$out" "--session-id"
NEW_ID="$(registry 42.claude.worker)"
chk "worker 角色的 id 已登记" "$([ -n "$NEW_ID" ] && echo yes)" "yes"
chk_contains "登记的 id 就是命令里钉的那个" "$out" "$NEW_ID"

echo "── 3. claude：同角色再派工续同一条 ──"
mk_claude_session "$WT" "$NEW_ID" "2026-09-18 10:00:00"
out="$(lib_eval "agent_session_plan 42 '$WT' $PLAN_PROMPT; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"")"
chk_contains "第二次是 resume" "$out" "kind=resume"
chk_contains "resume 的是自己登记的那条" "$out" "--resume $NEW_ID"

echo "── 4. 核心：review 不许续 worker 的会话 ──"
rm -rf "$TMP/state/agent-sessions" "$(claude_dir "$WT")"
mk_claude_session "$WT" "$W_ID" "2026-09-18 10:00:00"
lib_eval "agent_session_id_set 42 claude worker '$W_ID'" >/dev/null
out="$(lib_eval "agent_session_plan 42 '$WT' $PLAN_PROMPT; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"" DISPATCH_PROMPT_KIND=review)"
chk_contains "review 首轮起全新会话" "$out" "kind=new"
chk_lacks "review 的命令里没有 worker 那条会话" "$out" "$W_ID"
chk_lacks "review 不会用 --continue（那会续到 worker 那条）" "$out" "--continue"
REVIEW_ID="$(registry 42.claude.review)"
chk "review 角色单独登记了一条" "$([ -n "$REVIEW_ID" ] && [ "$REVIEW_ID" != "$W_ID" ] && echo yes)" "yes"

echo "── 5. review 跨轮复用自己那条（Q3 拍板 A）──"
mk_claude_session "$WT" "$REVIEW_ID" "2026-09-18 11:00:00"
out="$(lib_eval "agent_session_plan 42 '$WT' $PLAN_PROMPT; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"" DISPATCH_PROMPT_KIND=review)"
chk_contains "review 第 2 轮是 resume" "$out" "kind=resume"
chk_contains "续的是 review 自己那条" "$out" "--resume $REVIEW_ID"

echo "── 6. 反方向：worker 不许续 review 的会话 ──"
# review 那条现在是这个目录里**最新**的一条，老实现的 --continue 正好会续到它
out="$(lib_eval "agent_session_plan 42 '$WT' $PLAN_PROMPT; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"")"
chk_contains "worker 续的是自己那条" "$out" "--resume $W_ID"
chk_lacks "worker 没碰 review 那条" "$out" "$REVIEW_ID"
chk_lacks "worker 没回落到 --continue" "$out" "--continue"

echo "── 7. 目录里只剩 review 那条时，worker 必须起全新 ──"
rm -rf "$TMP/state/agent-sessions" "$(claude_dir "$WT")"
mk_claude_session "$WT" "$R_ID" "2026-09-18 12:00:00"
lib_eval "agent_session_id_set 42 claude review '$R_ID'" >/dev/null
out="$(lib_eval "agent_session_plan 42 '$WT' $PLAN_PROMPT; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"")"
chk_contains "worker 起全新会话" "$out" "kind=new"
chk_lacks "worker 没收养 review 那条" "$out" "--resume $R_ID"

echo "── 8. 向后兼容：上线前没登记过的会话仍被 worker 收养 ──"
rm -rf "$TMP/state/agent-sessions" "$(claude_dir "$WT")"
mk_claude_session "$WT" "$LEGACY_ID" "2026-09-18 09:00:00"
out="$(lib_eval "agent_session_plan 42 '$WT' $PLAN_PROMPT; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"")"
chk_contains "收养旧会话" "$out" "kind=adopt"
chk_contains "续的就是那条旧会话" "$out" "--resume $LEGACY_ID"
chk "收养后补登记" "$(registry 42.claude.worker)" "$LEGACY_ID"

echo "── 9. 登记的会话已经不在了 → 起全新，不报错 ──"
rm -rf "$TMP/state/agent-sessions" "$(claude_dir "$WT")"
lib_eval "agent_session_id_set 42 claude review 'deadbeef-dead-4ead-8ead-deadbeefdead'" >/dev/null
out="$(lib_eval "agent_session_plan 42 '$WT' $PLAN_PROMPT; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"" DISPATCH_PROMPT_KIND=review)"
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
out="$(lib_eval "agent_session_plan 42 '$WT' $PLAN_PROMPT; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"" DISPATCH_PROMPT_KIND=review)"
chk_contains "codex review 续自己那条" "$out" "codex resume $CR_ID"
chk_lacks "codex review 不用 --last（那会按时间猜，分不清角色）" "$out" "resume --last"

out="$(lib_eval "agent_session_plan 42 '$WT' $PLAN_PROMPT; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"")"
chk_contains "codex worker 收养的是非 review 的那条" "$out" "codex resume $CW_ID"
chk_lacks "codex worker 没收养 review 那条" "$out" "$CR_ID"

echo "── 12. codex：全新会话启动后回捞 id 登记 ──"
rm -rf "$TMP/state/agent-sessions" "$FAKE_HOME/.codex"
out="$(lib_eval "agent_session_plan 42 '$WT' $PLAN_PROMPT; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND|pre=[\$AGENT_SESSION_PRELAUNCH_IDS]\"")"
chk_contains "没历史时起全新" "$out" "kind=new"
chk_lacks "全新时不带 resume" "$out" "resume"
# 模拟 codex 起来后落盘，再跑回捞。会话里要留下「用这份 prompt 起的」证据——
# 回捞现在要凭证据认领，不再认「本次新出现的文件」。
CAP_ID="77777777-7777-4777-8777-777777777777"
CAP_PROMPT_FILE="$TMP/cap-prompt.md"
CAP_TXT="$(mk_prompt "$CAP_PROMPT_FILE" "worker 第一轮：请实现 issue #42")"
mk_codex_session "$WT" "$CAP_ID" "2026/09/18" "2026-09-18T13-00-00" "$CAP_TXT"
chk "回捞到新会话并登记" \
    "$(lib_eval "AGENT_LAUNCH_KIND=new WORKER_SESSION_ID='' AGENT_SESSION_PRELAUNCH_IDS=''; \
        agent_session_register_launched 42 '$WT' '$CAP_PROMPT_FILE'; agent_session_id_get 42 codex worker")" "$CAP_ID"
chk "举证函数认得出这条是本次启动建的" \
    "$(lib_eval "agent_session_started_with '$WT' '$CAP_ID' '$CAP_PROMPT_FILE' && echo yes || echo no")" "yes"
chk "换一份 prompt 就举证不出来" \
    "$(lib_eval "agent_session_started_with '$WT' '$CAP_ID' '$TMP/coding-agent.config' && echo yes || echo no")" "no"

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
out="$(lib_eval "agent_session_plan 42 '$WT' $PLAN_PROMPT; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"" DISPATCH_PROMPT_KIND=review)"
chk_contains "没实现隔离的 driver，review 也一律起全新" "$out" "kind=new"
chk_contains "review 用的是 new 命令" "$out" "mini-new"
out="$(lib_eval "agent_session_plan 42 '$WT' $PLAN_PROMPT; agent_launch_command '$WT' name /tmp/p.md; echo \"|kind=\$AGENT_LAUNCH_KIND\"")"
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
agent_session_plan 42 '$WT' $PLAN_PROMPT
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
agent_session_plan 77 '$EMPTY_WT' $PLAN_PROMPT
echo ok:\$AGENT_LAUNCH_KIND")" "ok:new"
sed -i 's/^WORKER_AGENT="claude"$/WORKER_AGENT="mini"/' "$TMP/coding-agent.config"
chk "不支持隔离的 driver + 无历史：plan 不中断" \
    "$(lib_eval "set -euo pipefail
agent_session_plan 77 '$EMPTY_WT' $PLAN_PROMPT
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
agent_session_plan 77 '$EMPTY_WT' $PLAN_PROMPT
echo ok:\$AGENT_LAUNCH_KIND")" "ok:new"

echo "── 17. 强制起新会话之后，worker 不许收养那条旧 review 对话 ──"
# 复审第 1、2 轮的阻塞项。触发链：review 登记 R1 → resume 秒退 → dispatch 走
# force_new 兜底 → 旧实现把 R1 的登记删掉 → worker 没有自己的有效登记时走收养，
# 「最新的、没登记的」正好是 R1。
sed -i 's/^WORKER_AGENT="codex"$/WORKER_AGENT="claude"/' "$TMP/coding-agent.config"
F_WT="$TMP/wt/issue-55"; mkdir -p "$F_WT"
rm -rf "$TMP/state/agent-sessions"
F_W=aaaaaaaa-5555-4555-8555-555555555555
F_R1=bbbbbbbb-5555-4555-8555-555555555555
mk_claude_session "$F_WT" "$F_W"  "2026-09-18 08:00:00"
mk_claude_session "$F_WT" "$F_R1" "2026-09-18 09:00:00"
# 先让本功能「接管」这条活（拍下上线前快照），再登记 R1 为 review。
# 注意这里 R1 **在**白名单里（两条文件都先于快照存在）——所以这一节考的纯粹是
# 退休名单：白名单在这个场景下帮不上忙。
lib_eval "agent_session_preexisting_snapshot 55 '$F_WT'; agent_session_id_set 55 claude review '$F_R1'" >/dev/null
# review 侧走兜底：强制起新会话
out="$(lib_eval "agent_session_plan 55 '$F_WT' $PLAN_PROMPT 1; echo id=\$WORKER_SESSION_ID" DISPATCH_PROMPT_KIND=review)"
F_R2="$(registry 55.claude.review)"
mk_claude_session "$F_WT" "$F_R2" "2026-09-18 10:00:00"
chk "强制起新后 review 换成了另一条" "$([ -n "$F_R2" ] && [ "$F_R2" != "$F_R1" ] && echo yes)" "yes"
chk "旧的 review id 进了退休名单" \
    "$(grep -Fxc "$F_R1" "$TMP/state/agent-sessions/55.claude.review.retired" 2>/dev/null)" "1"
# worker 自己那条故意不登记（升级窗口内的老会话就是这样）
out="$(lib_eval "agent_session_plan 55 '$F_WT' $PLAN_PROMPT; echo kind=\$AGENT_LAUNCH_KIND id=\$WORKER_SESSION_ID")"
chk_contains "worker 收养的是自己那条" "$out" "id=$F_W"
chk_lacks "worker 没收养退休掉的 review 对话" "$out" "$F_R1"
chk_lacks "worker 也没碰新的 review 对话" "$out" "$F_R2"

echo "── 18. 回捞超时 → review 晚落盘 → worker 仍不许收养它 ──"
# 复审第 2 轮的第 2 条。codex 启动侧钉不了 id，靠启动后回捞；回捞窗口内没等到，
# 那条 review 会话就「存在但从未登记」——反向判据下它天然符合收养条件。
sed -i 's/^WORKER_AGENT="claude"$/WORKER_AGENT="codex"/' "$TMP/coding-agent.config"
C_WT="$TMP/wt/issue-66"; mkdir -p "$C_WT"
rm -rf "$TMP/state/agent-sessions" "$FAKE_HOME/.codex"
C_W=aaaaaaaa-6666-4666-8666-666666666666
C_R=bbbbbbbb-6666-4666-8666-666666666666
mk_codex_session "$C_WT" "$C_W" "2026/09/18" "2026-09-18T08-00-00"
# review 派工：plan（拍快照）→ 回捞窗口设 0 立刻超时
out="$(lib_eval "agent_session_plan 66 '$C_WT' $PLAN_PROMPT >/dev/null
agent_session_register_launched 66 '$C_WT' 2>/dev/null
echo registered=[\$(agent_session_id_get 66 codex review)]" DISPATCH_PROMPT_KIND=review)"
chk_contains "回捞超时后 review 没有登记" "$out" "registered=[]"
chk "超时留下了可追查的记录" \
    "$(grep -c 'unresolved-launch' "$TMP/state/agent-sessions/66.codex.unresolved" 2>/dev/null)" "1"
# 窗口之后那条 review 才落盘
mk_codex_session "$C_WT" "$C_R" "2026/09/18" "2026-09-18T11-00-00"
out="$(lib_eval "agent_session_plan 66 '$C_WT' $PLAN_PROMPT; echo kind=\$AGENT_LAUNCH_KIND id=\$WORKER_SESSION_ID")"
chk_contains "worker 收养的是自己那条" "$out" "id=$C_W"
chk_lacks "worker 没收养那条无主的 review 会话" "$out" "$C_R"

echo "── 19. 白名单不能把向后兼容堵死 ──"
# 正向判据如果实现错（比如把 .preexisting 也当成排除集读），症状是「谁都收养不了」，
# 每次派工都新起会话、静默丢上下文。这两条就是守这个的。
sed -i 's/^WORKER_AGENT="codex"$/WORKER_AGENT="claude"/' "$TMP/coding-agent.config"
L_WT="$TMP/wt/issue-77"; mkdir -p "$L_WT"
rm -rf "$TMP/state/agent-sessions"
L_W=aaaaaaaa-7777-4777-8777-777777777777
mk_claude_session "$L_WT" "$L_W" "2026-09-18 08:00:00"
out="$(lib_eval "agent_session_plan 77 '$L_WT' $PLAN_PROMPT; echo kind=\$AGENT_LAUNCH_KIND id=\$WORKER_SESSION_ID")"
chk_contains "上线前的 worker 会话仍然能收养" "$out" "kind=adopt"
chk_contains "收养的就是那条" "$out" "id=$L_W"
chk "白名单文件确实拍到了它" \
    "$(grep -Fxc "$L_W" "$TMP/state/agent-sessions/77.claude.preexisting" 2>/dev/null)" "1"
# 单独用一个没有任何登记的编号来问：白名单文件的内容绝不能被当成排除集读进来
lib_eval "agent_session_preexisting_snapshot 79 '$L_WT'" >/dev/null
chk "白名单文件不会被当成排除集" \
    "$(lib_eval "agent_session_ids_blocked 79 | grep -Fxc '$L_W'")" "0"
chk "（对照）同一个 id 在白名单里" \
    "$(grep -Fxc "$L_W" "$TMP/state/agent-sessions/79.claude.preexisting" 2>/dev/null)" "1"

echo "── 20. 同一次派工的兜底不许把刚起的会话写进白名单 ──"
# plan 在一次派工里会被调两次（正常 + 秒退兜底）。第二次若重新拍快照，就会把本次
# 刚起的那条写进「上线前就存在」里，等于自己给自己开后门。
rm -rf "$TMP/state/agent-sessions"
mk_claude_session "$L_WT" "$L_W" "2026-09-18 08:00:00"
NEW_ONE=cccccccc-7777-4777-8777-777777777777
lib_eval "agent_session_plan 77 '$L_WT' $PLAN_PROMPT >/dev/null" DISPATCH_PROMPT_KIND=review >/dev/null
mk_claude_session "$L_WT" "$NEW_ONE" "2026-09-18 12:00:00"   # 本次派工起的会话落盘
lib_eval "agent_session_plan 77 '$L_WT' $PLAN_PROMPT 1 >/dev/null" DISPATCH_PROMPT_KIND=review >/dev/null
chk "白名单里只有上线前那条" \
    "$(tr -d '[:space:]' < "$TMP/state/agent-sessions/77.claude.preexisting")" "$L_W"

echo "── 21. 退休名单只增不删（多次强制起新都要留痕）──"
rm -rf "$TMP/state/agent-sessions"
R_A=dddddddd-8888-4888-8888-888888888881
R_B=dddddddd-8888-4888-8888-888888888882
lib_eval "agent_session_plan 88 '$L_WT' $PLAN_PROMPT >/dev/null
agent_session_id_set 88 claude review '$R_A'" >/dev/null
lib_eval "agent_session_retire 88 claude review; agent_session_id_set 88 claude review '$R_B'" >/dev/null
lib_eval "agent_session_retire 88 claude review" >/dev/null
chk "两次退休都在名单里" \
    "$(sort "$TMP/state/agent-sessions/88.claude.review.retired" | tr '\n' ' ')" "$R_A $R_B "
chk "退休的 id 都算「已知归属」" \
    "$(lib_eval "agent_session_ids_blocked 88 | grep -Fxc '$R_A'")" "1"

echo "── 22. cleanup 清当前登记，但不清角色归属 ──"
# worktree 可能在同一路径上重建，而 agent 的历史是按 cwd 存的——旧对话还在原地。
# 把角色归属一并清掉，那些旧 review 对话就重新变成「谁都能收养」。
lib_eval "agent_session_id_set 88 claude worker 'eeeeeeee-8888-4888-8888-888888888888'
agent_session_forget_all 88" >/dev/null
chk "当前登记已清" "$(ls "$TMP/state/agent-sessions"/88.claude.worker 2>/dev/null | wc -l)" "0"
chk "退休名单保留" "$(ls "$TMP/state/agent-sessions"/88.claude.review.retired 2>/dev/null | wc -l)" "1"
chk "白名单保留" "$(ls "$TMP/state/agent-sessions"/88.claude.preexisting 2>/dev/null | wc -l)" "1"

echo "── 23. codex 的每条启动命令都要带 --no-daemon ──"
# main 上 a1df47d 修过：新版 codex 的 TUI 默认连全机共享 daemon，工具 shell 会拿到
# daemon 的环境而不是 worker 的（GH_TOKEN 丢失 → gh 用错账号）。按 id resume 这条
# 新路径是合并时新加的，当时漏了这个 flag，所以这里逐条断言。
sed -i 's/^WORKER_AGENT="claude"$/WORKER_AGENT="codex"/' "$TMP/coding-agent.config"
if codex --help 2>/dev/null | grep -q -- '--no-daemon'; then
    chk_contains "new 带 --no-daemon" \
        "$(lib_eval "agent_command_new '$C_WT' n /tmp/p.md")" "--no-daemon"
    chk_contains "按 id resume 带 --no-daemon" \
        "$(lib_eval "WORKER_SESSION_ID='$C_W'; agent_command_resume '$C_WT' n /tmp/p.md")" "--no-daemon"
    chk_contains "resume --last 带 --no-daemon" \
        "$(lib_eval "agent_command_resume '$C_WT' n /tmp/p.md")" "--no-daemon"
else
    echo "  ⏭️  本机 codex 不支持 --no-daemon，跳过（3 项）"
fi

echo "── 24. 回捞必须举证：别的角色晚落盘的会话不许认成自己的（review 超时 → worker 新开）──"
# 复审第 3 轮 / 再一轮的阻塞项。链条：A 角色回捞超时（它那条会话没人登记），
# B 角色随后全新启动，A 的会话文件在「B 的启动前快照之后、B 自己的文件之前」落盘。
# 旧实现认「本次新出现的第一条」，于是 B 把 A 的会话登记到自己名下，下一轮直接 resume 过去。
sed -i 's/^WORKER_AGENT="codex"$/WORKER_AGENT="codex"/' "$TMP/coding-agent.config"
X_WT="$TMP/wt/issue-99"; mkdir -p "$X_WT"
rm -rf "$TMP/state/agent-sessions" "$FAKE_HOME/.codex"
X_R=aaaaaaaa-9999-4999-8999-999999999991   # review 那条（晚落盘）
X_W=bbbbbbbb-9999-4999-8999-999999999992   # worker 自己那条
RV_FILE="$TMP/p-review-99.md";  RV_TXT="$(mk_prompt "$RV_FILE" "review 关卡：请复审 PR #99 的改动")"
WK_FILE="$TMP/p-worker-99.md";  WK_TXT="$(mk_prompt "$WK_FILE" "worker：请按评论修 PR #99")"
# ① review 启动 → 回捞窗口 0，立即超时（它那条还没落盘）
lib_eval "agent_session_plan 99 '$X_WT' $PLAN_PROMPT >/dev/null
agent_session_register_launched 99 '$X_WT' '$RV_FILE' 2>/dev/null" \
    DISPATCH_PROMPT_KIND=review AGENT_SESSION_CAPTURE_SECS=0 >/dev/null
chk "review 超时后没有登记" "$(registry 99.codex.review)" ""
# ② worker 全新启动（此刻目录里还是空的，所以启动前快照为空）
# ③ review 那条现在才落盘 —— 它带的是 review 的 prompt
mk_codex_session "$X_WT" "$X_R" "2026/09/18" "2026-09-18T20-00-00" "$RV_TXT"
out="$(lib_eval "AGENT_LAUNCH_KIND=new WORKER_SESSION_ID='' AGENT_SESSION_PRELAUNCH_IDS=''
agent_session_register_launched 99 '$X_WT' '$WK_FILE' 2>/dev/null
echo registered=[\$(agent_session_id_get 99 codex worker)]" AGENT_SESSION_CAPTURE_SECS=0)"
chk_contains "worker 没把 review 那条认成自己的" "$out" "registered=[]"
chk "拒绝的原因留了痕" \
    "$(grep -c 'reason=' "$TMP/state/agent-sessions/99.codex.unresolved" 2>/dev/null)" "2"
# ④ worker 自己那条落盘后，才认领它
mk_codex_session "$X_WT" "$X_W" "2026/09/18" "2026-09-18T21-00-00" "$WK_TXT"
out="$(lib_eval "AGENT_LAUNCH_KIND=new WORKER_SESSION_ID='' AGENT_SESSION_PRELAUNCH_IDS=''
agent_session_register_launched 99 '$X_WT' '$WK_FILE' 2>/dev/null
echo registered=[\$(agent_session_id_get 99 codex worker)]" AGENT_SESSION_CAPTURE_SECS=0)"
chk_contains "worker 认领的是自己那条" "$out" "registered=[$X_W]"
# ⑤ 下一轮续接必须指向 worker 自己那条
out="$(lib_eval "agent_session_plan 99 '$X_WT' $PLAN_PROMPT; agent_launch_command '$X_WT' n /tmp/p.md")"
chk_contains "下一轮 resume 自己那条" "$out" "codex resume $X_W"
chk_lacks "下一轮没有 resume review 那条" "$out" "$X_R"

echo "── 25. 反方向：worker 超时 → review 新开 → 旧 worker 晚落盘 ──"
Y_WT="$TMP/wt/issue-98"; mkdir -p "$Y_WT"
rm -rf "$TMP/state/agent-sessions" "$FAKE_HOME/.codex"
Y_W=aaaaaaaa-9898-4898-8898-989898989891
Y_R=bbbbbbbb-9898-4898-8898-989898989892
YW_FILE="$TMP/p-worker-98.md"; YW_TXT="$(mk_prompt "$YW_FILE" "worker：请实现 issue #98")"
YR_FILE="$TMP/p-review-98.md"; YR_TXT="$(mk_prompt "$YR_FILE" "review 关卡：请复审 PR #98")"
lib_eval "agent_session_plan 98 '$Y_WT' $PLAN_PROMPT >/dev/null
agent_session_register_launched 98 '$Y_WT' '$YW_FILE' 2>/dev/null" \
    AGENT_SESSION_CAPTURE_SECS=0 >/dev/null
chk "worker 超时后没有登记" "$(registry 98.codex.worker)" ""
mk_codex_session "$Y_WT" "$Y_W" "2026/09/18" "2026-09-18T20-00-00" "$YW_TXT"
out="$(lib_eval "AGENT_LAUNCH_KIND=new WORKER_SESSION_ID='' AGENT_SESSION_PRELAUNCH_IDS=''
agent_session_register_launched 98 '$Y_WT' '$YR_FILE' 2>/dev/null
echo registered=[\$(agent_session_id_get 98 codex review)]" \
    DISPATCH_PROMPT_KIND=review AGENT_SESSION_CAPTURE_SECS=0)"
chk_contains "review 没把 worker 那条认成自己的" "$out" "registered=[]"
mk_codex_session "$Y_WT" "$Y_R" "2026/09/18" "2026-09-18T21-00-00" "$YR_TXT"
out="$(lib_eval "AGENT_LAUNCH_KIND=new WORKER_SESSION_ID='' AGENT_SESSION_PRELAUNCH_IDS=''
agent_session_register_launched 98 '$Y_WT' '$YR_FILE' 2>/dev/null
echo registered=[\$(agent_session_id_get 98 codex review)]" \
    DISPATCH_PROMPT_KIND=review AGENT_SESSION_CAPTURE_SECS=0)"
chk_contains "review 认领的是自己那条" "$out" "registered=[$Y_R]"

echo "── 26. 两条候选都自称是本次启动的 → 宁可不登记 ──"
Z_WT="$TMP/wt/issue-97"; mkdir -p "$Z_WT"
rm -rf "$TMP/state/agent-sessions" "$FAKE_HOME/.codex"
Z_A=aaaaaaaa-9797-4797-8797-979797979791
Z_B=bbbbbbbb-9797-4797-8797-979797979792
ZP_FILE="$TMP/p-97.md"; ZP_TXT="$(mk_prompt "$ZP_FILE" "worker：请实现 issue #97")"
mk_codex_session "$Z_WT" "$Z_A" "2026/09/18" "2026-09-18T20-00-00" "$ZP_TXT"
mk_codex_session "$Z_WT" "$Z_B" "2026/09/18" "2026-09-18T21-00-00" "$ZP_TXT"
out="$(lib_eval "AGENT_LAUNCH_KIND=new WORKER_SESSION_ID='' AGENT_SESSION_PRELAUNCH_IDS=''
agent_session_register_launched 97 '$Z_WT' '$ZP_FILE' 2>/dev/null
echo registered=[\$(agent_session_id_get 97 codex worker)]" AGENT_SESSION_CAPTURE_SECS=0)"
chk_contains "分不清就不登记" "$out" "registered=[]"
chk "原因写明是歧义" \
    "$(grep -c 'reason=ambiguous-proof' "$TMP/state/agent-sessions/97.codex.unresolved" 2>/dev/null)" "1"

echo "── 27. 举证不了的 driver：候选唯一且没有未解决启动才敢认 ──"
# 第三方 driver 可能实现了会话枚举（ISOLATION=1）但没实现举证。那时只能退一步：
# 「本目录只多出一条、而且此前没有认领失败过」才敢认，否则宁可不登记。
cat > "$TMP/project/.agents/skills/coding-agent-work-loop/drivers/mini2.sh" <<'MINI2'
AGENT_SESSION_ISOLATION=1
agent_bin() { echo "mini2"; }
agent_has_history() { return 1; }
agent_is_busy() { return 1; }
agent_command_new() { echo "mini2-new $3"; }
agent_command_resume() { echo "mini2-resume ${WORKER_SESSION_ID:-last} $3"; }
agent_session_new_id() { echo ""; }
mini2_dir() { echo "$HOME/.mini2/$(encoded_cwd "$1")"; }
agent_session_exists() { [ -n "$2" ] && [ -f "$(mini2_dir "$1")/$2" ]; }
agent_session_list() {
    local d; d="$(mini2_dir "$1")"
    [ -d "$d" ] || return 0
    ls -t "$d" 2>/dev/null
    return 0
}
MINI2
sed -i 's/^WORKER_AGENT="codex"$/WORKER_AGENT="mini2"/' "$TMP/coding-agent.config"
M_WT="$TMP/wt/issue-96"; mkdir -p "$M_WT"
rm -rf "$TMP/state/agent-sessions" "$FAKE_HOME/.mini2"
M_DIR="$FAKE_HOME/.mini2/$(printf %s "$M_WT" | tr / -)"; mkdir -p "$M_DIR"
touch "$M_DIR/aaaa-0001"
out="$(lib_eval "AGENT_LAUNCH_KIND=new WORKER_SESSION_ID='' AGENT_SESSION_PRELAUNCH_IDS=''
agent_session_register_launched 96 '$M_WT' /tmp/p.md 2>/dev/null
echo registered=[\$(agent_session_id_get 96 mini2 worker)]" AGENT_SESSION_CAPTURE_SECS=0)"
chk_contains "候选唯一、没有历史认领失败 → 认领" "$out" "registered=[aaaa-0001]"
# 有过认领失败之后，同一个编号就不再敢认了
rm -rf "$TMP/state/agent-sessions"
lib_eval "mkdir -p '$TMP/state/agent-sessions'
printf 'x unresolved-launch role=review reason=timeout\n' > '$TMP/state/agent-sessions/96.mini2.unresolved'" >/dev/null
out="$(lib_eval "AGENT_LAUNCH_KIND=new WORKER_SESSION_ID='' AGENT_SESSION_PRELAUNCH_IDS=''
agent_session_register_launched 96 '$M_WT' /tmp/p.md 2>/dev/null
echo registered=[\$(agent_session_id_get 96 mini2 worker)]" AGENT_SESSION_CAPTURE_SECS=0)"
chk_contains "之前有认领失败 → 不敢认" "$out" "registered=[]"

echo "── 28. 真实的多行 prompt 必须能举证（否则自己的会话也认不出来）──"
# 复审的第 1 条：举证原来用 `jq … | head -1`，拿到的是**第一条物理文本行**而不是
# 整条消息。仓库自带的模板全是多行、首行又短，于是比对必然不等 → 自己起的会话也
# 登记不上 → 每轮都从零起，Q3 的跨轮复用等于没有。
# 这一节直接拿仓库里的 review 模板当 prompt，首行短、后面还有几十行。
sed -i 's/^WORKER_AGENT="[a-z0-9]*"$/WORKER_AGENT="codex"/' "$TMP/coding-agent.config"
ML_WT="$TMP/wt/issue-95"; mkdir -p "$ML_WT"
rm -rf "$TMP/state/agent-sessions" "$FAKE_HOME/.codex"
ML_FILE="$TMP/p-multiline.md"
sed -e 's|${REPO}|example/none|g' -e 's|${PR}|95|g' -e 's|${ISSUE}|95|g' \
    "$REPO_DIR/prompts/review.template.md" > "$ML_FILE"
chk "拿来当 prompt 的模板确实是多行" \
    "$([ "$(wc -l < "$ML_FILE")" -gt 10 ] && echo yes)" "yes"
chk "而且首行不足 200 字节（旧实现正好栽在这）" \
    "$([ "$(head -1 "$ML_FILE" | wc -c)" -lt 200 ] && echo yes)" "yes"
ML_ID=aaaaaaaa-9595-4595-8595-959595959595
mk_codex_session "$ML_WT" "$ML_ID" "2026/10/08" "2026-10-08T09-00-00" "$(cat "$ML_FILE")"
chk "完整多行正文能举证" \
    "$(lib_eval "agent_session_started_with '$ML_WT' '$ML_ID' '$ML_FILE' && echo yes || echo no")" "yes"
out="$(lib_eval "AGENT_LAUNCH_KIND=new WORKER_SESSION_ID='' AGENT_SESSION_PRELAUNCH_IDS=''
agent_session_register_launched 95 '$ML_WT' '$ML_FILE' 2>/dev/null
echo registered=[\$(agent_session_id_get 95 codex worker)]" AGENT_SESSION_CAPTURE_SECS=0)"
chk_contains "多行 prompt 的会话登记得上" "$out" "registered=[$ML_ID]"
out="$(lib_eval "agent_session_plan 95 '$ML_WT' $PLAN_PROMPT; agent_launch_command '$ML_WT' n /tmp/p.md")"
chk_contains "下一轮按 id 续接自己那条" "$out" "codex resume $ML_ID"

echo "── 29. 首行相同、后文不同的两个角色，不许互相认领 ──"
# 复审的第 2 条：举证原来只比前 200 字节。项目可以覆写模板，两个角色的模板共享一段
# 很长的开头是允许的；只比前缀的话，别的角色的会话会被当成自己的。
PX_WT="$TMP/wt/issue-94"; mkdir -p "$PX_WT"
rm -rf "$TMP/state/agent-sessions" "$FAKE_HOME/.codex"
LONG_HEAD="Shared launch instructions: $(printf 'x%.0s' $(seq 1 220))"
RV94="$TMP/p-94-review.md"; printf '%s\nrole=review; review previous implementation\n' "$LONG_HEAD" > "$RV94"
WK94="$TMP/p-94-worker.md"; printf '%s\nrole=worker; implement new requirements\n' "$LONG_HEAD" > "$WK94"
chk "两份 prompt 的前 200 字节确实一样" \
    "$([ "$(head -c 200 "$RV94" | md5sum)" = "$(head -c 200 "$WK94" | md5sum)" ] && echo yes)" "yes"
PX_R=aaaaaaaa-9494-4494-8494-949494949491
mk_codex_session "$PX_WT" "$PX_R" "2026/10/08" "2026-10-08T09-00-00" "$(cat "$RV94")"
chk "worker 的 prompt 举证不了 review 的会话" \
    "$(lib_eval "agent_session_started_with '$PX_WT' '$PX_R' '$WK94' && echo yes || echo no")" "no"
chk "（对照）review 自己的 prompt 举证得了" \
    "$(lib_eval "agent_session_started_with '$PX_WT' '$PX_R' '$RV94' && echo yes || echo no")" "yes"
out="$(lib_eval "AGENT_LAUNCH_KIND=new WORKER_SESSION_ID='' AGENT_SESSION_PRELAUNCH_IDS=''
agent_session_register_launched 94 '$PX_WT' '$WK94' 2>/dev/null
echo registered=[\$(agent_session_id_get 94 codex worker)]" AGENT_SESSION_CAPTURE_SECS=0)"
chk_contains "worker 不会登记那条 review 会话" "$out" "registered=[]"

echo "── 30. 同一份 prompt 的两次启动，靠本次标记分得开 ──"
# 正文一致还不够：同一个角色连派两次，两次的 prompt 可能逐字节相同。plan 会往 prompt
# 末尾追加一行只有本次才有的标记，举证优先认它。
TG_WT="$TMP/wt/issue-93"; mkdir -p "$TG_WT"
rm -rf "$TMP/state/agent-sessions" "$FAKE_HOME/.codex"
BASE93="worker：请按评论修 issue #93
第二行：这份 prompt 两次启动完全一样"
# 上一次启动：同样的正文 + 它自己的标记
OLD93="$TMP/p-93-old.md"; printf '%s\n' "$BASE93" > "$OLD93"
OLD_TAG="$(lib_eval "agent_session_tag_prompt '$OLD93'")"
TG_OLD=aaaaaaaa-9393-4393-8393-939393939391
mk_codex_session "$TG_WT" "$TG_OLD" "2026/10/08" "2026-10-08T08-00-00" "$(cat "$OLD93")"
# 本次启动：plan 给 prompt 打上新的标记。
# 用 review 角色——它从不收养旧会话，所以必然走「全新」分支（worker 角色在这个场景里
# 会把 TG_OLD 收养走，根本到不了打标记那一步）。这也正是真实的 Q3 场景：第 2 轮复审
# 用的是同一份模板，渲染出来可能逐字节相同。
NEW93="$TMP/p-93-new.md"; printf '%s\n' "$BASE93" > "$NEW93"
lib_eval "agent_session_plan 93 '$TG_WT' '$NEW93' >/dev/null" DISPATCH_PROMPT_KIND=review >/dev/null
NEW_TAG="$(lib_eval "agent_session_prompt_tag '$NEW93'")"
chk "plan 给本次 prompt 打了标记" "$([ -n "$NEW_TAG" ] && echo yes)" "yes"
chk "两次的标记不一样" "$([ -n "$OLD_TAG" ] && [ "$OLD_TAG" != "$NEW_TAG" ] && echo yes)" "yes"
chk "上一次启动的会话举证不了本次" \
    "$(lib_eval "agent_session_started_with '$TG_WT' '$TG_OLD' '$NEW93' && echo yes || echo no")" "no"
TG_NEW=bbbbbbbb-9393-4393-8393-939393939392
mk_codex_session "$TG_WT" "$TG_NEW" "2026/10/08" "2026-10-08T09-00-00" "$(cat "$NEW93")"
chk "本次启动的会话举证得了" \
    "$(lib_eval "agent_session_started_with '$TG_WT' '$TG_NEW' '$NEW93' && echo yes || echo no")" "yes"
out="$(lib_eval "AGENT_LAUNCH_KIND=new WORKER_SESSION_ID='' AGENT_SESSION_PRELAUNCH_IDS='$TG_OLD'
agent_session_register_launched 93 '$TG_WT' '$NEW93' 2>/dev/null
echo registered=[\$(agent_session_id_get 93 codex review)]" \
    DISPATCH_PROMPT_KIND=review AGENT_SESSION_CAPTURE_SECS=0)"
chk_contains "登记的是本次那条" "$out" "registered=[$TG_NEW]"
chk "claude（能钉 id）的 prompt 一个字节都不动" \
    "$(sed -i 's/^WORKER_AGENT="codex"$/WORKER_AGENT="claude"/' "$TMP/coding-agent.config"
       CP="$TMP/p-claude.md"; printf 'claude 的 prompt\n' > "$CP"
       lib_eval "agent_session_plan 92 '$TG_WT' '$CP' >/dev/null" >/dev/null
       cat "$CP")" "claude 的 prompt"

echo "── 31. 任务 prompt 前面还有仓库指令时，照样要认出自己的会话 ──"
# 复审这一条：真实 rollout 的顺序是 developer×3 → user(AGENTS.md 指令 30k 字) →
# user(派工 prompt) → assistant。上一版只看「第一条 user 消息」，于是永远先撞上
# 仓库指令那条、判 false，自己的会话再也认不回来 → 每轮从零起，Q3 失效。
# 本机在一条真实 codex 会话上确认过这个顺序（见 driver 注释）。
sed -i 's/^WORKER_AGENT="[a-z0-9]*"$/WORKER_AGENT="codex"/' "$TMP/coding-agent.config"
PRE_WT="$TMP/wt/issue-91"; mkdir -p "$PRE_WT"
rm -rf "$TMP/state/agent-sessions" "$FAKE_HOME/.codex"
PRE_TXT="# AGENTS.md instructions for $PRE_WT

<INSTRUCTIONS>
这是仓库指令，不是派工 prompt。真实会话里它有三万多字。
</INSTRUCTIONS>"
PRE_FILE="$TMP/p-91.md"
printf '仓库：example/none\nReview 目标：PR #91\n多行任务 prompt，第三行。\n' > "$PRE_FILE"
# plan 走「全新」→ 给 prompt 打上本次标记
lib_eval "agent_session_plan 91 '$PRE_WT' '$PRE_FILE' >/dev/null" DISPATCH_PROMPT_KIND=review >/dev/null
PRE_TAG="$(lib_eval "agent_session_prompt_tag '$PRE_FILE'")"
chk "本次 prompt 已带标记" "$([ -n "$PRE_TAG" ] && echo yes)" "yes"
PRE_ID=aaaaaaaa-9191-4191-8191-919191919191
mk_codex_session_real "$PRE_WT" "$PRE_ID" "2026/10/08" "2026-10-08T09-00-00" \
    "$PRE_TXT" "$(cat "$PRE_FILE")"
chk "前置仓库指令不影响举证" \
    "$(lib_eval "agent_session_started_with '$PRE_WT' '$PRE_ID' '$PRE_FILE' && echo yes || echo no")" "yes"
out="$(lib_eval "AGENT_LAUNCH_KIND=new WORKER_SESSION_ID='' AGENT_SESSION_PRELAUNCH_IDS=''
agent_session_register_launched 91 '$PRE_WT' '$PRE_FILE' 2>/dev/null
echo registered=[\$(agent_session_id_get 91 codex review)]" \
    DISPATCH_PROMPT_KIND=review AGENT_SESSION_CAPTURE_SECS=0)"
chk_contains "登记成功" "$out" "registered=[$PRE_ID]"
out="$(lib_eval "agent_session_plan 91 '$PRE_WT' $PLAN_PROMPT; agent_launch_command '$PRE_WT' n /tmp/p.md" DISPATCH_PROMPT_KIND=review)"
chk_contains "下一轮按 id 续接（Q3 的跨轮复用）" "$out" "codex resume $PRE_ID"

echo "── 32. 标记只出现在「第一条 assistant 之后」的，不算本次启动 ──"
# 边界不能放宽成「整段对话里搜一遍」：下一次派工会把新 prompt 注入到**已有**会话里，
# 那条消息同样带标记，但那条会话不是这次启动建的。
BD_WT="$TMP/wt/issue-90"; mkdir -p "$BD_WT"
rm -rf "$TMP/state/agent-sessions" "$FAKE_HOME/.codex"
BD_FILE="$TMP/p-90.md"; printf '任务 prompt for #90\n' > "$BD_FILE"
lib_eval "agent_session_plan 90 '$BD_WT' '$BD_FILE' >/dev/null" DISPATCH_PROMPT_KIND=review >/dev/null
BD_ID=aaaaaaaa-9090-4090-8090-909090909090
# 启动输入里是别的任务；本次 prompt（带标记）只出现在 assistant 回复之后
mk_codex_session_real "$BD_WT" "$BD_ID" "2026/10/08" "2026-10-08T09-00-00" \
    "仓库指令" "另一个任务，跟本次无关" "$(cat "$BD_FILE")"
chk "只在后续消息里出现的标记不算证据" \
    "$(lib_eval "agent_session_started_with '$BD_WT' '$BD_ID' '$BD_FILE' && echo yes || echo no")" "no"
out="$(lib_eval "AGENT_LAUNCH_KIND=new WORKER_SESSION_ID='' AGENT_SESSION_PRELAUNCH_IDS=''
agent_session_register_launched 90 '$BD_WT' '$BD_FILE' 2>/dev/null
echo registered=[\$(agent_session_id_get 90 codex review)]" \
    DISPATCH_PROMPT_KIND=review AGENT_SESSION_CAPTURE_SECS=0)"
chk_contains "也不会被登记" "$out" "registered=[]"

echo "── 33. cwd 过滤不依赖 JSON 的排版 ──"
# 原来是在原始行上 grep `"cwd":"…"`，依赖 codex 写紧凑 JSON。哪天它多打一个空格，
# 「这个 worktree 有哪些会话」就会静默返回空——收养、回捞、判存在全都跟着失效，
# 而且不报错。实测 jq 解析跟 grep 一样快（200 个文件都是 0.4s），所以没有理由将就。
JS_WT="$TMP/wt/issue-89"; mkdir -p "$JS_WT"
rm -rf "$TMP/state/agent-sessions" "$FAKE_HOME/.codex"
JS_DIR="$FAKE_HOME/.codex/sessions/2026/10/08"; mkdir -p "$JS_DIR"
JS_ID=aaaaaaaa-8989-4898-8898-898989898989
# 故意写成带空格的「漂亮」形式
printf '{"timestamp": "2026-10-08T09-00-00", "type": "session_meta", "payload": {"session_id": "%s", "cwd": "%s"}}\n' \
    "$JS_ID" "$JS_WT" > "$JS_DIR/rollout-2026-10-08T09-00-00-$JS_ID.jsonl"
chk "排版带空格也能列出来" \
    "$(lib_eval "agent_session_list '$JS_WT' | tr '\n' ' '")" "$JS_ID "
chk "别的 cwd 不会被误配（前缀相同也不行）" \
    "$(lib_eval "agent_session_list '${JS_WT}-other' | wc -l")" "0"

echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
