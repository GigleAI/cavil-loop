#!/usr/bin/env bash
# kind: guard
# 交人评论的几条版式规矩（GitHub#238）：设计 / 样式选择题配真实渲染的样例图（GitHub#335：方案
# 只要会改变界面外观就必须附设计稿，有没有选择题都要，复审缺图打回）、回复人时先引用
# 人这一轮的原话（引用在前、标题在后）、issue 侧也带「本轮问题与回答」、复审检查这几项版式、
# 复审交人前收拢未答问题并按完整骨架写、先向外部需求机器人汇报时交维护者合并前附合并说明。
#
# 跑法：bash tests/reply-layout-prompts.test.sh（MUTATION=1 连负对照一起跑）
# 依赖：无。用仓库自带的真实模板，走 daemon 真正拼 prompt 的 compose_prompt_template；
# 占位符的替换起真实派工脚本（假 gh / 假 tmux）读它写出的 prompt。
#
# 为什么要有这个文件：同一条规矩逐字复制在多份模板里（配图三份 worker 模板、引用规矩两份
# worker 模板加复审模板、「引用块之后第一行是标题」四份交人评论第 1 条），只改其中一处不会报错，
# 只会让那一个环节照旧发出没图、没引用的评论。所以按「规矩 × 入口」矩阵逐格断言：该在的在、
# 不该在的不在、多份副本逐字一致、旧的互相冲突的说法（「第一个看得见的行是标题」「没有图就不
# 生成」）一处都不剩；负对照按格子做——只删一个入口的那一份，其余入口原样，要求那一格变红。
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"
# 在 worker 里跑时环境里带着派工变量（例如托管标记），会让拼出的提示词多出托管段：先清掉
# shellcheck disable=SC2046
unset $(compgen -v DISPATCH_)
# 同理：worker 环境里的 CODING_AGENT_RELEASE_ROOT 会让被测的 _lib.sh 改用装好的那份 scripts/
unset CODING_AGENT_RELEASE_ROOT

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
TMUX_PREFIX="replytest"
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

MOCK_H='## 界面改动配设计稿、选择题配样例图'
MOCK_REF='「界面改动配设计稿、选择题配样例图」'
DESIGN_MUST='就必须附设计稿，有没有选择题都要'
QUOTE_H='## 回复人时先引用人这一轮说的话'
QA_H='## 交人评论必须带上人工问题的最终回答'
HAND_H='## 交人评论（通过，或轮次已尽交人）：先收拢未答问题，再按完整骨架写'
ITEM1='1. **引用块之后第一行是 `##` 标题**'
L2_HEAD='2L. **worker 交人评论的版式（A、B 两类都看）**'
STEP3_NEW='机器标记和引用块（如有，见「回复人时先引用人这一轮说的话」）之后的第一行是 `##` 标题'
PR_IMG_LIMIT='- 这条只管交付后的交人评论：前文没有相关图片时，不为满足这条规则额外生成设计图；方案（含修订版）会改变界面外观、或回复里有要人拍板的界面 / 样式选择题时，照「界面改动配设计稿、选择题配样例图」配图，不适用这句。'
# 旧的、和「引用在前」或「设计阶段要配图」冲突的说法：成品里一处都不能剩
OLD_PHRASES=(
    '评论第一个看得见的行是 `##` 标题'
    '1. **开头一行 `##` 标题**'
    '没有图就不生成'
    '界面 / 样式选择题配样例图'
)

# 一节：从标题行截到下一个同级（## ）标题之前
section() { awk -v h="$1" '$0==h{on=1; print; next} on&&/^## /{exit} on{print}' "$2"; }
has() { grep -qF -- "$1" <<<"$2"; }

# 入口：五份成品。review 拼两次——带本项目的复审增量、不带（别的项目没有增量）
ENTRIES=(new-issue issue-comment pr-comment review review-noextra)
compose_all() {
    local name f
    for name in new-issue issue-comment pr-comment review; do
        f=$(compose_prompt_template "$name" 2>/dev/null)
        if [ -s "$f" ]; then cp "$f" "$TMP/c-$name.md"; else : > "$TMP/c-$name.md"; fi
    done
    mv "$TMP/project/$EXTRA_REL" "$TMP/extra.bak"
    f=$(compose_prompt_template review 2>/dev/null)
    if [ -s "$f" ]; then cp "$f" "$TMP/c-review-noextra.md"; else : > "$TMP/c-review-noextra.md"; fi
    mv "$TMP/extra.bak" "$TMP/project/$EXTRA_REL"
}

# 打印发现的问题，一行一条；空输出 = 全部满足
check_prompts() {
    compose_all
    local e f s ref p
    for e in "${ENTRIES[@]}"; do [ -s "$TMP/c-$e.md" ] || echo "$e: 拼不出 prompt"; done

    # 【1】配样例图：三份 worker 成品有、逐字一致；复审没有（复审只检查，见【5】）
    ref=""
    for e in new-issue issue-comment pr-comment; do
        f="$TMP/c-$e.md"; s=$(section "$MOCK_H" "$f")
        if [ -z "$s" ]; then echo "$e: 没有配样例图规矩"; continue; fi
        has '**不许用 ASCII 线框代替**' "$s" || echo "$e: 配图规矩没禁 ASCII 线框"
        has '每个候选项配一张真实渲染的样例图' "$s" || echo "$e: 配图规矩没要求每个候选项配图"
        has '「本项目未配置出图地址，无法内嵌图片」' "$s" || echo "$e: 配图规矩缺没配出图地址时的说法"
        has '改用文字逐项描述改前改后的差异、候选之间的差异' "$s" || echo "$e: 没配出图地址时没要求文字描述改前改后的差异"
        # GitHub#335：方案改界面外观就附设计稿，不看有没有选择题；托管同样适用；出图安全规矩只引用不另写
        has "$DESIGN_MUST" "$s" || echo "$e: 配图规矩没要求改界面外观的方案附设计稿"
        has '改既有界面 → 改前截图（标出要改的地方）+ 改后设计稿；全新界面 → 设计稿' "$s" || echo "$e: 配图规矩没分改既有界面 / 全新界面"
        has '托管条目同样适用' "$s" || echo "$e: 配图规矩没写托管条目同样适用"
        has '纯后端、没有可见界面变化的方案不适用' "$s" || echo "$e: 设计稿规矩缺不适用范围"
        has '照下方「评论配图标准」' "$s" || echo "$e: 配图规矩没引用评论配图标准"
        has 'public-assets/check.mjs' "$s" && echo "$e: 配图规矩里另写了一份发图前自查"
        [ "$(grep -cF -- '- **评论配图标准（' "$f")" = 1 ] || echo "$e: 成品里评论配图标准不是恰好一条"
        [ "$(grep -cF 'public-assets/check.mjs' "$f")" = 1 ] || echo "$e: 成品里发图前自查不是恰好一处"
        has '这不是豁免' "$s" || echo "$e: 配图规矩把出不了图当成豁免"
        has '翻 `${LABEL_PENDING_HUMAN}` 交人' "$s" || echo "$e: 配图规矩出不了图时没交人"
        has '纯后端、没有可见样式差异的决策不适用' "$s" || echo "$e: 配图规矩缺不适用范围"
        has '`${REVIEW_ASSET_BASE_URL}`' "$s" || echo "$e: 配图规矩没给出图地址"
        has 'scripts/review-screenshot.mjs' "$s" || echo "$e: 配图规矩没指截图脚本"
        if [ -z "$ref" ]; then ref="$s"; elif [ "$s" != "$ref" ]; then echo "$e: 配图规矩和 new-issue 不一致"; fi
    done
    for e in review review-noextra; do
        grep -qxF -- "$MOCK_H" "$TMP/c-$e.md" && echo "$e: 复审成品里出现了 worker 的配图规矩"
    done
    # 各入口指向这一节的那一行：首次方案的「UI / 交互」、issue 回复的修订版、PR 回复的交付后设计图
    s=$(grep -F -- '- **UI / 交互**（如适用）' "$TMP/c-new-issue.md")
    { has "$DESIGN_MUST" "$s" && has "$MOCK_REF" "$s"; } || echo "new-issue: 方案的 UI / 交互一行没要求改界面外观附设计稿"
    s=$(grep -F -- '修订版开头先引用人这一轮说的话' "$TMP/c-issue-comment.md")
    { has "$DESIGN_MUST" "$s" && has "$MOCK_REF" "$s"; } || echo "issue-comment: 修订版一行没要求改界面外观附设计稿"

    # 【2】引用人的原话：issue 回复、PR 回复、复审（两种）有、逐字一致；首次方案没有（还没人回过话）
    ref=""
    for e in issue-comment pr-comment review review-noextra; do
        f="$TMP/c-$e.md"; s=$(section "$QUOTE_H" "$f")
        if [ -z "$s" ]; then echo "$e: 没有引用规矩"; continue; fi
        has '人留下的**所有**评论——issue 对话、PR 对话、行内代码评论、review 正文' "$s" || echo "$e: 引用规矩没覆盖四种评论"
        has '每条最多 12 行' "$s" || echo "$e: 引用规矩没限 12 行"
        has '「…（[原文](链接)）」' "$s" || echo "$e: 引用规矩没写超长怎么收尾"
        has '`@账号 说`' "$s" || echo "$e: 引用规矩没要求写明谁说的"
        has '「人勾了 Q1 = B」' "$s" || echo "$e: 引用规矩没写只勾选时怎么写"
        has '引用块放在评论最前面，`##` 标题紧跟其后' "$s" || echo "$e: 引用规矩没写引用在前、标题在后"
        has '引用块在机器标记之后、标题之前' "$s" || echo "$e: 引用规矩没写机器标记的位置"
        has '复审打回给 worker 的评论' "$s" || echo "$e: 引用规矩没排除复审打回"
        has '**绝不**把可疑原文抄进 bot 自己的评论' "$s" || echo "$e: 引用规矩没禁抄可疑原文"
        has '会对**每页**分别执行过滤器' "$s" || echo "$e: 引用规矩没提分页陷阱"
        if [ -z "$ref" ]; then ref="$s"; elif [ "$s" != "$ref" ]; then echo "$e: 引用规矩和 issue-comment 不一致"; fi
    done
    grep -qxF -- "$QUOTE_H" "$TMP/c-new-issue.md" && echo "new-issue: 首次方案里出现了引用规矩"

    # 【3】「引用块之后第一行是标题」：四份交人评论第 1 条逐字一致；复审第 3 步同一说法
    ref=""
    for e in new-issue issue-comment pr-comment review; do
        f="$TMP/c-$e.md"
        s=$(grep -F -A1 -- "$ITEM1" "$f")
        if [ -z "$s" ]; then echo "$e: 交人评论第 1 条没改成引用块之后是标题"; continue; fi
        has '回应人时的引用块（如有' "$s" || echo "$e: 第 1 条没写引用块在标题之前"
        if [ -z "$ref" ]; then ref="$s"; elif [ "$s" != "$ref" ]; then echo "$e: 第 1 条和 new-issue 不一致"; fi
    done
    for e in review review-noextra; do
        grep -qF -- "$STEP3_NEW" "$TMP/c-$e.md" || echo "$e: 第 3 步还没改成引用块之后是标题"
    done
    for e in "${ENTRIES[@]}"; do
        for p in "${OLD_PHRASES[@]}"; do
            grep -qF -- "$p" "$TMP/c-$e.md" && echo "$e: 还留着旧说法「$p」"
        done
    done

    # 【4】本轮问题与回答：issue 回复补上，规则条目和 PR 回复那段逐字一致；首次方案、复审不带这一节
    local qi qp
    qi=$(section "$QA_H" "$TMP/c-issue-comment.md"); qp=$(section "$QA_H" "$TMP/c-pr-comment.md")
    if [ -z "$qi" ]; then echo "issue-comment: 没有本轮问题与回答"
    else
        has '写「本轮问题与回答」' "$qi" || echo "issue-comment: 本轮问答没写在主文"
        has '`<details><summary>之前轮的问题与最终回答</summary>`' "$qi" || echo "issue-comment: 之前轮问答没折叠"
        has '链接不能代替答案' "$qi" || echo "issue-comment: 本轮问答没写链接不能代替答案"
        has '人在 agent 评论里的勾选' "$qi" || echo "issue-comment: 本轮问答没读勾选"
        if [ -z "$qp" ]; then echo "pr-comment: 没有本轮问题与回答"
        elif [ "$(sed -n '/^- 与当前交付相关/,$p' <<<"$qi")" != "$(sed -n '/^- 与当前交付相关/,$p' <<<"$qp")" ]; then
            echo "issue-comment: 本轮问答的规则条目和 pr-comment 不一致"
        fi
    fi
    for e in new-issue review review-noextra; do
        grep -qxF -- "$QA_H" "$TMP/c-$e.md" && echo "$e: 出现了 worker 的本轮问答一节"
    done

    # 【5】复审检查版式（两类产出都看）：三项；worker 成品里没有
    for e in review review-noextra; do
        f="$TMP/c-$e.md"; s=$(grep -F -- "$L2_HEAD" "$f")
        if [ -z "$s" ]; then echo "$e: 没有版式检查那一步"; continue; fi
        has '任一项不合格判不通过' "$s" || echo "$e: 版式检查没写不合格打回"
        has '却有候选项没配真实渲染的样例图' "$s" || echo "$e: 版式检查漏了缺样例图"
        has '`${REVIEW_ASSET_BASE_URL}`' "$s" || echo "$e: 版式检查没给出图地址"
        has '逐条对照下面四项' "$s" || echo "$e: 版式检查的项数没跟上"
        has '④ 方案（含修订版）会改变界面外观' "$s" || echo "$e: 版式检查漏了改界面外观的方案"
        has '有没有选择题都算，托管条目同样适用' "$s" || echo "$e: 版式检查的设计稿一项没写不看选择题 / 托管同样适用"
        has '配了出图地址却没附设计稿' "$s" || echo "$e: 版式检查漏了缺设计稿"
        has '缺「改前截图（标出要改的地方）」或「改后设计稿」任一张' "$s" || echo "$e: 版式检查没要求改前 / 改后都有"
        has '并用文字描述改前改后的差异，缺了同样不合格' "$s" || echo "$e: 版式检查缺没配出图地址时的退路"
        has '纯后端、没有可见界面变化的方案不适用 ④' "$s" || echo "$e: 版式检查的设计稿一项缺不适用范围"
        has '在标题前引用人这一轮的全部评论' "$s" || echo "$e: 版式检查漏了缺引用"
        has '过程叙述（试了哪些写法、怎么一步步推导的、版本之间改了什么）留在折叠区外' "$s" || echo "$e: 版式检查漏了过程叙述外露"
        [ "$(grep -nF -- "$L2_HEAD" "$f" | cut -d: -f1)" -lt "$(grep -nF '2C. **A 类下结论之前' "$f" | head -1 | cut -d: -f1)" ] \
            || echo "$e: 版式检查排在下结论之后"
    done
    for e in new-issue issue-comment pr-comment; do
        grep -qF -- "$L2_HEAD" "$TMP/c-$e.md" && echo "$e: worker 成品里出现了复审的版式检查"
    done

    # 【6】复审交人：收拢未答问题 + 完整骨架 + 格式硬要求；顺序要对
    for e in review review-noextra; do
        f="$TMP/c-$e.md"; s=$(section "$HAND_H" "$f")
        if [ -z "$s" ]; then echo "$e: 没有交人骨架"; continue; fi
        has '人**直接在 agent 的评论里勾选**' "$s" || echo "$e: 收拢未答问题漏了直接勾选"
        has '`updated_at`' "$s" || echo "$e: 收拢未答问题没看更新时间"
        has '「继续」这类笼统话的仍算未答' "$s" || echo "$e: 收拢未答问题没处理笼统回复"
        has '问题因方案改动已失效的不列' "$s" || echo "$e: 收拢未答问题没排除失效题"
        has '折叠块里贴代码用四反引号' "$s" || echo "$e: 骨架缺四反引号要求"
        has '不许写「见上方第 N 条」' "$s" || echo "$e: 骨架没禁「见上方第 N 条」"
        has '`<summary>` 后空一行' "$s" || echo "$e: 骨架缺 summary 后空一行"
        has '只限交付后的交人评论' "$s" || echo "$e: 不另造设计图没限定在交付后"
        has '但设计阶段方案会改变界面外观却没附设计稿、或有界面 / 样式选择题却没配样例图，按第 2L 步打回' "$s" || echo "$e: 不另造设计图的例外没带上缺设计稿"
        local prev=0 n item
        for item in '1. 轮次标记' '2. 引用块' '3. `##` 结论标题' '4. 两三句 brief' '5. 本轮问题与回答' \
                    '6. 相关设计图' '7. 「需要人注意 / 确认」' '8. 待人确认的问题' '9. 预览 / 设计稿链接' '10. 各折叠块'; do
            n=$(grep -nF -- "$item" <<<"$s" | head -1 | cut -d: -f1)
            if [ -z "$n" ]; then echo "$e: 骨架缺「$item」"
            elif [ "$n" -le "$prev" ]; then echo "$e: 骨架里「$item」顺序不对"
            else prev=$n; fi
        done
    done
    for e in new-issue issue-comment pr-comment; do
        grep -qxF -- "$HAND_H" "$TMP/c-$e.md" && echo "$e: worker 成品里出现了复审的交人骨架"
    done

    # 【7】PR 回复「交付后带上相关设计图」那段只管交付后，不再劝退设计阶段配图
    grep -qF -- "$PR_IMG_LIMIT" "$TMP/c-pr-comment.md" || echo "pr-comment: 交付后设计图那段没限定范围"
}

echo "── 仓库现状：规矩 × 入口逐格满足 ──"
make_sandbox
out=$(check_prompts)
if [ -z "$out" ]; then ok "全部满足"; else bad "仓库现状不满足："; sed 's/^/       /' <<<"$out"; fi

# ── 外部需求机器人：合并说明只在先汇报时出现，不先汇报时交接段逐字节不变 ──
echo "── 外部需求机器人交接段 ──"
# HOME 指到沙盘、清掉 CAVIL_DEPLOY_ROOT：本机装过托管版本时，叫醒命令会指向装好的那份脚本，
# 不装时指向被测那份 scripts/。不隔离的话，同一份测试在开发机和 CI 上比的不是同一个东西。
mkdir -p "$TMP/bot-home"
bot_env() {   # 在子 shell 里设好机器人配置后执行 "$@"
    env -u CAVIL_DEPLOY_ROOT HOME="$TMP/bot-home" \
    LABEL_PENDING_REQUESTER_BOT="pending/requester-bot" REQUESTER_BOT_ACCOUNT="req-bot" \
    REQUESTER_BOT_ALLOWED_ACTORS="req-bot" REQUESTER_BOT_ORIGIN_MARKER="<!-- from-req-bot -->" \
    REQUESTER_BOT_REPORT_FIRST="$1" "${@:2}"
}
MERGE_H='## 交维护者合并前先发合并说明（本项目要求先向机器人汇报）'
check_bot() {   # 打印问题；$1 = 被测 skill 目录
    local sd="$1" off on name f
    off=$(SKILL_DIR="$sd" bot_env false bash -c 'source "$0" >/dev/null 2>&1; set +e; SKILL_DIR="$1" requester_bot_handoff_section' \
        "$REPO_DIR/scripts/_lib.sh" "$sd" 2>/dev/null)
    on=$(SKILL_DIR="$sd" bot_env true bash -c 'source "$0" >/dev/null 2>&1; set +e; SKILL_DIR="$1" requester_bot_handoff_section' \
        "$REPO_DIR/scripts/_lib.sh" "$sd" 2>/dev/null)
    [ -n "$off" ] || echo "bot: 不先汇报时交接段是空的（没拼出来）"
    has "$MERGE_H" "$off" && echo "bot: 不先汇报时出现了合并说明"
    if ! has "$MERGE_H" "$on"; then echo "bot: 先汇报时没有合并说明"
    else
        s=$(awk -v h="$MERGE_H" '$0==h{on=1} on' <<<"$on")
        has '改了什么 / 怎么改 / 为什么' "$s" || echo "bot: 合并说明缺改动小表"
        has '合并后要做的事' "$s" || echo "bot: 合并说明缺合并后要做的事"
        has '不贴测试原文、不重复复审细节' "$s" || echo "bot: 合并说明没限篇幅"
        has '翻 `pending/human` 之前' "$s" || echo "bot: 合并说明标签没渲染或时机不对"
        grep -q '@@' <<<"$s" && echo "bot: 合并说明里有没换掉的占位"
    fi
    # 拼进每份成品：先汇报时每份都带（谁交维护者都要发），不先汇报时都不带
    for name in new-issue issue-comment pr-comment review; do
        f=$(SKILL_DIR="$sd" bot_env true bash -c 'source "$0" >/dev/null 2>&1; set +e; SKILL_DIR="$1"; compose_prompt_template "$2"' \
            "$REPO_DIR/scripts/_lib.sh" "$sd" "$name" 2>/dev/null)
        grep -qxF -- "$MERGE_H" "$f" 2>/dev/null || echo "bot: 先汇报时 $name 成品里没有合并说明"
        f=$(SKILL_DIR="$sd" bot_env false bash -c 'source "$0" >/dev/null 2>&1; set +e; SKILL_DIR="$1"; compose_prompt_template "$2"' \
            "$REPO_DIR/scripts/_lib.sh" "$sd" "$name" 2>/dev/null)
        [ -s "$f" ] || echo "bot: 不先汇报时 $name 拼不出 prompt"
        grep -qxF -- "$MERGE_H" "$f" 2>/dev/null && echo "bot: 不先汇报时 $name 成品里有合并说明"
    done
    # 叫醒命令里带着被测那份 scripts/ 的路径，两边各换成同一个占位再比
    printf '%s\n' "$off" | sed "s|$sd/scripts|<SCRIPTS>|g; s|$REPO_DIR/scripts|<SCRIPTS>|g" > "$TMP/bot-off.md"
}
make_sandbox
out=$(check_bot "$SKILL_DIR")
if [ -z "$out" ]; then ok "合并说明只在先汇报时出现，每份成品一致"; else bad "交接段不满足："; sed 's/^/       /' <<<"$out"; fi

# 不先汇报时：交接段和合并基点（改动前的 _lib.sh + 改动前的交接模板）逐字节相同
BASE_REV=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$REPO_DIR" rev-parse HEAD~1)
mkdir -p "$TMP/old"
git -C "$REPO_DIR" archive "$BASE_REV" scripts prompts | tar -x -C "$TMP/old"
old_off=$(bot_env false bash -c 'source "$0" >/dev/null 2>&1; set +e; SKILL_DIR="$1" requester_bot_handoff_section' \
    "$TMP/old/scripts/_lib.sh" "$TMP/old" 2>/dev/null)
if [ -z "$old_off" ]; then bad "合并基点 ${BASE_REV:0:8} 拼不出交接段（对拍没真跑）"
elif old_off=$(printf '%s\n' "$old_off" | sed "s|$TMP/old/scripts|<SCRIPTS>|g"); grep -qF "<SCRIPTS>/notify-requester-bot.sh" <<<"$old_off" \
     && [ "$old_off" = "$(cat "$TMP/bot-off.md")" ]; then ok "不先汇报时交接段和合并基点 ${BASE_REV:0:8} 逐字节相同"
else bad "不先汇报时交接段和合并基点不同："; diff <(printf '%s\n' "$old_off") "$TMP/bot-off.md" | head -10 | sed 's/^/       /'; fi

# ── 真实派工脚本把出图地址占位换掉（配了 / 没配两种） ──
echo "── 真实派工脚本渲染出图地址 ──"
DSB="$TMP/dispatch"
mkdir -p "$DSB/bin" "$DSB/home"
git init -q --bare "$DSB/upstream.git"
git clone -q "$DSB/upstream.git" "$DSB/seed" 2>/dev/null
(cd "$DSB/seed" && git config user.email t@example.invalid && git config user.name t \
    && echo x > f && git add f && git commit -qm init && git push -q origin HEAD:main) >/dev/null 2>&1
cat > "$DSB/bin/gh" <<'SH'
#!/usr/bin/env bash
case "$*" in
    *"--jq .title"*|*title*) echo "测试标题" ;;
    *) echo "{}" ;;
esac
exit 0
SH
cat > "$DSB/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; esac
exit 0
SH
chmod +x "$DSB/bin/gh" "$DSB/bin/tmux"
# 编号取得很大，避免撞上本机真实派工写在 /tmp 下的 prompt；按进程号错开，两份本测试同时跑也不会互相覆盖
N_NEW=$((900000000 + ($$ % 1000000) * 3)); N_CMT=$((N_NEW + 1)); N_PR=$((N_NEW + 2))
dispatch_render() {   # $1 = 出图地址（可空）；$2 = 输出目录
    local url="$1" out="$2" w="$2.work" kind f
    rm -rf "$w" "$out"; mkdir -p "$w/state" "$w/wt" "$out"
    git clone -q "$DSB/upstream.git" "$w/project" 2>/dev/null
    cat > "$w/config" <<CONF
REPO="example/none"
PROJECT_ROOT="$w/project"
WORKTREE_BASE="$w/wt"
STATE_DIR="$w/state"
TMUX_PREFIX="rlp"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
WORKER_AGENT_DEFAULT="claude"
WEEKLY_REPORT_ASSET_ROOT_URL="$url"
PATH="$DSB/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    rm -f /tmp/cavil-loop-issue-$N_NEW-prompt.md /tmp/cavil-loop-issue-$N_CMT-cmt-0.md /tmp/cavil-loop-pr-$N_PR-prompt.md
    local E=(env -u CODING_AGENT_RELEASE_ROOT -u WEEKLY_REPORT_ASSET_ROOT_URL HOME="$DSB/home" CODING_AGENT_CONFIG="$w/config")
    (cd "$w/project" && "${E[@]}" bash "$REPO_DIR/scripts/dispatch-new-issue.sh" "$N_NEW") >/dev/null 2>&1
    (cd "$w/project" && "${E[@]}" bash "$REPO_DIR/scripts/dispatch-issue-comment.sh" "$N_CMT" 0) >/dev/null 2>&1
    mv /tmp/cavil-loop-issue-$N_CMT-cmt-0.md "$out/issue-comment.md" 2>/dev/null
    (cd "$w/project" && "${E[@]}" DISPATCH_PROMPT_KIND=review bash "$REPO_DIR/scripts/dispatch-issue-comment.sh" "$N_CMT" 0) >/dev/null 2>&1
    mv /tmp/cavil-loop-issue-$N_CMT-cmt-0.md "$out/review.md" 2>/dev/null
    (cd "$w/project" && "${E[@]}" bash "$REPO_DIR/scripts/dispatch-pr-comment.sh" "$N_PR" "feature/issue-$N_PR" 0) >/dev/null 2>&1
    mv /tmp/cavil-loop-issue-$N_NEW-prompt.md "$out/new-issue.md" 2>/dev/null
    mv /tmp/cavil-loop-pr-$N_PR-prompt.md "$out/pr-comment.md" 2>/dev/null
}
URL="https://assets.example.invalid/review-assets"
dispatch_render "$URL" "$TMP/r-url"
dispatch_render "" "$TMP/r-none"
for kind in new-issue issue-comment pr-comment review; do
    a="$TMP/r-url/$kind.md"; b="$TMP/r-none/$kind.md"
    if [ ! -s "$a" ] || [ ! -s "$b" ]; then bad "$kind：派工脚本没写出 prompt"; continue; fi
    if grep -qF 'REVIEW_ASSET_BASE_URL' "$a" "$b"; then bad "$kind：出图地址占位没被换掉"; continue; fi
    case "$kind" in
        review) want_url="（这里为 \`$URL\`，为空 = 没配）"; want_none='（这里为 ``，为空 = 没配）' ;;
        *) want_url="本项目的公网出图地址：\`$URL\`（"; want_none='本项目的公网出图地址：``（' ;;
    esac
    if grep -qF -- "$want_url" "$a" && grep -qF -- "$want_none" "$b"; then ok "$kind：配了 / 没配出图地址都渲染对"
    else bad "$kind：出图地址渲染不对"; fi
done
# 引用规矩、配图规矩确实进了派工脚本写出的成品（不只是拼装函数的输出）
grep -qxF -- "$QUOTE_H" "$TMP/r-url/review.md" && grep -qxF -- "$QUOTE_H" "$TMP/r-url/pr-comment.md" \
    && ok "派工写出的复审 / PR 回复 prompt 带引用规矩" || bad "派工写出的 prompt 缺引用规矩"
grep -qxF -- "$MOCK_H" "$TMP/r-url/new-issue.md" && ok "派工写出的首次方案 prompt 带配图规矩" || bad "派工写出的首次方案 prompt 缺配图规矩"
# GitHub#335：四个入口、配了 / 没配出图地址，派工写出的成品都带「改界面外观必须附设计稿」和文字描述的退路
for kind in new-issue issue-comment pr-comment review; do
    case "$kind" in
        review) must='配了出图地址却没附设计稿'; fallback='并用文字描述改前改后的差异，缺了同样不合格' ;;
        *) must="$DESIGN_MUST"; fallback='评论里写明「本项目未配置出图地址，无法内嵌图片」，改用文字逐项描述改前改后的差异' ;;
    esac
    for d in r-url r-none; do
        f="$TMP/$d/$kind.md"
        if grep -qF -- "$must" "$f" 2>/dev/null && grep -qF -- "$fallback" "$f" 2>/dev/null && grep -qF '会改变界面外观' "$f"; then
            ok "$kind（$([ "$d" = r-url ] && echo 配了 || echo 没配)出图地址）：带改界面外观必须附设计稿 + 文字描述退路"
        else bad "$kind（$d）：派工写出的 prompt 缺改界面外观必须附设计稿或文字描述退路"; fi
    done
done

# ── 负对照：每个格子单独删一份，其余入口原样 ──
expect_red() {   # <说明> <期望出现的报错片段>
    out=$(check_prompts)
    if grep -qF -- "$2" <<<"$out"; then ok "负对照：$1 → 被拦下"
    else bad "负对照：$1 → 没被拦下（输出：${out:-空}）"; fi
}
drop_section() {   # <文件> <标题>：删掉这一节（到下一个 ## 之前）
    awk -v h="$2" '$0==h{skip=1; next} skip&&/^## /{skip=0} !skip' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
}
mutation_on && echo "── 负对照 ──"
neg_sandbox() { mutation_gate || return 1; make_sandbox; }
SANDBOXES_BEFORE_NEG=$SANDBOXES
P="$TMP/skill/prompts"

for name in new-issue issue-comment pr-comment; do
    neg_sandbox || continue
    drop_section "$P/$name.template.md" "$MOCK_H"
    expect_red "$name 少了配图规矩" "$name: 没有配样例图规矩"
done
if neg_sandbox; then
    sed -i '/^- \*\*配了出图地址却出不了图\*\*/s/这不是豁免。/可以改用文字描述。/' "$P/pr-comment.template.md"
    expect_red "pr-comment 把出不了图改回豁免" "pr-comment: 配图规矩把出不了图当成豁免"
fi
for name in issue-comment pr-comment review; do
    neg_sandbox || continue
    drop_section "$P/$name.template.md" "$QUOTE_H"
    expect_red "$name 少了引用规矩" "$name: 没有引用规矩"
done
if neg_sandbox; then
    sed -i 's/引用块放在评论最前面，`##` 标题紧跟其后/`##` 标题放在最前面，引用块紧跟其后/' "$P/issue-comment.template.md"
    expect_red "issue-comment 引用改回标题在前" "issue-comment: 引用规矩没写引用在前、标题在后"
fi
for name in new-issue issue-comment pr-comment; do
    neg_sandbox || continue
    sed -i 's/^1\. \*\*引用块之后第一行是 `##` 标题\*\*/1. **开头一行 `##` 标题**/' "$P/$name.template.md"
    expect_red "$name 第 1 条退回「开头一行是标题」" "$name: 交人评论第 1 条没改成引用块之后是标题"
done
if neg_sandbox; then
    sed -i 's/^1\. \*\*引用块之后第一行是 `##` 标题\*\*/1. **开头一行 `##` 标题**/' "$TMP/project/$EXTRA_REL"
    expect_red "复审增量第 1 条退回「开头一行是标题」" "review: 交人评论第 1 条没改成引用块之后是标题"
fi
if neg_sandbox; then
    sed -i 's/机器标记和引用块（如有，见「回复人时先引用人这一轮说的话」）之后的第一行是 `##` 标题/评论第一个看得见的行是 `##` 标题/' "$P/review.template.md"
    expect_red "复审第 3 步退回「第一个看得见的行」" "review-noextra: 还留着旧说法「评论第一个看得见的行是 \`##\` 标题」"
fi
if neg_sandbox; then
    drop_section "$P/issue-comment.template.md" "$QA_H"
    expect_red "issue-comment 少了本轮问题与回答" "issue-comment: 没有本轮问题与回答"
fi
if neg_sandbox; then
    sed -i '/^## 交人评论必须带上人工问题的最终回答/,/^## /{s/链接不能代替答案。/链接可以代替答案。/}' "$P/issue-comment.template.md"
    expect_red "issue-comment 本轮问答的规则条目改了一句" "issue-comment: 本轮问答的规则条目和 pr-comment 不一致"
fi
if neg_sandbox; then
    drop_section "$P/pr-comment.template.md" "$QA_H"
    expect_red "pr-comment 少了本轮问题与回答（issue 侧原样）" "pr-comment: 没有本轮问题与回答"
fi
if neg_sandbox; then
    sed -i '/^2L\. \*\*worker 交人评论的版式/d' "$P/review.template.md"
    expect_red "复审少了版式检查" "review: 没有版式检查那一步"
fi
if neg_sandbox; then
    sed -i '/^2L\. /s/③ 过程叙述（试了哪些写法、怎么一步步推导的、版本之间改了什么）留在折叠区外。//' "$P/review.template.md"
    expect_red "复审版式检查漏了过程叙述" "review: 版式检查漏了过程叙述外露"
fi
if neg_sandbox; then
    drop_section "$P/review.template.md" "$HAND_H"
    expect_red "复审少了交人骨架" "review: 没有交人骨架"
fi
if neg_sandbox; then
    sed -i 's/人\*\*直接在 agent 的评论里勾选\*\*/人在新评论里回答/' "$P/review.template.md"
    expect_red "复审收拢未答问题漏了直接勾选" "review: 收拢未答问题漏了直接勾选"
fi
if neg_sandbox; then
    sed -i '/^5\. 本轮问题与回答：/d' "$P/review.template.md"
    expect_red "复审骨架少了一项" "review: 骨架缺「5. 本轮问题与回答」"
fi
if neg_sandbox; then
    printf '\n交人时若已有相关设计图就复用；没有图就不生成。\n' >> "$P/review.template.md"
    expect_red "复审又写回不分阶段的「没有图就不生成」" "review: 还留着旧说法「没有图就不生成」"
fi
if neg_sandbox; then
    sed -i 's/^- 这条只管交付后的交人评论：前文没有相关图片时，不为满足这条规则额外生成设计图；[^。]*。/- 前文没有相关图片时，不为满足这条规则额外生成设计图。/' "$P/pr-comment.template.md"
    expect_red "pr-comment 交付后设计图那段退回不限定" "pr-comment: 交付后设计图那段没限定范围"
fi
# 合并说明：去掉渲染、或不先汇报也渲染
expect_red_bot() {   # <说明> <期望出现的报错片段>
    out=$(check_bot "$TMP/skill")
    if grep -qF -- "$2" <<<"$out"; then ok "负对照：$1 → 被拦下"
    else bad "负对照：$1 → 没被拦下（输出：${out:-空}）"; fi
}
if neg_sandbox; then
    rm -f "$P/requester-bot-merge-note.md"
    expect_red_bot "合并说明文件没装上" "bot: 先汇报时没有合并说明"
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
report_counts "$pass" "$fail"
[ "$fail" -eq 0 ]
