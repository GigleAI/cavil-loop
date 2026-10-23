#!/usr/bin/env bash
# 交人拍板评论的「大白话」规矩（GitHub#63）必须同时出现在每一份会写交人评论的 prompt 里，
# 而且是同一份文字。
#
# 跑法：bash tests/plain-language-prompts.test.sh
# 依赖：无。用仓库自带的真实模板，走 daemon 真正拼 prompt 的 compose_prompt_template。
#
# 为什么要有这个文件：同一段规矩抄在 4 个地方（新 issue / issue 回复 / PR 回复三份 worker
# 模板 + 本项目给 review 的增量），review 模板另有一条打回依据。只改其中一处不会报错，
# 只会让别的环节照样发出读不懂的拍板评论——#62 的自审表就是这样只接到了返工入口。
# 所以这里按成品对拍：骨架、禁用规则、拍板格式在每份成品里都在，且逐字一致；
# 再对每个改动点各造一个负对照，确认少了哪一处这里都会红。
#
# 交人评论「自包含，链接只当出处」（GitHub#74）同理：同一句话在三份 worker 模板、本项目的
# review 增量、通用 review 模板交人那一步里各一份，逐字一致；通用 review 模板那份单独对拍
# 「别的项目没有 review 增量」的成品，否则只有本项目的复审会照这条写。
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/coding-agent.config" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$TMP/project"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="plaintest"
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

BAN_HEAD='**问题标题和选项里不许出现代码里的名字**'
WORKERS=(new-issue issue-comment pr-comment)
ALL=(new-issue issue-comment pr-comment review)

# 沙盘：skill 一份、项目一份（非 git 目录 → find_project_prompt_file 读本地增量）
make_sandbox() {
    rm -rf "$TMP/skill" "$TMP/project"
    mkdir -p "$TMP/skill" "$TMP/project/.agents/skills/cavil-loop"
    cp -r "$REPO_DIR/prompts" "$TMP/skill/prompts"
    cp -r "$REPO_DIR/.agents/skills/cavil-loop/prompts" "$TMP/project/.agents/skills/cavil-loop/prompts"
    SKILL_DIR="$TMP/skill"
}

skeleton()  { sed -n '/^### 评论里有要人拍板的问题时：固定骨架$/,/^反面（读不懂的那版/p' "$1"; }
rules()     { sed -n '/凡是发到 issue \/ PR 让用户拍板的问题/,/勾选约定/p' "$1"; }
# 每处禁用规则从加粗开头截到「不算」，同一份文字的每次出现都应逐字相同
# 自包含规则：从加粗开头截到行尾（每处都是一整行），所有出现应逐字相同
SELF_HEAD='**自包含，链接只当出处**'
self_texts() { grep -o -- "\*\*自包含，链接只当出处\*\*。.*" "$1"; }
SELF_CHECK='**只读这一条评论、不点任何链接，能不能知道发生了什么、要做哪几步？**'
ban_texts() { grep -oF -- "$BAN_HEAD" "$1" >/dev/null && grep -o -- "\*\*问题标题和选项里不许出现代码里的名字\*\*[^。]*。[^。]*不算" "$1"; }

# 打印发现的问题，一行一条；空输出 = 全部满足
check_prompts() {
    local name f ref_skel="" ref_rules="" ref_ban="" s r b n
    for name in "${ALL[@]}"; do
        f=$(compose_prompt_template "$name" 2>/dev/null)
        [ -s "$f" ] || { echo "$name: 拼不出 prompt"; continue; }
        cp "$f" "$TMP/composed-$name.md"; f="$TMP/composed-$name.md"

        s=$(skeleton "$f")
        if [ -z "$s" ]; then echo "$name: 没有拍板评论骨架"
        else
            grep -qF '要你选的只有一件事' <<<"$s" || echo "$name: 骨架缺「要你选的只有一件事」"
            grep -qF '先用一个真实例子讲清以前怎样、现在怎样' <<<"$s" || echo "$name: 骨架缺真实例子一步"
            grep -qF '只读标题、第一段和选项' <<<"$s" || echo "$name: 骨架缺发出前自查"
            if [ -z "$ref_skel" ]; then ref_skel="$s"; elif [ "$s" != "$ref_skel" ]; then echo "$name: 骨架和 ${ALL[0]} 不一致"; fi
        fi

        b=$(ban_texts "$f" | sort -u)
        n=$(ban_texts "$f" | wc -l)
        if [ -z "$b" ]; then echo "$name: 没有禁用规则"
        else
            [ "$(wc -l <<<"$b")" -eq 1 ] || echo "$name: 禁用规则有不同写法"
            if [ -z "$ref_ban" ]; then ref_ban="$b"; elif [ "$b" != "$ref_ban" ]; then echo "$name: 禁用规则和 ${ALL[0]} 不一致"; fi
            # 骨架里一处 + 拍板规则（worker）或打回依据（review）里一处
            [ "$n" -ge 2 ] || echo "$name: 禁用规则只出现 $n 处（应在骨架和拍板规则 / 打回依据里各一处）"
        fi
    done

    local ref_self="" t
    for name in "${ALL[@]}"; do
        f="$TMP/composed-$name.md"; [ -s "$f" ] || continue
        t=$(self_texts "$f" | sort -u)
        n=$(self_texts "$f" | wc -l)
        if [ -z "$t" ]; then echo "$name: 没有自包含规则"; continue; fi
        [ "$(wc -l <<<"$t")" -eq 1 ] || { echo "$name: 自包含规则有不同写法"; continue; }
        grep -qF -- "$SELF_CHECK" <<<"$t" || echo "$name: 自包含规则缺不点链接的自查句"
        grep -qF '要人动手的步骤按顺序写全文' <<<"$t" || echo "$name: 自包含规则缺步骤写全文"
        grep -qF '复审写交人评论时把 worker 的要点搬过来' <<<"$t" || echo "$name: 自包含规则没管到复审"
        if [ -z "$ref_self" ]; then ref_self="$t"; elif [ "$t" != "$ref_self" ]; then echo "$name: 自包含规则和 ${ALL[0]} 不一致"; fi
        # worker：交人评论那段第 8 条；review：本项目增量第 8 条 + 通用模板交人那一步
        if [ "$name" = review ]; then
            [ "$n" -ge 2 ] || echo "review: 自包含规则只出现 $n 处（应在本项目增量和通用模板交人那一步各一处）"
        else
            grep -qF -- "8. $SELF_HEAD" "$f" || echo "$name: 自包含规则不在交人评论那段的第 8 条"
        fi
    done

    f="$TMP/composed-pr-comment.md"
    if [ -s "$f" ]; then
        grep -A3 -F '链接不能代替答案' "$f" | grep -qF '链接不能代替步骤和结论' \
            || echo "pr-comment: 「链接不能代替答案」没扩到步骤和复审结论"
    fi

    # 别的项目没有 review 增量：拼出来的 review prompt 只剩通用模板，也得带这条
    local extra="$TMP/project/.agents/skills/cavil-loop/prompts/review.extra.md"
    if [ -f "$extra" ]; then
        mv "$extra" "$extra.off"
        f=$(compose_prompt_template review 2>/dev/null)
        if [ -s "$f" ] && self_texts "$f" | grep -qF -- "$SELF_CHECK"; then :; else
            echo "review（无项目增量）: 通用模板交人那一步没有自包含规则"
        fi
        mv "$extra.off" "$extra"
    fi

    for name in "${WORKERS[@]}"; do
        f="$TMP/composed-$name.md"; [ -s "$f" ] || continue
        r=$(rules "$f")
        grep -qF -- "$BAN_HEAD" <<<"$r" || echo "$name: 拍板问题规则里没有禁用规则"
        grep -qF '不勾会怎样' <<<"$r" || echo "$name: 拍板格式缺「不勾会怎样」"
        if [ -z "$ref_rules" ]; then ref_rules="$r"; elif [ "$r" != "$ref_rules" ]; then echo "$name: 拍板问题规则和 ${WORKERS[0]} 不一致"; fi
    done

    f="$TMP/composed-review.md"
    if [ -s "$f" ]; then
        grep -E '^2Q\. ' "$f" | grep -qF -- "$BAN_HEAD" || echo "review: 打回依据里没有禁用规则"
        grep -E '^2Q\. ' "$f" | grep -qF '判不通过' || echo "review: 违反禁用规则没写成判不通过"
    fi
}

echo "── 仓库现状：4 份成品都带骨架和禁用规则，且逐字一致 ──"
make_sandbox
out=$(check_prompts)
if [ -z "$out" ]; then ok "全部满足"; else bad "仓库现状不满足："; sed 's/^/       /' <<<"$out"; fi

# 负对照：每个改动点单独拿掉 / 改一个字，check_prompts 必须报出对应那条
expect_red() {   # <说明> <期望出现的报错片段>
    out=$(check_prompts)
    if grep -qF -- "$2" <<<"$out"; then ok "负对照：$1 → 被拦下"
    else bad "负对照：$1 → 没被拦下（输出：${out:-空}）"; fi
}

echo "── 负对照 ──"
make_sandbox
sed -i '/^### 评论里有要人拍板的问题时/,/^反面（读不懂的那版/d' "$SKILL_DIR/prompts/pr-comment.template.md"
expect_red "pr-comment 没有骨架" "pr-comment: 没有拍板评论骨架"

make_sandbox
sed -i 's/最多三四行/最多五六行/' "$SKILL_DIR/prompts/issue-comment.template.md"
expect_red "issue-comment 骨架改了一个词" "issue-comment: 骨架和 new-issue 不一致"

make_sandbox
sed -i '/^### 评论里有要人拍板的问题时/,/^反面（读不懂的那版/d' "$TMP/project/.agents/skills/cavil-loop/prompts/review.extra.md"
expect_red "review 增量没有骨架" "review: 没有拍板评论骨架"

make_sandbox
python3 - "$SKILL_DIR/prompts/new-issue.template.md" <<'PY'
import sys
p = sys.argv[1]; lines = open(p).read().split("\n")
# 只删拍板规则第 3 条下面那行禁用规则，骨架里那处保留
i = next(k for k, l in enumerate(lines) if l.startswith("  3. **讲人话**"))
assert "不许出现代码里的名字" in lines[i + 1]
del lines[i + 1]
open(p, "w").write("\n".join(lines))
PY
expect_red "new-issue 拍板规则里少了禁用规则" "new-issue: 拍板问题规则里没有禁用规则"

make_sandbox
sed -i 's/  不勾会怎样：按 A 走——<一句话>//; s/。选项列完后补一行「不勾会怎样」：按默认项走会发生什么//' "$SKILL_DIR/prompts/pr-comment.template.md"
expect_red "pr-comment 拍板格式少了「不勾会怎样」" "pr-comment: 拍板格式缺「不勾会怎样」"

make_sandbox
sed -i '/^2Q\. /d' "$SKILL_DIR/prompts/review.template.md"
expect_red "review 模板没有打回依据" "review: 打回依据里没有禁用规则"

make_sandbox
sed -i 's/测试编号、复盘经验编号/测试编号/' "$SKILL_DIR/prompts/review.template.md"
expect_red "review 打回依据里的禁用规则跟 worker 不是同一份文字" "review: 禁用规则有不同写法"

# 自包含规则（GitHub#74）：每个写入点单独拿掉 / 改一个字
for name in new-issue issue-comment pr-comment; do
    make_sandbox
    sed -i '/^8\. \*\*自包含，链接只当出处\*\*/d' "$SKILL_DIR/prompts/$name.template.md"
    expect_red "$name 交人评论那段少了自包含规则" "$name: 没有自包含规则"
done

make_sandbox
sed -i '/^8\. \*\*自包含，链接只当出处\*\*/d' "$TMP/project/.agents/skills/cavil-loop/prompts/review.extra.md"
expect_red "review 增量少了自包含规则" "review: 自包含规则只出现 1 处"

make_sandbox
sed -i '/^交人评论（通过，或轮次已尽交人）同样要/d' "$SKILL_DIR/prompts/review.template.md"
expect_red "通用 review 模板交人那一步少了自包含规则" "review（无项目增量）: 通用模板交人那一步没有自包含规则"

make_sandbox
sed -i '/^8\. \*\*自包含/s/出错怎么退回/出错找人/' "$SKILL_DIR/prompts/issue-comment.template.md"
expect_red "issue-comment 自包含规则改了一个词" "issue-comment: 自包含规则和 new-issue 不一致"

make_sandbox
sed -i '/^交人评论（通过，或轮次已尽交人）同样要/s/见 worker 上一条/见上上条/' "$SKILL_DIR/prompts/review.template.md"
expect_red "通用 review 模板那份跟增量不是同一份文字" "review: 自包含规则有不同写法"

make_sandbox
sed -i 's/\*\*只读这一条评论、不点任何链接，能不能知道发生了什么、要做哪几步？\*\* 不能就重写。//' "$SKILL_DIR/prompts/new-issue.template.md"
expect_red "new-issue 自包含规则少了自查句" "new-issue: 自包含规则缺不点链接的自查句"

make_sandbox
sed -i '/链接不能代替步骤和结论/d' "$SKILL_DIR/prompts/pr-comment.template.md"
expect_red "pr-comment「链接不能代替答案」没扩范围" "pr-comment: 「链接不能代替答案」没扩到步骤和复审结论"

echo
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
