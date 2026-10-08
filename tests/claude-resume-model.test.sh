#!/usr/bin/env bash
# 跑法：bash tests/claude-resume-model.test.sh
# 依赖：jq。验证 #56：claude 续接时没指定模型也要显式带上「当前默认模型」——
# `claude --continue` 不带 --model 会沿用会话当初的模型，长期开着的 issue 永远停在旧版本。
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
mkdir -p "$TMP/project" "$TMP/wt" "$TMP/state" "$TMP/home/.claude" "$TMP/cwd"

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

# 每次在干净子进程里拼命令：HOME 指到临时目录，不读本机真实 settings
resume_cmd() {
    local model_set="$1" model="$2"
    env -u ANTHROPIC_MODEL -u CLAUDE_CONFIG_DIR HOME="$TMP/home" \
        CODING_AGENT_CONFIG="$TMP/coding-agent.config" \
        CLAUDE_EXTRA_FLAGS="${FLAGS:-}" CLAUDE_MANAGED_SETTINGS="$TMP/managed.json" \
        DISPATCH_WORKER_AGENT=claude \
        DISPATCH_WORKER_MODEL="$model" DISPATCH_WORKER_MODEL_SET="$model_set" \
        ${EXTRA_ENV:+"$EXTRA_ENV"} \
        bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; agent_command_resume "$2" issue-test /tmp/prompt' \
        _ "$REPO_DIR" "$TMP/cwd"
}
new_cmd() {
    env -u ANTHROPIC_MODEL HOME="$TMP/home" CODING_AGENT_CONFIG="$TMP/coding-agent.config" \
        DISPATCH_WORKER_AGENT=claude DISPATCH_WORKER_MODEL="" DISPATCH_WORKER_MODEL_SET=1 \
        bash -c 'source "$1/scripts/_lib.sh" 2>/dev/null; agent_command_new "$2" issue-test /tmp/prompt' \
        _ "$REPO_DIR" "$TMP/cwd"
}
R='claude --continue  --model'
P='"$(cat /tmp/prompt)"'

echo "── 续接没指定模型：带上当前默认 ──"
chk "什么都没配 → default（账号默认）" "$(resume_cmd 1 '')" "$R default $P"

echo '{"model":"opus"}' > "$TMP/home/.claude/settings.json"
chk "用户 settings.json 的别名原样传" "$(resume_cmd 1 '')" "$R opus $P"

mkdir -p "$TMP/cwd/.claude"
echo '{"model":"sonnet"}' > "$TMP/cwd/.claude/settings.json"
chk "项目 settings.json 盖过用户级" "$(resume_cmd 1 '')" "$R sonnet $P"

echo '{"model":"haiku"}' > "$TMP/cwd/.claude/settings.local.json"
chk "项目 settings.local.json 优先级最高（文件里）" "$(resume_cmd 1 '')" "$R haiku $P"

EXTRA_ENV="ANTHROPIC_MODEL=claude-opus-5-5"
chk "ANTHROPIC_MODEL 盖过所有 settings" "$(resume_cmd 1 '')" "$R claude-opus-5-5 $P"
EXTRA_ENV=""

echo '{not json' > "$TMP/cwd/.claude/settings.local.json"
echo '{"model":{"x":1}}' > "$TMP/cwd/.claude/settings.json"
chk "坏 JSON / 非字符串 model 跳过，往下找" "$(resume_cmd 1 '')" "$R opus $P"
rm -rf "$TMP/cwd/.claude"

echo "── CLAUDE_EXTRA_FLAGS 里更高优先级的选择不能被覆盖（复审 #57 第 1 轮）──"
echo '{"model":"opus"}' > "$TMP/home/.claude/settings.json"
mkdir -p "$TMP/cwd/.claude"
echo '{"model":"opus"}' > "$TMP/cwd/.claude/settings.json"

FLAGS="--model sonnet"
chk "extra flags 已有 --model → 不再追加" "$(resume_cmd 1 '')" "claude --continue --model sonnet  $P"
FLAGS="--dangerously-skip-permissions --model=sonnet"
chk "extra flags 的 --model=X 形式同样不追加" "$(resume_cmd 1 '')" "claude --continue $FLAGS  $P"

FLAGS="--settings '{\"model\":\"sonnet\"}'"
chk "--settings JSON 的 model 盖过项目 / 用户文件" "$(resume_cmd 1 '')" "claude --continue $FLAGS --model sonnet $P"
FLAGS="--settings='{\"model\":\"sonnet\"}'"
chk "--settings=JSON 形式" "$(resume_cmd 1 '')" "claude --continue $FLAGS --model sonnet $P"
echo '{"model":"haiku"}' > "$TMP/flag-settings.json"
FLAGS="--settings $TMP/flag-settings.json"
chk "--settings 文件路径" "$(resume_cmd 1 '')" "claude --continue $FLAGS --model haiku $P"
FLAGS="--settings '{\"permissions\":{}}'"
chk "--settings 里没写 model → 往下找项目文件" "$(resume_cmd 1 '')" "claude --continue $FLAGS --model opus $P"

echo '{"model":"sonnet"}' > "$TMP/cwd/.claude/settings.json"
FLAGS="--setting-sources user"
chk "--setting-sources user → 跳过项目文件，只看用户级" "$(resume_cmd 1 '')" "claude --continue $FLAGS --model opus $P"
FLAGS="--setting-sources=project"
chk "--setting-sources=project → 跳过用户级" "$(resume_cmd 1 '')" "claude --continue $FLAGS --model sonnet $P"

echo '{"model":"claude-opus-5-5"}' > "$TMP/managed.json"
FLAGS="--settings '{\"model\":\"sonnet\"}'"
chk "managed settings 盖过 --settings 与文件" "$(resume_cmd 1 '')" "claude --continue $FLAGS --model claude-opus-5-5 $P"
rm -f "$TMP/managed.json"

FLAGS="--settings '{\"model\":\"sonnet\"}"
chk "引号不配对、解析不了 → 不追加（不拿猜测覆盖）" "$(resume_cmd 1 '')" "claude --continue $FLAGS  $P"
FLAGS="--settings \$(touch $TMP/pwned)"
resume_cmd 1 '' >/dev/null
chk "拆词不执行 \$(...)" "$([ -e "$TMP/pwned" ] && echo executed || echo safe)" "safe"
FLAGS=""
rm -rf "$TMP/cwd/.claude"

echo "── 指定了模型就用指定的 ──"
chk "dispatch 指定 fable" "$(resume_cmd 1 fable)" "$R fable $P"
chk "带空格的模型名照样 quote" "$(resume_cmd 1 'a b')" "$R a\\ b $P"

echo "── 新开会话行为不变（不带 --model，由 CLI 自己读配置）──"
chk "新会话没指定模型不传 --model" "$(new_cmd)" "claude -n issue-test   $P"

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
