#!/usr/bin/env bash
# prompt 模板的「base + 项目增量」合成（`compose_prompt_template`）。
#
# 跑法：bash tests/prompt-compose.test.sh
# 依赖：无。自造 SKILL_DIR / PROJECT_ROOT 沙盘，不碰网络、不碰真实项目。
#
# 为什么要有这个文件：这条链路错了不会报错，只会让 worker 拿到一份**悄悄不对**的
# prompt——
#   · 增量没被接上 → 项目的特殊规矩（比如「npm test 是整条链」）静默丢失，
#     worker 按通用流程干活，看日志完全正常；
#   · 顺序反了 → base 的通用条款写在后面，把项目的覆盖条款压掉，同样无声;
#   · 老的完全覆写行为被破坏 → 所有已有项目的模板一起失效。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

TMP=$(mktemp -d)
cat > "$TMP/coding-agent.config" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="composetest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
CONF
PROMPTS="$TMP/project/.agents/skills/coding-agent-work-loop/prompts"
mkdir -p "$TMP/state" "$TMP/wt" "$PROMPTS" "$TMP/skill/prompts"

export CODING_AGENT_CONFIG="$TMP/coding-agent.config"
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e
# 指向沙盘里的假 skill，别用真的 prompts/
SKILL_DIR="$TMP/skill"
printf 'BASE-通用工作流\n拍板问题要讲清上下文\n' > "$SKILL_DIR/prompts/new-issue.template.md"

trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 (期望 '$3'，实得 '$2')"; fail=$((fail+1)); fi; }
reset() { rm -f "$PROMPTS"/new-issue.*; }

echo "── 什么都不放 → 用 skill 自带的 base ──"
reset
out=$(compose_prompt_template new-issue)
chk "路径是 skill 的"       "$(basename "$out")" "new-issue.template.md"
chk "内容是 base"           "$(grep -c '^BASE-通用工作流$' "$out")" "1"

echo "── 只放 .template.md → 完全覆写（老行为不能破）──"
reset
printf 'PROJ-完全覆写\n' > "$PROMPTS/new-issue.template.md"
out=$(compose_prompt_template new-issue)
chk "用项目的那份"          "$(grep -c '^PROJ-完全覆写$' "$out")" "1"
chk "不含 base 内容"        "$(grep -c '^BASE-通用工作流$' "$out")" "0"

echo "── 只放 .extra.md → base + 增量（这是要推广的用法）──"
reset
printf 'EXTRA-本项目 npm test 是整条链\n' > "$PROMPTS/new-issue.extra.md"
out=$(compose_prompt_template new-issue)
chk "base 在"               "$(grep -c '^BASE-通用工作流$' "$out")" "1"
chk "base 的新规范也在"     "$(grep -c '拍板问题要讲清上下文' "$out")" "1"
chk "增量在"                "$(grep -c '^EXTRA-本项目 npm test 是整条链$' "$out")" "1"
# 顺序是这条机制的全部意义：后文覆盖前文，增量必须在 base **之后**
chk "增量排在 base 之后"    "$([ "$(grep -n '^EXTRA-' "$out" | cut -d: -f1)" -gt "$(grep -n '^BASE-' "$out" | cut -d: -f1)" ] && echo yes || echo no)" "yes"
chk "有冲突时以增量为准的说明" "$(grep -c '以这一段为准' "$out")" "1"

echo "── 两个都放 → 项目模板当 base，增量仍追加在后 ──"
reset
printf 'PROJ-完全覆写\n' > "$PROMPTS/new-issue.template.md"
printf 'EXTRA-补充\n'     > "$PROMPTS/new-issue.extra.md"
out=$(compose_prompt_template new-issue)
chk "用项目模板当 base"     "$(grep -c '^PROJ-完全覆写$' "$out")" "1"
chk "增量也接上了"          "$(grep -c '^EXTRA-补充$' "$out")" "1"
chk "不含 skill base"       "$(grep -c '^BASE-通用工作流$' "$out")" "0"

echo "── base 都没有 → 返回空串（调用方回落到内联 minimal prompt）──"
reset
rm -f "$SKILL_DIR/prompts/new-issue.template.md"
chk "空串" "$(compose_prompt_template new-issue)" ""

echo
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
