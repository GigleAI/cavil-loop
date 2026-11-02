#!/usr/bin/env bash
# 评论版式规矩：外面只放要人看的、其余折叠，并用 ❌ / ✅ / ⚠️ 标出每条结论。
#
# 跑法：bash tests/comment-layout-prompts.test.sh（MUTATION=1 连负对照一起跑）
# 依赖：无。用仓库自带的真实模板，走 daemon 真正拼 prompt 的 compose_prompt_template。
#
# 为什么要有这个文件：以前默认模板对版式只有一句「过程留痕折叠」，没说哪些放外面、
# 哪些折叠，worker 的方案评论于是整篇摊开（有接入项目的方案 120 行、第 100 行才出现第一个
# 折叠块）。同一套规矩写在多份模板里：三份 worker 模板「交人评论怎么写」的第 7、9 条，
# 首次 / 修订方案那一步的「方案评论版式」，复审模板第 3 步的「评论版式」和打回依据 ⑧，
# 以及本项目自己的 review 增量。只改其中一处不会报错，只会让别的环节照样发出整篇摊开的评论。
# 所以按拼好的成品对拍：每处都在、逐字一致；旧的「测试结果写进正文」说法已改掉；
# 再对每个改动点各造一个负对照，确认少了哪一处这里都会红。
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
TMUX_PREFIX="layouttest"
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

WORKERS=(new-issue issue-comment pr-comment)
ALL=(new-issue issue-comment pr-comment review)
EXTRA_REL=".agents/skills/cavil-loop/prompts/review.extra.md"

SANDBOXES=0
make_sandbox() {
    SANDBOXES=$((SANDBOXES + 1))
    rm -rf "$TMP/skill" "$TMP/project"
    mkdir -p "$TMP/skill" "$TMP/project/.agents/skills/cavil-loop"
    cp -r "$REPO_DIR/prompts" "$TMP/skill/prompts"
    cp -r "$REPO_DIR/.agents/skills/cavil-loop/prompts" "$TMP/project/.agents/skills/cavil-loop/prompts"
    SKILL_DIR="$TMP/skill"
}

# 每条规矩从加粗开头截到行尾（每处都是一整行），同一条的所有出现应逐字相同
FOLD_HEAD='**外面只放要人看的，其余折叠**'
MARK_HEAD='**用 ❌ / ✅ / ⚠️ 标出每条结论**'
PLAN_HEAD='**方案评论版式（外面只放要人看的，其余折叠）**'
REVIEW_HEAD='**评论版式（外面只放要人看的，其余折叠）**'
texts() { grep -oF -- "$1" "$2" >/dev/null && grep -o -- "$(sed 's/[][\.*^$/]/\\&/g' <<<"$1").*" "$2"; }

# 打印发现的问题，一行一条；空输出 = 全部满足
check_prompts() {
    local name f t n ref_fold="" ref_mark="" ref_plan=""
    for name in "${ALL[@]}"; do
        f=$(compose_prompt_template "$name" 2>/dev/null)
        [ -s "$f" ] || { echo "$name: 拼不出 prompt"; continue; }
        cp "$f" "$TMP/composed-$name.md"
    done

    # 1. 「交人评论怎么写」第 7 条：外面放什么 / 折叠什么（三份 worker + 本项目 review 增量）
    for name in "${ALL[@]}"; do
        f="$TMP/composed-$name.md"; [ -s "$f" ] || continue
        t=$(texts "$FOLD_HEAD" "$f" | sort -u)
        if [ -z "$t" ]; then echo "$name: 没有折叠规则"; continue; fi
        [ "$(wc -l <<<"$t")" -eq 1 ] || { echo "$name: 折叠规则有不同写法"; continue; }
        grep -qF -- "7. $FOLD_HEAD" "$f" || echo "$name: 折叠规则不在交人评论那段的第 7 条"
        grep -qF '<summary>` 后空一行' <<<"$t" || echo "$name: 折叠规则缺「<summary> 后空一行」"
        grep -qF '判据是内容性质不是长度' <<<"$t" || echo "$name: 折叠规则缺判据"
        if [ -z "$ref_fold" ]; then ref_fold="$t"; elif [ "$t" != "$ref_fold" ]; then echo "$name: 折叠规则和 ${ALL[0]} 不一致"; fi
        grep -qF '7. **过程留痕折叠**' "$f" && echo "$name: 还留着旧的一句话折叠规则"
    done

    # 2. ❌ / ✅ / ⚠️ 标识规则：四份成品都有、逐字一致；worker 在第 9 条
    for name in "${ALL[@]}"; do
        f="$TMP/composed-$name.md"; [ -s "$f" ] || continue
        t=$(texts "$MARK_HEAD" "$f" | sort -u)
        if [ -z "$t" ]; then echo "$name: 没有标识规则"; continue; fi
        [ "$(wc -l <<<"$t")" -eq 1 ] || { echo "$name: 标识规则有不同写法"; continue; }
        grep -qF '没跑过、没核对的一律不标 ✅' <<<"$t" || echo "$name: 标识规则没限定 ✅ 只给有证据的结论"
        if [ -z "$ref_mark" ]; then ref_mark="$t"; elif [ "$t" != "$ref_mark" ]; then echo "$name: 标识规则和 ${ALL[0]} 不一致"; fi
        if [ "$name" != review ]; then
            grep -qF -- "9. $MARK_HEAD" "$f" || echo "$name: 标识规则不在交人评论那段的第 9 条"
        fi
    done

    # 3. 首次 / 修订方案的版式（new-issue 第 2 步、issue-comment 方案迭代）
    for name in new-issue issue-comment; do
        f="$TMP/composed-$name.md"; [ -s "$f" ] || continue
        t=$(texts "$PLAN_HEAD" "$f" | sort -u)
        if [ -z "$t" ]; then echo "$name: 没有方案评论版式"; continue; fi
        [ "$(wc -l <<<"$t")" -eq 1 ] || { echo "$name: 方案评论版式有不同写法"; continue; }
        grep -qF '验收标准' <<<"$t" || echo "$name: 方案评论版式没把验收标准折叠"
        if [ -z "$ref_plan" ]; then ref_plan="$t"; elif [ "$t" != "$ref_plan" ]; then echo "$name: 方案评论版式和 new-issue 不一致"; fi
    done
    f="$TMP/composed-issue-comment.md"
    if [ -s "$f" ]; then
        sed -n '/^### § B\. 方案迭代/,/^### § C\./p' "$f" | grep -qF -- "$PLAN_HEAD" \
            || echo "issue-comment: 方案迭代那一步没有方案评论版式"
    fi

    # 4. 旧说法：「测试结果写进正文 / 整理进来」已改成「放本条的折叠块」
    for name in "${ALL[@]}"; do
        f="$TMP/composed-$name.md"; [ -s "$f" ] || continue
        grep -qF '测试结果整理进来' "$f" && echo "$name: 还留着「测试结果整理进来」"
        grep -qF '也写进交人评论正文' "$f" && echo "$name: 还留着「也写进交人评论正文」"
    done

    # 5. 复审：别的项目没有 review 增量，通用模板自己也得带版式、标识和打回依据
    local extra="$TMP/project/$EXTRA_REL"
    [ -f "$extra" ] && mv "$extra" "$extra.off"
    f=$(compose_prompt_template review 2>/dev/null)
    if [ -s "$f" ]; then
        cp "$f" "$TMP/composed-review-bare.md"; f="$TMP/composed-review-bare.md"
        texts "$REVIEW_HEAD" "$f" >/dev/null || echo "review（无项目增量）: 第 3 步没有评论版式"
        texts "$REVIEW_HEAD" "$f" | grep -qF '硬规则逐条核对' || echo "review（无项目增量）: 评论版式没把硬规则核对折叠"
        t=$(texts "$MARK_HEAD" "$f" | sort -u)
        if [ -z "$t" ]; then echo "review（无项目增量）: 没有标识规则"
        elif [ -n "$ref_mark" ] && [ "$t" != "$ref_mark" ]; then echo "review（无项目增量）: 标识规则和 worker 不一致"; fi
        grep -E '^2B\. ' "$f" | grep -qF '✅ 标在没有证据的结论上' || echo "review（无项目增量）: 打回依据 ⑧ 没管到版式和标识"
    else
        echo "review（无项目增量）: 拼不出 prompt"
    fi
    [ -f "$extra.off" ] && mv "$extra.off" "$extra"
}

echo "── 仓库现状：版式与标识规矩在每份成品里都在、逐字一致 ──"
make_sandbox
out=$(check_prompts)
if [ -z "$out" ]; then ok "全部满足"; else bad "仓库现状不满足："; sed 's/^/       /' <<<"$out"; fi

expect_red() {   # <说明> <期望出现的报错片段>
    out=$(check_prompts)
    if grep -qF -- "$2" <<<"$out"; then ok "负对照：$1 → 被拦下"
    else bad "负对照：$1 → 没被拦下（输出：${out:-空}）"; fi
}

mutation_on && echo "── 负对照 ──"
neg_sandbox() { mutation_gate || return 1; make_sandbox; }
SANDBOXES_BEFORE_NEG=$SANDBOXES

for name in new-issue issue-comment pr-comment; do
    neg_sandbox || continue
    sed -i '/^7\. \*\*外面只放要人看的，其余折叠\*\*/c 7. **过程留痕折叠**。历史轮次、长命令输出、逐条日志放进 `<details>`，主文只留当前结论。' "$SKILL_DIR/prompts/$name.template.md"
    expect_red "$name 第 7 条退回旧的一句话" "$name: 没有折叠规则"
done

if neg_sandbox; then
sed -i '/^7\. \*\*外面只放要人看的/s/判据是内容性质不是长度/判据是长度/' "$TMP/project/$EXTRA_REL"
expect_red "review 增量第 7 条改了一个词" "review: 折叠规则缺判据"
fi

for name in new-issue issue-comment pr-comment; do
    neg_sandbox || continue
    sed -i '/^9\. \*\*用 ❌ \/ ✅ \/ ⚠️ 标出每条结论\*\*/d' "$SKILL_DIR/prompts/$name.template.md"
    expect_red "$name 少了标识规则" "$name: 没有标识规则"
done

if neg_sandbox; then
sed -i '/\*\*用 ❌ \/ ✅ \/ ⚠️ 标出每条结论\*\*/s/没跑过、没核对的一律不标 ✅/没跑过的尽量不标 ✅/' "$SKILL_DIR/prompts/issue-comment.template.md"
expect_red "issue-comment 标识规则放宽 ✅" "issue-comment: 标识规则没限定 ✅ 只给有证据的结论"
fi

if neg_sandbox; then
sed -i '/\*\*用 ❌ \/ ✅ \/ ⚠️ 标出每条结论\*\*/d' "$SKILL_DIR/prompts/review.template.md"
expect_red "通用 review 模板少了标识规则" "review（无项目增量）: 没有标识规则"
fi

for name in new-issue issue-comment; do
    neg_sandbox || continue
    sed -i '/\*\*方案评论版式（外面只放要人看的，其余折叠）\*\*/d' "$SKILL_DIR/prompts/$name.template.md"
    expect_red "$name 少了方案评论版式" "$name: 没有方案评论版式"
done

if neg_sandbox; then
sed -i '/\*\*方案评论版式（外面只放要人看的，其余折叠）\*\*/s/、验收标准//' "$SKILL_DIR/prompts/new-issue.template.md"
expect_red "new-issue 方案版式不折叠验收标准" "new-issue: 方案评论版式没把验收标准折叠"
fi

if neg_sandbox; then
sed -i '/\*\*评论版式（外面只放要人看的，其余折叠）\*\*/d' "$SKILL_DIR/prompts/review.template.md"
expect_red "通用 review 模板少了评论版式" "review（无项目增量）: 第 3 步没有评论版式"
fi

if neg_sandbox; then
sed -i '/^2B\. /s/、或 ✅ 标在没有证据的结论上//' "$SKILL_DIR/prompts/review.template.md"
expect_red "打回依据 ⑧ 没管到标识" "review（无项目增量）: 打回依据 ⑧ 没管到版式和标识"
fi

if neg_sandbox; then
sed -i 's/也写进这条交人评论/也写进交人评论正文/' "$SKILL_DIR/prompts/pr-comment.template.md"
expect_red "pr-comment 退回「写进正文」" "pr-comment: 还留着「也写进交人评论正文」"
fi

if neg_sandbox; then
sed -i '/^8\. \*\*自包含/s/测试结果整理进这一条（[^）]*）/测试结果整理进来/' "$SKILL_DIR/prompts/new-issue.template.md"
expect_red "new-issue 第 8 条退回「整理进来」" "new-issue: 还留着「测试结果整理进来」"
fi

echo
neg_sandboxes=$((SANDBOXES - SANDBOXES_BEFORE_NEG))
if mutation_on; then
    if [ "$neg_sandboxes" -gt 0 ]; then ok "开关打开：负对照区建了 $neg_sandboxes 个沙盘"
    else bad "开关打开：负对照区一个沙盘都没建（负对照没真跑）"; fi
else
    if [ "$neg_sandboxes" -eq 0 ]; then ok "默认模式：负对照区一个沙盘都没建、没改模板"
    else bad "默认模式：负对照区仍建了 $neg_sandboxes 个沙盘（开关放在准备之后）"; fi
fi
mutation_summary "$0"
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
