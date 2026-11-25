#!/usr/bin/env bash
# kind: e2e
# 复盘报告的存放目录可配（GitHub#688）。
#
# 跑法：bash tests/retrospective-report-dir.test.sh
# 依赖：python3、git、flock、jq。不碰网络、不调模型、不碰真实项目：HOME 指向临时目录，gh / claude 是假的。
#
# 用例在 tests/retrospective_report_dir_test.py，沙箱和 tests/retrospective_cutoff_test.py 同一个：
# env -i 里跑真实入口 scripts/post-merge-retrospective.sh，项目 origin 是本地 bare 仓库，推送是真推。
# 不配置时的一轮和改动前的固定提交 4e63edb8 对拍（GitHub 调用、模型输入与说明、推上去的文件逐字节相同）；
# 正反例清单 tests/fixtures/repodir-cases.txt 同时过复盘入口和配置脚本的真实保存
# （客户端那一处在 client/test/unit/repodir.test.ts）。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# shellcheck source=lib/compat.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/compat.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$TEST_DIR/.." && pwd)"
SUITE="$TEST_DIR/retrospective_report_dir_test.py"
pass=0; fail=0
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

BASE_COMMIT=4e63edb8
mkdir -p "$T/base"
if git -C "$REPO_DIR" archive "$BASE_COMMIT" scripts prompts | tar -x -C "$T/base"; then
    # 派工模板原样当数据交给模型；对拍比的是复盘程序和它自己的说明，派工模板换成当前这份，
    # 后来改模板不会误红
    for f in "$REPO_DIR"/prompts/*.template.md; do
        [ "$(basename "$f")" = retrospective.template.md ] || cp "$f" "$T/base/prompts/"
    done
    compat_skip "不配置时的一轮与 $BASE_COMMIT" "$T/base" "$REPO_DIR" scripts prompts || export BASELINE_RELEASE="$T/base"
else
    echo "  ❌ 准备失败：取不到改动前的固定提交 $BASE_COMMIT"; fail=$((fail+1))
fi

echo "── 用例（真实入口；不配置的一轮与 $BASE_COMMIT 对拍）──"
if out=$(env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM QUIET=1 python3 "$SUITE" 2>&1); then
    echo "  ✅ $(printf '%s\n' "$out" | grep -E '^Ran ')"
    if [ -n "${BASELINE_RELEASE:-}" ] && printf '%s\n' "$out" | grep -q 'skipped'; then
        printf '%s\n' "$out" | tail -5
        echo "  ❌ 有用例跳过了（和改动前的对拍没跑）"; fail=$((fail+1))
    else
        pass=$((pass+1))
    fi
else
    printf '%s\n' "$out" | tail -60
    echo "  ❌ 用例有红"
    fail=$((fail+1))
fi

compat_summary
echo "通过 $pass，失败 $fail"
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
