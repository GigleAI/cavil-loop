#!/usr/bin/env bash
# 复审的修复范围（GitHub#621）：第 2 轮起复审只核对上轮的问题清单和「这次修复本身」的改动。
# 这个命令算出「这次修复本身」是哪些改动；算不出来的每一种情形都回到全量复审。只读：只读 GitHub、
# 只在当前 git 仓库里取提交和算合并树，不改工作区、不写 GitHub。
#
# 用法（在被审 PR 的 worktree 里跑）：
#   bash review-scope.sh --repo OWNER/REPO pr <PR 编号> --round <本轮轮次> [--on <结论评论所在的 issue / PR 编号>]
#       --baseline-mark '<上一条结论的第二行>'：基线由复审从受保护读取的输出里交进来，本命令不读任何评论
#       （托管 + 外部内容保护的条目用这一种）
#   bash review-scope.sh --repo OWNER/REPO plan <issue 编号> --round <本轮轮次> --comment <本轮要审的方案评论 id>
#   bash review-scope.sh --repo OWNER/REPO fingerprint <评论 id> --issue <issue 编号> --expect <指纹>
#       复审审完方案后确认评论还是审的那个版本（指纹取自 plan 输出的 current 行），一致才打印指纹，
#       被改过退出码 3——那一轮不写基线标记
#
# 基线来自**派工账号自己发的、最近一条**复审结论评论（第一行是 codex-review-round 标记）第二行的隐藏标记：
#   <!-- review-baseline: code head=<40 位提交号> base=<目标分支> -->
#   <!-- review-baseline: plan comment=<评论 id> sha256=<64 位指纹> -->
#
# 输出第一行（之后是范围内的差异）：
#   full <原因>     全量复审。原因：first-round / read-failed / no-baseline / base-changed /
#                   baseline-missing / history-rewritten / merge-conflict / deleted / edited / same-comment / not-own /
#                   not-this-issue
#   scope <N>       复核轮；N = 修复范围里改动的文件数（方案为 1 或 0），其后是差异全文
# 方案模式在第一行之后还有 current sha256=<指纹> 一行和本轮方案全文（两者出自同一次读取；本轮那条评论
# 读不到、不是派工账号发的、不在本条 issue 下时都没有）；scope 时再接上一版到这一版的差异
# 基线只从结论评论的第一、二行取：第一行是轮次标记，第二行是基线标记；别处出现的标记一律不认
# 判法是从上往下、停在第一条命中的（docs/operations.md「复审收敛：修复范围怎么算」那张表，测试逐行对拍）。
# 退出码：0 = 给出了结论（full 或 scope）；2 = 用法错误（没有输出）。

# ── Review convergence and `REVIEW.md`: rules moved from the root AGENTS.md (GitHub#658); read before changing ──
# Review convergence and `REVIEW.md` (GitHub#621: `prompts/review-converge.md` appended by
# `review_converge_section`, the three-way `review_md_read` and its two sections in
# `compose_prompt_template`, `scripts/review-scope.sh` + its managed entrypoint, the late must-fix
# rule in `prompts/autopilot-review.md`, the numbered rework rule in the issue-comment / pr-comment
# templates) → `tests/review-converge.test.sh` (~1 min; the real dispatch scripts write every entry
# point's prompt — new issue, issue comment, PR comment, split sub-issue, review, autopilot review —
# against a local bare origin and the stateful fake GitHub, with any inherited dispatch environment
# cleared, and `review-scope.sh` runs in a real git repo against a file-backed fake `gh`, one case per
# row of the two tables in `docs/operations{,.zh}.md`, plus `shasum`-only and no-sha256 `PATH`s).
# `REVIEW.md` has three outcomes and "could not read" is never "absent" — no remote ref counts as
# could not read, and a copy in the main checkout is never used instead. Checklist items the review
# template already fails (2H, 2Q, 2R, 2L, 2C, 2B) are must-fix, never suggestions, and the worker's
# text of this round is always in scope. The convergence section goes into every review prompt
# (projects that replace the whole template included) and into no worker prompt; it sits before the
# autopilot section, which overrides step ④ for autopilot items. Every way `review-scope.sh` cannot
# establish the fix is `full <reason>`, never an empty `scope`; a baseline is only the second line of
# a verdict whose first line is the round marker (a quoted marker elsewhere never counts); proposal
# mode reads only comments the dispatch account posted on this issue (`not-own` / `not-this-issue`
# otherwise — an autopilot item's other text goes through the guarded read command), is left out of
# the review prompt entirely on an autopilot item with the outsider guard on —
# `review_converge_section` keeps the `guarded-only` blocks of `prompts/review-converge.md` and drops
# the `plain-only` ones there (the reverse elsewhere): proposal reviews are full every round, and code
# mode gets its baseline only through `--baseline-mark '<line>'`, copied by the reviewer from the
# guarded read output, in which case `review-scope.sh` sends no comment request at all — so the
# guarded read command is the only reader of the item's comments; prints this round's proposal text
# together with its fingerprint from one read (the reviewer reviews that printed text, never a
# separate read), and its baseline fingerprint is written only through `fingerprint <id> --issue <N>
# --expect <current>`, which refuses when the comment changed during the review; fingerprints go
# through `cfg_sha256` in `scripts/_sha256.sh` (shared with `_lib.sh`); a plain merge of the base is
# subtracted by merging the reviewed commit with the current fork point (`git merge-tree
# --write-tree`), a conflict there is `full merge-conflict`. The round marker's format does not change
# (the weekly report reads it); the baseline marker is the line after it. Tests that diff composed
# prompts against the merge-base scripts (feature-off comparisons) pass the new side through
# `strip_review_converge` from `tests/lib/review-converge.sh` first, which drops exactly these two
# sections by their headings and nothing else
#
set -euo pipefail

usage() {
    echo "用法：bash $(basename "$0") --repo OWNER/REPO pr <PR> --round <N> [--on <编号> | --baseline-mark <结论第二行>]" >&2
    echo "      bash $(basename "$0") --repo OWNER/REPO plan <issue> --round <N> --comment <评论 id>" >&2
    echo "      bash $(basename "$0") --repo OWNER/REPO fingerprint <评论 id> --issue <issue> --expect <指纹>" >&2
    exit 2
}

repo="" mode="" num="" round="" on="" comment="" issue="" given_mark="" has_mark=""
while [ $# -gt 0 ]; do
    case "$1" in
        --repo) [ $# -ge 2 ] || usage; repo="$2"; shift 2 ;;
        --round) [ $# -ge 2 ] || usage; round="$2"; shift 2 ;;
        --on) [ $# -ge 2 ] || usage; on="$2"; shift 2 ;;
        --comment) [ $# -ge 2 ] || usage; comment="$2"; shift 2 ;;
        --baseline-mark) [ $# -ge 2 ] || usage; given_mark="$2"; has_mark=1; shift 2 ;;
        pr|plan) [ -z "$mode" ] && [ $# -ge 2 ] || usage; mode="$1"; num="$2"; shift 2 ;;
        fingerprint) [ -z "$mode" ] && [ $# -ge 2 ] || usage; mode="$1"; num="$2"; shift 2; break ;;
        *) usage ;;
    esac
done
[[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || usage
[[ "$num" =~ ^[0-9]+$ ]] || usage
case "$mode" in
    pr) [[ "$round" =~ ^[0-9]+$ ]] || usage; [ -z "$comment" ] || usage
        [ -n "$on" ] || on="$num"; [[ "$on" =~ ^[0-9]+$ ]] || usage ;;
    plan) [[ "$round" =~ ^[0-9]+$ ]] || usage; [[ "$comment" =~ ^[0-9]+$ ]] || usage; [ -z "$on$has_mark" ] || usage ;;
    fingerprint) [ -z "$round$on$comment$has_mark" ] || usage ;;   # 后面只能跟 --expect <指纹>，下面查
    *) usage ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# shellcheck source=_sha256.sh
source "$(dirname "${BASH_SOURCE[0]}")/_sha256.sh"

# 方案模式在结论行之后接着输出本轮那条方案评论的指纹和全文，两者出自同一次读取：复审审的就是这里印出来的
# 全文（不另读一份），指纹对应的也就是复审看到的这一版。审完用 `fingerprint <id> --issue <N> --expect <它>`
# 确认评论没有在审阅途中被改过，再写进基线标记
CURRENT=""
current_block() {
    [ -n "$CURRENT" ] || return 0
    printf 'current sha256=%s\n' "$CURRENT"
    printf '===== 本轮方案全文（评论 %s；复审审的就是这一版）=====\n' "$comment"
    cat "$TMP/cur"; printf '\n===== 全文结束 =====\n'
}
full() { printf 'full %s\n' "$1"; current_block; exit 0; }

# 读一条评论的正文（GitHub 返回的原样，不加换行）。只认本条 issue 下、派工账号自己发的：方案是 loop 账号
# 发的评论，别的账号写的内容、别的条目下的评论都不经这里送到 agent 面前（托管条目上外部账号的内容只能走
# 受保护的读取命令；loop 账号自己的评论在那条命令里也是原样显示，两边看到的是同一份文字）
#   0 读到；4 不存在（404）；5 不是派工账号发的；6 不在本条 issue 下；1 其他读取失败
body_of() {   # <评论 id> <输出文件>
    local err="$TMP/err.$1" who where
    if gh api "repos/$repo/issues/comments/$1" > "$TMP/c.$1" 2>"$err"; then
        who=$(jq -r '.user.login // empty' < "$TMP/c.$1" 2>/dev/null) || return 1
        where=$(jq -r '.issue_url // empty' < "$TMP/c.$1" 2>/dev/null) || return 1
        [ -n "$who" ] && [ -n "$where" ] || return 1
        [ "${where##*/issues/}" = "$issue" ] && [ "${where%/issues/*}" != "$where" ] || return 6
        [ "$who" = "$login" ] || return 5
        jq -je '.body | strings' < "$TMP/c.$1" > "$2" 2>/dev/null || return 1
        return 0
    fi
    grep -q 'HTTP 404' "$err" 2>/dev/null && return 4
    return 1
}
fp_of() {   # <文件> → 指纹；算不出（两种 sha256 工具都没有）返回 1、不输出
    local h
    h=$(cfg_sha256 < "$1" 2>/dev/null) || return 1
    [[ "$h" =~ ^[0-9a-f]{64}$ ]] || return 1
    printf '%s\n' "$h"
}

login=$(gh api user --jq .login 2>/dev/null) || login=""

if [ "$mode" = fingerprint ]; then
    # 必须带 --issue 和 --expect：指纹只能写成「审过的那个版本」的，审阅途中被改过就不给（退出码 3）
    [ "${1:-}" = --issue ] && [[ "${2:-}" =~ ^[0-9]+$ ]] && [ "${3:-}" = --expect ] && [[ "${4:-}" =~ ^[0-9a-f]{64}$ ]] && [ $# -eq 4 ] || usage
    issue="$2"; want="$4"
    [ -n "$login" ] || { echo "读不到派工账号" >&2; exit 1; }
    rc=0; body_of "$num" "$TMP/body" || rc=$?
    [ "$rc" != 5 ] || { echo "评论 $num 不是派工账号发的" >&2; exit 1; }
    [ "$rc" != 6 ] || { echo "评论 $num 不在 issue #$issue 下" >&2; exit 1; }
    [ "$rc" = 0 ] || { echo "读不到评论 $num" >&2; exit 1; }
    fp=$(fp_of "$TMP/body") || { echo "算不出指纹（没有 sha256sum 也没有 shasum）" >&2; exit 1; }
    [ "$fp" = "$want" ] || { echo "评论 $num 在审阅之后被改过，不写基线" >&2; exit 3; }
    printf '%s\n' "$fp"
    exit 0
fi

[ -n "$login" ] || full read-failed

if [ "$mode" = plan ]; then
    issue="$num"
    rc=0; body_of "$comment" "$TMP/cur" || rc=$?
    case "$rc" in 0) ;; 5) full not-own ;; 6) full not-this-issue ;; *) full read-failed ;; esac
    CURRENT=$(fp_of "$TMP/cur") || full read-failed
fi

# ① 本轮是最近一次人工动作之后的第 1 轮（轮次由复审照模板的规矩数出来）
[ "$round" -ge 2 ] || full first-round

# ② 基线：派工账号自己发的最近一条复审结论评论——第一行是轮次标记、第二行是基线标记。只认这个位置：
# 别的评论里引用了旧标记（不在第一行）不算复审结论
# 托管 + 外部内容保护的条目上，复审从受保护读取命令的输出里抄下自己上一条结论的第二行，用 --baseline-mark
# 交进来：这时本命令一条评论都不读，基线只认交进来的这一行
if [ -n "$has_mark" ]; then
    mark="${given_mark%$'\r'}"
else
target="$num"; [ "$mode" = plan ] || target="$on"
gh api --paginate "repos/$repo/issues/$target/comments" \
    --jq '.[] | {id, user: (.user.login // ""), body: (.body // "")}' > "$TMP/comments" 2>/dev/null || full read-failed
jq -rs --arg me "$login" '
    [ .[] | select(.user == $me) | .body | split("\n") | map(rtrimstr("\r"))
      | select((.[0] // "") | test("^<!-- codex-review-round:[0-9]+ -->$")) ] | last // empty
    | .[1] // ""' < "$TMP/comments" > "$TMP/mark" 2>/dev/null || full read-failed
[ -s "$TMP/mark" ] || full no-baseline
mark=$(head -1 "$TMP/mark")
fi
PLAN_RE='^<!-- review-baseline: plan comment=([0-9]+) sha256=([0-9a-f]{64}) -->$'
CODE_RE='^<!-- review-baseline: code head=([0-9a-f]{40}) base=([A-Za-z0-9._/-]+) -->$'

if [ "$mode" = plan ]; then
    [[ "$mark" =~ $PLAN_RE ]] || full no-baseline
    prev_id="${BASH_REMATCH[1]}" prev_fp="${BASH_REMATCH[2]}"
    rc=0; body_of "$prev_id" "$TMP/prev" || rc=$?
    case "$rc" in 0) ;; 4) full deleted ;; 5) full not-own ;; 6) full not-this-issue ;; *) full read-failed ;; esac
    fp=$(fp_of "$TMP/prev") || full read-failed
    [ "$fp" = "$prev_fp" ] || full edited
    [ "$prev_id" != "$comment" ] || full same-comment
    printf '\n' >> "$TMP/prev"; cp "$TMP/cur" "$TMP/cur2"; printf '\n' >> "$TMP/cur2"
    rc=0; diff -u --label "上一版方案（评论 ${prev_id}）" --label "本轮方案（评论 ${comment}）" "$TMP/prev" "$TMP/cur2" > "$TMP/diff" || rc=$?
    case "$rc" in 0) n=0 ;; 1) n=1 ;; *) full read-failed ;; esac
    printf 'scope %s\n' "$n"; current_block
    if [ "$n" != 0 ]; then printf '===== 修复范围：上一版到这一版的差异 =====\n'; cat "$TMP/diff"; fi
    exit 0
fi

[[ "$mark" =~ $CODE_RE ]] || full no-baseline
prev="${BASH_REMATCH[1]}" prev_base="${BASH_REMATCH[2]}"

pr=$(gh api "repos/$repo/pulls/$num" --jq '[.head.sha, .base.ref] | @tsv' 2>/dev/null) || full read-failed
head="${pr%%$'\t'*}" base="${pr#*$'\t'}"
[[ "$head" =~ ^[0-9a-f]{40}$ ]] && [ -n "$base" ] && [ "$base" != "$pr" ] || full read-failed

# ④ 改投了目标分支
[ "$base" = "$prev_base" ] || full base-changed

# ⑤ 取提交：目标分支最新、PR 最新提交；上轮审过的提交必须在本地
git fetch -q origin "+refs/heads/$base:refs/remotes/origin/$base" >/dev/null 2>&1 || full baseline-missing
git fetch -q origin "refs/pull/$num/head" >/dev/null 2>&1 || full baseline-missing
git cat-file -e "$head^{commit}" 2>/dev/null || full baseline-missing
git cat-file -e "$prev^{commit}" 2>/dev/null || full baseline-missing

# ⑥ 上轮审过的提交不在本轮的历史里：变基 / 强推
rc=0; git merge-base --is-ancestor "$prev" "$head" 2>/dev/null || rc=$?
case "$rc" in 0) ;; 1) full history-rewritten ;; *) full read-failed ;; esac

# ⑦ 本轮提交与目标分支的分叉点（＝本轮已经同步进来的主干）
fork=$(git merge-base "$head" "refs/remotes/origin/$base" 2>/dev/null) || full read-failed
[[ "$fork" =~ ^[0-9a-f]{40}$ ]] || full read-failed

# ⑧⑨ 上轮的 PR 内容 + 本轮已同步的主干，合成一棵树（只算、不动工作区）
rc=0; tree=$(git merge-tree --write-tree "$prev" "$fork" 2>/dev/null) || rc=$?
case "$rc" in 0) ;; 1) full merge-conflict ;; *) full read-failed ;; esac
tree="${tree%%$'\n'*}"
[[ "$tree" =~ ^[0-9a-f]{40}$ ]] || full read-failed

# ⑩⑪⑫ 合成的树与本轮提交比：差异就是这次修复本身
git diff --no-color --name-only "$tree" "$head" > "$TMP/names" 2>/dev/null || full read-failed
git diff --no-color "$tree" "$head" > "$TMP/diff" 2>/dev/null || full read-failed
n=$(grep -c . "$TMP/names" || true)
echo "scope $n"
cat "$TMP/diff"
