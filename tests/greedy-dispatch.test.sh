#!/usr/bin/env bash
# greedy 派工模式的挡工判据守卫（`greedy_skip_reason` / `DISPATCH_MODE` 校验）。
#
# 跑法：bash tests/greedy-dispatch.test.sh
# 依赖：无。不碰网络、不调 gh、不读任何真实项目的 config——自造临时 config 沙盘。
#
# 为什么要有这个文件：greedy 模式下**挡工 label 是唯一的刹车**，错的两个方向都很贵——
#   · 漏挡（比如 doing/agent 没挡住）→ 同一条活开两个 worker，或者 Done 的活被反复重开；
#   · 误挡（比如 "pending/human" 用了子串匹配，把 "pending/humanoid" 也挡了）→ 活悄悄
#     卡死在队列外，看板上什么都看不出来。
# 两种都不会报错，只能靠断言拦住。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

TMP_CONF=$(mktemp -d)/coding-agent.config
SANDBOX="$(dirname "$TMP_CONF")"
cat > "$TMP_CONF" <<CONF
REPO="example/none"
PROJECT_ROOT="$SANDBOX/project"
WORKTREE_BASE="$SANDBOX/wt"
STATE_DIR="$SANDBOX/state"
TMUX_PREFIX="greedytest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_REVIEW="pending/review"
GREEDY_SKIP_LABELS="blocked,需要讨论"
CONF
mkdir -p "$SANDBOX/state" "$SANDBOX/project" "$SANDBOX/wt"

export CODING_AGENT_CONFIG="$TMP_CONF"
# ⚠️ 同 reap 测试：_lib.sh 顶部的 `exec 9>&- 2>/dev/null` 会永久吞掉调用方 stderr，
# source 前后自己倒一手 fd 2，否则这个测试挂了会「无输出 + exit 1」没法查。
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e

cleanup() { rm -rf "$(dirname "$TMP_CONF")"; }
trap cleanup EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 $3，实得 $2)"; fail=$((fail+1)); fi
}
# 把「挡不挡 + 挡它的是谁」压成一个可断言的字符串：挡了写 label 名，没挡写 "-"
verdict() {
    local reason
    if reason=$(greedy_skip_reason "$1"); then echo "$reason"; else echo "-"; fi
}

echo "── 该派工的（不挡）──"
chk "无 label 的新 issue"          "$(verdict "")"                          "-"
chk "只挂优先级 label"             "$(verdict "priority/p0")"               "-"
chk "挂着 pending/agent"           "$(verdict "pending/agent")"             "-"
chk "挂着无关业务 label"           "$(verdict "bug,frontend")"              "-"

echo "── 该挡的（内置挡工 label）──"
chk "pending/human"                "$(verdict "pending/human")"             "pending/human"
chk "doing/agent"                  "$(verdict "doing/agent")"               "doing/agent"
chk "Done"                         "$(verdict "Done")"                      "Done"
chk "pending/PR"                   "$(verdict "pending/PR")"                "pending/PR"
chk "pending/review 归 review 那趟" "$(verdict "pending/review")"            "pending/review"
chk "混在一堆 label 里也能认出"    "$(verdict "bug,priority/p1,Done,ui")"   "Done"

echo "── 该挡的（项目自定义追加）──"
chk "GREEDY_SKIP_LABELS 第一项"    "$(verdict "blocked")"                   "blocked"
chk "GREEDY_SKIP_LABELS 第二项"    "$(verdict "需要讨论")"                   "需要讨论"

echo "── 精确匹配，不许子串误伤 ──"
# 这四条是这个测试真正要守的东西：任何一条挂了，都是「活悄悄消失」而不是报错
chk "pending/humanoid 不是 pending/human" "$(verdict "pending/humanoid")"   "-"
chk "not-Done 不是 Done"                  "$(verdict "not-Done")"           "-"
chk "doing/agent-lite 不是 doing/agent"   "$(verdict "doing/agent-lite")"   "-"
chk "带空格的 label 不被拆开"             "$(verdict "good first issue")"   "-"

echo "── DISPATCH_MODE 校验 ──"
chk "默认是 label"  "$DISPATCH_MODE" "label"
# 拼错必须 fail-fast：静默回落到 label 等于「配了 greedy 却没生效」，最难查
DISPATCH_MODE=gready bash -c "source '$REPO_DIR/scripts/_lib.sh'" >/dev/null 2>&1
chk "拼错的模式名 exit 非 0" "$([ $? -ne 0 ] && echo yes || echo no)" "yes"
DISPATCH_MODE=greedy bash -c "source '$REPO_DIR/scripts/_lib.sh'" >/dev/null 2>&1
chk "greedy 是合法值"        "$([ $? -eq 0 ] && echo yes || echo no)" "yes"

echo
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
