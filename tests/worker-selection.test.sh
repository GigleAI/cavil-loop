#!/usr/bin/env bash
# 跑法：bash tests/worker-selection.test.sh
# 依赖：无。验证普通 worker 与 review worker 的默认值、模型覆盖彼此隔离，
# 并守住 agent-poll 到 dispatch 的模型透传链路。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/coding-agent.config" <<CONF
REPO="example/none"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="selectiontest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_REVIEW="pending/review"
WORKER_AGENT="claude"
WORKER_MODEL="ordinary-model"
REVIEW_WORKER_AGENT="codex"
REVIEW_MODEL="review-model"
CONF
mkdir -p "$TMP/project" "$TMP/wt" "$TMP/state"

export CODING_AGENT_CONFIG="$TMP/coding-agent.config"
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e

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

echo "── 默认 worker 与独立 review worker ──"
chk "普通任务默认 Claude" "$WORKER_AGENT_DEFAULT" "claude"
chk "当前普通任务使用 Claude" "$WORKER_AGENT" "claude"
chk "review 默认 Codex" "$REVIEW_WORKER_AGENT" "codex"
chk "普通任务拿到自己的模型覆盖" "$(worker_model_arg)" "--model ordinary-model"

echo "── review 覆盖不会改写普通配置 ──"
review_agent="$REVIEW_WORKER_AGENT"
review_model="$REVIEW_MODEL"
chk "review agent 独立" "$review_agent" "codex"
chk "review model 独立" "$review_model" "review-model"
chk "普通 agent 未被 review 改写" "$WORKER_AGENT" "claude"
chk "普通 model 未被 review 改写" "$WORKER_MODEL" "ordinary-model"

echo "── dispatch 子进程加载配置后仍隔离 model ──"
dispatch_command() {
    local agent="$1" model_set="$2" model="$3"
    env \
        CODING_AGENT_CONFIG="$TMP/coding-agent.config" \
        DISPATCH_WORKER_AGENT="$agent" \
        DISPATCH_WORKER_MODEL="$model" \
        DISPATCH_WORKER_MODEL_SET="$model_set" \
        bash -c 'source "$1/scripts/_lib.sh"; agent_command_new /tmp issue-test /tmp/prompt' _ "$REPO_DIR"
}
review_cmd="$(dispatch_command codex 1 review-model)"
empty_cmd="$(dispatch_command codex 1 '')"
ordinary_cmd="$(dispatch_command claude 0 ignored)"
chk "review 子进程使用 review model" "$review_cmd" 'codex --dangerously-bypass-approvals-and-sandbox --model review-model "$(cat /tmp/prompt)"'
chk "明确空 review model 不继承普通 model" "$empty_cmd" 'codex --dangerously-bypass-approvals-and-sandbox  "$(cat /tmp/prompt)"'
chk "未指定 dispatch override 使用普通 model" "$ordinary_cmd" 'claude -n issue-test  --model ordinary-model "$(cat /tmp/prompt)"'

echo "── poll 队列必须把普通 model 传给 dispatch ──"
POLL="$REPO_DIR/scripts/agent-poll.sh"
normal_lines=$(grep -F 'collect_queue_rows issue "$LABEL_PENDING_AGENT_DEFAULT" "$WORKER_MODEL"' "$POLL" | wc -l)
normal_lines=$((normal_lines + $(grep -F 'collect_queue_rows pr "$LABEL_PENDING_AGENT_DEFAULT" "$WORKER_MODEL"' "$POLL" | wc -l)))
extra_lines=$(grep -F 'collect_queue_rows issue "$_extra_label" "$WORKER_MODEL"' "$POLL" | wc -l)
extra_lines=$((extra_lines + $(grep -F 'collect_queue_rows pr    "$_extra_label" "$WORKER_MODEL"' "$POLL" | wc -l)))
greedy_model=$(grep -F 'branch}${US}${US}${WORKER_MODEL}${US}${US}${US}${title}' "$POLL" | wc -l)
chk "普通 issue / PR 队列保留 WORKER_MODEL" "$normal_lines" "2"
chk "追加触发标签保留 WORKER_MODEL" "$extra_lines" "2"
chk "greedy 队列保留 WORKER_MODEL" "$greedy_model" "1"

echo
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
