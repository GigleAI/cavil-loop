#!/usr/bin/env bash
# kind: e2e
# 经验升档时的单条字数上限（GitHub#600，RETROSPECTIVE_RULE_MAX_CHARS）。
#
# 跑法：bash tests/retrospective-rule-limit.test.sh
# 依赖：python3、git、flock。不碰网络、不调模型、不碰真实项目：HOME 指向临时目录，gh / claude 是假的。
#
# 用例在 tests/retrospective_rule_limit_test.py：沿用 tests/retrospective_cutoff_test.py 的沙箱，
# 每个用例在干净环境里跑真实入口 scripts/post-merge-retrospective.sh，项目 origin 是本地 bare 仓库，
# 推送是真推。看的是推上去的经验文件和报告、队列里的任务文件、日志：300 / 301 字、两种升档模式、
# 挡下后人压缩 / 调高上限 / 改成不限时补升、人删掉标记不补升、模型压短「为什么」当轮升、
# 已在硬规则的长条目照常计次、模型自己写标记行作废计一次、标记行写坏不调模型不计次、配置填错不动任务。
# 判断规则本身的逐条用例在 tests/retrospective_lessons_test.py（tests/retrospective-lessons.test.sh 跑）。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE="$TEST_DIR/retrospective_rule_limit_test.py"
pass=0; fail=0

echo "── 用例（真实入口）──"
if out=$(QUIET=1 python3 "$SUITE" 2>&1); then
    echo "  ✅ $(printf '%s\n' "$out" | grep -E '^Ran ')"
    pass=$((pass+1))
else
    printf '%s\n' "$out" | tail -40
    echo "  ❌ 用例有红"
    fail=$((fail+1))
fi

echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
