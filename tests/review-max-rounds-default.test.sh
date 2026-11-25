#!/usr/bin/env bash
# kind: unit
# 复审轮数上限 REVIEW_MAX_ROUNDS 的默认值（6）。
#
# 跑法：bash tests/review-max-rounds-default.test.sh             （约 1 秒）
# 依赖：bash。不碰网络，HOME 指到临时目录。
#
# 守三件事：
#   【1】项目配置没写这一项 → 派工脚本拿到的是 6
#   【2】项目配置自己写了 → 用项目的值（默认值不覆盖项目配置）
#   【3】新项目拿到的配置样例，按生产方式加载后实际生效的值是 6
#       （setup.sh 把样例原样抄成项目配置，_lib.sh 再 source 它；所以这里也原样抄、走 _lib.sh 加载，
#        不从样例文本里抠数字——样例后面再有一行覆盖成 3 时，抠文本会放过）
# 托管合并前「交回 worker 修」的次数上限沿用同一个数，由 tests/autopilot.test.sh 守。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
chk() {   # 名称 实得 期望
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
# 在干净子进程里按生产方式加载：CODING_AGENT_CONFIG 指向项目配置，source 公共库，读最终生效值。
# 加载失败时输出 LOAD_FAILED，不会被当成某个数值。
rounds() {   # 仓库目录
    (cd "$TMP" && env -u REVIEW_MAX_ROUNDS HOME="$TMP" CODING_AGENT_CONFIG="$TMP/conf" \
        bash -c 'source "$1/scripts/_lib.sh" >/dev/null 2>&1 || { printf LOAD_FAILED; exit 0; }
                 printf "%s" "$REVIEW_MAX_ROUNDS"' _ "$1")
}

run_checks() {   # 仓库目录
    local repo="$1"
    echo "【1】项目没配 → 默认 6"
    conf
    chk "没写 REVIEW_MAX_ROUNDS" "$(rounds "$repo")" 6

    echo "【2】项目配了 → 用项目的值"
    conf 'REVIEW_MAX_ROUNDS=3'
    chk "写了 3" "$(rounds "$repo")" 3
    conf 'REVIEW_MAX_ROUNDS=8'
    chk "写了 8" "$(rounds "$repo")" 8

    echo "【3】新项目拿到的配置样例：按生产方式加载后生效值为 6"
    cp "$repo/cavil-loop.config.example" "$TMP/conf"   # 同 setup.sh：样例原样抄成项目配置
    chk "加载 cavil-loop.config.example 后的生效值" "$(rounds "$repo")" 6
}

run_checks "$REPO_DIR"

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
