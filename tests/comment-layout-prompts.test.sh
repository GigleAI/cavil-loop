#!/usr/bin/env bash
# 评论版式规矩：外面只放要人看的、其余折叠；❌ / ✅ / ⚠️ 默认不标，只标要人看的那几条。
#
# 跑法：bash tests/comment-layout-prompts.test.sh（MUTATION=1 连负对照一起跑）
# 依赖：无。用仓库自带的真实模板，走 daemon 真正拼 prompt 的 compose_prompt_template。
#
# 为什么要有这个文件：以前默认模板对版式只有一句「过程留痕折叠」，没说哪些放外面、
# 哪些折叠，worker 的方案评论于是整篇摊开（有接入项目的方案 120 行、第 100 行才出现第一个
# 折叠块）。同一套规矩写在多份模板里：三份 worker 模板「交人评论怎么写」的第 7、9 条，
# 首次 / 修订方案那一步的「方案评论版式」，复审模板第 3 步的「评论版式」和打回依据 ⑧，
# 以及本项目自己的 review 增量。只改其中一处不会报错，只会让别的环节照样发出整篇摊开的评论。
#
# GitHub#125：旧标识规则要求「标在每条结论、每节标题或验收项的开头」，worker 于是给「本项目暂无
# 硬规则」这种没有事项的说明也挂 ⚠️、放在外面。改成默认不标：⚠️ 只给「要人采取行动 / 会影响人判断」
# 的事，✅ 只给「本该做、做了、人得知道做对了」的事。复审打回依据 ⑧ 用同一判据的反面——打回条件
# 一旦退化成「没有要人处理的事」（只看动作），就会误伤「无需动手但影响判断」的真实限制，这里专门拦。
# 两份 worker 模板的硬规则核对表也要求整张折叠。
# 所以按拼好的成品对拍：每处都在、逐字一致；旧的「测试结果写进正文」说法已改掉；
# 再对每个写入点各造一个负对照（含第 8 条新说法、修订记录折叠、打回依据 ⑧ 的每个条件，
# 以及「通用 review 模板那份还在、增量自己的第 9 条没了」），确认少了哪一处这里都会红。
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
MARK_HEAD='**❌ / ✅ / ⚠️ 默认不标，只标要人看的那几条**'
OLD_MARK_EVERY='标在每条结论、每节标题或验收项的开头'
OLD_MARK_HEAD='标出每条结论**'
MARK_DEFAULT='只标在需要标的那一条开头，一处一个；不需要标的就不标'
WARN_ALLOW='⚠️ 只标两类事：要人采取行动的事（拍板、动手、确认），或无需动手、但人需要知道且会影响其判断的真实风险 \/ 限制 \/ 未验证范围'
WARN_EMPTY='「本项目暂无硬规则」「本次不需要新测试」「某项不适用」这类没有事项的说明不标'
OK_ONLY='✅ 只标本该做、做了、而且人得知道它做对了的事'
TITLE_EXEMPT='复审结论标题以 ✅ \/ ❌ 开头是另一条专门约定，不受「默认不标」影响'
WARN_REJECT='⚠️ 标在既不要人采取行动、也不影响人判断的内容上'
WARN_REJECT_ACTION_ONLY='没有要人处理的事'
OK_REJECT='✅ 撒在不需要人确认的普通描述上'
REVIEW_OMIT='只放要人采取行动或会影响人判断的事；没有就整节省掉'
HR_FOLD='这张表是自审证据，整张放进折叠块'
# 带 / 的短语在 sed 里要转义，grep 前还原
unesc() { sed 's#\\/#/#g' <<<"$1"; }
PLAN_HEAD='**方案评论版式（外面只放要人看的，其余折叠）**'
REVIEW_HEAD='**评论版式（外面只放要人看的，其余折叠）**'
ITEM8_NEW='测试结果整理进这一条（要人处理的放折叠区外，测试证据和过程放本条的折叠块）'
REVISION_LINE='修订版里「这一版比上一版改了什么」同样是过程，放进折叠块'
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

    # 2. ❌ / ✅ / ⚠️ 标识规则：四份成品都有、逐字一致；worker 和本项目 review 增量都在第 9 条
    #    （通用 review 模板那份不带编号，所以 review 成品里的「9.」只可能来自增量自己——
    #     先去重再比较会让通用段的同文规则盖住增量缺失，这里单独查编号那一份）
    for name in "${ALL[@]}"; do
        f="$TMP/composed-$name.md"; [ -s "$f" ] || continue
        if grep -qF -- "$OLD_MARK_EVERY" "$f" || grep -qF -- "$OLD_MARK_HEAD" "$f"; then
            echo "$name: 标识规则还要求每条 / 每节都标"
        fi
        t=$(texts "$MARK_HEAD" "$f" | sort -u)
        if [ -z "$t" ]; then echo "$name: 没有标识规则"; continue; fi
        [ "$(wc -l <<<"$t")" -eq 1 ] || { echo "$name: 标识规则有不同写法"; continue; }
        grep -qF '没跑过、没核对的一律不标 ✅' <<<"$t" || echo "$name: 标识规则没限定 ✅ 只给有证据的结论"
        grep -qF -- "$MARK_DEFAULT" <<<"$t" || echo "$name: 标识规则没写默认不标"
        grep -qF -- "$(unesc "$WARN_ALLOW")" <<<"$t" || echo "$name: 标识规则没写 ⚠️ 只标两类事"
        grep -qF -- "$WARN_EMPTY" <<<"$t" || echo "$name: 标识规则没写没有事项的说明不标"
        grep -qF -- "$OK_ONLY" <<<"$t" || echo "$name: 标识规则没收紧 ✅ 到须告知做对的事"
        grep -qF -- "$(unesc "$TITLE_EXEMPT")" <<<"$t" || echo "$name: 标识规则没保留复审标题的 ✅ / ❌"
        if [ -z "$ref_mark" ]; then ref_mark="$t"; elif [ "$t" != "$ref_mark" ]; then echo "$name: 标识规则和 ${ALL[0]} 不一致"; fi
        grep -qF -- "9. $MARK_HEAD" "$f" || echo "$name: 标识规则不在交人评论那段的第 9 条"
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
        sed -n '/^### § B\. 方案迭代/,/^### § C\./p' "$f" | grep -qF -- "$REVISION_LINE" \
            || echo "issue-comment: 方案迭代没要求把修订记录折叠"
    fi

    # 4. 旧说法：「测试结果写进正文 / 整理进来」已改成「放本条的折叠块」
    for name in "${ALL[@]}"; do
        f="$TMP/composed-$name.md"; [ -s "$f" ] || continue
        grep -qF '测试结果整理进来' "$f" && echo "$name: 还留着「测试结果整理进来」"
        grep -qF '也写进交人评论正文' "$f" && echo "$name: 还留着「也写进交人评论正文」"
        # 只查旧说法没了，整行删掉也算过；所以再查新说法确实在第 8 条里
        grep -E '^8\. \*\*自包含' "$f" | grep -qF -- "$ITEM8_NEW" || echo "$name: 第 8 条没写测试证据放折叠块"
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
        grep -E '^2B\. ' "$f" | grep -qF -- "$WARN_REJECT" || echo "review（无项目增量）: 打回依据 ⑧ 没管到乱标 ⚠️"
        grep -E '^2B\. ' "$f" | grep -qF -- "$WARN_REJECT_ACTION_ONLY" \
            && echo "review（无项目增量）: 打回依据 ⑧ 只看有没有动作，会误伤影响判断的限制"
        grep -E '^2B\. ' "$f" | grep -qF -- "$OK_REJECT" || echo "review（无项目增量）: 打回依据 ⑧ 没管到乱撒 ✅"
        texts "$REVIEW_HEAD" "$f" | grep -qF -- "$REVIEW_OMIT" || echo "review（无项目增量）: 评论版式没写无提醒事项时省掉那一节"
        grep -qF '**结论评论的标题以 ✅ / ❌ 开头**' "$f" || echo "review（无项目增量）: 结论标题 ✅ / ❌ 的约定没了"
        if grep -qF -- "$OLD_MARK_EVERY" "$f" || grep -qF -- "$OLD_MARK_HEAD" "$f"; then
            echo "review（无项目增量）: 标识规则还要求每条 / 每节都标"
        fi
        grep -E '^2B\. ' "$f" | grep -qF '缺开头那句说明' || echo "review（无项目增量）: 打回依据 ⑧ 没管到开头说明"
        grep -E '^2B\. ' "$f" | grep -qF '外面混进过程叙述（' || echo "review（无项目增量）: 打回依据 ⑧ 没管到外面混进过程"
        grep -E '^交人评论（通过，或轮次已尽交人）' "$f" | grep -qF -- "$ITEM8_NEW" \
            || echo "review（无项目增量）: 交人评论自包含没写测试证据放折叠块"
    else
        echo "review（无项目增量）: 拼不出 prompt"
    fi
    [ -f "$extra.off" ] && mv "$extra.off" "$extra"

    # 6. 两份会交代码的 worker 模板：硬规则核对表（含「本项目暂无硬规则」）整张折叠
    local ref_hr=""
    for name in issue-comment pr-comment; do
        f="$TMP/composed-$name.md"; [ -s "$f" ] || continue
        t=$(sed -n '/^## 有代码产出时：逐条核对硬规则/,/^## 交人评论怎么写/p' "$f" | grep -F -- "$HR_FOLD")
        if [ -z "$t" ]; then echo "$name: 硬规则核对表没要求整张折叠"; continue; fi
        grep -qF '本项目暂无硬规则」这句同样放进折叠块，不加任何标识' <<<"$t" \
            || echo "$name: 没写「本项目暂无硬规则」也折叠、不标"
        if [ -z "$ref_hr" ]; then ref_hr="$t"; elif [ "$t" != "$ref_hr" ]; then echo "$name: 硬规则折叠要求和 issue-comment 不一致"; fi
    done
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
    sed -i '/^9\. \*\*❌ \/ ✅ \/ ⚠️ 默认不标/d' "$SKILL_DIR/prompts/$name.template.md"
    expect_red "$name 少了标识规则" "$name: 没有标识规则"
done

if neg_sandbox; then
sed -i '/^9\. \*\*❌ \/ ✅ \/ ⚠️ 默认不标/d' "$TMP/project/$EXTRA_REL"
expect_red "review 增量少了第 9 条标识规则（通用模板那份仍在）" "review: 标识规则不在交人评论那段的第 9 条"
fi

if neg_sandbox; then
sed -i '/\*\*❌ \/ ✅ \/ ⚠️ 默认不标/s/没跑过、没核对的一律不标 ✅/没跑过的尽量不标 ✅/' "$SKILL_DIR/prompts/issue-comment.template.md"
expect_red "issue-comment 标识规则放宽 ✅" "issue-comment: 标识规则没限定 ✅ 只给有证据的结论"
fi

if neg_sandbox; then
sed -i '/\*\*❌ \/ ✅ \/ ⚠️ 默认不标/d' "$SKILL_DIR/prompts/review.template.md"
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
sed -i '/修订版里「这一版比上一版改了什么」同样是过程/d' "$SKILL_DIR/prompts/issue-comment.template.md"
expect_red "issue-comment 方案迭代少了修订记录折叠" "issue-comment: 方案迭代没要求把修订记录折叠"
fi

if neg_sandbox; then
sed -i '/\*\*评论版式（外面只放要人看的，其余折叠）\*\*/s/、硬规则逐条核对//' "$SKILL_DIR/prompts/review.template.md"
expect_red "通用 review 评论版式不折叠硬规则核对" "review（无项目增量）: 评论版式没把硬规则核对折叠"
fi

if neg_sandbox; then
sed -i '/\*\*评论版式（外面只放要人看的，其余折叠）\*\*/d' "$SKILL_DIR/prompts/review.template.md"
expect_red "通用 review 模板少了评论版式" "review（无项目增量）: 第 3 步没有评论版式"
fi

if neg_sandbox; then
sed -i '/^2B\. /s/、✅ 标在没有证据的结论上//' "$SKILL_DIR/prompts/review.template.md"
expect_red "打回依据 ⑧ 没管到标识" "review（无项目增量）: 打回依据 ⑧ 没管到版式和标识"
fi

if neg_sandbox; then
sed -i '/^2B\. /s/缺开头那句说明、//' "$SKILL_DIR/prompts/review.template.md"
expect_red "打回依据 ⑧ 不管开头说明" "review（无项目增量）: 打回依据 ⑧ 没管到开头说明"
fi

if neg_sandbox; then
sed -i '/^2B\. /s/外面混进过程叙述（试了哪些写法、怎么一步步推导的、版本之间改了什么）、//' "$SKILL_DIR/prompts/review.template.md"
expect_red "打回依据 ⑧ 不管外面混进过程" "review（无项目增量）: 打回依据 ⑧ 没管到外面混进过程"
fi

if neg_sandbox; then   # 复审给的退化：两项具体条件合成一句含糊的「其他版式问题」
sed -i '/^2B\. /s/缺开头那句说明、外面混进过程叙述（试了哪些写法、怎么一步步推导的、版本之间改了什么）/其他版式问题/' "$SKILL_DIR/prompts/review.template.md"
expect_red "打回依据 ⑧ 退化成「其他版式问题」" "review（无项目增量）: 打回依据 ⑧ 没管到开头说明"
fi

if neg_sandbox; then
sed -i 's/也写进这条交人评论/也写进交人评论正文/' "$SKILL_DIR/prompts/pr-comment.template.md"
expect_red "pr-comment 退回「写进正文」" "pr-comment: 还留着「也写进交人评论正文」"
fi

if neg_sandbox; then
sed -i '/^8\. \*\*自包含/s/测试结果整理进这一条（[^）]*）/测试结果整理进来/' "$SKILL_DIR/prompts/new-issue.template.md"
expect_red "new-issue 第 8 条退回「整理进来」" "new-issue: 还留着「测试结果整理进来」"
fi

# 第 8 条新说法：每个写入点各删一次（整句删掉，旧说法检查拦不住）
for name in new-issue issue-comment pr-comment; do
    neg_sandbox || continue
    sed -i "/^8\. \*\*自包含/s/$ITEM8_NEW//" "$SKILL_DIR/prompts/$name.template.md"
    expect_red "$name 第 8 条丢了测试证据放折叠块" "$name: 第 8 条没写测试证据放折叠块"
done

if neg_sandbox; then
sed -i "/^8\. \*\*自包含/s/$ITEM8_NEW//" "$TMP/project/$EXTRA_REL"
expect_red "review 增量第 8 条丢了测试证据放折叠块" "review: 第 8 条没写测试证据放折叠块"
fi

if neg_sandbox; then
sed -i "/^交人评论（通过，或轮次已尽交人）/s/$ITEM8_NEW//" "$SKILL_DIR/prompts/review.template.md"
expect_red "通用 review 交人评论丢了测试证据放折叠块" "review（无项目增量）: 交人评论自包含没写测试证据放折叠块"
fi

# ── GitHub#125：默认不标 ──
# 每个写入点各自退回旧的「每节都标」
for name in new-issue issue-comment pr-comment; do
    neg_sandbox || continue
    sed -i "/^9\. \*\*❌ \/ ✅ \/ ⚠️ 默认不标/s/$MARK_DEFAULT/$OLD_MARK_EVERY/" "$SKILL_DIR/prompts/$name.template.md"
    expect_red "$name 标识规则退回「每节都标」" "$name: 标识规则还要求每条 / 每节都标"
done
if neg_sandbox; then
sed -i "/^9\. \*\*❌ \/ ✅ \/ ⚠️ 默认不标/s/$MARK_DEFAULT/$OLD_MARK_EVERY/" "$TMP/project/$EXTRA_REL"
expect_red "review 增量标识规则退回「每节都标」" "review: 标识规则还要求每条 / 每节都标"
fi
if neg_sandbox; then
sed -i "/\*\*❌ \/ ✅ \/ ⚠️ 默认不标/s/$MARK_DEFAULT/$OLD_MARK_EVERY/" "$SKILL_DIR/prompts/review.template.md"
expect_red "通用 review 标识规则退回「每节都标」" "review（无项目增量）: 标识规则还要求每条 / 每节都标"
fi
if neg_sandbox; then   # 整行换回旧版（旧标题 + 旧正文）
OLD_LINE='9. **用 ❌ / ✅ / ⚠️ 标出每条结论**。❌ = 有问题（打回的点、测试红、做不到或被拦住的项）；✅ = 没问题，只用在有实际证据的结论上（跑过的测试、核对过的事实），没跑过、没核对的一律不标 ✅；⚠️ = 要人注意（已知限制、风险、尚未验证、要人确认或动手的事）。标在每条结论、每节标题或验收项的开头，一处一个，人扫一眼就分得出重点；正文叙述里不乱撒。'
python3 -c '
import sys; p, old = sys.argv[1], sys.argv[2]
L = open(p).read().split("\n")
L = [old if l.startswith("9. **❌ / ✅ / ⚠️ 默认不标") else l for l in L]
open(p, "w").write("\n".join(L))
' "$SKILL_DIR/prompts/pr-comment.template.md" "$OLD_LINE"
expect_red "pr-comment 整条换回旧标识规则" "pr-comment: 标识规则还要求每条 / 每节都标"
fi
# 各判据从一个写入点改坏
if neg_sandbox; then
sed -i "/^9\. \*\*❌ \/ ✅ \/ ⚠️ 默认不标/s/$WARN_ALLOW/⚠️ = 要人注意/" "$SKILL_DIR/prompts/new-issue.template.md"
expect_red "new-issue ⚠️ 退回「要人注意」" "new-issue: 标识规则没写 ⚠️ 只标两类事"
fi
if neg_sandbox; then
sed -i "/^9\. \*\*❌ \/ ✅ \/ ⚠️ 默认不标/s/$WARN_EMPTY/X/" "$SKILL_DIR/prompts/issue-comment.template.md"
expect_red "issue-comment 丢了无事项说明不标" "issue-comment: 标识规则没写没有事项的说明不标"
fi
if neg_sandbox; then
sed -i "/^9\. \*\*❌ \/ ✅ \/ ⚠️ 默认不标/s/$OK_ONLY/✅ = 没问题/" "$TMP/project/$EXTRA_REL"
expect_red "review 增量 ✅ 退回「没问题」（与通用那份不再一致）" "review: 标识规则有不同写法"
fi
if neg_sandbox; then
sed -i "/\*\*❌ \/ ✅ \/ ⚠️ 默认不标/s/$TITLE_EXEMPT//" "$SKILL_DIR/prompts/review.template.md"
expect_red "通用 review 丢了标题 ✅ / ❌ 例外" "review（无项目增量）: 标识规则和 worker 不一致"
fi
if neg_sandbox; then
sed -i 's/\*\*结论评论的标题以 ✅ \/ ❌ 开头\*\*/结论评论的标题随意/' "$SKILL_DIR/prompts/review.template.md"
expect_red "通用 review 丢了结论标题约定" "review（无项目增量）: 结论标题 ✅ / ❌ 的约定没了"
fi
# 打回依据 ⑧
if neg_sandbox; then   # 退化成只看有没有动作（方案第 1 轮复审指出的矛盾）
sed -i "/^2B\. /s/$WARN_REJECT/⚠️ 标在$WARN_REJECT_ACTION_ONLY上/" "$SKILL_DIR/prompts/review.template.md"
expect_red "打回依据 ⑧ 退化成只看动作" "review（无项目增量）: 打回依据 ⑧ 只看有没有动作，会误伤影响判断的限制"
fi
if neg_sandbox; then
sed -i "/^2B\. /s/、或 $WARN_REJECT//" "$SKILL_DIR/prompts/review.template.md"
expect_red "打回依据 ⑧ 不管乱标 ⚠️" "review（无项目增量）: 打回依据 ⑧ 没管到乱标 ⚠️"
fi
if neg_sandbox; then
sed -i "/^2B\. /s/、$OK_REJECT//" "$SKILL_DIR/prompts/review.template.md"
expect_red "打回依据 ⑧ 不管乱撒 ✅" "review（无项目增量）: 打回依据 ⑧ 没管到乱撒 ✅"
fi
if neg_sandbox; then
sed -i "/\*\*评论版式（外面只放要人看的，其余折叠）\*\*/s/$REVIEW_OMIT//" "$SKILL_DIR/prompts/review.template.md"
expect_red "通用 review 版式丢了「没有就整节省掉」" "review（无项目增量）: 评论版式没写无提醒事项时省掉那一节"
fi
# 硬规则核对表折叠
for name in issue-comment pr-comment; do
    neg_sandbox || continue
    sed -i "/$HR_FOLD/d" "$SKILL_DIR/prompts/$name.template.md"
    expect_red "$name 硬规则核对表不再要求折叠" "$name: 硬规则核对表没要求整张折叠"
done
if neg_sandbox; then
sed -i "/$HR_FOLD/s/，不加任何标识//" "$SKILL_DIR/prompts/pr-comment.template.md"
expect_red "pr-comment「暂无硬规则」折叠但没说不标" "pr-comment: 没写「本项目暂无硬规则」也折叠、不标"
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
