#!/usr/bin/env bash
# kind: unit
# 纯提问的答复记录（GitHub#614）：scripts/feedback-fingerprint.sh 的 snapshot / compare。
#
# 跑法：bash tests/feedback-fingerprint.test.sh        （~5 s，不联网：按请求路径返回夹具的假 gh）
#
# 每个场景都跑真实的 feedback-fingerprint.sh（它 source 真实的 _lib.sh，作者分类走真实的 outsider_role /
# repo_maintainer_check）：先 snapshot 拿到答复记录，把记录写进一条 loop 账号的答复评论（和 worker 真发的一样），
# 改夹具模拟人在交回前做了什么，再 compare，断言 verdict 和点出的条目。
#   1. 记录格式：v=2、四部分齐全；外部账号的正文不出现在输出里
#   2. 无变化交回 → resume（issue、PR、没有任何流程记录的 PR → none）
#   3. 人的反馈：新增 / 编辑（编号和时间都不变的 review）→ new-feedback 点出那一条；删除 → need-continue
#   4. 外部账号新增 / 编辑 / 删除 → 仍 resume；维护者做同样的事 → 照上
#   5. 正文改了、绑定的复审结论被删 / 被改、出现新的复审结论 → need-continue（不会退回更早的通过记录）
#   6. 选择题勾选：`**Q1：` / `**Q1.` 两种真实题头改勾选 → new-feedback；引用块、普通任务列表、答复里引用的方框 → 不算
#   7. 旧格式记录、等继续记录、写坏的记录 → need-continue；读失败、作者权限查不到 → 退出码 3、只输出 unreadable
#   8. 照派工说明走一遍：snapshot 第一行原样存文件 → 发前比对 resume；答复评论全文 → 交回 resume；
#      时间与顺序、角色、绑定那一步的全文、最新答复都在输出里；在行内代码 / 代码块里解释格式的方案仍是流程记录
#   9. 同标题、不同正文的两条复审结论：交回给出绑定那条的全文
#  10. 本条目本身：流程标签翻动不算变化；关闭、非流程标签、PR 新提交 → need-continue
#  11. 作者为空 / 缺失 → unreadable；已明确认定的外部账号照旧不计入
#  12. 勾选的来源时间（复审第 2 轮 #2）：首次派工、没有历史答复时，旧题在本轮被勾 / 在本轮起点之前勾过，
#      都从那条评论的修改历史给出时间和改的人；没改过、只改了别的字、历史分页、被删的版本、对不上、读失败
#  13. 写前核对（复审第 2 轮 #6）：缺 labels / 标签没有名字 / 状态认不出 → unreadable；issue 的关联打开 PR
#      （按分支名或正文关联）开了 / 关了 → item-changed；PR 列表读失败 → unreadable；是否仍持有派工标签单独一行
#  14. 一条评论里的多道题各算各的（复审第 3 轮 #2）：上轮勾第 1 题、本轮勾第 2 题，各自的时间和改的人；
#      loop 账号改选项措辞不算勾选；loop 账号自己改了勾选会标明身份；改的人身份查不到 → unreadable
#  15. 写前闸门（复审第 3 轮 #6）：答复和等继续提示共用的 `write ok <标签>` / `write stop <原因>`：打开且持有 →
#      pending/human，issue 有关联打开 PR → pending/PR，没持有 / 已关闭 → stop；比对（含 need-continue）也带它；读失败没有闸门行
#  16. 题目跨版本按题号认（复审第 4 轮 #2）：插入新题、调换两题顺序、删掉一题、同一题改措辞都不算已有题的勾选变化，
#      真改勾才算；新插入的题算插入者的改动；一版里题号重复、改的人不明 → 无法确认
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; [ -z "${2:-}" ] || printf '       %s\n' "$2"; fail=$((fail+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "期望 [$3]，实得 [$2]"; fi; }

FX="$TMP/fx"; mkdir -p "$FX" "$TMP/bin" "$TMP/state" "$TMP/home"
cat > "$TMP/cfg" <<CONF
REPO="acme/widget"
PROJECT_ROOT="$TMP"
WORKTREE_BASE="$TMP/wt"
STATE_DIR="$TMP/state"
TMUX_PREFIX="fptest"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
CONF

# 假 gh：路径 → $FX/<路径里的 / 换成 _>.json；--jq 交给真 jq；--paginate 只有一页。有 fail-<同名> 文件 = 这个请求失败
cat > "$TMP/bin/gh" <<'SH'
#!/usr/bin/env bash
path="" jqf="" gid="" gafter=""
while [ $# -gt 0 ]; do
    case "$1" in
        api|--paginate) shift ;;
        --jq) jqf="$2"; shift 2 ;;
        -f|-F) case "$2" in id=*) gid="${2#id=}" ;; after=*) gafter="${2#after=}" ;; esac; shift 2 ;;
        -*) shift ;;
        *) path="$1"; shift ;;
    esac
done
key=$(printf '%s' "$path" | tr '/' '_')
[ ! -e "$FX/fail-$key" ] || { echo "HTTP 502" >&2; exit 1; }
[ "$path" = user ] && { echo "loop-bot"; exit 0; }
# GraphQL: a comment's edit history → $FX/edits-<node id>[-<after>].json; fail-edits-<node id> = that read fails
if [ "$path" = graphql ]; then
    echo "graphql $gid" >> "$FX/graphql.log"
    [ ! -e "$FX/fail-edits-$gid" ] || { echo "HTTP 502" >&2; exit 1; }
    f="$FX/edits-$gid${gafter:+-$gafter}.json"
    [ -f "$f" ] || { echo "no fixture $f" >&2; exit 1; }
    cat "$f"; exit 0
fi
f="$FX/$key.json"
case "$path" in
    */collaborators/*/permission)
        login=$(printf '%s' "$path" | sed 's|.*/collaborators/||; s|/permission||')
        perm=$(jq -r --arg l "$login" '.[$l] // empty' "$FX/perms.json")
        [ -n "$perm" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
        jq -n --arg p "$perm" '{permission: $p}' | jq -r "${jqf:-.}"; exit 0 ;;
esac
[ -f "$f" ] || { echo "[]" | jq -c "${jqf:-.}"; exit 0; }
jq -c "${jqf:-.}" "$f"
SH
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH" FX HOME="$TMP/home"
unset CODING_AGENT_RELEASE_ROOT CAVIL_DEPLOY_ROOT WRITE_GH_TOKEN
echo '{"alice":"admin","mallory":"read"}' > "$FX/perms.json"

FP="$REPO_DIR/scripts/feedback-fingerprint.sh"
snap() { bash "$FP" --config "$TMP/cfg" snapshot "$1"; }
cmp_() { bash "$FP" --config "$TMP/cfg" compare "$1" --record "$2"; }
verdict() { sed -n 's/^verdict //p' <<<"$1"; }
field() { sed -n "s/^$2 //p" <<<"$1"; }

# 夹具助手：一条 issue / PR 的正文和评论
u() { jq -nc --arg l "$1" --arg t "${2:-User}" '{login: $l, type: $t}'; }
set_item() {   # <编号> <正文> <是否 PR> [状态] [标签 JSON] [最新提交]
    local st="${4:-open}" lb="${5:-[\"pending/agent\",\"priority/p0\"]}"
    if [ "$3" = pr ]; then
        jq -n --arg b "$2" --arg s "$st" --argjson l "$lb" '{body: $b, state: $s, labels: [$l[] | {name: .}], pull_request: {url: "x"}}' > "$FX/repos_acme_widget_issues_$1.json"
        jq -n --arg h "${6:-aaa111}" '{head: {sha: $h}, base: {ref: "main"}}' > "$FX/repos_acme_widget_pulls_$1.json"
    else jq -n --arg b "$2" --arg s "$st" --argjson l "$lb" '{body: $b, state: $s, labels: [$l[] | {name: .}]}' > "$FX/repos_acme_widget_issues_$1.json"; fi
}
conv_file() { echo "$FX/repos_acme_widget_issues_$1_comments.json"; }
add_conv() {   # <编号> <id> <login> <正文>
    local f; f=$(conv_file "$1"); [ -f "$f" ] || echo '[]' > "$f"
    jq --argjson id "$2" --argjson u "$(u "$3")" --arg b "$4" --arg t "${5:-2026-11-01T00:00:$(printf '%02d' $(( $2 % 60 )))Z}" \
        '. + [{id: $id, node_id: "IC_\($id)", user: $u, body: $b, created_at: $t, updated_at: $t}]' "$f" > "$f.t" && mv "$f.t" "$f"
}
edit_conv() { local f; f=$(conv_file "$1"); jq --argjson id "$2" --arg b "$3" 'map(if .id == $id then .body = $b else . end)' "$f" > "$f.t" && mv "$f.t" "$f"; }
del_conv() { local f; f=$(conv_file "$1"); jq --argjson id "$2" 'map(select(.id != $id))' "$f" > "$f.t" && mv "$f.t" "$f"; }
set_reviews() { echo "$2" > "$FX/repos_acme_widget_pulls_$1_reviews.json"; }
# worker 照派工说明做的样子：把 snapshot 第一行原样存进文件（① 发前比对用的就是这个文件），
# 再把同一行原样放进答复评论；交回时比对用的是那条评论的正文（C）
answer() {   # <编号> <id> <snapshot 输出>
    local rec; rec=$(sed -n '1p' <<<"$3")
    printf '%s\n' "$rec" > "$TMP/pre-$1"
    add_conv "$1" "$2" loop-bot "$(printf '## 回答\n\n因为缓存没命中。\n\n%s\n' "$rec")"
    jq -r --argjson id "$2" '.[] | select(.id == $id) | .body' "$(conv_file "$1")" > "$TMP/rec-$1"
}

echo "── 1. 记录格式 ──"
set_item 10 "原始需求" issue
add_conv 10 101 loop-bot $'## 方案：做 X\n\n**Q1：选哪个？**\n- [x] **A. 甲**\n- [ ] **B. 乙**\n\n> - [ ] 引用里的方框\n\n- [ ] 普通任务列表'
add_conv 10 102 mallory "外部账号的秘密原文 OUTSIDER-TEXT"
add_conv 10 103 alice "为什么缓存会慢？"
s=$(snap 10); rc=$?
chk "snapshot 退出码 0" "$rc" 0
rec=$(sed -n '1p' <<<"$s")
if [[ "$rec" =~ ^'<!-- agent-answer-only v=2 seen='[^\ ]+' item='[0-9a-f]{12}' resume=f101:'[0-9a-f]{12}' flow='[0-9a-f]{12}' -->'$ ]]; then ok "第一行是 v=2 完整记录，resume 绑定最后一条流程记录 f101"
else bad "记录格式不对" "$rec"; fi
grep -q 'OUTSIDER-TEXT' <<<"$s" && bad "外部账号的正文出现在输出里" || ok "外部账号的正文不出现在输出里"
grep -q 'c103' <<<"$rec" && grep -q 't101' <<<"$rec" && ! grep -q 'c102' <<<"$rec" \
    && ok "记录里有维护者的评论和选择题勾选，没有外部账号" || bad "记录里的条目不对" "$rec"
answer 10 104 "$s"

echo "── 2. 无变化交回 → resume ──"
o=$(cmp_ 10 "$TMP/rec-10")
chk "issue：没有任何变化 → resume" "$(verdict "$o")" resume
grep -q '^f101:[0-9a-f]* ｜ worker 交付 ｜ .* ｜ ## 方案：做 X$' <<<"$o" && grep -q '^- \[ \] 普通任务列表$' <<<"$o" \
    && ok "输出里给出要接着做的那一步：f101 的角色、时间和全文" || bad "没给出要接着做的那一步的全文" "$o"

set_item 20 "PR 正文" pr
set_reviews 20 '[]'
add_conv 20 201 alice "这里为什么这样写？"
s=$(snap 20); answer 20 202 "$s"
chk "没有任何流程记录：resume=none" "$(sed -n '1s/.*resume=\([^ ]*\).*/\1/p' <<<"$s")" none
o=$(cmp_ 20 "$TMP/rec-20")
chk "PR、没有流程记录、无变化 → resume" "$(verdict "$o")|$(field "$o" resume)" "resume|none"
add_conv 20 203 loop-bot "<!-- codex-review-round:1 -->"$'\n'"## ❌ 复审未通过"
o=$(cmp_ 20 "$TMP/rec-20")
chk "原来没有流程记录、交回前出现了一条 → need-continue" "$(verdict "$o")" need-continue
del_conv 20 203

echo "── 3. 人的反馈：新增 / 编辑 / 删除 ──"
set_item 30 "PR 正文" pr
set_reviews 30 "$(jq -nc --argjson u "$(u alice)" '[{id: 3001, user: $u, state: "COMMENTED", submitted_at: "2026-11-01T00:00:05Z", body: "为什么慢？"}]')"
add_conv 30 301 loop-bot $'## PR 交接'
s=$(snap 30); answer 30 302 "$s"
set_reviews 30 "$(jq -nc --argjson u "$(u alice)" '[{id: 3001, user: $u, state: "COMMENTED", submitted_at: "2026-11-01T00:00:05Z", body: "为什么慢？另外先补测试"}]')"
o=$(cmp_ 30 "$TMP/rec-30")
chk "同一条 review 编号不变、正文改了 → new-feedback，点出 r3001" "$(verdict "$o")|$(field "$o" edited)" "new-feedback|r3001"
grep -q '先补测试' <<<"$o" && ok "输出里给出这一次读到的新正文" || bad "输出里没有新正文" "$o"
set_reviews 30 "$(jq -nc --argjson u "$(u alice)" '[{id: 3001, user: $u, state: "COMMENTED", submitted_at: "2026-11-01T00:00:05Z", body: "为什么慢？"}]')"
add_conv 30 303 alice "另外改成 Y"
o=$(cmp_ 30 "$TMP/rec-30")
chk "新增一条维护者评论 → new-feedback，点出 c303" "$(verdict "$o")|$(field "$o" added)" "new-feedback|c303"
del_conv 30 303
set_reviews 30 '[]'
o=$(cmp_ 30 "$TMP/rec-30")
chk "删掉一条较早的维护者反馈 → need-continue" "$(verdict "$o")|$(field "$o" reason)" "need-continue|feedback-deleted"
# 删一条、同时新增一条（GitHub#654 第 3 轮复审）：判定是 need-continue，新增的编号仍列出——
# 「疑问 + 建议」停下后「继续」取待办按停下前最近一次交付之后的全部反馈取，不依赖这里有没有给出新条目的正文
add_conv 30 304 alice "另外再补一条回归测试"
o=$(cmp_ 30 "$TMP/rec-30")
chk "删一条 + 新增一条 → need-continue（feedback-deleted），added 仍列出 c304" "$(verdict "$o")|$(field "$o" reason)|$(field "$o" added)" "need-continue|feedback-deleted|c304"
del_conv 30 304

echo "── 4. 外部账号的动作不影响恢复 ──"
add_conv 10 105 mallory "外部账号新评论"
chk "外部账号新增评论 → 仍 resume" "$(verdict "$(cmp_ 10 "$TMP/rec-10")")" resume
edit_conv 10 102 "外部账号改了自己的旧评论"
chk "外部账号编辑旧评论 → 仍 resume" "$(verdict "$(cmp_ 10 "$TMP/rec-10")")" resume
del_conv 10 102; del_conv 10 105
chk "外部账号删除评论 → 仍 resume" "$(verdict "$(cmp_ 10 "$TMP/rec-10")")" resume
edit_conv 10 103 "为什么缓存会慢？顺便改成 Z"
chk "对照：维护者编辑自己的评论 → new-feedback" "$(verdict "$(cmp_ 10 "$TMP/rec-10")")" new-feedback
edit_conv 10 103 "为什么缓存会慢？"

echo "── 5. 正文和流程记录 ──"
set_item 10 "原始需求（改过）" issue
o=$(cmp_ 10 "$TMP/rec-10")
chk "正文改了 → need-continue" "$(verdict "$o")|$(field "$o" reason)" "need-continue|item-changed"
set_item 10 "原始需求" issue
set_item 40 "需求" issue
add_conv 40 401 loop-bot "<!-- codex-review-round:1 -->"$'\n'"## ✅ 方案复审通过"
add_conv 40 402 loop-bot $'## 修订版方案'
add_conv 40 403 loop-bot "<!-- codex-review-round:1 -->"$'\n'"## ❌ 方案复审未通过"
add_conv 40 404 alice "这条打回是什么意思？"
s=$(snap 40); answer 40 405 "$s"
chk "绑定的是答复之前最后一条记录 f403（❌ 打回）" "$(sed -n '1s/.*resume=\(f[0-9]*\).*/\1/p' <<<"$s")" f403
chk "无变化 → resume" "$(verdict "$(cmp_ 40 "$TMP/rec-40")")" resume
cp "$(conv_file 40)" "$TMP/c40"
del_conv 40 403
o=$(cmp_ 40 "$TMP/rec-40")
chk "绑定的 ❌ 打回被删（更早的 ✅ 还在）→ need-continue，不退回 ✅" "$(verdict "$o")" need-continue
grep -q 'f401' <<<"$(sed -n '/要接着做的那一步/,$p' <<<"$o")" && bad "输出里拿更早的 ✅ 顶替了" || ok "输出里没有拿更早的 ✅ 顶替"
cp "$TMP/c40" "$(conv_file 40)"
edit_conv 40 403 "<!-- codex-review-round:1 -->"$'\n'"## ❌ 方案复审未通过（改过）"
chk "绑定的 ❌ 打回被编辑 → need-continue" "$(verdict "$(cmp_ 40 "$TMP/rec-40")")" need-continue
cp "$TMP/c40" "$(conv_file 40)"
add_conv 40 406 loop-bot "<!-- codex-review-round:2 -->"$'\n'"## ✅ 方案复审通过"
chk "答复之后出现新的复审结论 → need-continue" "$(verdict "$(cmp_ 40 "$TMP/rec-40")")" need-continue
cp "$TMP/c40" "$(conv_file 40)"
chk "恢复原样 → 又是 resume" "$(verdict "$(cmp_ 40 "$TMP/rec-40")")" resume

echo "── 6. 选择题勾选 ──"
set_item 50 "需求" issue
add_conv 50 501 loop-bot $'## 方案\n\n**Q1：要不要？**（默认 A）\n\n- [ ] **A. 要**\n- [ ] **B. 不要**\n'
add_conv 50 502 loop-bot "<!-- codex-review-round:6 -->"$'\n## ❌ 交维护者\n\n**Q1. 怎样恢复？**\n\n- [ ] **A. 等继续**\n- [ ] **B. 记快照**\n'
add_conv 50 503 alice "问一下"
s=$(snap 50); answer 50 504 "$s"
chk "无变化 → resume" "$(verdict "$(cmp_ 50 "$TMP/rec-50")")" resume
cp "$(conv_file 50)" "$TMP/c50"
edit_conv 50 501 $'## 方案\n\n**Q1：要不要？**（默认 A）\n\n- [ ] **A. 要**\n- [x] **B. 不要**\n'
o=$(cmp_ 50 "$TMP/rec-50")
chk "全角冒号题头下改勾选 → new-feedback，点出 t501q1（流程记录不算变化）" "$(verdict "$o")|$(field "$o" edited)" "new-feedback|t501q1"
cp "$TMP/c50" "$(conv_file 50)"
edit_conv 50 502 "<!-- codex-review-round:6 -->"$'\n## ❌ 交维护者\n\n**Q1. 怎样恢复？**\n\n- [ ] **A. 等继续**\n- [x] **B. 记快照**\n'
o=$(cmp_ 50 "$TMP/rec-50")
chk "句点题头（复审结论里）改勾选 → new-feedback，点出 t502q1" "$(verdict "$o")|$(field "$o" edited)" "new-feedback|t502q1"
cp "$TMP/c50" "$(conv_file 50)"
# 引用块和普通任务列表里的方框（第 1 节 #10 的 101 里就有）改了不算勾选，但它们是流程记录的一部分
edit_conv 10 101 $'## 方案：做 X\n\n**Q1：选哪个？**\n- [x] **A. 甲**\n- [ ] **B. 乙**\n\n> - [x] 引用里的方框\n\n- [x] 普通任务列表'
chk "引用块 / 普通任务列表里的方框改了 → 不算勾选变化，也不算流程变化 → resume" "$(verdict "$(cmp_ 10 "$TMP/rec-10")")" resume
# 答复本身引用了带方框的任务列表：答复不进勾选、不进流程记录
set_item 60 "需求" issue
add_conv 60 601 loop-bot $'## 方案'
add_conv 60 602 alice $'- [ ] 第一件\n- [ ] 第二件\n这些要做吗？'
s=$(snap 60); rec=$(sed -n '1p' <<<"$s")
add_conv 60 603 loop-bot "$(printf '> @alice 说：\n> - [ ] 第一件\n\n**Q1：** 引用\n- [ ] 方框\n\n%s\n' "$rec")"
printf '%s\n' "$rec" > "$TMP/rec-60"
chk "答复里带方框：首次无反馈交回 → resume" "$(verdict "$(cmp_ 60 "$TMP/rec-60")")" resume

echo "── 7. 记录格式不对、读不全 ──"
echo '<!-- agent-answer-only seen=c1:abcdefabcdef -->' > "$TMP/old-rec"
chk "旧格式（只有 seen=）→ need-continue" "$(verdict "$(cmp_ 10 "$TMP/old-rec")")" need-continue
echo '<!-- agent-answer-only need=continue -->' > "$TMP/wait-rec"
chk "等继续记录 → need-continue" "$(verdict "$(cmp_ 10 "$TMP/wait-rec")")" need-continue
sed 's/item=[0-9a-f]*/item=zz/' "$TMP/rec-10" > "$TMP/bad-rec"
chk "写坏的记录 → need-continue" "$(verdict "$(cmp_ 10 "$TMP/bad-rec")")" need-continue
touch "$FX/fail-repos_acme_widget_issues_10_comments"
o=$(cmp_ 10 "$TMP/rec-10"); rc=$?
chk "评论读失败 → 退出码 3、只有一行 unreadable" "$rc|$(wc -l <<<"$o")|${o%% *}" "3|1|unreadable"
o=$(snap 10); rc=$?
chk "snapshot 读失败 → 退出码 3，不给记录" "$rc|${o%% *}" "3|unreadable"
rm -f "$FX/fail-repos_acme_widget_issues_10_comments"
add_conv 10 106 nobody-known "谁？"
o=$(cmp_ 10 "$TMP/rec-10"); rc=$?
chk "作者权限查不到 → 退出码 3（不当成外部账号）" "$rc|${o%% *}" "3|unreadable"
del_conv 10 106
chk "确实走到了比对：恢复原样后 resume" "$(verdict "$(cmp_ 10 "$TMP/rec-10")")" resume

echo "── 8. 照派工说明走一遍：发前比对、答复、交回（PR #639 复审第 1 轮 #1–#3）──"
set_item 70 "需求" issue
add_conv 70 701 alice "先把日志格式改成 JSON" "2026-11-01T01:00:00Z"
add_conv 70 702 loop-bot $'## 修订版方案\n\n记录格式是 `<!-- agent-answer-only v=2 seen=… -->`，示例：\n\n```\n<!-- agent-answer-only need=continue -->\n```' "2026-11-01T02:00:00Z"
add_conv 70 703 alice "为什么要用 JSON？" "2026-11-01T03:00:00Z"
s=$(snap 70)
sed -n 1p <<<"$s" > "$TMP/pre-70"
chk "发前比对：snapshot 第一行原样存文件 → resume（不再被前缀挡住）" "$(verdict "$(cmp_ 70 "$TMP/pre-70")")" resume
chk "第一行就是记录本身" "$(sed -n '1s/^\(<!-- agent-answer-only v=2 \).*/\1/p' <<<"$s")" "<!-- agent-answer-only v=2 "
grep -q '^f702:[0-9a-f]* ｜ worker 交付 ｜ 发表 2026-11-01T02:00:00Z ｜ ## 修订版方案$' <<<"$s" \
    && ok "行内代码 / 代码块里解释记录格式的方案仍是流程记录（worker 交付，带时间）" || bad "解释格式的方案被当成答复记录" "$s"
c1=$(grep -n '^### c701 ' <<<"$s" | cut -d: -f1); c3=$(grep -n '^### c703 ' <<<"$s" | cut -d: -f1)
[ -n "$c1" ] && [ -n "$c3" ] && [ "$c1" -lt "$c3" ] && grep -q '^### c701 .*发表 2026-11-01T01:00:00Z' <<<"$s" \
    && ok "人的反馈按时间排、带发表时间：能看出 c701 的修改要求早于本轮起点 f702" || bad "人的反馈缺时间或顺序" "$s"
grep -A1 '^## 答复记录要绑定的那一步' <<<"$s" | grep -q '^f702:' && ok "snapshot 给出要绑定那一步的全文" || bad "snapshot 没给出绑定的那一步" "$s"
answer 70 704 "$s"
s2=$(snap 70)
grep -A1 '^## 最新一条答复' <<<"$s2" | grep -q '^编号 704 ｜ 答复记录 ｜' && grep -A2 '^## 最新一条答复' <<<"$s2" | grep -qxF "$(cat "$TMP/pre-70")" \
    && ok "交回时 snapshot 给出最新一条答复和它的记录行" || bad "snapshot 没给出最新答复" "$s2"
grep -q '^f704' <<<"$s2" && bad "答复记录进了流程记录" || ok "真正的答复记录不进流程记录"
chk "无留言交回：拿答复评论全文比对 → resume" "$(verdict "$(cmp_ 70 "$TMP/rec-70")")" resume
add_conv 70 705 loop-bot $'agent 无法确认，请留言「继续」\n\n<!-- agent-answer-only need=continue -->'
grep -A1 '^## 最新一条答复' <<<"$(snap 70)" | grep -q '^编号 705 ｜ 等继续记录' && ok "等继续评论被认成等继续记录" || bad "等继续评论没认出"
jq -r '.[] | select(.id == 705) | .body' "$(conv_file 70)" > "$TMP/w70"
chk "拿等继续评论比对 → need-continue" "$(verdict "$(cmp_ 70 "$TMP/w70")")" need-continue
del_conv 70 705
# 「疑问 + 建议」不可行时的停下答复（GitHub#654）：带暂缓清单和等继续标记，不带答复记录
add_conv 70 706 loop-bot $'## 「能不能改用 Y」不可行，先回答、停下\n\n### 暂缓：留言「继续」后接着做\n\n- 「顺便补一条回归测试」（[原文](https://example.invalid/c701)）\n\n<!-- agent-answer-only need=continue -->'
grep -A1 '^## 最新一条答复' <<<"$(snap 70)" | grep -q '^编号 706 ｜ 等继续记录' && ok "停下答复（带暂缓清单）被认成等继续记录" || bad "停下答复没认成等继续记录"
grep -q '^f706' <<<"$(snap 70)" && bad "停下答复进了流程记录" || ok "停下答复不进流程记录（之后照旧绑在 f702 那一步）"
jq -r '.[] | select(.id == 706) | .body' "$(conv_file 70)" > "$TMP/p70"
chk "无留言交回停下答复 → need-continue（不自动接着做）" "$(verdict "$(cmp_ 70 "$TMP/p70")")" need-continue
del_conv 70 706

echo "── 9. 同标题、不同正文的复审结论：交回给出绑定那条的全文 ──"
set_item 80 "PR 正文" pr
set_reviews 80 '[]'
add_conv 80 801 loop-bot "<!-- codex-review-round:1 -->"$'\n## ❌ 复审未通过\n\n要求：OLD-REQUEST'
add_conv 80 802 loop-bot "<!-- codex-review-round:2 -->"$'\n## ❌ 复审未通过\n\n要求：NEW-REQUEST'
add_conv 80 803 alice "NEW-REQUEST 是什么意思？"
s=$(snap 80); answer 80 804 "$s"
o=$(cmp_ 80 "$TMP/rec-80")
sec=$(sed -n '/^## 要接着做的那一步/,$p' <<<"$o")
chk "无变化 → resume" "$(verdict "$o")" resume
grep -q 'NEW-REQUEST' <<<"$sec" && ! grep -q 'OLD-REQUEST' <<<"$sec" && grep -q '^f802:.* ｜ 复审结论 ｜' <<<"$sec" \
    && ok "给出的是绑定那条（f802）的全文和角色，不是同标题的 f801" || bad "要接着做的那一步不对" "$sec"

echo "── 10. 本条目本身：开关、标签、PR 提交 ──"
chk "流程标签翻动（pending/agent → doing/agent）→ 仍 resume" \
    "$(set_item 80 "PR 正文" pr open '["doing/agent","priority/p0"]'; verdict "$(cmp_ 80 "$TMP/rec-80")")" resume
chk "PR 被关闭 → need-continue（item-changed）" \
    "$(set_item 80 "PR 正文" pr closed; field "$(cmp_ 80 "$TMP/rec-80")" reason)" item-changed
chk "多了一个非流程标签 → need-continue" \
    "$(set_item 80 "PR 正文" pr open '["pending/agent","priority/p0","wontfix"]'; field "$(cmp_ 80 "$TMP/rec-80")" reason)" item-changed
chk "PR 有了新提交 → need-continue" \
    "$(set_item 80 "PR 正文" pr open '["pending/agent","priority/p0"]' bbb222; field "$(cmp_ 80 "$TMP/rec-80")" reason)" item-changed
set_item 80 "PR 正文" pr
chk "恢复原样 → resume" "$(verdict "$(cmp_ 80 "$TMP/rec-80")")" resume

echo "── 11. 作者信息不全 → unreadable，不当外部账号（复审第 1 轮 #4）──"
f=$(conv_file 80); cp "$f" "$TMP/c80"
jq '. + [{id: 805, node_id: "IC_805", user: {login: "", type: "User"}, body: "要求改成 Q", created_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-02T00:00:00Z"}]' "$TMP/c80" > "$f"
o=$(cmp_ 80 "$TMP/rec-80"); rc=$?
chk "作者为空 → 退出码 3、unreadable" "$rc|${o%% *}" "3|unreadable"
jq '. + [{id: 805, node_id: "IC_805", user: null, body: "要求改成 Q", created_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-02T00:00:00Z"}]' "$TMP/c80" > "$f"
o=$(snap 80); rc=$?
chk "作者缺失（user 为 null）→ 退出码 3、unreadable" "$rc|${o%% *}" "3|unreadable"
jq '. + [{id: 805, node_id: "IC_805", user: {login: "mallory", type: "User"}, body: "要求改成 Q", created_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-02T00:00:00Z"}]' "$TMP/c80" > "$f"
chk "对照：已明确认定的外部账号 → 不计入，仍 resume" "$(verdict "$(cmp_ 80 "$TMP/rec-80")")" resume
cp "$TMP/c80" "$f"

echo "── 12. 勾选的来源时间：首次派工也能分清本轮新勾和早先勾的（复审第 2 轮 #2）──"
P1=$'## 方案\n\n**Q1：要不要？**（默认 A）\n\n- [ ] **A. 要**\n- [ ] **B. 不要**\n\n不勾会怎样：按 A。'
P1B=$'## 方案\n\n**Q1：要不要？**（默认 A）\n\n- [ ] **A. 要**\n- [x] **B. 不要**\n\n不勾会怎样：按 A。'
P1BT=$'## 方案\n\n**Q1：要不要？**（默认 A）\n\n- [ ] **A. 要**\n- [x] **B. 不要**\n\n不勾会怎样：按 A。\n\n<sub>往返记录 2</sub>'
# 修改历史夹具：<节点> <JSON 数组：新的在前 [{at, body, editor, deleted}]> [after 游标] [下一页游标]
edits_fx() {
    jq -n --argjson v "$2" --arg next "${4:-}" '{data: {node: {userContentEdits: {
        pageInfo: {hasNextPage: ($next != ""), endCursor: (if $next == "" then null else $next end)},
        nodes: [$v[] | {editedAt: .at, deletedAt: (if .deleted then .at else null end), diff: (if .deleted then null else .body end),
                        editor: (if .editor then {login: .editor} else null end)}]}}}}' > "$FX/edits-$1${3:+-$3}.json"
}
set_updated() { local f; f=$(conv_file "$1"); jq --argjson id "$2" --arg t "$3" 'map(if .id == $id then .updated_at = $t else . end)' "$f" > "$f.t" && mv "$f.t" "$f"; }
v() { jq -nc --arg at "$1" --arg b "$2" --arg e "${3:-}" '{at: $at, body: $b, editor: (if $e == "" then null else $e end), deleted: false}'; }

# 场景甲：维护者在本轮（起点 f901 之后）勾了旧题，再问一个问题
set_item 90 "需求" issue
add_conv 90 901 loop-bot "$P1" "2026-11-01T01:00:00Z"
edit_conv 90 901 "$P1B"; set_updated 90 901 "2026-11-01T03:00:00Z"
add_conv 90 902 alice "为什么默认是 A？" "2026-11-01T03:30:00Z"
edits_fx IC_901 "[$(v 2026-11-01T03:00:00Z "$P1B" alice),$(v 2026-11-01T01:00:00Z "$P1" loop-bot)]"
s=$(snap 90); rc=$?
chk "snapshot 退出码 0" "$rc" 0
grep -q '^### t901q1 ｜ 选择题勾选 ｜ loop 账号 ｜ 编号 901 ｜ Q1 ｜ 勾选最后变化 2026-11-01T03:00:00Z，由 @alice（维护者）改的$' <<<"$s" \
    && ok "本轮新勾的：给出勾选变化的时间（晚于起点 f901 的 01:00）和改的人" || bad "勾选缺时间或来源" "$s"
t=$(grep -n '^### t901q1 ' <<<"$s" | cut -d: -f1); c=$(grep -n '^### c902 ' <<<"$s" | cut -d: -f1)
[ -n "$t" ] && [ -n "$c" ] && [ "$t" -lt "$c" ] && ok "勾选按变化时间排在 03:30 的提问之前" || bad "勾选排序不对" "$s"
grep -q '时间未知' <<<"$s" && bad "仍出现「时间未知」" "$s" || ok "不再出现「时间未知」"

# 场景乙：勾选早于本轮起点（勾完之后 worker 又发了修订版），本轮只是提问
set_item 91 "需求" issue
add_conv 91 911 loop-bot "$P1" "2026-11-01T01:00:00Z"
edit_conv 91 911 "$P1B"; set_updated 91 911 "2026-11-01T01:30:00Z"
add_conv 91 912 loop-bot $'## 修订版方案（按 Q1 = B）' "2026-11-01T02:00:00Z"
add_conv 91 913 alice "为什么这样改？" "2026-11-01T03:00:00Z"
edits_fx IC_911 "[$(v 2026-11-01T01:30:00Z "$P1B" alice),$(v 2026-11-01T01:00:00Z "$P1" loop-bot)]"
s=$(snap 91)
grep -q '^### t911q1 .*勾选最后变化 2026-11-01T01:30:00Z，由 @alice（维护者）改的$' <<<"$s" && grep -q '^f912:[0-9a-f]* ｜ worker 交付 ｜ 发表 2026-11-01T02:00:00Z' <<<"$s" \
    && ok "早先勾的：勾选时间 01:30 早于本轮起点 f912 的 02:00，两者都看得到" || bad "看不出勾选早于起点" "$s"

# 场景丙：勾完之后 loop 账号又改了这条评论别的字：时间仍是勾的那一次、人是维护者
set_item 92 "需求" issue
add_conv 92 921 loop-bot "$P1" "2026-11-01T01:00:00Z"
edit_conv 92 921 "$P1BT"; set_updated 92 921 "2026-11-01T04:00:00Z"
add_conv 92 922 alice "问一下" "2026-11-01T05:00:00Z"
edits_fx IC_921 "[$(v 2026-11-01T04:00:00Z "$P1BT" loop-bot),$(v 2026-11-01T03:00:00Z "$P1B" alice),$(v 2026-11-01T01:00:00Z "$P1" loop-bot)]"
grep -q '^### t921q1 .*勾选最后变化 2026-11-01T03:00:00Z，由 @alice（维护者）改的$' <<<"$(snap 92)" \
    && ok "之后只改了别的字：勾选时间仍是 03:00、改的人是维护者，不是 loop 账号的 04:00" || bad "被后来的无关修改顶替了"

# 场景丁：改过但勾选从没变（只有 loop 账号改字）→ 自发表起没变
set_item 93 "需求" issue
P1T=$'## 方案\n\n**Q1：要不要？**（默认 A）\n\n- [ ] **A. 要**\n- [ ] **B. 不要**\n\n不勾会怎样：按 A。\n\n<sub>往返记录 2</sub>'
add_conv 93 931 loop-bot "$P1" "2026-11-01T01:00:00Z"
edit_conv 93 931 "$P1T"; set_updated 93 931 "2026-11-01T04:00:00Z"
edits_fx IC_931 "[$(v 2026-11-01T04:00:00Z "$P1T" loop-bot),$(v 2026-11-01T01:00:00Z "$P1" loop-bot)]"
grep -q '^### t931q1 .*勾选自发表（2026-11-01T01:00:00Z）起没有变过$' <<<"$(snap 93)" && ok "改过字、勾选没变 → 自发表起没有变过" || bad "没认出勾选未变"
# 场景戊：没改过的评论不读修改历史
rm -f "$FX/graphql.log"
set_item 94 "需求" issue
add_conv 94 941 loop-bot "$P1" "2026-11-01T01:00:00Z"
s=$(snap 94)
grep -q '^### t941q1 .*勾选自发表（2026-11-01T01:00:00Z）起没有变过$' <<<"$s" && [ ! -s "$FX/graphql.log" ] \
    && ok "没改过的评论：自发表起没变，不发修改历史请求" || bad "没改过的评论也读了历史或说法不对" "$(cat "$FX/graphql.log" 2>/dev/null)"
grep -q '^graphql IC_921$' <<<"$(snap 92 >/dev/null; cat "$FX/graphql.log")" && ok "对照：改过的评论确实读了修改历史" || bad "改过的评论没读历史"

# 分页：两页拼起来才找得到勾的那一版
edits_fx IC_921 "[$(v 2026-11-01T04:00:00Z "$P1BT" loop-bot)]" "" CUR1
edits_fx IC_921 "[$(v 2026-11-01T03:00:00Z "$P1B" alice),$(v 2026-11-01T01:00:00Z "$P1" loop-bot)]" CUR1
grep -q '^### t921q1 .*勾选最后变化 2026-11-01T03:00:00Z，由 @alice（维护者）改的$' <<<"$(snap 92)" && ok "修改历史两页：读全后找到勾的那一版" || bad "分页没读全"
# 被删的版本 / 历史和现在对不上 → 无法确认，排在最后
edits_fx IC_921 "[$(v 2026-11-01T04:00:00Z "$P1BT" loop-bot),$(jq -nc '{at: "2026-11-01T03:00:00Z", deleted: true}'),$(v 2026-11-01T01:00:00Z "$P1" loop-bot)]"
s=$(snap 92)
grep -q '^### t921q1 .*勾选变化时间无法确认（修改历史里有被删掉的版本），按本轮内的变化对待$' <<<"$s" \
    && [ "$(grep -n '^### t921q1 ' <<<"$s" | cut -d: -f1)" -gt "$(grep -n '^### c922 ' <<<"$s" | cut -d: -f1)" ] \
    && ok "有被删掉的版本 → 无法确认、按本轮对待，排在最后" || bad "被删的版本没按无法确认处理" "$s"
edits_fx IC_921 "[$(v 2026-11-01T04:00:00Z "$P1" loop-bot)]"
grep -q '^### t921q1 .*勾选变化时间无法确认（修改历史和现在的正文对不上）' <<<"$(snap 92)" && ok "历史和现在的勾选对不上 → 无法确认" || bad "对不上没认出"
edits_fx IC_921 "[]"
grep -q '^### t921q1 .*勾选变化时间无法确认（评论改过、读不到修改历史）' <<<"$(snap 92)" && ok "改过却没有修改历史 → 无法确认" || bad "空历史没认出"
touch "$FX/fail-edits-IC_921"
o=$(snap 92); rc=$?
chk "修改历史读失败 → 退出码 3、unreadable" "$rc|${o%% *}" "3|unreadable"
rm -f "$FX/fail-edits-IC_921"
echo '{"data": {"node": null}}' > "$FX/edits-IC_921.json"
o=$(snap 92); rc=$?
chk "修改历史形状不对 → 退出码 3、unreadable" "$rc|${o%% *}" "3|unreadable"
edits_fx IC_921 "[$(v 2026-11-01T04:00:00Z "$P1BT" loop-bot),$(v 2026-11-01T03:00:00Z "$P1B" alice),$(v 2026-11-01T01:00:00Z "$P1" loop-bot)]"
# 勾选的时间不进记录：同一状态再读，记录不变 → resume
s=$(snap 92); answer 92 923 "$s"
chk "答复后无变化交回 → resume（勾选时间不影响指纹）" "$(verdict "$(cmp_ 92 "$TMP/rec-92")")" resume

echo "── 13. 写前核对：原始字段、关联 PR、是否仍持有派工（复审第 2 轮 #6）──"
issue_f="$FX/repos_acme_widget_issues_95.json"
set_item 95 "需求" issue
add_conv 95 951 loop-bot $'## 方案' "2026-11-01T01:00:00Z"
add_conv 95 952 alice "为什么？" "2026-11-01T02:00:00Z"
jq 'del(.labels)' "$issue_f" > "$issue_f.t" && mv "$issue_f.t" "$issue_f"
o=$(snap 95); rc=$?
chk "响应里没有 labels → unreadable（不当成没有标签）" "$rc|$o" "3|unreadable read-item"
set_item 95 "需求" issue; jq '.labels = [{color: "fff"}]' "$issue_f" > "$issue_f.t" && mv "$issue_f.t" "$issue_f"
o=$(snap 95); rc=$?
chk "标签没有名字 → unreadable" "$rc|$o" "3|unreadable read-item"
set_item 95 "需求" issue; jq '.state = "weird"' "$issue_f" > "$issue_f.t" && mv "$issue_f.t" "$issue_f"
o=$(snap 95); rc=$?
chk "状态认不出 → unreadable" "$rc|$o" "3|unreadable read-item"
set_item 95 "需求" issue '' '[]'
grep -q '^状态 open ｜ 标签 （无） ｜ 关联的打开 PR （无）$' <<<"$(snap 95)" && ok "对照：明确没有标签 → 照常读出、标签（无）" || bad "明确空标签没读出"

PULLS="$FX/repos_acme_widget_pulls?state=open&per_page=100.json"
set_item 95 "需求" issue open '["doing/agent","priority/p0"]'
echo '[{"number": 960, "head": {"ref": "feature/other"}, "body": "无关"}]' > "$PULLS"
s=$(snap 95)
grep -q '关联的打开 PR （无）$' <<<"$s" && ok "无关的打开 PR 不算" || bad "无关 PR 被算进来" "$s"
chk "持有派工标签 → holding yes（单独一行）" "$(grep -c '^holding yes$' <<<"$s")" 1
answer 95 953 "$s"
o=$(cmp_ 95 "$TMP/rec-95")
chk "无变化 → resume，比对输出也带 holding yes" "$(verdict "$o")|$(field "$o" holding)" "resume|yes"
echo '[{"number": 960, "head": {"ref": "feature/other"}, "body": "无关"}, {"number": 961, "head": {"ref": "feature/issue-95"}, "body": ""}]' > "$PULLS"
o=$(cmp_ 95 "$TMP/rec-95")
chk "答复准备期间本 issue 开了 PR（按分支名）→ need-continue（item-changed）" "$(verdict "$o")|$(field "$o" reason)" "need-continue|item-changed"
grep -q '关联的打开 PR #961$' <<<"$(snap 95)" && ok "snapshot 里列出关联的打开 PR #961" || bad "没列出关联 PR"
echo '[{"number": 962, "head": {"ref": "fix/x"}, "body": "Closes #95"}]' > "$PULLS"
chk "按正文 Closes #95 关联的 PR 也算 → item-changed" "$(field "$(cmp_ 95 "$TMP/rec-95")" reason)" item-changed
echo '[{"number": 960, "head": {"ref": "feature/other"}, "body": "无关"}]' > "$PULLS"
chk "关联 PR 又关了 → 回到 resume" "$(verdict "$(cmp_ 95 "$TMP/rec-95")")" resume
touch "$FX/fail-repos_acme_widget_pulls?state=open&per_page=100"
o=$(cmp_ 95 "$TMP/rec-95"); rc=$?
chk "打开 PR 列表读失败 → unreadable" "$rc|$o" "3|unreadable read-open-prs"
rm -f "$FX/fail-repos_acme_widget_pulls?state=open&per_page=100"
echo '[{"number": 960, "body": "无关"}]' > "$PULLS"
o=$(cmp_ 95 "$TMP/rec-95"); rc=$?
chk "打开 PR 缺分支名 → unreadable" "$rc|$o" "3|unreadable read-open-prs"
echo '[]' > "$PULLS"
set_item 95 "需求" issue open '["pending/human","priority/p0"]'
o=$(cmp_ 95 "$TMP/rec-95")
chk "派工标签被别人摘掉：恢复指纹不变（resume），但 holding no 单独报出" "$(verdict "$o")|$(field "$o" holding)" "resume|no"
rm -f "$PULLS"

echo "── 14. 一条评论里的多道题各算各的（复审第 3 轮 #2）──"
Q0=$'## 方案\n\n**Q1：要不要？**\n\n- [ ] **A. 要**\n- [ ] **B. 不要**\n\n不勾会怎样：按 A。\n\n**Q2：快还是稳？**\n\n- [ ] **A. 快**\n- [ ] **B. 稳**\n\n不勾会怎样：按 A。'
Q1T=$'## 方案\n\n**Q1：要不要？**\n\n- [ ] **A. 要**\n- [x] **B. 不要**\n\n不勾会怎样：按 A。\n\n**Q2：快还是稳？**\n\n- [ ] **A. 快**\n- [ ] **B. 稳**\n\n不勾会怎样：按 A。'
Q12T=$'## 方案\n\n**Q1：要不要？**\n\n- [ ] **A. 要**\n- [x] **B. 不要**\n\n不勾会怎样：按 A。\n\n**Q2：快还是稳？**\n\n- [ ] **A. 快**\n- [x] **B. 稳**\n\n不勾会怎样：按 A。'
Q12R=$'## 方案\n\n**Q1：要不要？**\n\n- [ ] **A. 要（改过措辞）**\n- [x] **B. 不要**\n\n不勾会怎样：按 A。\n\n**Q2：快还是稳？**\n\n- [ ] **A. 快**\n- [x] **B. 稳**\n\n不勾会怎样：按 A。'
set_item 97 "需求" issue
add_conv 97 971 loop-bot "$Q0" "2026-11-01T01:00:00Z"
edit_conv 97 971 "$Q12R"; set_updated 97 971 "2026-11-01T04:00:00Z"
add_conv 97 972 loop-bot $'## 修订版方案（按 Q1 = B）' "2026-11-01T02:00:00Z"
add_conv 97 973 alice "为什么第 2 题默认快？" "2026-11-01T05:00:00Z"
edits_fx IC_971 "[$(v 2026-11-01T04:00:00Z "$Q12R" loop-bot),$(v 2026-11-01T03:00:00Z "$Q12T" alice),$(v 2026-11-01T01:30:00Z "$Q1T" alice),$(v 2026-11-01T01:00:00Z "$Q0" loop-bot)]"
s=$(snap 97); rc=$?
chk "snapshot 退出码 0" "$rc" 0
grep -q '^### t971q1 ｜ 选择题勾选 ｜ loop 账号 ｜ 编号 971 ｜ Q1 ｜ 勾选最后变化 2026-11-01T01:30:00Z，由 @alice（维护者）改的$' <<<"$s" \
    && ok "第 1 题：上轮（01:30，早于起点 f972 的 02:00）由维护者勾的" || bad "第 1 题的时间 / 来源不对" "$s"
grep -q '^### t971q2 ｜ 选择题勾选 ｜ loop 账号 ｜ 编号 971 ｜ Q2 ｜ 勾选最后变化 2026-11-01T03:00:00Z，由 @alice（维护者）改的$' <<<"$s" \
    && ok "第 2 题：本轮（03:00）由维护者勾的，和第 1 题分开" || bad "第 2 题的时间 / 来源不对" "$s"
grep -q '04:00:00Z，由 @loop-bot' <<<"$s" && bad "loop 账号改措辞被当成勾选变化" "$s" || ok "loop 账号 04:00 改选项措辞不算勾选变化"
grep -A2 '^### t971q2 ' <<<"$s" | grep -q '^\*\*Q2：快还是稳？\*\*$' && ok "每题条目带上自己的题目行" || bad "题目行缺失" "$s"
rec=$(sed -n 1p <<<"$s")
grep -q 't971q1:[0-9a-f]*,t971q2:' <<<"$rec" && ok "记录里两题各有一项" || bad "记录里不是按题分项" "$rec"
# 只改措辞的版本 → 不算这两题的变化；勾选指纹只看勾了哪几个，措辞变了指纹不变
answer 97 974 "$s"
edit_conv 97 971 "$(sed 's/改过措辞/又改了措辞/' <<<"$Q12R")"
o=$(cmp_ 97 "$TMP/rec-97")
chk "交回前 loop 账号又改措辞：不算新的勾选反馈（edited 里没有 t971q*），只算流程变化" "$(field "$o" edited)|$(verdict "$o")" "-|need-continue"
edit_conv 97 971 "$Q12R"
# loop 账号自己改了勾选：标明身份
set_item 98 "需求" issue
add_conv 98 981 loop-bot "$Q0" "2026-11-01T01:00:00Z"
edit_conv 98 981 "$Q1T"; set_updated 98 981 "2026-11-01T02:00:00Z"
edits_fx IC_981 "[$(v 2026-11-01T02:00:00Z "$Q1T" loop-bot),$(v 2026-11-01T01:00:00Z "$Q0" loop-bot)]"
s=$(snap 98)
grep -q '^### t981q1 .*勾选最后变化 2026-11-01T02:00:00Z，由 @loop-bot（loop 账号）改的$' <<<"$s" && grep -q '^### t981q2 .*勾选自发表' <<<"$s" \
    && ok "loop 账号自己改的勾选标明是 loop 账号；没动的第 2 题仍是自发表起没变" || bad "编辑身份没标出" "$s"
edits_fx IC_981 "[$(v 2026-11-01T02:00:00Z "$Q1T" nobody-known),$(v 2026-11-01T01:00:00Z "$Q0" loop-bot)]"
o=$(snap 98); rc=$?
chk "改的人身份查不到 → 退出码 3、unreadable" "$rc|${o%% *}" "3|unreadable"

echo "── 15. 写前闸门：答复和等继续提示共用一行（复审第 3 轮 #6）──"
set_item 99 "需求" issue open '["doing/agent"]'
add_conv 99 991 loop-bot $'## 方案' "2026-11-01T01:00:00Z"
add_conv 99 992 alice "为什么？" "2026-11-01T02:00:00Z"
s=$(snap 99)
chk "打开、持有、没有关联 PR → write ok pending/human" "$(grep '^write ' <<<"$s")" "write ok pending/human"
answer 99 993 "$s"
PULLS="$FX/repos_acme_widget_pulls?state=open&per_page=100.json"
echo '[{"number": 996, "head": {"ref": "feature/issue-99"}, "body": ""}]' > "$PULLS"
o=$(cmp_ 99 "$TMP/rec-99")
chk "两次比对之间开了关联 PR：need-continue，闸门给出新去向 pending/PR" "$(verdict "$o")|$(field "$o" write)" "need-continue|ok pending/PR"
rm -f "$PULLS"
set_item 99 "需求" issue open '["pending/human"]'
o=$(cmp_ 99 "$TMP/rec-99")
chk "派工标签被摘：write stop not-holding（等继续提示也不能发）" "$(field "$o" write)" "stop not-holding"
o=$(cmp_ 99 "$TMP/old-rec")
chk "旧格式记录（need-continue）+ 没持有 → 同样 stop" "$(verdict "$o")|$(field "$o" write)" "need-continue|stop not-holding"
set_item 99 "需求" issue closed '["doing/agent"]'
chk "已关闭 → write stop closed" "$(field "$(cmp_ 99 "$TMP/rec-99")" write)" "stop closed"
set_item 99 "需求" issue open '["doing/agent"]'
touch "$FX/fail-repos_acme_widget_issues_99_comments"
o=$(cmp_ 99 "$TMP/rec-99"); rc=$?
chk "读失败 → 退出码 3、只有 unreadable 一行，没有闸门行（不能拿旧状态写）" "$rc|$(wc -l <<<"$o")|$(grep -c '^write ' <<<"$o")" "3|1|0"
rm -f "$FX/fail-repos_acme_widget_issues_99_comments"
chk "对照：恢复后闸门又是 ok" "$(field "$(cmp_ 99 "$TMP/rec-99")" write)" "ok pending/human"
set_item 20 "PR 正文" pr open '["doing/agent"]'
chk "PR 本身 → write ok pending/human" "$(grep '^write ' <<<"$(snap 20)")" "write ok pending/human"

echo "── 16. 题目跨版本按题号认（复审第 4 轮 #2）──"
qa() { printf '**Q%s：%s**\n\n- [%s] **A. 甲**\n- [%s] **B. 乙**\n\n不勾会怎样：按 A。\n\n' "$1" "$2" "$3" "$4"; }
B0="## 方案"$'\n\n'"$(qa 1 一 x ' ')"$'\n\n'"$(qa 2 二 ' ' x)"
BINS="## 方案"$'\n\n'"$(qa 1 一 x ' ')"$'\n\n'"$(qa 3 新题 ' ' ' ')"$'\n\n'"$(qa 2 二 ' ' x)"
BSWP="## 方案"$'\n\n'"$(qa 2 二 ' ' x)"$'\n\n'"$(qa 1 一 x ' ')"
BDEL="## 方案"$'\n\n'"$(qa 2 二 ' ' x)"
BREW="## 方案"$'\n\n'"$(qa 1 一（改过措辞） x ' ')"$'\n\n'"$(qa 2 二 ' ' x)"
BTCK="## 方案"$'\n\n'"$(qa 1 一 x ' ')"$'\n\n'"$(qa 2 二 x ' ')"
BDUP="## 方案"$'\n\n'"$(qa 1 一 x ' ')"$'\n\n'"$(qa 1 重复 ' ' ' ')"$'\n\n'"$(qa 2 二 ' ' x)"
case16() {   # <编号> <现在的正文> <历史 JSON（新的在前）>
    set_item "$1" "需求" issue
    add_conv "$1" "${1}1" loop-bot "$B0" "2026-11-01T01:00:00Z"
    edit_conv "$1" "${1}1" "$2"; set_updated "$1" "${1}1" "2026-11-01T04:00:00Z"
    edits_fx "IC_${1}1" "$3"
    snap "$1"
}
V0=$(v 2026-11-01T01:00:00Z "$B0" loop-bot)
s=$(case16 61 "$BINS" "[$(v 2026-11-01T04:00:00Z "$BINS" loop-bot),$V0]")
grep -q '^### t611q1 .*勾选自发表' <<<"$s" && grep -q '^### t611q2 .*勾选自发表' <<<"$s" \
    && ok "中间插入新题：Q1、Q2 的勾选都不算变化" || bad "插题后已有题被算成变化" "$s"
grep -q '^### t611q3 .*勾选最后变化 2026-11-01T04:00:00Z，由 @loop-bot（loop 账号）改的$' <<<"$s" \
    && ok "新插入的 Q3 算插入者（loop 账号）的改动，不是人的勾选" || bad "新题来源不对" "$s"
s=$(case16 62 "$BSWP" "[$(v 2026-11-01T04:00:00Z "$BSWP" loop-bot),$V0]")
grep -q '^### t621q1 .*勾选自发表' <<<"$s" && grep -q '^### t621q2 .*勾选自发表' <<<"$s" \
    && ok "调换两题顺序（两题勾选不同）：都不算变化" || bad "重排被算成勾选变化" "$s"
s=$(case16 63 "$BDEL" "[$(v 2026-11-01T04:00:00Z "$BDEL" loop-bot),$V0]")
grep -q '^### t631q2 .*勾选自发表' <<<"$s" && ! grep -q '^### t631q1 ' <<<"$s" \
    && ok "删掉 Q1：剩下的 Q2 不算变化，Q1 不再列出" || bad "删题处理不对" "$s"
s=$(case16 64 "$BREW" "[$(v 2026-11-01T04:00:00Z "$BREW" loop-bot),$V0]")
grep -q '^### t641q1 .*勾选自发表' <<<"$s" && ok "同一题改措辞：不算勾选变化" || bad "改措辞被算成勾选" "$s"
s=$(case16 65 "$BTCK" "[$(v 2026-11-01T04:00:00Z "$BTCK" alice),$V0]")
grep -q '^### t651q2 .*勾选最后变化 2026-11-01T04:00:00Z，由 @alice（维护者）改的$' <<<"$s" && grep -q '^### t651q1 .*勾选自发表' <<<"$s" \
    && ok "对照：维护者真改了 Q2 的勾选 → 只有 Q2 算变化" || bad "真改勾没认出" "$s"
s=$(case16 66 "$BSWP" "[$(v 2026-11-01T04:00:00Z "$BSWP" loop-bot),$(v 2026-11-01T03:00:00Z "$BTCK" alice),$V0]")
grep -q '^### t661q2 .*勾选最后变化 2026-11-01T04:00:00Z，由 @loop-bot' <<<"$s" && grep -q '^### t661q1 .*勾选自发表' <<<"$s" \
    && ok "维护者先改勾、loop 账号再重排并改回：按题号逐版比，Q2 的最后变化记在 loop 账号名下" || bad "多版本按题号比对不对" "$s"
s=$(case16 67 "$BDUP" "[$(v 2026-11-01T04:00:00Z "$BDUP" loop-bot),$V0]")
grep -q '^### t671q1 .*无法确认（这条评论里有两道 Q1）' <<<"$s" && grep -q '^### t671q1d2 .*无法确认（这条评论里有两道 Q1）' <<<"$s" \
    && grep -q '^### t671q2 .*勾选自发表' <<<"$s" \
    && ok "题号重复：两项都报无法确认、各有自己的条目，Q2 照常" || bad "重复题号没报无法确认" "$s"
s=$(case16 68 "$BTCK" "[$(jq -nc --arg b "$BTCK" '{at: "2026-11-01T04:00:00Z", body: $b, editor: null, deleted: false}'),$V0]")
grep -q '^### t681q2 .*无法确认（2026-11-01T04:00:00Z 那一版改的人不明）' <<<"$s" && ok "改勾那一版没有编辑者 → 无法确认" || bad "编辑者不明没报无法确认" "$s"
s=$(case16 69 "$BSWP" "[$(v 2026-11-01T04:00:00Z "$BSWP" loop-bot),$V0]"); answer 69 692 "$s"
edit_conv 69 691 "$B0"
o=$(cmp_ 69 "$TMP/rec-69")
chk "答复后 loop 账号把题目顺序换回来：勾选项不变（edited 为空），只算绑定那一步变了 → need-continue" "$(field "$o" edited)|$(verdict "$o")|$(field "$o" reason)" "-|need-continue|resume-record-gone-or-changed"

report_counts "$pass" "$fail"
echo
if [ "$fail" -eq 0 ]; then echo "全部通过（$pass 项）"; exit 0; fi
echo "失败 $fail 项（通过 $pass 项）"; exit 1
