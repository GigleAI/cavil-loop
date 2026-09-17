#!/usr/bin/env bash
# 四类 worker prompt 必须统一要求 footer 展示实际模型，并保留机器字段。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
pass=0; fail=0

for name in new-issue issue-comment pr-comment review; do
    file="$REPO_DIR/prompts/$name.template.md"
    if grep -qF 'models` 中的实际模型名' "$file" \
       && grep -qF 'models` 为空时写「模型未知」' "$file" \
       && grep -qF 'model_unknown=yes' "$file" \
       && grep -qF '另有模型无法确认' "$file"; then
        echo "  ✅ $name footer 模型说明完整"
        pass=$((pass + 1))
    else
        echo "  ❌ $name footer 模型说明缺失"
        fail=$((fail + 1))
    fi
done

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
