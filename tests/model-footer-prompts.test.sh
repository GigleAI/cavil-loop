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
       && grep -qF '另有模型无法确认' "$file" \
       && grep -qF '原样保留即可，不要自己再追加一遍' "$file"; then
        echo "  ✅ $name footer 模型说明完整"
        pass=$((pass + 1))
    else
        echo "  ❌ $name footer 模型说明缺失"
        fail=$((fail + 1))
    fi
done

# 本项目 footer 的形状由 .extra.md 定，而且 worker 是照着那里的**渲染示例**抄的。
# GitHub#29 的根因就在这里：示例里的 `token …` 行没有模型名，worker 又被要求
# 「整行原样用脚本输出」，于是模型名只留在隐藏的 agent-metrics 注释里，评论上看不到。
# 示例必须跟 driver 的真实输出同形，否则下一个人照抄示例又会把它抄没。
for name in new-issue issue-comment pr-comment review; do
    file="$REPO_DIR/.agents/skills/coding-agent-work-loop/prompts/$name.extra.md"
    if grep -qE '^token .*cache write.*（模型：' "$file" \
       && grep -qF '行末的模型说明同样由脚本自己补' "$file"; then
        echo "  ✅ $name.extra footer 示例带模型说明"
        pass=$((pass + 1))
    else
        echo "  ❌ $name.extra footer 示例没有模型说明（worker 会照抄成没有模型的那一行）"
        fail=$((fail + 1))
    fi
done

echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
