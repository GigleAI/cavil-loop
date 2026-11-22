#!/usr/bin/env bash
# kind: e2e
# PR 正文版式（GitHub#644）：发出前的只读检查命令，和把它写进 worker 说明的那一节。
#
# 跑法：bash tests/pr-body-lint.test.sh（约 3 分钟：二十次真实派工）
# 依赖：git、jq、python3。不碰网络：假 gh，HOME 指到临时目录。
#
#   【1】检查命令：真实脚本对一组正文样例逐个给出 ok / bad <码> <行号> 和退出码；每个样例跑两次结果相同；
#        输出里不出现正文文字；运行期间一次 gh 都不调
#   【2】第一行就是摘要：合格样例用 daemon 列「同时在进行的工作」的同一份规则读出的正是第一行那句
#   【3】真实派工的成品 prompt：issue 开干、拆出的子项、PR 返工三处都有「PR 正文版式」段且逐字相同，
#        命令路径已填好、照抄就能跑出结果；开 PR 那一步用 --body-file；首次设计轮没有这段
#   【4】复审不变：同一份审查标准下，复审 prompt 与主干脚本拼出的逐字相同；审查标准随主干走（新条目在新标准里有、旧的没有）
#   【5】命令目录：托管安装的入口齐全时用入口目录，少了版式检查的入口就整组退回本次发布的 scripts/
set -uo pipefail
# shellcheck source=lib/report.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/report.sh"

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$TEST_DIR")"
# shellcheck source=lib/prompt-files.sh
source "$TEST_DIR/lib/prompt-files.sh"
TMP=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] && echo "TMP=$TMP" || rm -rf "$TMP"' EXIT
export TZ=UTC GIT_CONFIG_GLOBAL="$TMP/gitconfig" GIT_CONFIG_NOSYSTEM=1
printf '[user]\n\tname = t\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; fail=$((fail + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "期望「$3」，实得「$2」"; fi; }

LINT="$REPO_DIR/scripts/pr-body-lint.sh"
SECRET='特征文字-不该出现在输出里-7731'

# ════════ 【1】检查命令 ════════
echo "── 【1】检查命令：样例 → 结果 ──"
S="$TMP/samples"; mkdir -p "$S" "$TMP/ghlog-bin"
# 记录调用的假 gh：检查命令运行期间不该被调到
cat > "$TMP/ghlog-bin/gh" <<SH
#!/usr/bin/env bash
echo "\$*" >> "$TMP/gh-calls"
exit 0
SH
chmod +x "$TMP/ghlog-bin/gh"

fold() { printf '<details><summary>%s</summary>\n\n%s\n\n</details>\n' "$1" "$2"; }
summary3() {
    printf '<!-- autopilot-summary:begin -->\n'
    fold 背景 "原来的情况。"
    fold 采用的方案 "最后的做法。"
    [ "${1:-3}" = 2 ] || fold 排除的方案和原因 "没有考虑别的方案。"
    printf '<!-- autopilot-summary:end -->\n'
}
{ printf 'PR 正文改成按章节折叠，%s。\n\nCloses #644\n\n⚠️ 一条要人注意的限制。\n\n' "$SECRET"
  fold 动机 "## 折叠块里的标题可以

\`\`\`
## 代码块里的标题不算
Closes #9
\`\`\`"
  fold 验证 "测试全绿。"
  summary3; } > "$S/good.md"
{ printf '改写已有正文，只保留原来的关联。\n\nRefs #12\n\n'; fold 改了什么 x; } > "$S/refs.md"
{ printf '这个 PR 不关联任何 issue，只改文档。\n\n'; fold 改了什么 x; } > "$S/nolink.md"
{ printf '子项的 PR，做拆分计划里的一块。\n\nCloses #20\nPart of #10\n\n'; fold 验证 x; } > "$S/sub.md"
{ printf '## 短标题\n\nCloses #1\n\n'; fold 验证 x; } > "$S/short-head.md"
{ fold 动机 "先写了折叠块。"; printf '\nCloses #1\n'; } > "$S/fold-first.md"
{ printf '关联行写进了折叠块。\n\n'; fold 动机 "Closes #1"; } > "$S/link-folded.md"
{ printf '有一章留在了折叠区外。\n\nCloses #1\n\n## 验证\n\n测试全绿。\n'; } > "$S/section-out.md"
{ printf '少了一个折叠块结尾。\n\nCloses #1\n\n<details><summary>动机</summary>\n\nx\n'; } > "$S/unclosed.md"
{ printf '托管总结段少了一块。\n\nCloses #1\n\n'; summary3 2; } > "$S/summary2.md"
# PR #650 复审第 1 轮：行内代码里的标签不算折叠；下划线式标题也是标题
{ printf '验证说明里提到了标签。\n\nCloses #1\n\n'; fold 验证 '说明中提到 `<details>` 和 `</details>` 标签。'; summary3; } > "$S/inline-tag.md"
{ printf '有一章用下划线式标题留在了外面。\n\n验证\n----\n\n测试通过。\n'; } > "$S/setext-out.md"
{ printf '下划线式标题写在折叠块里。\n\n'; fold 验证 '验证
====

测试通过。'; } > "$S/setext-in.md"
{ printf '正文中间有一条分隔线。\n\n---\n\n'; fold 验证 x; } > "$S/hr.md"
# PR #650 复审第 2 轮：跨行的行内代码；加粗的下划线式标题（折叠内外对拍）
{ printf '验证说明里有跨行的行内代码。\n\nCloses #1\n\n'; fold 验证 '说明中提到 `<details>
` 标签。'; } > "$S/inline-tag-wrap.md"
{ printf '有一章用加粗的下划线式标题留在了外面。\n\n**验证**\n----\n\n测试通过。\n'; } > "$S/setext-bold-out.md"
{ printf '加粗的下划线式标题写在折叠块里。\n\n'; fold 验证 '**验证**
----

测试通过。'; } > "$S/setext-bold-in.md"
{ printf '正文里有一段列表。\n\n- 第一项\n- 第二项\n\n'; fold 验证 x; } > "$S/list.md"
# PR #650 复审第 3 轮：HTML 属性值里的标签字样不算折叠（行内 HTML、HTML 块、折叠标签自己的属性；正文和托管总结段）
{ printf '验证说明里有带属性的 HTML。\n\nCloses #1\n\n'; fold 验证 '参见 <span title="<details>">标签</span>。

<div data-x='"'"'</details>'"'"'>块</div>'; summary3; } > "$S/attr-in.md"
{ printf '折叠标签自己的属性里有标签字样。\n\nCloses #1\n\n<details data-x="</details>"><summary>验证</summary>\n\n## 里面的标题\n\n</details>\n\n## 外面的标题\n'; } > "$S/attr-out.md"
{ printf '托管总结段里有带属性的 HTML。\n\nCloses #1\n\n<!-- autopilot-summary:begin -->\n'
  for t in 改了什么 怎么验证 剩余风险; do printf '<details><summary>%s</summary>\n\n<span title="</details><details>">x</span>\n\n</details>\n\n' "$t"; done
  printf '<!-- autopilot-summary:end -->\n'; } > "$S/attr-summary.md"
# PR #650 复审第 4 轮：行内原样文字元素跨三个 token（正文和托管总结段）；关联行紧贴折叠标签、同在一个 HTML 块里
{ printf '验证说明里有行内原样文字。\n\nCloses #1\n\n'; fold 验证 '示例 <textarea><details></textarea>。'; summary3; } > "$S/raw-inline.md"
{ printf '托管总结段里有行内原样文字。\n\nCloses #1\n\n<!-- autopilot-summary:begin -->\n'
  for t in 背景 采用的方案 排除的方案和原因; do printf '<details><summary>%s</summary>\n\n示例 <textarea></details></textarea>。\n\n</details>\n' "$t"; done
  printf '<!-- autopilot-summary:end -->\n'; } > "$S/raw-summary.md"
{ printf '关联行紧贴折叠标签。\n\n<details><summary>验证</summary>\nCloses #644\n</details>\n'; } > "$S/link-block-in.md"
{ printf '关联行紧贴在折叠块后面。\n\n<details><summary>验证</summary>\n</details>\nCloses #644\n'; } > "$S/link-block-out.md"
{ printf '跨行行内代码后面的关联行。\n\n'; fold 验证 '跨行 `a
b` 之后
Closes #1'; } > "$S/link-after-code.md"
# PR #650 复审第 5 轮：总结段标记的字样出现在文本框、行内代码里——daemon 合并后按字面截取（_autopilot_summary.sh），
# 会从那一行起照搬，所以检查照同一条规则报出来
{ printf '文本框里有总结段标记字样。\n\nCloses #644\n\n<details><summary>验证</summary>\n\n<textarea>\n<!-- autopilot-summary:begin -->\n</textarea>\n\n</details>\n'; } > "$S/mark-in-textarea.md"
{ printf '行内代码里有总结段标记字样。\n\nCloses #1\n\n'; fold 验证 '写法是 `<!-- autopilot-summary:end -->`。'; summary3; } > "$S/mark-in-code.md"
# 维护者在 PR #650 选了 B：章节在不在折叠里、折叠块成不成对不再查（上面 section-out / unclosed / setext-out /
# setext-bold-out / attr-out 现在都是 ok）。折叠深度照样算，只用来判关联行和总结段：属性值里的结尾标签不关上
# 折叠，没关上的折叠块里的关联行照样报
{ printf '属性值里的结尾标签不关上折叠。\n\n<details data-x="</details>"><summary>验证</summary>\n\nCloses #1\n\n</details>\n'; } > "$S/attr-link.md"
{ printf '没关上的折叠块里有关联行。\n\n<details><summary>验证</summary>\n\nCloses #1\n'; } > "$S/unclosed-link.md"
# PR #650 收窄后复审第 1 轮：多余的结尾标签不把深度带到负数（之后的折叠照样算，块内的关联行照报）；
# 总结段两个标记之间、折叠块外面的代码块 / 图片也算多出来的内容（块里的照常允许）
{ printf '多余结尾标签之后的折叠块里有关联行。\n\n</details>\n</details>\n\n<details><summary>验证</summary>\n\nCloses #644\n\n</details>\n'; } > "$S/extra-close-in.md"
{ printf '多余结尾标签之后的关联行在折叠外。\n\n</details>\n</details>\n\nCloses #644\n'; } > "$S/extra-close-out.md"
summary_with() {   # $1 = 插在第一个折叠块前面的内容，$2 = 插在第一个折叠块里面的内容
    printf '<!-- autopilot-summary:begin -->\n%s' "$1"
    printf '<details><summary>背景</summary>\n\n原来的情况。\n%s\n</details>\n' "$2"
    fold 采用的方案 "最后的做法。"; fold 排除的方案和原因 "没有考虑别的方案。"
    printf '<!-- autopilot-summary:end -->\n'
}
{ printf '总结段折叠块外有代码块。\n\nCloses #1\n\n'; summary_with $'```\ncode\n```\n' ''; } > "$S/summary-fence-out.md"
{ printf '总结段折叠块里有代码块。\n\nCloses #1\n\n'; summary_with '' $'\n```\ncode\n```\n'; } > "$S/summary-fence-in.md"
{ printf '总结段折叠块外有图片。\n\nCloses #1\n\n'; summary_with $'![图](https://example.com/a.png)\n\n' ''; } > "$S/summary-image-out.md"
# 收窄后复审第 2 轮：同一种可见内容的 Markdown 写法和 HTML 写法对拍，块外拒绝、块内允许；注释在块外也允许
vis_kinds=(md-hr html-hr md-img html-img span comment)
vis_text() {
    case "$1" in
        md-hr) printf -- '---' ;; html-hr) printf '<hr>' ;;
        md-img) printf '![图](https://example.com/a.png)' ;; html-img) printf '<img src="example.png" alt="示例">' ;;
        span) printf '<span>说明</span>' ;; comment) printf '<!-- 只是注释 -->' ;;
    esac
}
for k in "${vis_kinds[@]}"; do
    { printf '总结段里的可见内容。\n\nCloses #1\n\n'; summary_with "$(vis_text "$k")"$'\n\n' ''; } > "$S/vis-out-$k.md"
    { printf '总结段里的可见内容。\n\nCloses #1\n\n'; summary_with '' $'\n'"$(vis_text "$k")"$'\n'; } > "$S/vis-in-$k.md"
done
# 中间带 -- 的注释（解析器的注释写法不收）照浏览器到第一个 --> 为止
{ printf '注释里有两个连字符。\n\n'; fold 验证 '<!-- a -- <details> -->

x'; } > "$S/comment-dash.md"

# 样例名 → 期望（第一行输出 + 退出码）
expect=(
    "good|ok|0" "refs|ok|0" "nolink|ok|0" "sub|ok|0"
    "short-head|bad first-line 1|1" "fold-first|bad first-line 1|1"
    "link-folded|bad link-folded 5|1" "section-out|ok|0"
    "unclosed|ok|0" "summary2|bad autopilot-summary 5|1"
    "inline-tag|ok|0" "setext-out|ok|0" "setext-in|ok|0" "hr|ok|0"
    "inline-tag-wrap|ok|0" "setext-bold-out|ok|0" "setext-bold-in|ok|0" "list|ok|0"
    "attr-in|ok|0" "attr-out|ok|0" "attr-summary|ok|0" "comment-dash|ok|0"
    "raw-inline|ok|0" "raw-summary|ok|0" "link-block-in|bad link-folded 4|1" "link-block-out|ok|0" "link-after-code|bad link-folded 7|1"
    "mark-in-textarea|bad autopilot-summary 8|1" "mark-in-code|bad autopilot-summary 7|1"
    "attr-link|bad link-folded 5|1" "unclosed-link|bad link-folded 5|1"
    "extra-close-in|bad link-folded 8|1" "extra-close-out|ok|0"
    "summary-fence-out|bad autopilot-summary 5|1" "summary-fence-in|ok|0" "summary-image-out|bad autopilot-summary 5|1"
    "vis-out-md-hr|bad autopilot-summary 5|1" "vis-out-html-hr|bad autopilot-summary 5|1"
    "vis-out-md-img|bad autopilot-summary 5|1" "vis-out-html-img|bad autopilot-summary 5|1"
    "vis-out-span|bad autopilot-summary 5|1" "vis-out-comment|ok|0"
    "vis-in-md-hr|ok|0" "vis-in-html-hr|ok|0" "vis-in-md-img|ok|0" "vis-in-html-img|ok|0" "vis-in-span|ok|0" "vis-in-comment|ok|0"
)
: > "$TMP/gh-calls"
for e in "${expect[@]}"; do
    IFS='|' read -r name want code <<< "$e"; want=${want//+/$'\n'}
    out1=$(PATH="$TMP/ghlog-bin:$PATH" bash "$LINT" "$S/$name.md" 2>&1); rc1=$?
    out2=$(PATH="$TMP/ghlog-bin:$PATH" bash "$LINT" "$S/$name.md" 2>&1); rc2=$?
    check "样例 $name：输出" "$out1" "$want"
    check "样例 $name：退出码" "$rc1" "$code"
    [ "$out1|$rc1" = "$out2|$rc2" ] && ok "样例 $name：跑两次结果相同" || bad "样例 $name：两次结果不同" "$out1|$rc1 vs $out2|$rc2"
    case "$out1" in *"$SECRET"*|*"测试全绿"*|*"折叠块"*) bad "样例 $name：输出里带了正文文字" "$out1" ;; esac
done
out=$(PATH="$TMP/ghlog-bin:$PATH" bash "$LINT" "$S/nope.md" 2>/dev/null); rc=$?
check "文件不存在：退出码 2" "$rc" "2"
check "文件不存在：没有 ok" "$out" ""
out=$(bash "$LINT" 2>/dev/null); rc=$?
check "没给文件：退出码 2" "$rc" "2"
check "检查命令运行期间一次 gh 都没调（调用记录为空）" "$(wc -c < "$TMP/gh-calls" | tr -d ' ')" "0"
# 到达性：同一个假 gh 确实在 PATH 上、确实会记录
PATH="$TMP/ghlog-bin:$PATH" gh probe; check "假 gh 本身能记录调用" "$(cat "$TMP/gh-calls")" "probe"

# ════════ 【2】第一行就是摘要 ════════
echo "── 【2】合格正文的第一行，就是「同时在进行的工作」读出的摘要 ──"
# shellcheck source=../scripts/_concurrent_work_defs.sh
source "$REPO_DIR/scripts/_concurrent_work_defs.sh"
sum=$(jq -Rsr "$CONCURRENT_WORK_JQ_DEFS"' cw_first_sentence' < "$S/good.md")
check "摘要 = 第一行那句（去掉句末标点）" "$sum" "PR 正文改成按章节折叠，$SECRET"
sum=$(jq -Rsr "$CONCURRENT_WORK_JQ_DEFS"' cw_first_sentence' < "$S/short-head.md")
[ "$sum" != "短标题" ] && ok "短标题开头的正文，摘要读不成那个标题（所以检查报 first-line）" || bad "短标题被读成了摘要"

# ════════ 【2b】总结段：检查和 daemon 用同一个截取函数 ════════
echo "── 【2b】总结段按 daemon 合并后照搬的同一条规则截 ──"
# shellcheck source=../scripts/_autopilot_summary.sh
source "$REPO_DIR/scripts/_autopilot_summary.sh"
ext=$(autopilot_summary_extract < "$S/mark-in-textarea.md")
check "文本框里的标记字样：daemon 会从那一行起照搬（截出的第一行是文本框的结尾标签）" "${ext%%$'\n'*}" "</textarea>"
ext=$(autopilot_summary_extract < "$S/good.md")
n=$(printf '%s\n' "$ext" | grep -c '^<details>')
check "合格正文：daemon 截出的正是三个折叠块" "$n" "3"

# ════════ 【3】【4】【5】真实派工 ════════
CLEAN_ENV=(-u DISPATCH_PROMPT_KIND -u DISPATCH_AUTOPILOT -u DISPATCH_AUTOPILOT_ISSUE -u DISPATCH_AUTOPILOT_PR
           -u DISPATCH_AUTOPILOT_WHERE -u CODING_AGENT_RELEASE_ROOT -u CODING_AGENT_CONFIG -u DISPATCH_STUCK_RELEASE
           -u CAVIL_DEPLOY_ROOT)
mkdir -p "$TMP/bin" "$TMP/home"
bash "$TEST_DIR/lib/fake_gh_client.sh" install "$TMP/bin/gh" python3 "$TEST_DIR/lib/fake_github.py"
cat > "$TMP/bin/tmux" <<'SH'
#!/usr/bin/env bash
case "$1" in has-session) exit 1 ;; ls|list-sessions) exit 0 ;; esac
exit 0
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/claude"
chmod +x "$TMP/bin/tmux" "$TMP/bin/claude"

N_NEW=964401; N_CMT=964402; N_PR=964403; N_SUB=964404; N_PARENT=964450
items_json() {
    jq -n --arg n "$N_NEW" --arg c "$N_CMT" --arg p "$N_PR" --arg s "$N_SUB" --arg pa "$N_PARENT" '{
        ($n): {kind:"issue", state:"open", title:"新需求", body:"做一件事", user:{login:"maint"}},
        ($c): {kind:"issue", state:"open", title:"有新评论的需求", body:"x", user:{login:"maint"}},
        ($p): {kind:"pr", state:"open", merged:false, title:"自己的 PR", body:"x", user:{login:"loop-bot"},
               head:{sha:"1111111111111111111111111111111111111111", ref:("feature/issue-" + $p), repo:{full_name:"example/pb"}}, base:{ref:"main"}},
        ($s): {kind:"issue", state:"open", title:"子项", user:{login:"loop-bot"},
               body:("拆出来的一块\n\n<!-- agent-split-from: #" + $pa + " -->"),
               parent_issue_url:("https://api.github.com/repos/example/pb/issues/" + $pa)},
        ($pa): {kind:"issue", state:"open", title:"父 issue", body:"x", user:{login:"maint"}}
    }'
}

# make_project <名字> <REVIEW.md 来源文件>
make_project() {
    local d="$TMP/proj-$1"
    git init -q --bare -b main "$d/upstream.git"
    git clone -q "$d/upstream.git" "$d/seed" 2>/dev/null
    ( cd "$d/seed" || exit 1
      echo x > f; cp "$2" REVIEW.md
      git add -A && git commit -qm init && git push -q origin HEAD:main ) >/dev/null 2>&1
    git clone -q "$d/upstream.git" "$d/project" 2>/dev/null
    mkdir -p "$d/state" "$d/wt" "$d/gh"
    cat > "$d/config" <<CONF
REPO="example/pb"
PROJECT_ROOT="$d/project"
WORKTREE_BASE="$d/wt"
STATE_DIR="$d/state"
TMUX_PREFIX="pbl"
BRANCH_PREFIX="feature/issue-"
SESSION_NAME_PREFIX="issue"
LABEL_PENDING_AGENT="pending/agent"
LABEL_PENDING_HUMAN="pending/human"
LABEL_PENDING_BLOCKED=""
LABEL_PENDING_LATER=""
LABEL_PENDING_PR="pending/PR"
LABEL_AGENT_DOING="doing/agent"
LABEL_PENDING_REVIEW="pending/review"
POST_MERGE_RETROSPECTIVE=false
PRICE_AUTO_FETCH=0
AGENT_TRUST_PROMPT_WAIT_SECS=1
WORKER_SECRET_ENV=""
WORKER_AGENT_DEFAULT="claude"
PATH="$TMP/bin:\$PATH"
GH_TOKEN="fake-token-for-test"
CONF
    chmod 600 "$d/config"
    echo '{}' > "$d/gh/events.json"; echo '{}' > "$d/gh/perms.json"; echo loop-bot > "$d/gh/me"
    items_json > "$d/gh/items.json"
    jq -n --arg n "$N_NEW" --arg c "$N_CMT" --arg p "$N_PR" --arg s "$N_SUB" \
        '{($n): ["pending/agent"], ($c): ["pending/agent"], ($p): ["pending/agent"], ($s): ["pending/agent"]}' > "$d/gh/labels.base"
    echo "$d"
}

# dispatch_all <脚本树根> <项目目录> <输出目录> [HOME]：真实派工脚本写出五份提示词
dispatch_all() {
    local root="$1" d="$2" out="$3" home="${4:-$TMP/home}" name f
    mkdir -p "$out"
    for name in new-issue issue-comment sub-issue pr-comment review; do
        prompt_files_clear "$root" "$d/state"
        cp "$d/gh/labels.base" "$d/gh/labels.json"
        local extra=() cmd=()
        case "$name" in
            new-issue) cmd=(dispatch-new-issue.sh "$N_NEW") ;;
            sub-issue) cmd=(dispatch-new-issue.sh "$N_SUB") ;;
            issue-comment) cmd=(dispatch-issue-comment.sh "$N_CMT" 0) ;;
            pr-comment) cmd=(dispatch-pr-comment.sh "$N_PR" "feature/issue-$N_PR" 0) ;;
            review) cmd=(dispatch-issue-comment.sh "$N_CMT" 0); extra=(DISPATCH_PROMPT_KIND=review) ;;
        esac
        (cd "$d/project" && env "${CLEAN_ENV[@]}" HOME="$home" FAKE_GH_DIR="$d/gh" FAKE_GH_REPO=example/pb CODING_AGENT_CONFIG="$d/config" "${extra[@]}" \
            timeout 120 bash "$root/scripts/${cmd[0]}" "${cmd[@]:1}") >/dev/null 2>&1
        case "$name" in
            new-issue) f=$(prompt_file_of "$root" "$d/state" new "$N_NEW") ;;
            sub-issue) f=$(prompt_file_of "$root" "$d/state" new "$N_SUB") ;;
            pr-comment) f=$(prompt_file_of "$root" "$d/state" pr "$N_PR") ;;
            *) f=$(prompt_file_of "$root" "$d/state" cmt "$N_CMT" 0) ;;
        esac
        : > "${out:?}/${name:?}.md"; [ -s "$f" ] && cp "$f" "${out:?}/${name:?}.md"
    done
}

# 「PR 正文版式」段：从标题到下一个 ## 标题之前
section() { awk '/^## PR 正文版式/{on=1} on && /^## / && !/^## PR 正文版式/{exit} on' "$1"; }
has() { grep -qF -- "$2" "$1"; }

OLD="$TMP/old"; mkdir -p "$OLD"
BASE=$(git -C "$REPO_DIR" merge-base HEAD origin/main 2>/dev/null || true)
[ -n "$BASE" ] && git -C "$REPO_DIR" archive "$BASE" | tar -x -C "$OLD"
git -C "$REPO_DIR" show "$BASE:REVIEW.md" > "$TMP/review-old.md" 2>/dev/null || : > "$TMP/review-old.md"
cp "$REPO_DIR/REVIEW.md" "$TMP/review-new.md"
NEW_LINE='GitHub 上 issue / PR 的正文和评论都有修改历史'

echo "── 【3】真实派工的成品 prompt ──"
P=$(make_project new "$TMP/review-new.md")
dispatch_all "$REPO_DIR" "$P" "$TMP/out-new"
for n in new-issue issue-comment sub-issue pr-comment review; do
    [ -s "$TMP/out-new/$n.md" ] && ok "$n 派工写出了提示词" || bad "$n 派工没写出提示词"
done
has "$TMP/out-new/sub-issue.md" '只做本子项正文写明的那一块' && ok "子项走的是子项路径（带子项说明）" || bad "子项没走子项路径"
for n in issue-comment sub-issue pr-comment; do
    [ -n "$(section "$TMP/out-new/$n.md")" ] && ok "$n 有「PR 正文版式」段" || bad "$n 没有「PR 正文版式」段"
done
[ -z "$(section "$TMP/out-new/new-issue.md")" ] && ok "首次设计轮没有这段" || bad "首次设计轮带了这段"
[ -z "$(section "$TMP/out-new/review.md")" ] && ok "复审没有这段" || bad "复审带了这段"
a=$(section "$TMP/out-new/issue-comment.md"); b=$(section "$TMP/out-new/sub-issue.md"); c=$(section "$TMP/out-new/pr-comment.md")
[ "$a" = "$b" ] && [ "$a" = "$c" ] && ok "三处逐字相同" || bad "三处不一致"
case "$a" in *'${'*) bad "段里还有没替换的占位" ;; *) ok "段里的占位都替换了" ;; esac
has "$TMP/out-new/issue-comment.md" '`gh pr create --base main --title "..." --body-file <检查过的文件>`' \
    && ok "开 PR 那一步用 --body-file" || bad "开 PR 那一步没用 --body-file"
has "$TMP/out-new/issue-comment.md" 'gh pr create --base main --title "..." --body "' \
    && bad "开 PR 那一步还留着 --body \"...\" 的写法" || ok "开 PR 那一步不再有 --body \"...\" 的写法"
# 照抄段里的命令就能跑出结果
cmd=$(printf '%s\n' "$a" | grep -o "bash '[^']*/pr-body-lint.sh'" | head -1)
check "段里的命令指向本次发布的 scripts/（没有托管安装）" "$cmd" "bash '$REPO_DIR/scripts/pr-body-lint.sh'"
out=$(eval "$cmd \"\$S/good.md\""); check "照抄段里的命令检查合格样例" "$out" "ok"

echo "── 【4】复审不变；审查标准随主干走 ──"
if [ -n "$BASE" ] && [ -f "$OLD/scripts/dispatch-issue-comment.sh" ]; then
    P2=$(make_project old "$TMP/review-new.md")
    dispatch_all "$OLD" "$P2" "$TMP/out-oldscripts"
    norm() { sed -e "s|$REPO_DIR|<ROOT>|g" -e "s|$OLD|<ROOT>|g" -e "s|$TMP/proj-[a-z]*|<P>|g" \
        -e 's/20[0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]/<TS>/g' \
        -e 's/coding-agent-launch: [0-9a-f-]*/coding-agent-launch: <ID>/' "$1"; }
    if [ -s "$TMP/out-oldscripts/review.md" ] && diff <(norm "$TMP/out-new/review.md") <(norm "$TMP/out-oldscripts/review.md") > "$TMP/review.diff"; then
        ok "同一份审查标准下，复审 prompt 与合并基点的脚本拼出的逐字相同"
    else
        bad "复审 prompt 与合并基点的不同" "$(head -20 "$TMP/review.diff")"
    fi
else
    bad "取不到合并基点（git merge-base HEAD origin/main），没法对拍复审 prompt"
fi
has "$TMP/out-new/review.md" "$NEW_LINE" && ok "主干是新审查标准：复审 prompt 带新条目" || bad "新审查标准没进复审 prompt"
P3=$(make_project oldmd "$TMP/review-old.md")
dispatch_all "$REPO_DIR" "$P3" "$TMP/out-oldmd"
[ -s "$TMP/out-oldmd/review.md" ] && ! has "$TMP/out-oldmd/review.md" "$NEW_LINE" \
    && ok "主干是旧审查标准：复审 prompt 没有新条目" || bad "旧审查标准下复审 prompt 出现了新条目（或没写出）"

echo "── 【5】命令目录：托管入口齐全才用入口目录 ──"
mk_entries() {   # <HOME> <入口名...>
    local e="$1/.agents/releases/cavil-loop/entrypoints" n; shift
    mkdir -p "$e"
    for n in "$@"; do printf '#!/usr/bin/env bash\necho entry-%s\n' "$n" > "$e/$n"; done
    echo "$e"
}
H1="$TMP/home-full"; E1=$(mk_entries "$H1" flip-label.sh conflict-check.sh pr-feedback.sh pr-body-lint.sh)
dispatch_all "$REPO_DIR" "$P" "$TMP/out-full" "$H1"
cmd=$(section "$TMP/out-full/issue-comment.md" | grep -o "bash '[^']*/pr-body-lint.sh'" | head -1)
check "入口齐全：命令走托管入口目录" "$cmd" "bash '$E1/pr-body-lint.sh'"
H2="$TMP/home-part"; mk_entries "$H2" flip-label.sh conflict-check.sh pr-feedback.sh >/dev/null
dispatch_all "$REPO_DIR" "$P" "$TMP/out-part" "$H2"
cmd=$(section "$TMP/out-part/issue-comment.md" | grep -o "bash '[^']*/pr-body-lint.sh'" | head -1)
check "少了版式检查的入口：整组退回本次发布的 scripts/" "$cmd" "bash '$REPO_DIR/scripts/pr-body-lint.sh'"
grep -qF "bash '$REPO_DIR/scripts'/\"\$1\".sh" "$TMP/out-part/issue-comment.md" \
    && ok "……翻标签等步骤命令也一起退回 scripts/（同一个目录）" || bad "步骤命令没有和版式检查用同一个目录"

# ════════ 【6】只读：干净的发布目录跑一次，文件一个不多 ════════
echo "── 【6】在没设 PYTHONDONTWRITEBYTECODE 的环境里跑，发布目录里不留 __pycache__ ──"
mk_release() {
    mkdir -p "$1/scripts" "$1/tests/lib"
    cp "$REPO_DIR/scripts/pr-body-lint.sh" "$REPO_DIR/scripts/_concurrent_work_defs.sh" "$REPO_DIR/scripts/_autopilot_summary.sh" "$1/scripts/"
    cp -r "$REPO_DIR/tests/lib/vendor" "$1/tests/lib/"
    find "$1" -name __pycache__ -type d -prune -exec rm -rf {} +
}
R1="$TMP/rel-clean"; mk_release "$R1"
before=$(cd "$R1" && find . | LC_ALL=C sort)
out=$(env -u PYTHONDONTWRITEBYTECODE bash "$R1/scripts/pr-body-lint.sh" "$S/good.md" 2>&1); rc=$?
check "干净发布目录：合格样例输出 ok" "$out|$rc" "ok|0"
after=$(cd "$R1" && find . | LC_ALL=C sort)
check "干净发布目录：运行前后文件清单相同" "$after" "$before"
# 到达性：同一份目录，普通地导入一次解析器就会留下缓存（上一条的比较确实能看出来）
R2="$TMP/rel-plain"; mk_release "$R2"
env -u PYTHONDONTWRITEBYTECODE python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import markdown_it' "$R2/tests/lib/vendor"
n=$(find "$R2" -name __pycache__ -type d | wc -l | tr -d ' ')
[ "$n" -gt 0 ] && ok "对照：普通导入会在发布目录里写出 $n 个 __pycache__" || bad "对照：普通导入没写缓存，上面的比较证明不了什么"

report_counts "$pass" "$fail"
echo
if [ "$fail" -eq 0 ]; then echo "全部通过：$pass 项"; exit 0; fi
echo "有 $fail 项失败（通过 $pass 项）"; exit 1
