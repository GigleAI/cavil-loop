#!/usr/bin/env bash
# kind: guard
# 复盘经验文件的计次 / 锁定 / 转正校验（scripts/retrospective_lessons.py）+ 复盘主程序的接线。
#
# 跑法：bash tests/retrospective-lessons.test.sh
# 依赖：python3。不碰网络、不调模型、不碰真实项目。
#
# 为什么要有这个文件：硬规则段里的每一条，之后所有自审和交叉 review 都要逐条核对。
# 校验漏一条，模型就能悄悄改掉一条规则的意思、把别的错的次数挪过来、或凭空升级——
# 而这些都不会报错，只会让下一个 PR 被一条不该存在的规则拦下。
#
# 用例全绿即通过。（原来逐项关掉检查、改坏主程序的负对照已按 GitHub#234 删去。）
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE="$TEST_DIR/retrospective_lessons_test.py"
pass=0; fail=0

echo "── 用例 ──"
if out=$(QUIET=1 python3 "$SUITE" 2>&1); then
    echo "  ✅ $(printf '%s\n' "$out" | grep -E '^Ran ')"
    pass=$((pass+1))
else
    printf '%s\n' "$out" | tail -30
    echo "  ❌ 用例有红"
    fail=$((fail+1))
fi

echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
