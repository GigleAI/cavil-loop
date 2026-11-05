#!/usr/bin/env bash
# 复审轮数上限 REVIEW_MAX_ROUNDS 的默认值（6）。
#
# 跑法：bash tests/review-max-rounds-default.test.sh   （约 1 秒）
# 依赖：bash。不碰网络，HOME 指到临时目录。
#
# 守三件事：
#   【1】项目配置没写这一项 → 派工脚本拿到的是 6
#   【2】项目配置自己写了 → 用项目的值（默认值不覆盖项目配置）
#   【3】配置样例里写的值 = 代码里的默认值（setup 把样例抄给新项目，两处不一致新项目就拿不到默认值）
# 托管合并前「交回 worker 修」的次数上限沿用同一个数，由 tests/autopilot.test.sh 守。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
chk() {
    if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1))
    else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
}

conf() {   # [额外配置行…]
    cat > "$TMP/conf" <<CONF
REPO="example/r"
PROJECT_ROOT="$TMP"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="rmrtest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
CONF
    local l; for l in "$@"; do printf '%s\n' "$l" >> "$TMP/conf"; done
}
rounds() {
    (cd "$TMP" && env -u REVIEW_MAX_ROUNDS HOME="$TMP" CODING_AGENT_CONFIG="$TMP/conf" \
        bash -c 'source "$1/scripts/_lib.sh" >/dev/null 2>&1; printf "%s" "$REVIEW_MAX_ROUNDS"' _ "$REPO_DIR")
}

echo "【1】项目没配 → 默认 6"
conf
chk "没写 REVIEW_MAX_ROUNDS" "$(rounds)" 6

echo "【2】项目配了 → 用项目的值"
conf 'REVIEW_MAX_ROUNDS=3'
chk "写了 3" "$(rounds)" 3
conf 'REVIEW_MAX_ROUNDS=8'
chk "写了 8" "$(rounds)" 8

echo "【3】配置样例与代码默认值一致"
example=$(sed -n 's/^REVIEW_MAX_ROUNDS=\([0-9][0-9]*\)$/\1/p' "$REPO_DIR/cavil-loop.config.example")
chk "cavil-loop.config.example 里的值" "$example" 6

echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
