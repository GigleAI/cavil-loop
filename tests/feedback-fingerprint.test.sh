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
path="" jqf=""
while [ $# -gt 0 ]; do
    case "$1" in
        api|--paginate) shift ;;
        --jq) jqf="$2"; shift 2 ;;
        -*) shift ;;
        *) path="$1"; shift ;;
    esac
done
key=$(printf '%s' "$path" | tr '/' '_')
[ ! -e "$FX/fail-$key" ] || { echo "HTTP 502" >&2; exit 1; }
[ "$path" = user ] && { echo "loop-bot"; exit 0; }
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
        '. + [{id: $id, user: $u, body: $b, created_at: $t, updated_at: $t}]' "$f" > "$f.t" && mv "$f.t" "$f"
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
chk "全角冒号题头下改勾选 → new-feedback，点出 t501（流程记录不算变化）" "$(verdict "$o")|$(field "$o" edited)" "new-feedback|t501"
cp "$TMP/c50" "$(conv_file 50)"
edit_conv 50 502 "<!-- codex-review-round:6 -->"$'\n## ❌ 交维护者\n\n**Q1. 怎样恢复？**\n\n- [ ] **A. 等继续**\n- [x] **B. 记快照**\n'
o=$(cmp_ 50 "$TMP/rec-50")
chk "句点题头（复审结论里）改勾选 → new-feedback，点出 t502" "$(verdict "$o")|$(field "$o" edited)" "new-feedback|t502"
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
jq '. + [{id: 805, user: {login: "", type: "User"}, body: "要求改成 Q", created_at: "2026-11-02T00:00:00Z"}]' "$TMP/c80" > "$f"
o=$(cmp_ 80 "$TMP/rec-80"); rc=$?
chk "作者为空 → 退出码 3、unreadable" "$rc|${o%% *}" "3|unreadable"
jq '. + [{id: 805, user: null, body: "要求改成 Q", created_at: "2026-11-02T00:00:00Z"}]' "$TMP/c80" > "$f"
o=$(snap 80); rc=$?
chk "作者缺失（user 为 null）→ 退出码 3、unreadable" "$rc|${o%% *}" "3|unreadable"
jq '. + [{id: 805, user: {login: "mallory", type: "User"}, body: "要求改成 Q", created_at: "2026-11-02T00:00:00Z"}]' "$TMP/c80" > "$f"
chk "对照：已明确认定的外部账号 → 不计入，仍 resume" "$(verdict "$(cmp_ 80 "$TMP/rec-80")")" resume
cp "$TMP/c80" "$f"

report_counts "$pass" "$fail"
echo
if [ "$fail" -eq 0 ]; then echo "全部通过（$pass 项）"; exit 0; fi
echo "失败 $fail 项（通过 $pass 项）"; exit 1
