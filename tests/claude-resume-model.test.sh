#!/usr/bin/env bash
# 跑法：bash tests/claude-resume-model.test.sh
# 依赖：jq。无网络、不调真 claude（PATH 最前面放假 claude）。
#
# 验证 #56：claude 续接时没指定模型，也要显式带上「现在新开会话会用的模型」——
# `claude --continue` / `--resume` 不带 --model 会沿用会话当初的模型，长期开着的
# issue 永远停在旧版本。这个默认值由 driver 起一个 `claude -p` 探测出来（问 CLI 自己，
# 不复刻它的选模型规则）；这里钉住探测的接线：在哪个目录跑、带什么参数、怎么收尾、
# 失败时怎么退。CLI 自己的优先级（settings / worktree / --setting-sources …）不在
# 这里重测——那是 claude 的行为，PR #57 的评论里有真 CLI 的实测记录。
#
# 另验证 FABLE_MODEL 改成别名后，state 里老的 claude-fable-5 记录仍回 fable 队列。
#
# 负对照：REPO_DIR=<旧版 checkout> bash tests/claude-resume-model.test.sh 应当变红。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(dirname "$TEST_DIR")}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/coding-agent.config" <<CONF
REPO="example/none"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="resumemodeltest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
WORKER_AGENT="claude"
WORKER_MODEL=""
CONF
mkdir -p "$TMP/project" "$TMP/wt" "$TMP/state" "$TMP/home" "$TMP/cwd" "$TMP/daemon" "$TMP/bin"

# 假 claude：把 cwd / 参数 / 关键环境变量记下来，按 FAKE_MODE 决定输出
#   init（默认）：吐 init 行然后挂住——模拟真 CLI 在连不上 API 时的重试
#   silent：什么都不吐、挂住；fail：直接退出；garbage：吐一行非 JSON
#   nomodel：init 行里没有 model
cat > "$TMP/bin/claude" <<'FAKE'
#!/usr/bin/env bash
{
    echo "cwd=$PWD"
    echo "base_url=${ANTHROPIC_BASE_URL:-}"
    for a in "$@"; do echo "arg=$a"; done
} > "$FAKE_LOG"
case "${FAKE_MODE:-init}" in
    init)    echo '{"type":"system","subtype":"init","model":"'"${FAKE_MODEL:-claude-opus-5-5}"'"}'; echo $$ > "$FAKE_LOG.pid"; sleep 30 ;;
    silent)  echo $$ > "$FAKE_LOG.pid"; sleep 30 ;;
    fail)    exit 1 ;;
    garbage) echo 'not json'; sleep 30 ;;
    nomodel) echo '{"type":"system","subtype":"init"}'; sleep 30 ;;
    hooks)   echo '{"type":"system","subtype":"hook_started"}'; echo '{"type":"system","subtype":"hook_response"}'
             echo '{"type":"system","subtype":"init","model":"claude-haiku-5-5"}'; sleep 30 ;;
    noinit)  echo '{"type":"assistant"}'; echo '{"type":"system","subtype":"init","model":"late"}'; sleep 30 ;;
esac
FAKE
chmod +x "$TMP/bin/claude"

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

FAKE_LOG="$TMP/fake.log"
# 每次在干净子进程里、从「daemon 目录」拼命令；claude 实际起在 $TMP/cwd（worktree）
resume_cmd() {   # <dispatch model_set> <model> [VAR=VAL ...]
    local model_set="$1" model="$2"; shift 2
    rm -f "$FAKE_LOG" "$FAKE_LOG.pid"
    env -u ANTHROPIC_MODEL HOME="$TMP/home" PATH="$TMP/bin:$PATH" \
        CODING_AGENT_CONFIG="$TMP/coding-agent.config" FAKE_LOG="$FAKE_LOG" \
        CLAUDE_EXTRA_FLAGS="${FLAGS:-}" \
        DISPATCH_WORKER_AGENT=claude \
        DISPATCH_WORKER_MODEL="$model" DISPATCH_WORKER_MODEL_SET="$model_set" \
        "$@" \
        bash -c 'cd "$3" && source "$1/scripts/_lib.sh" 2>/dev/null; agent_command_resume "$2" issue-test /tmp/prompt' \
        _ "$REPO_DIR" "$TMP/cwd" "$TMP/daemon"
}
new_cmd() {
    rm -f "$FAKE_LOG"
    env -u ANTHROPIC_MODEL HOME="$TMP/home" PATH="$TMP/bin:$PATH" FAKE_LOG="$FAKE_LOG" \
        CODING_AGENT_CONFIG="$TMP/coding-agent.config" \
        DISPATCH_WORKER_AGENT=claude DISPATCH_WORKER_MODEL="" DISPATCH_WORKER_MODEL_SET=1 \
        bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; agent_command_new "$2" issue-test /tmp/prompt' \
        _ "$REPO_DIR" "$TMP/cwd"
}
probe_ran() { [ -f "$FAKE_LOG" ] && echo yes || echo no; }
has_arg()   { grep -qxF "arg=$1" "$FAKE_LOG" 2>/dev/null && echo yes || echo no; }
P='"$(cat /tmp/prompt)"'

echo "── 续接没指定模型：带上探测到的当前默认 ──"
FLAGS=""
chk "--continue 追加探测到的模型" "$(resume_cmd 1 '')" "claude --continue  --model claude-opus-5-5 $P"
chk "--resume <id> 同样追加" "$(resume_cmd 1 '' WORKER_SESSION_ID=abc-123)" \
    "claude --resume abc-123  --model claude-opus-5-5 $P"
chk "探测到别的模型就传别的" "$(resume_cmd 1 '' FAKE_MODEL=claude-sonnet-5-5)" \
    "claude --continue  --model claude-sonnet-5-5 $P"

chk "init 前面有 SessionStart hook 事件也能读到" "$(resume_cmd 1 '' FAKE_MODE=hooks)" \
    "claude --continue  --model claude-haiku-5-5 $P"

echo "── 探测的接线：在哪跑、带什么、不留什么 ──"
resume_cmd 1 '' >/dev/null
chk "在 worktree 里跑（不是 daemon 的目录）" "$(grep '^cwd=' "$FAKE_LOG")" "cwd=$TMP/cwd"
chk "API 地址指到本机，请求发不出去" "$(grep '^base_url=' "$FAKE_LOG")" "base_url=http://127.0.0.1:9"
chk "-p 非交互" "$(has_arg -p)" "yes"
chk "不落会话文件（否则下次 --continue 续到探测）" "$(has_arg --no-session-persistence)" "yes"
chk "不连 MCP" "$(has_arg --strict-mcp-config)" "yes"
chk "stream-json 输出" "$(has_arg stream-json)" "yes"
chk "不带 --continue" "$(has_arg --continue)" "no"
chk "不带 --resume" "$(has_arg --resume)" "no"

FLAGS="--dangerously-skip-permissions --settings '{\"model\":\"sonnet\"}' --setting-sources user,project"
resume_cmd 1 '' >/dev/null
chk "extra flags 原样传给探测（带引号的 JSON 拆成一个参数）" "$(has_arg '{"model":"sonnet"}')" "yes"
chk "extra flags 的其他参数也在" "$(has_arg user,project)" "yes"

echo "── 收尾：读到 init 就杀掉，不等它重试 ──"
FLAGS=""
start=$(date +%s)
out="$(resume_cmd 1 '')"
elapsed=$(( $(date +%s) - start ))
chk "读到 init 立刻返回（< 5 秒；假 claude 会挂 30 秒）" "$([ "$elapsed" -lt 5 ] && echo fast || echo "slow:${elapsed}s")" "fast"
pid="$(cat "$FAKE_LOG.pid" 2>/dev/null)"
sleep 0.3
chk "探测进程已被杀掉" "$( [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo alive || echo gone)" "gone"

echo "── 探测失败：不追加 --model（维持老行为，不拿猜测覆盖）──"
chk "claude 直接退出" "$(resume_cmd 1 '' FAKE_MODE=fail)" "claude --continue   $P"
chk "输出不是 JSON" "$(resume_cmd 1 '' FAKE_MODE=garbage)" "claude --continue   $P"
chk "init 里没有 model" "$(resume_cmd 1 '' FAKE_MODE=nomodel)" "claude --continue   $P"
chk "先出现非 system 事件 → 不再等后面的 init" "$(resume_cmd 1 '' FAKE_MODE=noinit)" "claude --continue   $P"
start=$(date +%s)
chk "一直不吐东西 → 按超时放弃" "$(resume_cmd 1 '' FAKE_MODE=silent CLAUDE_MODEL_PROBE_TIMEOUT=2)" "claude --continue   $P"
elapsed=$(( $(date +%s) - start ))
chk "超时确实生效（< 6 秒）" "$([ "$elapsed" -lt 6 ] && echo ok || echo "slow:${elapsed}s")" "ok"
pid="$(cat "$FAKE_LOG.pid" 2>/dev/null)"
sleep 0.3
chk "超时后探测进程也被杀掉" "$( [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo alive || echo gone)" "gone"

echo "── 不该探测的时候不探测 ──"
FLAGS="--model sonnet"
chk "extra flags 已有 --model → 不追加" "$(resume_cmd 1 '')" "claude --continue --model sonnet  $P"
chk "  …也不起探测" "$(probe_ran)" "no"
FLAGS="--dangerously-skip-permissions --model=sonnet"
chk "--model=X 形式同样不追加" "$(resume_cmd 1 '')" "claude --continue $FLAGS  $P"
FLAGS="--settings '{\"model\":\"sonnet\"}"
chk "引号不配对、拆不开 → 不追加" "$(resume_cmd 1 '')" "claude --continue $FLAGS  $P"
chk "  …也不起探测" "$(probe_ran)" "no"
FLAGS="--settings \$(touch $TMP/pwned)"
resume_cmd 1 '' >/dev/null
chk "拆词不执行 \$(...)" "$([ -e "$TMP/pwned" ] && echo executed || echo safe)" "safe"
FLAGS=""
chk "dispatch 指定了模型 → 用指定的" "$(resume_cmd 1 fable)" "claude --continue  --model fable $P"
chk "  …不起探测" "$(probe_ran)" "no"
chk "带空格的模型名照样 quote" "$(resume_cmd 1 'a b')" "claude --continue  --model a\\ b $P"

echo "── 新开会话行为不变（不带 --model，由 CLI 自己读配置）──"
chk "新会话没指定模型不传 --model" "$(new_cmd)" "claude -n issue-test   $P"
chk "  …不起探测" "$(probe_ran)" "no"

echo "── FABLE_MODEL 默认是别名，老 state 记录仍回 fable 队列 ──"
fable_default="$(env -u FABLE_MODEL HOME="$TMP/home" CODING_AGENT_CONFIG="$TMP/coding-agent.config" \
    bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; printf %s "$FABLE_MODEL"' _ "$REPO_DIR")"
chk "FABLE_MODEL 默认 fable" "$fable_default" "fable"

eval "$(awk '/^pending_label_for_model\(\) \{/,/^\}/' "$REPO_DIR/scripts/agent-poll.sh")"
LABEL_PENDING_AGENT_FABLE="pending/agent/fable"
LABEL_PENDING_AGENT_DEFAULT="pending/agent"
FABLE_MODEL="fable"
chk "记录为 fable → fable 队列" "$(pending_label_for_model fable)" "pending/agent/fable"
chk "老记录 claude-fable-5 → 仍回 fable 队列" "$(pending_label_for_model claude-fable-5)" "pending/agent/fable"
chk "claude-fable-5-1 → fable 队列" "$(pending_label_for_model claude-fable-5-1)" "pending/agent/fable"
chk "普通模型 → 默认队列" "$(pending_label_for_model claude-opus-5-5)" "pending/agent"
chk "空 → 默认队列" "$(pending_label_for_model '')" "pending/agent"

echo
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
