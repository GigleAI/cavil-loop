#!/usr/bin/env bash
# kind: unit
# 复审轮数上限 REVIEW_MAX_ROUNDS 的默认值（6）。
#
# 跑法：bash tests/review-max-rounds-default.test.sh             （约 1 秒）
#       MUTATION=1 bash tests/review-max-rounds-default.test.sh   （另跑 2 项负对照，约 2 秒）
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
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
chk() {   # 名称 实得 期望 —— 只在「正式版」里计数；负对照里 CHK_QUIET=1 时只记本轮失败数
    if [ "$2" = "$3" ]; then
        [ -n "${CHK_QUIET:-}" ] || { echo "  ✅ $1"; pass=$((pass+1)); }
    else
        if [ -n "${CHK_QUIET:-}" ]; then run_fail=$((run_fail+1)); echo "      （变红：$1，期望 [$3]，实得 [$2]）"
        else echo "  ❌ $1 (期望 [$3]，实得 [$2])"; fail=$((fail+1)); fi
    fi
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

# ---- 负对照：改坏一份副本，同一组检查必须变红 ----
mut_copy() {   # → 打印副本目录（scripts/ + 配置样例，够 _lib.sh 加载）
    local d; d=$(mktemp -d "$TMP/mut.XXXX")
    cp -r "$REPO_DIR/scripts" "$d/scripts"
    cp "$REPO_DIR/cavil-loop.config.example" "$d/"
    printf '%s' "$d"
}
mut_expect_red() {   # 名称 副本目录
    local run_fail=0
    CHK_QUIET=1 run_checks "$2" >"$TMP/mut.out" 2>&1
    grep '变红' "$TMP/mut.out" || true
    run_fail=$(grep -c '变红' "$TMP/mut.out")
    if [ "$run_fail" -gt 0 ]; then echo "  ✅ 负对照「$1」：检查变红"; pass=$((pass+1))
    else echo "  ❌ 负对照「$1」：检查仍全绿，没拦住"; fail=$((fail+1)); fi
}
mut_prep_fail() { echo "  ❌ 负对照「$1」准备失败：要改的原文不在了"; fail=$((fail+1)); }

echo "【负对照】"
if mutation_gate; then
    d=$(mut_copy)
    # 样例前面写 6、后面再写一行合法的覆盖 3：只抠文本的检查会放过
    printf '%s\n' 'REVIEW_MAX_ROUNDS="3"' >> "$d/cavil-loop.config.example"
    mut_expect_red "配置样例末尾再覆盖成 3" "$d"
fi
if mutation_gate; then
    d=$(mut_copy)
    if grep -q '^REVIEW_MAX_ROUNDS="\${REVIEW_MAX_ROUNDS:-6}"$' "$d/scripts/_lib.sh"; then
        sed -i 's/^REVIEW_MAX_ROUNDS="\${REVIEW_MAX_ROUNDS:-6}"$/REVIEW_MAX_ROUNDS="${REVIEW_MAX_ROUNDS:-3}"/' "$d/scripts/_lib.sh"
        mut_expect_red "代码默认值退回 3" "$d"
    else mut_prep_fail "代码默认值退回 3"; fi
fi
mutation_summary "$0"

echo
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
