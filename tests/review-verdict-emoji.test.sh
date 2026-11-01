#!/usr/bin/env bash
# 复审结论评论的标题以 ✅ / ❌ 开头（GitHub#84）。
#
# 跑法：bash tests/review-verdict-emoji.test.sh
# 依赖：无。用仓库自带的真实模板，走 daemon 真正拼 prompt 的 compose_prompt_template。
#
# 规矩只写在通用 review 模板里（没有 review 增量的项目也要有），所以对拍两份成品：
# 带本项目 review 增量的、拿掉增量的。查的是：
#   1. 规矩在、在发结论评论那一步（翻 label 之前）
#   2. 对应关系没写反：只有通过才 ✅，其余一律 ❌，每种「不通过 / 交人」结局都点到
#   3. 两个示例标题的符号和文字一致（✅ 配「通过」、❌ 配「未通过」）
#   4. 没漏进 worker 模板——worker 的评论不是复审结论
# 再对每一条造一个负对照，确认少了哪一处这里都会红。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/mutation.sh
source "$TEST_DIR/lib/mutation.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/coding-agent.config" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="verdicttest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
CONF
mkdir -p "$TMP/state" "$TMP/wt"

export CODING_AGENT_CONFIG="$TMP/coding-agent.config"
exec 8>&2
# shellcheck source=../scripts/_lib.sh
source "$REPO_DIR/scripts/_lib.sh"
exec 2>&8 8>&-
set +e

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }

RULE_HEAD='**结论评论的标题以 ✅ / ❌ 开头**'
WORKERS=(new-issue issue-comment pr-comment)
# 每种「这轮没通过」的结局都要点到，少一个 agent 就可能在那种结局上写成 ✅ 或干脆不写
FAIL_CASES=(
    "不通过退回 worker"
    "不通过且轮次已尽交人"
    "与主干冲突改判不通过"
    "冲突检查或轮次判断不了而交人"
    "没有可审的产出"
)

SANDBOXES=0
make_sandbox() {
    SANDBOXES=$((SANDBOXES + 1))
    rm -rf "$TMP/skill" "$TMP/project"
    mkdir -p "$TMP/skill" "$TMP/project/.agents/skills/cavil-loop"
    cp -r "$REPO_DIR/prompts" "$TMP/skill/prompts"
    cp -r "$REPO_DIR/.agents/skills/cavil-loop/prompts" "$TMP/project/.agents/skills/cavil-loop/prompts"
    SKILL_DIR="$TMP/skill"
}

line_of() { grep -nF -- "$2" "$1" | head -1 | cut -d: -f1; }
# 规矩所在那一行（整段在同一行里）
rule_line() { grep -F -- "$RULE_HEAD" "$1" | head -1; }

# 查一份 review 成品，打印问题，一行一条；空输出 = 全部满足
check_review() {
    local tag="$1" f="$2" r s l_rule l_flip l_step c ok_ex bad_ex
    r=$(rule_line "$f")
    [ -n "$r" ] || { echo "$tag: 没有「标题以 ✅ / ❌ 开头」"; return; }

    l_rule=$(line_of "$f" "$RULE_HEAD")
    l_step=$(line_of "$f" "3. 在该目标发一条 review 结论评论")
    l_flip=$(line_of "$f" "5. 通过：REST 翻")
    { [ -n "$l_step" ] && [ "$l_rule" = "$l_step" ]; } || echo "$tag: 规矩不在发结论评论那一步"
    { [ -n "$l_flip" ] && [ "$l_rule" -lt "$l_flip" ]; } || echo "$tag: 规矩排在翻 label 之后"

    s=${r#*"$RULE_HEAD"}
    case "$s" in *"只有本轮判了通过才用 ✅"*) ;; *) echo "$tag: 没写「只有通过才 ✅」";; esac
    case "$s" in *"其余一律 ❌"*) ;; *) echo "$tag: 没写「其余一律 ❌」";; esac
    for c in "${FAIL_CASES[@]}"; do
        case "$s" in *"$c"*) ;; *) echo "$tag: ❌ 的结局漏了「$c」";; esac
    done

    # 示例标题：符号紧跟 `## `，文字与符号一致
    ok_ex=$(grep -o '`## ✅ [^`]*`' <<<"$s" | head -1)
    bad_ex=$(grep -o '`## ❌ [^`]*`' <<<"$s" | head -1)
    if [ -z "$ok_ex" ]; then echo "$tag: 没有 ✅ 的示例标题"
    else case "$ok_ex" in *未通过*|*不通过*) echo "$tag: ✅ 示例写的是没通过";; *通过*) ;; *) echo "$tag: ✅ 示例没说通过";; esac
    fi
    if [ -z "$bad_ex" ]; then echo "$tag: 没有 ❌ 的示例标题"
    else case "$bad_ex" in *未通过*|*不通过*) ;; *) echo "$tag: ❌ 示例没说未通过";; esac
    fi
}

check_all() {
    local f name
    f=$(compose_prompt_template review 2>/dev/null)
    if [ -s "$f" ]; then cp "$f" "$TMP/composed-review.md"; check_review review "$TMP/composed-review.md"
    else echo "review: 拼不出 prompt"; fi

    # 别的项目没有 review 增量：规矩必须照样在
    mv "$TMP/project/.agents/skills/cavil-loop/prompts/review.extra.md" "$TMP/review.extra.bak"
    f=$(compose_prompt_template review 2>/dev/null)
    if [ -s "$f" ]; then cp "$f" "$TMP/composed-review-noextra.md"; check_review "review(无增量)" "$TMP/composed-review-noextra.md"
    else echo "review(无增量): 拼不出 prompt"; fi
    mv "$TMP/review.extra.bak" "$TMP/project/.agents/skills/cavil-loop/prompts/review.extra.md"

    for name in "${WORKERS[@]}"; do
        f=$(compose_prompt_template "$name" 2>/dev/null)
        [ -s "$f" ] || { echo "$name: 拼不出 prompt"; continue; }
        grep -qF -- "$RULE_HEAD" "$f" && echo "$name: worker 成品里出现了复审结论的标题规矩"
    done
}

echo "── 当前仓库的成品 ──"
make_sandbox
out=$(check_all)
if [ -z "$out" ]; then ok "review 成品（带 / 不带增量）都有规矩、对应关系正确，worker 成品里没有"
else bad "当前成品有问题："; printf '      %s\n' "$out"; fi

mutation_on && echo "── 负对照：每一处改坏都要红 ──"
# 每项负对照的开关判断在建沙盘、改模板之前：关着时只计数，一个沙盘都不建、一处模板都不改
# （GitHub#103 复审第 1 轮：判断放在 expect_red 里时，准备步骤默认模式照跑）
neg_sandbox() { mutation_gate || return 1; make_sandbox; }
SANDBOXES_BEFORE_NEG=$SANDBOXES
expect_red() {
    local desc="$1" want="$2" o
    o=$(check_all)
    if grep -qF -- "$want" <<<"$o"; then ok "$desc → 拦下"
    else bad "$desc → 没拦下（期望出现：$want；实得：${o:-<无>}）"; fi
}
T="prompts/review.template.md"

# 从规矩开头删到「不加。」为止（整条规矩）
drop_rule() {
    python3 - "$1" "$RULE_HEAD" <<'PY'
import sys
p, head = sys.argv[1], sys.argv[2]
t = open(p).read()
s = t.index(head); e = t.index("不加。", s) + len("不加。")
open(p, "w").write(t[:s] + t[e:])
PY
}

if neg_sandbox; then
drop_rule "$SKILL_DIR/$T"
expect_red "规矩整句删掉（带增量的成品）" "review: 没有「标题以 ✅ / ❌ 开头」"
fi

if neg_sandbox; then
drop_rule "$SKILL_DIR/$T"
expect_red "规矩整句删掉（无增量的项目）" "review(无增量): 没有「标题以 ✅ / ❌ 开头」"
fi

if neg_sandbox; then
sed -i 's/只有本轮判了通过才用 ✅/只有本轮判了通过才用 ❌/' "$SKILL_DIR/$T"
expect_red "通过写成 ❌" "review: 没写「只有通过才 ✅」"
fi

if neg_sandbox; then
sed -i 's/其余一律 ❌/其余一律 ✅/' "$SKILL_DIR/$T"
expect_red "其余写成 ✅" "review: 没写「其余一律 ❌」"
fi

for c in "${FAIL_CASES[@]}"; do
    neg_sandbox || continue
    sed -i "s/、\?$c//" "$SKILL_DIR/$T"
    expect_red "❌ 结局漏了「$c」" "review: ❌ 的结局漏了「$c」"
done

if neg_sandbox; then
sed -i 's/`## ✅ 冲突检查复审通过`/`## ✅ 冲突检查复审未通过`/' "$SKILL_DIR/$T"
expect_red "✅ 示例配了未通过" "review: ✅ 示例写的是没通过"
fi

if neg_sandbox; then
sed -i 's/`## ❌ 复审未通过：/`## ❌ 复审通过：/' "$SKILL_DIR/$T"
expect_red "❌ 示例配了通过" "review: ❌ 示例没说未通过"
fi

if neg_sandbox; then
python3 - "$SKILL_DIR/$T" "$RULE_HEAD" <<'PY'
import sys
p, head = sys.argv[1], sys.argv[2]
t = open(p).read()
s = t.index(head); e = t.index("不加。", s) + len("不加。")
rule = t[s:e]; t = t[:s] + t[e:]
a = t.index("\n", t.index("5. 通过：REST 翻"))
open(p, "w").write(t[:a] + rule + t[a:])
PY
expect_red "规矩挪到翻 label 那一步之后" "review: 规矩排在翻 label 之后"
fi

if neg_sandbox; then
printf '\n%s：通过 ✅，其余 ❌。\n' "$RULE_HEAD" >> "$SKILL_DIR/prompts/pr-comment.template.md"
expect_red "规矩漏进 worker 模板" "pr-comment: worker 成品里出现了复审结论的标题规矩"
fi

echo
# 开关真的挡在准备之前：默认模式负对照区一个沙盘都没建；打开时确实建了
neg_sandboxes=$((SANDBOXES - SANDBOXES_BEFORE_NEG))
if mutation_on; then
    if [ "$neg_sandboxes" -gt 0 ]; then ok "开关打开：负对照区建了 $neg_sandboxes 个沙盘"
    else bad "开关打开：负对照区一个沙盘都没建（负对照没真跑）"; fi
else
    if [ "$neg_sandboxes" -eq 0 ]; then ok "默认模式：负对照区一个沙盘都没建、没改模板"
    else bad "默认模式：负对照区仍建了 $neg_sandboxes 个沙盘（开关放在准备之后）"; fi
fi
mutation_summary "$0"
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
