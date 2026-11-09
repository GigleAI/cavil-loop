#!/usr/bin/env bash
# kind: guard
# 目录经验开关与「只复盘开关生效后合并的 PR」（GitHub#168）。
#
# 跑法：bash tests/retrospective-directory-cutoff.test.sh
# 依赖：python3、git、flock。不碰网络、不调模型、不碰真实项目：HOME 指向临时目录，gh / claude 是假的。
#
# 用例在 tests/retrospective_cutoff_test.py：每个用例都在 env -i 干净环境里跑真实入口
# scripts/post-merge-retrospective.sh（它 source _lib.sh、自己导出开关、再 exec python），
# 项目 origin 是本地 bare 仓库，推送是真推。单个文件的写 / 删失败从外面注入（sitecustomize），
# 不在被测代码里留测试开关。
#
# 用例全绿；其中「开关关掉」一例另和改动前的固定提交 954a294 对拍：GitHub 调用、模型输入、
# 推上去的经验和报告逐字节相同。（原来的负对照已按 GitHub#234 删去。）
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$TEST_DIR/.." && pwd)"
SUITE="$TEST_DIR/retrospective_cutoff_test.py"
pass=0; fail=0
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

BASE_COMMIT=954a294
mkdir -p "$T/base"
if git -C "$REPO_DIR" archive "$BASE_COMMIT" scripts prompts | tar -x -C "$T/base"; then
    # 复盘把 prompts/ 里除 retrospective.template.md 以外的派工模板原样当数据交给模型；
    # 对拍比的是复盘程序和它自己的说明，派工模板换成当前这份，后来改模板（如 GitHub#237）不会误红
    for f in "$REPO_DIR"/prompts/*.template.md; do
        [ "$(basename "$f")" = retrospective.template.md ] || cp "$f" "$T/base/prompts/"
    done
    export BASELINE_RELEASE="$T/base"
else
    echo "  ❌ 准备失败：取不到改动前的固定提交 $BASE_COMMIT"; fail=$((fail+1))
fi

echo "── 用例（真实入口，开关关掉一例与 $BASE_COMMIT 对拍）──"
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
