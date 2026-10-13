#!/usr/bin/env bash
# 复盘经验文件的计次 / 锁定 / 转正校验（scripts/retrospective_lessons.py）+ 复盘主程序的接线。
#
# 跑法：bash tests/retrospective-lessons.test.sh
# 依赖：python3。不碰网络、不调模型、不碰真实项目。
#
# 为什么要有这个文件：硬规则段里的每一条，之后所有自审和交叉 review 都要逐条核对。
# 校验漏一条，模型就能悄悄改掉一条规则的意思、把别的错的次数挪过来、或凭空升级——
# 而这些都不会报错，只会让下一个 PR 被一条不该存在的规则拦下。
#
# 两段：
#   1. 用例全绿；
#   2. 负对照：把每一项检查**单独**关掉（RETRO_LESSONS_DISABLE=<名>）重跑，必须变红。
#      检查名从模块的 CHECKS 读，不在这里抄一份——新加的检查自动纳入，漏写用例就红。
set -uo pipefail

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

echo "── 负对照：逐项关掉检查，必须变红 ──"
checks=$(python3 -c "import sys; sys.path.insert(0, '$TEST_DIR/../scripts'); import retrospective_lessons as r; print(' '.join(r.CHECKS))")
for name in $checks; do
    if RETRO_LESSONS_DISABLE="$name" QUIET=1 python3 "$SUITE" >/dev/null 2>&1; then
        echo "  ❌ 关掉 $name 后用例仍全绿——这项检查没有用例守着"
        fail=$((fail+1))
    else
        echo "  ✅ 关掉 $name → 变红"
        pass=$((pass+1))
    fi
done

echo
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
